#!/usr/bin/env node
// The `pi` command.
//
// Thin on purpose: parse arguments, call the engine, render the answer. Every
// decision it appears to make is actually the router's — this file only chooses
// how to print things.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { renderBrief, requireAgent } from "../core/engine/agents.ts";
import { createEventLog } from "../core/engine/event-log.ts";
import {
  HARNESS_PRODUCT_NAME,
  InstallError,
  install,
  isInstalled,
  requireHarness,
  uninstall,
} from "../core/engine/install.ts";
import { applyIgnore } from "../core/engine/gitignore.ts";
import {
  Permission,
  denialEvent,
  evaluate,
  recordChange,
  type ToolCall,
} from "../core/engine/guard.ts";
import { ReviewError, parseReviewedFile, requestReview, resolveReview } from "../core/engine/review.ts";
import {
  CheckpointError,
  auditSnapshots,
  discardSnapshots,
  gitHead,
  planRewind,
  rewindEvents,
  saveSnapshot,
} from "../core/engine/checkpoints.ts";
import { checkpointPath, repoPath, runPaths } from "../core/engine/paths.ts";
import {
  RouterError,
  StepResult,
  applyReport,
  markStepStarted,
  next as routeNext,
  planSteps,
} from "../core/engine/router.ts";
import { SENSORS, renderSensors, runSensors } from "../core/engine/sensors.ts";
import { createStateStore } from "../core/engine/state-store.ts";
import {
  CONFIG_FILE,
  WorkspaceError,
  activeRunId,
  listRunSummaries,
  listRuns,
  openWorkspace,
  resolveRunId,
  requireActiveRun,
  requireWorkflow,
  setActiveRun,
  unfinishedActiveRun,
  type Workspace,
} from "../core/engine/workspace.ts";
import { EventType, type PiEvent } from "../core/schemas/events.ts";
import { DirectiveKind, type Directive } from "../core/schemas/directive.ts";
import { RunState, RunStatus, STATE_VERSION, StepStatus } from "../core/schemas/state.ts";
import { serveStaticSite } from "../core/docs/serve.ts";
import { buildStaticSite } from "../core/docs/site.ts";
import { VERSION, versionInfo } from "../core/version.ts";

type Args = {
  positional: string[];
  flags: Map<string, string | true>;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const [name, inline] = splitFlag(token.slice(2));
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }

    const peek = argv[i + 1];
    if (peek !== undefined && !peek.startsWith("--")) {
      flags.set(name, peek);
      i++;
    } else {
      flags.set(name, true);
    }
  }

  return { positional, flags };
}

function splitFlag(raw: string): [string, string | undefined] {
  const eq = raw.indexOf("=");
  return eq === -1 ? [raw, undefined] : [raw.slice(0, eq), raw.slice(eq + 1)];
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function wantsJson(args: Args): boolean {
  return args.flags.get("json") === true;
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdInit(projectDir: string, args: Args): number {
  const configPath = join(projectDir, CONFIG_FILE);

  if (existsSync(configPath) && args.flags.get("force") !== true) {
    console.error(`${CONFIG_FILE} already exists. Pass --force to overwrite it.`);
    return 1;
  }

  const config = {
    version: 1,
    harness: flagString(args, "harness") ?? "cursor",
    defaultWorkflow: "feature",
    docs: {
      dir: "docs",
      files: ["README.md"],
      required: true,
      exempt: ["tests/", "test/", "**/*.test.*", "dist/"],
    },
    facts: {
      hasFrontend: true,
      hasBackend: true,
      needsInfra: false,
    },
    // Left empty deliberately: the type-check and linter sensors skip rather
    // than guess, so fill these in with this project's real commands.
    checks: {},
  };

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  mkdirSync(join(projectDir, "pi", "workflows"), { recursive: true });

  console.log(`Wrote ${CONFIG_FILE} and pi/workflows/.`);

  // Both files just appeared in someone's `git status`. Ignore them now rather
  // than at `pi install`, which may not be the next thing they run.
  if (args.flags.get("no-gitignore") !== true) {
    const ignored = applyIgnore(projectDir, []);
    if (ignored.wrote) console.log(`Wrote ${ignored.wrote}.`);
  }

  console.log("");
  console.log("Next:");
  console.log(`  1. Edit ${CONFIG_FILE} — the "facts" decide which steps apply to this project.`);
  console.log('  2. Run `pi start "what you want to build"`.');
  return 0;
}

function cmdRuns(workspace: Workspace, args: Args): number {
  const wanted = flagString(args, "use");

  if (wanted) {
    const runId = resolveRunId(workspace.projectDir, wanted);
    setActiveRun(workspace.projectDir, runId);

    const run = listRunSummaries(workspace.projectDir).find((entry) => entry.runId === runId);
    console.log(`Switched to ${runId}`);
    if (run) console.log(`  ${run.goal} — ${run.done}/${run.total} steps`);
    console.log("");
    console.log("Run `pi next` to pick it back up.");
    return 0;
  }

  const runs = listRunSummaries(workspace.projectDir);

  if (wantsJson(args)) {
    console.log(JSON.stringify(runs, null, 2));
    return 0;
  }

  if (runs.length === 0) {
    console.log('No runs yet. Start one with `pi start "<what you want to build>"`.');
    return 0;
  }

  for (const run of runs) {
    const mark = run.active ? "*" : " ";
    console.log(`${mark} ${run.runId.slice(0, 8)}  ${run.status.padEnd(9)} ${run.done}/${run.total}  ${run.goal}`);
    console.log(`             ${run.workflow}, started ${run.createdAt.slice(0, 10)}`);
  }

  console.log("");
  console.log("* is the active run. Switch with `pi runs --use <id>`.");
  return 0;
}

function cmdInstall(workspace: Workspace, args: Args): number {
  const harness = flagString(args, "harness") ?? workspace.config.harness;
  const noGitignore = args.flags.get("no-gitignore") === true;
  const result = install(workspace.projectDir, harness, { noGitignore });

  console.log(`Wired pi into ${harness}:`);
  for (const file of result.written) console.log(`  ${file}`);
  for (const note of result.notes) console.log(`\n  note: ${note}`);

  console.log("");
  console.log(`Restart ${HARNESS_PRODUCT_NAME[harness as keyof typeof HARNESS_PRODUCT_NAME] ?? harness} so it picks up the hooks, then:`);
  console.log('  pi start "<what you want to build>"');
  return 0;
}

function cmdUninstall(workspace: Workspace, args: Args): number {
  const harness = flagString(args, "harness") ?? workspace.config.harness;
  // Before asking whether it is installed: "emacs is not wired in" is a true
  // sentence and a useless one when the real answer is that emacs is not a
  // harness pi has.
  requireHarness(harness);

  const purge = args.flags.get("purge") === true;

  // `--purge` still has work to do after the wiring is already gone — that is
  // exactly the sequence someone follows when they uninstall, then decide they
  // want the config and history gone too.
  if (!isInstalled(workspace.projectDir, harness) && !purge) {
    console.log(`pi is not wired into ${harness} in this project; nothing to undo.`);
    console.log(`Use --purge to also delete ${CONFIG_FILE} and pi/.`);
    return 0;
  }

  const result = uninstall(workspace.projectDir, harness, { purge });

  if (result.removed.length === 0) {
    console.log("Nothing of pi's was found in this project.");
    return 0;
  }

  const unwired = result.removed.some(
    (file) => file.startsWith(".cursor") || file.startsWith(".github"),
  );

  console.log(unwired ? `Removed pi from ${harness}:` : "Removed pi's files:");
  for (const file of result.removed) console.log(`  ${file}`);
  for (const note of result.notes) console.log(`\n  note: ${note}`);

  console.log("");
  // Only worth saying when hooks actually came out; a bare --purge changes
  // nothing the harness is holding on to.
  if (unwired) {
    console.log(
      `Restart ${HARNESS_PRODUCT_NAME[harness as keyof typeof HARNESS_PRODUCT_NAME] ?? harness} so it stops calling the hooks.`,
    );
  }
  if (!purge) console.log("Re-wire it any time with `pi install`.");
  return 0;
}

function cmdStart(workspace: Workspace, args: Args): number {
  const goal = args.positional.join(" ").trim();
  if (goal === "") {
    console.error('Say what you want to build: pi start "add an orders service"');
    return 2;
  }

  const workflowId = flagString(args, "workflow") ?? workspace.config.defaultWorkflow;
  const workflow = requireWorkflow(workspace, workflowId);

  // Starting a run pushes the current one aside. That is usually what you meant,
  // so it is not refused — but it happened silently before, and a half-finished
  // run quietly disappearing is not something to find out about later.
  const displaced = unfinishedActiveRun(workspace.projectDir);

  const runId = randomUUID();
  const paths = runPaths(workspace.projectDir, runId);
  const store = createStateStore(paths);
  const log = createEventLog(paths.events, runId);
  const createdAt = new Date().toISOString();

  store.init(
    RunState.parse({
      version: STATE_VERSION,
      piVersion: VERSION,
      runId,
      goal,
      workflow: workflow.id,
      workflowDigest: workflow.digest,
      createdAt,
      updatedAt: createdAt,
      status: RunStatus.Active,
      currentStep: null,
      steps: planSteps(workflow, workspace.config.facts),
      facts: workspace.config.facts,
    }),
  );

  log.append({ type: EventType.RunStarted, workflow: workflow.id, goal });
  setActiveRun(workspace.projectDir, runId);

  const state = store.read();
  const skipped = Object.entries(state.steps).filter(
    ([, step]) => step.status === StepStatus.Skipped,
  );

  if (wantsJson(args)) {
    console.log(
      JSON.stringify(
        {
          runId,
          workflow: workflow.id,
          goal,
          statePath: paths.state,
          displaced: displaced?.runId ?? null,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`Started ${workflow.name} — ${goal}`);
  console.log(`Run ${runId}`);
  console.log(`State: ${paths.state}`);

  if (displaced) {
    console.log("");
    console.log(`Set aside: ${displaced.goal} (${displaced.done}/${displaced.total} steps)`);
    console.log(`  Nothing was lost. Go back with: pi runs --use ${displaced.runId.slice(0, 8)}`);
  }
  if (skipped.length > 0) {
    console.log("");
    console.log("Not applicable to this project (from pi.config.json facts):");
    for (const [id, step] of skipped) console.log(`  ${id} — ${step.skipReason}`);
  }
  console.log("");
  // Facts are project-wide; a run can still need to exclude a step that this
  // project's facts do not already skip. Hand-editing `status` in the state
  // file above is the supported way — see
  // docs/reference/09-configuration.md#skipping-a-step-for-one-run-only.
  console.log('To skip a different step for just this run, edit its "status" to "skipped"');
  console.log("in the state file above before your first `pi next` or `pi report`.");
  console.log("");
  console.log("Run `pi next` to get the first step.");
  return 0;
}

function cmdNext(workspace: Workspace, args: Args): number {
  const { runId, paths } = requireActiveRun(workspace.projectDir);
  const store = createStateStore(paths);
  const log = createEventLog(paths.events, runId);
  const state = store.read();
  const workflow = requireWorkflow(workspace, state.workflow);

  const directive = routeNext(state, workflow, {
    paths,
    artifactExists: (path) => existsSync(path),
  });

  // Handing out a run-step is what starts it. `next()` itself stays pure so a
  // hook can ask the same question without side effects.
  if (directive.kind === DirectiveKind.RunStep) {
    const events = store.update((draft) => void markStepStarted(draft, directive.step));
    if (events.steps[directive.step]?.status === StepStatus.Active) {
      log.appendAll([
        { type: EventType.AgentActivated, agent: directive.agent, step: directive.step },
        {
          type: EventType.StepStarted,
          step: directive.step,
          agent: directive.agent,
          attempt: directive.attempt,
        },
      ]);
    }
  }

  // `--brief` is what a coding agent asks for: the persona, the objective, and
  // the constraints as one prompt. Humans want the short form.
  if (directive.kind === DirectiveKind.RunStep && args.flags.get("brief") === true) {
    const agent = requireAgent(workspace.roster, directive.agent);
    console.log(renderBrief(agent, directive, { goal: state.goal, docs: workspace.config.docs }));
    return 0;
  }

  if (wantsJson(args)) {
    console.log(JSON.stringify(directive, null, 2));
    return directive.kind === DirectiveKind.Error ? 1 : 0;
  }

  renderDirective(directive);
  return directive.kind === DirectiveKind.Error ? 1 : 0;
}

function cmdAgents(workspace: Workspace, args: Args): number {
  const id = args.positional[0];
  const roster = workspace.roster;

  if (!id) {
    if (wantsJson(args)) {
      console.log(JSON.stringify([...roster.agents.values()].map(({ body, ...rest }) => rest), null, 2));
      return 0;
    }
    for (const agent of [...roster.agents.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`${agent.id.padEnd(20)} ${agent.description}`);
    }
    for (const failure of roster.broken) console.error(`\nFAILED ${failure.message}`);
    return roster.broken.length > 0 ? 1 : 0;
  }

  const agent = requireAgent(roster, id);
  if (wantsJson(args)) {
    console.log(JSON.stringify(agent, null, 2));
    return 0;
  }

  console.log(`${agent.name} (${agent.id})`);
  console.log(agent.description);
  console.log("");
  console.log(`Tools:  ${agent.tools.join(", ") || "(none)"}`);
  console.log(`Denied: ${agent.denyTools.join(", ") || "(none)"}`);
  if (agent.changeBudget) {
    console.log(`Budget: ${agent.changeBudget.maxFiles} files / ${agent.changeBudget.maxLines} lines`);
  }
  console.log("");
  console.log(agent.body);
  return 0;
}

/**
 * Record that a human acted. Gates will not resolve without one of these since
 * the last gate, so this is the evidence an approval rests on.
 *
 * Two legitimate sources mint a turn: a harness hook firing when the user sends
 * a message, and a person typing into a real terminal. An agent shelling out
 * non-interactively gets neither, which is the point.
 */
function recordHumanTurn(projectDir: string, source: string): boolean {
  const runId = activeRunId(projectDir);
  if (!runId) return false;

  const paths = runPaths(projectDir, runId);
  createStateStore(paths).update((draft) => {
    draft.lastHumanTurnAt = new Date().toISOString();
  });
  createEventLog(paths.events, runId).append({ type: EventType.HumanTurn, source });
  return true;
}

function cmdHumanTurn(workspace: Workspace, args: Args): number {
  const source = flagString(args, "source") ?? "cli";
  if (!recordHumanTurn(workspace.projectDir, source)) {
    console.error("No active run to attach a human turn to.");
    return 1;
  }
  console.log(`Recorded a human turn (${source}).`);
  return 0;
}

function cmdReport(workspace: Workspace, args: Args): number {
  const { runId, paths } = requireActiveRun(workspace.projectDir);
  const store = createStateStore(paths);
  const log = createEventLog(paths.events, runId);
  const workflow = requireWorkflow(workspace, store.read().workflow);

  const step = flagString(args, "step");
  const result = flagString(args, "result") as StepResult | undefined;

  if (!step || !result) {
    console.error("Usage: pi report --step <id> --result <completed|needs-review|approved|rejected|failed>");
    return 2;
  }

  if (!Object.values(StepResult).includes(result)) {
    console.error(
      `Unknown result "${result}". Expected one of: ${Object.values(StepResult).join(", ")}`,
    );
    return 2;
  }

  const artifacts = flagString(args, "artifacts")
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  // Resolving a gate from an interactive terminal is itself the human acting.
  const resolvesGate = result === StepResult.Approved || result === StepResult.Rejected;
  if (resolvesGate && process.stdin.isTTY) {
    recordHumanTurn(workspace.projectDir, "cli-tty");
  }

  let emitted: ReturnType<typeof applyReport> = [];
  const after = store.update((draft) => {
    emitted = applyReport(draft, workflow, {
      step,
      result,
      artifacts,
      feedback: flagString(args, "feedback"),
      error: flagString(args, "error"),
      gitHead: gitHead(workspace.projectDir),
    });
  });
  log.appendAll(emitted);

  // The router decided a boundary was reached; persisting it is our job. The
  // snapshot is written after the state, so a crash between the two leaves an
  // index entry with no file — which `pi doctor` reports — rather than a
  // snapshot of a state that was never current.
  for (const event of emitted) {
    if (event.type === EventType.CheckpointSaved) saveSnapshot(paths, after, step);
  }

  // Sensors run when a step says it is done, so their findings reach the human
  // at the gate — the moment they are about to decide.
  const sensed =
    result === StepResult.Completed
      ? fireSensors(workspace, store, log, step)
      : [];

  if (wantsJson(args)) {
    console.log(
      JSON.stringify({ step, result, events: emitted.map((e) => e.type), sensors: sensed }, null, 2),
    );
    return 0;
  }

  console.log(`Recorded: ${step} → ${result}`);
  for (const event of emitted) console.log(`  ${event.type}`);

  const lines = renderSensors(sensed);
  if (lines.length > 0) {
    console.log("");
    for (const line of lines) console.log(line);
  }
  return 0;
}

/** Run a step's sensors, record what they found, and hand back the results. */
function fireSensors(
  workspace: Workspace,
  store: Store,
  log: Log,
  stepId: string,
): ReturnType<typeof runSensors> {
  const state = store.read();
  const workflow = requireWorkflow(workspace, state.workflow);
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  const stepState = state.steps[stepId];

  if (!step || !stepState || step.sensors.length === 0) return [];

  const results = runSensors({
    step,
    stepState,
    workflow,
    config: workspace.config,
    paths: runPaths(workspace.projectDir, state.runId),
    projectDir: workspace.projectDir,
  });

  log.appendAll(
    results
      .filter((result) => !result.skipped)
      .map((result) => ({
        type: EventType.SensorFired,
        step: stepId,
        sensor: result.sensor,
        pass: result.pass,
        findings: result.findings.map((finding) => finding.message),
      })),
  );

  return results;
}

function cmdSensors(workspace: Workspace, args: Args): number {
  // With no active run this is a catalogue; with one it is a dry run of the
  // current step, so you can see what the gate will say before you get there.
  const runId = activeRunId(workspace.projectDir);

  if (!runId || args.flags.get("list") === true) {
    if (wantsJson(args)) {
      console.log(JSON.stringify(SENSORS.map(({ id, describes }) => ({ id, describes })), null, 2));
      return 0;
    }
    for (const sensor of SENSORS) console.log(`${sensor.id.padEnd(20)} ${sensor.describes}`);
    return 0;
  }

  const paths = runPaths(workspace.projectDir, runId);
  const state = createStateStore(paths).read();
  const workflow = requireWorkflow(workspace, state.workflow);
  const stepId = flagString(args, "step") ?? state.currentStep;
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  const stepState = stepId ? state.steps[stepId] : undefined;

  if (!step || !stepState) {
    console.error(`No step "${stepId ?? "(none)"}" to run sensors for.`);
    return 1;
  }

  const results = runSensors({
    step,
    stepState,
    workflow,
    config: workspace.config,
    paths,
    projectDir: workspace.projectDir,
  });

  if (wantsJson(args)) {
    console.log(JSON.stringify(results, null, 2));
    return 0;
  }

  if (results.length === 0) {
    console.log(`Step "${step.id}" declares no sensors.`);
    return 0;
  }

  for (const result of results) {
    if (result.skipped) {
      console.log(`skip  ${result.sensor} — ${result.skipped}`);
      continue;
    }
    if (result.findings.length === 0) console.log(`ok    ${result.sensor}`);
  }

  const lines = renderSensors(results);
  if (lines.length > 0) {
    console.log("");
    for (const line of lines) console.log(line);
  }

  return 0;
}

// ── The guard ───────────────────────────────────────────────────────────────
//
// This is the hook entry point. It runs on every tool call, so it stays quiet,
// fast, and fails open: if the guard cannot tell whether something is allowed,
// blocking the user's editor is worse than letting the call through.

function toolCallFrom(args: Args, projectDir: string): ToolCall {
  const files = flagString(args, "files")
    ?.split(",")
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => repoPath(projectDir, file));

  const lines = Number.parseInt(flagString(args, "lines") ?? "0", 10);

  return {
    tool: flagString(args, "tool") ?? "",
    files: files ?? [],
    lines: Number.isNaN(lines) ? 0 : lines,
  };
}

function cmdGuard(workspace: Workspace, args: Args): number {
  const call = toolCallFrom(args, workspace.projectDir);
  if (call.tool === "") {
    console.error("Usage: pi guard --tool <id> [--files a,b] [--lines n] [--record]");
    return 2;
  }

  const runId = activeRunId(workspace.projectDir);
  if (!runId) {
    // No run means pi is not governing this session. Say nothing and allow.
    console.log(JSON.stringify({ permission: Permission.Allow }));
    return 0;
  }

  const paths = runPaths(workspace.projectDir, runId);
  const store = createStateStore(paths);
  const state = store.read();
  const workflow = requireWorkflow(workspace, state.workflow);
  const agent = state.currentStep ? state.steps[state.currentStep]?.agent : undefined;

  const verdict = evaluate(state, workflow, call, {
    agent: agent ? workspace.roster.agents.get(agent) : undefined,
  });

  if (verdict.permission === Permission.Deny) {
    createEventLog(paths.events, runId).appendAll(
      denialEvent(call, verdict, state.currentStep),
    );
    console.log(
      JSON.stringify({ permission: Permission.Deny, agent_message: verdict.message }),
    );
    return 0;
  }

  // `--record` is the post-tool-use half: the call happened, so it counts.
  if (args.flags.get("record") === true) {
    store.update((draft) => recordChange(draft, call));
  }

  console.log(JSON.stringify({ permission: Permission.Allow }));
  return 0;
}

// ── Review ──────────────────────────────────────────────────────────────────

function cmdReview(workspace: Workspace, args: Args): number {
  const action = args.positional[0] ?? "status";
  const { runId, paths } = requireActiveRun(workspace.projectDir);
  const store = createStateStore(paths);
  const log = createEventLog(paths.events, runId);

  switch (action) {
    case "request":
      return reviewRequest(workspace, store, log, args);
    case "resolve":
      return reviewResolve(workspace, store, log, args);
    case "status":
      return reviewStatus(store, args);
    default:
      console.error(`Unknown review action "${action}". Expected: request, resolve, status.`);
      return 2;
  }
}

type Store = ReturnType<typeof createStateStore>;
type Log = ReturnType<typeof createEventLog>;

function reviewRequest(workspace: Workspace, store: Store, log: Log, args: Args): number {
  const summary = flagString(args, "summary");
  const files = flagString(args, "files")
    ?.split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const file = parseReviewedFile(raw);
      return { ...file, path: repoPath(workspace.projectDir, file.path) };
    });

  if (!summary || !files || files.length === 0) {
    console.error('Usage: pi review request --summary "<what and why>" --files <paths> [--lines n]');
    return 2;
  }

  const changedLines = Number.parseInt(flagString(args, "lines") ?? "0", 10);

  let requested: ReturnType<typeof requestReview> | undefined;
  store.update((draft) => {
    requested = requestReview(draft, {
      summary,
      files,
      changedLines: Number.isNaN(changedLines) ? 0 : changedLines,
    });
  });
  log.appendAll(requested!.events);

  if (wantsJson(args)) {
    console.log(JSON.stringify(requested!.receipt, null, 2));
    return 0;
  }

  console.log(`Review requested for step "${requested!.receipt.step}".`);
  console.log("");
  console.log(summary);
  for (const file of files) console.log(`  ${file.action} ${file.path}`);
  console.log("");
  console.log("The step is frozen until this is answered:");
  console.log("  pi review resolve --approve");
  console.log('  pi review resolve --reject --feedback "..."');
  return 0;
}

function reviewResolve(workspace: Workspace, store: Store, log: Log, args: Args): number {
  const approve = args.flags.get("approve") === true;
  const reject = args.flags.get("reject") === true;

  if (approve === reject) {
    console.error("Pass exactly one of --approve or --reject.");
    return 2;
  }

  // Answering a review from an interactive terminal is itself the human acting.
  if (process.stdin.isTTY) recordHumanTurn(workspace.projectDir, "cli-tty");

  let resolved: ReturnType<typeof resolveReview> | undefined;
  store.update((draft) => {
    resolved = resolveReview(draft, {
      approved: approve,
      feedback: flagString(args, "feedback"),
    });
  });
  log.appendAll(resolved!.events);

  if (wantsJson(args)) {
    console.log(JSON.stringify(resolved!.receipt, null, 2));
    return 0;
  }

  console.log(
    approve
      ? "Approved. The step continues with a fresh change budget."
      : "Sent back with your feedback. The step continues from where it was.",
  );
  return 0;
}

function reviewStatus(store: Store, args: Args): number {
  const state = store.read();
  const stepState = state.currentStep ? state.steps[state.currentStep] : undefined;
  const receipts = stepState?.receipts ?? [];

  if (wantsJson(args)) {
    console.log(JSON.stringify(receipts, null, 2));
    return 0;
  }

  if (receipts.length === 0) {
    console.log(`No reviews on step "${state.currentStep ?? "(none)"}".`);
    return 0;
  }

  for (const receipt of receipts) {
    const answer = receipt.resolution
      ? receipt.resolution.approved
        ? "approved"
        : `rejected — ${receipt.resolution.feedback}`
      : "WAITING ON YOU";
    console.log(`${receipt.requestedAt.slice(11, 19)}  ${answer}`);
    console.log(`  ${receipt.summary}`);
    for (const file of receipt.files) console.log(`    ${file.action} ${file.path}`);
  }
  return 0;
}

function cmdStatus(workspace: Workspace, args: Args): number {
  const runId = activeRunId(workspace.projectDir);
  if (!runId) {
    console.log("No active run. Start one with `pi start \"<what you want to build>\"`.");
    return 0;
  }

  const paths = runPaths(workspace.projectDir, runId);
  const state = createStateStore(paths).read();
  const workflow = requireWorkflow(workspace, state.workflow);

  if (wantsJson(args)) {
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }

  const done = workflow.steps.filter(
    (step) => state.steps[step.id]?.status === StepStatus.Completed,
  ).length;
  const applicable = workflow.steps.filter(
    (step) => state.steps[step.id]?.status !== StepStatus.Skipped,
  ).length;

  console.log(`${workflow.name} — ${state.goal}`);
  console.log(`${state.status} · ${done}/${applicable} steps · run ${runId}`);
  console.log("");

  for (const step of workflow.steps) {
    const stepState = state.steps[step.id];
    if (!stepState) continue;
    const suffix =
      stepState.status === StepStatus.Skipped
        ? ` (${stepState.skipReason})`
        : stepState.attempt > 0
          ? ` (attempt ${stepState.attempt + 1})`
          : "";
    console.log(`  ${marker(stepState.status)} ${step.id} — ${step.agent}${suffix}`);
  }

  const waiting = workflow.steps.find((step) => {
    const status = state.steps[step.id]?.status;
    return status === StepStatus.AwaitingApproval || status === StepStatus.AwaitingReview;
  });
  if (waiting) {
    console.log("");
    console.log(`Waiting on you: ${waiting.id}. Run \`pi next\` for details.`);
  }

  return 0;
}

function marker(status: StepStatus): string {
  switch (status) {
    case StepStatus.Completed:
      return "[x]";
    case StepStatus.Active:
      return "[-]";
    case StepStatus.AwaitingApproval:
    case StepStatus.AwaitingReview:
      return "[?]";
    case StepStatus.Skipped:
      return "[s]";
    case StepStatus.Failed:
      return "[!]";
    default:
      return "[ ]";
  }
}

function cmdLog(workspace: Workspace, args: Args): number {
  const { runId, paths } = requireActiveRun(workspace.projectDir);
  const log = createEventLog(paths.events, runId);
  const step = flagString(args, "step");

  const events = log.read().filter((event) => !step || eventStep(event) === step);

  if (wantsJson(args)) {
    console.log(JSON.stringify(events, null, 2));
    return 0;
  }

  for (const event of events) {
    const when = new Date(event.ts).toISOString().slice(11, 19);
    console.log(`${when}  ${event.type.padEnd(20)} ${eventStep(event) ?? ""}`);
  }

  const damaged = log.readDamaged();
  if (damaged.length > 0) {
    console.log("");
    console.log(`${damaged.length} unreadable line(s); run \`pi doctor\` for detail.`);
  }
  return 0;
}

function eventStep(event: PiEvent): string | undefined {
  return "step" in event ? event.step : undefined;
}

function cmdWorkflows(workspace: Workspace, args: Args): number {
  const id = args.positional[0];

  if (!id) {
    if (wantsJson(args)) {
      console.log(JSON.stringify([...workspace.workflows.keys()], null, 2));
      return 0;
    }
    for (const [key, loaded] of workspace.workflows) {
      const shadowed = loaded.source.includes(join("pi", "workflows")) ? " (project)" : "";
      console.log(`${key.padEnd(10)} ${loaded.workflow.steps.length} steps  ${loaded.workflow.description}${shadowed}`);
    }
    return 0;
  }

  const workflow = requireWorkflow(workspace, id);
  if (wantsJson(args)) {
    console.log(JSON.stringify(workflow, null, 2));
    return 0;
  }

  console.log(`${workflow.name} (${workflow.id}) — ${workflow.description}`);
  console.log("");
  for (const step of workflow.steps) {
    const when = step.when.length > 0 ? `  when ${step.when.join(" and ")}` : "";
    const budget = step.changeBudget
      ? `  budget ${step.changeBudget.maxFiles} files / ${step.changeBudget.maxLines} lines`
      : "";
    console.log(`  ${step.id} — ${step.agent}${when}`);
    console.log(`      ${step.objective}`);
    if (step.produces.length > 0) console.log(`      produces ${step.produces.join(", ")}`);
    if (budget) console.log(`    ${budget}`);
  }
  return 0;
}

function cmdCheckpoints(workspace: Workspace, args: Args): number {
  const { paths } = requireActiveRun(workspace.projectDir);
  const state = createStateStore(paths).read();

  if (wantsJson(args)) {
    console.log(JSON.stringify(state.checkpoints, null, 2));
    return 0;
  }

  if (state.checkpoints.length === 0) {
    console.log("No checkpoints yet. They are written as checkpointed steps complete.");
    return 0;
  }

  console.log(`Checkpoints for run ${state.runId}:`);
  console.log("");
  for (const checkpoint of state.checkpoints) {
    const missing = existsSync(checkpointPath(paths, checkpoint.step)) ? "" : "  (snapshot missing)";
    console.log(`  ${checkpoint.step}${missing}`);
    console.log(`    at        ${checkpoint.at}`);
    if (checkpoint.gitHead) console.log(`    git HEAD  ${checkpoint.gitHead.slice(0, 12)}`);
    if (checkpoint.artifacts.length > 0) {
      console.log(`    artifacts ${checkpoint.artifacts.join(", ")}`);
    }
  }

  console.log("");
  console.log("Rewind with: pi rewind --to <step>");
  return 0;
}

function cmdRewind(workspace: Workspace, args: Args): number {
  const { runId, paths } = requireActiveRun(workspace.projectDir);
  const store = createStateStore(paths);
  const state = store.read();
  const workflow = requireWorkflow(workspace, state.workflow);

  const target = flagString(args, "to") ?? flagString(args, "step");
  if (!target) {
    console.error("Usage: pi rewind --to <step> [--yes]");
    console.error("Run `pi checkpoints` to see where you can rewind to.");
    return 2;
  }

  const plan = planRewind(paths, state, workflow, target);

  // A rewind throws work away, so it is shown before it is done. Without
  // `--yes` this is a dry run and nothing on disk changes.
  console.log(
    plan.from
      ? `Rewind run ${runId} to "${plan.target}", restoring the checkpoint taken after "${plan.from.step}".`
      : `Rewind run ${runId} to the start, before any step ran.`,
  );
  console.log("");
  console.log(`  undoes    ${plan.undone.join(", ") || "nothing"}`);
  console.log(`  discards  ${plan.discardedReceipts} review receipt(s)`);
  if (plan.from?.gitHead) {
    console.log(`  code was  ${plan.from.gitHead.slice(0, 12)} at that checkpoint`);
  }
  console.log("");
  console.log("Your files are not touched. pi moves its own state; moving the code is yours.");

  if (args.flags.get("yes") !== true) {
    console.log("");
    console.log("Nothing changed. Re-run with --yes to apply.");
    return 0;
  }

  store.restore(plan.state);
  createEventLog(paths.events, runId).appendAll(rewindEvents(plan));
  discardSnapshots(paths, plan.undone);

  console.log("");
  console.log(`Rewound. Next step: ${plan.state.currentStep ?? "none"}`);
  return 0;
}

function cmdDocs(workspace: Workspace, args: Args): number {
  const [subcommand] = args.positional;
  const outDir = flagString(args, "out") ?? "dist/docs";
  const docsDir = workspace.config.docs.dir;

  if (subcommand === "build") {
    const result = buildStaticSite(workspace.projectDir, outDir, docsDir);

    if (result.pages.length === 0) {
      console.error(
        `No sequenced pages found under ${docsDir}/. ` +
          `Name files with a two-digit prefix, e.g. 01-what-pi-is.md.`,
      );
      return 1;
    }

    console.log(`Built ${result.pages.length} page(s) to ${result.outDir}/`);
    for (const page of result.pages) {
      console.log(`  ${String(page.order).padStart(2, "0")}  ${page.sourcePath}`);
    }
    return 0;
  }

  if (subcommand === "serve") {
    const host = flagString(args, "host") ?? "127.0.0.1";
    const port = Number(flagString(args, "port") ?? "4173");
    const skipBuild = args.flags.has("no-build");
    const absoluteOut = join(workspace.projectDir, outDir);

    if (!skipBuild) {
      const result = buildStaticSite(workspace.projectDir, outDir, docsDir);
      if (result.pages.length === 0) {
        console.error(
          `No sequenced pages found under ${docsDir}/. ` +
            `Name files with a two-digit prefix, e.g. 01-what-pi-is.md.`,
        );
        return 1;
      }
      console.log(`Built ${result.pages.length} page(s) to ${result.outDir}/`);
    }

    serveStaticSite(absoluteOut, { host, port })
      .then(() => {
        console.log(`Serving ${absoluteOut} at http://${host}:${port}/`);
        console.log("Press Ctrl+C to stop.");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exit(1);
      });

    return 0;
  }

  console.error("Usage: pi docs build [--out <dir>] | pi docs serve [--port <n>] [--host <addr>] [--no-build]");
  return 2;
}

function cmdDoctor(workspace: Workspace): number {
  let failures = 0;
  const ok = (message: string) => console.log(`ok    ${message}`);
  const bad = (message: string) => {
    console.log(`FAIL  ${message}`);
    failures++;
  };

  existsSync(workspace.configPath)
    ? ok(`${CONFIG_FILE} present`)
    : console.log(`warn  no ${CONFIG_FILE}; using defaults (run \`pi init\`)`);

  isInstalled(workspace.projectDir, workspace.config.harness)
    ? ok(`wired into ${workspace.config.harness}`)
    : console.log(
        `warn  not wired into ${workspace.config.harness}; guards will not run ` +
          `automatically (run \`pi install\`)`,
      );

  workspace.roster.agents.size > 0
    ? ok(`${workspace.roster.agents.size} persona(s) loaded`)
    : bad("no personas loaded");

  for (const failure of workspace.roster.broken) bad(failure.message);

  workspace.workflows.size > 0
    ? ok(`${workspace.workflows.size} workflow(s) loaded`)
    : bad("no workflows loaded");

  for (const broken of workspace.broken) {
    bad(`${broken.source} failed to compile`);
    for (const issue of broken.issues) {
      console.log(`        ${issue.path || "(root)"}: ${issue.message}`);
    }
  }

  const runs = listRuns(workspace.projectDir);
  ok(`${runs.length} run(s) on disk`);

  const active = activeRunId(workspace.projectDir);
  if (active) {
    const paths = runPaths(workspace.projectDir, active);
    try {
      const state = createStateStore(paths).read();
      ok(`active run ${active} is readable`);

      // Not a failure: pi is meant to survive being upgraded mid-run. But if a
      // run starts behaving oddly right after an upgrade, this is the line that
      // explains why, so it is worth saying out loud.
      if (state.piVersion && state.piVersion !== VERSION) {
        console.log(
          `warn  this run was started by pi ${state.piVersion}; you are on ${VERSION}`,
        );
      }
    } catch (cause) {
      bad(`active run ${active} is unreadable: ${(cause as Error).message}`);
    }

    const damaged = createEventLog(paths.events, active).readDamaged();
    damaged.length === 0
      ? ok("event log is intact")
      : bad(`${damaged.length} unreadable event line(s) (first at line ${damaged[0]?.line})`);

    try {
      const problems = auditSnapshots(paths, createStateStore(paths).read());
      problems.length === 0
        ? ok("checkpoints match their snapshots")
        : problems.forEach((problem) => bad(problem));
    } catch {
      // Unreadable state is already reported above; no need to say it twice.
    }
  }

  console.log("");
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderDirective(directive: Directive): void {
  switch (directive.kind) {
    case DirectiveKind.RunStep: {
      const { progress } = directive;
      console.log(`Step ${progress.index + 1}/${progress.total}: ${directive.step} — ${directive.agent}`);
      console.log(directive.objective);
      if (directive.attempt > 1) console.log(`Attempt ${directive.attempt}. Feedback: ${directive.feedback}`);
      console.log("");

      if (directive.consumes.length > 0) {
        console.log("Reads:");
        for (const ref of directive.consumes) {
          console.log(`  ${ref.present ? " " : "!"} ${ref.name}  ${ref.path}`);
        }
      }
      if (directive.produces.length > 0) {
        console.log("Writes:");
        for (const ref of directive.produces) console.log(`    ${ref.name}  ${ref.path}`);
      }
      if (directive.tools.length > 0) console.log(`Tools: ${directive.tools.join(", ")}`);
      if (directive.changeBudget) {
        console.log(
          `Budget: ${directive.changeBudget.maxFiles} files / ${directive.changeBudget.maxLines} lines before review`,
        );
      }
      for (const warning of directive.warnings) console.log(`\nwarning: ${warning}`);
      console.log("");
      console.log(`When finished: pi report --step ${directive.step} --result completed`);
      return;
    }

    case DirectiveKind.AwaitReview:
      console.log(directive.narration);
      console.log("");
      console.log(directive.summary);
      for (const file of directive.files) console.log(`  ${file}`);
      console.log(`  ${directive.changedLines} lines`);
      console.log("");
      console.log("Approve with: pi review resolve --approve");
      return;

    case DirectiveKind.AwaitApproval:
      console.log(directive.narration);
      if (directive.artifacts.length > 0) {
        console.log("");
        for (const artifact of directive.artifacts) console.log(`  ${artifact.path}`);
      }
      console.log("");
      console.log(`Approve: pi report --step ${directive.step} --result approved`);
      console.log(`Send back: pi report --step ${directive.step} --result rejected --feedback "..."`);
      return;

    case DirectiveKind.Done:
      console.log(directive.summary);
      return;

    case DirectiveKind.Error:
      console.error(directive.message);
      return;
  }
}

const USAGE = `pi — a workflow harness for coding agents

Usage
  pi init [--force] [--no-gitignore]       scaffold pi.config.json in this project
  pi install [--no-gitignore]              wire pi into your coding tool's hooks
  pi uninstall [--purge]                   take pi back out; --purge drops config+history
  pi start "<goal>" [--workflow <id>]      begin a run
  pi runs [--use <id>] [--json]            list runs, or switch to one
  pi status [--json]                       where the active run is
  pi next [--brief] [--json]               what to do now; --brief for the full prompt
  pi report --step <id> --result <r>       record the outcome of a step
             [--artifacts a,b] [--feedback "..."] [--error "..."]
  pi review request --summary "..."        stop and ask for review of a change
                    --files a,b [--lines n]
  pi review resolve --approve              answer the open review
                    | --reject --feedback "..."
  pi review status                         reviews on the current step
  pi guard --tool <id> [--files a,b]       may this tool call proceed? (for hooks)
           [--lines n] [--record]
  pi human-turn [--source <name>]          record that a human acted (gates need this)
  pi log [--step <id>] [--json]            the run's event history
  pi workflows [<id>] [--json]             list workflows, or show one
  pi agents [<id>] [--json]                list personas, or show one
  pi sensors [--step <id>] [--list]        dry-run the current step's checks
  pi checkpoints                           list the boundaries you can rewind to
  pi rewind --to <step> [--yes]            move the run back to a boundary
  pi doctor                                check this project's setup
  pi docs build [--out <dir>]              build a static site from sequenced docs
  pi docs serve [--port <n>] [--host <a>]   build (unless --no-build) and serve locally
  pi version

Results for --result: completed, needs-review, approved, rejected, failed`;

function main(argv: string[]): number {
  // `pi engine next` and `pi next` are the same thing: the conductor skill uses
  // the namespaced form, humans use the short one.
  const tokens = argv[0] === "engine" ? argv.slice(1) : argv;
  const [verb, ...rest] = tokens;
  const args = parseArgs(rest);
  const projectDir = flagString(args, "project-dir") ?? process.cwd();

  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    console.log(USAGE);
    return verb ? 0 : 2;
  }

  if (verb === "version" || verb === "--version") {
    if (wantsJson(args)) {
      console.log(JSON.stringify(versionInfo(), null, 2));
      return 0;
    }
    console.log(VERSION);
    return 0;
  }

  if (verb === "init") return cmdInit(projectDir, args);

  const workspace = openWorkspace(projectDir);

  switch (verb) {
    case "install":
      return cmdInstall(workspace, args);
    case "uninstall":
      return cmdUninstall(workspace, args);
    case "start":
      return cmdStart(workspace, args);
    case "next":
      return cmdNext(workspace, args);
    case "agents":
    case "agent":
      return cmdAgents(workspace, args);
    case "sensors":
    case "sensor":
      return cmdSensors(workspace, args);
    case "report":
      return cmdReport(workspace, args);
    case "human-turn":
      return cmdHumanTurn(workspace, args);
    case "guard":
      return cmdGuard(workspace, args);
    case "review":
      return cmdReview(workspace, args);
    case "runs":
    case "run":
      return cmdRuns(workspace, args);
    case "status":
      return cmdStatus(workspace, args);
    case "log":
      return cmdLog(workspace, args);
    case "workflows":
    case "workflow":
      return cmdWorkflows(workspace, args);
    case "checkpoints":
    case "checkpoint":
      return cmdCheckpoints(workspace, args);
    case "rewind":
      return cmdRewind(workspace, args);
    case "doctor":
      return cmdDoctor(workspace);
    case "docs":
    case "doc":
      return cmdDocs(workspace, args);
    default:
      console.error(`Unknown command "${verb}".\n`);
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (cause) {
  if (
    cause instanceof WorkspaceError ||
    cause instanceof RouterError ||
    cause instanceof ReviewError ||
    cause instanceof CheckpointError ||
    cause instanceof InstallError
  ) {
    // Expected, explainable failures: say the one useful sentence, not a stack.
    console.error(cause.message);
    process.exitCode = 1;
  } else {
    throw cause;
  }
}

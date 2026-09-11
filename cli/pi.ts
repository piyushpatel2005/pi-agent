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
  Permission,
  denialEvent,
  evaluate,
  recordChange,
  type ToolCall,
} from "../core/engine/guard.ts";
import { ReviewError, parseReviewedFile, requestReview, resolveReview } from "../core/engine/review.ts";
import { runPaths } from "../core/engine/paths.ts";
import {
  RouterError,
  StepResult,
  applyReport,
  markStepStarted,
  next as routeNext,
  planSteps,
} from "../core/engine/router.ts";
import { createStateStore } from "../core/engine/state-store.ts";
import {
  CONFIG_FILE,
  WorkspaceError,
  activeRunId,
  listRuns,
  openWorkspace,
  requireActiveRun,
  requireWorkflow,
  setActiveRun,
  type Workspace,
} from "../core/engine/workspace.ts";
import { EventType, type PiEvent } from "../core/schemas/events.ts";
import { DirectiveKind, type Directive } from "../core/schemas/directive.ts";
import { RunState, RunStatus, STATE_VERSION, StepStatus } from "../core/schemas/state.ts";

const VERSION = "0.0.1";

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
  };

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  mkdirSync(join(projectDir, "pi", "workflows"), { recursive: true });

  console.log(`Wrote ${CONFIG_FILE} and pi/workflows/.`);
  console.log("");
  console.log("Next:");
  console.log(`  1. Edit ${CONFIG_FILE} — the "facts" decide which steps apply to this project.`);
  console.log('  2. Run `pi start "what you want to build"`.');
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

  const runId = randomUUID();
  const paths = runPaths(workspace.projectDir, runId);
  const store = createStateStore(paths);
  const log = createEventLog(paths.events, runId);
  const createdAt = new Date().toISOString();

  store.init(
    RunState.parse({
      version: STATE_VERSION,
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
    console.log(JSON.stringify({ runId, workflow: workflow.id, goal }, null, 2));
    return 0;
  }

  console.log(`Started ${workflow.name} — ${goal}`);
  console.log(`Run ${runId}`);
  if (skipped.length > 0) {
    console.log("");
    console.log("Not applicable to this project (from pi.config.json facts):");
    for (const [id, step] of skipped) console.log(`  ${id} — ${step.skipReason}`);
  }
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
  store.update((draft) => {
    emitted = applyReport(draft, workflow, {
      step,
      result,
      artifacts,
      feedback: flagString(args, "feedback"),
      error: flagString(args, "error"),
    });
  });
  log.appendAll(emitted);

  if (wantsJson(args)) {
    console.log(JSON.stringify({ step, result, events: emitted.map((e) => e.type) }, null, 2));
    return 0;
  }

  console.log(`Recorded: ${step} → ${result}`);
  for (const event of emitted) console.log(`  ${event.type}`);
  return 0;
}

// ── The guard ───────────────────────────────────────────────────────────────
//
// This is the hook entry point. It runs on every tool call, so it stays quiet,
// fast, and fails open: if the guard cannot tell whether something is allowed,
// blocking the user's editor is worse than letting the call through.

function toolCallFrom(args: Args): ToolCall {
  const files = flagString(args, "files")
    ?.split(",")
    .map((file) => file.trim())
    .filter(Boolean);

  const lines = Number.parseInt(flagString(args, "lines") ?? "0", 10);

  return {
    tool: flagString(args, "tool") ?? "",
    files: files ?? [],
    lines: Number.isNaN(lines) ? 0 : lines,
  };
}

function cmdGuard(workspace: Workspace, args: Args): number {
  const call = toolCallFrom(args);
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
      return reviewRequest(store, log, args);
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

function reviewRequest(store: Store, log: Log, args: Args): number {
  const summary = flagString(args, "summary");
  const files = flagString(args, "files")
    ?.split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map(parseReviewedFile);

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
      createStateStore(paths).read();
      ok(`active run ${active} is readable`);
    } catch (cause) {
      bad(`active run ${active} is unreadable: ${(cause as Error).message}`);
    }

    const damaged = createEventLog(paths.events, active).readDamaged();
    damaged.length === 0
      ? ok("event log is intact")
      : bad(`${damaged.length} unreadable event line(s) (first at line ${damaged[0]?.line})`);
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
  pi init [--harness <name>] [--force]     scaffold pi.config.json in this project
  pi start "<goal>" [--workflow <id>]      begin a run
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
  pi doctor                                check this project's setup
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
    console.log(VERSION);
    return 0;
  }

  if (verb === "init") return cmdInit(projectDir, args);

  const workspace = openWorkspace(projectDir);

  switch (verb) {
    case "start":
      return cmdStart(workspace, args);
    case "next":
      return cmdNext(workspace, args);
    case "agents":
    case "agent":
      return cmdAgents(workspace, args);
    case "report":
      return cmdReport(workspace, args);
    case "human-turn":
      return cmdHumanTurn(workspace, args);
    case "guard":
      return cmdGuard(workspace, args);
    case "review":
      return cmdReview(workspace, args);
    case "status":
      return cmdStatus(workspace, args);
    case "log":
      return cmdLog(workspace, args);
    case "workflows":
    case "workflow":
      return cmdWorkflows(workspace, args);
    case "doctor":
      return cmdDoctor(workspace);
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
    cause instanceof ReviewError
  ) {
    // Expected, explainable failures: say the one useful sentence, not a stack.
    console.error(cause.message);
    process.exitCode = 1;
  } else {
    throw cause;
  }
}

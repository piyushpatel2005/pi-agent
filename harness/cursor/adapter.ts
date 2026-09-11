#!/usr/bin/env node
// The Cursor hook adapter.
//
// Cursor calls this before and after every tool call. Its job is translation:
// take Cursor's payload, work out which pi tool the call corresponds to and
// what it would touch, ask the engine, and answer in the shape Cursor expects.
//
// Cursor's contract, which shapes everything below:
//   - Event names are camelCase (preToolUse, postToolUse, ...).
//   - preToolUse must print {"permission":"allow"|"deny"} on stdout; a denial
//     may carry an `agent_message`. Empty or malformed stdout is a failure, so
//     this file must print valid JSON on every path it can possibly take.
//   - sessionStart context is {"additional_context"} (snake_case).
//   - stop may only offer {"followup_message"}, which Cursor submits as the
//     next user message. pi deliberately does not use it: see below.
//
// This adapter fails OPEN: any internal error allows the call. A guard that
// bricks someone's editor when pi has a bug is worse than one that occasionally
// misses a write, and the run's own gates still catch the work at review time.

import { createEventLog } from "../../core/engine/event-log.ts";
import {
  Permission,
  denialEvent,
  evaluate,
  recordChange,
  type ToolCall,
} from "../../core/engine/guard.ts";
import { runPaths } from "../../core/engine/paths.ts";
import { createStateStore } from "../../core/engine/state-store.ts";
import {
  activeRunId,
  openWorkspace,
  type Workspace,
} from "../../core/engine/workspace.ts";
import { ToolName } from "../../core/schemas/agent.ts";
import { EventType } from "../../core/schemas/events.ts";
import { StepStatus } from "../../core/schemas/state.ts";
import { existsSync, readFileSync } from "node:fs";

type CursorInput = {
  hook_event_name?: string;
  conversation_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

const ALLOW = JSON.stringify({ permission: Permission.Allow });

// ── Tool mapping ────────────────────────────────────────────────────────────
//
// Cursor's tool names to pi's. Anything unmapped is unknown to pi and passes
// through: pi governs the work it knows about, not every button in the editor.

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "Search", "LS", "Codebase"]);

// Cursor's actual edit tools. `StrReplace` is the one that matters: it is how
// nearly every edit is made, and while it was missing here the guard never saw
// an edit at all — budgets and review requirements were inert, and nothing said
// so, because an unmapped tool is allowed silently.
const WRITE_TOOLS = new Set(["Write", "StrReplace", "EditNotebook", "Delete"]);

function mapTool(input: CursorInput, files: string[], workspace: Workspace): string | null {
  const name = input.tool_name ?? "";

  if (READ_TOOLS.has(name)) return ToolName.Read;
  if (name === "Shell" || name === "Bash" || name === "Terminal") return ToolName.RunCommand;
  if (name === "Task" || name === "Agent") return ToolName.Delegate;

  if (WRITE_TOOLS.has(name)) {
    // Writing a step's own artifact is not the same act as changing the
    // repository, and must not spend the code budget — otherwise producing the
    // summary a reviewer asked for is itself over budget.
    return files.length > 0 && files.every((file) => isArtifact(file, workspace))
      ? ToolName.WriteArtifact
      : ToolName.WriteCode;
  }

  return null;
}

// ── The control plane ───────────────────────────────────────────────────────
//
// Every refusal names a `pi` command that puts things right. If that command is
// itself governed, the refusal is unactionable: the verbs that move a run all
// have to run while no step is active or while one is frozen at a gate, which
// is precisely when nothing is granted. So pi's own read-and-advance verbs are
// answered here, before the guard is consulted at all.
//
// This is an allowlist, not a denylist. A verb that removes the guard or
// discards the run (`install`, `uninstall`, `start`, `rewind`, `abandon`) is
// absent on purpose, so a refusal stays a decision rather than an
// inconvenience.

const CONTROL_VERBS: ReadonlySet<string> = new Set([
  "status", "next", "report", "log", "runs", "review",
  "sensors", "checkpoints", "workflows", "agents", "doctor", "version",
]);

/**
 * The one verb a model must never reach, in any state.
 *
 * Human presence is what makes a gate mean something. A model that could mint
 * its own human turn could approve its own work.
 */
const HUMAN_TURN = "human-turn";

/**
 * Anything that lets a second command ride along on the first.
 *
 * `pi status && rm -rf build` is not a pi command, and neither is
 * `pi status > overwrite.ts`. Rather than try to parse a shell, treat any
 * metacharacter as disqualifying.
 */
const SHELL_METACHARACTERS = /[;&|<>`$()]/;

/** The pi verb this command invokes, or null if it is not a bare pi command. */
function piVerb(command: string): string | null {
  if (SHELL_METACHARACTERS.test(command)) return null;

  const words = command.trim().split(/\s+/);
  let at = 0;

  if (words[0] === "node") {
    // Run from a checkout: `node cli/pi.ts <verb>`, path or not.
    if (!words[1]?.endsWith("pi.ts")) return null;
    at = 2;
  } else if (words[0] === "pi" || words[0]?.endsWith("/pi")) {
    at = 1;
  } else {
    return null;
  }

  // `pi engine next` is the same verb as `pi next`.
  if (words[at] === "engine") at += 1;

  return words[at] ?? null;
}

function commandOf(input: CursorInput): string | null {
  const command = (input.tool_input ?? {}).command;
  return typeof command === "string" && command.trim() !== "" ? command : null;
}

function isArtifact(file: string, workspace: Workspace): boolean {
  const runId = activeRunId(workspace.projectDir);
  if (!runId) return false;

  return file.startsWith(runPaths(workspace.projectDir, runId).artifacts);
}

// ── Payload extraction ──────────────────────────────────────────────────────

function filesOf(toolInput: Record<string, unknown>): string[] {
  const files: string[] = [];

  const single = toolInput.file_path ?? toolInput.path ?? toolInput.target_file;
  if (typeof single === "string" && single !== "") files.push(single);

  // MultiEdit carries its own list.
  const edits = toolInput.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const path = (edit as Record<string, unknown>)?.file_path;
      if (typeof path === "string" && path !== "" && !files.includes(path)) files.push(path);
    }
  }

  return files;
}

function countLines(value: unknown): number {
  return typeof value === "string" && value !== "" ? value.split("\n").length : 0;
}


function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * How many lines differ between two versions of a file.
 *
 * Line multisets rather than a real diff: for a budget, a moved line is not a
 * changed line, and an exact LCS buys precision nobody spends.
 */
function changedLines(before: string, after: string): number {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split("\n")) {
    const seen = counts.get(line) ?? 0;
    if (seen > 0) counts.set(line, seen - 1);
    else added++;
  }
  let removed = 0;
  for (const remaining of counts.values()) removed += remaining;
  return Math.max(added, removed);
}
/**
 * How many lines this call would touch.
 *
 * Cursor applies an edit as a whole-file write, so `tool_input` carries the
 * resulting file and not the edit. Measuring what it sends charges a two-line
 * change for every line in the file, which empties a budget in one call. So
 * compare against what is on disk: `preToolUse` runs before the write, and the
 * difference is the size of the actual edit.
 */
function linesOf(toolInput: Record<string, unknown>, file: string | undefined): number {
  const edits = toolInput.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    return edits.reduce((total: number, raw) => {
      const edit = (raw ?? {}) as Record<string, unknown>;
      return total + Math.max(countLines(edit.new_string), countLines(edit.old_string));
    }, 0);
  }
  const editText = Math.max(countLines(toolInput.new_string), countLines(toolInput.old_string));
  if (editText > 0) return editText;
  const whole = textOf(toolInput.contents) ?? textOf(toolInput.content);
  if (whole === null) return 0;
  // A new file is all of itself; an edit to an existing one is only what it changes.
  if (!file || !existsSync(file)) return countLines(whole);
  try {
    return changedLines(readFileSync(file, "utf-8"), whole);
  } catch {
    return countLines(whole);
  }
}


function toolCallOf(input: CursorInput, workspace: Workspace): ToolCall | null {
  const toolInput = input.tool_input ?? {};
  const files = filesOf(toolInput);
  const tool = mapTool(input, files, workspace);

  return tool === null ? null : { tool, files, lines: linesOf(toolInput, files[0]) };
}

// ── Targets ─────────────────────────────────────────────────────────────────

/**
 * Which project this event is about.
 *
 * A multi-root workspace sends every root, in no particular order, and some
 * events carry no `cwd` at all. Taking the first root is wrong whenever the run
 * lives in another one: the guard waves every call through, and — worse —
 * `beforeSubmitPrompt` records the human turn against a project with no run, so
 * it is dropped and no gate can ever be cleared. Both failures are silent.
 *
 * So prefer whichever candidate actually has a run.
 */
function projectDirOf(input: CursorInput): string {
  const candidates = [input.cwd, ...(input.workspace_roots ?? [])].filter(
    (dir): dir is string => typeof dir === "string" && dir !== "",
  );

  for (const dir of candidates) {
    if (activeRunId(dir)) return dir;
  }

  return candidates[0] ?? process.cwd();
}

function guard(input: CursorInput): string {
  const projectDir = projectDirOf(input);
  const runId = activeRunId(projectDir);

  // No run means pi is not governing this session. Stay out of the way.
  if (!runId) return ALLOW;

  // pi's own control plane, answered before the guard: see CONTROL_VERBS.
  const command = commandOf(input);
  if (command !== null) {
    const verb = piVerb(command);

    if (verb === HUMAN_TURN) {
      return JSON.stringify({
        permission: Permission.Deny,
        agent_message:
          "`pi human-turn` records that a person was present, which is what an " +
          "approval rests on. It is not yours to run. If a gate is waiting, show " +
          "the human what you have done and end your turn.",
      });
    }

    if (verb !== null && CONTROL_VERBS.has(verb)) return ALLOW;
  }

  const workspace = openWorkspace(projectDir);
  const call = toolCallOf(input, workspace);
  if (!call) return ALLOW;

  const paths = runPaths(projectDir, runId);
  const state = createStateStore(paths).read();
  const loaded = workspace.workflows.get(state.workflow);
  if (!loaded) return ALLOW;

  const agentId = state.currentStep ? state.steps[state.currentStep]?.agent : undefined;

  const verdict = evaluate(state, loaded.workflow, call, {
    agent: agentId ? workspace.roster.agents.get(agentId) : undefined,
  });

  if (verdict.permission === Permission.Allow) return ALLOW;

  createEventLog(paths.events, runId).appendAll(denialEvent(call, verdict, state.currentStep));

  return JSON.stringify({ permission: Permission.Deny, agent_message: verdict.message });
}

function record(input: CursorInput): string {
  const projectDir = projectDirOf(input);
  const runId = activeRunId(projectDir);
  if (!runId) return "";

  const workspace = openWorkspace(projectDir);
  const call = toolCallOf(input, workspace);

  // Only repository changes count. Artifact writes are the step's own output
  // and must not spend the budget meant for code.
  if (!call || call.tool !== ToolName.WriteCode) return "";
  if ((call.files?.length ?? 0) === 0) return "";

  createStateStore(runPaths(projectDir, runId)).update((draft) => recordChange(draft, call));
  return "";
}

/**
 * A human submitted a prompt, which is the evidence gates rest on.
 *
 * Cursor fires beforeSubmitPrompt only for interactive, top-level submissions.
 * A headless run mints none, which is exactly why an unattended agent cannot
 * approve its own work.
 */
function humanTurn(input: CursorInput): string {
  const projectDir = projectDirOf(input);
  const runId = activeRunId(projectDir);
  if (!runId) return "";

  const paths = runPaths(projectDir, runId);
  createStateStore(paths).update((draft) => {
    draft.lastHumanTurnAt = new Date().toISOString();
  });
  createEventLog(paths.events, runId).append({
    type: EventType.HumanTurn,
    source: "cursor:beforeSubmitPrompt",
  });

  return "";
}

/** Tell a new session where the run stands, so it does not have to ask. */
function sessionStart(input: CursorInput): string {
  const projectDir = projectDirOf(input);
  const runId = activeRunId(projectDir);
  if (!runId) return "";

  const state = createStateStore(runPaths(projectDir, runId)).read();
  const waiting = state.currentStep ? state.steps[state.currentStep] : undefined;

  const lines = [
    `A pi run is active: "${state.goal}" (workflow \`${state.workflow}\`).`,
    `Current step: ${state.currentStep ?? "none"}${waiting ? ` (${waiting.status})` : ""}.`,
    "Run `pi next` to see what to do, and `pi report` when a step is done.",
    "Tool calls are guarded: a refusal will tell you what to do instead.",
  ];

  return JSON.stringify({ additional_context: lines.join(" ") });
}

// ── There is deliberately no `stop` target ──────────────────────────────────
//
// It is tempting to nudge from `stop` when a run is left waiting at a gate.
// Do not. The only channel `stop` has is `followup_message`, and Cursor submits
// that as the next user message — which fires `beforeSubmitPrompt`, which is
// where `humanTurn` records that a person was present.
//
// So the nudge minted the very evidence a gate rests on. pi generated a string,
// Cursor handed it back, and pi recorded it as a human. Measured across two
// runs: every gate resolved from chat had a human turn 9 to 15 seconds after it
// opened, while gates resolved from a terminal had theirs minutes apart. That
// made `hasHumanPresence` self-satisfying and the claim that an unattended run
// cannot approve its own work false.
//
// The payload gives no way to tell the two apart: `beforeSubmitPrompt` receives
// only `{ prompt, attachments }` and the fields every hook gets. No `source`,
// no `is_followup`. `loop_count` exists, but on the `stop` payload — the wrong
// side of the loop.
//
// The second reason stands on its own: a gate exists to END the agent's turn.
// A followup auto-continues it at exactly the moment it must stop, so the hook
// was fighting the gate it reported on. A waiting gate surfaces through the
// agent's closing message and `pi status` instead.

// ── Entry ───────────────────────────────────────────────────────────────────

const TARGETS: Record<string, (input: CursorInput) => string> = {
  guard,
  record,
  "human-turn": humanTurn,
  "session-start": sessionStart,
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? "";
  const handler = TARGETS[target];

  // An unknown target must still answer, or Cursor sees malformed output.
  if (!handler) {
    if (target === "guard") process.stdout.write(ALLOW);
    return;
  }

  let input: CursorInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim() !== "") input = JSON.parse(raw) as CursorInput;
  } catch {
    // A payload we cannot read is not grounds to block the user's editor.
    if (target === "guard") process.stdout.write(ALLOW);
    return;
  }

  const output = handler(input);
  if (output !== "") process.stdout.write(output);
}

main().catch(() => {
  // Last resort. Same reasoning: fail open, never strand the editor.
  if (process.argv[2] === "guard") process.stdout.write(ALLOW);
});

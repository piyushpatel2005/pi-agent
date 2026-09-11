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
//   - stop cannot refuse a stop; it may only offer {"followup_message"}.
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
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "Delete", "Create"]);
const SHELL_TOOLS = new Set(["Shell", "Bash", "Terminal"]);

function mapTool(input: CursorInput, files: string[], workspace: Workspace): string | null {
  const name = input.tool_name ?? "";

  if (READ_TOOLS.has(name)) return ToolName.Read;
  if (SHELL_TOOLS.has(name)) {
    return isControlCommand(input.tool_input ?? {}) ? null : ToolName.RunCommand;
  }
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
// pi's own steering commands are not the work; they are how the work is
// directed, and how a refusal is obeyed. Guarding them deadlocks the loop: the
// guard denies `run-command` at every gate and then says "run `pi next`", which
// is a `run-command`. Every escape hatch welded shut by the guard pointing at
// it.
//
// The allowance is a list rather than "anything named pi", because `install`,
// `uninstall`, `rewind`, and `start` reshape the run or remove the guard
// itself. Those stay governed, so the model cannot unguard itself or discard
// the history to get past a refusal.

const CONTROL_VERBS = new Set([
  "next",
  "report",
  "status",
  "log",
  "review",
  "runs",
  "run",
  "workflows",
  "agents",
  "sensors",
  "checkpoints",
  "doctor",
  "version",
  "human-turn",
]);

function isPiProgram(token: string): boolean {
  return token === "pi" || token.endsWith("/pi");
}

function isScriptRunner(token: string): boolean {
  const base = token.slice(token.lastIndexOf("/") + 1);
  return base === "node" || base === "bun";
}

/** Is this shell call one of pi's own steering commands? */
function isControlCommand(toolInput: Record<string, unknown>): boolean {
  const raw = toolInput.command;
  if (typeof raw !== "string") return false;

  const command = raw.trim();

  // A single invocation and nothing else. `pi status && rm -rf build` is not a
  // pi command, and letting an operator through would turn this into the
  // general-purpose escape hatch it exists to avoid.
  if (/[;&|><`$(){}\n]/.test(command)) return false;

  const tokens = command.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return false;

  // Either `pi <verb>` or, from a checkout, `node cli/pi.ts <verb>`.
  const verb = isPiProgram(tokens[0]!)
    ? tokens[1]
    : isScriptRunner(tokens[0]!) && /(^|\/)pi\.ts$/.test(tokens[1] ?? "")
      ? tokens[2]
      : undefined;

  return verb !== undefined && CONTROL_VERBS.has(verb);
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

/**
 * How many lines this call would touch.
 *
 * For an edit we take the larger of the old and new text rather than their sum:
 * rewriting twenty lines as twenty-two is a twenty-two line change, not a
 * forty-two line one, and inflating it would spend budgets the reviewer never
 * sees the benefit of.
 */
function linesOf(toolInput: Record<string, unknown>): number {
  const direct = Math.max(
    countLines(toolInput.contents ?? toolInput.content),
    countLines(toolInput.new_string),
    countLines(toolInput.old_string),
  );

  const edits = toolInput.edits;
  if (!Array.isArray(edits)) return direct;

  return edits.reduce((total: number, raw) => {
    const edit = (raw ?? {}) as Record<string, unknown>;
    return total + Math.max(countLines(edit.new_string), countLines(edit.old_string));
  }, direct);
}

function toolCallOf(input: CursorInput, workspace: Workspace): ToolCall | null {
  const toolInput = input.tool_input ?? {};
  const files = filesOf(toolInput);
  const tool = mapTool(input, files, workspace);

  return tool === null ? null : { tool, files, lines: linesOf(toolInput) };
}

// ── Targets ─────────────────────────────────────────────────────────────────

function projectDirOf(input: CursorInput): string {
  return input.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
}

function guard(input: CursorInput): string {
  const projectDir = projectDirOf(input);
  const runId = activeRunId(projectDir);

  // No run means pi is not governing this session. Stay out of the way.
  if (!runId) return ALLOW;

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

/**
 * Cursor's stop hook cannot refuse a stop, so an unfinished run surfaces as a
 * nudge rather than a block. Advisory by design, and honest about it.
 */
function stop(input: CursorInput): string {
  const projectDir = projectDirOf(input);
  const runId = activeRunId(projectDir);
  if (!runId) return "";

  const state = createStateStore(runPaths(projectDir, runId)).read();
  if (state.status !== "active" || state.currentStep === null) return "";

  const stepState = state.steps[state.currentStep];
  if (!stepState) return "";

  if (stepState.status === StepStatus.AwaitingReview) {
    return JSON.stringify({
      followup_message:
        `Step "${state.currentStep}" is waiting on your review. ` +
        `Run \`pi review status\` to see it.`,
    });
  }

  if (stepState.status === StepStatus.AwaitingApproval) {
    return JSON.stringify({
      followup_message:
        `Step "${state.currentStep}" is done and waiting for your approval. ` +
        `Run \`pi next\` to see it.`,
    });
  }

  return "";
}

// ── Entry ───────────────────────────────────────────────────────────────────

const TARGETS: Record<string, (input: CursorInput) => string> = {
  guard,
  record,
  "human-turn": humanTurn,
  "session-start": sessionStart,
  stop,
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

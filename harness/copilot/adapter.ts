#!/usr/bin/env node
// The GitHub Copilot hook adapter — Copilot's analog of
// harness/cursor/adapter.ts. Translates Copilot's hook payloads into pi's
// guard/ToolCall contract and answers in the shape Copilot expects.
//
// Hooks are registered (see install.ts) under their PascalCase,
// Claude-Code-shaped names (SessionStart, UserPromptSubmit, PreToolUse,
// PostToolUse), which selects the snake_case payload dialect GitHub's own
// hooks reference documents as matching "the VS Code Copilot extension
// format" — verified by aidlc-workflows to work across both Copilot CLI and
// VS Code Copilot Chat agent mode.
//
// Two contract differences from Cursor that matter here:
//   - Empty stdout on preToolUse means "allow" (Cursor requires an explicit
//     {"permission":"allow"}).
//   - A non-zero, non-2 exit from a command hook fails CLOSED for
//     preToolUse, so this adapter must never exit non-zero.
//
// Fails open on every internal error, for the same reason Cursor's adapter
// does: a bug in pi must not brick someone's session.
//
// Deliberately no agentStop/Stop target: its decision control can force
// another turn from a `reason` string, the same hazard as Cursor's
// followup_message minting a human turn nobody actually took.

import { createEventLog } from "../../core/engine/event-log.ts";
import {
  Permission,
  denialEvent,
  evaluate,
  recordChange,
  type ToolCall,
} from "../../core/engine/guard.ts";
import { repoPath, runPaths } from "../../core/engine/paths.ts";
import { createStateStore } from "../../core/engine/state-store.ts";
import { activeRunId, openWorkspace, type Workspace } from "../../core/engine/workspace.ts";
import { ToolName } from "../../core/schemas/agent.ts";
import { EventType } from "../../core/schemas/events.ts";

type CopilotInput = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

// Copilot's tool names ("Tool names for hook matching" in its hooks
// reference) mapped to pi's. Unmapped names pass through allowed, same as an
// unmapped Cursor tool.
const READ_TOOLS = new Set(["view", "grep", "glob"]);
const WRITE_TOOLS = new Set(["create", "edit", "str_replace_editor", "apply_patch"]);

function mapTool(name: string, files: string[], workspace: Workspace): string | null {
  if (READ_TOOLS.has(name)) return ToolName.Read;
  if (name === "bash" || name === "powershell") return ToolName.RunCommand;
  if (name === "task") return ToolName.Delegate;

  if (WRITE_TOOLS.has(name)) {
    // Writing a step's own artifact is not changing the repository — same
    // rule as harness/cursor/adapter.ts.
    return files.length > 0 && files.every((file) => isArtifact(file, workspace))
      ? ToolName.WriteArtifact
      : ToolName.WriteCode;
  }

  return null;
}

// ── pi's own control plane ──────────────────────────────────────────────────
// Identical allowlist/reasoning to harness/cursor/adapter.ts: keep pi's
// read-and-advance verbs reachable no matter what is granted; never let a
// model reach `pi human-turn`, the one command that could mint the presence a
// gate rests on; `install`/`uninstall`/`start`/`rewind`/`abandon` stay off the
// list because each removes the guard or discards the run.
const CONTROL_VERBS: ReadonlySet<string> = new Set([
  "status", "next", "report", "log", "runs", "review",
  "sensors", "checkpoints", "workflows", "agents", "doctor", "version",
]);
const HUMAN_TURN = "human-turn";
const SHELL_METACHARACTERS = /[;&|<>`$()]/;

/**
 * Same split as harness/cursor/adapter.ts: `pi agents` reads a persona, but
 * `pi agents --eject` writes one into the repository, so the eject form falls
 * through to the guard rather than being waved past it.
 */
function isControlCommand(command: string, verb: string): boolean {
  if (!CONTROL_VERBS.has(verb)) return false;

  return !(verb === "agents" && /(^|\s)--eject(=|\s|$)/.test(command));
}

/** The pi verb this command invokes, or null if it is not a bare pi command. */
function piVerb(command: string): string | null {
  if (SHELL_METACHARACTERS.test(command)) return null;

  const words = command.trim().split(/\s+/);
  let at = 0;

  if (words[0] === "node") {
    if (!words[1]?.endsWith("pi.ts")) return null;
    at = 2;
  } else if (words[0] === "pi" || words[0]?.endsWith("/pi")) {
    at = 1;
  } else {
    return null;
  }

  if (words[at] === "engine") at += 1;
  return words[at] ?? null;
}

function isArtifact(file: string, workspace: Workspace): boolean {
  const runId = activeRunId(workspace.projectDir);
  return runId !== null && file.startsWith(runPaths(workspace.projectDir, runId).artifacts);
}

// ── Payload extraction ──────────────────────────────────────────────────────

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function countLines(value: string): number {
  return value === "" ? 0 : value.split("\n").length;
}

/** For an edit, the larger of the old and new text — never the sum. */
function linesOf(name: string, toolInput: Record<string, unknown>): number {
  if (name === "create") return countLines(textOf(toolInput.content ?? toolInput.file_text));

  const before = countLines(textOf(toolInput.old_str ?? toolInput.old_string));
  const after = countLines(textOf(toolInput.new_str ?? toolInput.new_string));
  return Math.max(before, after);
}

function toolCallOf(input: CopilotInput, workspace: Workspace): ToolCall | null {
  const name = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const raw = toolInput.path ?? toolInput.file_path;
  const files = typeof raw === "string" && raw !== "" ? [raw] : [];

  const tool = mapTool(name, files, workspace);
  if (tool === null) return null;

  return {
    tool,
    files: files.map((file) => repoPath(workspace.projectDir, file)),
    lines: WRITE_TOOLS.has(name) ? linesOf(name, toolInput) : 0,
  };
}

function projectDirOf(input: CopilotInput): string {
  return input.cwd && input.cwd !== "" ? input.cwd : process.cwd();
}

/**
 * The one deny shape both Copilot surfaces honor: the flat fields the public
 * hooks reference documents, plus the same payload nested under
 * `hookSpecificOutput` the VS Code-format surface needs (per
 * aidlc-workflows's compatibility spike) — cheap to emit both.
 */
function denyJson(hookEventName: string, reason: string): string {
  return `${JSON.stringify({
    permissionDecision: "deny",
    permissionDecisionReason: reason,
    hookSpecificOutput: { hookEventName, permissionDecision: "deny", permissionDecisionReason: reason },
  })}\n`;
}

// ── Targets ──────────────────────────────────────────────────────────────────

function guard(input: CopilotInput): string {
  const projectDir = projectDirOf(input);
  const runId = activeRunId(projectDir);
  if (!runId) return ""; // Not governed; empty output is Copilot's own "allow."

  const command =
    input.tool_name === "bash" || input.tool_name === "powershell"
      ? textOf((input.tool_input ?? {}).command)
      : "";
  if (command !== "") {
    const verb = piVerb(command);
    if (verb === HUMAN_TURN) {
      return denyJson(
        "PreToolUse",
        "`pi human-turn` records that a person was present, which is what an " +
          "approval rests on. It is not yours to run. If a gate is waiting, show " +
          "the human what you have done and end your turn.",
      );
    }
    if (verb !== null && isControlCommand(command, verb)) return "";
  }

  const workspace = openWorkspace(projectDir);
  const call = toolCallOf(input, workspace);
  if (!call) return "";

  const paths = runPaths(projectDir, runId);
  const state = createStateStore(paths).read();
  const loaded = workspace.workflows.get(state.workflow);
  if (!loaded) return "";

  const agentId = state.currentStep ? state.steps[state.currentStep]?.agent : undefined;
  const verdict = evaluate(state, loaded.workflow, call, {
    agent: agentId ? workspace.roster.agents.get(agentId) : undefined,
  });
  if (verdict.permission === Permission.Allow) return "";

  createEventLog(paths.events, runId).appendAll(denialEvent(call, verdict, state.currentStep));
  return denyJson("PreToolUse", verdict.message);
}

function record(input: CopilotInput): string {
  const projectDir = projectDirOf(input);
  const runId = activeRunId(projectDir);
  if (!runId) return "";

  const workspace = openWorkspace(projectDir);
  const call = toolCallOf(input, workspace);
  if (!call || (call.files?.length ?? 0) === 0) return "";

  createStateStore(runPaths(projectDir, runId)).update((draft) => recordChange(draft, call));
  return "";
}

/** A human submitted a prompt — the evidence gates rest on. */
function humanTurn(input: CopilotInput): string {
  const projectDir = projectDirOf(input);
  const runId = activeRunId(projectDir);
  if (!runId) return "";

  const paths = runPaths(projectDir, runId);
  createStateStore(paths).update((draft) => {
    draft.lastHumanTurnAt = new Date().toISOString();
  });
  createEventLog(paths.events, runId).append({
    type: EventType.HumanTurn,
    source: "copilot:UserPromptSubmit",
  });
  return "";
}

/** Tell a new session where the run stands, so it does not have to ask. */
function sessionStart(input: CopilotInput): string {
  const projectDir = projectDirOf(input);
  const runId = activeRunId(projectDir);
  if (!runId) return "";

  const state = createStateStore(runPaths(projectDir, runId)).read();
  const waiting = state.currentStep ? state.steps[state.currentStep] : undefined;
  const additionalContext = [
    `A pi run is active: "${state.goal}" (workflow \`${state.workflow}\`).`,
    `Current step: ${state.currentStep ?? "none"}${waiting ? ` (${waiting.status})` : ""}.`,
    "Run `pi next` to see what to do, and `pi report` when a step is done.",
    "Tool calls are guarded: a refusal will tell you what to do instead.",
  ].join(" ");

  return `${JSON.stringify({
    additionalContext,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  })}\n`;
}

// ── Entry ────────────────────────────────────────────────────────────────────

const TARGETS: Record<string, (input: CopilotInput) => string> = {
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
  // An unknown target must still exit 0 — Copilot's preToolUse contract
  // treats a non-zero exit as a deny.
  if (!handler) return;

  let input: CopilotInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim() !== "") input = JSON.parse(raw) as CopilotInput;
  } catch {
    return; // Malformed input is not grounds to block the session.
  }

  try {
    const output = handler(input);
    if (output !== "") process.stdout.write(output);
  } catch {
    // Fail open: never let an internal error become a silent deny.
  }
}

main().catch(() => {
  // Last resort. Never exit non-zero, never strand the session.
});

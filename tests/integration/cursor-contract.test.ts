// The contract with Cursor, as Cursor documents it rather than as pi assumes it.
//
// Three defects reached a user through a suite that already drove this adapter
// as a subprocess against a live run. `cursor.test.ts` was not missing; it was
// feeding payloads pi had invented — `Edit` and `MultiEdit`, which Cursor does
// not send, and always a `cwd`, which some events do not carry. The tests and
// the code held the same wrong belief about the editor, so they agreed with
// each other and both were wrong.
//
// Everything here is therefore written from Cursor's published hook contract:
// the tool names it says it sends, and the payload fields it says each event
// carries. https://cursor.com/docs/hooks

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "cli", "pi.ts");
const ADAPTER = join(ROOT, "harness", "cursor", "adapter.ts");

const projects: string[] = [];

afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pi(project: string, ...argv: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: project, encoding: "utf-8" });
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
}

/** Call the adapter as Cursor does. `payload` is verbatim: no fields added. */
function hook(project: string, target: string, payload: Record<string, unknown>): string {
  const result = spawnSync(process.execPath, [ADAPTER, target], {
    cwd: project,
    encoding: "utf-8",
    input: JSON.stringify(payload),
  });

  assert.equal(result.status, 0, `adapter exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

type Verdict = { permission: "allow" | "deny"; agent_message?: string };

function guard(project: string, payload: Record<string, unknown>): Verdict {
  const out = hook(project, "guard", { hook_event_name: "preToolUse", cwd: project, ...payload });
  assert.notEqual(out.trim(), "", "preToolUse must always print JSON");
  return JSON.parse(out) as Verdict;
}

function shell(project: string, command: string): Verdict {
  return guard(project, { tool_name: "Shell", tool_input: { command } });
}

function events(project: string): { type: string; source?: string }[] {
  return JSON.parse(pi(project, "log", "--json").out) as { type: string; source?: string }[];
}

/** A project with one workflow. `gate` decides whether its step ends at one. */
function project(gate: "none" | "approval" = "none"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-contract-"));
  projects.push(dir);

  mkdirSync(join(dir, "pi", "workflows"), { recursive: true });
  writeFileSync(
    join(dir, "pi.config.json"),
    JSON.stringify({ version: 1, defaultWorkflow: "one", facts: {} }),
    "utf-8",
  );
  writeFileSync(
    join(dir, "pi", "workflows", "one.workflow.json"),
    JSON.stringify({
      id: "one",
      name: "One step",
      version: 1,
      description: "A single step to guard.",
      defaults: { gate, checkpoint: false },
      steps: [
        {
          id: "build",
          agent: "backend-developer",
          objective: "Build it.",
          produces: ["summary.md"],
          tools: ["read", "write-code", "write-artifact"],
          changeBudget: { maxFiles: 3, maxLines: 50 },
        },
      ],
    }),
    "utf-8",
  );

  return dir;
}

// ── Tool names ──────────────────────────────────────────────────────────────

describe("the tools Cursor actually sends", () => {
  // Cursor's documented preToolUse tool names. `StrReplace` is the one that
  // matters: it is how nearly every edit is made, and while it was absent from
  // the adapter's write set the guard never saw an edit at all. Budgets and
  // review requirements were inert, and nothing said so — an unmapped tool is
  // allowed silently, without even a log line.
  const EDIT_TOOLS = ["Write", "StrReplace", "EditNotebook", "Delete"];

  for (const tool of EDIT_TOOLS) {
    test(`${tool} is governed, not waved through`, () => {
      const dir = project();
      assert.equal(pi(dir, "start", "Guard my edits").code, 0);

      // No step handed out yet, so every write must be refused. If this tool is
      // missing from the adapter's map it falls through as "not pi's business"
      // and this passes as an allow.
      const verdict = guard(dir, {
        tool_name: tool,
        tool_input: { file_path: "src/a.ts", contents: "x\ny" },
      });

      assert.equal(verdict.permission, "deny", `${tool} reached the repository unguarded`);
      assert.match(verdict.agent_message!, /No step is active/);
    });
  }

  test("StrReplace spends the change budget like any other edit", () => {
    const dir = project();
    pi(dir, "start", "Spend the budget");
    pi(dir, "next");

    const input = {
      file_path: "src/a.ts",
      old_string: Array.from({ length: 10 }, () => "a").join("\n"),
      new_string: Array.from({ length: 40 }, () => "b").join("\n"),
    };

    assert.equal(guard(dir, { tool_name: "StrReplace", tool_input: input }).permission, "allow");
    hook(dir, "record", { hook_event_name: "postToolUse", cwd: dir, tool_name: "StrReplace", tool_input: input });

    const state = JSON.parse(pi(dir, "status", "--json").out);
    assert.deepEqual(state.steps.build.changedFiles, ["src/a.ts"]);
    assert.equal(state.steps.build.changedLines, 40, "counted the larger side");

    // 40 spent against a limit of 50: another 40 must not fit.
    const next = guard(dir, {
      tool_name: "StrReplace",
      tool_input: { file_path: "src/b.ts", new_string: input.new_string },
    });
    assert.equal(next.permission, "deny");
    assert.match(next.agent_message!, /against a limit of 50/);
  });

  test("a tool pi genuinely does not know still passes through", () => {
    const dir = project();
    pi(dir, "start", "Stay out of the way");

    assert.equal(guard(dir, { tool_name: "WebSearch", tool_input: { query: "x" } }).permission, "allow");
  });
});

// ── Which project an event belongs to ───────────────────────────────────────

describe("a workspace with more than one folder open", () => {
  // `beforeSubmitPrompt` carries `workspace_roots` and no `cwd`. Taking the
  // first root meant pi looked for a run in whichever folder the editor happened
  // to list first, found none, and returned quietly. The symptom was that
  // approval gates could never be cleared, because the human turn they wait on
  // was being recorded nowhere.
  test("finds the run even when it is not the first root", () => {
    const other = mkdtempSync(join(tmpdir(), "pi-unrelated-"));
    projects.push(other);

    const dir = project();
    assert.equal(pi(dir, "start", "Find me").code, 0);

    hook(dir, "human-turn", {
      hook_event_name: "beforeSubmitPrompt",
      workspace_roots: [other, dir],
    });

    const turn = events(dir).find((event) => event.type === "human.turn");
    assert.equal(turn?.source, "cursor:beforeSubmitPrompt", "the human turn went nowhere");
  });

  test("an approval gate can actually be cleared this way", () => {
    // The end-to-end version of the bug: everything looked wired up, and the
    // run could not be advanced past its first gate.
    const other = mkdtempSync(join(tmpdir(), "pi-unrelated-"));
    projects.push(other);

    const dir = project("approval");
    pi(dir, "start", "Clear my gate");
    pi(dir, "next");
    assert.equal(pi(dir, "report", "--step", "build", "--result", "completed").code, 0);

    hook(dir, "human-turn", {
      hook_event_name: "beforeSubmitPrompt",
      workspace_roots: [other, dir],
    });

    const approved = pi(dir, "report", "--step", "build", "--result", "approved");
    assert.equal(approved.code, 0, approved.err);
  });

  test("guards the right project when only roots are given", () => {
    const other = mkdtempSync(join(tmpdir(), "pi-unrelated-"));
    projects.push(other);

    const dir = project();
    pi(dir, "start", "Guard me");

    const out = hook(dir, "guard", {
      hook_event_name: "preToolUse",
      workspace_roots: [other, dir],
      tool_name: "Write",
      tool_input: { file_path: "src/a.ts", contents: "x" },
    });

    assert.equal((JSON.parse(out) as Verdict).permission, "deny");
  });
});

// ── The control plane ───────────────────────────────────────────────────────

describe("pi's own commands stay reachable", () => {
  // The property that matters: whenever the guard refuses and names a command
  // to put things right, that command must itself be allowed. Otherwise the
  // refusal is unactionable and the run cannot be moved at all.
  test("the remedy a refusal names is never itself refused", () => {
    const dir = project("approval");
    pi(dir, "start", "Do not strand me");

    // 1. Before a step is handed out.
    const idle = shell(dir, "npm test");
    assert.equal(idle.permission, "deny");
    assert.match(idle.agent_message!, /pi next/);
    assert.equal(shell(dir, "pi next").permission, "allow");

    // 2. Parked at an approval gate.
    pi(dir, "next");
    pi(dir, "report", "--step", "build", "--result", "completed");

    const gated = shell(dir, "npm test");
    assert.equal(gated.permission, "deny");
    assert.match(gated.agent_message!, /pi next/);
    assert.equal(shell(dir, "pi next").permission, "allow");
    assert.equal(shell(dir, "pi report --step build --result approved").permission, "allow");
  });

  test("recognises pi run from a checkout as well as on the path", () => {
    const dir = project();
    pi(dir, "start", "Both spellings");

    assert.equal(shell(dir, "pi status").permission, "allow");
    assert.equal(shell(dir, "node cli/pi.ts status").permission, "allow");
    assert.equal(shell(dir, `node ${CLI} status`).permission, "allow");
  });

  test("reading a persona is still allowed, ejected or not", () => {
    const dir = project();
    pi(dir, "start", "Let me read the roster");

    assert.equal(shell(dir, "pi agents").permission, "allow");
    assert.equal(shell(dir, "pi agents qa-engineer").permission, "allow");
  });

  test("will not mint the human turn a gate is waiting for", () => {
    // The one verb a model must never reach. If it could run this, it could
    // manufacture the presence that makes a gate mean something and then
    // approve its own work.
    const dir = project();
    pi(dir, "start", "Not yours to grant");

    assert.equal(shell(dir, "pi human-turn").permission, "deny");
  });

  for (const command of [
    "pi uninstall",
    "pi uninstall --purge",
    "pi rewind --to build --yes",
    "pi abandon",
    "pi start \"something else\"",
    "pi install",
    // Reading a persona is a control verb; writing one is not. `--eject` would
    // otherwise be an unguarded way to rewrite the rules the run is judged by.
    "pi agents --eject qa-engineer",
    "pi agents --eject=qa-engineer --force",
  ]) {
    test(`does not hand over \`${command}\``, () => {
      // Each of these either removes the guard or discards the run, which would
      // make a refusal an inconvenience rather than a decision.
      const dir = project();
      pi(dir, "start", "Keep the guard on");

      assert.equal(shell(dir, command).permission, "deny", `${command} was allowed`);
    });
  }

  test("a pi command with anything chained onto it is not a pi command", () => {
    const dir = project();
    pi(dir, "start", "No smuggling");

    for (const command of [
      "pi status && rm -rf build",
      "pi status; npm publish",
      "pi status | tee /tmp/out",
      "pi status > overwrite.ts",
      "echo $(pi status)",
    ]) {
      assert.equal(shell(dir, command).permission, "deny", `${command} was allowed`);
    }
  });
});

// ── Abandoning ──────────────────────────────────────────────────────────────

describe("pi abandon", () => {
  test("stops the guard governing the session", () => {
    // Without this, a run nobody wants finished guards forever: its gates will
    // never open, and every refusal names a command that cannot help.
    const dir = project("approval");
    pi(dir, "start", "Change of plan");
    pi(dir, "next");
    pi(dir, "report", "--step", "build", "--result", "completed");

    assert.equal(shell(dir, "npm test").permission, "deny");

    const { code, out } = pi(dir, "abandon", "--reason", "Requirements changed");
    assert.equal(code, 0, out);
    assert.match(out, /Requirements changed/);

    assert.equal(shell(dir, "npm test").permission, "allow", "still guarded after abandoning");
  });

  test("keeps the history rather than tidying it away", () => {
    const dir = project();
    pi(dir, "start", "Worth reading later");
    pi(dir, "abandon");

    const listed = pi(dir, "runs");
    assert.equal(listed.code, 0);
    assert.match(listed.out, /abandoned/);
  });

  test("says so when there is no run to abandon", () => {
    const dir = project();

    const { code, err } = pi(dir, "abandon");
    assert.equal(code, 1);
    assert.match(err, /no active run/i);
  });
});

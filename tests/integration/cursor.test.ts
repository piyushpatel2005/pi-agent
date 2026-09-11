// The Cursor harness end to end.
//
// Drives the adapter exactly as Cursor does — real payloads on stdin, JSON on
// stdout — against a real run. If this passes, a refusal in the editor is a
// refusal for the same reason the unit tests say it should be.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "cli", "pi.ts");
const ADAPTER = join(ROOT, "harness", "cursor", "adapter.ts");

let project: string;

function pi(...argv: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: project, encoding: "utf-8" });
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
}

/** Call the adapter the way Cursor does: payload on stdin, JSON on stdout. */
function hook(target: string, payload: Record<string, unknown>): string {
  const result = spawnSync(process.execPath, [ADAPTER, target], {
    cwd: project,
    encoding: "utf-8",
    input: JSON.stringify({ cwd: project, ...payload }),
  });

  assert.equal(result.status, 0, `adapter exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

type Verdict = { permission: "allow" | "deny"; agent_message?: string };

function preToolUse(tool_name: string, tool_input: Record<string, unknown> = {}): Verdict {
  const out = hook("guard", { hook_event_name: "preToolUse", tool_name, tool_input });
  assert.notEqual(out.trim(), "", "preToolUse must always print JSON");
  return JSON.parse(out);
}

function postToolUse(tool_name: string, tool_input: Record<string, unknown> = {}): void {
  hook("record", { hook_event_name: "postToolUse", tool_name, tool_input });
}

/** Propose a write, and record it if it was allowed — the full hook pair. */
function edit(path: string, lines: number): Verdict {
  const input = { file_path: path, contents: Array.from({ length: lines }, () => "x").join("\n") };
  const verdict = preToolUse("Write", input);
  if (verdict.permission === "allow") postToolUse("Write", input);
  return verdict;
}

before(() => {
  project = mkdtempSync(join(tmpdir(), "pi-cursor-"));
  mkdirSync(join(project, "pi", "workflows"), { recursive: true });

  writeFileSync(
    join(project, "pi.config.json"),
    JSON.stringify({ version: 1, harness: "cursor", defaultWorkflow: "small", facts: {} }),
    "utf-8",
  );
  writeFileSync(
    join(project, "pi", "workflows", "small.workflow.json"),
    JSON.stringify({
      id: "small",
      name: "Small",
      version: 1,
      description: "One budgeted step.",
      defaults: { gate: "none", checkpoint: false },
      steps: [
        {
          id: "build",
          agent: "backend-developer",
          objective: "Build it.",
          produces: ["summary.md"],
          tools: ["read", "write-code", "write-artifact", "request-review"],
          changeBudget: { maxFiles: 3, maxLines: 50 },
        },
      ],
    }),
    "utf-8",
  );
});

after(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("pi install", () => {
  test("writes the hooks, skill, rule, and permission", () => {
    const { code, out } = pi("install");
    assert.equal(code, 0, out);

    for (const file of [
      ".cursor/hooks.json",
      ".cursor/cli.json",
      ".cursor/skills/pi/SKILL.md",
      ".cursor/rules/pi.mdc",
    ]) {
      assert.match(out, new RegExp(file.replace(/[.]/g, "\\.")));
    }
  });

  test("wires every event the guard needs", () => {
    const hooks = JSON.parse(readFileSync(join(project, ".cursor", "hooks.json"), "utf-8"));
    assert.deepEqual(Object.keys(hooks.hooks).sort(), [
      "beforeSubmitPrompt",
      "postToolUse",
      "preToolUse",
      "sessionStart",
      "stop",
    ]);
    assert.match(hooks.hooks.preToolUse[0].command, /adapter\.ts"? guard$/);
  });

  test("pre-approves running pi so the loop does not prompt", () => {
    const cli = JSON.parse(readFileSync(join(project, ".cursor", "cli.json"), "utf-8"));
    assert.ok(cli.permissions.allow.includes("Shell(pi)"));
  });

  test("doctor now reports the project as wired", () => {
    assert.match(pi("doctor").out, /wired into cursor/);
  });

  test("reinstalling does not duplicate or clobber", () => {
    // Something of the user's, in an event pi also uses.
    const path = join(project, ".cursor", "hooks.json");
    const hooks = JSON.parse(readFileSync(path, "utf-8"));
    hooks.hooks.preToolUse.unshift({ command: "echo theirs" });
    hooks.hooks.afterFileEdit = [{ command: "echo mine" }];
    writeFileSync(path, JSON.stringify(hooks, null, 2), "utf-8");

    const { code, out } = pi("install");
    assert.equal(code, 0);
    assert.match(out, /Kept 1 existing preToolUse hook/);

    const after = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(after.hooks.preToolUse.length, 2, "one theirs, one pi's — not three");
    assert.equal(after.hooks.preToolUse[0].command, "echo theirs");
    assert.deepEqual(after.hooks.afterFileEdit, [{ command: "echo mine" }]);
  });

  test("refuses a harness it does not have", () => {
    const { code, err } = pi("install", "--harness", "emacs");
    assert.equal(code, 1);
    assert.match(err, /No harness "emacs"/);
  });
});

describe("the adapter with no run", () => {
  test("allows everything and says nothing", () => {
    assert.equal(preToolUse("Write", { file_path: "a.ts", contents: "x" }).permission, "allow");
    assert.equal(hook("session-start", { hook_event_name: "sessionStart" }), "");
    assert.equal(hook("stop", { hook_event_name: "stop" }), "");
  });
});

describe("the adapter during a run", () => {
  test("session start tells a fresh session where things stand", () => {
    assert.equal(pi("start", "Add the orders service").code, 0);

    const context = JSON.parse(hook("session-start", { hook_event_name: "sessionStart" }));
    assert.match(context.additional_context, /Add the orders service/);
    assert.match(context.additional_context, /pi next/);
  });

  test("reads are allowed before a step is handed out; writes are not", () => {
    assert.equal(preToolUse("Read", { file_path: "a.ts" }).permission, "allow");
    assert.equal(preToolUse("Grep", { pattern: "x" }).permission, "allow");
    assert.equal(preToolUse("Write", { file_path: "a.ts", contents: "x" }).permission, "deny");
  });

  test("a prompt submission mints the human turn gates depend on", () => {
    hook("human-turn", { hook_event_name: "beforeSubmitPrompt" });

    const events = JSON.parse(pi("log", "--json").out) as { type: string; source?: string }[];
    const turn = events.find((event) => event.type === "human.turn");
    assert.equal(turn?.source, "cursor:beforeSubmitPrompt");
  });

  test("writes are allowed once the step is running", () => {
    assert.match(pi("next").out, /build/);
    assert.equal(edit("src/a.ts", 20).permission, "allow");
  });

  test("a tool the step does not grant is refused", () => {
    const verdict = preToolUse("Shell", { command: "npm test" });
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.agent_message!, /does not grant `run-command`/);
  });

  test("a tool pi knows nothing about passes through", () => {
    assert.equal(preToolUse("WebSearch", { query: "x" }).permission, "allow");
  });

  test("Task is mapped to delegate and refused", () => {
    assert.equal(preToolUse("Task", { prompt: "do it" }).permission, "deny");
  });

  test("postToolUse tallies what was actually written", () => {
    const state = JSON.parse(pi("status", "--json").out);
    assert.deepEqual(state.steps.build.changedFiles, ["src/a.ts"]);
    assert.equal(state.steps.build.changedLines, 20);
  });

  test("the budget bites through the real hook path", () => {
    assert.equal(edit("src/b.ts", 25).permission, "allow");

    const verdict = edit("src/c.ts", 20);
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.agent_message!, /65 lines against a limit of 50/);
    assert.match(verdict.agent_message!, /pi review request/);
  });

  test("writing a step's own artifact does not spend the code budget", () => {
    const state = JSON.parse(pi("status", "--json").out);
    const artifact = join(
      project,
      "pi",
      "runs",
      state.runId,
      "artifacts",
      "build",
      "summary.md",
    );

    const verdict = preToolUse("Write", { file_path: artifact, contents: "a\nb\nc" });
    assert.equal(verdict.permission, "allow", "over budget for code, but this is an artifact");
  });

  test("an open review freezes writing through the hook too", () => {
    pi("review", "request", "--summary", "Did the thing.", "--files", "src/a.ts", "--lines", "45");

    const verdict = preToolUse("Write", { file_path: "src/a.ts", contents: "x" });
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.agent_message!, /waiting on your review/);
  });

  test("stop nudges rather than blocking, since Cursor's stop cannot refuse", () => {
    const output = JSON.parse(hook("stop", { hook_event_name: "stop" }));
    assert.match(output.followup_message, /waiting on your review/);
    assert.ok(!("permission" in output), "stop has no decision channel");
  });

  test("the human turn from the hook is enough to resolve the review", () => {
    hook("human-turn", { hook_event_name: "beforeSubmitPrompt" });
    assert.equal(pi("review", "resolve", "--approve").code, 0);
    assert.equal(edit("src/d.ts", 30).permission, "allow");
  });
});

describe("payload translation", () => {
  // Its own project with a wide budget, so these measure what the adapter
  // counted rather than whether a shared tally happened to be near a limit.
  let outer: string;

  before(() => {
    outer = project;
    project = mkdtempSync(join(tmpdir(), "pi-payload-"));
    mkdirSync(join(project, "pi", "workflows"), { recursive: true });

    writeFileSync(
      join(project, "pi.config.json"),
      JSON.stringify({ version: 1, defaultWorkflow: "wide", facts: {} }),
      "utf-8",
    );
    writeFileSync(
      join(project, "pi", "workflows", "wide.workflow.json"),
      JSON.stringify({
        id: "wide",
        name: "Wide",
        version: 1,
        description: "Room to measure in.",
        defaults: { gate: "none", checkpoint: false },
        steps: [
          {
            id: "build",
            agent: "backend-developer",
            objective: "Build it.",
            produces: ["summary.md"],
            tools: ["read", "write-code"],
          },
        ],
      }),
      "utf-8",
    );

    pi("start", "Measure the translation");
    pi("next");
  });

  after(() => {
    rmSync(project, { recursive: true, force: true });
    project = outer;
  });

  function tally(): { changedFiles: string[]; changedLines: number } {
    const { changedFiles, changedLines } = JSON.parse(pi("status", "--json").out).steps.build;
    return { changedFiles, changedLines };
  }

  test("Write counts the lines of its contents", () => {
    postToolUse("Write", { file_path: "src/a.ts", contents: "a\nb\nc" });
    assert.deepEqual(tally(), { changedFiles: ["src/a.ts"], changedLines: 3 });
  });

  test("Edit counts the larger side, not the sum", () => {
    // 20 lines becoming 22 is a 22-line change, not a 42-line one. Inflating it
    // would spend budget the reviewer never sees the benefit of.
    postToolUse("Edit", {
      file_path: "src/b.ts",
      old_string: Array.from({ length: 20 }, () => "a").join("\n"),
      new_string: Array.from({ length: 22 }, () => "b").join("\n"),
    });
    assert.equal(tally().changedLines, 3 + 22);
  });

  test("MultiEdit sums across its edits and collects every file", () => {
    postToolUse("MultiEdit", {
      edits: [
        { file_path: "src/c.ts", new_string: "a\nb\nc" },
        { file_path: "src/d.ts", new_string: "a\nb" },
      ],
    });

    const after = tally();
    assert.deepEqual(after.changedFiles, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    assert.equal(after.changedLines, 3 + 22 + 5);
  });

  test("reads leave no tally", () => {
    postToolUse("Read", { file_path: "src/z.ts" });
    assert.deepEqual(tally().changedFiles, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  test("the same file edited twice is one file but both line counts", () => {
    postToolUse("Write", { file_path: "src/a.ts", contents: "a\nb" });

    const after = tally();
    assert.equal(after.changedFiles.length, 4, "still four distinct files");
    assert.equal(after.changedLines, 3 + 22 + 5 + 2);
  });

  test("malformed input allows rather than stranding the editor", () => {
    const result = spawnSync(process.execPath, [ADAPTER, "guard"], {
      cwd: project,
      encoding: "utf-8",
      input: "{ this is not json",
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { permission: "allow" });
  });

  test("an unknown target still answers when it is the guard", () => {
    const result = spawnSync(process.execPath, [ADAPTER, "guard"], {
      cwd: project,
      encoding: "utf-8",
      input: "",
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { permission: "allow" });
  });
});

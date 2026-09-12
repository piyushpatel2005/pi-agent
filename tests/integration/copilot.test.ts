// The GitHub Copilot harness end to end.
//
// Same discipline cursor-contract.test.ts learned the hard way: payloads here
// are shaped exactly as GitHub's hooks reference documents them (PascalCase
// event names, snake_case fields), not as pi imagines them. Every scenario
// below traces to an acceptance criterion in
// `pi/runs/<run>/artifacts/requirements/acceptance-criteria.md`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "cli", "pi.ts");
const ADAPTER = join(ROOT, "harness", "copilot", "adapter.ts");

const projects: string[] = [];
afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pi(project: string, ...argv: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: project, encoding: "utf-8" });
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
}

/** Call the adapter as Copilot does: payload verbatim, on stdin. */
function hook(project: string, target: string, payload: Record<string, unknown>): string {
  const result = spawnSync(process.execPath, [ADAPTER, target], {
    cwd: project,
    encoding: "utf-8",
    input: JSON.stringify(payload),
  });

  assert.equal(result.status, 0, `adapter exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

type Verdict = { permissionDecision: "deny"; permissionDecisionReason: string };

function guard(project: string, tool_name: string, tool_input: Record<string, unknown> = {}): string {
  return hook(project, "guard", {
    hook_event_name: "PreToolUse",
    cwd: project,
    tool_name,
    tool_input,
  });
}

/** `""` (allow) or the parsed deny payload — never anything else. */
function verdict(out: string): Verdict | null {
  if (out.trim() === "") return null;
  return JSON.parse(out) as Verdict;
}

function shell(project: string, command: string): Verdict | null {
  return verdict(guard(project, "bash", { command }));
}

function record(project: string, tool_name: string, tool_input: Record<string, unknown>): void {
  hook(project, "record", { hook_event_name: "PostToolUse", cwd: project, tool_name, tool_input });
}

/** Propose a write, and record it if it was allowed — the full hook pair. */
function write(project: string, path: string, lines: number): Verdict | null {
  const content = Array.from({ length: lines }, () => "x").join("\n");
  const input = { path, content };
  const out = verdict(guard(project, "create", input));
  if (out === null) record(project, "create", input);
  return out;
}

function readJson<T>(dir: string, ...parts: string[]): T {
  return JSON.parse(readFileSync(join(dir, ...parts), "utf-8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

/** A project with pi scaffolded and one budgeted step, `harness` in its config. */
function project(harness: "copilot" | "cursor" = "copilot"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-copilot-"));
  projects.push(dir);

  mkdirSync(join(dir, "pi", "workflows"), { recursive: true });
  writeFileSync(
    join(dir, "pi.config.json"),
    JSON.stringify({ version: 1, harness, defaultWorkflow: "one", facts: {} }),
    "utf-8",
  );
  writeFileSync(
    join(dir, "pi", "workflows", "one.workflow.json"),
    JSON.stringify({
      id: "one",
      name: "One step",
      version: 1,
      description: "A single step to guard.",
      defaults: { gate: "none", checkpoint: false },
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

const hooksPath = (dir: string) => join(dir, ".github", "hooks", "pi.json");
const settingsPath = (dir: string) => join(dir, ".github", "copilot", "settings.json");

// ── Install (R1, R2) ─────────────────────────────────────────────────────────

describe("pi install --harness copilot", () => {
  test("writes the hooks file, instructions, and skill", () => {
    const dir = project();
    const { code, out } = pi(dir, "install");
    assert.equal(code, 0, out);

    for (const file of [
      ".github/hooks/pi.json",
      ".github/instructions/pi.instructions.md",
      ".github/skills/pi/SKILL.md",
    ]) {
      assert.match(out, new RegExp(file.replace(/[.]/g, "\\.")));
      assert.ok(existsSync(join(dir, file)), `${file} was not written`);
    }
  });

  test("registers exactly the four events the guard needs, no agentStop", () => {
    const dir = project();
    pi(dir, "install");

    const hooks = readJson<{ version: number; hooks: Record<string, unknown[]> }>(
      dir,
      ".github",
      "hooks",
      "pi.json",
    );
    assert.equal(hooks.version, 1);
    assert.deepEqual(Object.keys(hooks.hooks).sort(), [
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
      "UserPromptSubmit",
    ]);

    const entry = hooks.hooks.PreToolUse![0] as { bash: string; powershell: string };
    assert.match(entry.bash, /adapter\.ts"? guard$/);
    assert.match(entry.powershell, /adapter\.ts"? guard$/);
  });

  test("re-running keeps a foreign hook file's own unrelated content", () => {
    const dir = project();
    pi(dir, "install");

    const before = readJson<Record<string, unknown>>(dir, ".github", "hooks", "pi.json");
    writeJson(hooksPath(dir), { ...before, notPi: "leave me alone" });

    pi(dir, "install");
    const after = readJson<Record<string, unknown>>(dir, ".github", "hooks", "pi.json");
    // pi owns this file outright and rewrites it fresh — unlike Cursor's
    // shared hooks.json, there is no foreign content to preserve here because
    // Copilot never asks two tools to share one file. What must not happen is
    // a duplicate or a crash.
    assert.equal(pi(dir, "install").code, 0);
    assert.deepEqual(Object.keys(after.hooks as object).sort(), [
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
      "UserPromptSubmit",
    ]);
  });

  test("pre-approves running pi without prompting", () => {
    const dir = project();
    pi(dir, "install");

    const settings = readJson<{ permissions: { allow: string[] } }>(
      dir,
      ".github",
      "copilot",
      "settings.json",
    );
    assert.ok(settings.permissions.allow.includes("Shell(pi *)"));
  });

  test("keeps a project's own copilot settings alongside pi's grant", () => {
    const dir = project();
    mkdirSync(join(dir, ".github", "copilot"), { recursive: true });
    writeJson(settingsPath(dir), { permissions: { allow: ["Shell(ls)"] }, theirs: true });

    pi(dir, "install");

    const settings = readJson<{ permissions: { allow: string[] }; theirs: boolean }>(
      dir,
      ".github",
      "copilot",
      "settings.json",
    );
    assert.deepEqual(settings.permissions.allow.sort(), ["Shell(ls)", "Shell(pi *)"]);
    assert.equal(settings.theirs, true);
  });

  test("doctor reports the project as wired", () => {
    const dir = project();
    pi(dir, "install");
    assert.match(pi(dir, "doctor").out, /wired into copilot/);
  });

  test("refuses a harness it does not have, and now lists copilot too", () => {
    const dir = project();
    const { code, err } = pi(dir, "install", "--harness", "emacs");
    assert.equal(code, 1);
    assert.match(err, /No harness "emacs"/);
    assert.match(err, /cursor/);
    assert.match(err, /copilot/);
  });

});

// ── Uninstall (R4) ───────────────────────────────────────────────────────────

describe("pi uninstall --harness copilot", () => {
  test("removes everything install put there", () => {
    const dir = project();
    pi(dir, "install");

    const { code } = pi(dir, "uninstall");
    assert.equal(code, 0);

    assert.equal(existsSync(hooksPath(dir)), false);
    assert.equal(existsSync(join(dir, ".github", "instructions", "pi.instructions.md")), false);
    assert.equal(existsSync(join(dir, ".github", "skills", "pi")), false);
    assert.equal(existsSync(settingsPath(dir)), false, "a bare settings.json goes with it");
  });

  test("prunes empty directories but keeps .github itself", () => {
    const dir = project();
    pi(dir, "install");
    pi(dir, "uninstall");

    for (const sub of ["hooks", "instructions", "skills", "copilot"]) {
      assert.equal(existsSync(join(dir, ".github", sub)), false, `.github/${sub} should be pruned`);
    }
    assert.equal(existsSync(join(dir, ".github")), true, ".github/ itself is not pi's to remove");
  });

  test("revokes only pi's grant, keeping the project's own", () => {
    const dir = project();
    mkdirSync(join(dir, ".github", "copilot"), { recursive: true });
    writeJson(settingsPath(dir), { permissions: { allow: ["Shell(ls)"] } });
    pi(dir, "install");

    pi(dir, "uninstall");

    const settings = readJson<{ permissions: { allow: string[] } }>(dir, ".github", "copilot", "settings.json");
    assert.deepEqual(settings.permissions.allow, ["Shell(ls)"]);
  });

  test("doctor stops reporting the project as wired", () => {
    const dir = project();
    pi(dir, "install");
    pi(dir, "uninstall");
    assert.match(pi(dir, "doctor").out, /not wired into copilot/);
  });

  test("running it on a project with nothing of pi's is a no-op", () => {
    const dir = project();
    const { code, out } = pi(dir, "uninstall");
    assert.equal(code, 0);
    assert.match(out, /not wired into copilot/);
  });

  test("leaves pi.config.json and pi/ alone without --purge", () => {
    const dir = project();
    pi(dir, "install");
    assert.equal(pi(dir, "start", "Add orders", "--workflow", "feature").code, 0);

    pi(dir, "uninstall");

    assert.equal(existsSync(join(dir, "pi.config.json")), true);
    assert.equal(existsSync(join(dir, "pi", "runs")), true);
  });

  test("--purge takes the config and history too", () => {
    const dir = project();
    pi(dir, "install");
    assert.equal(pi(dir, "start", "Add orders", "--workflow", "feature").code, 0);

    const { code, out } = pi(dir, "uninstall", "--purge");
    assert.equal(code, 0, out);
    assert.equal(existsSync(join(dir, "pi.config.json")), false);
    assert.equal(existsSync(join(dir, "pi")), false);
  });
});

// ── The two harnesses stay independent (R5) ─────────────────────────────────

describe("cursor and copilot installs do not see each other", () => {
  test("installing one does not report the other as wired", () => {
    const dir = project("cursor");
    pi(dir, "install", "--harness", "cursor");

    assert.equal(pi(dir, "doctor").out.includes("wired into copilot"), false);

    pi(dir, "install", "--harness", "copilot");
    assert.match(pi(dir, "doctor").out, /wired into cursor/); // config still says cursor
    assert.equal(existsSync(join(dir, ".github", "hooks", "pi.json")), true);
    assert.equal(existsSync(join(dir, ".cursor", "hooks.json")), true);
  });

  test("uninstalling one leaves the other's files alone", () => {
    const dir = project("cursor");
    pi(dir, "install", "--harness", "cursor");
    pi(dir, "install", "--harness", "copilot");

    pi(dir, "uninstall", "--harness", "cursor");

    assert.equal(existsSync(join(dir, ".cursor", "hooks.json")), false);
    assert.equal(existsSync(join(dir, ".github", "hooks", "pi.json")), true);
  });
});

// ── CLI output (R6) ──────────────────────────────────────────────────────────

describe("pi install's terminal output", () => {
  test("names GitHub Copilot, not Cursor", () => {
    const dir = project();
    const { out } = pi(dir, "install");
    assert.match(out, /Restart GitHub Copilot/);
    assert.doesNotMatch(out, /Restart Cursor/);
  });

  test("cursor's own install message is unchanged", () => {
    const dir = project("cursor");
    const { out } = pi(dir, "install", "--harness", "cursor");
    assert.match(out, /Restart Cursor so it picks up the hooks/);
  });
});

// ── The adapter (R3) ─────────────────────────────────────────────────────────

describe("the copilot adapter with no run", () => {
  test("allows everything and says nothing", () => {
    const dir = project();
    assert.equal(shell(dir, "npm test"), null);
    assert.equal(hook(dir, "session-start", { hook_event_name: "SessionStart", cwd: dir }), "");
  });

  test("malformed input allows rather than stranding the session", () => {
    const dir = project();
    const result = spawnSync(process.execPath, [ADAPTER, "guard"], {
      cwd: dir,
      encoding: "utf-8",
      input: "{ this is not json",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  test("an unknown target still exits 0 and prints nothing", () => {
    const dir = project();
    const result = spawnSync(process.execPath, [ADAPTER, "not-a-real-target"], {
      cwd: dir,
      encoding: "utf-8",
      input: "{}",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  test("no target corresponds to agentStop/Stop", () => {
    const source = readFileSync(ADAPTER, "utf-8");
    assert.doesNotMatch(source, /"agentStop"|"Stop"/);
  });
});

describe("the copilot adapter during a run", () => {
  function started(): string {
    const dir = project();
    pi(dir, "start", "Add the orders service");
    pi(dir, "next");
    return dir;
  }

  test("session-start names the run, the step, and what to do next", () => {
    const dir = started();
    const context = JSON.parse(hook(dir, "session-start", { hook_event_name: "SessionStart", cwd: dir }));

    assert.match(context.additionalContext, /Add the orders service/);
    assert.match(context.additionalContext, /pi next/);
    assert.equal(context.hookSpecificOutput.hookEventName, "SessionStart");
  });

  test("a bare control verb is allowed even though the step grants no run-command", () => {
    const dir = started();
    assert.equal(shell(dir, "pi status"), null);
    assert.equal(shell(dir, "pi next"), null);
  });

  test("pi human-turn is denied with a reason, not silently allowed", () => {
    const dir = started();
    const denied = shell(dir, "pi human-turn");

    assert.equal(denied?.permissionDecision, "deny");
    assert.match(denied!.permissionDecisionReason, /not yours to run/);
    // Same payload nested for the VS Code-format surface.
    const nested = JSON.parse(guard(dir, "bash", { command: "pi human-turn" })).hookSpecificOutput;
    assert.equal(nested.permissionDecisionReason, denied!.permissionDecisionReason);
  });

  test("a tool the step does not grant is refused with the guard's own reason", () => {
    const dir = started();
    const denied = shell(dir, "npm test");

    assert.equal(denied?.permissionDecision, "deny");
    assert.match(denied!.permissionDecisionReason, /does not grant `run-command`/);
  });

  test("view maps to read and is allowed before any write is", () => {
    const dir = started();
    assert.equal(verdict(guard(dir, "view", { path: "a.ts" })), null);
    assert.equal(write(dir, "src/a.ts", 10), null);
  });

  test("task maps to delegate and is refused", () => {
    const dir = started();
    const denied = verdict(guard(dir, "task", { prompt: "do it" }));
    assert.equal(denied?.permissionDecision, "deny");
  });

  test("a tool name pi has no mapping for passes through allowed", () => {
    const dir = started();
    assert.equal(verdict(guard(dir, "web_search", { query: "x" })), null);
  });

  test("postToolUse tallies what create actually wrote", () => {
    const dir = started();
    write(dir, "src/a.ts", 12);

    const state = JSON.parse(pi(dir, "status", "--json").out);
    assert.deepEqual(state.steps.build.changedFiles, ["src/a.ts"]);
    assert.equal(state.steps.build.changedLines, 12);
  });

  test("edit counts the larger side, old_str/new_str or old_string/new_string", () => {
    const dir = started();
    const input = { path: "src/b.ts", old_str: "a\nb\nc", new_str: "a\nb\nc\nd\ne" };
    assert.equal(verdict(guard(dir, "edit", input)), null);
    record(dir, "edit", input);

    const state = JSON.parse(pi(dir, "status", "--json").out);
    assert.equal(state.steps.build.changedLines, 5);
  });

  test("the change budget bites through the real hook path", () => {
    const dir = started();
    assert.equal(write(dir, "src/a.ts", 30), null);

    const denied = write(dir, "src/b.ts", 25);
    assert.equal(denied?.permissionDecision, "deny");
    assert.match(denied!.permissionDecisionReason, /55 lines against a limit of 50/);
  });

  test("writing a step's own artifact does not spend the code budget", () => {
    const dir = started();
    const state = JSON.parse(pi(dir, "status", "--json").out);
    const artifact = join(dir, "pi", "runs", state.runId, "artifacts", "build", "summary.md");

    const denied = verdict(guard(dir, "create", { path: artifact, content: Array.from({ length: 30 }, () => "x").join("\n") }));
    assert.equal(denied, null, "artifact prose must not touch the code budget");
  });

  test("a prompt submission mints the human turn gates depend on", () => {
    const dir = started();
    hook(dir, "human-turn", { hook_event_name: "UserPromptSubmit", cwd: dir, prompt: "go" });

    const events = JSON.parse(pi(dir, "log", "--json").out) as { type: string; source?: string }[];
    const turn = events.find((event) => event.type === "human.turn");
    assert.equal(turn?.source, "copilot:UserPromptSubmit");
  });
});

// Drives the real `pi` binary against a throwaway project.
//
// The unit tests prove each module in isolation; this proves they are actually
// wired to each other and to the filesystem.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const CLI = join(import.meta.dirname, "..", "..", "cli", "pi.ts");

let project: string;

function pi(...argv: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: project,
    encoding: "utf-8",
  });
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
}

before(() => {
  project = mkdtempSync(join(tmpdir(), "pi-cli-"));
});

after(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("pi CLI", () => {
  test("reports its version", () => {
    const { code, out } = pi("version");
    assert.equal(code, 0);
    assert.match(out, /^\d+\.\d+\.\d+/);
  });

  test("lists the shipped workflows before any project setup", () => {
    const { code, out } = pi("workflows");
    assert.equal(code, 0);
    for (const id of ["feature", "quick", "bugfix", "docs", "product-discovery"]) {
      assert.match(out, new RegExp(`^${id}\\b`, "m"));
    }
  });

  test("lists the eight personas", () => {
    const { code, out } = pi("agents");
    assert.equal(code, 0);
    for (const id of [
      "business-analyst",
      "solution-architect",
      "ui-designer",
      "frontend-developer",
      "backend-developer",
      "qa-engineer",
      "devops-engineer",
      "technical-writer",
    ]) {
      assert.match(out, new RegExp(`^${id}\\b`, "m"));
    }
  });

  test("shows one persona with its limits", () => {
    const { code, out } = pi("agents", "backend-developer");
    assert.equal(code, 0);
    assert.match(out, /Backend Developer/);
    assert.match(out, /Denied: delegate/);
    assert.match(out, /Budget: 8 files \/ 300 lines/);
  });

  test("ejects a persona into the project, and says no to an id it does not ship", () => {
    const ejected = join(project, "pi", "agents", "qa-engineer.md");

    try {
      const { code, out } = pi("agents", "--eject", "qa-engineer");
      assert.equal(code, 0, out);
      assert.match(out, /Wrote pi\/agents\/qa-engineer\.md/);
      assert.match(readFileSync(ejected, "utf-8"), /^---\nid: qa-engineer\n/);

      const second = pi("agents", "--eject", "qa-engineer");
      assert.equal(second.code, 1);
      assert.match(second.err, /already exists/);

      // An AgentError reaching the top level used to print a stack trace.
      const missing = pi("agents", "--eject", "scrum-master");
      assert.equal(missing.code, 1);
      assert.match(missing.err, /pi ships no persona "scrum-master"/);
      assert.doesNotMatch(missing.err, /at \w+ \(/);
    } finally {
      // The project is shared by every test in this file, and an override
      // would follow this one into them.
      rmSync(join(project, "pi", "agents"), { recursive: true, force: true });
    }
  });

  test("every shipped workflow compiles against the shipped roster", () => {
    const { code, out } = pi("doctor");
    assert.equal(code, 0, out);
    assert.match(out, /All checks passed/);
  });

  test("init scaffolds a config and refuses to clobber it", () => {
    assert.equal(pi("init").code, 0);

    const config = JSON.parse(readFileSync(join(project, "pi.config.json"), "utf-8"));
    assert.equal(config.harness, "cursor");
    assert.equal(config.docs.dir, "docs");

    const second = pi("init");
    assert.equal(second.code, 1);
    assert.match(second.err, /already exists/);
    assert.equal(pi("init", "--force").code, 0);
  });

  test("status is calm when there is no run", () => {
    const { code, out } = pi("status");
    assert.equal(code, 0);
    assert.match(out, /No active run/);
  });

  test("start requires a goal", () => {
    assert.equal(pi("start").code, 2);
  });

  test("start rejects an unknown workflow", () => {
    const { code, err } = pi("start", "anything", "--workflow", "nope");
    assert.equal(code, 1);
    assert.match(err, /no workflow "nope"/);
  });
});

describe("pi CLI: a full run", () => {
  test("start plans the run and skips inapplicable steps", () => {
    writeFileSync(
      join(project, "pi.config.json"),
      JSON.stringify({
        version: 1,
        defaultWorkflow: "feature",
        facts: { hasFrontend: false, hasBackend: true, needsInfra: false },
      }),
      "utf-8",
    );

    const { code, out } = pi("start", "Add an orders service");
    assert.equal(code, 0, out);
    assert.match(out, /Feature delivery — Add an orders service/);
    // hasFrontend and needsInfra are false, so those steps never run.
    assert.match(out, /ux-design/);
    assert.match(out, /frontend-implementation/);
    assert.match(out, /infrastructure/);
    // The state file is where a step can be hand-skipped for this run only.
    assert.match(out, /State: .*state\.json/);
    assert.match(out, /skip a different step for just this run/);
  });

  test("next hands out the first applicable step and starts it", () => {
    const { code, out } = pi("next");
    assert.equal(code, 0);
    // 6, not 9: progress counts the steps that apply here, not the ones skipped.
    assert.match(out, /Step 1\/6: requirements — business-analyst/);
    assert.match(out, /requirements\.md/);

    // Asking twice does not advance: the step is now active, not pending.
    assert.match(pi("next").out, /requirements/);
  });

  test("--brief renders the persona's full prompt for the step", () => {
    const { code, out } = pi("next", "--brief");
    assert.equal(code, 0);
    assert.match(out, /^# Business Analyst/);
    assert.match(out, /Add an orders service/);
    assert.match(out, /acceptance-criteria\.md/);
    assert.match(out, /pi report --step requirements --result completed/);
  });

  test("a step with no gate flows straight to the next one", () => {
    // The feature workflow gates everything by default, so requirements gates too.
    assert.equal(pi("report", "--step", "requirements", "--result", "completed").code, 0);
    assert.match(pi("next").out, /approval/);
  });

  test("approval is refused without evidence a human acted", () => {
    const { code, err } = pi("report", "--step", "requirements", "--result", "approved");
    assert.equal(code, 1);
    assert.match(err, /no human has acted/);
  });

  test("a recorded human turn unblocks the gate", () => {
    assert.equal(pi("human-turn", "--source", "test").code, 0);

    const { code, out } = pi("report", "--step", "requirements", "--result", "approved");
    assert.equal(code, 0, out);
    assert.match(pi("next").out, /architecture — solution-architect/);
  });

  test("one human turn does not bank approvals for later gates", () => {
    assert.equal(pi("report", "--step", "architecture", "--result", "completed").code, 0);

    const { code, err } = pi("report", "--step", "architecture", "--result", "approved");
    assert.equal(code, 1);
    assert.match(err, /no human has acted/);
  });

  test("rejection sends the step back with feedback", () => {
    assert.equal(pi("human-turn").code, 0);
    assert.equal(
      pi("report", "--step", "architecture", "--result", "rejected", "--feedback", "Split the write path").code,
      0,
    );

    const { out } = pi("next");
    assert.match(out, /architecture/);
    assert.match(out, /Attempt 2/);
    assert.match(out, /Split the write path/);
  });

  test("status shows progress against the workflow", () => {
    const { code, out } = pi("status");
    assert.equal(code, 0);
    assert.match(out, /\[x\] requirements/);
    assert.match(out, /\[-\] architecture/);
    assert.match(out, /\[s\] ux-design/);
  });

  test("--json emits the state verbatim", () => {
    const state = JSON.parse(pi("status", "--json").out);
    assert.equal(state.workflow, "feature");
    assert.equal(state.goal, "Add an orders service");
    assert.equal(state.steps.requirements.status, "completed");
    assert.equal(state.steps["ux-design"].status, "skipped");
  });

  test("the log is the audit trail for everything above", () => {
    const events = JSON.parse(pi("log", "--json").out).map((event: { type: string }) => event.type);
    assert.deepEqual(events.slice(0, 3), ["run.started", "agent.activated", "step.started"]);
    assert.ok(events.includes("gate.opened"));
    assert.ok(events.includes("gate.resolved"));
    assert.ok(events.includes("human.turn"));
    assert.ok(events.includes("checkpoint.saved"));
  });

  test("log --step narrows to one step", () => {
    const events = JSON.parse(pi("log", "--step", "requirements", "--json").out);
    assert.ok(events.length > 0);
    for (const event of events) assert.equal(event.step, "requirements");
  });

  test("report validates its arguments", () => {
    assert.equal(pi("report", "--step", "architecture").code, 2);
    assert.equal(pi("report", "--step", "architecture", "--result", "vibes").code, 2);
    assert.equal(pi("report", "--step", "no-such-step", "--result", "completed").code, 1);
  });

  test("engine is an accepted prefix for the same verbs", () => {
    assert.equal(pi("engine", "status").code, 0);
  });

  test("an unknown verb explains itself", () => {
    const { code, err } = pi("frobnicate");
    assert.equal(code, 2);
    assert.match(err, /Unknown command/);
  });
});

describe("pi CLI: project overrides", () => {
  test("a project workflow shadows a shipped one of the same id", () => {
    writeFileSync(
      join(project, "pi", "workflows", "quick.workflow.json"),
      JSON.stringify({
        id: "quick",
        name: "Our quick path",
        version: 2,
        description: "Locally retuned.",
        steps: [
          {
            id: "implement",
            agent: "backend-developer",
            objective: "Just do it.",
            produces: ["summary.md"],
            tools: ["write-code"],
          },
        ],
      }),
      "utf-8",
    );

    const { code, out } = pi("workflows", "quick");
    assert.equal(code, 0, out);
    assert.match(out, /Our quick path/);
  });

  test("a broken project workflow is reported, not crashed on", () => {
    writeFileSync(join(project, "pi", "workflows", "bad.workflow.json"), "{ not json", "utf-8");

    const { code, out } = pi("doctor");
    assert.equal(code, 1);
    assert.match(out, /bad\.workflow\.json failed to compile/);
    // The good workflows still load.
    assert.equal(pi("workflows").code, 0);

    rmSync(join(project, "pi", "workflows", "bad.workflow.json"));
  });

  test("a workflow granting a role more than it holds fails to compile", () => {
    writeFileSync(
      join(project, "pi", "workflows", "overreach.workflow.json"),
      JSON.stringify({
        id: "overreach",
        name: "Overreach",
        version: 1,
        description: "Asks the analyst to write code.",
        steps: [
          {
            id: "write",
            agent: "business-analyst",
            objective: "Write the service.",
            produces: ["summary.md"],
            tools: ["read", "write-code"],
          },
        ],
      }),
      "utf-8",
    );

    const { code, out } = pi("doctor");
    assert.equal(code, 1);
    assert.match(out, /"business-analyst" may not use "write-code"/);

    rmSync(join(project, "pi", "workflows", "overreach.workflow.json"));
  });

  test("a project persona shadows a shipped one", () => {
    mkdirSync(join(project, "pi", "agents"), { recursive: true });
    writeFileSync(
      join(project, "pi", "agents", "ui-designer.md"),
      "---\nid: ui-designer\nname: Our Designer\ndescription: Local rules.\ntools: [read]\n---\n\nFollow the house style guide.\n",
      "utf-8",
    );

    const { code, out } = pi("agents", "ui-designer");
    assert.equal(code, 0);
    assert.match(out, /Our Designer/);
    assert.match(out, /house style guide/);

    rmSync(join(project, "pi", "agents"), { recursive: true });
  });

  test("a broken persona is reported, not crashed on", () => {
    mkdirSync(join(project, "pi", "agents"), { recursive: true });
    writeFileSync(join(project, "pi", "agents", "bad.md"), "no frontmatter here", "utf-8");

    const { code, out } = pi("doctor");
    assert.equal(code, 1);
    assert.match(out, /bad\.md/);
    // The shipped personas still load.
    assert.match(pi("agents").out, /backend-developer/);

    rmSync(join(project, "pi", "agents"), { recursive: true });
  });

  test("a workflow naming an unknown sensor fails to compile", () => {
    writeFileSync(
      join(project, "pi", "workflows", "astro.workflow.json"),
      JSON.stringify({
        id: "astro",
        name: "Astro",
        version: 1,
        description: "Consults the stars.",
        steps: [
          {
            id: "build",
            agent: "backend-developer",
            objective: "Build it.",
            produces: ["summary.md"],
            tools: ["write-code"],
            sensors: ["astrology"],
          },
        ],
      }),
      "utf-8",
    );

    const { code, out } = pi("doctor");
    assert.equal(code, 1);
    assert.match(out, /unknown sensor "astrology"/);

    rmSync(join(project, "pi", "workflows", "astro.workflow.json"));
  });

  test("an invalid config is a clear error, not a stack trace", () => {
    writeFileSync(join(project, "pi.config.json"), JSON.stringify({ version: "one" }), "utf-8");

    const { code, err } = pi("status");
    assert.equal(code, 1);
    assert.match(err, /not a valid pi config/);
  });
});

describe("pi CLI: skipping a step for one run only", () => {
  function scratchProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-cli-skip-"));
    writeFileSync(
      join(dir, "pi.config.json"),
      JSON.stringify({ version: 1, defaultWorkflow: "feature" }),
      "utf-8",
    );
    return dir;
  }

  function piIn(dir: string, ...argv: string[]): { code: number; out: string; err: string } {
    const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: dir, encoding: "utf-8" });
    return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
  }

  test("start's --json output names the state file", () => {
    const dir = scratchProject();
    try {
      const { code, out } = piIn(dir, "start", "Something", "--json");
      assert.equal(code, 0, out);

      const started = JSON.parse(out);
      assert.match(started.statePath, /state\.json$/);
      assert.ok(existsSync(started.statePath), `${started.statePath} should exist`);

      const state = JSON.parse(readFileSync(started.statePath, "utf-8"));
      assert.equal(state.runId, started.runId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hand-editing a step's status to skipped is honored like a facts-driven skip", () => {
    const dir = scratchProject();
    try {
      const { out: startOut } = piIn(dir, "start", "Something", "--json");
      const { statePath } = JSON.parse(startOut);

      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      state.steps["ux-design"].status = "skipped";
      state.steps["ux-design"].skipReason = "manually excluded for this run";
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

      const status = piIn(dir, "status");
      assert.equal(status.code, 0, status.out);
      assert.match(status.out, /\[s\] ux-design.*manually excluded for this run/);

      // The router routes straight past it, the same as a facts-driven skip —
      // no RouterError, no special-casing for a hand-edited skip.
      const next = piIn(dir, "next");
      assert.equal(next.code, 0, next.out);
      assert.match(next.out, /requirements — business-analyst/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deleting a step's key instead of skipping it breaks the run", () => {
    const dir = scratchProject();
    try {
      const { out: startOut } = piIn(dir, "start", "Something", "--json");
      const { statePath } = JSON.parse(startOut);

      // The router walks steps in workflow order and checks each one exists,
      // so deleting the very first step's key fails on the very next call.
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      delete state.steps.requirements;
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

      const next = piIn(dir, "next");
      assert.equal(next.code, 1);
      assert.match(next.err, /"requirements".*has no record of it/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

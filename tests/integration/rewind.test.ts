// Checkpoints and rewinding, driven through the real CLI.
//
// The unit tests prove the planning logic. This proves the pieces the planner
// cannot see: that snapshots actually reach disk as steps complete, that a
// rewind survives a round trip through the state store's invariants, and that
// the event log keeps the rewind rather than forgetting it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function state(): {
  currentStep: string | null;
  steps: Record<string, { status: string; artifacts: string[] }>;
  checkpoints: { step: string }[];
} {
  const { out } = pi("status", "--json");
  return JSON.parse(out);
}

/** A workflow with no gates, so a run can be driven forward without a human. */
const WORKFLOW = {
  id: "linear",
  name: "Linear",
  version: 1,
  defaults: { gate: "none", checkpoint: true },
  steps: [
    {
      id: "requirements",
      agent: "business-analyst",
      objective: "Write down what to build.",
      produces: ["requirements.md"],
      tools: ["read", "write-artifact"],
    },
    {
      id: "design",
      agent: "solution-architect",
      objective: "Design it.",
      consumes: ["requirements.md"],
      produces: ["design.md"],
      tools: ["read", "write-artifact"],
    },
    {
      id: "build",
      agent: "backend-developer",
      objective: "Build it.",
      consumes: ["design.md"],
      produces: ["build.md"],
      tools: ["read", "write-artifact"],
    },
  ],
};

before(() => {
  project = mkdtempSync(join(tmpdir(), "pi-rewind-"));
  assert.equal(pi("init").code, 0);
  writeFileSync(
    join(project, "pi", "workflows", "linear.workflow.json"),
    JSON.stringify(WORKFLOW, null, 2),
    "utf-8",
  );

  assert.equal(pi("start", "Add an orders service", "--workflow", "linear").code, 0);
  for (const step of ["requirements", "design", "build"]) {
    const result = pi("report", "--step", step, "--result", "completed", "--artifacts", `${step}.md`);
    assert.equal(result.code, 0, result.err);
  }
});

after(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("pi checkpoints", () => {
  test("a checkpoint is recorded for every completed step", () => {
    const { code, out } = pi("checkpoints");
    assert.equal(code, 0);
    for (const step of ["requirements", "design", "build"]) {
      assert.match(out, new RegExp(`^  ${step}$`, "m"));
    }
    assert.doesNotMatch(out, /snapshot missing/);
  });

  test("doctor agrees the snapshots are all present", () => {
    const { out } = pi("doctor");
    assert.match(out, /ok\s+checkpoints match their snapshots/);
  });
});

describe("pi rewind", () => {
  test("without --yes it explains the damage and changes nothing", () => {
    const before = state();

    const { code, out } = pi("rewind", "--to", "design");
    assert.equal(code, 0);
    assert.match(out, /restoring the checkpoint taken after "requirements"/);
    assert.match(out, /undoes\s+design, build/);
    assert.match(out, /Nothing changed/);
    assert.match(out, /Your files are not touched/);

    assert.deepEqual(state(), before);
  });

  test("naming a step that does not exist fails loudly", () => {
    const { code, err } = pi("rewind", "--to", "nope", "--yes");
    assert.equal(code, 1);
    assert.match(err, /No step "nope"/);
  });

  test("with --yes the run moves back and later work is undone", () => {
    const { code, out } = pi("rewind", "--to", "design", "--yes");
    assert.equal(code, 0);
    assert.match(out, /Next step: design/);

    const after = state();
    assert.equal(after.currentStep, "design");
    assert.equal(after.steps.requirements?.status, "completed");
    assert.equal(after.steps.design?.status, "pending");
    assert.equal(after.steps.build?.status, "pending");
    assert.deepEqual(after.steps.build?.artifacts, []);

    // The checkpoint index rewinds with the state: "build" happened after the
    // point we restored, so it is no longer a boundary this run knows about.
    assert.deepEqual(after.checkpoints.map((checkpoint) => checkpoint.step), ["requirements"]);
  });

  test("doctor stays clean afterwards: undone snapshots go with the index", () => {
    const { out } = pi("doctor");
    assert.match(out, /ok\s+checkpoints match their snapshots/);
    assert.doesNotMatch(out, /not in the index/);
  });

  test("the event log keeps the rewind instead of forgetting it", () => {
    const events: { type: string; message?: string }[] = JSON.parse(pi("log", "--json").out);

    // Everything that happened is still there, including the work we undid.
    const completed = events.filter((event) => event.type === "step.completed");
    assert.equal(completed.length, 3);

    const rewind = events.findLast((event) => event.type === "log.emitted");
    assert.match(rewind!.message!, /Rewound to "design"/);
    assert.match(rewind!.message!, /undoing 2 step\(s\): design, build/);
  });

  test("the run carries on from the restored point", () => {
    const { code, out } = pi("next");
    assert.equal(code, 0);
    assert.match(out, /design/);

    assert.equal(pi("report", "--step", "design", "--result", "completed").code, 0);
    assert.equal(state().currentStep, "build");
  });
});

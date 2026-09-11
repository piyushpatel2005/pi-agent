import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CheckpointError,
  auditSnapshots,
  loadSnapshot,
  planRewind,
  saveSnapshot,
} from "../../core/engine/checkpoints.ts";
import { compileWorkflow } from "../../core/engine/compile.ts";
import { checkpointPath, runPaths } from "../../core/engine/paths.ts";
import { StepResult, applyReport, boundaryDigest, planSteps } from "../../core/engine/router.ts";
import { RunState, RunStatus, STATE_VERSION, StepStatus } from "../../core/schemas/state.ts";
import { GatePolicy, type CompiledWorkflow } from "../../core/schemas/workflow.ts";

const RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempPaths() {
  const root = mkdtempSync(join(tmpdir(), "pi-checkpoint-"));
  roots.push(root);
  return runPaths(root, RUN_ID);
}

function workflow(): CompiledWorkflow {
  const result = compileWorkflow({
    id: "feature",
    name: "Feature",
    version: 1,
    steps: [
      {
        id: "requirements",
        agent: "business-analyst",
        objective: "Capture requirements",
        produces: ["requirements.md"],
        tools: ["read"],
        gate: GatePolicy.None,
      },
      {
        id: "design",
        agent: "solution-architect",
        objective: "Design it",
        produces: ["design.md"],
        tools: ["read"],
        gate: GatePolicy.None,
      },
      {
        id: "build",
        agent: "backend-developer",
        objective: "Build it",
        produces: ["build.md"],
        tools: ["read", "write-code"],
        gate: GatePolicy.None,
      },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.workflow;
}

function freshState(wf: CompiledWorkflow): RunState {
  return RunState.parse({
    version: STATE_VERSION,
    runId: RUN_ID,
    goal: "Add an orders service",
    workflow: wf.id,
    workflowDigest: wf.digest,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    status: RunStatus.Active,
    currentStep: "requirements",
    steps: planSteps(wf, {}),
  });
}

/** Run steps to completion, saving snapshots the way the CLI does. */
function advance(state: RunState, wf: CompiledWorkflow, paths: ReturnType<typeof runPaths>, steps: string[]) {
  for (const step of steps) {
    applyReport(state, wf, {
      step,
      result: StepResult.Completed,
      artifacts: [`${step}.md`],
      gitHead: `head-${step}`,
    });
    saveSnapshot(paths, structuredClone(state), step);
  }
}

describe("snapshots", () => {
  test("a saved snapshot round-trips through disk", () => {
    const paths = tempPaths();
    const wf = workflow();
    const state = freshState(wf);
    advance(state, wf, paths, ["requirements"]);

    const loaded = loadSnapshot(paths, "requirements");
    assert.equal(loaded.runId, RUN_ID);
    assert.equal(loaded.steps.requirements?.status, StepStatus.Completed);
  });

  test("a missing snapshot is named, not swallowed", () => {
    const paths = tempPaths();
    assert.throws(
      () => loadSnapshot(paths, "design"),
      (error: CheckpointError) => error.code === "missing-snapshot",
    );
  });

  test("a corrupt snapshot is refused rather than half-restored", () => {
    const paths = tempPaths();
    mkdirSync(paths.checkpoints, { recursive: true });
    writeFileSync(checkpointPath(paths, "design"), "{ not json", "utf-8");

    assert.throws(
      () => loadSnapshot(paths, "design"),
      (error: CheckpointError) => error.code === "unreadable-snapshot",
    );
  });

  test("doctor notices an index entry whose file went missing", () => {
    const paths = tempPaths();
    const wf = workflow();
    const state = freshState(wf);
    advance(state, wf, paths, ["requirements"]);
    rmSync(checkpointPath(paths, "requirements"));

    const problems = auditSnapshots(paths, state);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /indexed but its file is missing/);
  });

  test("doctor notices a stray file that is not in the index", () => {
    const paths = tempPaths();
    const state = freshState(workflow());
    mkdirSync(paths.checkpoints, { recursive: true });
    writeFileSync(checkpointPath(paths, "ghost"), "{}", "utf-8");

    const problems = auditSnapshots(paths, state);
    assert.deepEqual(problems, ['checkpoint file "ghost.json" is not in the index']);
  });
});

describe("boundaryDigest", () => {
  test("the same boundary always fingerprints the same", () => {
    const wf = workflow();
    const a = freshState(wf);
    const b = freshState(wf);
    assert.equal(boundaryDigest(a, "requirements"), boundaryDigest(b, "requirements"));
  });

  test("finishing more work changes the fingerprint", () => {
    const paths = tempPaths();
    const wf = workflow();
    const state = freshState(wf);

    const before = boundaryDigest(state, "requirements");
    advance(state, wf, paths, ["requirements"]);
    assert.notEqual(boundaryDigest(state, "requirements"), before);
  });
});

describe("planRewind", () => {
  test("rewinding to a step restores the checkpoint before it", () => {
    const paths = tempPaths();
    const wf = workflow();
    const state = freshState(wf);
    advance(state, wf, paths, ["requirements", "design", "build"]);

    const plan = planRewind(paths, state, wf, "design");

    assert.equal(plan.from?.step, "requirements");
    assert.deepEqual(plan.undone, ["design", "build"]);
    assert.equal(plan.state.steps.requirements?.status, StepStatus.Completed);
    assert.equal(plan.state.steps.design?.status, StepStatus.Pending);
    assert.equal(plan.state.currentStep, "design");
  });

  test("the restored state carries the git HEAD the checkpoint was taken at", () => {
    const paths = tempPaths();
    const wf = workflow();
    const state = freshState(wf);
    advance(state, wf, paths, ["requirements", "design"]);

    const plan = planRewind(paths, state, wf, "design");
    assert.equal(plan.from?.gitHead, "head-requirements");
  });

  test("rewinding to the first step resets the run without needing a checkpoint", () => {
    const paths = tempPaths();
    const wf = workflow();
    const state = freshState(wf);
    advance(state, wf, paths, ["requirements", "design"]);

    const plan = planRewind(paths, state, wf, "requirements");

    assert.equal(plan.from, null);
    assert.deepEqual(plan.undone, ["requirements", "design"]);
    assert.equal(plan.state.currentStep, "requirements");
    assert.deepEqual(plan.state.checkpoints, []);
    for (const step of ["requirements", "design", "build"]) {
      assert.equal(plan.state.steps[step]?.status, StepStatus.Pending);
      assert.deepEqual(plan.state.steps[step]?.artifacts, []);
    }
  });

  test("a step skipped by a condition stays skipped through a reset", () => {
    const result = compileWorkflow({
      id: "feature",
      name: "Feature",
      version: 1,
      steps: [
        { id: "api", agent: "backend-developer", objective: "API", produces: ["api.md"] },
        {
          id: "ui",
          agent: "frontend-developer",
          objective: "UI",
          when: ["hasFrontend"],
          produces: ["ui.md"],
        },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");

    const wf = result.workflow;
    const state = RunState.parse({
      version: STATE_VERSION,
      runId: RUN_ID,
      goal: "Add an orders service",
      workflow: wf.id,
      workflowDigest: wf.digest,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
      status: RunStatus.Active,
      currentStep: "api",
      steps: planSteps(wf, { hasFrontend: false }),
    });

    const paths = tempPaths();
    advance(state, wf, paths, ["api"]);

    const plan = planRewind(paths, state, wf, "api");
    assert.equal(plan.state.steps.ui?.status, StepStatus.Skipped);
  });

  test("an unknown step is rejected before anything is loaded", () => {
    const paths = tempPaths();
    const wf = workflow();
    assert.throws(
      () => planRewind(paths, freshState(wf), wf, "nope"),
      (error: CheckpointError) => error.code === "unknown-step",
    );
  });

  test("rewinding to where the run already sits is refused", () => {
    const paths = tempPaths();
    const wf = workflow();
    assert.throws(
      () => planRewind(paths, freshState(wf), wf, "requirements"),
      (error: CheckpointError) => error.code === "nothing-to-undo",
    );
  });

  test("an edited snapshot is refused rather than restored", () => {
    const paths = tempPaths();
    const wf = workflow();
    const state = freshState(wf);
    advance(state, wf, paths, ["requirements", "design"]);

    // Someone hand-edits the snapshot to claim work that never happened.
    const tampered = JSON.parse(readFileSync(checkpointPath(paths, "requirements"), "utf-8"));
    tampered.steps.design.status = StepStatus.Completed;
    writeFileSync(checkpointPath(paths, "requirements"), JSON.stringify(tampered), "utf-8");

    assert.throws(
      () => planRewind(paths, state, wf, "design"),
      (error: CheckpointError) => error.code === "digest-mismatch",
    );
  });

  test("rewinding past the only checkpoint says so instead of guessing", () => {
    const result = compileWorkflow({
      id: "feature",
      name: "Feature",
      version: 1,
      defaults: { checkpoint: false },
      steps: [
        { id: "a", agent: "business-analyst", objective: "A", produces: ["a.md"] },
        { id: "b", agent: "backend-developer", objective: "B", produces: ["b.md"] },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");

    const wf = result.workflow;
    const paths = tempPaths();
    const state = RunState.parse({
      version: STATE_VERSION,
      runId: RUN_ID,
      goal: "Add an orders service",
      workflow: wf.id,
      workflowDigest: wf.digest,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
      status: RunStatus.Active,
      currentStep: "a",
      steps: planSteps(wf, {}),
    });
    advance(state, wf, paths, ["a"]);

    assert.throws(
      () => planRewind(paths, state, wf, "b"),
      (error: CheckpointError) => error.code === "no-checkpoint",
    );
  });
});

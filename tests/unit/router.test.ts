import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  RouterError,
  StepResult,
  applyReport,
  markStepStarted,
  next,
  planSteps,
} from "../../core/engine/router.ts";
import { compileWorkflow } from "../../core/engine/compile.ts";
import { runPaths } from "../../core/engine/paths.ts";
import { DirectiveKind } from "../../core/schemas/directive.ts";
import { EventType } from "../../core/schemas/events.ts";
import {
  RunState,
  RunStatus,
  StepStatus,
  STATE_VERSION,
} from "../../core/schemas/state.ts";
import { GatePolicy, type CompiledWorkflow } from "../../core/schemas/workflow.ts";

const RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PATHS = runPaths("/project", RUN_ID);
const CONTEXT = { paths: PATHS };
const NOW = () => new Date("2026-09-11T12:00:00.000Z");

function workflow(steps: Record<string, unknown>[] = defaultSteps()): CompiledWorkflow {
  const result = compileWorkflow({ id: "feature", name: "Feature", version: 1, steps });
  assert.equal(result.ok, true, "test workflow must compile");
  if (!result.ok) throw new Error("unreachable");
  return result.workflow;
}

function defaultSteps() {
  return [
    {
      id: "requirements",
      agent: "business-analyst",
      objective: "Capture requirements",
      produces: ["requirements.md"],
      tools: ["read"],
      gate: GatePolicy.None,
    },
    {
      id: "build",
      agent: "backend-developer",
      objective: "Implement the service",
      consumes: ["requirements.md"],
      produces: ["build-summary.md"],
      tools: ["read", "write-code"],
      gate: GatePolicy.Approval,
      changeBudget: { maxFiles: 8, maxLines: 300 },
    },
  ];
}

function stateFor(wf: CompiledWorkflow, facts: Record<string, boolean> = {}): RunState {
  return RunState.parse({
    version: STATE_VERSION,
    runId: RUN_ID,
    goal: "Add an orders service",
    workflow: wf.id,
    workflowDigest: wf.digest,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    status: RunStatus.Active,
    currentStep: null,
    steps: planSteps(wf, facts),
  });
}

describe("planSteps", () => {
  test("marks inapplicable steps skipped up front, with a reason", () => {
    const wf = workflow([
      { id: "api", agent: "backend-developer", objective: "API", produces: ["api.md"] },
      {
        id: "ui",
        agent: "frontend-developer",
        objective: "UI",
        when: ["hasFrontend"],
        produces: ["ui.md"],
      },
    ]);

    const steps = planSteps(wf, { hasFrontend: false });

    assert.equal(steps.api?.status, StepStatus.Pending);
    assert.equal(steps.ui?.status, StepStatus.Skipped);
    assert.match(steps.ui?.skipReason ?? "", /hasFrontend/);
  });

  test("keeps applicable conditional steps pending", () => {
    const wf = workflow([
      {
        id: "ui",
        agent: "frontend-developer",
        objective: "UI",
        when: ["hasFrontend"],
        produces: ["ui.md"],
      },
    ]);

    assert.equal(planSteps(wf, { hasFrontend: true }).ui?.status, StepStatus.Pending);
  });
});

describe("next", () => {
  test("routes to the first step of a fresh run", () => {
    const wf = workflow();
    const directive = next(stateFor(wf), wf, CONTEXT);

    assert.equal(directive.kind, DirectiveKind.RunStep);
    if (directive.kind !== DirectiveKind.RunStep) return;
    assert.equal(directive.step, "requirements");
    assert.equal(directive.agent, "business-analyst");
    assert.equal(directive.attempt, 1);
  });

  test("is pure — asking twice gives the same answer and changes nothing", () => {
    const wf = workflow();
    const state = stateFor(wf);
    const snapshot = JSON.stringify(state);

    const first = next(state, wf, CONTEXT);
    const second = next(state, wf, CONTEXT);

    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(state), snapshot, "next() must not mutate state");
  });

  test("resolves consumed artifacts to the producing step's path", () => {
    const wf = workflow();
    const state = stateFor(wf);
    state.steps.requirements!.status = StepStatus.Completed;

    const directive = next(state, wf, CONTEXT);
    assert.equal(directive.kind, DirectiveKind.RunStep);
    if (directive.kind !== DirectiveKind.RunStep) return;

    assert.equal(directive.consumes[0]?.name, "requirements.md");
    assert.match(directive.consumes[0]?.path ?? "", /artifacts\/requirements\/requirements\.md$/);
  });

  test("reports a missing input rather than throwing", () => {
    const wf = workflow();
    const state = stateFor(wf);
    state.steps.requirements!.status = StepStatus.Completed;

    const directive = next(state, wf, { paths: PATHS, artifactExists: () => false });
    assert.equal(directive.kind, DirectiveKind.RunStep);
    if (directive.kind !== DirectiveKind.RunStep) return;
    assert.equal(directive.consumes[0]?.present, false);
  });

  test("skips over a skipped step", () => {
    const wf = workflow([
      {
        id: "ui",
        agent: "frontend-developer",
        objective: "UI",
        when: ["hasFrontend"],
        produces: ["ui.md"],
      },
      { id: "api", agent: "backend-developer", objective: "API", produces: ["api.md"] },
    ]);
    const directive = next(stateFor(wf, { hasFrontend: false }), wf, CONTEXT);

    assert.equal(directive.kind, DirectiveKind.RunStep);
    if (directive.kind !== DirectiveKind.RunStep) return;
    assert.equal(directive.step, "api");
  });

  test("progress counts only steps that will actually run", () => {
    const wf = workflow([
      {
        id: "ui",
        agent: "frontend-developer",
        objective: "UI",
        when: ["hasFrontend"],
        produces: ["ui.md"],
      },
      { id: "api", agent: "backend-developer", objective: "API", produces: ["api.md"] },
    ]);
    const directive = next(stateFor(wf, { hasFrontend: false }), wf, CONTEXT);

    assert.equal(directive.kind, DirectiveKind.RunStep);
    if (directive.kind !== DirectiveKind.RunStep) return;
    assert.deepEqual(directive.progress, { index: 0, total: 1, completed: 0 });
  });

  test("says done when every step is terminal", () => {
    const wf = workflow();
    const state = stateFor(wf);
    state.steps.requirements!.status = StepStatus.Completed;
    state.steps.build!.status = StepStatus.Completed;

    const directive = next(state, wf, CONTEXT);
    assert.equal(directive.kind, DirectiveKind.Done);
    if (directive.kind !== DirectiveKind.Done) return;
    assert.equal(directive.completed, 2);
  });

  test("warns when the workflow file changed mid-run", () => {
    const wf = workflow();
    const state = stateFor(wf);
    state.workflowDigest = "sha256:the-old-one";

    const directive = next(state, wf, CONTEXT);
    assert.equal(directive.kind, DirectiveKind.RunStep);
    if (directive.kind !== DirectiveKind.RunStep) return;
    assert.match(directive.warnings.join(" "), /changed after this run started/);
  });

  test("errors when the run has no record of a workflow step", () => {
    const wf = workflow();
    const state = stateFor(wf);
    delete (state.steps as Record<string, unknown>).requirements;

    assert.throws(
      () => next(state, wf, CONTEXT),
      (error: unknown) => error instanceof RouterError && error.code === "state-workflow-mismatch",
    );
  });

  test("stops at an open approval gate", () => {
    const wf = workflow();
    const state = stateFor(wf);
    state.steps.requirements!.status = StepStatus.Completed;
    state.steps.build!.status = StepStatus.AwaitingApproval;
    state.steps.build!.artifacts = ["build-summary.md"];

    const directive = next(state, wf, CONTEXT);
    assert.equal(directive.kind, DirectiveKind.AwaitApproval);
    if (directive.kind !== DirectiveKind.AwaitApproval) return;
    assert.equal(directive.step, "build");
    assert.equal(directive.artifacts[0]?.name, "build-summary.md");
  });

  test("stops at an outstanding review", () => {
    const wf = workflow();
    const state = stateFor(wf);
    state.steps.requirements!.status = StepStatus.Completed;
    state.steps.build!.status = StepStatus.AwaitingReview;
    state.steps.build!.receipts = [
      {
        id: "r-1",
        step: "build",
        requestedAt: "2026-09-10T01:00:00.000Z",
        summary: "Add the orders service",
        files: [{ path: "src/orders.ts", action: "add" }],
        changedLines: 180,
        digest: "sha256:plan-a",
        resolution: null,
      },
    ];

    const directive = next(state, wf, CONTEXT);
    assert.equal(directive.kind, DirectiveKind.AwaitReview);
    if (directive.kind !== DirectiveKind.AwaitReview) return;
    assert.equal(directive.receiptId, "r-1");
    assert.equal(directive.changedLines, 180);
  });

  test("errors when awaiting a review that was never requested", () => {
    const wf = workflow();
    const state = stateFor(wf);
    state.steps.requirements!.status = StepStatus.AwaitingReview;

    const directive = next(state, wf, CONTEXT);
    assert.equal(directive.kind, DirectiveKind.Error);
  });

  test("refuses to route a failed run", () => {
    const wf = workflow();
    const state = stateFor(wf);
    state.status = RunStatus.Failed;

    assert.equal(next(state, wf, CONTEXT).kind, DirectiveKind.Error);
  });
});

describe("markStepStarted", () => {
  test("moves a pending step to active and emits its start events", () => {
    const wf = workflow();
    const state = stateFor(wf);

    const events = markStepStarted(state, "requirements", NOW);

    assert.equal(state.steps.requirements?.status, StepStatus.Active);
    assert.equal(state.currentStep, "requirements");
    assert.deepEqual(
      events.map((event) => event.type),
      [EventType.AgentActivated, EventType.StepStarted],
    );
  });

  test("is idempotent — starting an active step emits nothing", () => {
    const wf = workflow();
    const state = stateFor(wf);
    markStepStarted(state, "requirements", NOW);

    assert.deepEqual(markStepStarted(state, "requirements", NOW), []);
  });
});

describe("applyReport", () => {
  function started(wf: CompiledWorkflow, stepId: string) {
    const state = stateFor(wf);
    markStepStarted(state, stepId, NOW);
    return state;
  }

  test("an ungated step completes and checkpoints", () => {
    const wf = workflow();
    const state = started(wf, "requirements");

    const events = applyReport(
      state,
      wf,
      { step: "requirements", result: StepResult.Completed, artifacts: ["requirements.md"] },
      NOW,
    );

    assert.equal(state.steps.requirements?.status, StepStatus.Completed);
    assert.equal(state.currentStep, "build");
    assert.deepEqual(
      events.map((event) => event.type),
      [EventType.StepCompleted, EventType.CheckpointSaved],
    );
    assert.equal(state.checkpoints.length, 1);
  });

  test("a gated step stops for approval instead of completing", () => {
    const wf = workflow();
    const state = started(wf, "requirements");
    applyReport(state, wf, { step: "requirements", result: StepResult.Completed }, NOW);
    markStepStarted(state, "build", NOW);

    const events = applyReport(state, wf, { step: "build", result: StepResult.Completed }, NOW);

    assert.equal(state.steps.build?.status, StepStatus.AwaitingApproval);
    assert.deepEqual(
      events.map((event) => event.type),
      [EventType.GateOpened],
    );
  });

  test("approval requires that a human acted since the last gate", () => {
    const wf = workflow();
    const state = started(wf, "requirements");
    applyReport(state, wf, { step: "requirements", result: StepResult.Completed }, NOW);
    markStepStarted(state, "build", NOW);
    applyReport(state, wf, { step: "build", result: StepResult.Completed }, NOW);

    assert.throws(
      () => applyReport(state, wf, { step: "build", result: StepResult.Approved }, NOW),
      (error: unknown) => error instanceof RouterError && error.code === "no-human-presence",
    );
  });

  test("approval completes the step once a human is present", () => {
    const wf = workflow();
    const state = started(wf, "requirements");
    applyReport(state, wf, { step: "requirements", result: StepResult.Completed }, NOW);
    markStepStarted(state, "build", NOW);
    applyReport(state, wf, { step: "build", result: StepResult.Completed }, NOW);
    state.lastHumanTurnAt = "2026-09-11T11:59:00.000Z";

    const events = applyReport(state, wf, { step: "build", result: StepResult.Approved }, NOW);

    assert.equal(state.steps.build?.status, StepStatus.Completed);
    assert.equal(state.status, RunStatus.Completed);
    assert.equal(state.currentStep, null);
    assert.deepEqual(
      events.map((event) => event.type),
      [EventType.GateResolved, EventType.StepCompleted, EventType.CheckpointSaved],
    );
  });

  test("rejection sends the step back with the human's feedback", () => {
    const wf = workflow();
    const state = started(wf, "requirements");
    applyReport(state, wf, { step: "requirements", result: StepResult.Completed }, NOW);
    markStepStarted(state, "build", NOW);
    applyReport(state, wf, { step: "build", result: StepResult.Completed }, NOW);

    applyReport(
      state,
      wf,
      { step: "build", result: StepResult.Rejected, feedback: "split the migration out" },
      NOW,
    );

    assert.equal(state.steps.build?.status, StepStatus.Active);
    assert.equal(state.steps.build?.attempt, 1);

    const directive = next(state, wf, CONTEXT);
    assert.equal(directive.kind, DirectiveKind.RunStep);
    if (directive.kind !== DirectiveKind.RunStep) return;
    assert.equal(directive.attempt, 2);
    assert.equal(directive.feedback, "split the migration out");
  });

  test("rejection without feedback is refused", () => {
    const wf = workflow();
    const state = started(wf, "requirements");
    applyReport(state, wf, { step: "requirements", result: StepResult.Completed }, NOW);
    markStepStarted(state, "build", NOW);
    applyReport(state, wf, { step: "build", result: StepResult.Completed }, NOW);

    assert.throws(
      () => applyReport(state, wf, { step: "build", result: StepResult.Rejected }, NOW),
      (error: unknown) => error instanceof RouterError && error.code === "missing-feedback",
    );
  });

  test("needs-review parks the step pending a human look", () => {
    const wf = workflow();
    const state = started(wf, "requirements");

    const events = applyReport(
      state,
      wf,
      { step: "requirements", result: StepResult.NeedsReview },
      NOW,
    );

    assert.equal(state.steps.requirements?.status, StepStatus.AwaitingReview);
    assert.deepEqual(
      events.map((event) => event.type),
      [EventType.GateOpened],
    );
  });

  test("reporting the same completion twice is a no-op, not an error", () => {
    // The conductor's loop can be interrupted between reporting and asking
    // again; a retry must not corrupt the run.
    const wf = workflow();
    const state = started(wf, "requirements");
    applyReport(state, wf, { step: "requirements", result: StepResult.Completed }, NOW);

    const second = applyReport(
      state,
      wf,
      { step: "requirements", result: StepResult.Completed },
      NOW,
    );

    assert.deepEqual(second, []);
    assert.equal(state.checkpoints.length, 1, "no duplicate checkpoint");
  });

  test("refuses an out-of-order transition", () => {
    const wf = workflow();
    const state = stateFor(wf);

    assert.throws(
      () => applyReport(state, wf, { step: "requirements", result: StepResult.Approved }, NOW),
      (error: unknown) => error instanceof RouterError && error.code === "illegal-transition",
    );
  });

  test("refuses a step the workflow does not define", () => {
    const wf = workflow();
    assert.throws(
      () => applyReport(stateFor(wf), wf, { step: "nope", result: StepResult.Completed }, NOW),
      (error: unknown) => error instanceof RouterError && error.code === "unknown-step",
    );
  });

  test("failure stops the run", () => {
    const wf = workflow();
    const state = started(wf, "requirements");

    const events = applyReport(
      state,
      wf,
      { step: "requirements", result: StepResult.Failed, error: "no requirements source" },
      NOW,
    );

    assert.equal(state.status, RunStatus.Failed);
    assert.deepEqual(
      events.map((event) => event.type),
      [EventType.StepFailed, EventType.RunFailed],
    );
  });
});

describe("a full run", () => {
  test("drives from first directive to done", () => {
    const wf = workflow();
    const state = stateFor(wf);
    const seen: string[] = [];

    for (let guard = 0; guard < 20; guard++) {
      const directive = next(state, wf, CONTEXT);
      seen.push(directive.kind);

      if (directive.kind === DirectiveKind.Done) break;

      if (directive.kind === DirectiveKind.RunStep) {
        markStepStarted(state, directive.step, NOW);
        applyReport(state, wf, { step: directive.step, result: StepResult.Completed }, NOW);
        continue;
      }

      if (directive.kind === DirectiveKind.AwaitApproval) {
        state.lastHumanTurnAt = "2026-09-11T11:59:59.000Z";
        applyReport(state, wf, { step: directive.step, result: StepResult.Approved }, NOW);
        continue;
      }

      assert.fail(`unexpected directive ${directive.kind}`);
    }

    assert.deepEqual(seen, [
      DirectiveKind.RunStep,
      DirectiveKind.RunStep,
      DirectiveKind.AwaitApproval,
      DirectiveKind.Done,
    ]);
    assert.equal(state.status, RunStatus.Completed);
  });
});

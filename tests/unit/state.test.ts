import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  RunState,
  StepState,
  StepStatus,
  RunStatus,
  ReviewReceipt,
  STATE_VERSION,
  TERMINAL_STEP_STATUSES,
  newStepState,
  hasHumanPresence,
  approvedReceiptFor,
  pendingReceipt,
  changedFileCount,
} from "../../core/schemas/state.ts";

const T0 = "2026-09-10T00:00:00.000Z";
const T1 = "2026-09-10T01:00:00.000Z";
const T2 = "2026-09-10T02:00:00.000Z";

function runState(overrides: Partial<Record<string, unknown>> = {}) {
  return RunState.parse({
    version: STATE_VERSION,
    runId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    goal: "Add an orders service",
    workflow: "feature",
    workflowDigest: "sha256:abc",
    createdAt: T0,
    updatedAt: T0,
    status: RunStatus.Active,
    currentStep: null,
    steps: {},
    ...overrides,
  });
}

describe("RunState", () => {
  test("parses a minimal run and fills defaults", () => {
    const state = runState();

    assert.deepEqual(state.checkpoints, []);
    assert.deepEqual(state.facts, {});
    assert.equal(state.lastHumanTurnAt, null);
    assert.equal(state.lastGateResolvedAt, null);
  });

  test("rejects a state from a future schema version", () => {
    const result = RunState.safeParse({ ...runState(), version: 2 });
    assert.equal(result.success, false);
  });

  test("rejects a malformed runId", () => {
    const result = RunState.safeParse({ ...runState(), runId: "run-1" });
    assert.equal(result.success, false);
  });

  test("rejects a non-ISO timestamp", () => {
    const result = RunState.safeParse({ ...runState(), createdAt: "yesterday" });
    assert.equal(result.success, false);
  });
});

describe("StepState", () => {
  test("a new step starts pending with empty tallies", () => {
    const step = newStepState("backend-developer");

    assert.equal(step.status, StepStatus.Pending);
    assert.equal(step.attempt, 0);
    assert.equal(step.changedLines, 0);
    assert.deepEqual(step.changedFiles, []);
    assert.deepEqual(step.receipts, []);
  });

  test("rejects an unknown status", () => {
    const result = StepState.safeParse({ status: "vibing", agent: "qa-engineer" });
    assert.equal(result.success, false);
  });

  test("completed and skipped are the terminal statuses", () => {
    assert.ok(TERMINAL_STEP_STATUSES.has(StepStatus.Completed));
    assert.ok(TERMINAL_STEP_STATUSES.has(StepStatus.Skipped));
    assert.ok(!TERMINAL_STEP_STATUSES.has(StepStatus.Failed));
    assert.ok(!TERMINAL_STEP_STATUSES.has(StepStatus.AwaitingApproval));
  });
});

describe("changedFileCount", () => {
  test("counts distinct files, so rewriting one file is still one file", () => {
    const step = StepState.parse({
      status: StepStatus.Active,
      agent: "backend-developer",
      changedFiles: ["src/a.ts", "src/a.ts", "src/a.ts", "src/b.ts"],
      changedLines: 420,
    });

    assert.equal(changedFileCount(step), 2);
    assert.equal(step.changedLines, 420, "line churn stays cumulative");
  });
});

describe("hasHumanPresence", () => {
  test("false when no human has acted at all", () => {
    assert.equal(hasHumanPresence(runState()), false);
  });

  test("true on a first gate once a human has acted", () => {
    const state = runState({ lastHumanTurnAt: T1 });
    assert.equal(hasHumanPresence(state), true);
  });

  test("false when the last human turn predates the last gate", () => {
    // This is the case that matters: the model resolved a gate, then tried to
    // resolve another one without the human coming back.
    const state = runState({ lastHumanTurnAt: T1, lastGateResolvedAt: T2 });
    assert.equal(hasHumanPresence(state), false);
  });

  test("true again once the human acts after the last gate", () => {
    const state = runState({ lastHumanTurnAt: T2, lastGateResolvedAt: T1 });
    assert.equal(hasHumanPresence(state), true);
  });
});

describe("review receipts", () => {
  const requested = ReviewReceipt.parse({
    id: "r-1",
    step: "backend-implementation",
    requestedAt: T1,
    summary: "Add the orders service",
    files: [{ path: "src/orders.ts", action: "add" }],
    changedLines: 180,
    digest: "sha256:plan-a",
  });

  test("a requested receipt is unresolved by default", () => {
    assert.equal(requested.resolution, null);
  });

  test("pendingReceipt finds the review the human owes an answer on", () => {
    const step = StepState.parse({
      status: StepStatus.AwaitingReview,
      agent: "backend-developer",
      receipts: [requested],
    });

    assert.equal(pendingReceipt(step)?.id, "r-1");
    assert.equal(approvedReceiptFor(step, "sha256:plan-a"), undefined);
  });

  test("an approved receipt only covers the exact content reviewed", () => {
    const approved = {
      ...requested,
      resolution: { approved: true, at: T2 },
    };
    const step = StepState.parse({
      status: StepStatus.Active,
      agent: "backend-developer",
      receipts: [approved],
    });

    assert.equal(approvedReceiptFor(step, "sha256:plan-a")?.id, "r-1");
    // The approval must not carry over to different content.
    assert.equal(approvedReceiptFor(step, "sha256:plan-b"), undefined);
  });

  test("a rejected receipt never counts as approval", () => {
    const rejected = {
      ...requested,
      resolution: { approved: false, at: T2, feedback: "split this up" },
    };
    const step = StepState.parse({
      status: StepStatus.AwaitingReview,
      agent: "backend-developer",
      receipts: [rejected],
    });

    assert.equal(approvedReceiptFor(step, "sha256:plan-a"), undefined);
    assert.equal(pendingReceipt(step), undefined, "it was answered, just not approved");
  });
});

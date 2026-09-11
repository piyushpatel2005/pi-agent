import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ReviewError,
  digestOf,
  parseReviewedFile,
  requestReview,
  resolveReview,
} from "../../core/engine/review.ts";
import { RunState, RunStatus, STATE_VERSION, StepStatus } from "../../core/schemas/state.ts";
import type { RunState as RunStateType } from "../../core/schemas/state.ts";

const FILES = [{ path: "src/a.ts", action: "modify" as const }];

function state(overrides: Record<string, unknown> = {}): RunStateType {
  const now = new Date().toISOString();
  return RunState.parse({
    version: STATE_VERSION,
    runId: "11111111-1111-4111-8111-111111111111",
    goal: "g",
    workflow: "w",
    workflowDigest: "sha256:x",
    createdAt: now,
    updatedAt: now,
    status: RunStatus.Active,
    currentStep: "build",
    steps: { build: { status: StepStatus.Active, agent: "backend-developer" } },
    lastHumanTurnAt: now,
    ...overrides,
  });
}

function open(draft: RunStateType, summary = "Added the orders service."): void {
  requestReview(draft, { summary, files: FILES, changedLines: 120 });
}

describe("requestReview", () => {
  test("records the receipt and freezes the step", () => {
    const draft = state();
    const { receipt } = requestReview(draft, {
      summary: "Added the orders service.",
      files: FILES,
      changedLines: 120,
    });

    assert.equal(receipt.step, "build");
    assert.equal(receipt.changedLines, 120);
    assert.equal(receipt.resolution, null);
    assert.equal(draft.steps.build!.status, StepStatus.AwaitingReview);
    assert.deepEqual(draft.steps.build!.receipts, [receipt]);
  });

  test("emits the request and opens the gate", () => {
    const draft = state();
    const { events } = requestReview(draft, { summary: "s", files: FILES, changedLines: 1 });
    assert.deepEqual(events.map((event) => event.type), ["review.requested", "gate.opened"]);
  });

  test("refuses a second review while one is unanswered", () => {
    const draft = state();
    open(draft);
    assert.throws(() => open(draft), /already has a review waiting/);
  });

  test("refuses an empty summary, because that is what the reviewer reads", () => {
    assert.throws(
      () => requestReview(state(), { summary: "   ", files: FILES, changedLines: 1 }),
      /needs a summary/,
    );
  });

  test("refuses a review with no files", () => {
    assert.throws(
      () => requestReview(state(), { summary: "s", files: [], changedLines: 0 }),
      /at least one file/,
    );
  });

  test("refuses when no step is active", () => {
    assert.throws(
      () => requestReview(state({ currentStep: null }), { summary: "s", files: FILES, changedLines: 1 }),
      ReviewError,
    );
  });
});

describe("resolveReview", () => {
  test("approval resumes the step and records the answer", () => {
    const draft = state();
    open(draft);

    const { receipt, events } = resolveReview(draft, { approved: true });

    assert.equal(receipt.resolution?.approved, true);
    assert.equal(draft.steps.build!.status, StepStatus.Active);
    assert.deepEqual(events.map((event) => event.type), ["review.resolved", "gate.resolved"]);
  });

  test("rejection resumes the step with the feedback attached", () => {
    const draft = state();
    open(draft);

    resolveReview(draft, { approved: false, feedback: "Split the write path." });

    assert.equal(draft.steps.build!.status, StepStatus.Active);
    assert.equal(draft.steps.build!.error, "Split the write path.");
    assert.equal(draft.steps.build!.receipts[0]!.resolution?.feedback, "Split the write path.");
  });

  test("rejection without feedback is refused, since the retry would be a guess", () => {
    const draft = state();
    open(draft);
    assert.throws(() => resolveReview(draft, { approved: false }), /needs feedback/);
  });

  test("an unattended run cannot approve its own work", () => {
    const draft = state({ lastHumanTurnAt: null });
    open(draft);
    assert.throws(() => resolveReview(draft, { approved: true }), /without a human/);
  });

  test("a human turn that predates the last gate does not count", () => {
    const draft = state({
      lastHumanTurnAt: "2026-01-01T00:00:00.000Z",
      lastGateResolvedAt: "2026-01-02T00:00:00.000Z",
    });
    open(draft);
    assert.throws(() => resolveReview(draft, { approved: true }), /without a human/);
  });

  test("resolving stamps the gate, so the next one needs a fresh human turn", () => {
    const draft = state();
    open(draft);
    resolveReview(draft, { approved: true });

    assert.ok(draft.lastGateResolvedAt);
    open(draft, "More work.");
    assert.throws(() => resolveReview(draft, { approved: true }), /without a human/);
  });

  test("refuses when there is nothing to answer", () => {
    assert.throws(() => resolveReview(state(), { approved: true }), /no review waiting/);
  });
});

describe("digestOf", () => {
  const request = { summary: "Added it.", files: FILES, changedLines: 10 };

  test("is stable for the same content", () => {
    assert.equal(digestOf("build", request), digestOf("build", request));
  });

  test("ignores the order files were listed in", () => {
    const a = { ...request, files: [FILES[0]!, { path: "b.ts", action: "add" as const }] };
    const b = { ...request, files: [{ path: "b.ts", action: "add" as const }, FILES[0]!] };
    assert.equal(digestOf("build", a), digestOf("build", b));
  });

  test("changes when the summary, files, line count, or step change", () => {
    const base = digestOf("build", request);
    assert.notEqual(base, digestOf("build", { ...request, summary: "Something else." }));
    assert.notEqual(base, digestOf("build", { ...request, changedLines: 11 }));
    assert.notEqual(
      base,
      digestOf("build", { ...request, files: [{ path: "src/a.ts", action: "delete" }] }),
    );
    assert.notEqual(base, digestOf("other", request));
  });
});

describe("parseReviewedFile", () => {
  test("reads an explicit action", () => {
    assert.deepEqual(parseReviewedFile("add:src/a.ts"), { action: "add", path: "src/a.ts" });
    assert.deepEqual(parseReviewedFile("delete:src/b.ts"), { action: "delete", path: "src/b.ts" });
  });

  test("treats a bare path as a modification", () => {
    assert.deepEqual(parseReviewedFile("src/a.ts"), { action: "modify", path: "src/a.ts" });
  });

  test("does not mistake a path containing a colon for an action", () => {
    assert.deepEqual(parseReviewedFile("weird:name.ts"), {
      action: "modify",
      path: "weird:name.ts",
    });
  });
});

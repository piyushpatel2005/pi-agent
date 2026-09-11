// Review receipts: the record that a human looked at a specific change.
//
// A receipt has to be worth more than a flag, or the gate is theatre. Three
// properties make it real, and each is enforced somewhere:
//
//   1. It fingerprints what was reviewed (`digest`), so an approval cannot be
//      quietly retargeted at different work.
//   2. It cannot be edited after the fact — the state store's append-only
//      invariant refuses a receipt whose digest or answer changed.
//   3. It requires human presence: a run with nobody watching mints no human
//      turn, so it cannot approve its own work.

import { createHash, randomUUID } from "node:crypto";

import { EventType, type PiEventInput, type ReviewedFile } from "../schemas/events.ts";
import {
  ReviewReceipt,
  StepStatus,
  hasHumanPresence,
  pendingReceipt,
  type RunState,
  type StepState,
} from "../schemas/state.ts";

export class ReviewError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
  }
}

export type ReviewRequest = {
  summary: string;
  files: ReviewedFile[];
  changedLines: number;
};

/**
 * Fingerprint of what the human is being asked to approve.
 *
 * Over the summary and the file list rather than file contents: the reviewer
 * reads the summary and the paths, so that is what the receipt should attest
 * to. Contents are in git.
 */
export function digestOf(step: string, request: ReviewRequest): string {
  const canonical = JSON.stringify({
    step,
    summary: request.summary.trim(),
    files: [...request.files]
      .map((file) => `${file.action} ${file.path}`)
      .sort(),
    changedLines: request.changedLines,
  });

  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Open a review. The step stops accepting changes until it is answered, which
 * is what keeps the reviewed diff from moving underneath the reviewer.
 */
export function requestReview(
  draft: RunState,
  request: ReviewRequest,
  now: () => Date = () => new Date(),
): { receipt: ReviewReceipt; events: PiEventInput[] } {
  const stepId = draft.currentStep;
  if (stepId === null) {
    throw new ReviewError("no-active-step", "No step is active, so there is nothing to review.");
  }

  const stepState = draft.steps[stepId];
  if (!stepState) {
    throw new ReviewError("unknown-step", `This run has no record of step "${stepId}".`);
  }

  const outstanding = pendingReceipt(stepState);
  if (outstanding) {
    throw new ReviewError(
      "review-already-pending",
      `Step "${stepId}" already has a review waiting for an answer ` +
        `(${outstanding.id}). Resolve it before requesting another.`,
    );
  }

  if (request.summary.trim() === "") {
    throw new ReviewError(
      "empty-summary",
      "A review needs a summary. The reviewer is reading the summary, not the diff.",
    );
  }

  if (request.files.length === 0) {
    throw new ReviewError("no-files", "A review needs at least one file to review.");
  }

  const receipt = ReviewReceipt.parse({
    id: randomUUID(),
    step: stepId,
    requestedAt: now().toISOString(),
    summary: request.summary.trim(),
    files: request.files,
    changedLines: request.changedLines,
    digest: digestOf(stepId, request),
    resolution: null,
  });

  stepState.receipts.push(receipt);
  stepState.status = StepStatus.AwaitingReview;

  return {
    receipt,
    events: [
      {
        type: EventType.ReviewRequested,
        step: stepId,
        receiptId: receipt.id,
        summary: receipt.summary,
        files: receipt.files,
        changedLines: receipt.changedLines,
      },
      { type: EventType.GateOpened, step: stepId, kind: "review" },
    ],
  };
}

/**
 * Answer the open review.
 *
 * Approval resumes the step with a fresh budget; rejection also resumes it, but
 * with the feedback attached so the next attempt knows what was wrong. Either
 * way the step goes back to running — a review is a checkpoint inside a step,
 * not the end of one.
 */
export function resolveReview(
  draft: RunState,
  answer: { approved: boolean; feedback?: string },
  now: () => Date = () => new Date(),
): { receipt: ReviewReceipt; events: PiEventInput[] } {
  const stepId = draft.currentStep;
  if (stepId === null) {
    throw new ReviewError("no-active-step", "No step is active, so there is no review to answer.");
  }

  const stepState = draft.steps[stepId];
  if (!stepState) {
    throw new ReviewError("unknown-step", `This run has no record of step "${stepId}".`);
  }

  const receipt = pendingReceipt(stepState);
  if (!receipt) {
    throw new ReviewError(
      "no-pending-review",
      `Step "${stepId}" has no review waiting for an answer.`,
    );
  }

  // The presence rule. Without it, an unattended run could resolve its own
  // reviews and the receipt would attest to nothing.
  if (!hasHumanPresence(draft)) {
    throw new ReviewError(
      "no-human-presence",
      "A review cannot be resolved without a human: no human turn has been " +
        "recorded since the last gate. Review requires an interactive session.",
    );
  }

  if (!answer.approved && !answer.feedback?.trim()) {
    throw new ReviewError(
      "missing-feedback",
      "Rejecting a review needs feedback, otherwise the next attempt is a guess.",
    );
  }

  const timestamp = now().toISOString();

  receipt.resolution = {
    approved: answer.approved,
    at: timestamp,
    ...(answer.feedback?.trim() ? { feedback: answer.feedback.trim() } : {}),
  };

  stepState.status = StepStatus.Active;
  draft.lastGateResolvedAt = timestamp;

  if (!answer.approved) stepState.error = answer.feedback?.trim();

  return {
    receipt,
    events: [
      {
        type: EventType.ReviewResolved,
        step: stepId,
        receiptId: receipt.id,
        approved: answer.approved,
        ...(receipt.resolution.feedback ? { feedback: receipt.resolution.feedback } : {}),
      },
      {
        type: EventType.GateResolved,
        step: stepId,
        kind: "review",
        outcome: answer.approved ? "approved" : "rejected",
      },
    ],
  };
}

/** Parse `add:src/a.ts` / `modify:src/b.ts` / a bare path into a reviewed file. */
export function parseReviewedFile(raw: string): ReviewedFile {
  const match = /^(add|modify|delete):(.+)$/.exec(raw.trim());
  if (match) return { action: match[1] as ReviewedFile["action"], path: match[2]!.trim() };

  return { action: "modify", path: raw.trim() };
}

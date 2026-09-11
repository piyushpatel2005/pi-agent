// The run state is truth-of-now.
//
// The event log says what happened; this file says where we are. The router
// reads it to pick the next step, the guards read it to decide whether a tool
// call is allowed, `pi status` renders it, and `pi resume` restores from it.
//
// Two rules shape everything below:
//
//   1. State is derivable from the log, but not re-derived on the hot path.
//      A `preToolUse` guard runs on every tool call and must answer in
//      milliseconds, so the fields it needs (the current step, its change
//      tally, its receipts) are maintained here rather than replayed.
//
//   2. Receipts are append-only. A review receipt is the evidence a human
//      approved something. Routine status writes must never drop or rewrite
//      one, and the state store enforces that as an invariant.

import { z } from "zod";
import { ReviewedFile } from "./events.ts";

/** Bumped only for a breaking change to the shape below; the store migrates on read. */
export const STATE_VERSION = 1;

const iso = z.iso.datetime();

export const StepStatus = {
  /** Not reached yet. */
  Pending: "pending",
  /** The current step; work is happening. */
  Active: "active",
  /** Work is written but a human has not reviewed the change yet. */
  AwaitingReview: "awaiting-review",
  /** Reviewed; waiting for the human to approve the step and advance the run. */
  AwaitingApproval: "awaiting-approval",
  /** Done, artifacts produced. */
  Completed: "completed",
  /** Not applicable to this run (a `when` condition was false). */
  Skipped: "skipped",
  /** Attempted and could not complete. */
  Failed: "failed",
} as const;

export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

/** Statuses the router treats as "no more work here". */
export const TERMINAL_STEP_STATUSES: ReadonlySet<StepStatus> = new Set([
  StepStatus.Completed,
  StepStatus.Skipped,
]);

export const RunStatus = {
  Active: "active",
  /** Stopped at a clean step boundary, resumable. */
  Parked: "parked",
  Completed: "completed",
  Failed: "failed",
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/**
 * A human's decision on a proposed change.
 *
 * `digest` fingerprints what was actually reviewed. The change-budget guard
 * accepts a receipt only when the digest still matches what is about to be
 * written, so an approval cannot be reused to wave through different code.
 */
export const ReviewReceipt = z.object({
  id: z.string().min(1),
  step: z.string().min(1),
  requestedAt: iso,
  summary: z.string(),
  files: z.array(ReviewedFile),
  changedLines: z.number().int().nonnegative(),
  digest: z.string().min(1),
  resolution: z
    .object({
      approved: z.boolean(),
      at: iso,
      feedback: z.string().optional(),
    })
    .nullable()
    .default(null),
});

export type ReviewReceipt = z.infer<typeof ReviewReceipt>;

export const StepState = z.object({
  status: z.enum(Object.values(StepStatus) as [StepStatus, ...StepStatus[]]),
  agent: z.string().min(1),
  /** Incremented on each revision, so a rejected step can be told from a first pass. */
  attempt: z.number().int().nonnegative().default(0),
  startedAt: iso.optional(),
  completedAt: iso.optional(),

  /** Artifacts this step produced, for traceability and the next step's inputs. */
  artifacts: z.array(z.string()).default([]),

  /**
   * The change tally the budget guard enforces against.
   *
   * Files are stored as a path list rather than a count on purpose: rewriting
   * the same file five times is one file against `maxFiles`, which is what a
   * reviewer actually cares about. `changedLines` stays cumulative, because
   * churn is churn.
   */
  changedFiles: z.array(z.string()).default([]),
  changedLines: z.number().int().nonnegative().default(0),

  receipts: z.array(ReviewReceipt).default([]),

  skipReason: z.string().optional(),
  error: z.string().optional(),
});

export type StepState = z.infer<typeof StepState>;

export const Checkpoint = z.object({
  step: z.string().min(1),
  at: iso,
  /** Digest of the state at this boundary; `pi rewind` verifies against it. */
  digest: z.string().min(1),
  artifacts: z.array(z.string()).default([]),
  /** Recorded when the project is a git repo, so a rewind can show what moved. */
  gitHead: z.string().optional(),
});

export type Checkpoint = z.infer<typeof Checkpoint>;

export const RunState = z.object({
  version: z.literal(STATE_VERSION),
  /**
   * The pi release that started this run.
   *
   * Separate from `version` above, which is the schema shape. Two releases can
   * write the same schema and still behave differently, so when a six-month-old
   * run looks wrong this is the field that says which tool to blame.
   *
   * Optional because runs created before this field existed are still valid;
   * absent means "older than 0.1.0".
   */
  piVersion: z.string().min(1).optional(),
  runId: z.uuid(),
  goal: z.string(),

  workflow: z.string().min(1),
  /**
   * Digest of the compiled workflow this run started from. If the workflow file
   * changes mid-run, the router can say so instead of silently routing against
   * a definition that no longer matches the recorded steps.
   */
  workflowDigest: z.string().min(1),

  createdAt: iso,
  updatedAt: iso,
  status: z.enum(Object.values(RunStatus) as [RunStatus, ...RunStatus[]]),

  /** The step the run is on. Null before the first step and after the last. */
  currentStep: z.string().nullable(),

  /**
   * Keyed by step id. Order is not stored here — it belongs to the workflow,
   * which is the only thing entitled to define it.
   */
  steps: z.record(z.string(), StepState),

  checkpoints: z.array(Checkpoint).default([]),

  /**
   * Human presence, for the gate rule: a gate may only resolve when a human
   * acted since the last gate resolved. An unattended run mints no human turn,
   * so it cannot approve its own work.
   */
  lastHumanTurnAt: iso.nullable().default(null),
  lastGateResolvedAt: iso.nullable().default(null),

  /**
   * The closed set of booleans a workflow's `when` conditions resolve against
   * (hasFrontend, needsInfra, isBrownfield). Deliberately not arbitrary
   * expressions, so routing stays predictable and explainable.
   */
  facts: z.record(z.string(), z.boolean()).default({}),
});

export type RunState = z.infer<typeof RunState>;

// ── Definitional helpers ────────────────────────────────────────────────────
// These encode what the fields above *mean*. Keeping them beside the schema
// stops each caller from reinventing the comparison slightly differently.

export function newStepState(agent: string): StepState {
  return StepState.parse({ status: StepStatus.Pending, agent });
}

/**
 * Has a human acted since the last gate resolved?
 *
 * This is the whole presence rule. A run with no gates yet only needs one human
 * turn to have happened at all.
 */
export function hasHumanPresence(state: RunState): boolean {
  if (state.lastHumanTurnAt === null) return false;
  if (state.lastGateResolvedAt === null) return true;
  return Date.parse(state.lastHumanTurnAt) > Date.parse(state.lastGateResolvedAt);
}

/** The receipt covering exactly this content, if a human approved it. */
export function approvedReceiptFor(
  step: StepState,
  digest: string,
): ReviewReceipt | undefined {
  return step.receipts.find(
    (receipt) => receipt.digest === digest && receipt.resolution?.approved === true,
  );
}

/** A review the human has not answered yet; the run is waiting on them. */
export function pendingReceipt(step: StepState): ReviewReceipt | undefined {
  return step.receipts.find((receipt) => receipt.resolution === null);
}

/** Distinct files touched, which is what `maxFiles` budgets. */
export function changedFileCount(step: StepState): number {
  return new Set(step.changedFiles).size;
}

/**
 * The most recent approval, which is where the budget starts counting again.
 *
 * Receipts are append-only and in request order, so the last approved one is
 * the current baseline.
 */
export function latestApprovedReceipt(step: StepState): ReviewReceipt | undefined {
  return step.receipts.findLast((receipt) => receipt.resolution?.approved === true);
}

/**
 * What this step has changed since its last approved review — or since it
 * started, if there has not been one.
 *
 * This is the quantity the budget is measured against, and it is what makes the
 * budget mean "review every N files" rather than "you get N files per step,
 * ever". Being reviewed buys a fresh allowance; it does not raise the ceiling.
 */
export function tallySinceReview(step: StepState): { files: string[]; lines: number } {
  const baseline = latestApprovedReceipt(step);
  if (!baseline) {
    return { files: [...new Set(step.changedFiles)], lines: step.changedLines };
  }

  // Files the human already saw do not count again; changing one of them
  // further still adds lines, which is why lines are a simple difference.
  const reviewed = new Set(baseline.files.map((file) => file.path));

  return {
    files: [...new Set(step.changedFiles)].filter((path) => !reviewed.has(path)),
    lines: Math.max(0, step.changedLines - baseline.changedLines),
  };
}

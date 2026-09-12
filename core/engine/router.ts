// The routing brain: which step runs, and when we stop for the human.
//
// Split deliberately into two halves with different powers:
//
//   `next()`   — a pure function of (state, workflow). It answers "what now?"
//                and changes nothing. Because it is pure, asking twice gives
//                the same answer, which is what makes it safe to call from a
//                hook, from the CLI, and from the conductor's loop without
//                coordinating them.
//
//   `applyReport()` — the only thing that advances the run. It mutates a state
//                draft and returns the events that describe what it did, so the
//                caller can write state and log in one transaction.
//
// Nothing here reads the filesystem. That keeps the decision logic testable as
// a table of inputs and outputs rather than as a fixture directory.

import { createHash } from "node:crypto";

import {
  DirectiveKind,
  type ArtifactRef,
  type Directive,
} from "../schemas/directive.ts";
import { EventType, type PiEventInput } from "../schemas/events.ts";
import {
  RunStatus,
  StepStatus,
  TERMINAL_STEP_STATUSES,
  newStepState,
  hasHumanPresence,
  pendingReceipt,
  type RunState,
  type StepState,
} from "../schemas/state.ts";
import {
  GatePolicy,
  evaluateWhen,
  type CompiledStep,
  type CompiledWorkflow,
} from "../schemas/workflow.ts";
import { artifactPath, type RunPaths } from "./paths.ts";

/** A move the run cannot make. Surfaced to the user, never worked around. */
export class RouterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
  }
}

export type RouterContext = {
  paths: RunPaths;
  /** Which artifacts exist on disk. Injected so the router stays pure. */
  artifactExists?: (path: string) => boolean;
};

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * Decide up front which steps apply to this project.
 *
 * Facts come from configuration and do not change during a run, so conditional
 * steps are resolved once at the start rather than re-evaluated on every
 * routing decision. A step that does not apply is recorded as skipped with its
 * reason, which keeps it visible in `pi status` instead of silently missing.
 */
export function planSteps(
  workflow: CompiledWorkflow,
  facts: Readonly<Record<string, boolean>>,
): Record<string, StepState> {
  const steps: Record<string, StepState> = {};

  for (const step of workflow.steps) {
    const state = newStepState(step.agent);
    if (!evaluateWhen(step.when, facts)) {
      state.status = StepStatus.Skipped;
      state.skipReason = `condition not met: ${step.when.join(", ")}`;
    }
    steps[step.id] = state;
  }

  return steps;
}

// ── next() ──────────────────────────────────────────────────────────────────

export function next(
  state: RunState,
  workflow: CompiledWorkflow,
  context: RouterContext,
): Directive {
  if (state.status === RunStatus.Failed) {
    return {
      kind: DirectiveKind.Error,
      message: "This run is marked failed. Start a new run or rewind to a checkpoint.",
    };
  }

  if (state.status === RunStatus.Abandoned) {
    return {
      kind: DirectiveKind.Error,
      message: "This run was abandoned. Start a new run if you want to continue.",
    };
  }

  const current = firstUnfinishedStep(state, workflow);
  if (!current) return doneDirective(state, workflow);

  const { step, stepState } = current;

  switch (stepState.status) {
    case StepStatus.AwaitingReview:
      return awaitReviewDirective(step, stepState);

    case StepStatus.AwaitingApproval:
      return awaitApprovalDirective(step, state, workflow, context);

    case StepStatus.Failed:
      return {
        kind: DirectiveKind.Error,
        step: step.id,
        message:
          `Step "${step.id}" failed: ${stepState.error ?? "no reason recorded"}. ` +
          "Fix the cause and rerun the step, or rewind to the previous checkpoint.",
      };

    default:
      return runStepDirective(step, stepState, state, workflow, context);
  }
}

/** The first step in workflow order that still has work left. */
function firstUnfinishedStep(
  state: RunState,
  workflow: CompiledWorkflow,
): { step: CompiledStep; stepState: StepState } | undefined {
  for (const step of workflow.steps) {
    const stepState = state.steps[step.id];
    if (!stepState) {
      throw new RouterError(
        "state-workflow-mismatch",
        `the workflow defines step "${step.id}" but this run has no record of it; ` +
          "the workflow changed after the run started",
      );
    }
    if (!TERMINAL_STEP_STATUSES.has(stepState.status)) {
      return { step, stepState };
    }
  }
  return undefined;
}

function runStepDirective(
  step: CompiledStep,
  stepState: StepState,
  state: RunState,
  workflow: CompiledWorkflow,
  context: RouterContext,
): Directive {
  const warnings: string[] = [];
  if (state.workflowDigest !== workflow.digest) {
    warnings.push(
      `The "${workflow.id}" workflow file changed after this run started. ` +
        "Steps already completed reflect the previous definition.",
    );
  }

  const attempt = stepState.attempt + 1;

  return {
    kind: DirectiveKind.RunStep,
    step: step.id,
    agent: step.agent,
    objective: step.objective,
    attempt,
    tools: step.tools,
    consumes: step.consumes.map((name) => resolveConsumed(name, workflow, context)),
    produces: step.produces.map((name) => ({
      name,
      path: artifactPath(context.paths, step.id, name),
      present: false,
    })),
    gate: step.gate,
    changeBudget: step.changeBudget,
    requireReviewBefore: step.requireReviewBefore,
    sensors: step.sensors,
    progress: progressOf(state, workflow, step),
    feedback: attempt > 1 ? stepState.error : undefined,
    warnings,
    narration:
      attempt > 1
        ? `Picking "${step.objective}" back up with your feedback.`
        : `Starting: ${step.objective}`,
  };
}

/**
 * Find where a consumed artifact lives, and say whether it is actually there.
 *
 * A missing input is reported rather than thrown: the producing step may have
 * been skipped by design, and the conductor is better placed than the router to
 * decide whether that is fatal for this particular step.
 */
function resolveConsumed(
  name: string,
  workflow: CompiledWorkflow,
  context: RouterContext,
): ArtifactRef {
  const producer = workflow.steps.find((step) => step.produces.includes(name));
  const path = producer
    ? artifactPath(context.paths, producer.id, name)
    : artifactPath(context.paths, "unknown", name);

  return {
    name,
    path,
    present: context.artifactExists ? context.artifactExists(path) : true,
  };
}

function awaitReviewDirective(step: CompiledStep, stepState: StepState): Directive {
  const receipt = pendingReceipt(stepState);

  if (!receipt) {
    return {
      kind: DirectiveKind.Error,
      step: step.id,
      message:
        `Step "${step.id}" is waiting on a review, but no review request is recorded. ` +
        "Run `pi review request` for this step, or report the step again.",
    };
  }

  return {
    kind: DirectiveKind.AwaitReview,
    step: step.id,
    receiptId: receipt.id,
    summary: receipt.summary,
    changedLines: receipt.changedLines,
    files: receipt.files.map((file) => `${file.action} ${file.path}`),
    narration: `Waiting on your review of ${receipt.files.length} file(s) before continuing.`,
  };
}

function awaitApprovalDirective(
  step: CompiledStep,
  state: RunState,
  workflow: CompiledWorkflow,
  context: RouterContext,
): Directive {
  const stepState = state.steps[step.id]!;

  return {
    kind: DirectiveKind.AwaitApproval,
    step: step.id,
    agent: step.agent,
    artifacts: stepState.artifacts.map((name) => ({
      name,
      path: artifactPath(context.paths, step.id, name),
      present: true,
    })),
    progress: progressOf(state, workflow, step),
    narration: `"${step.objective}" is done and ready for your approval.`,
  };
}

function doneDirective(state: RunState, workflow: CompiledWorkflow): Directive {
  const statuses = workflow.steps.map((step) => state.steps[step.id]?.status);
  const completed = statuses.filter((status) => status === StepStatus.Completed).length;
  const skipped = statuses.filter((status) => status === StepStatus.Skipped).length;

  return {
    kind: DirectiveKind.Done,
    summary:
      skipped > 0
        ? `Finished ${completed} step(s); ${skipped} did not apply to this project.`
        : `Finished all ${completed} step(s).`,
    completed,
    skipped,
  };
}

/** Progress counts only steps that will actually run. */
function progressOf(state: RunState, workflow: CompiledWorkflow, step: CompiledStep) {
  const applicable = workflow.steps.filter(
    (candidate) => state.steps[candidate.id]?.status !== StepStatus.Skipped,
  );

  return {
    index: applicable.findIndex((candidate) => candidate.id === step.id),
    total: Math.max(applicable.length, 1),
    completed: applicable.filter(
      (candidate) => state.steps[candidate.id]?.status === StepStatus.Completed,
    ).length,
  };
}

// ── report() ────────────────────────────────────────────────────────────────

export const StepResult = {
  /** The work is written; the gate decides what happens next. */
  Completed: "completed",
  /** Work is paused pending a human review of a proposed change. */
  NeedsReview: "needs-review",
  /** The human approved the step at its gate. */
  Approved: "approved",
  /** The human sent it back with feedback. */
  Rejected: "rejected",
  /** The step could not be completed. */
  Failed: "failed",
} as const;

export type StepResult = (typeof StepResult)[keyof typeof StepResult];

export type ReportInput = {
  step: string;
  result: StepResult;
  /** Artifacts produced, recorded for traceability. */
  artifacts?: string[];
  /** Required on rejection: what the human wants changed. */
  feedback?: string;
  error?: string;
  /**
   * The repository's commit at this moment, when it is a git repo.
   *
   * Supplied by the caller because the router does not touch the filesystem.
   * Recorded on the checkpoint so a rewind can tell you what the code looked
   * like at that boundary — pi moves its own state, never your working tree.
   */
  gitHead?: string;
};

/**
 * Advance the run. Mutates the draft and returns the events describing it, so
 * the caller writes state and log together.
 */
export function applyReport(
  draft: RunState,
  workflow: CompiledWorkflow,
  input: ReportInput,
  now: () => Date = () => new Date(),
): PiEventInput[] {
  const step = workflow.steps.find((candidate) => candidate.id === input.step);
  if (!step) {
    throw new RouterError("unknown-step", `no step "${input.step}" in workflow "${workflow.id}"`);
  }

  const stepState = draft.steps[step.id];
  if (!stepState) {
    throw new RouterError(
      "state-workflow-mismatch",
      `this run has no record of step "${step.id}"`,
    );
  }

  const timestamp = now().toISOString();
  const events: PiEventInput[] = [];

  switch (input.result) {
    case StepResult.Completed:
      return completeStep(draft, workflow, step, stepState, input, timestamp, events);

    case StepResult.NeedsReview:
      requireStatus(stepState, step.id, [StepStatus.Pending, StepStatus.Active]);
      stepState.status = StepStatus.AwaitingReview;
      events.push({ type: EventType.GateOpened, step: step.id, kind: "review" });
      return events;

    case StepResult.Approved:
      return approveStep(draft, workflow, step, stepState, timestamp, events, input.gitHead);

    case StepResult.Rejected:
      return rejectStep(draft, step, stepState, input, timestamp, events);

    case StepResult.Failed:
      stepState.status = StepStatus.Failed;
      stepState.error = input.error ?? "no reason recorded";
      draft.status = RunStatus.Failed;
      events.push({ type: EventType.StepFailed, step: step.id, error: stepState.error });
      events.push({ type: EventType.RunFailed, error: `step "${step.id}" failed` });
      return events;
  }
}

function completeStep(
  draft: RunState,
  workflow: CompiledWorkflow,
  step: CompiledStep,
  stepState: StepState,
  input: ReportInput,
  timestamp: string,
  events: PiEventInput[],
): PiEventInput[] {
  // Reporting the same outcome twice is a no-op rather than an error: the
  // conductor's loop can be interrupted between the report and the next call,
  // and a retry must not be punished.
  if (stepState.status === StepStatus.Completed) return events;
  if (stepState.status === StepStatus.AwaitingApproval) return events;

  requireStatus(stepState, step.id, [
    StepStatus.Pending,
    StepStatus.Active,
    StepStatus.AwaitingReview,
  ]);

  stepState.artifacts = input.artifacts ?? stepState.artifacts;
  stepState.startedAt ??= timestamp;

  if (step.gate === GatePolicy.Approval) {
    stepState.status = StepStatus.AwaitingApproval;
    events.push({ type: EventType.GateOpened, step: step.id, kind: "approval" });
    return events;
  }

  finishStep(draft, workflow, step, stepState, timestamp, events, input.gitHead);
  return events;
}

/**
 * Mark a step as started.
 *
 * Kept separate from `next()` so that function can stay pure: a guard hook asks
 * what the current step is without that question itself starting one. The CLI
 * applies this when it hands a `run-step` directive to the conductor.
 */
export function markStepStarted(
  draft: RunState,
  stepId: string,
  now: () => Date = () => new Date(),
): PiEventInput[] {
  const stepState = draft.steps[stepId];
  if (!stepState) {
    throw new RouterError("state-workflow-mismatch", `this run has no record of step "${stepId}"`);
  }

  if (stepState.status !== StepStatus.Pending) return [];

  stepState.status = StepStatus.Active;
  stepState.startedAt ??= now().toISOString();
  draft.currentStep = stepId;

  return [
    { type: EventType.AgentActivated, agent: stepState.agent, step: stepId },
    {
      type: EventType.StepStarted,
      step: stepId,
      agent: stepState.agent,
      attempt: stepState.attempt + 1,
    },
  ];
}

function approveStep(
  draft: RunState,
  workflow: CompiledWorkflow,
  step: CompiledStep,
  stepState: StepState,
  timestamp: string,
  events: PiEventInput[],
  gitHead?: string,
): PiEventInput[] {
  if (stepState.status === StepStatus.Completed) return events;

  requireStatus(stepState, step.id, [StepStatus.AwaitingApproval]);

  // The presence rule. An unattended run mints no human turn, so it cannot
  // approve its own work — this is the check that makes that true.
  if (!hasHumanPresence(draft)) {
    throw new RouterError(
      "no-human-presence",
      `step "${step.id}" cannot be approved: no human has acted since the last gate. ` +
        "Approval gates require an interactive session.",
    );
  }

  draft.lastGateResolvedAt = timestamp;
  events.push({
    type: EventType.GateResolved,
    step: step.id,
    kind: "approval",
    outcome: "approved",
  });
  finishStep(draft, workflow, step, stepState, timestamp, events, gitHead);
  return events;
}

function rejectStep(
  draft: RunState,
  step: CompiledStep,
  stepState: StepState,
  input: ReportInput,
  timestamp: string,
  events: PiEventInput[],
): PiEventInput[] {
  requireStatus(stepState, step.id, [StepStatus.AwaitingApproval, StepStatus.AwaitingReview]);

  if (!input.feedback || input.feedback.trim() === "") {
    throw new RouterError(
      "missing-feedback",
      `rejecting step "${step.id}" needs feedback saying what should change`,
    );
  }

  stepState.status = StepStatus.Active;
  stepState.attempt += 1;
  stepState.error = input.feedback;
  draft.lastGateResolvedAt = timestamp;

  events.push({
    type: EventType.GateResolved,
    step: step.id,
    kind: "approval",
    outcome: "revised",
  });
  return events;
}

function finishStep(
  draft: RunState,
  workflow: CompiledWorkflow,
  step: CompiledStep,
  stepState: StepState,
  timestamp: string,
  events: PiEventInput[],
  gitHead?: string,
): void {
  stepState.status = StepStatus.Completed;
  stepState.completedAt = timestamp;
  stepState.startedAt ??= timestamp;

  events.push({
    type: EventType.StepCompleted,
    step: step.id,
    agent: step.agent,
    artifacts: stepState.artifacts,
  });

  if (step.checkpoint) {
    const digest = boundaryDigest(draft, step.id);

    draft.checkpoints.push({
      step: step.id,
      at: timestamp,
      digest,
      artifacts: stepState.artifacts,
      ...(gitHead ? { gitHead } : {}),
    });
    events.push({ type: EventType.CheckpointSaved, step: step.id, digest });
  }

  advanceCursor(draft, workflow);
}

/**
 * Fingerprint of a run boundary: which step just finished, everything finished
 * before it, and what they produced.
 *
 * Deliberately not a digest of the whole state. The checkpoint entry lives
 * inside the state it would be describing, so hashing all of it cannot be done
 * without hashing the hash. This covers what a rewind actually needs to verify:
 * that a snapshot on disk is the boundary its index entry claims.
 */
export function boundaryDigest(state: RunState, stepId: string): string {
  const finished = Object.entries(state.steps)
    .filter(([, step]) => TERMINAL_STEP_STATUSES.has(step.status))
    .map(([id, step]) => `${id}:${step.status}:${[...step.artifacts].sort().join("|")}`)
    .sort();

  const canonical = JSON.stringify({ runId: state.runId, step: stepId, finished });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Point `currentStep` at the next step with work left, or null when finished.
 *
 * Order comes from the workflow, never from the state object's key order — the
 * two agree today, and relying on that would be a quiet bug the first time they
 * stop agreeing.
 */
function advanceCursor(draft: RunState, workflow: CompiledWorkflow): void {
  const remaining = workflow.steps.filter((step) => {
    const status = draft.steps[step.id]?.status;
    return status !== undefined && !TERMINAL_STEP_STATUSES.has(status);
  });

  draft.currentStep = remaining[0]?.id ?? null;

  if (remaining.length === 0) {
    draft.status = RunStatus.Completed;
  }
}

function requireStatus(
  stepState: StepState,
  stepId: string,
  allowed: readonly StepStatus[],
): void {
  if (allowed.includes(stepState.status)) return;

  throw new RouterError(
    "illegal-transition",
    `step "${stepId}" is ${stepState.status}; expected one of ${allowed.join(", ")}`,
  );
}

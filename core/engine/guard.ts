// The guard: may this tool call proceed?
//
// This is where the framework stops being advice. Everything else tells the
// model what it should do; the guard is consulted before each tool call and can
// answer no. The host harness wires it to its pre-tool-use hook, so a refusal
// is a refusal rather than a suggestion the model may talk itself out of.
//
// `evaluate` is pure. A hook fires on every tool call, and a decision function
// that mutated state would make the run's history depend on how many times the
// model happened to reach for a tool.

import { ToolName, effectiveTools, type AgentSpec } from "../schemas/agent.ts";
import { EventType, type PiEventInput } from "../schemas/events.ts";
import {
  RunStatus,
  StepStatus,
  latestApprovedReceipt,
  tallySinceReview,
  type RunState,
  type StepState,
} from "../schemas/state.ts";
import type { ChangeBudget, CompiledStep, CompiledWorkflow } from "../schemas/workflow.ts";

export const Permission = {
  Allow: "allow",
  Deny: "deny",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/**
 * Why a call was refused. Carried on the event so `pi log` can answer "why did
 * it stop" without anyone re-deriving it from the state at the time.
 */
export const DenialReason = {
  RunNotActive: "run-not-active",
  NoActiveStep: "no-active-step",
  StepNotRunning: "step-not-running",
  ToolNotGranted: "tool-not-granted",
  ToolDeniedByPersona: "tool-denied-by-persona",
  ReviewRequired: "review-required",
  ReviewPending: "review-pending",
  OverBudget: "over-budget",
} as const;

export type DenialReason = (typeof DenialReason)[keyof typeof DenialReason];

/** Which guard owns each refusal, so the log groups them usefully. */
const GUARD_OF: Record<DenialReason, string> = {
  [DenialReason.RunNotActive]: "run-state",
  [DenialReason.NoActiveStep]: "run-state",
  [DenialReason.StepNotRunning]: "run-state",
  [DenialReason.ToolNotGranted]: "tool-grant",
  [DenialReason.ToolDeniedByPersona]: "tool-grant",
  [DenialReason.ReviewRequired]: "review",
  [DenialReason.ReviewPending]: "review",
  [DenialReason.OverBudget]: "change-budget",
};

/** A tool call as the host is about to make it. */
export type ToolCall = {
  /** A pi tool id. The harness adapter maps the host's own tool names onto these. */
  tool: string;
  /** Repository paths the call would touch. Empty for a read. */
  files?: readonly string[];
  /** Lines the call would add or remove. */
  lines?: number;
};

export type Verdict =
  | { permission: typeof Permission.Allow }
  | {
      permission: typeof Permission.Deny;
      reason: DenialReason;
      /** Written for the model: what happened and what to do about it. */
      message: string;
    };

export type GuardContext = {
  /** The persona on the current step, when the roster is available. */
  agent?: AgentSpec;
};

/** Tools that only read. They stay available even when the run is between steps. */
const READ_ONLY: ReadonlySet<string> = new Set([ToolName.Read, ToolName.Search]);

const ALLOW: Verdict = { permission: Permission.Allow };

function deny(reason: DenialReason, message: string): Verdict {
  return { permission: Permission.Deny, reason, message };
}

export function evaluate(
  state: RunState,
  workflow: CompiledWorkflow,
  call: ToolCall,
  context: GuardContext = {},
): Verdict {
  const readOnly = READ_ONLY.has(call.tool);

  // Reading is always safe, and blocking it would leave the model unable to
  // even orient itself enough to fix whatever is wrong.
  if (readOnly) return ALLOW;

  // A completed run has nothing left to protect: no step is active, no budget
  // is in force, and the next `pi start` re-engages the guard. Refusing here
  // made finishing successfully indistinguishable from being stuck, and no verb
  // a model can reach gets it out — `start` and `rewind` are both deliberately
  // outside the harness control plane.
  //
  // `failed` and `parked` still refuse, for their own reasons: a failed run's
  // plan turned out to be wrong, and a parked run still has work pending.
  if (state.status === RunStatus.Completed) return ALLOW;

  if (state.status !== RunStatus.Active) {
    return deny(
      DenialReason.RunNotActive,
      `This run is ${state.status}, so it is not accepting changes. ` +
        `Run \`pi status\` to see where it stopped.`,
    );
  }

  if (state.currentStep === null) {
    return deny(
      DenialReason.NoActiveStep,
      `No step is active, so there is nothing this change belongs to. ` +
        `Run \`pi next\` to be given one.`,
    );
  }

  const step = workflow.steps.find((candidate) => candidate.id === state.currentStep);
  const stepState = state.steps[state.currentStep];

  if (!step || !stepState) {
    return deny(
      DenialReason.NoActiveStep,
      `This run's current step ("${state.currentStep}") is not in workflow ` +
        `"${workflow.id}". Run \`pi doctor\`.`,
    );
  }

  return (
    checkStepRunning(step, stepState) ??
    checkToolGranted(step, stepState, call, context) ??
    checkReviewRequired(step, stepState, call) ??
    checkBudget(step, stepState, call) ??
    ALLOW
  );
}

function checkStepRunning(step: CompiledStep, stepState: StepState): Verdict | null {
  if (stepState.status === StepStatus.Active) return null;

  if (stepState.status === StepStatus.AwaitingReview) {
    return deny(
      DenialReason.ReviewPending,
      `Step "${step.id}" is waiting on your review. Nothing more may be changed ` +
        `until it is answered, otherwise the review would be of code that has ` +
        `already moved on. Resolve it with \`pi review resolve --approve\` or ` +
        `\`--reject --feedback "..."\`.`,
    );
  }

  return deny(
    DenialReason.StepNotRunning,
    `Step "${step.id}" is ${stepState.status}, not running, so it may not make ` +
      `changes. Run \`pi next\` to see what the run is waiting for.`,
  );
}

function checkToolGranted(
  step: CompiledStep,
  stepState: StepState,
  call: ToolCall,
  context: GuardContext,
): Verdict | null {
  if (!step.tools.includes(call.tool)) {
    return deny(
      DenialReason.ToolNotGranted,
      `Step "${step.id}" does not grant \`${call.tool}\`. It grants: ` +
        `${step.tools.join(", ") || "(nothing)"}. If this step genuinely needs ` +
        `that tool, that is a workflow change, not something to work around.`,
    );
  }

  // The persona is the ceiling even when a step's grant is stale — for example
  // a project persona that revoked a tool the shipped workflow still lists.
  if (context.agent && !effectiveTools(context.agent, step.tools).includes(call.tool)) {
    return deny(
      DenialReason.ToolDeniedByPersona,
      `The ${stepState.agent} persona does not use \`${call.tool}\`. That work ` +
        `belongs to a different role and a different step.`,
    );
  }

  return null;
}

function checkReviewRequired(
  step: CompiledStep,
  stepState: StepState,
  call: ToolCall,
): Verdict | null {
  if (!step.requireReviewBefore.includes(call.tool)) return null;
  if (latestApprovedReceipt(stepState)) return null;

  return deny(
    DenialReason.ReviewRequired,
    `Step "${step.id}" requires review before its first \`${call.tool}\` call. ` +
      `Describe what you are about to change and why, then wait for an answer:\n\n` +
      `  pi review request --summary "<what and why>" --files <paths> --lines <n>`,
  );
}

function checkBudget(
  step: CompiledStep,
  stepState: StepState,
  call: ToolCall,
): Verdict | null {
  const budget = step.changeBudget;
  if (!budget) return null;

  const projected = project(stepState, call);

  const overFiles = projected.files > budget.maxFiles;
  const overLines = projected.lines > budget.maxLines;
  if (!overFiles && !overLines) return null;

  return deny(
    DenialReason.OverBudget,
    describeOverBudget(step, budget, projected, overFiles, overLines),
  );
}

/** What the tally would be if this call went through. */
function project(stepState: StepState, call: ToolCall): { files: number; lines: number } {
  const sinceReview = tallySinceReview(stepState);
  const files = new Set(sinceReview.files);
  for (const file of call.files ?? []) files.add(file);

  return { files: files.size, lines: sinceReview.lines + (call.lines ?? 0) };
}

function describeOverBudget(
  step: CompiledStep,
  budget: ChangeBudget,
  projected: { files: number; lines: number },
  overFiles: boolean,
  overLines: boolean,
): string {
  const exceeded = [
    overFiles ? `${projected.files} files against a limit of ${budget.maxFiles}` : null,
    overLines ? `${projected.lines} lines against a limit of ${budget.maxLines}` : null,
  ].filter(Boolean);

  return (
    `This change would put step "${step.id}" at ${exceeded.join(" and ")}.\n\n` +
    `The limit exists so that changes arrive in pieces a person can actually ` +
    `read. Stop here, summarize what you have done so far, and ask for review:\n\n` +
    `  pi review request --summary "<what you changed and why>" --files <paths> --lines <n>\n\n` +
    `Once it is approved the budget starts fresh and you can continue. Do not ` +
    `split the same change across smaller calls to get under the limit — the ` +
    `tally is cumulative, so that does not work and is not the point.`
  );
}

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * Record a change that actually happened. The host calls this after the tool
 * ran, so the tally reflects work done rather than work merely proposed.
 */
export function recordChange(draft: RunState, call: ToolCall): void {
  const stepId = draft.currentStep;
  if (stepId === null) return;

  const stepState = draft.steps[stepId];
  if (!stepState) return;

  // Files are a set: rewriting one file five times is one file against
  // `maxFiles`, which is what a reviewer actually cares about. Lines stay
  // cumulative, because churn is churn.
  for (const file of call.files ?? []) {
    if (!stepState.changedFiles.includes(file)) stepState.changedFiles.push(file);
  }
  stepState.changedLines += call.lines ?? 0;
}

/** Record a refusal, so the log can answer "why did it stop". */
export function denialEvent(
  call: ToolCall,
  verdict: Verdict,
  step: string | null,
): PiEventInput[] {
  if (verdict.permission === Permission.Allow) return [];

  return [
    {
      type: EventType.GuardBlocked,
      guard: GUARD_OF[verdict.reason],
      tool: call.tool,
      reason: verdict.reason,
      ...(step ? { step } : {}),
    },
  ];
}

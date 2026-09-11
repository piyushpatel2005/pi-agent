// What the engine tells the conductor to do.
//
// `pi engine next` prints exactly one of these as JSON. The conductor (the
// model, running inside Cursor) reads it, performs that single move, reports
// the outcome, and asks again. It never decides the order itself — which is the
// difference between a workflow and a suggestion.

import { z } from "zod";

import { ChangeBudget, GatePolicy } from "./workflow.ts";

export const DirectiveKind = {
  /** Do this step, as this persona, with these tools. */
  RunStep: "run-step",
  /** A review is outstanding; stop and wait for the human. */
  AwaitReview: "await-review",
  /** The step's gate is open; present it and wait for the human. */
  AwaitApproval: "await-approval",
  /** Nothing left to do. */
  Done: "done",
  /** Something is wrong that the conductor must not try to work around. */
  Error: "error",
} as const;

export type DirectiveKind = (typeof DirectiveKind)[keyof typeof DirectiveKind];

/** An artifact with its resolved location, so the conductor never joins paths. */
export const ArtifactRef = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  /** False for a consumed artifact whose producing step was skipped. */
  present: z.boolean(),
});

export type ArtifactRef = z.infer<typeof ArtifactRef>;

const progress = z.object({
  index: z.number().int().nonnegative(),
  /** Steps that will actually run, so a skipped step is not counted against you. */
  total: z.number().int().positive(),
  completed: z.number().int().nonnegative(),
});

export const Directive = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(DirectiveKind.RunStep),
    step: z.string().min(1),
    agent: z.string().min(1),
    objective: z.string(),
    attempt: z.number().int().positive(),
    tools: z.array(z.string()),
    consumes: z.array(ArtifactRef),
    produces: z.array(ArtifactRef),
    gate: z.enum(Object.values(GatePolicy) as [GatePolicy, ...GatePolicy[]]),
    changeBudget: ChangeBudget.optional(),
    requireReviewBefore: z.array(z.string()),
    sensors: z.array(z.string()),
    progress,
    /** Feedback from a rejected attempt, so a retry knows what to fix. */
    feedback: z.string().optional(),
    /** Advisory notices, e.g. the workflow file changed mid-run. */
    warnings: z.array(z.string()).default([]),
    /** Pre-worded sentence for the user; absent means say nothing. */
    narration: z.string().optional(),
  }),

  z.object({
    kind: z.literal(DirectiveKind.AwaitReview),
    step: z.string().min(1),
    receiptId: z.string().min(1),
    summary: z.string(),
    changedLines: z.number().int().nonnegative(),
    files: z.array(z.string()),
    narration: z.string(),
  }),

  z.object({
    kind: z.literal(DirectiveKind.AwaitApproval),
    step: z.string().min(1),
    agent: z.string().min(1),
    artifacts: z.array(ArtifactRef),
    progress,
    narration: z.string(),
  }),

  z.object({
    kind: z.literal(DirectiveKind.Done),
    summary: z.string(),
    completed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),

  z.object({
    kind: z.literal(DirectiveKind.Error),
    /** Printed verbatim. The conductor must not paraphrase or retry past it. */
    message: z.string().min(1),
    step: z.string().optional(),
  }),
]);

export type Directive = z.infer<typeof Directive>;
export type DirectiveOf<K extends DirectiveKind> = Extract<Directive, { kind: K }>;
export type RunStepDirective = DirectiveOf<typeof DirectiveKind.RunStep>;

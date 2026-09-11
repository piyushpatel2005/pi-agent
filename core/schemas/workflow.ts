// A workflow is data, not code.
//
// It names an ordered list of steps; each step binds one persona to an
// objective, the artifacts it reads and writes, the tools it may use, and how
// much it is allowed to change before a human looks. Adding a step, reordering
// the flow, or tightening a budget is a JSON edit — no engine change.
//
// The shapes here are the authoring surface. `core/engine/compile.ts` turns an
// authored spec into a compiled workflow the router can execute, applying
// defaults and refusing a spec whose wiring cannot work.

import { z } from "zod";

/**
 * The closed set of booleans a `when` condition may test.
 *
 * Deliberately not arbitrary expressions. A workflow author can say "only when
 * there is a frontend", but cannot embed logic the engine is unable to explain
 * back to the user. Adding a fact is a deliberate code change, which is the
 * point: routing stays predictable.
 */
export const WorkflowFact = {
  HasFrontend: "hasFrontend",
  HasBackend: "hasBackend",
  NeedsInfra: "needsInfra",
  IsBrownfield: "isBrownfield",
} as const;

export type WorkflowFact = (typeof WorkflowFact)[keyof typeof WorkflowFact];

export const WORKFLOW_FACTS: readonly WorkflowFact[] = Object.values(WorkflowFact);

/**
 * One `when` entry: a fact name, optionally negated with a leading `!`.
 * A step's conditions are ANDed — all must hold for the step to run.
 */
export const WhenCondition = z
  .string()
  .min(1)
  .superRefine((raw, ctx) => {
    const { fact } = stripNegation(raw);
    if (WORKFLOW_FACTS.includes(fact as WorkflowFact)) return;
    ctx.addIssue({
      code: "custom",
      message: `unknown fact "${fact}"; known facts: ${WORKFLOW_FACTS.join(", ")}`,
    });
  });

export type WhenCondition = z.infer<typeof WhenCondition>;

function stripNegation(raw: string): { fact: string; negated: boolean } {
  return raw.startsWith("!")
    ? { fact: raw.slice(1), negated: true }
    : { fact: raw, negated: false };
}

/** Does this step run, given what we know about the project? */
export function evaluateWhen(
  conditions: readonly string[],
  facts: Readonly<Record<string, boolean>>,
): boolean {
  return conditions.every((raw) => {
    const { fact, negated } = stripNegation(raw);
    const value = facts[fact] ?? false;
    return negated ? !value : value;
  });
}

/**
 * How much a step may change before a human has to look.
 *
 * This is the lever behind "review smaller changes": the budget guard tallies
 * what the step has written and refuses the call that would exceed it, naming
 * `pi review request` as the way forward.
 */
export const ChangeBudget = z.object({
  maxFiles: z.number().int().positive(),
  maxLines: z.number().int().positive(),
});

export type ChangeBudget = z.infer<typeof ChangeBudget>;

/** What happens at the end of a step. */
export const GatePolicy = {
  /** Stop and ask the human to approve before advancing. */
  Approval: "approval",
  /** Advance automatically. */
  None: "none",
} as const;

export type GatePolicy = (typeof GatePolicy)[keyof typeof GatePolicy];

const gatePolicy = z.enum(Object.values(GatePolicy) as [GatePolicy, ...GatePolicy[]]);

/**
 * Artifact names are logical, not paths. A step declares `produces:
 * ["requirements.md"]` and the engine resolves where that lives under the run
 * directory, so a workflow never hard-codes layout.
 */
const artifactName = z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/, {
  message: "artifact names are lowercase kebab/dot, e.g. api-contract.md",
});

const identifier = z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, {
  message: "ids are lowercase kebab-case, e.g. backend-implementation",
});

export const StepSpec = z.object({
  id: identifier,

  /**
   * The persona that leads this step. Validated against the live roster at
   * compile time rather than against a hard-coded enum here, so adding a
   * persona stays a matter of dropping in a file.
   */
  agent: identifier,

  /** What this step is for, in the author's words. Shown to the human and the model. */
  objective: z.string().min(1),

  /** Artifacts this step reads. Each must be produced by an earlier step. */
  consumes: z.array(artifactName).default([]),

  /** Artifacts this step writes. Each must be produced by exactly one step. */
  produces: z.array(artifactName).default([]),

  /** Tool ids this step may use. Anything not listed is denied by the guards. */
  tools: z.array(identifier).default([]),

  /** All conditions must hold for this step to run; otherwise it is skipped. */
  when: z.array(WhenCondition).default([]),

  gate: gatePolicy.optional(),
  checkpoint: z.boolean().optional(),
  changeBudget: ChangeBudget.optional(),

  /**
   * Tools that may not be used until a human has approved a review for this
   * step. Use it to force a plan-then-write rhythm on code-writing steps
   * instead of waiting for the budget to be hit.
   */
  requireReviewBefore: z.array(identifier).default([]),

  /** Advisory deterministic checks run when this step's artifacts land. */
  sensors: z.array(identifier).default([]),
});

export type StepSpec = z.infer<typeof StepSpec>;

/** Values inherited by any step that does not set them. */
export const WorkflowDefaults = z.object({
  gate: gatePolicy.default(GatePolicy.Approval),
  checkpoint: z.boolean().default(true),
  changeBudget: ChangeBudget.optional(),
});

export type WorkflowDefaults = z.infer<typeof WorkflowDefaults>;

export const WorkflowSpec = z.object({
  id: identifier,
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().default(""),
  // `prefault` rather than `default` so an omitted block still flows through
  // WorkflowDefaults and picks up its per-field defaults.
  defaults: WorkflowDefaults.prefault({}),
  steps: z.array(StepSpec).min(1),
});

export type WorkflowSpec = z.infer<typeof WorkflowSpec>;

/**
 * A step with every default resolved. The router only ever sees these, so it
 * never has to reason about which values were inherited.
 */
export const CompiledStep = StepSpec.extend({
  gate: gatePolicy,
  checkpoint: z.boolean(),
  /** Position in the workflow, so the router never re-derives order. */
  index: z.number().int().nonnegative(),
});

export type CompiledStep = z.infer<typeof CompiledStep>;

export const CompiledWorkflow = z.object({
  id: identifier,
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string(),
  steps: z.array(CompiledStep).min(1),
  /** Digest of the authored spec, recorded on the run to detect later drift. */
  digest: z.string().min(1),
});

export type CompiledWorkflow = z.infer<typeof CompiledWorkflow>;

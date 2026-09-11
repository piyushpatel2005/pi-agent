// Turn an authored workflow into one the router can execute.
//
// Compiling does two things: it resolves defaults so the router never reasons
// about inheritance, and it refuses a workflow whose wiring cannot work. The
// second is the valuable half. A step that consumes an artifact nobody produces
// will fail halfway through a run, after the human has already spent attention
// on the steps before it. Catching it at compile time costs nothing.

import { createHash } from "node:crypto";

import {
  CompiledWorkflow,
  WorkflowSpec,
  type CompiledStep,
  type StepSpec,
} from "../schemas/workflow.ts";

export type IssueSeverity = "error" | "warning";

export type WorkflowIssue = {
  severity: IssueSeverity;
  /** Where the problem is, e.g. `steps[2].consumes[0]`. */
  path: string;
  message: string;
};

export type CompileResult =
  | { ok: true; workflow: CompiledWorkflow; warnings: WorkflowIssue[] }
  | { ok: false; issues: WorkflowIssue[] };

/** Cross-document checks need a roster; callers that have one pass it in. */
export type CompileContext = {
  /** Known persona ids. Omit to skip the check (useful before the roster loads). */
  agents?: readonly string[];
  /** Known tool ids. Omit to skip the check. */
  tools?: readonly string[];
  /**
   * What each persona is allowed to hold, by id. A step may grant a subset;
   * granting more is an error, so a workflow cannot widen a role's reach.
   */
  agentTools?: Readonly<Record<string, readonly string[]>>;
};

export function compileWorkflow(
  input: unknown,
  context: CompileContext = {},
): CompileResult {
  const parsed = WorkflowSpec.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        severity: "error" as const,
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const spec = parsed.data;
  const issues: WorkflowIssue[] = [];

  checkUniqueStepIds(spec, issues);
  checkArtifactWiring(spec, issues);
  checkReviewGrants(spec, issues);
  checkRosterReferences(spec, context, issues);

  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) return { ok: false, issues };

  const steps: CompiledStep[] = spec.steps.map((step, index) => ({
    ...step,
    index,
    gate: step.gate ?? spec.defaults.gate,
    checkpoint: step.checkpoint ?? spec.defaults.checkpoint,
    changeBudget: step.changeBudget ?? spec.defaults.changeBudget,
  }));

  const workflow = CompiledWorkflow.parse({
    id: spec.id,
    name: spec.name,
    version: spec.version,
    description: spec.description,
    steps,
    digest: digestOf(spec),
  });

  return { ok: true, workflow, warnings: issues };
}

/** Stable digest of the authored spec, used to detect mid-run workflow drift. */
export function digestOf(spec: WorkflowSpec): string {
  return `sha256:${createHash("sha256").update(stableStringify(spec)).digest("hex")}`;
}

// ── Checks ──────────────────────────────────────────────────────────────────

function checkUniqueStepIds(spec: WorkflowSpec, issues: WorkflowIssue[]): void {
  const seen = new Set<string>();
  spec.steps.forEach((step, index) => {
    if (seen.has(step.id)) {
      issues.push({
        severity: "error",
        path: `steps[${index}].id`,
        message: `duplicate step id "${step.id}"`,
      });
    }
    seen.add(step.id);
  });
}

/**
 * Every consumed artifact must be produced by exactly one earlier step, and the
 * consumer must run whenever the producer does.
 *
 * The condition check is the subtle one. If `ux-design.md` is only produced
 * `when: ["hasFrontend"]`, then an unconditional step consuming it breaks on
 * any backend-only project. Requiring the producer's conditions to be a subset
 * of the consumer's makes that impossible to author by accident.
 */
function checkArtifactWiring(spec: WorkflowSpec, issues: WorkflowIssue[]): void {
  const producers = new Map<string, StepSpec & { index: number }>();

  spec.steps.forEach((step, index) => {
    for (const [slot, artifact] of step.produces.entries()) {
      const existing = producers.get(artifact);
      if (existing) {
        issues.push({
          severity: "error",
          path: `steps[${index}].produces[${slot}]`,
          message:
            `"${artifact}" is also produced by step "${existing.id}"; ` +
            "two producers make its provenance ambiguous",
        });
        continue;
      }
      producers.set(artifact, { ...step, index });
    }
  });

  spec.steps.forEach((step, index) => {
    for (const [slot, artifact] of step.consumes.entries()) {
      const path = `steps[${index}].consumes[${slot}]`;
      const producer = producers.get(artifact);

      if (!producer) {
        issues.push({
          severity: "error",
          path,
          message: `"${artifact}" is consumed but never produced`,
        });
        continue;
      }

      if (producer.index >= index) {
        issues.push({
          severity: "error",
          path,
          message:
            `"${artifact}" is produced later, by step "${producer.id}"; ` +
            "a step cannot consume an artifact from its own future",
        });
        continue;
      }

      const unguarded = producer.when.filter((cond) => !step.when.includes(cond));
      if (unguarded.length > 0) {
        issues.push({
          severity: "error",
          path,
          message:
            `"${artifact}" is only produced when [${producer.when.join(", ")}], ` +
            `but step "${step.id}" does not share ${unguarded.map((c) => `"${c}"`).join(", ")}; ` +
            "it would run with a missing input",
        });
      }
    }
  });
}

/** A step cannot gate a tool it was never granted — that is a silent no-op. */
function checkReviewGrants(spec: WorkflowSpec, issues: WorkflowIssue[]): void {
  spec.steps.forEach((step, index) => {
    for (const [slot, tool] of step.requireReviewBefore.entries()) {
      if (!step.tools.includes(tool)) {
        issues.push({
          severity: "error",
          path: `steps[${index}].requireReviewBefore[${slot}]`,
          message:
            `"${tool}" is gated behind review but not granted to step "${step.id}", ` +
            "so the gate would never fire",
        });
      }
    }
  });
}

function checkRosterReferences(
  spec: WorkflowSpec,
  context: CompileContext,
  issues: WorkflowIssue[],
): void {
  spec.steps.forEach((step, index) => {
    if (context.agents && !context.agents.includes(step.agent)) {
      issues.push({
        severity: "error",
        path: `steps[${index}].agent`,
        message: `unknown agent "${step.agent}"${suggest(step.agent, context.agents)}`,
      });
    }

    if (context.tools) {
      for (const [slot, tool] of step.tools.entries()) {
        if (!context.tools.includes(tool)) {
          issues.push({
            severity: "error",
            path: `steps[${index}].tools[${slot}]`,
            message: `unknown tool "${tool}"${suggest(tool, context.tools)}`,
          });
        }
      }
    }

    // The persona is the ceiling. A step may narrow it but never widen it,
    // otherwise "this role cannot write code" is only true until a workflow
    // says otherwise.
    const ceiling = context.agentTools?.[step.agent];
    if (!ceiling) return;

    for (const [slot, tool] of step.tools.entries()) {
      if (!ceiling.includes(tool)) {
        issues.push({
          severity: "error",
          path: `steps[${index}].tools[${slot}]`,
          message:
            `"${step.agent}" may not use "${tool}". That persona grants: ` +
            `${ceiling.join(", ") || "(nothing)"}.`,
        });
      }
    }
  });
}

/** "did you mean" for the common case: a near-miss on a known id. */
function suggest(value: string, known: readonly string[]): string {
  const near = known.filter(
    (candidate) => candidate.startsWith(value.slice(0, 4)) || value.startsWith(candidate.slice(0, 4)),
  );
  return near.length > 0 ? `; did you mean ${near.map((n) => `"${n}"`).join(" or ")}?` : "";
}

/** Key-sorted JSON, so an irrelevant reordering does not change the digest. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// The seven personas.
//
// A persona is a Markdown file: Zod-validated frontmatter declaring who it is
// and what it may touch, then a body that is the operating instruction handed
// to the model when a step activates that role.
//
// Keeping the roster small is deliberate. Every handoff between roles loses
// context, so seven broad personas beat twenty narrow ones — a backend
// developer who also writes their own migrations is better than a pair who
// have to explain the schema to each other.

import { z } from "zod";

import { ChangeBudget } from "./workflow.ts";

/**
 * Every tool a step may be granted.
 *
 * A closed set so that a typo in a workflow is a compile error rather than a
 * silently ungranted capability discovered halfway through a run.
 */
export const ToolName = {
  /** Read a file from the repository or a prior step's artifact. */
  Read: "read",
  /** Search the repository. */
  Search: "search",
  /** Ask the human a question and wait for the answer. */
  AskUser: "ask-user",
  /** Write one of the step's declared artifacts. */
  WriteArtifact: "write-artifact",
  /** Modify repository source. Subject to the change budget. */
  WriteCode: "write-code",
  /** Run a shell command. */
  RunCommand: "run-command",
  /** Stop and ask the human to review a specific diff before continuing. */
  RequestReview: "request-review",
  /**
   * Spawn a nested agent. Never granted to a persona: only the conductor
   * dispatches, so a worker cannot quietly become an orchestrator and bury a
   * decision one level deeper than the log can see.
   */
  Delegate: "delegate",
} as const;

export type ToolName = (typeof ToolName)[keyof typeof ToolName];

export const TOOL_NAMES: readonly ToolName[] = Object.values(ToolName);

/** Tools no persona may hold, whatever a workflow asks for. */
export const ALWAYS_DENIED: readonly ToolName[] = [ToolName.Delegate];

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "must be lower-case kebab-case");

export const AgentSpec = z.object({
  id: identifier,
  name: z.string().min(1),

  /** One sentence: what this role owns. Shown by `pi agents`. */
  description: z.string().min(1),

  /**
   * The persona's ceiling. A workflow step grants tools from this set; a step
   * asking for more is a compile error, so a workflow cannot widen a role's
   * reach by asking nicely.
   */
  tools: z.array(z.enum(TOOL_NAMES)).default([]),

  /** Tools withheld even when a step grants them. `delegate` is always here. */
  denyTools: z.array(z.enum(TOOL_NAMES)).default([...ALWAYS_DENIED]),

  /** Default ceiling on how much this role changes before review. */
  changeBudget: ChangeBudget.optional(),

  /** Reference material under `core/knowledge/<id>/`, loaded on activation. */
  knowledge: z.array(z.string().min(1)).default([]),

  /**
   * Whether this role writes code and therefore owes documentation. Drives
   * whether the generated docs contract appears in the brief.
   */
  writesCode: z.boolean().default(false),
});

export type AgentSpec = z.infer<typeof AgentSpec>;

/** A persona file: validated frontmatter plus its Markdown body. */
export type Agent = AgentSpec & {
  /** The operating instructions, verbatim from below the frontmatter. */
  body: string;
  /** Where it was loaded from, for error messages. */
  source: string;
};

/**
 * What the role may actually use on this step: the workflow's grant, narrowed
 * to the persona's ceiling, minus its denials.
 *
 * The compiler already refuses a workflow that grants beyond the ceiling, so
 * intersecting here is redundant in the happy path. It is kept because the
 * guard calls this on every tool call and a stale grant — a project persona
 * that revoked a tool the workflow still lists — must not be the one case where
 * the ceiling quietly stops applying.
 */
export function effectiveTools(agent: AgentSpec, granted: readonly string[]): string[] {
  const allowed = new Set<string>(agent.tools);
  const denied = new Set<string>([...agent.denyTools, ...ALWAYS_DENIED]);

  return granted.filter((tool) => allowed.has(tool) && !denied.has(tool));
}

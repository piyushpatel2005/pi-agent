// The event log is the system of record.
//
// Every meaningful thing the harness does becomes one line in
// `pi/runs/<run-id>/events.ndjson`. The engine, the guard hooks, the CLI, and
// any future inspector UI all read and write this one shape, so it is the
// contract that keeps them honest. Nothing reaches disk without passing
// `PiEvent.parse()`.
//
// `EventType` is a const object rather than a TS `enum` because Node executes
// these files by stripping types, and `enum` emits runtime code. The call site
// reads identically (`EventType.StepStarted`) and the union of values stays
// exhaustive for the compiler.

import { z } from "zod";

export const EventType = {
  // A run is one invocation of one workflow against one goal.
  RunStarted: "run.started",
  RunCompleted: "run.completed",
  RunFailed: "run.failed",

  // Step lifecycle. Every step transition lands here, which is what makes the
  // log replayable into the current state.
  StepStarted: "step.started",
  StepCompleted: "step.completed",
  StepSkipped: "step.skipped",
  StepFailed: "step.failed",

  // A persona taking over the work.
  AgentActivated: "agent.activated",

  // Traceability: which step produced which file.
  ArtifactWritten: "artifact.written",

  // Durability: a resumable boundary between steps.
  CheckpointSaved: "checkpoint.saved",

  // Human-in-the-loop. Review gates code before it lands; approval gates a
  // step before the run advances.
  ReviewRequested: "review.requested",
  ReviewResolved: "review.resolved",
  GateOpened: "gate.opened",
  GateResolved: "gate.resolved",

  // Presence evidence. A gate may only resolve when a human acted since the
  // last one, so an unattended run cannot approve its own work.
  HumanTurn: "human.turn",

  // A guard refused a tool call. Every denial is recorded, so "why did it stop"
  // is always answerable from the log.
  GuardBlocked: "guard.blocked",

  // Advisory deterministic checks (required sections, type-check, traceability).
  SensorFired: "sensor.fired",

  // Free-form harness logging.
  Log: "log.emitted",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

/** Every event carries these. The emitter stamps them; callers never pass them. */
const envelope = {
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  runId: z.string().min(1),
} as const;

function event<T extends EventType, S extends z.ZodRawShape>(type: T, payload: S) {
  return z.object({ ...envelope, type: z.literal(type), ...payload });
}

/**
 * Agent and step ids are plain strings here, deliberately.
 *
 * The persona roster and the workflow definition both change over time; a log
 * written last month must still parse after a persona is renamed or a step is
 * removed. Validation against the live roster belongs at the point of use (the
 * router, the guards), not at the point of record.
 */
const agentId = z.string().min(1);
const stepId = z.string().min(1);

const fileAction = z.enum(["add", "modify", "delete"]);

export const ReviewedFile = z.object({
  path: z.string().min(1),
  action: fileAction,
});
export type ReviewedFile = z.infer<typeof ReviewedFile>;

export const PiEvent = z.discriminatedUnion("type", [
  event(EventType.RunStarted, {
    workflow: z.string().min(1),
    goal: z.string(),
  }),
  event(EventType.RunCompleted, {
    summary: z.string(),
  }),
  event(EventType.RunFailed, {
    error: z.string(),
  }),

  event(EventType.StepStarted, {
    step: stepId,
    agent: agentId,
    attempt: z.number().int().positive(),
  }),
  event(EventType.StepCompleted, {
    step: stepId,
    agent: agentId,
    artifacts: z.array(z.string()).default([]),
  }),
  event(EventType.StepSkipped, {
    step: stepId,
    reason: z.string(),
  }),
  event(EventType.StepFailed, {
    step: stepId,
    error: z.string(),
  }),

  event(EventType.AgentActivated, {
    agent: agentId,
    step: stepId,
  }),

  event(EventType.ArtifactWritten, {
    step: stepId,
    agent: agentId,
    path: z.string().min(1),
    action: fileAction,
    lines: z.number().int().nonnegative(),
  }),

  event(EventType.CheckpointSaved, {
    step: stepId,
    digest: z.string().min(1),
  }),

  event(EventType.ReviewRequested, {
    step: stepId,
    receiptId: z.string().min(1),
    summary: z.string(),
    files: z.array(ReviewedFile),
    changedLines: z.number().int().nonnegative(),
  }),
  event(EventType.ReviewResolved, {
    step: stepId,
    receiptId: z.string().min(1),
    approved: z.boolean(),
    feedback: z.string().optional(),
  }),

  event(EventType.GateOpened, {
    step: stepId,
    kind: z.enum(["approval", "review"]),
  }),
  event(EventType.GateResolved, {
    step: stepId,
    kind: z.enum(["approval", "review"]),
    outcome: z.enum(["approved", "rejected", "revised"]),
  }),

  event(EventType.HumanTurn, {
    source: z.string().min(1),
  }),

  event(EventType.GuardBlocked, {
    guard: z.string().min(1),
    tool: z.string().min(1),
    reason: z.string(),
    step: stepId.optional(),
  }),

  event(EventType.SensorFired, {
    step: stepId,
    sensor: z.string().min(1),
    pass: z.boolean(),
    findings: z.array(z.string()).default([]),
  }),

  event(EventType.Log, {
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
  }),
]);

export type PiEvent = z.infer<typeof PiEvent>;

/** Narrow the union to one variant, e.g. `EventOf<typeof EventType.StepStarted>`. */
export type EventOf<T extends EventType> = Extract<PiEvent, { type: T }>;

/**
 * What callers hand to the emitter. The envelope is the emitter's job, so a
 * caller cannot forge an id, backdate a timestamp, or attribute an event to
 * another run.
 */
export type PiEventInput = PiEvent extends infer E
  ? E extends PiEvent
    ? Omit<E, keyof typeof envelope>
    : never
  : never;

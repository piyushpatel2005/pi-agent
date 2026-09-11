import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { EventType, PiEvent, type PiEventInput } from "../../core/schemas/events.ts";

/** A valid envelope, so each case only has to vary the part under test. */
function stamp<T extends object>(payload: T) {
  return { id: "evt-1", ts: 1_700_000_000_000, runId: "run-1", ...payload };
}

describe("EventType", () => {
  test("every declared type has a schema variant", () => {
    const declared = Object.values(EventType).sort();
    const inUnion = PiEvent.options
      .map((variant) => variant.shape.type.value)
      .sort();

    assert.deepEqual(inUnion, declared);
  });

  test("values are namespaced dot-strings, so logs stay greppable", () => {
    for (const value of Object.values(EventType)) {
      assert.match(value, /^[a-z]+\.[a-z]+$/, `${value} is not <noun>.<verb>`);
    }
  });
});

describe("PiEvent.parse", () => {
  test("accepts a well-formed event", () => {
    const parsed = PiEvent.parse(
      stamp({
        type: EventType.StepStarted,
        step: "requirements",
        agent: "business-analyst",
        attempt: 1,
      }),
    );

    assert.equal(parsed.type, EventType.StepStarted);
    assert.equal(parsed.runId, "run-1");
  });

  test("rejects an unknown event type", () => {
    const result = PiEvent.safeParse(stamp({ type: "step.teleported", step: "x" }));
    assert.equal(result.success, false);
  });

  test("rejects a known type carrying the wrong payload", () => {
    // ReviewRequested without its receiptId is the exact shape a buggy caller
    // would produce, and it must never reach disk.
    const result = PiEvent.safeParse(
      stamp({
        type: EventType.ReviewRequested,
        step: "backend-implementation",
        summary: "Add the orders service",
        files: [],
        changedLines: 120,
      }),
    );

    assert.equal(result.success, false);
  });

  test("rejects an event missing its envelope", () => {
    const result = PiEvent.safeParse({
      type: EventType.Log,
      level: "info",
      message: "no envelope",
    });

    assert.equal(result.success, false);
  });

  test("defaults optional collections rather than leaving them undefined", () => {
    const parsed = PiEvent.parse(
      stamp({
        type: EventType.StepCompleted,
        step: "architecture",
        agent: "solution-architect",
      }),
    );

    assert.equal(parsed.type, EventType.StepCompleted);
    assert.deepEqual(parsed.type === EventType.StepCompleted ? parsed.artifacts : null, []);
  });

  test("guard denials record enough to answer 'why did it stop'", () => {
    const parsed = PiEvent.parse(
      stamp({
        type: EventType.GuardBlocked,
        guard: "change-budget",
        tool: "Write",
        reason: "310 lines exceeds the step budget of 300",
        step: "backend-implementation",
      }),
    );

    assert.equal(parsed.type, EventType.GuardBlocked);
  });
});

describe("PiEventInput", () => {
  test("omits the envelope so callers cannot forge it", () => {
    const input: PiEventInput = {
      type: EventType.HumanTurn,
      source: "cursor:beforeSubmitPrompt",
    };

    // @ts-expect-error — id belongs to the emitter, not the caller.
    const forged: PiEventInput = { ...input, id: "forged" };

    assert.equal(input.type, EventType.HumanTurn);
    assert.ok(forged);
  });
});

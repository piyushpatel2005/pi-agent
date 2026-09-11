import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventLog } from "../../core/engine/event-log.ts";
import { EventType } from "../../core/schemas/events.ts";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-log-"));
  logPath = join(dir, "nested", "events.ndjson");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createEventLog", () => {
  test("reads back nothing before anything is written", () => {
    assert.deepEqual(createEventLog(logPath, "run-1").read(), []);
  });

  test("stamps the envelope so callers cannot forge it", () => {
    const log = createEventLog(logPath, "run-1", () => 1_700_000_000_000);

    const event = log.append({ type: EventType.HumanTurn, source: "test" });

    assert.equal(event.runId, "run-1");
    assert.equal(event.ts, 1_700_000_000_000);
    assert.match(event.id, /^[0-9a-f-]{36}$/);
  });

  test("preserves write order", () => {
    const log = createEventLog(logPath, "run-1");

    log.append({ type: EventType.RunStarted, workflow: "feature", goal: "ship it" });
    log.append({ type: EventType.StepStarted, step: "requirements", agent: "business-analyst", attempt: 1 });
    log.append({ type: EventType.StepCompleted, step: "requirements", agent: "business-analyst", artifacts: [] });

    assert.deepEqual(
      log.read().map((event) => event.type),
      [EventType.RunStarted, EventType.StepStarted, EventType.StepCompleted],
    );
  });

  test("writes one line per event", () => {
    const log = createEventLog(logPath, "run-1");
    log.appendAll([
      { type: EventType.Log, level: "info", message: "one" },
      { type: EventType.Log, level: "warn", message: "two" },
    ]);

    const lines = readFileSync(logPath, "utf-8").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  });

  test("refuses to write an invalid event", () => {
    const log = createEventLog(logPath, "run-1");

    assert.throws(() =>
      log.append({
        type: EventType.StepStarted,
        step: "requirements",
        // @ts-expect-error — deliberately omitting a required field
        agent: undefined,
        attempt: 1,
      }),
    );
  });

  test("a crash mid-write costs one line, not the log", () => {
    const log = createEventLog(logPath, "run-1");
    log.append({ type: EventType.Log, level: "info", message: "before the crash" });

    // A process killed mid-append leaves a truncated trailing line.
    appendFileSync(logPath, '{"type":"log.emitted","level":"in');

    const events = log.read();
    assert.equal(events.length, 1, "the intact line is still readable");
    assert.equal(events[0]?.type, EventType.Log);

    const damaged = log.readDamaged();
    assert.equal(damaged.length, 1);
    assert.equal(damaged[0]?.line, 2);
    assert.match(damaged[0]?.error ?? "", /not JSON/);
  });

  test("reports a line that is valid JSON but not a valid event", () => {
    const log = createEventLog(logPath, "run-1");
    log.append({ type: EventType.Log, level: "info", message: "fine" });
    appendFileSync(logPath, `${JSON.stringify({ type: "log.emitted", level: "shouting" })}\n`);

    assert.equal(log.read().length, 1);
    assert.equal(log.readDamaged().length, 1);
  });

  test("appends rather than truncating across handles", () => {
    createEventLog(logPath, "run-1").append({
      type: EventType.Log,
      level: "info",
      message: "first handle",
    });
    createEventLog(logPath, "run-1").append({
      type: EventType.Log,
      level: "info",
      message: "second handle",
    });

    assert.equal(createEventLog(logPath, "run-1").read().length, 2);
  });
});

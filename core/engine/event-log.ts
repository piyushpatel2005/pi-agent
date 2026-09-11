// The append-only run history.
//
// One JSON object per line in `events.ndjson`. Append-only is the whole point:
// nothing here is ever rewritten, so the file is a record rather than a cache,
// and it can be tailed, grepped, and replayed.
//
// Two properties this file is responsible for:
//
//   1. Nothing invalid reaches disk. Every append is validated against the
//      event schema first, so a reader never has to defend against a shape
//      the writer should have caught.
//
//   2. A crash mid-write costs one line, not the log. Writes use O_APPEND so
//      concurrent writers interleave whole lines, and the reader skips a
//      malformed trailing line instead of refusing the file.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { PiEvent, type PiEventInput } from "../schemas/events.ts";

export type BadLine = {
  /** 1-based, so it matches what an editor shows. */
  line: number;
  raw: string;
  error: string;
};

export type EventLog = {
  append: (input: PiEventInput) => PiEvent;
  appendAll: (inputs: readonly PiEventInput[]) => PiEvent[];
  /** Every well-formed event, in write order. */
  read: () => PiEvent[];
  /** Lines that failed to parse — surfaced by `pi doctor` rather than thrown. */
  readDamaged: () => BadLine[];
};

export function createEventLog(path: string, runId: string, now = () => Date.now()): EventLog {
  function stamp(input: PiEventInput): PiEvent {
    // Parsing here, not at the call site, is what guarantees the file's
    // contents match the schema for every writer.
    return PiEvent.parse({ ...input, id: randomUUID(), ts: now(), runId });
  }

  function write(events: readonly PiEvent[]): void {
    if (events.length === 0) return;
    mkdirSync(dirname(path), { recursive: true });
    const payload = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    // O_APPEND: the kernel positions each write at the current end of file, so
    // two processes appending at once cannot overwrite each other.
    appendFileSync(path, payload, { flag: "a" });
  }

  function lines(): string[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8").split("\n");
  }

  return {
    append(input) {
      const event = stamp(input);
      write([event]);
      return event;
    },

    appendAll(inputs) {
      // Stamped together and written in one call, so a batch cannot be split
      // across another writer's line.
      const events = inputs.map(stamp);
      write(events);
      return events;
    },

    read() {
      const events: PiEvent[] = [];
      for (const line of lines()) {
        if (line.trim() === "") continue;
        const parsed = safeParseLine(line);
        if (parsed.ok) events.push(parsed.event);
      }
      return events;
    },

    readDamaged() {
      const damaged: BadLine[] = [];
      lines().forEach((line, index) => {
        if (line.trim() === "") return;
        const parsed = safeParseLine(line);
        if (!parsed.ok) damaged.push({ line: index + 1, raw: line, error: parsed.error });
      });
      return damaged;
    },
  };
}

function safeParseLine(
  line: string,
): { ok: true; event: PiEvent } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (cause) {
    return { ok: false, error: `not JSON: ${(cause as Error).message}` };
  }

  const result = PiEvent.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((issue) => issue.message).join("; ") };
  }
  return { ok: true, event: result.data };
}

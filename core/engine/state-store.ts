// The only writer of `state.json`.
//
// Everything that changes the run goes through `update()`, which does a locked
// read-modify-write and refuses a mutation that would violate an invariant.
// Centralising that is what lets the rest of the engine treat state as
// trustworthy rather than defensively re-checking it.
//
// Three guarantees:
//
//   1. **Atomic.** State is written to a temp file and renamed into place, so a
//      reader never sees a half-written file and a crash leaves the previous
//      state intact.
//
//   2. **Serialised.** A directory lock means the conductor and a guard hook
//      cannot interleave read-modify-write cycles and lose one of them.
//
//   3. **Receipts are append-only.** A review receipt is evidence a human
//      approved something. Routine status writes cannot drop one, alter what it
//      covers, or change an answer once given.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import { RunState, type ReviewReceipt } from "../schemas/state.ts";
import type { RunPaths } from "./paths.ts";

/** A mutation was refused because it would have broken a state invariant. */
export class StateInvariantError extends Error {
  readonly invariant: string;

  constructor(invariant: string, detail: string) {
    super(`${invariant}: ${detail}`);
    this.name = "StateInvariantError";
    this.invariant = invariant;
  }
}

/** The lock was held by someone else for longer than we are willing to wait. */
export class StateLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateLockError";
  }
}

export type StateStore = {
  exists: () => boolean;
  read: () => RunState;
  /** Write the initial state. Refuses to clobber an existing run. */
  init: (initial: RunState) => RunState;
  /** Locked read-modify-write. The mutator receives a private copy. */
  update: (mutate: (draft: RunState) => void) => RunState;
  /**
   * Replace the state wholesale, for a rewind.
   *
   * `update` refuses to drop a step or discard a receipt, which is what makes
   * an approval impossible to retarget during normal operation. A rewind has to
   * do exactly that, so it gets its own door rather than a weakened invariant —
   * the guard stays absolute everywhere else, and the one place that bypasses
   * it is named, deliberate, and confirmed by a human at the CLI.
   *
   * Run identity is still enforced: a rewind moves a run backwards, it does not
   * turn it into a different run.
   */
  restore: (state: RunState) => RunState;
};

export type StoreOptions = {
  /** How long to wait for the lock before giving up. */
  lockTimeoutMs?: number;
  /** A lock older than this is treated as abandoned by a dead process. */
  staleLockMs?: number;
  now?: () => Date;
};

export function createStateStore(paths: RunPaths, options: StoreOptions = {}): StateStore {
  const lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  const staleLockMs = options.staleLockMs ?? 30_000;
  const now = options.now ?? (() => new Date());

  function read(): RunState {
    if (!existsSync(paths.state)) {
      throw new Error(`no run state at ${paths.state}`);
    }
    return RunState.parse(JSON.parse(readFileSync(paths.state, "utf-8")));
  }

  function writeAtomic(state: RunState): void {
    mkdirSync(paths.root, { recursive: true });
    const temp = `${paths.state}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    // rename(2) is atomic within a filesystem: a reader sees either the old
    // file or the new one, never a partial write.
    renameSync(temp, paths.state);
  }

  function acquireLock(): () => void {
    const deadline = Date.now() + lockTimeoutMs;

    for (;;) {
      try {
        // mkdir is atomic and fails if the directory exists, which makes it a
        // portable mutex with no extra dependency.
        mkdirSync(paths.lock);
        return () => rmSync(paths.lock, { recursive: true, force: true });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;

        if (lockAgeMs() > staleLockMs) {
          // The holder is gone; reclaim rather than block forever.
          rmSync(paths.lock, { recursive: true, force: true });
          continue;
        }

        if (Date.now() >= deadline) {
          throw new StateLockError(
            `could not acquire the state lock at ${paths.lock} within ${lockTimeoutMs}ms; ` +
              "another pi process may be mid-write",
          );
        }

        sleep(15);
      }
    }
  }

  function lockAgeMs(): number {
    try {
      return Date.now() - statSync(paths.lock).mtimeMs;
    } catch {
      return 0;
    }
  }

  return {
    exists: () => existsSync(paths.state),

    read,

    init(initial) {
      if (existsSync(paths.state)) {
        throw new StateInvariantError(
          "run-already-initialised",
          `${paths.state} already exists; starting over would discard its history`,
        );
      }
      const state = RunState.parse(initial);
      mkdirSync(paths.root, { recursive: true });
      writeAtomic(state);
      return state;
    },

    update(mutate) {
      const release = acquireLock();
      try {
        const before = read();
        // The mutator works on a copy, so a mutator that throws partway cannot
        // leave a half-applied object behind.
        const draft = structuredClone(before);
        mutate(draft);
        draft.updatedAt = now().toISOString();

        const after = RunState.parse(draft);
        assertInvariants(before, after);
        writeAtomic(after);
        return after;
      } finally {
        release();
      }
    },

    restore(state) {
      const release = acquireLock();
      try {
        const before = read();
        const after = RunState.parse({ ...state, updatedAt: now().toISOString() });

        assertRunIdentity(before, after);
        writeAtomic(after);
        return after;
      } finally {
        release();
      }
    },
  };
}

// ── Invariants ──────────────────────────────────────────────────────────────

function assertInvariants(before: RunState, after: RunState): void {
  assertRunIdentity(before, after);

  for (const [stepId, beforeStep] of Object.entries(before.steps)) {
    const afterStep = after.steps[stepId];

    if (!afterStep) {
      throw new StateInvariantError(
        "step-retention",
        `step "${stepId}" disappeared; a step may change status but never vanish`,
      );
    }

    assertReceiptsAppendOnly(stepId, beforeStep.receipts, afterStep.receipts);
  }
}

/** A run does not become a different run. True of updates and rewinds alike. */
function assertRunIdentity(before: RunState, after: RunState): void {
  if (after.runId !== before.runId) {
    throw new StateInvariantError(
      "run-identity",
      `runId changed from ${before.runId} to ${after.runId}`,
    );
  }

  if (after.version !== before.version) {
    throw new StateInvariantError(
      "schema-version",
      "version is owned by migration, not by an update",
    );
  }

  if (Date.parse(after.createdAt) !== Date.parse(before.createdAt)) {
    throw new StateInvariantError("run-identity", "createdAt is immutable");
  }
}

/**
 * A receipt may be added, and a pending one may be answered exactly once.
 * Nothing else about it can move.
 *
 * This is what stops an approval from being retargeted at different code, and
 * what makes it safe to keep receipts in the same file as routine status.
 */
function assertReceiptsAppendOnly(
  stepId: string,
  before: readonly ReviewReceipt[],
  after: readonly ReviewReceipt[],
): void {
  for (const original of before) {
    const current = after.find((receipt) => receipt.id === original.id);

    if (!current) {
      throw new StateInvariantError(
        "receipt-append-only",
        `receipt "${original.id}" was dropped from step "${stepId}"`,
      );
    }

    if (current.digest !== original.digest) {
      throw new StateInvariantError(
        "receipt-append-only",
        `receipt "${original.id}" changed what it covers (digest ${original.digest} → ${current.digest})`,
      );
    }

    if (current.step !== original.step || current.requestedAt !== original.requestedAt) {
      throw new StateInvariantError(
        "receipt-append-only",
        `receipt "${original.id}" changed its identity`,
      );
    }

    if (
      original.resolution !== null &&
      JSON.stringify(current.resolution) !== JSON.stringify(original.resolution)
    ) {
      throw new StateInvariantError(
        "receipt-append-only",
        `receipt "${original.id}" was already answered; an answer cannot be revised`,
      );
    }
  }
}

/** Blocking sleep. The lock path is short and synchronous by design. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

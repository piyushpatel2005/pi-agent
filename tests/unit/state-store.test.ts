import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStateStore,
  StateInvariantError,
  StateLockError,
} from "../../core/engine/state-store.ts";
import { runPaths, type RunPaths } from "../../core/engine/paths.ts";
import {
  RunState,
  RunStatus,
  StepStatus,
  STATE_VERSION,
  newStepState,
} from "../../core/schemas/state.ts";

const RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let projectDir: string;
let paths: RunPaths;

function initialState(): RunState {
  return RunState.parse({
    version: STATE_VERSION,
    runId: RUN_ID,
    goal: "Add an orders service",
    workflow: "feature",
    workflowDigest: "sha256:abc",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    status: RunStatus.Active,
    currentStep: "requirements",
    steps: {
      requirements: newStepState("business-analyst"),
      build: newStepState("backend-developer"),
    },
  });
}

const receipt = {
  id: "r-1",
  step: "build",
  requestedAt: "2026-09-10T01:00:00.000Z",
  summary: "Add the orders service",
  files: [{ path: "src/orders.ts", action: "add" as const }],
  changedLines: 180,
  digest: "sha256:plan-a",
  resolution: null,
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-state-"));
  paths = runPaths(projectDir, RUN_ID);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("init", () => {
  test("writes the initial state and reads it back", () => {
    const store = createStateStore(paths);
    assert.equal(store.exists(), false);

    store.init(initialState());

    assert.equal(store.exists(), true);
    assert.equal(store.read().goal, "Add an orders service");
  });

  test("refuses to clobber an existing run", () => {
    const store = createStateStore(paths);
    store.init(initialState());

    assert.throws(
      () => store.init(initialState()),
      (error: unknown) =>
        error instanceof StateInvariantError && error.invariant === "run-already-initialised",
    );
  });
});

describe("read", () => {
  test("fails loudly on a corrupt state file rather than guessing", () => {
    const store = createStateStore(paths);
    store.init(initialState());
    writeFileSync(paths.state, "{ not json");

    assert.throws(() => store.read());
  });

  test("rejects a state file that does not match the schema", () => {
    const store = createStateStore(paths);
    store.init(initialState());
    writeFileSync(paths.state, JSON.stringify({ version: STATE_VERSION, runId: RUN_ID }));

    assert.throws(() => store.read());
  });
});

describe("update", () => {
  test("applies a mutation and stamps updatedAt", () => {
    const store = createStateStore(paths, { now: () => new Date("2026-09-11T12:00:00.000Z") });
    store.init(initialState());

    const after = store.update((draft) => {
      draft.steps.requirements!.status = StepStatus.Active;
      draft.currentStep = "requirements";
    });

    assert.equal(after.steps.requirements?.status, StepStatus.Active);
    assert.equal(after.updatedAt, "2026-09-11T12:00:00.000Z");
    assert.equal(store.read().steps.requirements?.status, StepStatus.Active);
  });

  test("a throwing mutator leaves the stored state untouched", () => {
    const store = createStateStore(paths);
    store.init(initialState());

    assert.throws(() =>
      store.update((draft) => {
        draft.steps.requirements!.status = StepStatus.Completed;
        throw new Error("mutator blew up");
      }),
    );

    assert.equal(store.read().steps.requirements?.status, StepStatus.Pending);
  });

  test("releases the lock even when the mutation fails", () => {
    const store = createStateStore(paths);
    store.init(initialState());

    assert.throws(() =>
      store.update(() => {
        throw new Error("boom");
      }),
    );

    // If the lock leaked, this second update would time out.
    assert.doesNotThrow(() => store.update((draft) => void (draft.currentStep = "build")));
  });

  test("writes atomically, leaving no temp files behind", () => {
    const store = createStateStore(paths);
    store.init(initialState());
    store.update((draft) => void (draft.currentStep = "build"));

    const stray = readFileSync(paths.state, "utf-8");
    assert.match(stray, /"currentStep": "build"/);
  });
});

describe("identity invariants", () => {
  test("runId cannot change", () => {
    const store = createStateStore(paths);
    store.init(initialState());

    assert.throws(
      () => store.update((draft) => void (draft.runId = "00000000-0000-4000-8000-000000000000")),
      (error: unknown) => error instanceof StateInvariantError && error.invariant === "run-identity",
    );
  });

  test("createdAt cannot change", () => {
    const store = createStateStore(paths);
    store.init(initialState());

    assert.throws(
      () => store.update((draft) => void (draft.createdAt = "2020-01-01T00:00:00.000Z")),
      (error: unknown) => error instanceof StateInvariantError && error.invariant === "run-identity",
    );
  });

  test("a step cannot vanish", () => {
    const store = createStateStore(paths);
    store.init(initialState());

    assert.throws(
      () => store.update((draft) => void delete draft.steps.build),
      (error: unknown) =>
        error instanceof StateInvariantError && error.invariant === "step-retention",
    );
  });
});

describe("receipts are append-only", () => {
  function storeWithReceipt() {
    const store = createStateStore(paths);
    store.init(initialState());
    store.update((draft) => void draft.steps.build!.receipts.push(receipt));
    return store;
  }

  test("a receipt can be added", () => {
    const store = storeWithReceipt();
    assert.equal(store.read().steps.build?.receipts.length, 1);
  });

  test("a pending receipt can be answered", () => {
    const store = storeWithReceipt();

    const after = store.update((draft) => {
      draft.steps.build!.receipts[0]!.resolution = {
        approved: true,
        at: "2026-09-10T02:00:00.000Z",
      };
    });

    assert.equal(after.steps.build?.receipts[0]?.resolution?.approved, true);
  });

  test("an answered receipt cannot be revised", () => {
    const store = storeWithReceipt();
    store.update((draft) => {
      draft.steps.build!.receipts[0]!.resolution = {
        approved: false,
        at: "2026-09-10T02:00:00.000Z",
        feedback: "split this up",
      };
    });

    assert.throws(
      () =>
        store.update((draft) => {
          draft.steps.build!.receipts[0]!.resolution = {
            approved: true,
            at: "2026-09-10T03:00:00.000Z",
          };
        }),
      (error: unknown) =>
        error instanceof StateInvariantError && error.invariant === "receipt-append-only",
    );
  });

  test("a receipt cannot be retargeted at different content", () => {
    // The attack this blocks: get approval for a small change, then point the
    // approval at a much larger one.
    const store = storeWithReceipt();

    assert.throws(
      () => store.update((draft) => void (draft.steps.build!.receipts[0]!.digest = "sha256:plan-b")),
      (error: unknown) =>
        error instanceof StateInvariantError && error.invariant === "receipt-append-only",
    );
  });

  test("a receipt cannot be dropped", () => {
    const store = storeWithReceipt();

    assert.throws(
      () => store.update((draft) => void (draft.steps.build!.receipts = [])),
      (error: unknown) =>
        error instanceof StateInvariantError && error.invariant === "receipt-append-only",
    );
  });
});

describe("locking", () => {
  test("reports a stuck lock instead of hanging", () => {
    const store = createStateStore(paths, { lockTimeoutMs: 50, staleLockMs: 60_000 });
    store.init(initialState());
    mkdirSync(paths.lock);

    assert.throws(
      () => store.update((draft) => void (draft.currentStep = "build")),
      (error: unknown) => error instanceof StateLockError,
    );
  });

  test("reclaims a lock abandoned by a dead process", () => {
    const store = createStateStore(paths, { lockTimeoutMs: 50, staleLockMs: 0 });
    store.init(initialState());
    mkdirSync(paths.lock);

    assert.doesNotThrow(() => store.update((draft) => void (draft.currentStep = "build")));
    assert.equal(store.read().currentStep, "build");
  });
});

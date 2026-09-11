// Checkpoints and rewinding.
//
// The run's state is a single JSON document, so a checkpoint is just a copy of
// it taken at a step boundary, and a rewind is putting one back. That simplicity
// is the whole reason state was kept as one atomically-written document.
//
// What a rewind does NOT do is touch your working tree. pi does not own your
// git history and will not pretend to: it moves its own idea of where the run
// is, records the commit each checkpoint was taken at, and leaves moving the
// code to you. A tool that silently reverted files would be a tool nobody could
// afford to be wrong.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { EventType, type PiEventInput } from "../schemas/events.ts";
import { RunState, RunStatus, StepStatus, type Checkpoint } from "../schemas/state.ts";
import type { CompiledWorkflow } from "../schemas/workflow.ts";
import { checkpointPath, type RunPaths } from "./paths.ts";
import { boundaryDigest } from "./router.ts";

export class CheckpointError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

/**
 * Write the full state as it stands at a boundary.
 *
 * Called by the CLI after the router records a checkpoint entry, keeping the
 * split the rest of the engine uses: the router decides, the caller does IO.
 */
export function saveSnapshot(paths: RunPaths, state: RunState, step: string): void {
  const path = checkpointPath(paths, step);
  mkdirSync(paths.checkpoints, { recursive: true });

  // Same atomic write the state store uses: a half-written checkpoint is worse
  // than a missing one, because it looks restorable.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(temp, path);
}

export function loadSnapshot(paths: RunPaths, step: string): RunState {
  const path = checkpointPath(paths, step);
  if (!existsSync(path)) {
    throw new CheckpointError(
      "missing-snapshot",
      `No checkpoint file for step "${step}". It may predate checkpointing, or have been deleted.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (cause) {
    throw new CheckpointError(
      "unreadable-snapshot",
      `The checkpoint for "${step}" is not valid JSON: ${(cause as Error).message}`,
    );
  }

  const parsed = RunState.safeParse(raw);
  if (!parsed.success) {
    throw new CheckpointError(
      "invalid-snapshot",
      `The checkpoint for "${step}" is not a valid run state; it cannot be restored.`,
    );
  }

  return parsed.data;
}

/**
 * Delete the snapshots for boundaries a rewind removed from the index.
 *
 * They describe a shape of the run that no longer exists, and leaving them
 * would make `pi doctor` report an orphan after every legitimate rewind —
 * training people to ignore it. The event log still records that they happened.
 */
export function discardSnapshots(paths: RunPaths, steps: readonly string[]): void {
  for (const step of steps) rmSync(checkpointPath(paths, step), { force: true });
}

/** Checkpoints on disk that are not in the state's index, and vice versa. */
export function auditSnapshots(paths: RunPaths, state: RunState): string[] {
  const problems: string[] = [];
  const indexed = new Set(state.checkpoints.map((checkpoint) => checkpoint.step));

  for (const checkpoint of state.checkpoints) {
    if (!existsSync(checkpointPath(paths, checkpoint.step))) {
      problems.push(`checkpoint "${checkpoint.step}" is indexed but its file is missing`);
    }
  }

  if (existsSync(paths.checkpoints)) {
    for (const entry of readdirSync(paths.checkpoints)) {
      if (!entry.endsWith(".json")) continue;
      const step = entry.slice(0, -".json".length);
      if (!indexed.has(step)) problems.push(`checkpoint file "${entry}" is not in the index`);
    }
  }

  return problems;
}

// ── Rewinding ───────────────────────────────────────────────────────────────

export type RewindPlan = {
  /** The step that will be next to run once this is applied. */
  target: string;
  /** The checkpoint being restored, or null when rewinding to the very start. */
  from: Checkpoint | null;
  /** Steps whose completed work will be undone, in workflow order. */
  undone: string[];
  /** Receipts that will be discarded with them. */
  discardedReceipts: number;
  /** The state that would be written. */
  state: RunState;
};

/**
 * Work out how to make `target` the next step to run.
 *
 * "Rewind to architecture" means undo architecture and everything after it, so
 * the restore point is the checkpoint of the step *before* the target. Rewinding
 * to the first step means going back to the run's original plan, which needs no
 * checkpoint at all.
 */
export function planRewind(
  paths: RunPaths,
  state: RunState,
  workflow: CompiledWorkflow,
  target: string,
): RewindPlan {
  const index = workflow.steps.findIndex((step) => step.id === target);
  if (index === -1) {
    throw new CheckpointError(
      "unknown-step",
      `No step "${target}" in workflow "${workflow.id}".`,
    );
  }

  const restored = index === 0 ? initialState(state, workflow) : restorePoint(paths, state, workflow, index);

  const undone = workflow.steps
    .slice(index)
    .filter((step) => {
      const before = state.steps[step.id]?.status;
      const after = restored.state.steps[step.id]?.status;
      return before !== after && before !== StepStatus.Pending;
    })
    .map((step) => step.id);

  if (undone.length === 0 && state.currentStep === target) {
    throw new CheckpointError(
      "nothing-to-undo",
      `The run is already at "${target}"; there is nothing to rewind.`,
    );
  }

  const discardedReceipts = workflow.steps
    .slice(index)
    .reduce((total, step) => total + (state.steps[step.id]?.receipts.length ?? 0), 0);

  return { target, from: restored.from, undone, discardedReceipts, state: restored.state };
}

function restorePoint(
  paths: RunPaths,
  state: RunState,
  workflow: CompiledWorkflow,
  index: number,
): { state: RunState; from: Checkpoint } {
  // Walk backwards to the nearest step that actually has a checkpoint: a
  // workflow may set `checkpoint: false` on a step, and rewinding to the last
  // real boundary is more useful than refusing.
  for (let i = index - 1; i >= 0; i--) {
    const candidate = workflow.steps[i]!.id;
    const entry = state.checkpoints.findLast((checkpoint) => checkpoint.step === candidate);
    if (!entry) continue;

    const snapshot = loadSnapshot(paths, candidate);
    verify(snapshot, entry);

    return { state: snapshot, from: entry };
  }

  throw new CheckpointError(
    "no-checkpoint",
    `No checkpoint exists before "${workflow.steps[index]!.id}". ` +
      `Rewind to "${workflow.steps[0]!.id}" to restart the run from the beginning.`,
  );
}

/** Does this snapshot describe the boundary its index entry claims? */
function verify(snapshot: RunState, entry: Checkpoint): void {
  if (boundaryDigest(snapshot, entry.step) === entry.digest) return;

  throw new CheckpointError(
    "digest-mismatch",
    `The checkpoint file for "${entry.step}" does not match the boundary it was ` +
      `recorded at. It has been modified or replaced, so restoring it would put ` +
      `the run into a state that never existed.`,
  );
}

/** The run as it was planned, before any step ran. */
function initialState(state: RunState, workflow: CompiledWorkflow): {
  state: RunState;
  from: null;
} {
  const fresh = structuredClone(state);

  for (const step of workflow.steps) {
    const stepState = fresh.steps[step.id];
    if (!stepState) continue;

    // A step skipped by a `when` condition stays skipped: that was a decision
    // about the project, not work that was done.
    if (stepState.status === StepStatus.Skipped) continue;

    fresh.steps[step.id] = {
      ...stepState,
      status: StepStatus.Pending,
      attempt: 0,
      artifacts: [],
      changedFiles: [],
      changedLines: 0,
      receipts: [],
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
    };
  }

  fresh.checkpoints = [];
  fresh.currentStep = workflow.steps.find(
    (step) => fresh.steps[step.id]?.status === StepStatus.Pending,
  )?.id ?? null;
  fresh.status = RunStatus.Active;

  return { state: fresh, from: null };
}

/**
 * The events a rewind emits.
 *
 * The log is never rewound. It is the audit trail, and a trail that can be
 * edited to remove the part you regret is not a trail — so a rewind is recorded
 * as one more thing that happened.
 */
export function rewindEvents(plan: RewindPlan): PiEventInput[] {
  return [
    {
      type: EventType.Log,
      level: "warn",
      message:
        `Rewound to "${plan.target}"` +
        (plan.from ? ` from the checkpoint at "${plan.from.step}"` : " (start of run)") +
        `, undoing ${plan.undone.length} step(s): ${plan.undone.join(", ") || "none"}.`,
    },
  ];
}

/** The commit the working tree is on, when this is a git repository. */
export function gitHead(projectDir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a repo, or git is not installed. Both are fine; the field is optional.
    return undefined;
  }
}

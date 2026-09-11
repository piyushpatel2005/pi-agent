// Where a run keeps its things.
//
// One module owns the layout so nothing else has to join path segments and
// quietly disagree about them. Everything a run produces lives under a single
// directory, which is what makes a run easy to inspect, archive, or delete.

import { join } from "node:path";

export type RunPaths = {
  /** `<project>/pi/runs/<runId>` */
  root: string;
  /** Machine truth-of-now. */
  state: string;
  /** Human-readable mirror of the same, regenerated on write. */
  stateMarkdown: string;
  /** Append-only history. */
  events: string;
  /** One file per resumable boundary. */
  checkpoints: string;
  /** Artifacts the steps produce. */
  artifacts: string;
  /** Coordination directory for the state lock. */
  lock: string;
};

export function runsDir(projectDir: string): string {
  return join(projectDir, "pi", "runs");
}

export function runPaths(projectDir: string, runId: string): RunPaths {
  const root = join(runsDir(projectDir), runId);
  return {
    root,
    state: join(root, "state.json"),
    stateMarkdown: join(root, "state.md"),
    events: join(root, "events.ndjson"),
    checkpoints: join(root, "checkpoints"),
    artifacts: join(root, "artifacts"),
    lock: join(root, ".state.lock"),
  };
}

/** Where a step's artifacts land, e.g. `artifacts/architecture/api-contract.md`. */
export function artifactPath(paths: RunPaths, step: string, artifact: string): string {
  return join(paths.artifacts, step, artifact);
}

export function checkpointPath(paths: RunPaths, step: string): string {
  return join(paths.checkpoints, `${step}.json`);
}

// Where a run keeps its things.
//
// One module owns the layout so nothing else has to join path segments and
// quietly disagree about them. Everything a run produces lives under a single
// directory, which is what makes a run easy to inspect, archive, or delete.

import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * A repository path as pi records it: relative to the project root, forward
 * slashes, no leading `./`.
 *
 * Receipts hold what a human typed; hooks report what the editor sent. Both
 * must pass through here before they are compared or tallied.
 */
export function repoPath(projectDir: string, file: string): string {
  const root = resolve(projectDir);
  const resolved = isAbsolute(file) ? resolve(file) : resolve(root, file);
  const rel = relative(root, resolved).replace(/\\/g, "/");

  if (rel.startsWith("..") || isAbsolute(rel)) {
    return resolved.replace(/\\/g, "/");
  }

  return rel;
}

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

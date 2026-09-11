// Versions, and the difference between them.
//
// Four things in pi carry a version, and conflating them would be a bug:
//
//   VERSION        the release of the pi tool itself. SemVer, git-tagged.
//   STATE_VERSION  the shape of `state.json`. Bumped only by a migration.
//   CONFIG_VERSION the shape of `pi.config.json`. Bumped only by a migration.
//   workflow.version  author-owned, per workflow file. pi never sets it.
//
// A pi release can ship without touching any schema version, and usually does.
// The schema versions exist so an old state file meets a clear error instead of
// a confusing one; they are not a changelog.

import pkg from "../package.json" with { type: "json" };

import { CONFIG_VERSION } from "./schemas/config.ts";
import { STATE_VERSION } from "./schemas/state.ts";

/**
 * The running release of pi.
 *
 * Read from package.json rather than written out again here. Two copies of a
 * version number is two copies until the day they disagree, and the day they
 * disagree is the day someone files a bug against the wrong release.
 */
export const VERSION: string = pkg.version;

export type VersionInfo = {
  pi: string;
  state: number;
  config: number;
  node: string;
};

/** Everything worth pasting into a bug report. */
export function versionInfo(): VersionInfo {
  return {
    pi: VERSION,
    state: STATE_VERSION,
    config: CONFIG_VERSION,
    node: process.versions.node,
  };
}

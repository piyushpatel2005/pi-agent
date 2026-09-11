// Projecting pi into a coding tool's configuration.
//
// The harness layer is deliberately thin. pi's engine, personas, and workflows
// are host-neutral; all a host needs is (a) hooks pointed at the adapter, (b) a
// skill telling it how to drive the loop, and (c) permission to run `pi`
// without prompting. Porting to another tool means writing those three things
// and nothing else.
//
// Installing merges rather than overwrites. A project's `.cursor/` usually
// already has hooks and rules in it that have nothing to do with pi, and an
// installer that flattens them would be worse than no installer.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { applyIgnore, revokeIgnore, tracked } from "./gitignore.ts";
import { CONFIG_FILE } from "./workspace.ts";

/** The root of the pi installation, resolved from this file. */
export const PI_ROOT = join(import.meta.dirname, "..", "..");

export type InstallResult = {
  /** Files written, relative to the project. */
  written: string[];
  /** Things the user should know: merges made, conflicts left alone. */
  notes: string[];
};

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

export const HARNESSES = ["cursor"] as const;
export type Harness = (typeof HARNESSES)[number];

/**
 * Reject a harness pi cannot project into.
 *
 * Called before anything else looks at the project, so that a typo in the name
 * is reported as a typo. Answering a question about "emacs" as though the
 * harness existed would be worse than refusing it.
 */
export function requireHarness(harness: string): void {
  if (!(HARNESSES as readonly string[]).includes(harness)) {
    throw new InstallError(`No harness "${harness}". Available: ${HARNESSES.join(", ")}.`);
  }
}

export type InstallOptions = {
  /**
   * Skip the `.gitignore` block. For a project that has decided to commit its
   * pi config rather than keep it local.
   */
  noGitignore?: boolean;
};

export function install(
  projectDir: string,
  harness: string,
  options: InstallOptions = {},
): InstallResult {
  requireHarness(harness);
  return installCursor(projectDir, options);
}

// ── Cursor ──────────────────────────────────────────────────────────────────

const ADAPTER = join(PI_ROOT, "harness", "cursor", "adapter.ts");

/**
 * The hooks pi owns, keyed by Cursor's event names.
 *
 * `preToolUse` is not marked `failClosed`. The adapter already answers "allow"
 * on every error path it can reach, so failing closed would only bite when the
 * process itself cannot start — and denying every tool call because pi is
 * mid-upgrade is a worse failure than briefly not guarding.
 */
function cursorHooks(): Record<string, { command: string }[]> {
  const run = (target: string) => ({ command: `node ${JSON.stringify(ADAPTER)} ${target}` });

  return {
    sessionStart: [run("session-start")],
    beforeSubmitPrompt: [run("human-turn")],
    preToolUse: [run("guard")],
    postToolUse: [run("record")],
    // No `stop`: its only channel is `followup_message`, which Cursor submits
    // as a user message and which therefore mints the human presence gates
    // rest on. See the note in harness/cursor/adapter.ts.
  };
}

function installCursor(projectDir: string, options: InstallOptions): InstallResult {
  const written: string[] = [];
  const notes: string[] = [];
  const cursorDir = join(projectDir, ".cursor");

  if (!existsSync(ADAPTER)) {
    throw new InstallError(
      `The pi adapter is missing at ${ADAPTER}. This installation looks incomplete.`,
    );
  }

  // Whether pi *created* these, as opposed to merging into a project's own.
  // It decides whether pi may put them in .gitignore below.
  const madeHooks = mergeHooks(join(cursorDir, "hooks.json"), cursorHooks(), written, notes);
  const madeCli = mergePermissions(join(cursorDir, "cli.json"), written, notes);

  copyInto(
    join(PI_ROOT, "harness", "cursor", "skills", "pi", "SKILL.md"),
    join(cursorDir, "skills", "pi", "SKILL.md"),
    projectDir,
    written,
  );
  copyInto(
    join(PI_ROOT, "harness", "cursor", "rules", "pi.mdc"),
    join(cursorDir, "rules", "pi.mdc"),
    projectDir,
    written,
  );

  if (!options.noGitignore) {
    const extra: string[] = [];
    if (madeHooks) extra.push("/.cursor/hooks.json");
    if (madeCli) extra.push("/.cursor/cli.json");

    const ignored = applyIgnore(projectDir, extra);
    if (ignored.wrote) written.push(ignored.wrote);
    notes.push(...ignored.notes);

    warnAboutTrackedFiles(projectDir, madeHooks, madeCli, notes);
  }

  return { written, notes };
}

/**
 * Say so when pi merged into a file the project already commits.
 *
 * `.gitignore` does nothing for a tracked file, so an ignore rule here would be
 * a rule that silently fails. The honest move is to name the file and let the
 * user decide.
 */
function warnAboutTrackedFiles(
  projectDir: string,
  madeHooks: boolean,
  madeCli: boolean,
  notes: string[],
): void {
  const shared: string[] = [];
  if (!madeHooks) shared.push(".cursor/hooks.json");
  if (!madeCli) shared.push(".cursor/cli.json");

  const committed = tracked(projectDir, shared);
  if (committed.length === 0) return;

  const one = committed.length === 1;

  notes.push(
    `${committed.join(" and ")} ${one ? "is" : "are"} already tracked by git, and pi merged ` +
      `into ${one ? "it" : "them"}. That edit will show up in your next commit, and ` +
      "`.gitignore` cannot hide a file git already follows. Run `pi uninstall` and then " +
      `\`git checkout -- ${committed.join(" ")}\` if you would rather it never appeared.`,
  );
}

// ── Merging ─────────────────────────────────────────────────────────────────

type HookEntry = { command: string };

/** Returns true when pi created the file, rather than merging into one. */
function mergeHooks(
  path: string,
  ours: Record<string, HookEntry[]>,
  written: string[],
  notes: string[],
): boolean {
  const isOurFile = !existsSync(path);
  const existing = readJson(path);
  const hooks: Record<string, HookEntry[]> =
    (existing?.hooks as Record<string, HookEntry[]>) ?? {};

  let replaced = 0;

  for (const [event, entries] of Object.entries(ours)) {
    const current = Array.isArray(hooks[event]) ? hooks[event]! : [];

    // Drop any previous pi entry for this event so reinstalling after moving
    // the pi installation does not leave a hook pointing at the old path.
    const foreign = current.filter((entry) => !isOurs(entry));
    replaced += current.length - foreign.length;

    hooks[event] = [...foreign, ...entries];

    if (foreign.length > 0) {
      notes.push(`Kept ${foreign.length} existing ${event} hook(s) alongside pi's.`);
    }
  }

  writeJson(path, { ...(existing ?? {}), version: existing?.version ?? 1, hooks });
  written.push(".cursor/hooks.json");

  if (replaced > 0) notes.push(`Replaced ${replaced} stale pi hook(s) from a previous install.`);

  return isOurFile;
}

/** Is this hook entry one pi wrote? Matched on the adapter path it invokes. */
const ADAPTER_PATTERN = /harness[\\/]cursor[\\/]adapter\.ts/;

function isOurs(entry: HookEntry): boolean {
  return typeof entry?.command === "string" && ADAPTER_PATTERN.test(entry.command);
}

/**
 * Pre-approve running `pi`, so the conductor's loop does not prompt on every
 * call. Nothing else is touched: widening a project's permissions beyond what
 * pi needs is not the installer's business.
 */
function mergePermissions(path: string, written: string[], notes: string[]): boolean {
  const isOurFile = !existsSync(path);
  const existing = readJson(path) ?? {};
  const permissions = (existing.permissions as Record<string, unknown>) ?? {};
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];

  const grant = "Shell(pi)";
  if (allow.includes(grant)) {
    notes.push(`${grant} was already allowed.`);
    return isOurFile;
  }

  writeJson(path, {
    ...existing,
    permissions: { ...permissions, allow: [...allow, grant] },
  });
  written.push(".cursor/cli.json");

  return isOurFile;
}

function copyInto(source: string, target: string, projectDir: string, written: string[]): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  written.push(target.slice(projectDir.length + 1));
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch (cause) {
    throw new InstallError(
      `${path} is not valid JSON, so it cannot be merged into: ${(cause as Error).message}`,
    );
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

// ── Uninstalling ────────────────────────────────────────────────────────────

export type UninstallResult = {
  /** Files changed or deleted, relative to the project. */
  removed: string[];
  /** Things the user should know: what was kept, and what was left behind. */
  notes: string[];
};

/**
 * Take pi back out of a project's configuration.
 *
 * The exact inverse of `install`, and no more than that. It removes the hooks,
 * the permission, the skill, and the rule — the files pi wrote and can write
 * again. It does not touch `pi/`, because config, workflows, and run history
 * are yours; an uninstaller that deleted your audit trail would be one you
 * could not risk running.
 */
export type UninstallOptions = {
  /**
   * Also delete `pi.config.json` and `pi/` — the project's configuration,
   * its workflow overrides, and every run it has ever recorded.
   */
  purge?: boolean;
};

export function uninstall(
  projectDir: string,
  harness: string,
  options: UninstallOptions = {},
): UninstallResult {
  requireHarness(harness);

  const removed: string[] = [];
  const notes: string[] = [];
  const cursorDir = join(projectDir, ".cursor");

  unmergeHooks(join(cursorDir, "hooks.json"), projectDir, removed, notes);
  revokePermission(join(cursorDir, "cli.json"), projectDir, removed, notes);

  deleteIfPresent(join(cursorDir, "skills", "pi"), projectDir, removed);
  deleteIfPresent(join(cursorDir, "rules", "pi.mdc"), projectDir, removed);

  // Innermost first, so emptying `skills/` can leave `.cursor/` empty in turn.
  pruneEmpty(
    [join(cursorDir, "skills"), join(cursorDir, "rules"), cursorDir],
    projectDir,
    removed,
  );

  if (options.purge) purgeProject(projectDir, removed, notes);

  const left = [CONFIG_FILE, "pi/"].filter((path) =>
    existsSync(join(projectDir, path.replace(/\/$/, ""))),
  );

  if (left.length === 0) {
    const unignored = revokeIgnore(projectDir);
    if (unignored) removed.push(unignored);
  } else {
    // The ignore block outlives the install on purpose: these files are still
    // sitting in the project, and un-ignoring them now is how they end up in
    // somebody's commit.
    notes.push(
      `Left ${left.join(" and ")} alone: your config, workflows, and run history ` +
        "live there. Use --purge to delete those too.",
    );
    notes.push("Kept pi's .gitignore block, so what is left stays out of your commits.");
  }

  return { removed, notes };
}

/**
 * Delete the project's own pi files: config, workflows, and run history.
 *
 * Separated behind a flag rather than folded into the default because this is
 * the one part of an uninstall that destroys something that cannot be made
 * again. Hooks and skills can be rewritten by `pi install`; a run's audit trail
 * cannot be rewritten by anything.
 */
function purgeProject(projectDir: string, removed: string[], notes: string[]): void {
  const runs = countRuns(projectDir);

  if (existsSync(join(projectDir, CONFIG_FILE))) {
    rmSync(join(projectDir, CONFIG_FILE));
    removed.push(CONFIG_FILE);
  }

  if (existsSync(join(projectDir, "pi"))) {
    rmSync(join(projectDir, "pi"), { recursive: true });
    removed.push(runs > 0 ? `pi/ (${runs} run(s) discarded)` : "pi/");
  }

  if (runs > 0) notes.push(`${runs} run(s) of history were deleted. That cannot be undone.`);
}

function countRuns(projectDir: string): number {
  const dir = join(projectDir, "pi", "runs");
  if (!existsSync(dir)) return 0;

  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

/**
 * Strip pi's hooks out, leaving every other hook exactly where it was.
 *
 * Install merges into this file rather than owning it, so uninstall has to
 * unpick rather than delete. Removing a project's unrelated hooks because pi
 * happened to share the file would be unforgivable.
 */
function unmergeHooks(
  path: string,
  projectDir: string,
  removed: string[],
  notes: string[],
): void {
  const existing = readJson(path);
  if (!existing) return;

  const hooks = (existing.hooks as Record<string, HookEntry[]>) ?? {};
  let dropped = 0;
  let kept = 0;

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;

    const foreign = entries.filter((entry) => !isOurs(entry));
    dropped += entries.length - foreign.length;
    kept += foreign.length;

    // An event with nothing left in it is removed entirely, rather than left as
    // an empty array for someone to wonder about later.
    if (foreign.length === 0) delete hooks[event];
    else hooks[event] = foreign;
  }

  if (dropped === 0) return;

  const rest = { ...existing };
  delete rest.hooks;
  delete rest.version;

  // If all that is left is the empty shell pi created, take the file with it.
  // If the project had anything else in there, keep the file and just rewrite.
  if (Object.keys(hooks).length === 0 && Object.keys(rest).length === 0) {
    rmSync(path);
    removed.push(relative(projectDir, path));
  } else {
    writeJson(path, { ...existing, hooks });
    removed.push(`${relative(projectDir, path)} (${dropped} pi hook(s) removed)`);
  }

  if (kept > 0) notes.push(`Kept ${kept} hook(s) that were not pi's.`);
}

/** Take back the `Shell(pi)` grant, and nothing else in the file. */
function revokePermission(
  path: string,
  projectDir: string,
  removed: string[],
  notes: string[],
): void {
  const existing = readJson(path);
  if (!existing) return;

  const permissions = (existing.permissions as Record<string, unknown>) ?? {};
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];

  const grant = "Shell(pi)";
  if (!allow.includes(grant)) return;

  const remaining = allow.filter((entry) => entry !== grant);

  // Same rule as hooks.json: if the only thing in here was pi's grant, the file
  // is pi's leftover and goes with it. An empty `{"permissions":{"allow":[]}}`
  // is litter that outlives the tool that wrote it.
  const otherPermissions = Object.keys(permissions).filter((key) => key !== "allow");
  const otherKeys = Object.keys(existing).filter((key) => key !== "permissions");

  if (remaining.length === 0 && otherPermissions.length === 0 && otherKeys.length === 0) {
    rmSync(path);
    removed.push(relative(projectDir, path));
    return;
  }

  writeJson(path, { ...existing, permissions: { ...permissions, allow: remaining } });
  removed.push(`${relative(projectDir, path)} (${grant} revoked)`);

  if (remaining.length > 0) {
    notes.push(`Left ${remaining.length} other permission(s) in place.`);
  }
}

/**
 * Delete a directory only if it is empty, and its parents while they are too.
 *
 * Removing pi's skill leaves `.cursor/skills/` behind, and removing everything
 * leaves `.cursor/` behind. Neither belongs to pi once pi is gone, but neither
 * is anyone else's either when there is nothing in it.
 */
function pruneEmpty(dirs: readonly string[], projectDir: string, removed: string[]): void {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    if (readdirSync(dir).length > 0) continue;

    rmSync(dir, { recursive: true });
    removed.push(`${relative(projectDir, dir)}/`);
  }
}

function deleteIfPresent(path: string, projectDir: string, removed: string[]): void {
  if (!existsSync(path)) return;

  rmSync(path, { recursive: true, force: true });
  removed.push(relative(projectDir, path));
}

/** Is pi wired into this project's Cursor configuration? */
export function isInstalled(projectDir: string, harness: string): boolean {
  if (harness !== "cursor") return false;

  const hooks = readJson(join(projectDir, ".cursor", "hooks.json"));
  const events = (hooks?.hooks as Record<string, HookEntry[]>) ?? {};

  return Object.values(events).some((entries) => entries.some(isOurs));
}

// Keeping pi out of other people's commits.
//
// pi writes into a project it does not own. Until a team has actually decided
// to adopt it, none of that belongs in a pull request: nobody reviewing a
// change asked to also review someone else's run history, and a stray
// `pi.config.json` in a diff is a decision made by accident.
//
// The entries live in a marked block so `pi uninstall` can take out exactly
// what `pi install` put in, and so anything hand-written around the block
// survives untouched.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BEGIN = "# >>> pi >>>";
export const END = "# <<< pi <<<";

/**
 * Paths pi owns outright, in every project.
 *
 * Anchored with a leading `/` so they match at the project root and not, say, a
 * `pi/` directory that happens to exist somewhere in a source tree.
 */
export const OWNED: readonly string[] = [
  // Run history only. `pi/workflows/` and `pi/agents/` are authored content —
  // a team's own workflows and persona overrides — and hiding those would mean
  // pi's extension points could never be committed.
  "/pi/runs/",
  "/pi.config.json",
  "/.cursor/skills/pi/",
  "/.cursor/rules/pi.mdc",
];

/**
 * Files pi ignores only when it created them, remembered across installs.
 *
 * Anything else in a stale block is dropped on reinstall, so this list can
 * change between versions without leaving entries nobody can account for.
 */
const REMEMBERED: readonly string[] = ["/.cursor/hooks.json", "/.cursor/cli.json"];

export function renderBlock(paths: readonly string[]): string {
  return [
    BEGIN,
    "# Written by `pi install`, removed by `pi uninstall`.",
    "# Delete this block by hand once the team decides to commit pi's config.",
    ...paths,
    END,
  ].join("\n");
}

export function hasBlock(text: string): boolean {
  const lines = text.split("\n");
  const start = lines.indexOf(BEGIN);
  return start !== -1 && lines.indexOf(END, start) !== -1;
}

/**
 * The paths an existing block already lists.
 *
 * This is pi's memory of which shared files it created. On a reinstall,
 * `.cursor/hooks.json` exists — because pi wrote it last time — and looks
 * indistinguishable from a file the project owns. The block is the record that
 * tells them apart, and without it a second install would quietly un-ignore
 * everything the first one made.
 */
export function blockPaths(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(BEGIN);
  if (start === -1) return [];

  const end = lines.indexOf(END, start);
  if (end === -1) return [];

  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** The file's text with pi's block taken out, and nothing else changed. */
export function withoutBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(BEGIN);
  if (start === -1) return text;

  const end = lines.indexOf(END, start);
  // Half a block means someone edited it by hand. Leaving a stray marker is
  // better than guessing where the block was meant to stop and eating the rest
  // of their file.
  if (end === -1) return text;

  lines.splice(start, end - start + 1);
  return tidy(lines.join("\n"));
}

/** The file's text with pi's block present and listing exactly `paths`. */
export function withBlock(text: string, paths: readonly string[]): string {
  const base = tidy(withoutBlock(text));
  const block = renderBlock(paths);

  return base.length > 0 ? `${base}\n${block}\n` : `${block}\n`;
}

/** Collapse the blank runs an edit leaves behind; end on exactly one newline. */
function tidy(text: string): string {
  const body = text.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  return body.length > 0 ? `${body}\n` : "";
}

// ── Applying it to a project ────────────────────────────────────────────────

export type IgnoreResult = {
  /** Description of the change, or null when nothing needed doing. */
  wrote: string | null;
  notes: string[];
};

/**
 * Put pi's paths in the project's `.gitignore`.
 *
 * `extra` carries the shared files pi created this run — `.cursor/hooks.json`
 * and `.cursor/cli.json` when the project had none. Those are only ignorable
 * because pi made them; when pi merged into a file that was already there, the
 * file is the project's and pi has no business hiding it.
 */
export function applyIgnore(projectDir: string, extra: readonly string[]): IgnoreResult {
  const notes: string[] = [];

  if (!isRepo(projectDir)) {
    return { wrote: null, notes: ["Not a git repository, so there was nothing to ignore."] };
  }

  const path = join(projectDir, ".gitignore");
  const before = existsSync(path) ? readFileSync(path, "utf-8") : "";

  // Union with the shared files the block already claims, so reinstalling never
  // gives back a path a previous install took responsibility for.
  const claimed = blockPaths(before).filter((path) => REMEMBERED.includes(path));
  const paths = [...new Set([...OWNED, ...claimed, ...extra])];
  const after = withBlock(before, paths);

  if (after === before) return { wrote: null, notes };

  writeFileSync(path, after, "utf-8");

  const wrote = hasBlock(before)
    ? ".gitignore (pi's block updated)"
    : `.gitignore (${paths.length} path(s) ignored)`;

  return { wrote, notes };
}

/** Take pi's block back out. Deletes a `.gitignore` that held nothing else. */
export function revokeIgnore(projectDir: string): string | null {
  const path = join(projectDir, ".gitignore");
  if (!existsSync(path)) return null;

  const before = readFileSync(path, "utf-8");
  if (!hasBlock(before)) return null;

  const after = withoutBlock(before);

  if (after.trim().length === 0) {
    rmSync(path);
    return ".gitignore";
  }

  writeFileSync(path, after, "utf-8");
  return ".gitignore (pi's block removed)";
}

/**
 * Which of these paths git already tracks.
 *
 * Worth asking because `.gitignore` has no effect on a tracked file. If a
 * project commits its `.cursor/hooks.json`, pi merging into it *will* show up
 * in the next diff, and saying so is better than adding an ignore rule that
 * quietly does nothing.
 */
export function tracked(projectDir: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];

  try {
    const out = execFileSync("git", ["ls-files", "--", ...paths], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function isRepo(projectDir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

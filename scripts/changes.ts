// What has happened since the last tag, and what the changelog does not mention.
//
//   node scripts/changes.ts          commits since the last tag, and a draft
//   node scripts/changes.ts --all    every commit, not only the unmentioned ones
//
// This drafts; it does not write. Commits and changelogs answer different
// questions — a commit explains a change to someone reading the code, a
// changelog tells a user what they can now do — and a file generated from the
// other one reads like it. "Refactor the state store" is a true commit message
// and a useless release note.
//
// So the job here is to make sure nothing user-visible was forgotten, not to
// write the entry for you.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { unreleasedBody } from "./changelog.ts";

export type Commit = {
  hash: string;
  short: string;
  subject: string;
  /** The Conventional Commits type, when the subject happens to carry one. */
  type?: string;
  /** The subject with any `type(scope):` prefix removed. */
  summary: string;
};

const CONVENTIONAL = /^(\w+)(\([^)]*\))?!?:\s*(.+)$/;

/**
 * Which Keep a Changelog heading a commit belongs under.
 *
 * Conventional Commit types map cleanly. Anything else is a guess from the
 * verb, which is why the output is a draft you edit rather than a file we write.
 */
const HEADINGS: Record<string, string> = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  revert: "Changed",
  docs: "Documentation",
  test: "Internal",
  chore: "Internal",
  build: "Internal",
  ci: "Internal",
  style: "Internal",
};

/** Headings whose contents are usually not worth telling a user about. */
export const INTERNAL_HEADINGS = new Set(["Internal"]);

function git(root: string, ...args: string[]): string {
  // stderr is captured rather than inherited: the callers below treat a failing
  // git as a normal answer ("no tags yet"), and a tool that prints `fatal:` on
  // a path it handles fine is a tool people stop reading.
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** The newest version tag, or undefined before the first release. */
export function lastTag(root: string): string | undefined {
  try {
    return git(root, "describe", "--tags", "--abbrev=0", "--match", "v*") || undefined;
  } catch {
    // No tags yet. Not a problem — it just means "since the beginning".
    return undefined;
  }
}

export function parseCommit(line: string): Commit | undefined {
  const [hash, ...rest] = line.split(" ");
  if (!hash) return undefined;

  const subject = rest.join(" ").trim();
  if (subject === "") return undefined;

  const match = CONVENTIONAL.exec(subject);
  return {
    hash,
    short: hash.slice(0, 7),
    subject,
    type: match?.[1],
    summary: match?.[3] ?? subject,
  };
}

/** Commits on this branch since the last tag, newest first. */
export function commitsSince(root: string, tag = lastTag(root)): Commit[] {
  const range = tag ? `${tag}..HEAD` : "HEAD";

  let out: string;
  try {
    out = git(root, "log", range, "--no-merges", "--format=%H %s");
  } catch {
    // An empty repository has no HEAD to log.
    return [];
  }

  return out === "" ? [] : out.split("\n").flatMap((line) => parseCommit(line) ?? []);
}

/**
 * Commits whose subject does not appear to be described in the notes.
 *
 * Deliberately crude: it looks for the distinctive words of the commit summary
 * in the notes text. A changelog is written in different words than a commit
 * message, so this will have false positives — which is exactly why it prints a
 * list to check rather than blocking anything.
 */
export function uncovered(commits: readonly Commit[], notes: string): Commit[] {
  const haystack = notes.toLowerCase();

  return commits.filter((commit) => {
    if (commit.type && INTERNAL_HEADINGS.has(HEADINGS[commit.type] ?? "")) return false;

    const words = distinctiveWords(commit.summary);
    // One word is not enough to judge on. "Update the code" leaves only "code"
    // to match, and reporting that as undocumented is a guess dressed up as a
    // finding — which is how advisory output gets ignored.
    if (words.length < 2) return false;

    const hits = words.filter((word) => haystack.includes(word)).length;
    return hits / words.length < 0.5;
  });
}

const NOISE = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "from",
  "add", "adds", "added", "adding", "fix", "fixes", "fixed", "update", "updates",
  "updated", "create", "created", "creates", "make", "makes", "made", "use",
  "uses", "used", "new", "support", "this", "that", "it", "is", "be", "so",
]);

function distinctiveWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((word) => word.length > 3 && !NOISE.has(word)),
    ),
  ];
}

/** Group commits under the changelog heading each one probably belongs to. */
export function draft(commits: readonly Commit[]): Map<string, Commit[]> {
  const groups = new Map<string, Commit[]>();

  for (const commit of commits) {
    const heading = (commit.type && HEADINGS[commit.type]) ?? "Uncategorised";
    groups.set(heading, [...(groups.get(heading) ?? []), commit]);
  }

  return groups;
}

// ── Script ──────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const root = join(import.meta.dirname, "..");
  const all = process.argv.includes("--all");

  const tag = lastTag(root);
  const commits = commitsSince(root, tag);
  const notes = unreleasedBody(readFileSync(join(root, "CHANGELOG.md"), "utf-8"));
  const missing = uncovered(commits, notes);
  const shown = all ? commits : missing;

  console.log(`${commits.length} commit(s) since ${tag ?? "the beginning"}.`);

  if (commits.length === 0) {
    console.log("Nothing to write up.");
    process.exit(0);
  }

  if (missing.length === 0 && !all) {
    console.log("Every commit looks mentioned in the Unreleased notes.");
    console.log("Re-run with --all to see them anyway.");
    process.exit(0);
  }

  console.log(
    all
      ? ""
      : `\n${missing.length} of them are not obviously mentioned in the Unreleased notes.` +
        "\nThis is a guess based on wording, so expect some false alarms.\n",
  );

  // Printed in changelog shape so the lines worth keeping can be moved across
  // as they are, and the rest deleted.
  for (const [heading, group] of draft(shown)) {
    console.log(`### ${heading}`);
    console.log("");
    for (const commit of group) console.log(`- ${commit.summary}  (${commit.short})`);
    console.log("");
  }

  console.log("Edit these into CHANGELOG.md under ## [Unreleased]; drop what no user would notice.");
}

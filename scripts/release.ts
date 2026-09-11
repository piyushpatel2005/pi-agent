// Cut a release: bump the version, close the changelog section, commit, tag.
//
//   node scripts/release.ts 0.1.0         show what would happen; change nothing
//   node scripts/release.ts 0.1.0 --yes   do it
//
// Dry run by default, like `pi rewind`, because a tag is a promise other people
// may already have fetched. It stops short of pushing for the same reason: it
// prints the push command and leaves you to be the one who says it.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  UNRELEASED,
  closeUnreleased,
  isAhead,
  isPrerelease,
  isVersion,
  unreleasedBody,
} from "./changelog.ts";
import { commitsSince, uncovered } from "./changes.ts";

const ROOT = join(import.meta.dirname, "..");
const PACKAGE = join(ROOT, "package.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

// ── What was asked for ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const apply = argv.includes("--yes");
const target = argv.find((arg) => !arg.startsWith("--"));

if (!target) {
  console.error("Usage: node scripts/release.ts <version> [--yes]");
  console.error("Example: node scripts/release.ts 0.1.0");
  process.exit(2);
}

if (!isVersion(target)) {
  fail(`"${target}" is not a version. Expected MAJOR.MINOR.PATCH, e.g. 0.1.0`);
}

const tag = `v${target}`;
const pkg = JSON.parse(readFileSync(PACKAGE, "utf-8"));
const current: string = pkg.version;

if (!isAhead(target, current)) {
  fail(`${target} does not follow the current ${current}`);
}

// ── Refuse to ship something nobody can reproduce ───────────────────────────

const changelog = readFileSync(CHANGELOG, "utf-8");
const problems: string[] = [];

if (git("status", "--porcelain") !== "") {
  // A tag names a commit. Uncommitted work is not in that commit, so a release
  // cut from a dirty tree points at something that never existed on its own.
  problems.push("the working tree is dirty; commit or stash first");
}

if (git("tag", "--list", tag) !== "") {
  problems.push(`tag ${tag} already exists`);
}

if (!changelog.includes(UNRELEASED)) {
  problems.push(`CHANGELOG.md has no "${UNRELEASED}" section to release`);
} else if (unreleasedBody(changelog).trim() === "") {
  problems.push(`the ${UNRELEASED} section is empty; a release with no notes helps nobody`);
}

// ── The plan ────────────────────────────────────────────────────────────────
//
// Printed before the blockers, and printed even when there are some: the point
// of a dry run is to see what a release would contain, and needing a clean tree
// before you can look at it would be backwards.

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const date = new Date().toISOString().slice(0, 10);
const pre = isPrerelease(target);

console.log(
  `${pre ? "Prerelease" : "Release"} ${current} → ${target}   tag ${tag}, branch ${branch}`,
);
console.log("");
console.log("  package.json   version bumped");
console.log(
  pre
    // A release candidate is a snapshot of work still in progress, so its notes
    // stay under Unreleased. Consuming them here would leave the real release
    // with nothing to say, which is the opposite of what an RC is for.
    ? `  CHANGELOG.md   untouched; notes stay under "${UNRELEASED}"`
    : `  CHANGELOG.md   "${UNRELEASED}" closed as "[${target}] - ${date}"`,
);
console.log(`  git commit     Release ${target}`);
console.log(`  git tag        ${tag} (annotated)`);
console.log("");
console.log(pre ? "Notes so far (staying under Unreleased):" : "Release notes:");
for (const line of unreleasedBody(changelog).trim().split("\n")) {
  console.log(`  ${line}`);
}
console.log("");

// Advisory, never blocking. A commit with no changelog line is usually an
// internal change that earns no entry, and a release tool that insisted
// otherwise would just teach people to write filler.
const missing = uncovered(commitsSince(ROOT), unreleasedBody(changelog));
if (missing.length > 0) {
  console.log(`${missing.length} commit(s) since the last tag are not mentioned in the notes:`);
  for (const commit of missing) console.log(`  ? ${commit.short}  ${commit.subject}`);
  console.log("");
  console.log("  Add anything user-visible with: npm run changes");
  console.log("");
}

if (problems.length > 0) {
  console.log(`Not ready to release (${problems.length}):`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  console.log("");
  process.exit(1);
}

if (!apply) {
  console.log("Nothing changed. Re-run with --yes to apply.");
  process.exit(0);
}

// ── Verify, then apply ──────────────────────────────────────────────────────

// The slow checks run here rather than in the plan, so a dry run stays instant
// and the authoritative pass happens once, immediately before tagging.
const checks: [string, string[]][] = [
  ["typecheck", [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]],
  ["tests", ["--test"]],
];

for (const [name, args] of checks) {
  process.stdout.write(`Running ${name}... `);
  try {
    execFileSync(process.execPath, args, { cwd: ROOT, stdio: "pipe" });
    console.log("ok");
  } catch {
    console.log("FAILED");
    fail(`${name} failed; not tagging. Run it yourself to see why.`);
  }
}

pkg.version = target;
writeFileSync(PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");

if (pre) {
  git("add", "package.json");
} else {
  writeFileSync(CHANGELOG, closeUnreleased(changelog, target, date), "utf-8");
  git("add", "package.json", "CHANGELOG.md");
}

git("commit", "-m", `Release ${target}`);
git("tag", "-a", tag, "-m", `pi ${target}`);

console.log("");
console.log(`Tagged ${tag}. Nothing has been pushed.`);
console.log("");
console.log(`  git push origin ${branch} ${tag}`);

if (pre) {
  console.log("");
  console.log(`When ${target.split("-")[0]} is ready, release it normally; the notes are still`);
  console.log(`under ${UNRELEASED} waiting for it.`);
}

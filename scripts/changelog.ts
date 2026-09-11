// The pure half of cutting a release: reading and re-heading the changelog, and
// deciding whether one version follows another.
//
// Split out from `release.ts` for the same reason the router splits `next()`
// from `applyReport()`: these are the parts worth testing as a table of inputs
// and outputs, and they should not require a git repository to exercise.

export const UNRELEASED = "## [Unreleased]";

/** The text between the Unreleased heading and the next version heading. */
export function unreleasedBody(text: string): string {
  const start = text.indexOf(UNRELEASED);
  if (start === -1) return "";

  const after = start + UNRELEASED.length;
  const next = text.slice(after).search(/^## \[/m);
  return next === -1 ? text.slice(after) : text.slice(after, after + next);
}

/**
 * Rename the Unreleased heading to this version and open an empty one above it.
 *
 * The notes themselves are not rewritten, only re-headed, so what you read in
 * the dry run is exactly what ships.
 */
export function closeUnreleased(text: string, version: string, date: string): string {
  return text.replace(UNRELEASED, `${UNRELEASED}\n\n## [${version}] - ${date}`);
}

/**
 * The notes under one release's heading.
 *
 * Returns "" when the version has no heading or nothing written under it. The
 * last section in the file is the case worth being careful about: there is no
 * following heading to stop at, so it runs to the end.
 */
export function releaseNotes(text: string, version: string): string {
  const heading = text.indexOf(`## [${version}]`);
  if (heading === -1) return "";

  // Start after the heading's own line, so the date is not mistaken for notes.
  const start = text.indexOf("\n", heading);
  if (start === -1) return "";

  const rest = text.slice(start);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The most recent released version in the changelog, ignoring Unreleased. */
export function latestRelease(text: string): string | undefined {
  return /^## \[(\d+\.\d+\.\d+[0-9A-Za-z.-]*)\]/m.exec(text)?.[1];
}

/** Every version heading, in the order they appear. */
export function releasedVersions(text: string): string[] {
  return [...text.matchAll(/^## \[(\d+\.\d+\.\d+[0-9A-Za-z.-]*)\]/gm)].map((match) => match[1]!);
}

export function isVersion(value: string): boolean {
  // Plain SemVer, optionally with a prerelease tag. Build metadata is excluded:
  // it does not affect precedence and only complicates the tag name.
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value);
}

/** Is this version a prerelease — an `-rc.1`, `-beta.2`, and so on? */
export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

/** SemVer precedence: a release must move forward. */
export function isAhead(next: string, previous: string): boolean {
  const numbers = (value: string) =>
    value.split("-")[0]!.split(".").map((piece) => Number.parseInt(piece, 10));

  const [a, b] = [numbers(next), numbers(previous)];
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }

  // Same numbers, so the prerelease tags decide. A version with no tag outranks
  // one that has any, which is what makes 1.0.0 follow 1.0.0-rc.2.
  return comparePrerelease(next.split("-").slice(1).join("-"), previous.split("-").slice(1).join("-")) > 0;
}

/**
 * SemVer §11.4 precedence for the prerelease tag: compare dot-separated
 * identifiers left to right, numbers numerically and below text, and a shorter
 * run of identifiers below a longer one that starts the same way.
 *
 * Without this you can cut `rc.1` and then find `rc.2` refused, because the
 * numeric parts are identical and nothing else is looking.
 */
export function comparePrerelease(next: string, previous: string): number {
  if (next === previous) return 0;
  // An absent tag is the finished release, which outranks every prerelease.
  if (next === "") return 1;
  if (previous === "") return -1;

  const a = next.split(".");
  const b = previous.split(".");

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;

    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return Number(x) - Number(y);
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }

  return 0;
}

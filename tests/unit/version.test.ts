import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  closeUnreleased,
  comparePrerelease,
  isAhead,
  isPrerelease,
  isVersion,
  latestRelease,
  releaseNotes,
  releasedVersions,
  unreleasedBody,
} from "../../scripts/changelog.ts";
import { draft, parseCommit, uncovered, type Commit } from "../../scripts/changes.ts";
import { VERSION, versionInfo } from "../../core/version.ts";
import { CONFIG_VERSION } from "../../core/schemas/config.ts";
import { STATE_VERSION } from "../../core/schemas/state.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf-8");

describe("the release version has one home", () => {
  test("VERSION is whatever package.json says", () => {
    assert.equal(VERSION, pkg.version);
  });

  test("it is a version, not a placeholder", () => {
    assert.equal(isVersion(VERSION), true, `"${VERSION}" is not valid SemVer`);
  });

  test("versionInfo reports the schema versions it claims to", () => {
    assert.deepEqual(versionInfo(), {
      pi: pkg.version,
      state: STATE_VERSION,
      config: CONFIG_VERSION,
      node: process.versions.node,
    });
  });
});

describe("the changelog keeps up with the version", () => {
  test("every released version appears exactly once", () => {
    const versions = releasedVersions(changelog);
    assert.deepEqual(
      versions,
      [...new Set(versions)],
      "a version heading appears twice; two entries for one release is one too many",
    );
  });

  test("the changelog's newest release is the one in package.json", () => {
    const newest = latestRelease(changelog);

    // A prerelease deliberately leaves its notes under Unreleased so the real
    // release still has something to say, so the two are expected to disagree.
    if (isPrerelease(pkg.version)) {
      assert.notEqual(
        unreleasedBody(changelog).trim(),
        "",
        `package.json is at the prerelease ${pkg.version}, so its notes must be waiting under Unreleased`,
      );
      return;
    }

    // Before the first tag there is nothing released yet, and that is fine.
    // After it, drift between the two is the bug this test exists to catch.
    if (newest === undefined) {
      assert.match(
        changelog,
        /## \[Unreleased\]/,
        "no releases yet, so there must at least be an Unreleased section",
      );
      return;
    }

    assert.equal(
      newest,
      pkg.version,
      `CHANGELOG.md's newest release is ${newest} but package.json says ${pkg.version}`,
    );
  });

  test("released work is described, not just numbered", () => {
    for (const version of releasedVersions(changelog)) {
      assert.notEqual(releaseNotes(changelog, version).trim(), "", `${version} has no notes`);
    }
  });
});

describe("releaseNotes", () => {
  const text = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [0.2.0] - 2026-02-01",
    "",
    "- the newer thing",
    "",
    "## [0.1.0] - 2026-01-01",
    "",
    "- the older thing",
    "",
  ].join("\n");

  test("reads a section that has another heading after it", () => {
    assert.equal(releaseNotes(text, "0.2.0").trim(), "- the newer thing");
  });

  test("reads the last section, which has no heading to stop at", () => {
    // The case that broke: with nothing following, there is no next heading to
    // find, and the naive version returned a single character instead.
    assert.equal(releaseNotes(text, "0.1.0").trim(), "- the older thing");
  });

  test("does not mistake the heading's own date for notes", () => {
    assert.doesNotMatch(releaseNotes(text, "0.2.0"), /2026-02-01/);
  });

  test("is empty for a version with no heading, and one with no notes", () => {
    assert.equal(releaseNotes(text, "9.9.9"), "");
    assert.equal(releaseNotes("## [0.1.0] - 2026-01-01\n\n## [0.0.9] - 2025-01-01\n", "0.1.0").trim(), "");
  });
});

describe("unreleasedBody", () => {
  test("reads the section up to the next release heading", () => {
    const text = "# Changelog\n\n## [Unreleased]\n\n- new thing\n\n## [0.1.0] - 2026-01-01\n\n- old\n";
    assert.equal(unreleasedBody(text).trim(), "- new thing");
  });

  test("reads to the end when nothing has been released yet", () => {
    assert.equal(unreleasedBody("## [Unreleased]\n\n- first\n").trim(), "- first");
  });

  test("is empty when there is no section at all", () => {
    assert.equal(unreleasedBody("# Changelog\n"), "");
  });
});

describe("closeUnreleased", () => {
  test("re-heads the notes and opens an empty Unreleased above them", () => {
    const text = "## [Unreleased]\n\n- a thing\n";
    const closed = closeUnreleased(text, "0.2.0", "2026-09-11");

    assert.match(closed, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-09-11\n\n- a thing/);
    // The notes are re-headed, never rewritten: what you reviewed is what ships.
    assert.equal(unreleasedBody(closed).trim(), "");
    assert.equal(latestRelease(closed), "0.2.0");
  });
});

describe("isAhead", () => {
  const cases: [string, string, boolean][] = [
    ["0.2.0", "0.1.0", true],
    ["0.1.1", "0.1.0", true],
    ["1.0.0", "0.9.9", true],
    ["0.1.0", "0.1.0", false],
    ["0.1.0", "0.2.0", false],
    ["0.9.9", "1.0.0", false],
    // A prerelease is overtaken by its own release, but not the reverse.
    ["1.0.0", "1.0.0-rc.1", true],
    ["1.0.0-rc.1", "1.0.0", false],
  ];

  for (const [next, previous, expected] of cases) {
    test(`${next} ${expected ? "follows" : "does not follow"} ${previous}`, () => {
      assert.equal(isAhead(next, previous), expected);
    });
  }
});

describe("prereleases", () => {
  const cases: [string, string, boolean][] = [
    // The bug this exists to prevent: cutting rc.1 and then being unable to
    // cut rc.2, because the numeric parts match and nothing else was looking.
    ["1.0.0-rc.2", "1.0.0-rc.1", true],
    ["1.0.0-rc.1", "1.0.0-rc.2", false],
    ["1.0.0-rc.10", "1.0.0-rc.9", true],
    ["1.0.0-beta.1", "1.0.0-alpha.9", true],
    ["1.0.0-alpha.1", "1.0.0-beta.1", false],
    // A finished release follows its own candidates, never the reverse.
    ["1.0.0", "1.0.0-rc.1", true],
    ["1.0.0-rc.1", "1.0.0", false],
    // A candidate for the next version follows the last real release.
    ["0.2.0-rc.1", "0.1.0", true],
    ["0.1.0-rc.1", "0.1.0", false],
    ["1.0.0-rc.1", "1.0.0-rc.1", false],
  ];

  for (const [next, previous, expected] of cases) {
    test(`${next} ${expected ? "follows" : "does not follow"} ${previous}`, () => {
      assert.equal(isAhead(next, previous), expected);
    });
  }

  test("numeric identifiers rank below alphanumeric ones", () => {
    // SemVer §11.4.3. `rc` is text, `1` is a number, so rc wins.
    assert.equal(comparePrerelease("rc", "1") > 0, true);
  });

  test("a shorter run of identifiers ranks below a longer one", () => {
    assert.equal(comparePrerelease("rc.1.1", "rc.1") > 0, true);
    assert.equal(comparePrerelease("rc.1", "rc.1.1") < 0, true);
  });

  test("isPrerelease tells the two kinds apart", () => {
    assert.equal(isPrerelease("1.0.0-rc.1"), true);
    assert.equal(isPrerelease("1.0.0"), false);
  });
});

describe("drafting notes from commits", () => {
  const commit = (subject: string): Commit => {
    const parsed = parseCommit(`abcdef1234567890 ${subject}`);
    assert.ok(parsed, `"${subject}" should parse`);
    return parsed;
  };

  test("reads a Conventional Commit subject into a type and a summary", () => {
    const parsed = commit("feat(cli): add pi rewind");
    assert.equal(parsed.type, "feat");
    assert.equal(parsed.summary, "add pi rewind");
    assert.equal(parsed.short, "abcdef1");
  });

  test("keeps an ordinary subject whole rather than inventing a type", () => {
    const parsed = commit("Added rewind capability");
    assert.equal(parsed.type, undefined);
    assert.equal(parsed.summary, "Added rewind capability");
  });

  test("ignores a line with no subject", () => {
    assert.equal(parseCommit("abcdef1234567890"), undefined);
    assert.equal(parseCommit(""), undefined);
  });

  test("groups commits under the heading their type implies", () => {
    const groups = draft([
      commit("feat: add pi rewind"),
      commit("fix: stop the guard denying reads"),
      commit("Some untyped commit"),
    ]);

    assert.deepEqual([...groups.keys()], ["Added", "Fixed", "Uncategorised"]);
    assert.equal(groups.get("Added")?.[0]?.summary, "add pi rewind");
  });

  test("a commit described in the notes is not reported as missing", () => {
    const notes = "- `pi rewind --to <step>` moves a run back to a checkpoint boundary.";
    assert.deepEqual(uncovered([commit("feat: add pi rewind checkpoint")], notes), []);
  });

  test("a commit nobody wrote up is reported", () => {
    const notes = "- `pi rewind` moves a run back.";
    const missing = uncovered([commit("feat: add a telemetry exporter")], notes);
    assert.equal(missing.length, 1);
    assert.match(missing[0]!.subject, /telemetry/);
  });

  test("internal commits are not expected to have notes", () => {
    // A changelog that lists every chore is a changelog nobody reads.
    for (const subject of ["chore: bump deps", "test: cover the router", "ci: cache node_modules"]) {
      assert.deepEqual(uncovered([commit(subject)], ""), []);
    }
  });

  test("a commit of nothing but noise words is not flagged", () => {
    // Nothing distinctive to match on, so claiming it is undocumented would be
    // a guess dressed up as a finding.
    assert.deepEqual(uncovered([commit("fix: update the code")], ""), []);
  });
});

describe("isVersion", () => {
  test("accepts plain SemVer and prereleases", () => {
    for (const value of ["0.0.1", "1.2.3", "10.20.30", "1.0.0-rc.1", "1.0.0-beta.2"]) {
      assert.equal(isVersion(value), true, value);
    }
  });

  test("rejects what a tag should never be built from", () => {
    for (const value of ["v1.0.0", "1.0", "1", "latest", "1.0.0+build.5", ""]) {
      assert.equal(isVersion(value), false, value);
    }
  });
});

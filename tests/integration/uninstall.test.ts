// Taking pi back out of a project.
//
// The install tests prove pi merges into a project's Cursor config without
// trampling it. These prove the reverse: that it can be unpicked again, and
// that unpicking it leaves everything that was not pi's exactly where it was.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

const CLI = join(import.meta.dirname, "..", "..", "cli", "pi.ts");
const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

function pi(project: string, ...argv: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: project, encoding: "utf-8" });
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
}

/** A project with pi scaffolded, and optionally already wired into Cursor. */
function project(install = true): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-uninstall-"));
  projects.push(dir);

  mkdirSync(join(dir, "pi", "workflows"), { recursive: true });
  writeFileSync(
    join(dir, "pi.config.json"),
    JSON.stringify({ version: 1, harness: "cursor", facts: {} }),
    "utf-8",
  );

  if (install) assert.equal(pi(dir, "install").code, 0);
  return dir;
}

type HookEntry = { command: string };
type HooksFile = { version?: number; hooks: Record<string, HookEntry[]> };
type CliFile = { permissions: { allow: string[] } };

function readJson<T>(dir: string, ...parts: string[]): T {
  return JSON.parse(readFileSync(join(dir, ...parts), "utf-8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

function events(dir: string): Record<string, HookEntry[]> {
  return readJson<HooksFile>(dir, ".cursor", "hooks.json").hooks;
}

function allowed(dir: string): string[] {
  return readJson<CliFile>(dir, ".cursor", "cli.json").permissions.allow;
}

function hooksPath(dir: string): string {
  return join(dir, ".cursor", "hooks.json");
}

describe("pi uninstall", () => {
  test("removes everything install put there", () => {
    const dir = project();

    const { code, out } = pi(dir, "uninstall");
    assert.equal(code, 0, out);

    assert.equal(existsSync(join(dir, ".cursor", "skills", "pi")), false);
    assert.equal(existsSync(join(dir, ".cursor", "rules", "pi.mdc")), false);
    assert.equal(existsSync(hooksPath(dir)), false, "a bare hooks.json goes with it");
    assert.equal(existsSync(join(dir, ".cursor", "cli.json")), false, "and a bare cli.json");
  });

  test("doctor stops reporting the project as wired", () => {
    const dir = project();
    assert.match(pi(dir, "doctor").out, /wired into cursor/);

    pi(dir, "uninstall");
    assert.match(pi(dir, "doctor").out, /not wired into cursor/);
  });

  test("says so plainly when there is nothing to undo", () => {
    const dir = project(false);

    const { code, out } = pi(dir, "uninstall");
    assert.equal(code, 0);
    assert.match(out, /not wired into cursor/);
    assert.doesNotMatch(out, /Removed/);
  });

  test("running it twice is harmless", () => {
    const dir = project();
    assert.equal(pi(dir, "uninstall").code, 0);

    const second = pi(dir, "uninstall");
    assert.equal(second.code, 0);
    assert.match(second.out, /nothing to undo/);
  });

  test("refuses a harness it does not have", () => {
    const dir = project();
    const { code, err } = pi(dir, "uninstall", "--harness", "emacs");
    assert.equal(code, 1);
    assert.match(err, /No harness "emacs"/);
  });

  test("takes the empty husks with it, rather than leaving them behind", () => {
    const dir = project();

    pi(dir, "uninstall");

    // pi wrote every one of these, so when its own entries are gone there is
    // nothing left for them to hold. An empty `{"permissions":{"allow":[]}}`
    // outliving the tool that wrote it is litter.
    assert.equal(existsSync(join(dir, ".cursor", "cli.json")), false);
    assert.equal(existsSync(join(dir, ".cursor", "skills")), false);
    assert.equal(existsSync(join(dir, ".cursor", "rules")), false);
    assert.equal(existsSync(join(dir, ".cursor")), false, "an empty .cursor/ goes too");
  });

  test("keeps .cursor when the project has anything else in it", () => {
    const dir = project();
    writeFileSync(join(dir, ".cursor", "theirs.json"), "{}", "utf-8");

    pi(dir, "uninstall");

    assert.equal(existsSync(join(dir, ".cursor")), true);
    assert.equal(existsSync(join(dir, ".cursor", "theirs.json")), true);
  });

  test("leaves pi/ alone, history and all", () => {
    const dir = project();
    assert.equal(pi(dir, "start", "Add orders", "--workflow", "feature").code, 0);

    const { out } = pi(dir, "uninstall");
    assert.match(out, /Left pi\.config\.json and pi\/ alone/);

    assert.equal(existsSync(join(dir, "pi.config.json")), true);
    assert.equal(existsSync(join(dir, "pi", "runs")), true);
  });
});

describe("pi uninstall --purge", () => {
  test("takes the config and the history too", () => {
    const dir = project();
    assert.equal(pi(dir, "start", "Add orders", "--workflow", "feature").code, 0);

    const { code, out } = pi(dir, "uninstall", "--purge");
    assert.equal(code, 0, out);
    assert.match(out, /pi\.config\.json/);
    assert.match(out, /pi\/ \(1 run\(s\) discarded\)/);
    assert.match(out, /cannot be undone/);

    assert.equal(existsSync(join(dir, "pi.config.json")), false);
    assert.equal(existsSync(join(dir, "pi")), false);
    assert.equal(existsSync(join(dir, ".cursor")), false);
  });

  test("works after a plain uninstall has already unwired it", () => {
    // The order someone actually follows: unwire, then decide the rest can go.
    const dir = project();
    assert.equal(pi(dir, "uninstall").code, 0);
    assert.equal(existsSync(join(dir, "pi.config.json")), true);

    const { code, out } = pi(dir, "uninstall", "--purge");
    assert.equal(code, 0, out);
    assert.equal(existsSync(join(dir, "pi.config.json")), false);

    // No hooks came out this time, so it should not talk about hooks.
    assert.doesNotMatch(out, /Restart/);
  });

  test("says so when there is genuinely nothing left", () => {
    const dir = project();
    pi(dir, "uninstall", "--purge");

    const { code, out } = pi(dir, "uninstall", "--purge");
    assert.equal(code, 0);
    assert.match(out, /Nothing of pi's was found/);
  });

  test("without --purge, points at the flag rather than staying silent", () => {
    const dir = project();
    pi(dir, "uninstall");

    const { out } = pi(dir, "uninstall");
    assert.match(out, /nothing to undo/);
    assert.match(out, /--purge/);
  });
});

describe("uninstall and the project's own config", () => {
  /** Wire pi in, then add hooks and permissions of the project's own. */
  function shared(): string {
    const dir = project();

    const hooks = readJson<HooksFile>(dir, ".cursor", "hooks.json");
    // Theirs in an event pi also uses, and theirs in an event pi never touches.
    hooks.hooks.preToolUse!.unshift({ command: "echo theirs" });
    hooks.hooks.afterFileEdit = [{ command: "echo mine" }];
    writeJson(hooksPath(dir), hooks);

    const cli = readJson<CliFile>(dir, ".cursor", "cli.json");
    cli.permissions.allow.unshift("Shell(ls)");
    writeJson(join(dir, ".cursor", "cli.json"), cli);

    return dir;
  }

  test("removes pi's hooks and keeps the project's", () => {
    const dir = shared();

    const { out } = pi(dir, "uninstall");
    assert.match(out, /Kept 2 hook\(s\) that were not pi's/);

    const after = events(dir);
    assert.deepEqual(after.preToolUse, [{ command: "echo theirs" }]);
    assert.deepEqual(after.afterFileEdit, [{ command: "echo mine" }]);
  });

  test("drops an event whose only hook was pi's, rather than leaving it empty", () => {
    const dir = shared();
    pi(dir, "uninstall");

    const after = events(dir);

    // pi owned all of these outright, so the keys go too — an empty array left
    // behind is litter someone has to puzzle over later.
    for (const event of ["sessionStart", "beforeSubmitPrompt", "postToolUse", "stop"]) {
      assert.equal(event in after, false, `${event} should be gone, not empty`);
    }
  });

  test("keeps a hooks.json that still has something in it", () => {
    const dir = shared();
    pi(dir, "uninstall");
    assert.equal(existsSync(hooksPath(dir)), true);
  });

  test("revokes only pi's permission", () => {
    const dir = shared();

    const { out } = pi(dir, "uninstall");
    assert.match(out, /Shell\(pi\) revoked/);

    assert.deepEqual(allowed(dir), ["Shell(ls)"]);
  });

  test("a project's foreign hooks survive a full install–uninstall round trip", () => {
    const dir = shared();
    const before = readFileSync(hooksPath(dir), "utf-8");

    pi(dir, "uninstall");
    assert.equal(pi(dir, "install").code, 0);
    pi(dir, "uninstall");
    assert.equal(pi(dir, "install").code, 0);

    const after = events(dir);

    // Their hooks are still there, still first, and have not multiplied.
    assert.equal(after.preToolUse![0]!.command, "echo theirs");
    assert.equal(after.preToolUse!.length, 2, "one theirs, one pi's");
    assert.deepEqual(after.afterFileEdit, [{ command: "echo mine" }]);
    assert.notEqual(before, "", "sanity: the fixture wrote something");
  });
});

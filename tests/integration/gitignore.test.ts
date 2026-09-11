// Staying out of the project's commits.
//
// pi writes into a repository it does not own, and until a team decides to
// adopt it none of that should reach a pull request. The measure that matters
// is `git status`: after installing pi and running work through it, a real
// repository should look untouched apart from .gitignore itself.

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

function pi(project: string, ...argv: string[]): { code: number; out: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: project, encoding: "utf-8" });
  return { code: result.status ?? 1, out: result.stdout + result.stderr };
}

function git(project: string, ...argv: string[]): string {
  const result = spawnSync("git", argv, { cwd: project, encoding: "utf-8" });
  return result.stdout;
}

/** A real git repository with one commit in it. */
function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-gitignore-"));
  projects.push(dir);

  git(dir, "init", "-q", ".");
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), contents, "utf-8");
  }

  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "initial");
  return dir;
}

function status(dir: string): string[] {
  return git(dir, "status", "--short")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function ignoreFile(dir: string): string {
  return existsSync(join(dir, ".gitignore")) ? readFileSync(join(dir, ".gitignore"), "utf-8") : "";
}

describe("a project that installs pi", () => {
  test("sees nothing of pi's in git status", () => {
    const dir = repo({ "README.md": "# project\n", ".gitignore": "node_modules/\n" });

    assert.equal(pi(dir, "init").code, 0);
    assert.equal(pi(dir, "install").code, 0);
    assert.equal(pi(dir, "start", "Add orders", "--workflow", "quick").code, 0);

    // .gitignore is the one thing pi is allowed to have changed. Everything
    // else it wrote — config, run history, hooks, the skill — is invisible.
    assert.deepEqual(status(dir), ["M .gitignore"]);
  });

  test("gets the block from `pi init`, before install is even run", () => {
    // init writes pi.config.json and pi/, so waiting for install would leave
    // them exposed for however long it takes someone to run the next command.
    const dir = repo({ "README.md": "# project\n" });

    assert.equal(pi(dir, "init").code, 0);
    assert.deepEqual(status(dir), ["?? .gitignore"]);
  });

  test("keeps the project's own ignore rules", () => {
    const dir = repo({ ".gitignore": "node_modules/\n*.log\n" });

    pi(dir, "init");
    pi(dir, "install");

    const text = ignoreFile(dir);
    assert.ok(text.includes("node_modules/"));
    assert.ok(text.includes("*.log"));
  });

  test("does not grow the file when installed twice", () => {
    const dir = repo({ ".gitignore": "node_modules/\n" });

    pi(dir, "init");
    pi(dir, "install");
    const once = ignoreFile(dir);

    pi(dir, "install");
    assert.equal(ignoreFile(dir), once);
  });

  test("leaves the file alone with --no-gitignore", () => {
    const dir = repo({ ".gitignore": "node_modules/\n" });

    pi(dir, "init", "--no-gitignore");
    pi(dir, "install", "--no-gitignore");

    assert.equal(ignoreFile(dir), "node_modules/\n");
    assert.ok(status(dir).some((line) => line.includes("pi.config.json")));
  });

  test("says so, and stays quiet, outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-nogit-"));
    projects.push(dir);

    assert.equal(pi(dir, "init").code, 0);
    assert.equal(existsSync(join(dir, ".gitignore")), false);
  });
});

describe("shared files pi merges into", () => {
  test("are not ignored when the project already had them", () => {
    // .cursor/hooks.json is theirs. pi added entries to it; hiding the whole
    // file would hide their hooks too.
    const dir = repo({ ".cursor/hooks.json": '{"hooks":{"stop":[{"command":"echo theirs"}]}}' });

    pi(dir, "init");
    pi(dir, "install");

    assert.ok(!ignoreFile(dir).includes("/.cursor/hooks.json"));
    assert.ok(status(dir).some((line) => line.includes(".cursor/hooks.json")));
  });

  test("are ignored when pi created them", () => {
    const dir = repo({ "README.md": "# project\n" });

    pi(dir, "init");
    pi(dir, "install");

    const text = ignoreFile(dir);
    assert.ok(text.includes("/.cursor/hooks.json"));
    assert.ok(text.includes("/.cursor/cli.json"));
  });

  test("are reported when git already tracks them", () => {
    const dir = repo({ ".cursor/hooks.json": '{"hooks":{}}' });

    pi(dir, "init");
    const { out } = pi(dir, "install");

    // An ignore rule would silently do nothing here, so pi says so instead.
    assert.match(out, /already tracked by git/);
    assert.match(out, /\.cursor\/hooks\.json/);
  });

  test("draw no warning when the project does not track them", () => {
    const dir = repo({ "README.md": "# project\n" });
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "hooks.json"), '{"hooks":{}}', "utf-8");

    pi(dir, "init");
    const { out } = pi(dir, "install");

    assert.doesNotMatch(out, /already tracked by git/);
  });
});

describe("uninstalling", () => {
  test("keeps the block while config and history are still there", () => {
    const dir = repo({ "README.md": "# project\n" });
    pi(dir, "init");
    pi(dir, "install");

    const { out } = pi(dir, "uninstall");

    // Un-ignoring them now is exactly how they end up in someone's commit.
    assert.ok(ignoreFile(dir).includes("/pi.config.json"));
    assert.match(out, /Kept pi's \.gitignore block/);
    assert.deepEqual(status(dir), ["?? .gitignore"], "the config it left is still hidden");
  });

  test("puts the file back byte for byte once nothing is left to ignore", () => {
    const dir = repo({ ".gitignore": "node_modules/\n*.log\n" });
    pi(dir, "init");
    pi(dir, "install");
    pi(dir, "start", "Add orders", "--workflow", "quick");

    pi(dir, "uninstall", "--purge");

    assert.equal(ignoreFile(dir), "node_modules/\n*.log\n");
    assert.deepEqual(status(dir), [], "the repository should look untouched");
  });

  test("deletes a .gitignore that held nothing but pi's block", () => {
    const dir = repo({ "README.md": "# project\n" });
    pi(dir, "init");
    pi(dir, "install");

    pi(dir, "uninstall", "--purge");

    assert.equal(existsSync(join(dir, ".gitignore")), false);
    assert.deepEqual(status(dir), []);
  });
});

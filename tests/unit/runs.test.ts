import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPaths } from "../../core/engine/paths.ts";
import { WorkspaceError, listRuns, resolveRunId } from "../../core/engine/workspace.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A project with runs of our choosing on disk.
 *
 * Made here rather than through the CLI because run ids are random UUIDs, and
 * the case worth testing — two ids sharing a prefix — cannot be arranged by
 * asking for one.
 */
function projectWith(...runIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "pi-resolve-"));
  roots.push(root);

  for (const runId of runIds) {
    const paths = runPaths(root, runId);
    mkdirSync(paths.root, { recursive: true });
    // `listRuns` only checks that a state file is there, so it may be empty.
    writeFileSync(paths.state, "{}", "utf-8");
  }

  return root;
}

describe("listRuns", () => {
  test("finds the runs that have state, and ignores stray directories", () => {
    const root = projectWith("aaaa1111-0000-4000-8000-000000000001");
    mkdirSync(join(root, "pi", "runs", "not-a-run"), { recursive: true });

    assert.deepEqual(listRuns(root), ["aaaa1111-0000-4000-8000-000000000001"]);
  });

  test("is empty in a project that has never run anything", () => {
    assert.deepEqual(listRuns(mkdtempSync(join(tmpdir(), "pi-empty-"))), []);
  });
});

describe("resolveRunId", () => {
  const first = "aaaa1111-0000-4000-8000-000000000001";
  const second = "aaaa2222-0000-4000-8000-000000000002";

  test("takes a whole id", () => {
    assert.equal(resolveRunId(projectWith(first, second), first), first);
  });

  test("takes a prefix that only one run has", () => {
    assert.equal(resolveRunId(projectWith(first, second), "aaaa1"), first);
  });

  test("takes a prefix of one character when that is enough", () => {
    assert.equal(resolveRunId(projectWith(first, "bbbb2222-0000-4000-8000-000000000002"), "b"),
      "bbbb2222-0000-4000-8000-000000000002");
  });

  test("refuses a prefix two runs share, and names them", () => {
    // Guessing between two runs would silently resume the wrong work.
    const root = projectWith(first, second);

    assert.throws(
      () => resolveRunId(root, "aaaa"),
      (error: WorkspaceError) => {
        assert.equal(error.code, "ambiguous-run");
        assert.match(error.message, /matches 2 runs/);
        assert.match(error.message, new RegExp(first));
        assert.match(error.message, new RegExp(second));
        return true;
      },
    );
  });

  test("prefers an exact id over treating it as a prefix", () => {
    // One id being the start of another is unlikely with UUIDs, but "exact
    // wins" is the only answer that is never surprising.
    const short = "aaaa1111-0000-4000-8000-000000000001";
    const longer = "aaaa1111-0000-4000-8000-0000000000019";

    assert.equal(resolveRunId(projectWith(short, longer), short), short);
  });

  test("refuses an id that matches nothing", () => {
    assert.throws(
      () => resolveRunId(projectWith(first), "zzzz"),
      (error: WorkspaceError) => error.code === "no-such-run",
    );
  });

  test("refuses anything in a project with no runs", () => {
    assert.throws(
      () => resolveRunId(projectWith(), first),
      (error: WorkspaceError) => error.code === "no-such-run",
    );
  });
});

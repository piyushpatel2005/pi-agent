// Editing someone else's .gitignore.
//
// The block is pi's; every other line in the file belongs to the project, and
// these tests exist to prove pi never touches those.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  BEGIN,
  END,
  blockPaths,
  hasBlock,
  renderBlock,
  withBlock,
  withoutBlock,
} from "../../core/engine/gitignore.ts";

const PATHS = ["/pi/", "/pi.config.json"];

describe("the block itself", () => {
  test("is fenced by markers, so it can be found again", () => {
    const block = renderBlock(PATHS);

    assert.ok(block.startsWith(BEGIN));
    assert.ok(block.endsWith(END));
    assert.ok(hasBlock(block));
  });

  test("lists exactly the paths it was given", () => {
    const block = renderBlock(PATHS);

    for (const path of PATHS) assert.ok(block.includes(path), `${path} missing`);
    assert.ok(!block.includes("/.cursor/"), "listed a path it was not given");
  });

  test("says who wrote it and how to be rid of it", () => {
    const block = renderBlock(PATHS);

    assert.match(block, /pi install/);
    assert.match(block, /pi uninstall/);
  });
});

describe("adding the block", () => {
  test("keeps what was already in the file", () => {
    const before = "node_modules/\n*.log\n";
    const after = withBlock(before, PATHS);

    assert.ok(after.startsWith("node_modules/\n*.log\n"));
    assert.ok(hasBlock(after));
  });

  test("writes a whole file when there was none", () => {
    const after = withBlock("", PATHS);

    assert.ok(hasBlock(after));
    assert.ok(after.endsWith("\n"));
  });

  test("replaces its own block rather than stacking another", () => {
    const once = withBlock("node_modules/\n", PATHS);
    const twice = withBlock(once, PATHS);

    assert.equal(twice, once, "installing twice should not grow the file");
    assert.equal(twice.split(BEGIN).length - 1, 1);
  });

  test("updates the paths when they change between installs", () => {
    const before = withBlock("", PATHS);
    const after = withBlock(before, [...PATHS, "/.cursor/cli.json"]);

    assert.ok(after.includes("/.cursor/cli.json"));
    assert.equal(after.split(BEGIN).length - 1, 1);
  });
});

describe("reading a block back", () => {
  test("reports the paths and not the commentary", () => {
    const paths = blockPaths(renderBlock(PATHS));

    assert.deepEqual(paths, PATHS);
  });

  test("finds the block inside a larger file", () => {
    const text = `${withBlock("node_modules/\n", PATHS)}dist/\n`;

    assert.deepEqual(blockPaths(text), PATHS, "picked up lines outside the block");
  });

  test("is empty when there is no block", () => {
    assert.deepEqual(blockPaths("node_modules/\n"), []);
  });

  test("is what lets a reinstall keep the paths it claimed before", () => {
    // The bug this guards: pi creates .cursor/hooks.json on the first install,
    // so on the second one the file exists and looks like the project's own.
    // Without the block as a record, install two would hand it back.
    const first = withBlock("", [...PATHS, "/.cursor/hooks.json"]);
    const claimed = blockPaths(first);

    const second = withBlock(first, [...new Set([...PATHS, ...claimed])]);
    assert.ok(second.includes("/.cursor/hooks.json"));
  });
});

describe("removing the block", () => {
  test("puts the file back exactly as it was", () => {
    const before = "node_modules/\n*.log\n";

    assert.equal(withoutBlock(withBlock(before, PATHS)), before);
  });

  test("leaves a file that never had a block alone", () => {
    const before = "node_modules/\n";

    assert.equal(withoutBlock(before), before);
  });

  test("keeps lines a project added after the block", () => {
    const text = `${withBlock("node_modules/\n", PATHS)}dist/\n`;

    const after = withoutBlock(text);
    assert.ok(after.includes("node_modules/"));
    assert.ok(after.includes("dist/"));
    assert.ok(!hasBlock(after));
  });

  test("leaves a half-edited block alone rather than eating the rest", () => {
    // Someone deleted the closing marker by hand. Guessing where the block was
    // meant to stop would take their lines with it.
    const text = `node_modules/\n${BEGIN}\n/pi/\ndist/\n`;

    assert.equal(withoutBlock(text), text);
  });

  test("is not fooled by the end marker appearing first", () => {
    const text = `${END}\nnode_modules/\n`;

    assert.equal(hasBlock(text), false);
    assert.equal(withoutBlock(text), text);
  });
});

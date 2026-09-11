import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DocsConfig,
  ProjectConfig,
  defaultConfig,
  isDocsExempt,
  isDocsPath,
  owesDocumentation,
  renderDocsInstruction,
} from "../../core/schemas/config.ts";

const docs = (overrides: Record<string, unknown> = {}) =>
  DocsConfig.parse({ ...overrides });

describe("ProjectConfig", () => {
  test("a repo with no config file still gets a working one", () => {
    const config = defaultConfig();

    assert.equal(config.harness, "cursor");
    assert.equal(config.defaultWorkflow, "feature");
    assert.equal(config.docs.dir, "docs");
    assert.deepEqual(config.docs.files, ["README.md"]);
    assert.equal(config.docs.required, true);
  });

  test("a repo can move its docs without touching any persona", () => {
    const config = ProjectConfig.parse({
      docs: { dir: "website/content", files: ["README.md", "CHANGELOG.md"] },
    });

    assert.equal(config.docs.dir, "website/content");
    assert.deepEqual(config.docs.files, ["README.md", "CHANGELOG.md"]);
    assert.equal(config.docs.required, true, "unspecified fields keep their defaults");
  });

  test("carries the project facts that workflow conditions resolve against", () => {
    const config = ProjectConfig.parse({ facts: { hasFrontend: true, needsInfra: false } });
    assert.deepEqual(config.facts, { hasFrontend: true, needsInfra: false });
  });

  test("rejects a config from a future schema version", () => {
    assert.equal(ProjectConfig.safeParse({ version: 99 }).success, false);
  });
});

describe("isDocsPath", () => {
  test("recognizes the docs directory and the listed files", () => {
    const policy = docs();

    assert.equal(isDocsPath("docs/guide/install.md", policy), true);
    assert.equal(isDocsPath("./docs/index.md", policy), true);
    assert.equal(isDocsPath("README.md", policy), true);
    assert.equal(isDocsPath("src/server.ts", policy), false);
  });

  test("does not match a directory that merely shares a prefix", () => {
    assert.equal(isDocsPath("docstore/schema.ts", docs()), false);
  });

  test("follows a relocated docs directory", () => {
    const policy = docs({ dir: "website/content", files: ["README.md"] });

    assert.equal(isDocsPath("website/content/api.md", policy), true);
    assert.equal(isDocsPath("docs/api.md", policy), false);
  });
});

describe("isDocsExempt", () => {
  test("exempts tests and build output by default", () => {
    const policy = docs();

    assert.equal(isDocsExempt("tests/unit/state.test.ts", policy), true);
    assert.equal(isDocsExempt("dist/bundle.js", policy), true);
    assert.equal(isDocsExempt("core/engine/router.ts", policy), false);
  });

  test("matches glob patterns anywhere in the tree", () => {
    const policy = docs();

    assert.equal(isDocsExempt("src/orders/orders.test.ts", policy), true);
    assert.equal(isDocsExempt("src/orders/orders.ts", policy), false);
  });
});

describe("owesDocumentation", () => {
  const policy = docs();

  test("true when source changed and no documentation did", () => {
    assert.equal(owesDocumentation(["src/orders.ts", "src/index.ts"], policy), true);
  });

  test("false when the step also updated documentation", () => {
    assert.equal(owesDocumentation(["src/orders.ts", "docs/orders.md"], policy), false);
    assert.equal(owesDocumentation(["src/cli.ts", "README.md"], policy), false);
  });

  test("false when only exempt paths changed", () => {
    assert.equal(owesDocumentation(["tests/unit/orders.test.ts"], policy), false);
  });

  test("false when the step changed nothing", () => {
    assert.equal(owesDocumentation([], policy), false);
  });

  test("false for every case once the repo opts out", () => {
    const relaxed = docs({ required: false });
    assert.equal(owesDocumentation(["src/orders.ts"], relaxed), false);
  });

  test("a test-only change alongside source still owes docs", () => {
    // The exemption removes tests from consideration; it does not excuse the
    // source file sitting next to them.
    assert.equal(
      owesDocumentation(["src/orders.ts", "tests/orders.test.ts"], policy),
      true,
    );
  });
});

describe("renderDocsInstruction", () => {
  test("names the configured surfaces so the persona never hard-codes them", () => {
    const instruction = renderDocsInstruction(
      docs({ dir: "website/content", files: ["README.md", "CHANGELOG.md"] }),
    );

    assert.match(instruction, /`website\/content\/`/);
    assert.match(instruction, /`README\.md`/);
    assert.match(instruction, /`CHANGELOG\.md`/);
    assert.doesNotMatch(instruction, /`docs\/`/);
  });

  test("tells the agent to fix stale references, not just add new prose", () => {
    assert.match(renderDocsInstruction(docs()), /stale/);
  });

  test("softens the wording when documentation is not required", () => {
    const instruction = renderDocsInstruction(docs({ required: false }));

    assert.match(instruction, /not required for every change/);
    assert.doesNotMatch(instruction, /part of the work/);
  });
});

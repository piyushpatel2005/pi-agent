import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import { repoPath } from "../../core/engine/paths.ts";

const project = join("/Users", "me", "proj");

describe("repoPath", () => {
  test("an absolute path inside the project becomes repo-relative", () => {
    assert.equal(repoPath(project, join(project, "src", "a.ts")), "src/a.ts");
  });

  test("a relative path is canonicalized", () => {
    assert.equal(repoPath(project, "src/a.ts"), "src/a.ts");
  });

  test("a path outside the project stays absolute", () => {
    assert.equal(repoPath(project, "/etc/hosts"), "/etc/hosts");
  });
});

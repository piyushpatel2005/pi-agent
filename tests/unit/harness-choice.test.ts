import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { resolveHarnessChoice } from "../../cli/harness-choice.ts";

describe("resolveHarnessChoice", () => {
  test("uses --harness when provided", async () => {
    assert.equal(
      await resolveHarnessChoice({ harness: "copilot", configured: "cursor" }),
      "copilot",
    );
  });

  test("uses configured harness when non-interactive", async () => {
    assert.equal(
      await resolveHarnessChoice({ configured: "copilot", yes: true }),
      "copilot",
    );
  });

  test("rejects unknown harness names", async () => {
    await assert.rejects(
      () => resolveHarnessChoice({ harness: "emacs", configured: "cursor" }),
      /No harness "emacs"/,
    );
  });
});

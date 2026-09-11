// The guard through the real CLI, against a real run.
//
// This is the test that matters most for "review smaller changes": it proves
// the limit is enforced by a process that can say no, not by a paragraph in a
// prompt that the model may talk itself out of.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const CLI = join(import.meta.dirname, "..", "..", "cli", "pi.ts");

let project: string;

function pi(...argv: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: project, encoding: "utf-8" });
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
}

type Verdict = { permission: "allow" | "deny"; agent_message?: string };

function guard(...argv: string[]): Verdict {
  const { code, out } = pi("guard", ...argv);
  assert.equal(code, 0, out);
  return JSON.parse(out);
}

/** Write `lines` lines across `files`, recording each as the host would. */
function write(files: string[], lines: number): Verdict {
  const verdict = guard("--tool", "write-code", "--files", files.join(","), "--lines", String(lines));
  if (verdict.permission === "allow") {
    guard("--tool", "write-code", "--files", files.join(","), "--lines", String(lines), "--record");
  }
  return verdict;
}

before(() => {
  project = mkdtempSync(join(tmpdir(), "pi-guard-"));
  mkdirSync(join(project, "pi", "workflows"), { recursive: true });

  writeFileSync(
    join(project, "pi.config.json"),
    JSON.stringify({ version: 1, defaultWorkflow: "budgeted", facts: {} }),
    "utf-8",
  );

  // A tiny workflow so the test is about the guard, not about routing.
  writeFileSync(
    join(project, "pi", "workflows", "budgeted.workflow.json"),
    JSON.stringify({
      id: "budgeted",
      name: "Budgeted",
      version: 1,
      description: "One step with a small budget.",
      defaults: { gate: "none", checkpoint: false },
      steps: [
        {
          id: "build",
          agent: "backend-developer",
          objective: "Build it.",
          produces: ["summary.md"],
          tools: ["read", "write-code", "request-review"],
          changeBudget: { maxFiles: 3, maxLines: 100 },
        },
      ],
    }),
    "utf-8",
  );
});

after(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("the guard through the CLI", () => {
  test("allows everything when pi is not governing a run", () => {
    assert.equal(guard("--tool", "write-code", "--files", "a.ts").permission, "allow");
  });

  test("refuses a write before any step has been handed out", () => {
    assert.equal(pi("start", "Add the orders service").code, 0);

    const verdict = guard("--tool", "write-code", "--files", "a.ts", "--lines", "10");
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.agent_message!, /No step is active|not running/);
  });

  test("reading is allowed even then", () => {
    assert.equal(guard("--tool", "read").permission, "allow");
  });

  test("allows granted writes once the step is running", () => {
    assert.match(pi("next").out, /build/);
    assert.equal(write(["src/a.ts"], 40).permission, "allow");
  });

  test("refuses a tool the step does not grant", () => {
    const verdict = guard("--tool", "run-command");
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.agent_message!, /does not grant `run-command`/);
  });

  test("allows a second write that stays inside the budget", () => {
    assert.equal(write(["src/b.ts"], 50).permission, "allow");
  });

  test("refuses the write that would cross the line limit", () => {
    const verdict = write(["src/c.ts"], 30);
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.agent_message!, /120 lines against a limit of 100/);
    assert.match(verdict.agent_message!, /pi review request/);
  });

  test("splitting the same change into smaller calls does not get around it", () => {
    for (let i = 0; i < 4; i++) {
      const verdict = write(["src/c.ts"], 5);
      if (i === 0) assert.equal(verdict.permission, "allow", "first small write should fit");
    }
    // The tally is cumulative, so the budget still bites.
    assert.equal(write(["src/c.ts"], 5).permission, "deny");
  });

  test("the refusal is in the log, so `why did it stop` is answerable", () => {
    const events = JSON.parse(pi("log", "--json").out) as { type: string; guard?: string }[];
    const blocked = events.filter((event) => event.type === "guard.blocked");
    assert.ok(blocked.length > 0);
    assert.ok(blocked.some((event) => event.guard === "change-budget"));
  });
});

describe("review unblocks the budget", () => {
  test("requesting a review freezes the step", () => {
    const { code, out } = pi(
      "review",
      "request",
      "--summary",
      "Added the orders service and its data model.",
      "--files",
      "add:src/a.ts,modify:src/b.ts",
      "--lines",
      "105",
    );
    assert.equal(code, 0, out);
    assert.match(out, /frozen until this is answered/);

    // Frozen means frozen: not even a granted write gets through.
    const verdict = guard("--tool", "write-code", "--files", "src/a.ts", "--lines", "1");
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.agent_message!, /waiting on your review/);
  });

  test("a second request is refused while one is unanswered", () => {
    const { code, err } = pi("review", "request", "--summary", "More.", "--files", "src/d.ts");
    assert.equal(code, 1);
    assert.match(err, /already has a review waiting/);
  });

  test("status shows what the human owes an answer on", () => {
    const { out } = pi("review", "status");
    assert.match(out, /WAITING ON YOU/);
    assert.match(out, /Added the orders service/);
  });

  test("an unattended run cannot approve its own review", () => {
    const { code, err } = pi("review", "resolve", "--approve");
    assert.equal(code, 1);
    assert.match(err, /without a human/);
  });

  test("rejection requires feedback", () => {
    assert.equal(pi("human-turn").code, 0);

    const { code, err } = pi("review", "resolve", "--reject");
    assert.equal(code, 1);
    assert.match(err, /needs feedback/);
  });

  test("approval resumes the step with a fresh budget", () => {
    const { code, out } = pi("review", "resolve", "--approve");
    assert.equal(code, 0, out);
    assert.match(out, /fresh change budget/);

    // Was over budget a moment ago; now there is room again.
    assert.equal(write(["src/e.ts"], 60).permission, "allow");
  });

  test("the fresh budget is a budget, not a blank cheque", () => {
    assert.equal(write(["src/f.ts"], 50).permission, "deny");
  });

  test("requires exactly one of --approve or --reject", () => {
    assert.equal(pi("review", "resolve").code, 2);
    assert.equal(pi("review", "resolve", "--approve", "--reject").code, 2);
  });
});

describe("requireReviewBefore", () => {
  test("the first write is refused until review, even well under budget", () => {
    const gated = mkdtempSync(join(tmpdir(), "pi-gated-"));
    const previous = project;
    project = gated;

    try {
      mkdirSync(join(gated, "pi", "workflows"), { recursive: true });
      writeFileSync(
        join(gated, "pi.config.json"),
        JSON.stringify({ version: 1, defaultWorkflow: "gated", facts: {} }),
        "utf-8",
      );
      writeFileSync(
        join(gated, "pi", "workflows", "gated.workflow.json"),
        JSON.stringify({
          id: "gated",
          name: "Gated",
          version: 1,
          description: "Review before the first write.",
          defaults: { gate: "none", checkpoint: false },
          steps: [
            {
              id: "build",
              agent: "backend-developer",
              objective: "Build it.",
              produces: ["summary.md"],
              tools: ["read", "write-code", "request-review"],
              requireReviewBefore: ["write-code"],
            },
          ],
        }),
        "utf-8",
      );

      pi("start", "Careful change");
      pi("next");

      const blocked = guard("--tool", "write-code", "--files", "a.ts", "--lines", "1");
      assert.equal(blocked.permission, "deny");
      assert.match(blocked.agent_message!, /requires review before its first/);

      pi("review", "request", "--summary", "Here is the plan.", "--files", "a.ts", "--lines", "1");
      pi("human-turn");
      assert.equal(pi("review", "resolve", "--approve").code, 0);

      assert.equal(guard("--tool", "write-code", "--files", "a.ts", "--lines", "1").permission, "allow");
    } finally {
      project = previous;
      rmSync(gated, { recursive: true, force: true });
    }
  });
});

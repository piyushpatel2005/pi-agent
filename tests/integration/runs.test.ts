// Several runs in one project.
//
// Starting a run pushes the current one aside. That is usually what you meant,
// but it used to happen in silence and with no way back, which made an
// interrupted run effectively lost. These pin the parts that fixed it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const CLI = join(import.meta.dirname, "..", "..", "cli", "pi.ts");

let project: string;
let runA: string;
let runB: string;

function pi(...argv: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: project, encoding: "utf-8" });
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
}

type Summary = {
  runId: string;
  active: boolean;
  goal: string;
  done: number;
  total: number;
  createdAt: string;
};

function runs(): Summary[] {
  return JSON.parse(pi("runs", "--json").out);
}

function start(goal: string): string {
  const result = pi("start", goal, "--workflow", "quick", "--json");
  assert.equal(result.code, 0, result.err);
  return JSON.parse(result.out).runId;
}

before(() => {
  project = mkdtempSync(join(tmpdir(), "pi-runs-"));
  assert.equal(pi("init").code, 0);

  runA = start("Feature A");
  assert.equal(pi("report", "--step", "requirements", "--result", "completed").code, 0);

  runB = start("Feature B");
});

after(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("pi runs", () => {
  test("lists every run, marking the active one", () => {
    const all = runs();
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((run) => run.active),
      [true, false],
      "the newest run is active and listed first",
    );
  });

  test("orders by when a run started, not by its random id", () => {
    const [first, second] = runs();
    assert.equal(first!.goal, "Feature B");
    assert.equal(second!.goal, "Feature A");
    assert.ok(Date.parse(first!.createdAt) >= Date.parse(second!.createdAt));
  });

  test("remembers how far each run got", () => {
    const a = runs().find((run) => run.goal === "Feature A");
    assert.equal(a?.done, 1);
    assert.equal(a?.total, 3);
  });

  test("shows the active run with a marker in the human output", () => {
    const { out } = pi("runs");
    assert.match(out, new RegExp(`^\\* ${runB.slice(0, 8)}`, "m"));
    assert.match(out, new RegExp(`^  ${runA.slice(0, 8)}`, "m"));
  });
});

describe("starting over an unfinished run", () => {
  test("says what it set aside and how to get back", () => {
    // Re-proves the before() hook's second start, which is the case that used
    // to lose work silently.
    const { out } = pi("start", "Feature C", "--workflow", "quick");
    assert.match(out, /Set aside: Feature B \(0\/3 steps\)/);
    assert.match(out, /pi runs --use [0-9a-f]{8}/);
    assert.match(out, /Nothing was lost/);
  });

  test("reports the displaced run in --json too", () => {
    const started = JSON.parse(pi("start", "Feature D", "--workflow", "quick", "--json").out);
    assert.equal(typeof started.displaced, "string", "Feature C was unfinished");
  });

  test("stays quiet when the run it would displace is finished", () => {
    // `quick` gates its steps, so "completed" parks them awaiting approval and
    // the run stays unfinished. This one has no gates, so it can actually end.
    writeFileSync(
      join(project, "pi", "workflows", "solo.workflow.json"),
      JSON.stringify({
        id: "solo",
        name: "Solo",
        version: 1,
        defaults: { gate: "none", checkpoint: false },
        steps: [
          {
            id: "only",
            agent: "backend-developer",
            objective: "Do the thing.",
            produces: ["summary.md"],
            tools: ["read", "write-artifact"],
          },
        ],
      }),
      "utf-8",
    );

    assert.equal(pi("start", "Feature E", "--workflow", "solo").code, 0);
    assert.equal(pi("report", "--step", "only", "--result", "completed").code, 0);

    const { out } = pi("start", "Feature F", "--workflow", "solo");
    assert.doesNotMatch(out, /Set aside/, "a finished run is not something you were interrupted in");
  });
});

describe("pi runs --use", () => {
  test("switches on a short prefix and picks the run back up", () => {
    const { code, out } = pi("runs", "--use", runA.slice(0, 8));
    assert.equal(code, 0, out);
    assert.match(out, /Feature A — 1\/3 steps/);

    assert.match(pi("status").out, /Feature A/);
    assert.match(pi("next").out, /implementation/, "resumes at the step it had reached");
  });

  test("accepts a whole id as well", () => {
    assert.equal(pi("runs", "--use", runB).code, 0);
    assert.match(pi("status").out, /Feature B/);
  });

  test("refuses an id that matches nothing", () => {
    const { code, err } = pi("runs", "--use", "zzzzzzzz");
    assert.equal(code, 1);
    assert.match(err, /No run here starts with "zzzzzzzz"/);
  });

  test("switching does not change what the run contains", () => {
    const before = runs().find((run) => run.goal === "Feature A");
    pi("runs", "--use", runA);
    const after = runs().find((run) => run.goal === "Feature A");

    assert.equal(after?.done, before?.done);
    assert.equal(after?.total, before?.total);
  });
});

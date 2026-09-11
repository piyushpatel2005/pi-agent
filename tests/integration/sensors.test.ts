// Sensors through the CLI: do they reach the human at the gate, where the
// decision is actually being made?

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const CLI = join(import.meta.dirname, "..", "..", "cli", "pi.ts");

let project: string;
let runId: string;

function pi(...argv: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: project, encoding: "utf-8" });
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
}

function writeArtifact(step: string, name: string, body: string): void {
  const dir = join(project, "pi", "runs", runId, "artifacts", step);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf-8");
}

before(() => {
  project = mkdtempSync(join(tmpdir(), "pi-sensor-cli-"));
  mkdirSync(join(project, "pi", "workflows"), { recursive: true });

  writeFileSync(
    join(project, "pi.config.json"),
    JSON.stringify({
      version: 1,
      defaultWorkflow: "sensed",
      facts: {},
      checks: { typeCheck: "true", lint: "echo 'src/a.ts:1 unused' && false" },
    }),
    "utf-8",
  );
  writeFileSync(
    join(project, "pi", "workflows", "sensed.workflow.json"),
    JSON.stringify({
      id: "sensed",
      name: "Sensed",
      version: 1,
      description: "Two sensed steps.",
      defaults: { gate: "none", checkpoint: false },
      steps: [
        {
          id: "requirements",
          agent: "business-analyst",
          objective: "Say what to build.",
          produces: ["requirements.md"],
          tools: ["write-artifact"],
          sensors: ["required-sections"],
        },
        {
          id: "build",
          agent: "backend-developer",
          objective: "Build it.",
          consumes: ["requirements.md"],
          produces: ["summary.md"],
          tools: ["write-code", "write-artifact"],
          sensors: ["required-sections", "docs-coverage", "type-check", "linter"],
        },
      ],
    }),
    "utf-8",
  );

  pi("start", "Add order cancellation");
  runId = JSON.parse(pi("status", "--json").out).runId;
});

after(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("pi sensors", () => {
  test("lists the catalogue", () => {
    const { code, out } = pi("sensors", "--list");
    assert.equal(code, 0);
    for (const id of ["required-sections", "docs-coverage", "traceability", "type-check"]) {
      assert.match(out, new RegExp(`^${id}\\b`, "m"));
    }
  });

  test("dry-runs the current step before you get to the gate", () => {
    pi("next");
    writeArtifact("requirements", "requirements.md", "# Requirements\n\nTBD\n");

    const { code, out } = pi("sensors");
    assert.equal(code, 0);
    assert.match(out, /warn {2}\[required-sections\]/);
    assert.match(out, /still contains TBD/);
  });

  test("its findings are exactly what the gate will say", () => {
    const dry = pi("sensors").out;
    const gate = pi("report", "--step", "requirements", "--result", "completed").out;

    for (const line of dry.trim().split("\n").filter(Boolean)) {
      assert.ok(gate.includes(line.trim()), `gate did not repeat: ${line}`);
    }
  });
});

describe("sensors at the gate", () => {
  test("a clean step says nothing", () => {
    pi("next");
    writeArtifact(
      "build",
      "summary.md",
      "# Summary\n\nAdded the cancellation endpoint described in the requirements, " +
        "and wired it to the inventory service so the reserved stock is released " +
        "whenever an order is cancelled before the carrier scans it.\n",
    );

    // No files changed yet, so docs-coverage and the command sensors all skip.
    const { out } = pi("sensors");
    assert.ok(!out.includes("warn"), out);
  });

  test("docs-coverage warns once code lands with no documentation", () => {
    pi("guard", "--tool", "write-code", "--files", "src/a.ts", "--lines", "40", "--record");

    const { out } = pi("sensors");
    assert.match(out, /warn {2}\[docs-coverage\]/);
    assert.match(out, /no documentation was touched/);
  });

  test("a failing configured check is reported with its output", () => {
    const { out } = pi("sensors");
    assert.match(out, /warn {2}\[linter\]/);
    assert.match(out, /src\/a\.ts:1 unused/);
  });

  test("a passing configured check is noted, not warned about", () => {
    const { out } = pi("sensors");
    assert.match(out, /note {2}\[type-check\]/);
    assert.ok(!/warn {2}\[type-check\]/.test(out));
  });

  test("documenting the change clears the warning", () => {
    pi("guard", "--tool", "write-code", "--files", "docs/orders.md", "--lines", "10", "--record");

    const { out } = pi("sensors");
    assert.ok(!/warn {2}\[docs-coverage\]/.test(out), out);
    assert.match(out, /note {2}\[docs-coverage\].*docs\/orders\.md/);
  });

  test("findings land in the log, so the gate's reasoning is recoverable", () => {
    pi("report", "--step", "build", "--result", "completed");

    const events = JSON.parse(pi("log", "--json").out) as {
      type: string;
      sensor?: string;
      pass?: boolean;
      findings?: string[];
    }[];
    const fired = events.filter((event) => event.type === "sensor.fired");

    assert.ok(fired.some((event) => event.sensor === "docs-coverage"));

    const linter = fired.find((event) => event.sensor === "linter");
    assert.equal(linter?.pass, false);
    assert.ok(linter?.findings?.[0]?.includes("unused"));
  });

  test("a sensor never fails the step, only reports on it", () => {
    const state = JSON.parse(pi("status", "--json").out);
    assert.equal(state.steps.build.status, "completed");
    assert.equal(state.status, "completed");
  });
});

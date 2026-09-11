import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { compileWorkflow } from "../../core/engine/compile.ts";
import { artifactPath, runPaths, type RunPaths } from "../../core/engine/paths.ts";
import {
  SENSORS,
  SENSOR_IDS,
  findSensor,
  renderSensors,
  runSensors,
  type SensorContext,
} from "../../core/engine/sensors.ts";
import { defaultConfig, ProjectConfig } from "../../core/schemas/config.ts";
import { newStepState, type StepState } from "../../core/schemas/state.ts";
import type { CompiledWorkflow } from "../../core/schemas/workflow.ts";

const WORKFLOW: CompiledWorkflow = (() => {
  const result = compileWorkflow({
    id: "w",
    name: "W",
    version: 1,
    description: "d",
    defaults: { gate: "none", checkpoint: false },
    steps: [
      {
        id: "requirements",
        agent: "business-analyst",
        objective: "o",
        produces: ["requirements.md", "acceptance-criteria.md"],
        tools: ["write-artifact"],
      },
      {
        id: "build",
        agent: "backend-developer",
        objective: "o",
        consumes: ["requirements.md"],
        produces: ["summary.md"],
        tools: ["write-code"],
      },
      {
        id: "validation",
        agent: "business-analyst",
        objective: "o",
        consumes: ["acceptance-criteria.md"],
        produces: ["validation.md"],
        tools: ["write-artifact"],
      },
    ],
  });
  assert.ok(result.ok, "fixture must compile");
  return result.workflow;
})();

let project: string;
let paths: RunPaths;

before(() => {
  project = mkdtempSync(join(tmpdir(), "pi-sensors-"));
  paths = runPaths(project, "11111111-1111-4111-8111-111111111111");
});

after(() => {
  rmSync(project, { recursive: true, force: true });
});

function writeArtifact(step: string, name: string, body: string): void {
  const path = artifactPath(paths, step, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf-8");
}

function context(
  stepId: string,
  // Config overrides are parsed, not spread, so nested defaults still apply.
  overrides: { stepState?: Partial<StepState>; config?: Record<string, unknown> } = {},
): SensorContext {
  const step = WORKFLOW.steps.find((candidate) => candidate.id === stepId)!;
  return {
    step,
    stepState: { ...newStepState(step.agent), ...overrides.stepState },
    workflow: WORKFLOW,
    config: overrides.config ? ProjectConfig.parse(overrides.config) : defaultConfig(),
    paths,
    projectDir: project,
  };
}

function run(sensorId: string, ctx: SensorContext) {
  return findSensor(sensorId)!.run(ctx);
}

describe("the registry", () => {
  test("every sensor the shipped workflows declare exists", () => {
    // The compiler enforces this too; this is the list that makes it true.
    for (const id of [
      "required-sections",
      "upstream-coverage",
      "traceability",
      "docs-coverage",
      "type-check",
      "linter",
    ]) {
      assert.ok(findSensor(id), `missing sensor "${id}"`);
    }
    assert.equal(SENSORS.length, SENSOR_IDS.length);
  });

  test("a step declaring an unknown sensor is reported, not silently skipped", () => {
    const results = runSensors(context("requirements"));
    void results;

    const withUnknown = context("requirements");
    withUnknown.step = { ...withUnknown.step, sensors: ["astrology"] };
    const [result] = runSensors(withUnknown);

    assert.equal(result?.sensor, "astrology");
    assert.match(result!.skipped!, /no sensor by that name/);
  });

  test("a sensor that throws does not take the run down with it", () => {
    const broken = context("build");
    broken.step = { ...broken.step, sensors: ["required-sections"] };

    // A directory where the sensor expects a file: it exists, so the sensor
    // gets past its own guard, then reading it throws.
    mkdirSync(artifactPath(paths, "build", "summary.md"), { recursive: true });

    try {
      const [result] = runSensors(broken);
      assert.equal(result?.sensor, "required-sections");
      assert.equal(result?.pass, true, "a broken sensor must not fail the step");
      assert.match(result!.skipped!, /the sensor itself failed/);
    } finally {
      rmSync(artifactPath(paths, "build", "summary.md"), { recursive: true, force: true });
    }
  });
});

describe("required-sections", () => {
  test("flags an artifact that was declared but never written", () => {
    const result = run("required-sections", context("build"));
    assert.equal(result.pass, false);
    assert.match(result.findings[0]!.message, /`summary\.md` was declared but never written/);
  });

  test("accepts a real document", () => {
    writeArtifact(
      "requirements",
      "requirements.md",
      "# Requirements\n\nOrders can be cancelled by their owner at any point before the\n" +
        "carrier scans them, which releases the reserved inventory back to stock.\n\n" +
        "## Out of scope\n\nRefunds are handled by the payments service.\n",
    );
    writeArtifact(
      "requirements",
      "acceptance-criteria.md",
      "# Acceptance Criteria\n\n" +
        "- A pending order can be cancelled by its owner\n" +
        "- A shipped order cannot be cancelled\n" +
        "- Cancelling releases the reserved inventory\n",
    );

    const result = run("required-sections", context("requirements"));
    assert.equal(result.pass, true, JSON.stringify(result.findings));
  });

  test("a short list of real criteria is not a stub", () => {
    // Four lines, but every line carries content. Counting lines would have
    // called this a stub; counting words does not.
    const result = run("required-sections", context("requirements"));
    assert.ok(!result.findings.some((finding) => /stub/.test(finding.message)));
  });

  test("flags a document with no content under its headings", () => {
    writeArtifact("build", "summary.md", "# Summary\n\n## Details\n\n## Notes\n");
    const result = run("required-sections", context("build"));
    assert.equal(result.pass, false);
    assert.match(result.findings[0]!.message, /looks like a stub/);
  });

  test("flags unresolved placeholders", () => {
    writeArtifact(
      "build",
      "summary.md",
      "# Summary\n\nWe implemented the cancellation endpoint and wired it to the " +
        "inventory service so that reservations are released whenever an order is " +
        "cancelled before the carrier has scanned it.\n\n## Open\n\nTBD\n",
    );

    const result = run("required-sections", context("build"));
    assert.equal(result.pass, false);
    assert.ok(
      result.findings.some((finding) => /still contains TBD/.test(finding.message)),
      JSON.stringify(result.findings),
    );
  });

  test("notes a document with no headings, without failing it", () => {
    writeArtifact(
      "build",
      "summary.md",
      "We implemented the cancellation endpoint and wired it to the inventory " +
        "service so that reservations are released when an order is cancelled.\n",
    );

    const result = run("required-sections", context("build"));
    assert.equal(result.pass, true);
    assert.match(result.findings[0]!.message, /no headings/);
  });
});

describe("upstream-coverage", () => {
  test("skips a step that consumes nothing", () => {
    assert.match(run("upstream-coverage", context("requirements")).skipped!, /consumes nothing/);
  });

  test("passes when the output engages with its input", () => {
    writeArtifact(
      "build",
      "summary.md",
      "# Requirements\n\nImplemented cancellation and the out of scope items were left alone.\n",
    );
    assert.equal(run("upstream-coverage", context("build")).pass, true);
  });

  test("warns when the output never refers to its input", () => {
    writeArtifact("build", "summary.md", "# Notes\n\nSomething entirely unrelated happened here.\n");

    const result = run("upstream-coverage", context("build"));
    assert.equal(result.pass, false);
    assert.match(result.findings[0]!.message, /Nothing in this step's output refers to/);
  });
});

describe("traceability", () => {
  test("skips without acceptance criteria to trace against", () => {
    assert.match(run("traceability", context("build")).skipped!, /no acceptance-criteria/);
  });

  test("passes when every criterion is engaged with", () => {
    writeArtifact(
      "validation",
      "validation.md",
      "# Validation\n\n" +
        "- A pending order can be cancelled by its owner: met, covered by `cancel.test.ts`\n" +
        "- A shipped order cannot be cancelled: met, returns 409\n" +
        "- Cancelling releases the reserved inventory: met, verified against stock levels\n",
    );

    const result = run("traceability", context("validation"));
    assert.equal(result.pass, true, JSON.stringify(result.findings));
  });

  test("names the criteria the validation never mentions", () => {
    writeArtifact(
      "validation",
      "validation.md",
      "# Validation\n\n- A pending order can be cancelled by its owner: met\n\nEverything looks good.\n",
    );

    const result = run("traceability", context("validation"));
    assert.equal(result.pass, false);
    assert.match(result.findings[0]!.message, /2 of 3 acceptance criteria/);
    assert.match(result.findings[0]!.message, /Unmentioned is not the same as met/);
  });
});

describe("docs-coverage", () => {
  const docsConfig = { version: 1 as const, docs: { dir: "docs", files: ["README.md"] } };

  test("skips a step that changed nothing", () => {
    assert.match(run("docs-coverage", context("build")).skipped!, /changed no files/);
  });

  test("skips when the project does not require docs", () => {
    const result = run(
      "docs-coverage",
      context("build", {
        stepState: { changedFiles: ["src/a.ts"] },
        config: { version: 1, docs: { required: false } },
      }),
    );
    assert.match(result.skipped!, /not required/);
  });

  test("warns when code changed and no documentation did", () => {
    const result = run(
      "docs-coverage",
      context("build", {
        stepState: { changedFiles: ["src/a.ts", "src/b.ts"] },
        config: docsConfig,
      }),
    );

    assert.equal(result.pass, false);
    assert.match(result.findings[0]!.message, /2 file\(s\) changed and no documentation/);
    assert.match(result.findings[0]!.message, /`docs\/`/);
  });

  test("passes and says so when documentation was updated", () => {
    const result = run(
      "docs-coverage",
      context("build", {
        stepState: { changedFiles: ["src/a.ts", "docs/orders.md"] },
        config: docsConfig,
      }),
    );

    assert.equal(result.pass, true);
    assert.match(result.findings[0]!.message, /Documentation was updated: docs\/orders\.md/);
  });

  test("does not ask for docs when only exempt files changed", () => {
    const result = run(
      "docs-coverage",
      context("build", {
        stepState: { changedFiles: ["tests/a.test.ts"] },
        config: docsConfig,
      }),
    );
    assert.equal(result.pass, true);
  });

  test("follows the project's configured docs location", () => {
    const result = run(
      "docs-coverage",
      context("build", {
        stepState: { changedFiles: ["src/a.ts"] },
        config: { version: 1, docs: { dir: "website/content", files: [] } },
      }),
    );
    assert.match(result.findings[0]!.message, /`website\/content\/`/);
  });
});

describe("type-check and linter", () => {
  test("skip rather than pass when nothing is configured", () => {
    const ctx = context("build", { stepState: { changedFiles: ["src/a.ts"] } });
    for (const id of ["type-check", "linter"]) {
      const result = run(id, ctx);
      assert.equal(result.pass, true);
      assert.match(result.skipped!, /no `checks\./);
    }
  });

  test("skip when the step changed no files", () => {
    const result = run(
      "type-check",
      context("build", { config: { version: 1, checks: { typeCheck: "true" } } }),
    );
    assert.match(result.skipped!, /changed no files/);
  });

  test("pass when the configured command succeeds", () => {
    const result = run(
      "type-check",
      context("build", {
        stepState: { changedFiles: ["src/a.ts"] },
        config: { version: 1, checks: { typeCheck: "true" } },
      }),
    );
    assert.equal(result.pass, true);
    assert.equal(result.skipped, undefined);
  });

  test("warn with the command's output when it fails", () => {
    const result = run(
      "linter",
      context("build", {
        stepState: { changedFiles: ["src/a.ts"] },
        config: { version: 1, checks: { lint: "echo 'a.ts:1 unused variable' && false" } },
      }),
    );

    assert.equal(result.pass, false);
    assert.match(result.findings[0]!.message, /failed/);
    assert.match(result.findings[0]!.message, /unused variable/);
  });
});

describe("renderSensors", () => {
  test("says nothing for a skipped or clean sensor", () => {
    assert.deepEqual(
      renderSensors([
        { sensor: "a", pass: true, findings: [], skipped: "not configured" },
        { sensor: "b", pass: true, findings: [] },
      ]),
      [],
    );
  });

  test("marks warnings and notes differently, naming the sensor", () => {
    const lines = renderSensors([
      {
        sensor: "docs-coverage",
        pass: false,
        findings: [
          { severity: "warn", message: "No docs." },
          { severity: "info", message: "FYI." },
        ],
      },
    ]);

    assert.deepEqual(lines, ["warn  [docs-coverage] No docs.", "note  [docs-coverage] FYI."]);
  });
});

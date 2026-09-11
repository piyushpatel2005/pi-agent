// The sensor registry and its six sensors.
//
// Each sensor answers one question about a step that just reported complete,
// deterministically, from what is on disk. None of them call a model, and none
// of them block — they produce findings that surface at the gate, where a human
// is already looking.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { isDocsPath, owesDocumentation, type ProjectConfig } from "../schemas/config.ts";
import {
  Severity,
  info,
  pass,
  skip,
  warn,
  type Finding,
  type SensorResult,
} from "../schemas/sensor.ts";
import type { StepState } from "../schemas/state.ts";
import type { CompiledStep, CompiledWorkflow } from "../schemas/workflow.ts";
import { artifactPath, type RunPaths } from "./paths.ts";

export type SensorContext = {
  step: CompiledStep;
  stepState: StepState;
  /** Needed to locate a consumed artifact, which lives in its producer's directory. */
  workflow: CompiledWorkflow;
  config: ProjectConfig;
  paths: RunPaths;
  projectDir: string;
};

export type Sensor = {
  id: string;
  /** One line, shown by `pi sensors`. */
  describes: string;
  run: (context: SensorContext) => SensorResult;
};

// ── Artifact helpers ────────────────────────────────────────────────────────

type Artifact = { name: string; path: string; body: string };

function artifactsOf(context: SensorContext): Artifact[] {
  return context.step.produces
    .map((name) => ({ name, path: artifactPath(context.paths, context.step.id, name) }))
    .filter((artifact) => existsSync(artifact.path))
    .map((artifact) => ({ ...artifact, body: readFileSync(artifact.path, "utf-8") }));
}

/**
 * A consumed artifact lives in the directory of the step that produced it, so
 * it has to be looked up through the workflow rather than derived from the
 * current step. The compiler guarantees exactly one producer per artifact.
 */
function consumedOf(context: SensorContext): Artifact[] {
  return context.step.consumes
    .map((name) => {
      const producer = context.workflow.steps.find((step) => step.produces.includes(name));
      if (!producer) return null;

      const path = artifactPath(context.paths, producer.id, name);
      return existsSync(path) ? { name, path, body: readFileSync(path, "utf-8") } : null;
    })
    .filter((artifact): artifact is Artifact => artifact !== null);
}

// ── required-sections ───────────────────────────────────────────────────────

const PLACEHOLDER = /\b(TBD|TODO|FIXME|lorem ipsum|\?\?\?|<placeholder>|xxx)\b/gi;

/**
 * A document short enough that nobody actually wrote it.
 *
 * Counted in words rather than lines: a heading plus three real acceptance
 * criteria is four lines and a perfectly good document, while four lines of
 * section headers with nothing under them is not.
 */
const THIN_DOCUMENT_WORDS = 20;

const requiredSections: Sensor = {
  id: "required-sections",
  describes: "Produced artifacts exist, have structure, and are not full of placeholders.",
  run(context) {
    const findings: Finding[] = [];

    for (const name of context.step.produces) {
      const path = artifactPath(context.paths, context.step.id, name);

      if (!existsSync(path)) {
        findings.push(warn(`\`${name}\` was declared but never written.`, path));
        continue;
      }

      const body = readFileSync(path, "utf-8");
      const words = prose(body);

      if (words < THIN_DOCUMENT_WORDS) {
        findings.push(
          warn(`\`${name}\` has only ${words} words of content; it looks like a stub.`, path),
        );
      }

      if (!/^#{1,6} /m.test(body)) {
        findings.push(info(`\`${name}\` has no headings, so it may be hard to read back.`, path));
      }

      const placeholders = [...new Set(body.match(PLACEHOLDER) ?? [])];
      if (placeholders.length > 0) {
        findings.push(
          warn(
            `\`${name}\` still contains ${placeholders.join(", ")} — unresolved ` +
              `questions become someone else's guess downstream.`,
            path,
          ),
        );
      }
    }

    return pass(this.id, findings);
  },
};

// ── upstream-coverage ───────────────────────────────────────────────────────

const upstreamCoverage: Sensor = {
  id: "upstream-coverage",
  describes: "The step's output engages with the inputs it was given.",
  run(context) {
    const consumed = consumedOf(context);
    if (consumed.length === 0) return skip(this.id, "this step consumes nothing");

    const produced = artifactsOf(context);
    if (produced.length === 0) return skip(this.id, "no artifacts were produced");

    const findings: Finding[] = [];
    const haystack = produced.map((artifact) => artifact.body).join("\n").toLowerCase();

    for (const input of consumed) {
      const headings = headingsOf(input.body);
      if (headings.length === 0) continue;

      const covered = headings.filter((heading) => haystack.includes(heading.toLowerCase()));
      if (covered.length === 0) {
        findings.push(
          warn(
            `Nothing in this step's output refers to anything in \`${input.name}\`. ` +
              `Either it was not used, or the output does not say how.`,
            input.path,
          ),
        );
      }
    }

    return pass(this.id, findings);
  },
};

/** Words of actual content: headings and list markers are structure, not prose. */
function prose(body: string): number {
  return body
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, " ")
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word)).length;
}

function headingsOf(body: string): string[] {
  return [...body.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)]
    .map((match) => match[1]!.trim())
    .filter((heading) => heading.length > 3);
}

// ── traceability ────────────────────────────────────────────────────────────

const traceability: Sensor = {
  id: "traceability",
  describes: "Every acceptance criterion is accounted for in the validation.",
  run(context) {
    const criteria = consumedOf(context).find((artifact) =>
      artifact.name.includes("acceptance-criteria"),
    );
    if (!criteria) return skip(this.id, "no acceptance-criteria artifact to trace against");

    const produced = artifactsOf(context);
    if (produced.length === 0) return skip(this.id, "no artifacts were produced");

    const items = checklistOf(criteria.body);
    if (items.length === 0) {
      return pass(this.id, [
        info(`\`${criteria.name}\` has no itemized criteria, so there is nothing to trace.`),
      ]);
    }

    const haystack = produced.map((artifact) => artifact.body).join("\n").toLowerCase();
    const common = commonWords(items);
    const missing = items.filter((item) => !mentions(haystack, item, common));

    if (missing.length === 0) return pass(this.id);

    return pass(this.id, [
      warn(
        `${missing.length} of ${items.length} acceptance criteria are not mentioned in the ` +
          `validation: ${missing.slice(0, 3).map((item) => `"${truncate(item)}"`).join(", ")}` +
          `${missing.length > 3 ? ", …" : ""}. Unmentioned is not the same as met.`,
        criteria.path,
      ),
    ]);
  },
};

/** Bullets and numbered items, which is how criteria are written in practice. */
function checklistOf(body: string): string[] {
  return [...body.matchAll(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/gm)]
    .map((match) => match[1]!.trim())
    .filter((item) => item.length > 10);
}

function significantWords(item: string): string[] {
  return item
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4 && !STOPWORDS.has(word));
}

/**
 * Words that appear in most of the criteria, and so say nothing about any one
 * of them.
 *
 * In a document about cancelling orders, "order" and "cancelled" are in every
 * line. Matching on them would mark an untouched criterion as covered just
 * because the validation discussed the same feature — which is exactly the
 * false pass this sensor exists to catch.
 */
function commonWords(items: readonly string[]): Set<string> {
  const common = new Set<string>();
  if (items.length < 3) return common;

  const frequency = new Map<string, number>();
  for (const item of items) {
    for (const word of new Set(significantWords(item))) {
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }

  for (const [word, count] of frequency) {
    if (count > items.length / 2) common.add(word);
  }
  return common;
}

/**
 * Does the validation engage with this criterion? Matched on its distinctive
 * words rather than the whole sentence, since nobody restates a criterion
 * verbatim.
 */
function mentions(haystack: string, item: string, common: ReadonlySet<string>): boolean {
  const words = significantWords(item).filter((word) => !common.has(word));

  // Nothing distinctive to look for; assume covered rather than cry wolf.
  if (words.length === 0) return true;

  const hits = words.filter((word) => haystack.includes(word)).length;
  return hits / words.length >= 0.5;
}

const STOPWORDS = new Set([
  "should", "shall", "must", "would", "could", "there", "their", "which",
  "where", "when", "while", "about", "after", "before", "these", "those",
  "being", "having", "value", "values", "given", "return", "returns",
]);

function truncate(value: string, max = 50): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ── docs-coverage ───────────────────────────────────────────────────────────

const docsCoverage: Sensor = {
  id: "docs-coverage",
  describes: "Code changes arrived with the documentation they imply.",
  run(context) {
    const { docs } = context.config;
    if (!docs.required) return skip(this.id, "documentation is not required in this project");

    const changed = context.stepState.changedFiles;
    if (changed.length === 0) return skip(this.id, "this step changed no files");

    if (!owesDocumentation(changed, docs)) {
      const touched = changed.filter((file) => isDocsPath(file, docs));
      return pass(
        this.id,
        touched.length > 0
          ? [info(`Documentation was updated: ${touched.join(", ")}.`)]
          : [],
      );
    }

    const surfaces = [`\`${docs.dir}/\``, ...docs.files.map((file) => `\`${file}\``)].join(", ");

    return pass(this.id, [
      warn(
        `${changed.length} file(s) changed and no documentation was touched. If this ` +
          `changed behavior, a command, a flag, or a public interface, it belongs in ` +
          `${surfaces} now rather than later.`,
      ),
    ]);
  },
};

// ── type-check and linter ───────────────────────────────────────────────────
//
// These run a command the project configured. With nothing configured they skip
// rather than pass: pi does not guess at build tooling, and a green report that
// silently checked nothing would be worse than an honest gap.

function commandSensor(id: string, key: "typeCheck" | "lint", describes: string): Sensor {
  return {
    id,
    describes,
    run(context) {
      const command = context.config.checks?.[key];
      if (!command) {
        return skip(id, `no \`checks.${key}\` command is configured in pi.config.json`);
      }

      if (context.stepState.changedFiles.length === 0) {
        return skip(id, "this step changed no files");
      }

      try {
        execSync(command, {
          cwd: context.projectDir,
          stdio: "pipe",
          encoding: "utf-8",
          timeout: 120_000,
        });
        return pass(id, [info(`\`${command}\` passed.`)]);
      } catch (cause) {
        const error = cause as { stdout?: string; stderr?: string; signal?: string };
        if (error.signal === "SIGTERM") {
          return pass(id, [warn(`\`${command}\` timed out after 120s.`)]);
        }

        const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
        return pass(id, [
          warn(`\`${command}\` failed:\n${indent(tail(output))}`),
        ]);
      }
    },
  };
}

function tail(output: string, lines = 15): string {
  const all = output.split("\n");
  return all.length <= lines ? output : `…\n${all.slice(-lines).join("\n")}`;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

// ── The registry ────────────────────────────────────────────────────────────

export const SENSORS: readonly Sensor[] = [
  requiredSections,
  upstreamCoverage,
  traceability,
  docsCoverage,
  commandSensor("type-check", "typeCheck", "The project's type checker passes."),
  commandSensor("linter", "lint", "The project's linter passes."),
];

export const SENSOR_IDS: readonly string[] = SENSORS.map((sensor) => sensor.id);

export function findSensor(id: string): Sensor | undefined {
  return SENSORS.find((sensor) => sensor.id === id);
}

/**
 * Run the sensors a step declared.
 *
 * A sensor that throws is reported as a broken sensor, not as a failing step:
 * advisory tooling that crashes a run would be worse than no tooling.
 */
export function runSensors(context: SensorContext): SensorResult[] {
  return context.step.sensors.map((id) => {
    const sensor = findSensor(id);
    if (!sensor) return skip(id, "no sensor by that name is registered");

    try {
      return sensor.run(context);
    } catch (cause) {
      return skip(id, `the sensor itself failed: ${(cause as Error).message}`);
    }
  });
}

/** The lines a gate shows. Empty when everything passed quietly. */
export function renderSensors(results: readonly SensorResult[]): string[] {
  const lines: string[] = [];

  for (const result of results) {
    if (result.skipped) continue;

    for (const finding of result.findings) {
      const marker = finding.severity === Severity.Warn ? "warn" : "note";
      lines.push(`${marker}  [${result.sensor}] ${finding.message}`);
    }
  }

  return lines;
}

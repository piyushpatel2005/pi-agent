// Per-repository configuration: `pi.config.json` at the project root.
//
// Everything here has a working default, so a repo with no config file still
// runs. The file exists to describe things only the repo knows — where its docs
// live, whether it has a frontend, how large a change may get before review.
//
// The documentation policy deserves a note on why it is configuration rather
// than persona prose. "Update the docs" written into an agent's instructions is
// unenforceable and drifts per repo. Declared here, it becomes: one generated
// sentence in the agent's brief, one deterministic check after the step, and
// one place to change when a repo keeps its docs somewhere unusual.

import { z } from "zod";

import { ChangeBudget } from "./workflow.ts";

export const CONFIG_VERSION = 1;

/** Repos differ on where prose lives; this is the only place that knows. */
export const DocsConfig = z.object({
  /** Directory holding long-form documentation. */
  dir: z.string().min(1).default("docs"),

  /**
   * Individual files outside `dir` that are documentation too. Listed
   * explicitly because a README at the root is documentation while a random
   * root-level Markdown file usually is not.
   */
  files: z.array(z.string().min(1)).default(["README.md"]),

  /**
   * Whether a step that changed source is expected to touch documentation.
   * Turning this off keeps the config (so the agent still knows where docs go)
   * while dropping the expectation.
   */
  required: z.boolean().default(true),

  /**
   * Source paths that never warrant a doc update — tests, fixtures, generated
   * code. Matched as path prefixes or `*` suffix globs.
   */
  exempt: z.array(z.string().min(1)).default(["tests/", "test/", "**/*.test.*", "dist/"]),
});

export type DocsConfig = z.infer<typeof DocsConfig>;

/** Shell commands the sensors run to verify a step's work. */
export const ChecksConfig = z.object({
  typeCheck: z.string().min(1).optional(),
  lint: z.string().min(1).optional(),
});

export type ChecksConfig = z.infer<typeof ChecksConfig>;

export const ProjectConfig = z.object({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),

  /** Which coding tool this project is wired for. */
  harness: z.string().min(1).default("cursor"),

  /** Workflow used when `pi start` is given no `--workflow`. */
  defaultWorkflow: z.string().min(1).default("feature"),

  docs: DocsConfig.prefault({}),

  /**
   * Project truths the workflow's `when` conditions resolve against. Declared
   * once here instead of being guessed per run.
   */
  facts: z.record(z.string(), z.boolean()).default({}),

  /**
   * Project-wide ceiling on how much one step may change before review.
   * A step's own budget still wins when it is stricter.
   */
  changeBudget: ChangeBudget.optional(),

  /**
   * Commands the `type-check` and `linter` sensors run.
   *
   * Optional, and skipped rather than assumed when absent: pi does not guess at
   * a project's build tooling, and a sensor that silently checked nothing would
   * report green for the wrong reason.
   */
  checks: ChecksConfig.optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** The config a repo gets when it has no `pi.config.json`. */
export function defaultConfig(): ProjectConfig {
  return ProjectConfig.parse({});
}

// ── Documentation policy ────────────────────────────────────────────────────

function normalize(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** Is this path part of the project's documentation? */
export function isDocsPath(path: string, docs: DocsConfig): boolean {
  const candidate = normalize(path);
  const dir = normalize(docs.dir).replace(/\/$/, "");

  if (candidate === dir || candidate.startsWith(`${dir}/`)) return true;
  return docs.files.some((file) => normalize(file) === candidate);
}

/** Is this path exempt from the expectation that a change is documented? */
export function isDocsExempt(path: string, docs: DocsConfig): boolean {
  const candidate = normalize(path);

  return docs.exempt.some((pattern) => {
    const rule = normalize(pattern);

    // `**/*.test.*` style: match on the trailing segment pattern.
    if (rule.includes("*")) {
      const expression = new RegExp(
        `^${rule
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      return expression.test(candidate);
    }

    const prefix = rule.replace(/\/$/, "");
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  });
}

/**
 * Given the files a step changed, does it owe a documentation update?
 *
 * True only when the step changed something substantive and touched no
 * documentation. This is what the docs sensor reports on and what a
 * code-writing persona is told to avoid.
 */
export function owesDocumentation(
  changedFiles: readonly string[],
  docs: DocsConfig,
): boolean {
  if (!docs.required) return false;

  const touchedDocs = changedFiles.some((file) => isDocsPath(file, docs));
  if (touchedDocs) return false;

  return changedFiles.some(
    (file) => !isDocsPath(file, docs) && !isDocsExempt(file, docs),
  );
}

/**
 * The documentation contract, worded for an agent brief.
 *
 * Generated from config rather than written into each persona file, so a repo
 * that keeps docs in `website/content` gets instructions naming that path and
 * there is exactly one place to change it.
 */
export function renderDocsInstruction(docs: DocsConfig): string {
  if (!docs.required) {
    return `Documentation lives in \`${docs.dir}/\`${
      docs.files.length > 0 ? ` and ${docs.files.map((f) => `\`${f}\``).join(", ")}` : ""
    }. Update it when a change makes it wrong, but it is not required for every change.`;
  }

  const surfaces = [`\`${docs.dir}/\``, ...docs.files.map((file) => `\`${file}\``)];
  const list =
    surfaces.length > 1
      ? `${surfaces.slice(0, -1).join(", ")} and ${surfaces.at(-1)}`
      : surfaces[0];

  return [
    `Documentation is part of the work, not a follow-up. When you change behavior, ` +
      `a command, a flag, a configuration key, or a public interface, update ${list} ` +
      `in the same step.`,
    `Grep the documentation surfaces for anything your change makes stale — renamed files, ` +
      `removed flags, changed defaults — and fix those references too.`,
    `Exempt from this: ${docs.exempt.map((pattern) => `\`${pattern}\``).join(", ")}.`,
  ].join(" ");
}

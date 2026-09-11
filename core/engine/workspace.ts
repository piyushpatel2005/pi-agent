// The project's view of pi: its config, its workflows, and which run is active.
//
// The CLI, and later the hooks, both need the same answers to "what is
// configured here?" and "which run am I talking about?". Answering that in one
// place keeps them from drifting.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { TOOL_NAMES } from "../schemas/agent.ts";
import { ProjectConfig, defaultConfig } from "../schemas/config.ts";
import { RunState, RunStatus, StepStatus } from "../schemas/state.ts";
import type { CompiledWorkflow } from "../schemas/workflow.ts";
import { loadAgents, rosterContext, type AgentRoster } from "./agents.ts";
import { compileWorkflow, type CompileContext, type WorkflowIssue } from "./compile.ts";
import { SENSOR_IDS } from "./sensors.ts";
import { runPaths, runsDir, type RunPaths } from "./paths.ts";

export const CONFIG_FILE = "pi.config.json";

/** Workflows that ship with pi, resolved relative to this file. */
const SHIPPED_WORKFLOWS = join(import.meta.dirname, "..", "workflows");

export class WorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export type LoadedWorkflow = {
  workflow: CompiledWorkflow;
  source: string;
  /** Non-fatal findings from compilation. */
  warnings: WorkflowIssue[];
};

export type BrokenWorkflow = {
  source: string;
  issues: WorkflowIssue[];
};

export type Workspace = {
  projectDir: string;
  config: ProjectConfig;
  configPath: string;
  /** The personas available here; a project file shadows a shipped one. */
  roster: AgentRoster;
  /** Compiled workflows by id; a project file shadows a shipped one. */
  workflows: Map<string, LoadedWorkflow>;
  /** Workflow files that failed to compile, kept so `pi doctor` can report them. */
  broken: BrokenWorkflow[];
};

export function openWorkspace(projectDir: string): Workspace {
  const configPath = join(projectDir, CONFIG_FILE);
  const config = readConfig(configPath);

  // Personas load first: workflows are compiled against them, so a workflow
  // naming a role that does not exist fails here rather than mid-run.
  const roster = loadAgents(projectDir);
  const context: CompileContext = {
    tools: TOOL_NAMES,
    sensors: SENSOR_IDS,
    ...rosterContext(roster),
  };

  const workflows = new Map<string, LoadedWorkflow>();
  const broken: BrokenWorkflow[] = [];

  // Project workflows load second so they shadow a shipped workflow of the
  // same id — that is how a team retunes `feature` without forking pi.
  for (const dir of [SHIPPED_WORKFLOWS, join(projectDir, "pi", "workflows")]) {
    loadWorkflowsFrom(dir, context, workflows, broken);
  }

  return { projectDir, config, configPath, roster, workflows, broken };
}

function readConfig(configPath: string): ProjectConfig {
  if (!existsSync(configPath)) return defaultConfig();

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (cause) {
    throw new WorkspaceError(
      "config-unreadable",
      `${configPath} is not valid JSON: ${(cause as Error).message}`,
    );
  }

  const parsed = ProjectConfig.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new WorkspaceError("config-invalid", `${configPath} is not a valid pi config:\n${detail}`);
  }

  return parsed.data;
}

function loadWorkflowsFrom(
  dir: string,
  context: CompileContext,
  into: Map<string, LoadedWorkflow>,
  broken: BrokenWorkflow[],
): void {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".workflow.json")) continue;
    const source = join(dir, entry);

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(source, "utf-8"));
    } catch (cause) {
      broken.push({
        source,
        issues: [
          { severity: "error", path: "", message: `not valid JSON: ${(cause as Error).message}` },
        ],
      });
      continue;
    }

    const result = compileWorkflow(raw, context);
    if (!result.ok) {
      broken.push({ source, issues: result.issues });
      continue;
    }

    into.set(result.workflow.id, {
      workflow: result.workflow,
      source,
      warnings: result.warnings,
    });
  }
}

export function requireWorkflow(workspace: Workspace, id: string): CompiledWorkflow {
  const loaded = workspace.workflows.get(id);
  if (loaded) return loaded.workflow;

  const known = [...workspace.workflows.keys()].sort().join(", ");
  throw new WorkspaceError(
    "unknown-workflow",
    `no workflow "${id}". Available: ${known || "(none)"}`,
  );
}

// ── The active run ──────────────────────────────────────────────────────────
//
// A pointer file rather than a flag on every command, so `pi status` and
// `pi next` mean the obvious thing. It is per-checkout and gitignored: two
// people working in the same repo do not share a cursor.

function activeRunPointer(projectDir: string): string {
  return join(runsDir(projectDir), "active");
}

export function activeRunId(projectDir: string): string | null {
  const pointer = activeRunPointer(projectDir);
  if (!existsSync(pointer)) return null;

  const id = readFileSync(pointer, "utf-8").trim();
  if (id === "") return null;

  // A pointer to a run that was deleted is stale, not fatal.
  return existsSync(runPaths(projectDir, id).state) ? id : null;
}

export function setActiveRun(projectDir: string, runId: string): void {
  mkdirSync(runsDir(projectDir), { recursive: true });
  writeFileSync(activeRunPointer(projectDir), `${runId}\n`, "utf-8");
}

export function clearActiveRun(projectDir: string): void {
  rmSync(activeRunPointer(projectDir), { force: true });
}

export function requireActiveRun(projectDir: string): { runId: string; paths: RunPaths } {
  const runId = activeRunId(projectDir);
  if (!runId) {
    throw new WorkspaceError(
      "no-active-run",
      "no active run here. Start one with `pi start \"<what you want to build>\"`.",
    );
  }
  return { runId, paths: runPaths(projectDir, runId) };
}

/** Every run id in the project, in no particular order. */
export function listRuns(projectDir: string): string[] {
  const dir = runsDir(projectDir);
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(runPaths(projectDir, entry.name).state))
    .map((entry) => entry.name)
    .sort();
}

export type RunSummary = {
  runId: string;
  active: boolean;
  goal: string;
  workflow: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  /** Steps finished out of the steps that apply to this project. */
  done: number;
  total: number;
};

/**
 * Every run with enough of its state to describe it, newest first.
 *
 * Ordered by when each run started, which is what a person means by "newest" —
 * the ids are random UUIDs, so sorting by name would be sorting by nothing.
 * Runs whose state cannot be read are left out rather than shown as rubble;
 * `pi doctor` is the place that reports damage.
 */
export function listRunSummaries(projectDir: string): RunSummary[] {
  const active = activeRunId(projectDir);

  return listRuns(projectDir)
    .flatMap((runId) => {
      const parsed = RunState.safeParse(
        JSON.parse(readFileSync(runPaths(projectDir, runId).state, "utf-8")),
      );
      if (!parsed.success) return [];

      const state = parsed.data;
      const steps = Object.values(state.steps);
      const applicable = steps.filter((step) => step.status !== StepStatus.Skipped);

      return [
        {
          runId,
          active: runId === active,
          goal: state.goal,
          workflow: state.workflow,
          status: state.status,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          done: applicable.filter((step) => step.status === StepStatus.Completed).length,
          total: applicable.length,
        },
      ];
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Find a run from a whole id or an unambiguous prefix.
 *
 * Run ids are UUIDs, and asking someone to type one exactly to switch between
 * two runs would make the feature not worth having.
 */
export function resolveRunId(projectDir: string, wanted: string): string {
  const runs = listRuns(projectDir);

  if (runs.includes(wanted)) return wanted;

  const matches = runs.filter((runId) => runId.startsWith(wanted));

  if (matches.length === 1) return matches[0]!;

  if (matches.length === 0) {
    throw new WorkspaceError(
      "no-such-run",
      `No run here starts with "${wanted}". Run \`pi runs\` to see them.`,
    );
  }

  throw new WorkspaceError(
    "ambiguous-run",
    `"${wanted}" matches ${matches.length} runs. Use more of the id:\n` +
      matches.map((runId) => `  ${runId}`).join("\n"),
  );
}

/** Is there a run in progress that a new one would push aside? */
export function unfinishedActiveRun(projectDir: string): RunSummary | undefined {
  return listRunSummaries(projectDir).find(
    (run) => run.active && run.status === RunStatus.Active && run.done < run.total,
  );
}

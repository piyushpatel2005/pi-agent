// Loading personas, and turning one plus a step into the brief a model reads.
//
// The brief is assembled here rather than written into each persona file for
// the same reason the docs contract is: the parts that vary per project (where
// docs live, what this step may touch, how much it may change) come from
// configuration, so persona files stay about the role and nothing else.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AgentSpec, effectiveTools, type Agent } from "../schemas/agent.ts";
import type { DocsConfig } from "../schemas/config.ts";
import { renderDocsInstruction } from "../schemas/config.ts";
import type { RunStepDirective } from "../schemas/directive.ts";
import { FrontmatterError, parseFrontmatter } from "./frontmatter.ts";

/** Personas that ship with pi, resolved relative to this file. */
const SHIPPED_AGENTS = join(import.meta.dirname, "..", "agents");

export class AgentError extends Error {
  readonly source: string;

  constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = "AgentError";
    this.source = source;
  }
}

export type AgentRoster = {
  agents: Map<string, Agent>;
  /** Files that failed to load, so `pi doctor` can report rather than crash. */
  broken: { source: string; message: string }[];
};

/**
 * Load the shipped personas, then any project ones on top.
 *
 * A project file whose id matches a shipped persona replaces it, which is how a
 * team adjusts how its backend developer works without forking pi.
 */
export function loadAgents(projectDir: string): AgentRoster {
  const agents = new Map<string, Agent>();
  const broken: AgentRoster["broken"] = [];

  for (const dir of [SHIPPED_AGENTS, join(projectDir, "pi", "agents")]) {
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".md")) continue;
      const source = join(dir, entry);

      try {
        const agent = parseAgent(readFileSync(source, "utf-8"), source);
        agents.set(agent.id, agent);
      } catch (cause) {
        broken.push({ source, message: (cause as Error).message });
      }
    }
  }

  return { agents, broken };
}

export function parseAgent(source: string, path: string): Agent {
  let parsed;
  try {
    parsed = parseFrontmatter(source);
  } catch (cause) {
    if (cause instanceof FrontmatterError) throw new AgentError(path, cause.message);
    throw cause;
  }

  const spec = AgentSpec.safeParse(parsed.data);
  if (!spec.success) {
    const detail = spec.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AgentError(path, detail);
  }

  if (parsed.body === "") {
    throw new AgentError(path, "has no body; a persona with no instructions does nothing");
  }

  return { ...spec.data, body: parsed.body, source: path };
}

export function requireAgent(roster: AgentRoster, id: string): Agent {
  const agent = roster.agents.get(id);
  if (agent) return agent;

  const known = [...roster.agents.keys()].sort().join(", ");
  throw new AgentError("roster", `no persona "${id}". Known: ${known || "(none)"}`);
}

/** The shape `compileWorkflow` wants, so a workflow naming a bad role fails to compile. */
export function rosterContext(roster: AgentRoster): {
  agents: string[];
  agentTools: Record<string, readonly string[]>;
} {
  const agentTools: Record<string, readonly string[]> = {};
  for (const [id, agent] of roster.agents) agentTools[id] = agent.tools;

  return { agents: [...roster.agents.keys()], agentTools };
}

// ── The brief ───────────────────────────────────────────────────────────────

export type BriefContext = {
  goal: string;
  docs: DocsConfig;
};

/**
 * Everything the model should know to execute one step, in one string.
 *
 * Ordered so the role comes first and the constraints come last: the reader
 * should know who they are before they are told what they may not do.
 */
export function renderBrief(
  agent: Agent,
  directive: RunStepDirective,
  context: BriefContext,
): string {
  const sections: string[] = [];
  const tools = effectiveTools(agent, directive.tools);

  sections.push(
    `# ${agent.name}\n\n${agent.description}\n\n` +
      `You are on step ${directive.progress.index + 1} of ${directive.progress.total} ` +
      `(\`${directive.step}\`) of: ${context.goal}`,
  );

  sections.push(`## Your objective\n\n${directive.objective}`);

  if (directive.attempt > 1 && directive.feedback) {
    sections.push(
      `## This is attempt ${directive.attempt}\n\n` +
        `Your previous attempt was sent back with this feedback. Address it ` +
        `specifically rather than starting over:\n\n> ${directive.feedback}`,
    );
  }

  sections.push(`## How you work\n\n${demoteHeadings(agent.body)}`);

  if (directive.consumes.length > 0) {
    const lines = directive.consumes.map(
      (ref) => `- \`${ref.name}\` — ${ref.path}${ref.present ? "" : "  **(missing)**"}`,
    );
    sections.push(
      `## Read these first\n\n${lines.join("\n")}\n\n` +
        `These are the inputs your step was given. Read them before you begin; ` +
        `anything marked missing is a gap you should report rather than invent around.`,
    );
  }

  if (directive.produces.length > 0) {
    const lines = directive.produces.map((ref) => `- \`${ref.name}\` — ${ref.path}`);
    sections.push(
      `## Produce these\n\n${lines.join("\n")}\n\n` +
        `The step is not complete until every one exists. A later step reads them, ` +
        `so write for that reader, not for yourself.`,
    );
  }

  sections.push(`## Tools you may use\n\n${tools.map((tool) => `\`${tool}\``).join(", ")}`);

  if (agent.writesCode) sections.push(`## Documentation\n\n${renderDocsInstruction(context.docs)}`);

  const limits = renderLimits(directive);
  if (limits) sections.push(limits);

  sections.push(
    `## Finishing\n\n` +
      `Do this step and only this step. Later steps have their own roles and ` +
      `their own budgets; work you do early on their behalf arrives unreviewed ` +
      `and unattributed.\n\n` +
      `When you are done, report it:\n\n` +
      `\`\`\`bash\npi report --step ${directive.step} --result completed\n\`\`\`\n\n` +
      `If you could not finish, report \`--result failed --error "<what stopped you>"\` ` +
      `instead. Do not report completion over known failures.`,
  );

  return sections.join("\n\n");
}

/**
 * Push the persona's own headings one level down so they nest under "How you
 * work" instead of competing with the brief's sections. Persona files can then
 * be written as standalone documents, which is how they read best on their own.
 */
function demoteHeadings(body: string): string {
  let inFence = false;

  return body
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return /^#{1,5} /.test(line) ? `#${line}` : line;
    })
    .join("\n");
}

function renderLimits(directive: RunStepDirective): string | null {
  const rules: string[] = [];

  if (directive.changeBudget) {
    rules.push(
      `You may change at most **${directive.changeBudget.maxFiles} files** and ` +
        `**${directive.changeBudget.maxLines} lines** in this step. This is not ` +
        `advisory: the guard refuses the call that would exceed it. Stop at a ` +
        `boundary you chose and request review before you are stopped at one you did not.`,
    );
  }

  for (const tool of directive.requireReviewBefore) {
    rules.push(
      `Before your first \`${tool}\` call you must call \`request-review\` and get ` +
        `an answer. Describe what you are about to do and why.`,
    );
  }

  if (directive.gate === "approval") {
    rules.push(
      `This step ends at an approval gate. A human reads your output before the ` +
        `run continues, so make your summary worth reading.`,
    );
  }

  return rules.length > 0 ? `## Limits\n\n${rules.map((rule) => `- ${rule}`).join("\n")}` : null;
}

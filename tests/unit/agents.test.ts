import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AgentError,
  loadAgents,
  parseAgent,
  renderBrief,
  requireAgent,
  rosterContext,
} from "../../core/engine/agents.ts";
import { ToolName, effectiveTools } from "../../core/schemas/agent.ts";
import { defaultConfig } from "../../core/schemas/config.ts";
import { DirectiveKind, type RunStepDirective } from "../../core/schemas/directive.ts";

const EXPECTED_ROSTER = [
  "backend-developer",
  "business-analyst",
  "devops-engineer",
  "frontend-developer",
  "qa-engineer",
  "solution-architect",
  "ui-designer",
];

function agentFile(frontmatter: string, body = "Do the thing."): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

function directive(overrides: Partial<RunStepDirective> = {}): RunStepDirective {
  return {
    kind: DirectiveKind.RunStep,
    step: "backend-implementation",
    agent: "backend-developer",
    objective: "Implement the orders service.",
    attempt: 1,
    tools: [ToolName.Read, ToolName.WriteCode, ToolName.RequestReview],
    consumes: [{ name: "architecture.md", path: "/run/architecture.md", present: true }],
    produces: [{ name: "backend-summary.md", path: "/run/backend-summary.md", present: false }],
    gate: "approval",
    requireReviewBefore: [ToolName.WriteCode],
    sensors: [],
    progress: { index: 3, total: 8 },
    warnings: [],
    ...overrides,
  } as RunStepDirective;
}

describe("parseAgent", () => {
  test("reads the frontmatter and keeps the body verbatim", () => {
    const agent = parseAgent(
      agentFile("id: tester\nname: Tester\ndescription: Tests.\ntools: [read]"),
      "tester.md",
    );

    assert.equal(agent.id, "tester");
    assert.equal(agent.name, "Tester");
    assert.deepEqual(agent.tools, ["read"]);
    assert.equal(agent.body, "Do the thing.");
    assert.equal(agent.source, "tester.md");
  });

  test("delegate is denied by default, so a worker cannot spawn workers", () => {
    const agent = parseAgent(agentFile("id: a\nname: A\ndescription: d"), "a.md");
    assert.deepEqual(agent.denyTools, [ToolName.Delegate]);
    assert.equal(agent.writesCode, false);
  });

  test("rejects an unknown tool instead of ignoring it", () => {
    assert.throws(
      () => parseAgent(agentFile("id: a\nname: A\ndescription: d\ntools: [sudo]"), "a.md"),
      AgentError,
    );
  });

  test("rejects an id that is not kebab-case", () => {
    assert.throws(
      () => parseAgent(agentFile("id: Backend_Dev\nname: A\ndescription: d"), "a.md"),
      /kebab-case/,
    );
  });

  test("rejects a persona with no body", () => {
    assert.throws(() => parseAgent("---\nid: a\nname: A\ndescription: d\n---\n", "a.md"), /no body/);
  });

  test("names the file in the error", () => {
    try {
      parseAgent("no frontmatter", "somewhere/a.md");
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof AgentError);
      assert.equal(error.source, "somewhere/a.md");
    }
  });
});

describe("effectiveTools", () => {
  test("subtracts the persona's denials from the step's grant", () => {
    const agent = parseAgent(
      agentFile("id: a\nname: A\ndescription: d\ntools: [read, write-code]\ndenyTools: [write-code]"),
      "a.md",
    );
    assert.deepEqual(effectiveTools(agent, ["read", "write-code"]), ["read"]);
  });

  test("delegate is stripped even when a persona forgets to deny it", () => {
    const agent = parseAgent(
      agentFile("id: a\nname: A\ndescription: d\ntools: [read]\ndenyTools: []"),
      "a.md",
    );
    assert.deepEqual(effectiveTools(agent, ["read", "delegate"]), ["read"]);
  });
});

describe("the shipped roster", () => {
  const roster = loadAgents("/nonexistent-project");

  test("is exactly the seven personas, all valid", () => {
    assert.deepEqual([...roster.agents.keys()].sort(), EXPECTED_ROSTER);
    assert.deepEqual(roster.broken, []);
  });

  test("only code-writing roles hold write-code", () => {
    for (const agent of roster.agents.values()) {
      const holdsWriteCode = agent.tools.includes(ToolName.WriteCode);
      assert.equal(
        holdsWriteCode,
        agent.writesCode,
        `${agent.id}: writesCode=${agent.writesCode} but write-code grant=${holdsWriteCode}`,
      );
    }
  });

  test("no persona may delegate", () => {
    for (const agent of roster.agents.values()) {
      assert.ok(!agent.tools.includes(ToolName.Delegate), `${agent.id} holds delegate`);
      assert.ok(agent.denyTools.includes(ToolName.Delegate), `${agent.id} does not deny delegate`);
    }
  });

  test("every code-writing role has a change budget", () => {
    for (const agent of roster.agents.values()) {
      if (!agent.writesCode) continue;
      assert.ok(agent.changeBudget, `${agent.id} writes code with no budget`);
    }
  });

  test("rosterContext gives the compiler the ceiling for each role", () => {
    const context = rosterContext(roster);
    assert.deepEqual(context.agents.sort(), EXPECTED_ROSTER);
    assert.ok(context.agentTools["business-analyst"]);
    assert.ok(!context.agentTools["business-analyst"]!.includes(ToolName.WriteCode));
  });

  test("requireAgent explains itself on a miss", () => {
    assert.throws(() => requireAgent(roster, "scrum-master"), /no persona "scrum-master"/);
  });
});

describe("renderBrief", () => {
  const roster = loadAgents("/nonexistent-project");
  const backend = requireAgent(roster, "backend-developer");
  const context = { goal: "Add order cancellation", docs: defaultConfig().docs };

  test("opens with the role and where the step sits", () => {
    const brief = renderBrief(backend, directive(), context);
    assert.match(brief, /^# Backend Developer/);
    assert.match(brief, /step 4 of 8/);
    assert.match(brief, /Add order cancellation/);
  });

  test("carries the objective, inputs, and outputs", () => {
    const brief = renderBrief(backend, directive(), context);
    assert.match(brief, /Implement the orders service\./);
    assert.match(brief, /architecture\.md/);
    assert.match(brief, /backend-summary\.md/);
  });

  test("marks an input that is not there, rather than pretending", () => {
    const brief = renderBrief(
      backend,
      directive({ consumes: [{ name: "architecture.md", path: "/run/a.md", present: false }] }),
      context,
    );
    assert.match(brief, /\*\*\(missing\)\*\*/);
  });

  test("states the budget and the review requirement as rules", () => {
    const brief = renderBrief(
      backend,
      directive({ changeBudget: { maxFiles: 8, maxLines: 300 } }),
      context,
    );
    assert.match(brief, /8 files/);
    assert.match(brief, /300 lines/);
    assert.match(brief, /Before your first `write-code` call/);
  });

  test("includes the docs contract for a role that writes code", () => {
    assert.match(renderBrief(backend, directive(), context), /## Documentation/);
    assert.match(renderBrief(backend, directive(), context), /`docs\/`/);
  });

  test("omits the docs contract for a role that does not", () => {
    const analyst = requireAgent(roster, "business-analyst");
    const brief = renderBrief(
      analyst,
      directive({ agent: "business-analyst", step: "requirements", tools: [ToolName.Read] }),
      context,
    );
    assert.ok(!brief.includes("## Documentation"));
  });

  test("the docs contract follows the project's config", () => {
    const brief = renderBrief(backend, directive(), {
      ...context,
      docs: { dir: "website/content", files: ["CHANGELOG.md"], required: true, exempt: ["tests/"] },
    });
    assert.match(brief, /`website\/content\/`/);
    assert.match(brief, /`CHANGELOG\.md`/);
  });

  test("a retry leads with the feedback rather than burying it", () => {
    const brief = renderBrief(
      backend,
      directive({ attempt: 2, feedback: "Split the write path." }),
      context,
    );
    assert.match(brief, /attempt 2/);
    assert.match(brief, /Split the write path\./);
  });

  test("lists only the tools left after the persona's denials", () => {
    const brief = renderBrief(
      backend,
      directive({ tools: [ToolName.Read, ToolName.Delegate] }),
      context,
    );
    assert.match(brief, /## Tools you may use\n\n`read`/);
    assert.ok(!brief.includes("`delegate`"));
  });

  test("ends with the exact command to report the step", () => {
    const brief = renderBrief(backend, directive(), context);
    assert.match(brief, /pi report --step backend-implementation --result completed/);
  });

  test("nests the persona's headings under the brief's own", () => {
    const brief = renderBrief(backend, directive(), context);
    // "Before writing code" is `##` in the persona file; it must not compete
    // with the brief's own `##` sections.
    assert.match(brief, /^### Before writing code$/m);
    assert.match(brief, /^## How you work$/m);
  });
});

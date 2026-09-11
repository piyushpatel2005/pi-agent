import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { compileWorkflow, digestOf } from "../../core/engine/compile.ts";
import {
  GatePolicy,
  WorkflowSpec,
  evaluateWhen,
} from "../../core/schemas/workflow.ts";

/** An authored step before defaults are applied — every field optional but id/agent/objective. */
type DraftStep = {
  id: string;
  agent: string;
  objective: string;
  consumes?: string[];
  produces?: string[];
  tools?: string[];
  when?: string[];
  requireReviewBefore?: string[];
  sensors?: string[];
  gate?: GatePolicy;
  checkpoint?: boolean;
};

/** A small but realistic two-step workflow; cases below vary one thing at a time. */
function spec(overrides: Record<string, unknown> = {}): {
  id: string;
  name: string;
  version: number;
  steps: DraftStep[];
} & Record<string, unknown> {
  return {
    id: "feature",
    name: "Feature delivery",
    version: 1,
    steps: [
      {
        id: "requirements",
        agent: "business-analyst",
        objective: "Capture requirements.",
        produces: ["requirements.md"],
        tools: ["read", "write-artifact"],
      },
      {
        id: "architecture",
        agent: "solution-architect",
        objective: "Design the system.",
        consumes: ["requirements.md"],
        produces: ["architecture.md"],
        tools: ["read", "write-artifact"],
      },
    ],
    ...overrides,
  };
}

function expectIssue(result: ReturnType<typeof compileWorkflow>, match: RegExp) {
  assert.equal(result.ok, false, "expected compilation to fail");
  if (result.ok) return;
  const messages = result.issues.map((issue) => `${issue.path}: ${issue.message}`);
  assert.ok(
    messages.some((message) => match.test(message)),
    `no issue matched ${match}\ngot:\n  ${messages.join("\n  ")}`,
  );
}

describe("compileWorkflow", () => {
  test("compiles a well-formed workflow", () => {
    const result = compileWorkflow(spec());

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.workflow.steps.length, 2);
    assert.equal(result.warnings.length, 0);
  });

  test("resolves defaults so the router never sees inheritance", () => {
    const result = compileWorkflow(
      spec({
        defaults: { gate: GatePolicy.None, checkpoint: false },
        steps: [
          {
            id: "requirements",
            agent: "business-analyst",
            objective: "Capture requirements.",
            produces: ["requirements.md"],
          },
          {
            id: "build",
            agent: "backend-developer",
            objective: "Implement it.",
            consumes: ["requirements.md"],
            gate: GatePolicy.Approval,
          },
        ],
      }),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [first, second] = result.workflow.steps;
    assert.equal(first?.gate, GatePolicy.None, "inherited from defaults");
    assert.equal(first?.checkpoint, false);
    assert.equal(second?.gate, GatePolicy.Approval, "step overrides the default");
  });

  test("records step order as an index", () => {
    const result = compileWorkflow(spec());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.workflow.steps.map((step) => step.index),
      [0, 1],
    );
  });

  test("rejects a spec that is not a workflow at all", () => {
    expectIssue(compileWorkflow({ id: "nope" }), /name|version|steps/);
  });

  test("rejects duplicate step ids", () => {
    const duplicated = spec();
    duplicated.steps[1]!.id = "requirements";
    expectIssue(compileWorkflow(duplicated), /duplicate step id "requirements"/);
  });
});

describe("artifact wiring", () => {
  test("rejects consuming an artifact nobody produces", () => {
    const broken = spec();
    broken.steps[1]!.consumes = ["design-system.md"];
    expectIssue(compileWorkflow(broken), /"design-system.md" is consumed but never produced/);
  });

  test("rejects consuming an artifact produced later", () => {
    const broken = spec();
    broken.steps[0]!.consumes = ["architecture.md"];
    expectIssue(compileWorkflow(broken), /produced later, by step "architecture"/);
  });

  test("rejects two steps producing the same artifact", () => {
    const broken = spec();
    broken.steps[1]!.produces = ["requirements.md"];
    expectIssue(compileWorkflow(broken), /also produced by step "requirements"/);
  });

  test("rejects an unconditional step consuming a conditional artifact", () => {
    // The bug this catches: ux-design.md only exists on frontend projects, but
    // the step reading it would run on every project and find nothing.
    const broken = compileWorkflow(
      spec({
        steps: [
          {
            id: "ux-design",
            agent: "ui-designer",
            objective: "Design the screens.",
            produces: ["ux-design.md"],
            when: ["hasFrontend"],
          },
          {
            id: "frontend",
            agent: "frontend-developer",
            objective: "Build the screens.",
            consumes: ["ux-design.md"],
          },
        ],
      }),
    );

    expectIssue(broken, /does not share "hasFrontend".*missing input/);
  });

  test("accepts a conditional consumer that shares the producer's condition", () => {
    const result = compileWorkflow(
      spec({
        steps: [
          {
            id: "ux-design",
            agent: "ui-designer",
            objective: "Design the screens.",
            produces: ["ux-design.md"],
            when: ["hasFrontend"],
          },
          {
            id: "frontend",
            agent: "frontend-developer",
            objective: "Build the screens.",
            consumes: ["ux-design.md"],
            when: ["hasFrontend"],
          },
        ],
      }),
    );

    assert.equal(result.ok, true);
  });
});

describe("review grants", () => {
  test("rejects gating a tool the step was never granted", () => {
    const broken = spec();
    broken.steps[1]!.requireReviewBefore = ["write-code"];
    expectIssue(compileWorkflow(broken), /gated behind review but not granted/);
  });

  test("accepts gating a granted tool", () => {
    const ok = spec();
    ok.steps[1]!.tools = ["read", "write-code"];
    ok.steps[1]!.requireReviewBefore = ["write-code"];
    assert.equal(compileWorkflow(ok).ok, true);
  });
});

describe("roster references", () => {
  const roster = {
    agents: ["business-analyst", "solution-architect"],
    tools: ["read", "write-artifact"],
  };

  test("accepts references that exist", () => {
    assert.equal(compileWorkflow(spec(), roster).ok, true);
  });

  test("rejects an unknown agent and suggests the near miss", () => {
    const broken = spec();
    broken.steps[1]!.agent = "solution-architects";
    expectIssue(compileWorkflow(broken, roster), /unknown agent.*did you mean "solution-architect"/);
  });

  test("rejects an unknown tool", () => {
    const broken = spec();
    broken.steps[0]!.tools = ["read", "rm-rf"];
    expectIssue(compileWorkflow(broken, roster), /unknown tool "rm-rf"/);
  });

  test("skips the check when no roster is supplied", () => {
    const unknownAgent = spec();
    unknownAgent.steps[0]!.agent = "nobody";
    assert.equal(compileWorkflow(unknownAgent).ok, true);
  });
});

describe("when conditions", () => {
  test("rejects an unknown fact at parse time", () => {
    const broken = spec();
    broken.steps[0]!.when = ["hasQuantumBackend"];
    expectIssue(compileWorkflow(broken), /unknown fact "hasQuantumBackend"/);
  });

  test("evaluates plain and negated facts, ANDed together", () => {
    const facts = { hasFrontend: true, isBrownfield: false };

    assert.equal(evaluateWhen([], facts), true, "no conditions means always");
    assert.equal(evaluateWhen(["hasFrontend"], facts), true);
    assert.equal(evaluateWhen(["isBrownfield"], facts), false);
    assert.equal(evaluateWhen(["!isBrownfield"], facts), true);
    assert.equal(evaluateWhen(["hasFrontend", "!isBrownfield"], facts), true);
    assert.equal(evaluateWhen(["hasFrontend", "isBrownfield"], facts), false);
  });

  test("an unknown fact at runtime reads as false rather than throwing", () => {
    assert.equal(evaluateWhen(["hasFrontend"], {}), false);
    assert.equal(evaluateWhen(["!hasFrontend"], {}), true);
  });
});

describe("digest", () => {
  test("is stable across key reordering", () => {
    const a = WorkflowSpec.parse(spec());
    const b = WorkflowSpec.parse({
      version: 1,
      name: "Feature delivery",
      id: "feature",
      steps: spec().steps,
    });

    assert.equal(digestOf(a), digestOf(b));
  });

  test("changes when a step changes", () => {
    const a = WorkflowSpec.parse(spec());
    const changed = spec();
    changed.steps[1]!.objective = "Design the system differently.";
    const b = WorkflowSpec.parse(changed);

    assert.notEqual(digestOf(a), digestOf(b));
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { compileWorkflow } from "../../core/engine/compile.ts";
import {
  DenialReason,
  Permission,
  denialEvent,
  evaluate,
  recordChange,
  type ToolCall,
  type Verdict,
} from "../../core/engine/guard.ts";
import { planSteps } from "../../core/engine/router.ts";
import { parseAgent } from "../../core/engine/agents.ts";
import { ToolName } from "../../core/schemas/agent.ts";
import { RunState, RunStatus, STATE_VERSION, StepStatus } from "../../core/schemas/state.ts";
import type { RunState as RunStateType } from "../../core/schemas/state.ts";

const WORKFLOW = (() => {
  const result = compileWorkflow({
    id: "w",
    name: "W",
    version: 1,
    description: "d",
    defaults: { gate: "none", checkpoint: false },
    steps: [
      {
        id: "build",
        agent: "backend-developer",
        objective: "Build it.",
        produces: ["summary.md"],
        tools: ["read", "search", "write-code", "run-command", "request-review"],
        changeBudget: { maxFiles: 3, maxLines: 100 },
      },
      {
        id: "gated",
        agent: "backend-developer",
        objective: "Build it carefully.",
        produces: ["gated.md"],
        tools: ["read", "write-code", "request-review"],
        requireReviewBefore: ["write-code"],
        changeBudget: { maxFiles: 3, maxLines: 100 },
      },
    ],
  });

  assert.ok(result.ok, "fixture workflow must compile");
  return result.workflow;
})();

function stateAt(step: string, overrides: Record<string, unknown> = {}): RunStateType {
  const now = new Date().toISOString();
  return RunState.parse({
    version: STATE_VERSION,
    runId: "11111111-1111-4111-8111-111111111111",
    goal: "g",
    workflow: "w",
    workflowDigest: WORKFLOW.digest,
    createdAt: now,
    updatedAt: now,
    status: RunStatus.Active,
    currentStep: step,
    steps: planSteps(WORKFLOW, {}),
    ...overrides,
  });
}

/** A state with `step` running, and whatever tally the test needs. */
function running(
  step: string,
  stepOverrides: Record<string, unknown> = {},
  stateOverrides: Record<string, unknown> = {},
): RunStateType {
  const state = stateAt(step, stateOverrides);
  state.steps[step] = { ...state.steps[step]!, status: StepStatus.Active, ...stepOverrides };
  return state;
}

function check(state: RunStateType, call: ToolCall, context = {}): Verdict {
  return evaluate(state, WORKFLOW, call, context);
}

function assertDenied(verdict: Verdict, reason: DenialReason): void {
  assert.equal(verdict.permission, Permission.Deny);
  assert.equal(verdict.permission === Permission.Deny && verdict.reason, reason);
}

describe("reading is always allowed", () => {
  test("even when no step is active", () => {
    assert.equal(check(stateAt("build"), { tool: ToolName.Read }).permission, Permission.Allow);
    assert.equal(check(stateAt("build"), { tool: ToolName.Search }).permission, Permission.Allow);
  });

  test("even when the run is finished", () => {
    const done = stateAt("build", { status: RunStatus.Completed, currentStep: null });
    assert.equal(check(done, { tool: ToolName.Read }).permission, Permission.Allow);
  });
});

describe("run and step state", () => {
  // The three terminal statuses do not behave alike, and the asymmetry is the
  // point: a completed run has nothing left to protect, while a failed one
  // reached a plan that turned out to be wrong and a parked one still has work
  // pending. Pinning only the status that changed would leave the other two
  // free to drift into matching it.
  test("a completed run no longer governs the project", () => {
    const done = stateAt("build", { status: RunStatus.Completed });
    assert.equal(check(done, { tool: ToolName.WriteCode }).permission, Permission.Allow);
  });

  // Placement, not just behavior. A finished run also has no current step, so
  // an allowance sitting below that check would never be reached.
  test("a completed run is allowed even with no current step", () => {
    const done = stateAt("build", { status: RunStatus.Completed, currentStep: null });
    assert.equal(check(done, { tool: ToolName.WriteCode }).permission, Permission.Allow);
  });

  test("a failed run accepts no changes", () => {
    const failed = stateAt("build", { status: RunStatus.Failed });
    assertDenied(check(failed, { tool: ToolName.WriteCode }), DenialReason.RunNotActive);
  });

  test("a parked run accepts no changes", () => {
    const parked = stateAt("build", { status: RunStatus.Parked });
    assertDenied(check(parked, { tool: ToolName.WriteCode }), DenialReason.RunNotActive);
  });

  test("no active step means there is nothing to change", () => {
    const idle = stateAt("build", { currentStep: null });
    assertDenied(check(idle, { tool: ToolName.WriteCode }), DenialReason.NoActiveStep);
  });

  test("a step that has not been handed out yet cannot write", () => {
    assertDenied(check(stateAt("build"), { tool: ToolName.WriteCode }), DenialReason.StepNotRunning);
  });

  test("a step awaiting review is frozen", () => {
    const frozen = running("build", { status: StepStatus.AwaitingReview });
    const verdict = check(frozen, { tool: ToolName.WriteCode });
    assertDenied(verdict, DenialReason.ReviewPending);
    assert.match(
      verdict.permission === Permission.Deny ? verdict.message : "",
      /already moved on/,
    );
  });

  test("a current step missing from the workflow is reported, not ignored", () => {
    const drifted = stateAt("build", { currentStep: "ghost" });
    assertDenied(check(drifted, { tool: ToolName.WriteCode }), DenialReason.NoActiveStep);
  });
});

describe("tool grants", () => {
  test("a tool the step does not grant is refused", () => {
    const verdict = check(running("gated"), { tool: ToolName.RunCommand });
    assertDenied(verdict, DenialReason.ToolNotGranted);
    assert.match(
      verdict.permission === Permission.Deny ? verdict.message : "",
      /not something to work around/,
    );
  });

  test("the persona is still the ceiling when a step's grant is stale", () => {
    const analyst = parseAgent(
      "---\nid: business-analyst\nname: BA\ndescription: d\ntools: [read]\n---\n\nb",
      "ba.md",
    );
    const state = running("build", { agent: "business-analyst" });
    assertDenied(
      check(state, { tool: ToolName.WriteCode }, { agent: analyst }),
      DenialReason.ToolDeniedByPersona,
    );
  });

  test("a granted tool within the persona's reach is allowed", () => {
    const developer = parseAgent(
      "---\nid: backend-developer\nname: BE\ndescription: d\ntools: [read, write-code]\n---\n\nb",
      "be.md",
    );
    assert.equal(
      check(running("build"), { tool: ToolName.WriteCode }, { agent: developer }).permission,
      Permission.Allow,
    );
  });
});

describe("requireReviewBefore", () => {
  test("the first write is refused until a review is approved", () => {
    const verdict = check(running("gated"), { tool: ToolName.WriteCode, files: ["a.ts"] });
    assertDenied(verdict, DenialReason.ReviewRequired);
    assert.match(
      verdict.permission === Permission.Deny ? verdict.message : "",
      /pi review request/,
    );
  });

  test("an approved review unlocks the tool", () => {
    const state = running("gated", {
      receipts: [approved({ changedLines: 0, files: [] })],
    });
    assert.equal(
      check(state, { tool: ToolName.WriteCode, files: ["a.ts"] }).permission,
      Permission.Allow,
    );
  });

  test("a rejected review does not unlock it", () => {
    const state = running("gated", {
      receipts: [
        {
          ...approved({ changedLines: 0, files: [] }),
          resolution: { approved: false, at: new Date().toISOString(), feedback: "no" },
        },
      ],
    });
    assertDenied(
      check(state, { tool: ToolName.WriteCode, files: ["a.ts"] }),
      DenialReason.ReviewRequired,
    );
  });

  test("tools outside requireReviewBefore are unaffected", () => {
    assert.equal(check(running("gated"), { tool: ToolName.Read }).permission, Permission.Allow);
  });
});

function approved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: "receipt-1",
    step: "gated",
    requestedAt: now,
    summary: "s",
    files: [{ path: "a.ts", action: "modify" }],
    changedLines: 0,
    digest: "sha256:x",
    resolution: { approved: true, at: now },
    ...overrides,
  };
}

describe("the change budget", () => {
  test("allows a call that stays inside it", () => {
    const state = running("build", { changedFiles: ["a.ts"], changedLines: 40 });
    assert.equal(
      check(state, { tool: ToolName.WriteCode, files: ["b.ts"], lines: 30 }).permission,
      Permission.Allow,
    );
  });

  test("allows a call that lands exactly on the limit", () => {
    const state = running("build", { changedFiles: ["a.ts", "b.ts"], changedLines: 90 });
    assert.equal(
      check(state, { tool: ToolName.WriteCode, files: ["c.ts"], lines: 10 }).permission,
      Permission.Allow,
    );
  });

  test("refuses a call that would exceed the file limit", () => {
    const state = running("build", { changedFiles: ["a.ts", "b.ts", "c.ts"], changedLines: 10 });
    const verdict = check(state, { tool: ToolName.WriteCode, files: ["d.ts"], lines: 1 });
    assertDenied(verdict, DenialReason.OverBudget);
    assert.match(verdict.permission === Permission.Deny ? verdict.message : "", /4 files/);
  });

  test("refuses a call that would exceed the line limit", () => {
    const state = running("build", { changedFiles: ["a.ts"], changedLines: 95 });
    const verdict = check(state, { tool: ToolName.WriteCode, files: ["a.ts"], lines: 20 });
    assertDenied(verdict, DenialReason.OverBudget);
    assert.match(verdict.permission === Permission.Deny ? verdict.message : "", /115 lines/);
  });

  test("names both limits when both are blown", () => {
    const state = running("build", { changedFiles: ["a.ts", "b.ts", "c.ts"], changedLines: 99 });
    const verdict = check(state, { tool: ToolName.WriteCode, files: ["d.ts"], lines: 50 });
    assert.match(
      verdict.permission === Permission.Deny ? verdict.message : "",
      /4 files.*and.*149 lines/s,
    );
  });

  test("rewriting the same file does not spend the file budget again", () => {
    const state = running("build", { changedFiles: ["a.ts", "b.ts", "c.ts"], changedLines: 10 });
    assert.equal(
      check(state, { tool: ToolName.WriteCode, files: ["a.ts"], lines: 5 }).permission,
      Permission.Allow,
    );
  });

  test("a step with no budget is unbounded", () => {
    const result = compileWorkflow({
      id: "u",
      name: "U",
      version: 1,
      description: "d",
      defaults: { gate: "none", checkpoint: false },
      steps: [
        {
          id: "build",
          agent: "backend-developer",
          objective: "o",
          produces: ["s.md"],
          tools: ["write-code"],
        },
      ],
    });
    assert.ok(result.ok);

    const state = running("build", { changedFiles: Array.from({ length: 50 }, (_, i) => `${i}.ts`) });
    assert.equal(
      evaluate(state, result.workflow, { tool: ToolName.WriteCode, files: ["x.ts"], lines: 9999 })
        .permission,
      Permission.Allow,
    );
  });
});

describe("the budget after a review", () => {
  test("approval starts the allowance fresh rather than raising the ceiling", () => {
    // At the limit, then approved for exactly that work.
    const state = running("build", {
      changedFiles: ["a.ts", "b.ts", "c.ts"],
      changedLines: 100,
      receipts: [
        approved({
          step: "build",
          files: [
            { path: "a.ts", action: "modify" },
            { path: "b.ts", action: "modify" },
            { path: "c.ts", action: "modify" },
          ],
          changedLines: 100,
        }),
      ],
    });

    assert.equal(
      check(state, { tool: ToolName.WriteCode, files: ["d.ts"], lines: 50 }).permission,
      Permission.Allow,
    );
  });

  test("the fresh allowance is a full budget, not an unlimited one", () => {
    const state = running("build", {
      changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
      changedLines: 150,
      receipts: [
        approved({
          step: "build",
          files: [
            { path: "a.ts", action: "modify" },
            { path: "b.ts", action: "modify" },
            { path: "c.ts", action: "modify" },
          ],
          changedLines: 100,
        }),
      ],
    });

    // Three unreviewed files already; a fourth blows the refreshed budget.
    assertDenied(
      check(state, { tool: ToolName.WriteCode, files: ["g.ts"], lines: 1 }),
      DenialReason.OverBudget,
    );
  });

  test("an unresolved review does not refresh anything", () => {
    const state = running("build", {
      changedFiles: ["a.ts", "b.ts", "c.ts"],
      changedLines: 100,
      receipts: [approved({ step: "build", resolution: null })],
      status: StepStatus.Active,
    });
    assertDenied(
      check(state, { tool: ToolName.WriteCode, files: ["d.ts"], lines: 1 }),
      DenialReason.OverBudget,
    );
  });
});

describe("recordChange", () => {
  test("adds new files and accumulates lines", () => {
    const state = running("build");
    recordChange(state, { tool: ToolName.WriteCode, files: ["a.ts"], lines: 10 });
    recordChange(state, { tool: ToolName.WriteCode, files: ["b.ts"], lines: 5 });

    assert.deepEqual(state.steps.build!.changedFiles, ["a.ts", "b.ts"]);
    assert.equal(state.steps.build!.changedLines, 15);
  });

  test("a file changed twice is recorded once but its lines both count", () => {
    const state = running("build");
    recordChange(state, { tool: ToolName.WriteCode, files: ["a.ts"], lines: 10 });
    recordChange(state, { tool: ToolName.WriteCode, files: ["a.ts"], lines: 7 });

    assert.deepEqual(state.steps.build!.changedFiles, ["a.ts"]);
    assert.equal(state.steps.build!.changedLines, 17);
  });

  test("is a no-op when no step is active", () => {
    const idle = stateAt("build", { currentStep: null });
    recordChange(idle, { tool: ToolName.WriteCode, files: ["a.ts"], lines: 10 });
    assert.deepEqual(idle.steps.build!.changedFiles, []);
  });
});

describe("denialEvent", () => {
  test("records nothing for an allowed call", () => {
    assert.deepEqual(denialEvent({ tool: "read" }, { permission: Permission.Allow }, "build"), []);
  });

  test("names the guard that refused, so the log groups usefully", () => {
    const verdict = check(running("build", { changedFiles: ["a", "b", "c"] }), {
      tool: ToolName.WriteCode,
      files: ["d"],
      lines: 1,
    });
    const [event] = denialEvent({ tool: ToolName.WriteCode }, verdict, "build");

    assert.equal(event?.type, "guard.blocked");
    assert.equal((event as { guard: string }).guard, "change-budget");
    assert.equal((event as { reason: string }).reason, DenialReason.OverBudget);
  });
});

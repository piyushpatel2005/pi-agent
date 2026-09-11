# pi

A workflow harness for coding agents.

Your coding agent already has a model and a tool loop. What it doesn't have is a
memory of where it is, a rule about what it may do next, or a record of why it
did what it did. `pi` supplies those. It doesn't call an LLM — your agent stays
the agent, and `pi` becomes the constitution it works under.

Concretely, `pi` gives a run:

- **Seven personas** — business-analyst, solution-architect, ui-designer,
  frontend-developer, backend-developer, qa-engineer, devops-engineer — so each
  step of the work is done in one role at a time instead of all of them at once.
- **A deterministic router.** The engine, not the model, decides what happens
  next. Ask it with `pi next`, tell it what happened with `pi report`.
- **Approval gates with a presence rule.** A gate only resolves if a human acted
  since the last gate. An unattended run cannot approve its own work.
- **Change budgets.** A step declares how many files and lines it may touch
  before it has to stop and show you. This is what makes "review smaller
  changes" a rule instead of a hope.
- **An append-only event log.** Every step, gate, approval, and denial lands in
  NDJSON, so "why did it do that" is always answerable.

## Requirements

Node **22.18 or newer** — `pi` is TypeScript that Node runs directly via native
type stripping, so there is no build step.

```bash
node --version
```

## Install

From a clone:

```bash
git clone <this-repo> pi
cd pi
npm install
npm link
```

`npm link` puts `pi` on your `PATH`. Check it:

```bash
pi version
pi --help
```

To install without linking, `npm install -g .` from the clone works the same
way. To use it without installing at all, run `node /path/to/pi/cli/pi.ts`.

Uninstall with `npm unlink -g pi-harness`.

## Quickstart

In the project you want to work on:

```bash
cd ~/code/my-project
pi init
pi install     # wire pi into Cursor's hooks, then restart Cursor
```

`pi init` writes `pi.config.json` and a `pi/workflows/` directory. `pi install`
wires the guard into your coding tool — without it, `pi` still routes and
records, but nothing consults the guard, so budgets are advice again.

Open the config and set the **facts** — they decide which steps apply to your
project:

```json
{
  "facts": {
    "hasFrontend": true,
    "hasBackend": true,
    "needsInfra": false
  }
}
```

Then start a run:

```bash
pi start "Add an orders service with a REST API"
```

From here the loop is three commands. Ask what to do, do it, say what happened:

```bash
pi next                                        # the engine hands you one step
# ... you (or your coding agent) do the work ...
pi report --step requirements --result completed
```

When a step finishes and its gate is open, `pi next` will tell you it is waiting
on you rather than handing out more work:

```
"Capture what this feature must do" is done and ready for your approval.

Approve: pi report --step requirements --result approved
Send back: pi report --step requirements --result rejected --feedback "..."
```

Rejecting reruns the step with your feedback attached, so the next attempt knows
what was wrong. At any point:

```bash
pi status      # where the run is
pi log         # everything that has happened
```

## Commands

| Command | What it does |
| --- | --- |
| `pi init` | Scaffold `pi.config.json` and `pi/workflows/` |
| `pi install` | Wire pi into your coding tool's hooks |
| `pi start "<goal>"` | Begin a run; `--workflow <id>` picks a non-default one |
| `pi next` | The one thing to do now; `--json` for machine use |
| `pi report --step <id> --result <r>` | Record an outcome |
| `pi status` | Progress against the workflow |
| `pi log` | The event history; `--step <id>` to narrow |
| `pi workflows [<id>]` | List workflows, or show one in detail |
| `pi agents [<id>]` | List personas, or show one in detail |
| `pi review request` | Stop and ask for review of a change |
| `pi review resolve` | Answer the open review |
| `pi review status` | Reviews on the current step |
| `pi guard --tool <id>` | May this call proceed? (for harness hooks) |
| `pi human-turn` | Record that a human acted (gates require this) |
| `pi doctor` | Check this project's setup |

Results for `--report`: `completed`, `needs-review`, `approved`, `rejected`,
`failed`. Exit codes are `0` success, `1` error, `2` bad usage.

Every verb also accepts an `engine` prefix (`pi engine next`), which is the form
the harness layer uses.

### About `pi human-turn`

Approval gates need evidence that a person was actually there. `pi report
--result approved` mints that evidence automatically when you run it from an
interactive terminal. When a harness drives `pi` non-interactively, the harness
hook calls `pi human-turn` on the user's real messages instead. Either way, an
agent running unattended cannot manufacture its own approval.

## Small, reviewed changes

This is the part that makes `pi` more than a prompt. A step declares how much it
may change:

```json
"changeBudget": { "maxFiles": 8, "maxLines": 300 }
```

The guard is consulted before every tool call and refuses the one that would
cross the limit, with a message naming the way forward:

```
This change would put step "backend-implementation" at 310 lines against a
limit of 300.

The limit exists so that changes arrive in pieces a person can actually read.
Stop here, summarize what you have done so far, and ask for review:

  pi review request --summary "<what you changed and why>" --files <paths>
```

The tally is cumulative across the step, so splitting one change into smaller
calls doesn't get around it. Distinct files are counted, so rewriting the same
file five times is one file.

When the agent requests review, **the step freezes** — no further changes are
accepted until you answer, so the diff can't move underneath you:

```bash
pi review status              # what you owe an answer on
pi review resolve --approve
pi review resolve --reject --feedback "Split the write path"
```

**Approval starts the budget fresh; it does not raise the ceiling.** So the
budget means "review every N files", not "N files per step, ever". Rejection
resumes the step with your feedback attached.

`requireReviewBefore: ["write-code"]` forces a review before the *first* write
of a step, however small — for when you want to see the plan, not just the
overflow.

Three things keep a receipt from being theatre: it fingerprints what you read
(so an approval can't be retargeted at different work), the state store refuses
any edit to it after the fact, and resolving requires a recorded human turn, so
an unattended run can't approve its own work.

## Personas

Seven roles, each a Markdown file in `core/agents/`. See them with `pi agents`,
or read one in full with `pi agents backend-developer`.

| Persona | Owns | Writes code |
| --- | --- | --- |
| `business-analyst` | Requirements, acceptance criteria, final validation | no |
| `solution-architect` | Boundaries, contracts, technology choices | structure only |
| `ui-designer` | Screens, flows, states, accessibility | no |
| `frontend-developer` | Client implementation against contract and design | yes |
| `backend-developer` | Services, data models, APIs, migrations | yes |
| `qa-engineer` | Test strategy and unit/integration/e2e tests | yes |
| `devops-engineer` | Infrastructure, CI/CD, environments, security posture | yes |

The roster is small on purpose. Every handoff between roles loses context, so
seven broad personas beat twenty narrow ones.

Each file's frontmatter declares what the role may touch:

```yaml
---
id: backend-developer
name: Backend Developer
description: Implements services, data models, and APIs against the approved contract.
tools: [read, search, write-artifact, write-code, run-command, request-review]
denyTools: [delegate]
changeBudget: { maxFiles: 8, maxLines: 300 }
writesCode: true
---
```

`tools` is a **ceiling, not a default**. A workflow step grants a subset of it;
a step asking for more fails to compile, so a workflow cannot hand the business
analyst a code editor by asking nicely. `delegate` is denied to every persona —
only the conductor dispatches, so a worker can't quietly become an orchestrator
and bury a decision one level below what the log can see.

`writesCode` decides whether the generated documentation contract appears in
that role's brief.

To change how a role works, drop a file with the same `id` in `pi/agents/`. It
replaces the shipped one.

### The brief

`pi next --brief` renders what a coding agent should actually be given: the
persona, the step's objective, the artifacts to read and write, the tools it
holds, the documentation contract, and the budget — assembled as one prompt.
The short `pi next` is for humans.

The parts that vary per project (where docs live, what this step may touch, how
much it may change) come from configuration rather than from the persona file,
so persona files stay about the role.

## Configuration

`pi.config.json` in your project root:

```json
{
  "version": 1,
  "harness": "cursor",
  "defaultWorkflow": "feature",
  "docs": {
    "dir": "docs",
    "files": ["README.md"],
    "required": true,
    "exempt": ["tests/", "test/", "**/*.test.*", "dist/"]
  },
  "facts": {
    "hasFrontend": true,
    "hasBackend": true,
    "needsInfra": false,
    "isBrownfield": false
  }
}
```

- **`facts`** — the closed set of booleans that workflow `when` conditions
  resolve against. A step whose condition is false is marked skipped at the
  start of the run, so you can see up front what won't happen.
- **`docs`** — where documentation belongs in this repo. Implementation steps
  carry a generated instruction pointing at `dir` and `files`, and a
  `docs-coverage` sensor flags code changes that arrived without them.
  Everything matching `exempt` is excused.
- **`changeBudget`** — an optional project-wide default that steps inherit.

## Workflows

Three ship with `pi`:

- **`feature`** — requirements, architecture, UX design, backend, frontend,
  tests, infrastructure, validation. Eight steps, most of them conditional.
- **`quick`** — requirements, implementation, tests. For when you already know
  what you're building.
- **`bugfix`** — reproduce, diagnose, fix, regression test.

Inspect one with `pi workflows feature`.

To change how your team works, drop a JSON file in `pi/workflows/`. A file whose
`id` matches a shipped workflow shadows it, so you can retune `feature` without
forking `pi`. A step looks like this:

```json
{
  "id": "backend-implementation",
  "agent": "backend-developer",
  "objective": "Implement the services and data model behind the contract.",
  "when": ["hasBackend"],
  "consumes": ["architecture.md", "api-contract.md"],
  "produces": ["backend-summary.md"],
  "tools": ["read", "write-code", "run-command", "request-review"],
  "changeBudget": { "maxFiles": 8, "maxLines": 300 },
  "requireReviewBefore": ["write-code"],
  "gate": "approval",
  "sensors": ["type-check", "linter", "docs-coverage"]
}
```

Workflows are compiled, not just parsed. `pi` rejects a workflow that consumes
an artifact nobody produces, consumes one produced later, declares two producers
for the same artifact, requires review before a tool the step was never granted,
names a persona that does not exist, grants a persona a tool it does not hold,
or wires a conditional producer into an unconditional consumer. Run `pi doctor`
to see what failed and why.

## The harness layer

`pi` is not the agent. Your coding tool owns the model and the tool loop; `pi`
supplies routing, guards, state, and the audit trail around it. The harness
layer is the seam between them, and it is deliberately thin — three things:

1. **Hooks** pointed at `harness/cursor/adapter.ts`, which translates the host's
   tool calls into pi's vocabulary and answers allow or deny.
2. **A skill** (`.cursor/skills/pi/SKILL.md`) telling the agent how to drive the
   `next` / work / `report` loop.
3. **A permission** so running `pi` doesn't prompt on every call.

`pi install` writes all three, merging into your existing `.cursor/` config
rather than replacing it. Reinstalling is safe and idempotent; it also cleans up
hooks left pointing at a previous pi location.

What gets wired, by Cursor event:

| Event | What pi does |
| --- | --- |
| `sessionStart` | Tells a fresh session which run is active and where it stands |
| `beforeSubmitPrompt` | Mints the human turn that gates depend on |
| `preToolUse` | The guard: allow or deny, with a reason |
| `postToolUse` | Records what was actually changed, for the tally |
| `stop` | Nudges when a review or approval is outstanding |

Two honest caveats:

- **The guard fails open.** Any internal error allows the call. A guard that
  bricks your editor when pi has a bug is worse than one that occasionally
  misses a write, and the review gates still catch the work before it lands.
- **`stop` cannot block.** Cursor's stop hook has no decision channel, so an
  unfinished run surfaces as a follow-up nudge, not a refusal.

Porting to another tool means writing those three things for it and nothing
else — the engine, personas, and workflows are host-neutral.

## Where a run lives

```
<project>/pi/runs/<runId>/
  state.json       truth-of-now: step statuses, receipts, checkpoints
  events.ndjson    append-only audit log
  artifacts/       what each step produced
  checkpoints/
```

`state.json` is a cache the engine can answer guard questions from quickly;
`events.ndjson` is the record of what actually happened. `pi/runs/` should be
gitignored.

## Development

```bash
npm test          # node --test
npm run typecheck # tsc --noEmit
```

There is no build step and no runtime dependency beyond `zod`. The code avoids
TypeScript-only runtime syntax (enforced by `erasableSyntaxOnly`) so Node can
strip types and run the source directly.

## Status

Early, but usable end to end on Cursor: the engine, workflows, personas, the
guard, review receipts, the CLI, and the Cursor harness.

Still to come: the sensors (`docs-coverage`, `type-check`, `linter` are declared
by workflows but not yet run), `pi rewind` to a checkpoint, and harnesses for
Claude Code and Copilot.

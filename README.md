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
```

That writes `pi.config.json` and a `pi/workflows/` directory. Open the config and
set the **facts** — they decide which steps apply to your project:

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
| `pi start "<goal>"` | Begin a run; `--workflow <id>` picks a non-default one |
| `pi next` | The one thing to do now; `--json` for machine use |
| `pi report --step <id> --result <r>` | Record an outcome |
| `pi status` | Progress against the workflow |
| `pi log` | The event history; `--step <id>` to narrow |
| `pi workflows [<id>]` | List workflows, or show one in detail |
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
or wires a conditional producer into an unconditional consumer. Run `pi doctor`
to see what failed and why.

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

Early. The engine, schemas, workflows, and CLI work end to end. Persona
definitions, the tool registry with its reviewer gate, the sensors, and the
Cursor harness projection are still being built.

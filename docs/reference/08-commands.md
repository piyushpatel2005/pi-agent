# Commands

**This page answers one question: what does this command do, and what does it do
to the run?**

`pi --help` lists the flags. This page does not repeat them. For each command it
adds the three things `--help` cannot tell you: **what state the run must be in,
what state the command produces, and what it refuses.**

## The step state machine

Most of this page is easier to read once you have this. A step is in exactly one
of seven states:

| Status | Meaning |
| --- | --- |
| `pending` | Not reached yet. Grants no tools. |
| `active` | The current step. Work is happening. |
| `awaiting-review` | Work is written; a human has not looked at the change. |
| `awaiting-approval` | Reviewed; waiting for a human to approve and advance. |
| `completed` | Done. |
| `skipped` | A `when` condition was false, decided at `pi start`. |
| `failed` | Attempted and could not finish. |

`completed` and `skipped` are the two the router treats as "nothing more to do
here".

The run itself has four:

| Status | Meaning |
| --- | --- |
| `active` | In progress. |
| `parked` | Set aside at a clean boundary; resumable. |
| `completed` | Every step is finished or skipped. |
| `abandoned` | Stopped deliberately with `pi abandon`; history kept, guard released. |
| `failed` | A step failed. |

### What moves a step

| From | Command | To |
| --- | --- | --- |
| `pending` | `pi next` | `active` |
| `active` | `pi report --result completed` | `completed`, or `awaiting-approval` if the step has a gate |
| `active` | `pi report --result needs-review` | `awaiting-review` |
| `active` | `pi review request` | frozen; a pending receipt is added |
| `awaiting-review` | `pi review resolve` | `active` |
| `awaiting-approval` | `pi report --result approved` | `completed` |
| `awaiting-approval` | `pi report --result rejected` | `active`, attempt + 1 |
| any | `pi report --result failed` | `failed`, and the run fails too |

## Setup

### `pi init`

Writes `pi.config.json` and `pi/workflows/`, and adds a marked block to
`.gitignore` covering pi's config and run history.

Refuses to overwrite an existing config without `--force`. `--no-gitignore`
skips the ignore block.

This is a file-level operation with no opinion about runs; it neither requires
nor produces run state.

### `pi install`

Merges pi into your coding tool: hooks into `.cursor/hooks.json`, permission to
run `pi` unprompted into `.cursor/cli.json`, plus a skill and a rule under
`.cursor/`.

**Merges rather than overwrites.** Hooks you already had survive. Requires a
restart of your editor to take effect.

Without this, pi still routes and records, but nothing consults the guard —
budgets become advice.

### `pi uninstall`

The exact inverse. Unpicks pi's hooks and permissions, deletes the skill and
rule, and removes files and directories the removal left empty rather than
leaving husks. Anything it did not add, it leaves.

Keeps `pi.config.json` and `pi/` — including run history — unless you pass
`--purge`. `--purge` tells you how many runs it is about to discard first,
because a run's audit trail is the one thing nothing can recreate.

### `pi doctor`

Checks the project's setup: config present, wiring in place, personas and
workflows loading, run state coherent. Reports broken persona and workflow files
with the offending file and line rather than crashing on them.

Safe at any time. Changes nothing.

## Running

### `pi start "<goal>"`

Compiles the workflow, resolves every `when` condition against the `facts` in
`pi.config.json`, and writes a new run.

**Skips are decided here, once.** Editing `facts` afterwards does not change a
run already underway — the facts are copied into the run. Same for the workflow:
the run records a digest of the compiled workflow, so if the file changes
mid-run the router can say so rather than route against a definition that no
longer matches.

An unfinished run is parked, not discarded, and you are told. The run also
records which pi release started it, so a run that looks wrong six months later
can name the version to blame.

### `pi next`

Asks the engine what to do now. Deterministic: routing is the engine's job, so
the same state always gives the same answer.

**Side effect:** asking for a `pending` step starts it, moving it to `active`.
That transition is what makes the step's tools usable. A step that was never
started grants nothing, which is the cause of most "everything is refused"
reports.

Returns a step, a waiting-on-review notice, a waiting-on-approval notice, done,
or an error. Refuses when the run has failed.

`--brief` prints the full prompt: persona instructions, objective, artifact
paths, tool grants, budget, and the generated documentation contract. That is
the form an agent should read.

In the human-readable form, a consumed artifact that does not exist on disk is
marked `!`.

### `pi report --step <id> --result <r>`

Records an outcome. Five results:

| Result | Requires | Produces |
| --- | --- | --- |
| `completed` | `pending` or `active` | `completed`, or `awaiting-approval` at a gate |
| `needs-review` | `pending` or `active` | `awaiting-review` |
| `approved` | `awaiting-approval` | `completed`; run advances |
| `rejected` | `awaiting-approval` | `active`, attempt incremented |
| `failed` | any | `failed`; the run fails too |

`--artifacts a,b` records which artifacts the step produced. It records names
and does not create files.

`--feedback` is required on rejection. `--error` carries the reason on failure;
without one, pi records "no reason recorded".

Three behaviors worth knowing:

**`completed` is idempotent.** Reporting it against a step already `completed`
or `awaiting-approval` is a no-op rather than an error, because an agent's loop
can be interrupted between the report and the next call and a retry should not
be punished.

**Sensors run only on `completed`.** That is the moment they are useful, since a
human is about to decide. Their findings never change the outcome.

**A checkpoint is saved when a step finishes**, recording the git commit checked
out at the time.

`approved` and `rejected` require human presence — see below.

### `pi status`

Where the active run is: goal, status, step count, and every step with its state
and persona. `[x]` finished, `[-]` current, `[ ]` pending; skipped steps say so.

Read-only.

### `pi runs`

Lists runs newest first. `--use <id>` switches the active run; a unique prefix
of the id is enough.

### `pi log`

The run's event history, including refusals — which makes it the place to answer
"why was that blocked" after the fact. `--step <id>` narrows to one step.

Two gaps to know about: a run **completing** and a step being **skipped** are
recorded in the run's state but are not written to the log.

## Review

### `pi review request`

Freezes the step and records a pending receipt describing the proposed change.
While it is open, everything except reading and searching is refused.

Requires an `active` step. The `--summary` should say what changed, what you
left alone, and what you are unsure about.

### `pi review resolve`

Answers the open review with `--approve` or `--reject --feedback "..."`. Either
returns the step to `active`.

**Approval starts a fresh change allowance; it does not raise the ceiling.** The
budget is measured from the approval forward.

The receipt fingerprints what was reviewed, and the budget guard accepts it only
while that fingerprint still matches what is about to be written — so an
approval cannot be reused to wave through different code.

Requires human presence. Receipts are append-only: a resolution cannot be
revised or deleted.

### `pi review status`

Reviews on the current step, marking an unanswered one `WAITING ON YOU`.

## The guard

### `pi guard --tool <id>`

Asks whether a tool call may proceed. This is what the hooks call; you will
rarely run it yourself except to debug.

Prints `{"permission":"allow"}` or `{"permission":"deny","agent_message":"..."}`.

**A denial exits 0.** The verdict is in the JSON, not the exit code. Exit 2
means the command itself was wrong. If you script against this, read
`permission`.

`--files` and `--lines` describe the proposed change. `--record` adds it to the
step's tally — without it the call is evaluated but not counted.

`read` and `search` are always allowed, whatever state the run is in.

### `pi human-turn`

Records that a human acted.

Gates need this. An approval is refused unless a human has acted since the last
gate resolved, which is what stops an unattended run from approving its own
work. Each gate needs its own turn; resolving one banks no credit for the next.

Typing in an interactive session records a turn automatically. This command is
for the cases where that did not happen.

## Recovery

### `pi abandon`

Stops governing the active run without deleting it. The run's state and event
log stay on disk with status `abandoned`, and the active-run pointer is cleared
so the harness no longer refuses tool calls for that session.

Use this when a run is stuck at a gate you no longer want to finish, or when the
goal changed enough that starting fresh is simpler than rewinding. Optional
`--reason` is recorded in the log and printed.

Refuses when there is no active run. Agents cannot reach this command through
the harness control plane — only a human at the CLI can.

### `pi checkpoints`

Lists the boundaries you can rewind to, each with its timestamp and the git
commit that was checked out.

### `pi rewind --to <step>`

Moves the run's state back to a boundary.

**A dry run by default.** It prints what it would undo, including how many
review receipts it would discard, and changes nothing until you add `--yes`.

**It never touches your working tree.** pi moves its own state; moving the code
is yours, and the `gitHead` on the checkpoint tells you which commit to reach
for.

Rewinding is the only sanctioned way to discard review receipts, and it verifies
the state against the digest recorded on the checkpoint before it moves.

## Inspection

### `pi workflows` / `pi agents`

List, or show one in full. Project-local definitions are marked `(project)`.

### `pi sensors`

Dry-runs the current step's sensors, recording nothing. `--list` shows every
registered sensor.

Unlike the gate, **this prints skips with their reasons** — which is the reason
to use it. A skipped sensor at a gate prints nothing and looks exactly like a
clean pass. See [Sensors](10-sensors.md).

### `pi docs build`

Writes a static HTML site from the sequenced markdown files under the project's
`docs.dir` (default `docs/`). Only files matching `NN-slug.md` are included —
for example `01-what-pi-is.md`, `02-the-run-model.md`.

Markdown is rendered to HTML. Fenced blocks marked `mermaid` are rendered as
diagrams using the bundled [Mermaid](https://mermaid.js.org/) library copied
into `assets/mermaid/`.

```bash
pi docs build
pi docs build --out website/static/docs
```

Output:

- `index.html` — ordered table of contents
- `pages/*.html` — one page per markdown file
- `manifest.json` — machine-readable order for other tools
- `assets/mermaid/` — Mermaid runtime for diagram rendering

Does not touch the run. Refuses with a non-zero exit when no sequenced pages
are found.

### `pi docs serve`

Builds the site (unless `--no-build`) and serves it locally over HTTP.

```bash
pi docs serve
pi docs serve --port 8080 --host 0.0.0.0
pi docs serve --no-build --out dist/docs
```

Defaults to `http://127.0.0.1:4173/`. The process runs until you press Ctrl+C.
Use this while editing markdown; re-run or restart without `--no-build` to pick
up changes.

Equivalent npm scripts: `npm run docs:build` and `npm run docs:serve`.

### `pi version`

The release, and the schema versions it writes. `--json` for scripts.

## Conventions

`--json` is available on `status`, `next`, `runs`, `log`, `workflows`, `agents`,
and `version`, and is the stable form to script against.

Exit codes are `0` success, `1` error, `2` bad usage. The exception is
`pi guard`, where a denial is also `0` — see above.

Every verb also accepts an `engine` prefix, so `pi engine status` is `pi status`.
That is the form the harness layer uses internally; there is no behavioral
difference.

Every command works from anywhere inside the project.

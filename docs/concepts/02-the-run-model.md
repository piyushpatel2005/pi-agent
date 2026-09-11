# The run model

**This page answers one question: what are a run, a step, a gate, and an
artifact, and how do they relate?**

This is the vocabulary the rest of the documentation assumes. Everything here is
observable — you can see all of it with `pi status` and `pi log`.

## A run

A run is one piece of work from start to finish. You create one with a goal and
a workflow:

```bash
pi start "Add an orders service with a REST API" --workflow feature
```

The workflow supplies the steps; the goal is what you are trying to achieve. A
run gets an id, a directory under `pi/runs/<id>/`, and a status.

A run is `active` while work is happening, `completed` when every step is
finished or skipped, and `failed` if a step was reported failed.

A project can have several runs. One is the *active* run — the one commands act
on by default. `pi runs` lists them; `pi runs --use <id>` switches. Starting a
new run while another is unfinished sets the old one aside rather than
discarding it, and says so.

## A step

A step is one unit of work with one owner. It names a persona, an objective, the
artifacts it reads and writes, the tools it may use, and optionally a change
budget.

Steps run in the order the workflow lists them. pi does not parallelize, and
does not skip ahead: the current step is the first one that is not yet finished.

Each step has a status:

| Status | Meaning |
| --- | --- |
| `pending` | Not reached yet |
| `active` | The current step; work is happening |
| `awaiting-review` | A change has been proposed and a human has not answered |
| `awaiting-approval` | Work is done; waiting for a human to advance the run |
| `completed` | Finished |
| `skipped` | Not applicable to this run |
| `failed` | Attempted and could not be completed |

`completed` and `skipped` are the two that count as finished. Everything else
means the run is still on that step.

### Skipped steps

Some steps only apply to some projects. A step can declare conditions —
`hasFrontend`, `hasBackend`, `needsInfra`, `isBrownfield` — and it runs only if
all of them hold. The values come from the `facts` block in `pi.config.json`.

Skips are decided **once, when the run starts**, not as the run reaches each
step. That means `pi status` immediately after `pi start` shows you the whole
shape of the run, including what will not happen.

A fact you leave out of your config counts as false. An empty `facts` block
therefore skips every conditional step, quietly. It is worth reading `pi status`
once after starting a run for exactly this reason.

## The loop

Three commands, repeated:

```bash
pi next                                     # what should happen now
# ... the work ...
pi report --step <id> --result completed    # what happened
```

`pi next` answers one question and answers it deterministically — the engine
decides routing, not the agent. `pi next --brief` prints the full prompt for the
step: the persona, the objective, the artifacts, the tools, the limits.

`pi report` records the outcome. The results you can report are `completed`,
`needs-review`, `approved`, `rejected`, and `failed`.

Reporting `completed` means the work is done and its artifacts exist. It does
not mean you stopped. If something blocked you, the honest report is:

```bash
pi report --step <id> --result failed --error "what stopped you"
```

A failed step fails the run. The run stops accepting changes, and `pi next`
tells you to fix the cause and rewind, or start again. There is no resume
command; recovery is `pi rewind` or a new run.

## Gates

A gate is a deliberate stop at the end of a step.

Steps default to `gate: "approval"`. When such a step reports `completed`, it
does not finish — it moves to `awaiting-approval` and the run waits. A human
advances it:

```bash
pi report --step <id> --result approved
pi report --step <id> --result rejected --feedback "what should change"
```

Rejecting returns the step to `active` with the feedback attached, and the next
`pi next --brief` carries it. The attempt counter goes up. Nothing is lost.

A step declared `gate: "none"` finishes immediately on `completed` and the run
moves on without asking.

### Why an agent cannot approve its own work

pi tracks when a human last acted, and refuses to record an approval unless that
happened after the last gate was resolved. Approving twice in a row without a
human doing anything in between is refused.

A **human turn** is evidence that a person acted since the last gate resolved.
pi records one when:

- you **type and submit** a top-level message in your coding tool's chat (Cursor
  fires `beforeSubmitPrompt` for that case), or
- you run `pi human-turn` yourself in a terminal.

These do **not** count: clicking an option card, approving a suggested command,
or any UI interaction that does not go through a typed submission. If you made a
decision that way and a gate still refuses, type a short message in chat or run
`pi human-turn`, then retry the approval.

In a fully non-interactive session there is no human turn, so approvals refuse —
which is the intended behavior, not a bug.

## Reviews

A gate is the end of a step. A review is a stop *inside* one.

When an agent reaches a natural boundary, or is told by the guard that it is at
its budget, it stops and asks:

```bash
pi review request --summary "what changed and why" --files "modify:src/a.ts" --lines 120
```

The step freezes: until the review is answered, every tool except reading and
searching is refused. That freeze is the point — a review of code that has since
moved on is not a review.

You answer with `pi review resolve --approve` or `--reject --feedback "..."`.
Either way the step returns to `active`. Approving also starts the change budget
fresh.

Reviews are recorded as **receipts** on the step, and receipts are append-only.
One can be added, and answered exactly once. An answer cannot be revised or
deleted, which is what makes the record worth having.

## Artifacts

An artifact is a named file a step produces — `requirements.md`,
`architecture.md`, `test-results.md`. Steps declare what they produce and what
they consume, so a later step reads the earlier step's output rather than
guessing at it.

Artifacts live at `pi/runs/<id>/artifacts/<step>/<name>`. pi records their names
and tells the agent where they go; **the agent writes the files**. Reporting a
step with `--artifacts a,b` records the names, it does not create anything.

Artifacts are distinct from your source code. A step that writes
`architecture.md` and a step that edits `src/orders.ts` are doing different
things, and pi treats them differently: only source changes spend the change
budget.

## Checkpoints

When a step finishes, pi can snapshot the run. `pi checkpoints` lists the
boundaries, and `pi rewind --to <step>` moves the run back to one — dry run by
default, applied with `--yes`.

Rewinding moves pi's state only. Your files are untouched. Checkpoints record
the git commit that was checked out at the time, so you can move your code
yourself with git if you want to.

## What is on disk

Under `pi/runs/<run-id>/`:

| Path | What it is |
| --- | --- |
| `state.json` | The run as it is now: steps, statuses, receipts, tallies |
| `events.ndjson` | Append-only history, one event per line |
| `artifacts/<step>/` | What each step produced |
| `checkpoints/<step>.json` | Snapshots you can rewind to |

`pi log` reads the event log. Two things worth knowing: a run *completing* is
recorded in `state.json` but not written to the log, and skipped steps likewise
appear only in the state. The log is a history of what was done, not a complete
history of everything that became true.

## Next

[Guards and advice](03-guards-and-advice.md) covers the part of pi with teeth —
what can actually refuse a tool call, and what merely tells you something.

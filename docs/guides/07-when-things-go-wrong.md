# When things go wrong

**This page answers one question: the run is stuck or failed — how do I get
out?**

Start with `pi doctor` and `pi status`. Between them they explain most of it.

## The run is failed

Reporting a step failed fails the whole run:

```bash
pi report --step implementation --result failed \
  --error "The payments API has no cancellation endpoint"
```

```
Recorded: implementation → failed
  step.failed
  run.failed
```

After that the run stops accepting changes. `pi next` says so:

```
This run is marked failed. Start a new run or rewind to a checkpoint.
```

The guard refuses writes for the same reason. This is deliberate: a failed run
is a run whose plan turned out to be wrong, and continuing to write against a
wrong plan is how you get a large diff nobody asked for.

**There is no resume command.** Two ways forward: rewind to a checkpoint, or
start a new run. Which one depends on whether the plan is salvageable.

## Rewinding

```bash
pi checkpoints
```

```
Checkpoints for run 78410dc7-e5fa-4952-a66a-7d920f9fecea:

  requirements
    at        2026-09-11T15:37:49.934Z
    git HEAD  c8470f6afbe4

Rewind with: pi rewind --to <step>
```

Checkpoints are saved when a step finishes. Each records the git commit that was
checked out at the time.

```bash
pi rewind --to requirements
```

```
Rewind run 78410dc7-e5fa-4952-a66a-7d920f9fecea to the start, before any step ran.

  undoes    requirements, implementation
  discards  1 review receipt(s)

Your files are not touched. pi moves its own state; moving the code is yours.

Nothing changed. Re-run with --yes to apply.
```

**Rewind is a dry run by default.** It shows what it would undo and changes
nothing. Add `--yes` to apply.

**It does not touch your working tree.** pi moves its own state and nothing
else. If you want the code back too, that is git's job, and the `git HEAD`
recorded on the checkpoint tells you which commit to reach for.

Rewinding discards review receipts for the steps it undoes. That is the one
place pi's append-only record can be rolled back, and it is deliberate: rewinding
means those reviews were of work that no longer exists.

## The gate will not clear

You reported `completed`, the step is `awaiting-approval`, and approving does
not work.

**Check the human turn.** pi refuses an approval unless a human has acted since
the last gate resolved. From a non-interactive shell:

```
A review cannot be resolved without a human: no human turn has been recorded
since the last gate. Review requires an interactive session.
```

A human turn is recorded when you **type and submit** a top-level message in
chat, or when you run `pi human-turn` in a terminal. Clicking an option card or
approving a suggested command does **not** count. If you made a decision that
way and the gate still refuses, type a short message in chat, then retry:

```bash
pi report --step requirements --result approved
```

Each gate needs its own human turn.

**Check compound shell commands.** If an agent runs `cd … && pi report …`, the
`&&` disqualifies the line from pi's control-plane allowlist and the guard treats
it as a normal shell command — which a frozen step refuses. Bare `pi report …`
from the project directory is allowed; chained commands are not.

## The step will not start

`pi next` hands you a step, but every tool call is refused with "is not running".

Asking for a pending step is what *starts* it. If you skipped `pi next` and went
straight to work, the step is still `pending` and grants nothing. Run `pi next`.

## Steps I expected did not happen

`pi status` shows them skipped.

Skips are decided once, when the run starts, from the `facts` in
`pi.config.json`. **A fact you leave out counts as false**, so an empty or
partial `facts` block skips every conditional step.

Fix the config, then start a new run — the facts are frozen into the run at
`pi start`, so editing the file does not change a run already underway.

## A sensor is complaining

It is not blocking you. Sensors report at the gate and never stop a step. Decide
whether the finding is real and proceed either way.

The opposite problem is more dangerous: a sensor that **skips** prints nothing at
the gate, which looks exactly like a clean pass.

```bash
pi sensors
```

The dry run prints skips with their reasons. The common one is `type-check` and
`linter` skipping because `checks` is not configured in `pi.config.json` — if
you have never set that, those two have never run.

## Everything is refused

```bash
pi doctor
```

```
ok    pi.config.json present
ok    wired into cursor
ok    8 persona(s) loaded
ok    4 workflow(s) loaded
ok    7 run(s) on disk
ok    active run 21a59ada-… is readable
ok    event log is intact
ok    checkpoints match their snapshots

All checks passed.
```

The run count and active-run id change with your project; the shape does not.
`pi doctor` checks the project setup and the integrity of the run, and reports
broken persona or workflow files rather than crashing on them.

If it says pi is not wired in, run `pi install` and restart your editor. If a
persona or workflow fails to load, the message names the file and the line.

## The state file looks wrong

pi refuses edits that would break the run's integrity — a step cannot vanish, a
review receipt cannot be dropped or its answer revised. If you have hand-edited
`state.json` into a shape pi rejects, the error names the invariant you broke.

`pi rewind` is the sanctioned way to move a run backwards. It is the only path
that may discard receipts.

## Starting over

```bash
pi start "a better description of the work"
```

An unfinished run is set aside, not deleted. `pi runs` still lists it and
`pi runs --use <id>` goes back. Nothing you have done is lost, including the
event log and the artifacts.

## Removing pi

```bash
pi uninstall           # unwire this project; keep config and history
pi uninstall --purge   # also delete pi.config.json and pi/
```

Uninstalling reverses the install and nothing more: hooks and permissions that
were not pi's are left where they were, and files left empty by the removal are
deleted rather than left as husks.

`--purge` is separate because it destroys the one thing nothing can recreate. A
run's audit trail cannot be written again by anything; hooks and skills can be
rewritten by `pi install`. It tells you how many runs it is discarding first.

Removing the `pi` command from your machine is a different operation
(`npm unlink -g pi-harness`). Unwire your projects first, or you leave hooks
pointing at a command that is no longer there.

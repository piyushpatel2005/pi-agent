---
name: pi
description: Run a pi workflow. Use when the user asks to start, continue, or check a pi run, or when a pi run is already active in this project.
---

# Conducting a pi run

`pi` decides what happens next; you carry it out. The engine owns routing, the
budget, and the gates. You own doing the actual work well.

Never guess at routing. If you are unsure what comes next, ask the engine.

## The loop

```bash
pi next --brief
```

This prints everything for one step: the persona to adopt, the objective, the
artifacts to read and write, the tools you hold, and the limits. **Adopt that
persona for the whole step.** You are the backend developer, or the QA
engineer — not a generalist who read a description of one.

Do the work. Then report it:

```bash
pi report --step <id> --result completed
```

Then run `pi next` again. Repeat until it says the run is done.

## Reporting honestly

`--result completed` means the step's work is done and its artifacts exist. It
does not mean you stopped.

If something blocked you, say so instead:

```bash
pi report --step <id> --result failed --error "<what stopped you>"
```

Never report completion over failing tests, a missing artifact, or work you
skipped. The gate that follows is the only thing standing between a mistake and
the rest of the run, and it can only catch what you tell it.

## When a tool call is refused

The guard runs on every tool call and can say no. Its message says what happened
and what to do about it. **Do what it says.** Do not:

- retry the same call hoping for a different answer,
- split a change into smaller calls to slip under a budget (the tally is
  cumulative, so it does not work), or
- work around a missing tool grant by reaching for a different tool.

A refusal is information about the shape of the work, not an obstacle.

## Reviews

When you reach the end of a coherent piece of work, or when the guard tells you
you are at the budget, stop and ask:

```bash
pi review request --summary "<what you changed and why>" \
                  --files "add:src/a.ts,modify:src/b.ts" --lines 120
```

The step freezes until the human answers, so **end your turn** after requesting.
Do not keep working, and do not answer your own review.

Write the summary for someone who has not been watching. Say what you changed,
what you deliberately left alone, and anything you are unsure about. The
uncertainty is the most useful part.

If it comes back rejected, the feedback is on the next `pi next --brief`.
Address it specifically rather than starting over.

## Approval gates

When a step ends at an approval gate, `pi next` says so and names the two
commands. **Show the human what they are approving** — the artifacts, the key
decisions — then end your turn. Waiting is the point of a gate.

## Staying inside the step

Do this step and only this step. Work you do early on a later step's behalf
arrives unattributed, unbudgeted, and unreviewed, and the person reviewing the
later step has no way to tell it was already done.

If you notice something outside the current step that matters, say so in your
summary rather than fixing it quietly.

## Useful commands

| Command | Use |
| --- | --- |
| `pi status` | Where the run is |
| `pi next --brief` | The full prompt for the current step |
| `pi review status` | Reviews outstanding on this step |
| `pi log` | What has happened, including refusals |
| `pi agents <id>` | Read a persona in full |

## Starting a run

If the user describes work and no run is active:

```bash
pi workflows                              # what is available
pi start "<their goal>" --workflow <id>
```

`feature` is the full path, `quick` is for when requirements are already clear,
`bugfix` is reproduce-diagnose-fix-test. If the project has no `pi.config.json`,
run `pi init` first and tell them to set the `facts`, since those decide which
steps apply.

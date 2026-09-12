# What pi is

**This page answers one question: what does a harness solve that a coding agent
alone does not?**

If you already know why you want pi, skip to [Getting started](../guides/04-getting-started.md).

## The problem

A coding agent is good at the next step and bad at the tenth. Ask one to build a
feature and it will start well: it reads the code, makes a plan, writes
something plausible. Then the context fills, the plan drifts, and forty minutes
later you have a large diff, no record of why any of it happened, and no place
where you could have said "stop, not like that."

The failure is not that the model is weak. It is that nothing outside the model
is keeping track. There is no notion of which step you are on, no limit on how
much arrives before you see it, no record of what was decided, and no point at
which the work pauses for a human on purpose rather than by accident.

Those are not modelling problems. They are workflow problems, and they are
solved the way workflow problems have always been solved: with something outside
the worker that owns sequencing, limits, and state.

## The split

pi is that something. It does not talk to a model and it does not write your
code. Your coding tool keeps doing both.

| Your coding tool owns | pi owns |
| --- | --- |
| The model, and the loop that calls it | Which step comes next, and who does it |
| Reading files, editing, running commands | Whether a given tool call is allowed right now |
| Deciding *how* to do the work | Deciding *what* the work is, and when it stops |
| The conversation | The record of what happened, and why |

The agent stays in charge of the part it is good at — judgment inside a single
step. pi takes the part it is bad at: knowing where it is, staying inside
agreed limits, and stopping.

A useful way to hold it: the engine decides, the agent executes. When the agent
is unsure what comes next, it does not guess. It asks pi.

## What that buys you

**Work arrives in pieces you can read.** Each step has a change budget. When a
step would exceed it, the tool call is refused and the agent is told to
summarize and ask for review. Approving starts a fresh allowance rather than
raising the ceiling, so the next chunk is the same size as the last.

**Stopping is designed, not hoped for.** Steps end at gates. A gate does not
advance until a human says so, and pi will not accept an approval unless a
human has actually acted since the last gate — an agent cannot approve its own
work.

**There is a record.** Every run keeps an append-only event log: steps started
and finished, gates opened and resolved, reviews requested and answered, tool
calls refused and why. You can read what happened after the fact without
reconstructing it from a chat transcript.

**Roles are real.** Each step names a persona — a business analyst, a backend
developer, a technical writer — and that persona has a ceiling on what tools it
may use. A role that does not write code cannot write code, whatever the step
asks for. The agent adopts one role per step instead of being a generalist who
read a description of eight.

## What pi is not

**It is not an agent.** pi has no model, no prompt loop, and no opinion about
which model you use. Point it at a different coding tool and the engine is
unchanged.

**It is not a sandbox.** pi refuses tool calls through your coding tool's hook
system. It is a workflow control, not a security boundary — an agent that
bypasses the hooks bypasses pi.

**It is not a project manager.** A run is one piece of work, days at most. There
is no backlog, no estimation, no cross-run reporting.

**It does not touch your git history.** pi records where a run is; you move your
code yourself. Even `pi rewind`, which moves a run back to an earlier step, only
moves pi's own state — your working tree is left exactly as it is.

## The pieces

Five things make up a pi installation. Each has its own page; this is the map.

**Workflows** name the steps and their order. Four ship with pi — `feature`,
`quick`, `bugfix`, and `docs` — and you can write your own or shadow a shipped
one. See [Workflows](../extending/11-workflows.md).

**Personas** are the roles steps are assigned to. Eight ship with pi. Each
declares what tools it may hold and carries the operating instructions handed to
the model when a step activates it. See [Personas](../extending/12-personas.md).

**The guard** is consulted before every tool call and can refuse it. This is the
part with teeth. See [Guards and advice](03-guards-and-advice.md).

**Sensors** check a step's output when it reports itself done and report what
they find at the gate. They never block. Also on the guards page.

**The harness** is the thin layer that wires pi into a specific coding tool:
hooks pointed at an adapter, a skill that teaches the loop, and permission to
run `pi` without prompting. Cursor and GitHub Copilot both have one today. See
[Harnesses](../extending/13-harnesses.md).

## Where to go next

If you want to see it work, [Getting started](../guides/04-getting-started.md) goes
from nothing to a finished first step in one transcript.

If you want the vocabulary first — run, step, gate, artifact, receipt —
[The run model](02-the-run-model.md) is the next page.

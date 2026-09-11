# Guards and advice

**This page answers one question: what can actually stop me, and what merely
tells me something?**

pi has two mechanisms that look similar and behave completely differently. The
guard refuses tool calls. Sensors report findings. Confusing them is the most
common way to misread what pi is doing.

| | The guard | Sensors |
| --- | --- | --- |
| Runs | Before every tool call | When a step reports itself done |
| Can it stop the work? | **Yes** — the call does not happen | **No**, ever |
| Who reads it | The agent, immediately | The human, at the gate |
| Consequence of failing | The tool call is refused | A line of output |

The asymmetry is deliberate. A guard that only advised would be ignored. A
sensor that blocked would turn a heuristic into a wall, and these heuristics are
not good enough to be walls.

## The guard

The guard is consulted before each tool call and answers allow or deny. Your
coding tool's hook system asks it; the agent never chooses whether to consult
it.

**Reading and searching are always allowed.** Whatever state the run is in,
`read` and `search` pass. Being unable to look at the code is never the correct
outcome, and every other check is skipped for them.

Everything else goes through eight checks, in order. The first one that objects
wins.

### 1. Is the run accepting changes?

A run that has failed is not. The refusal says so and points at `pi status`.

### 2. Is there an active step?

Changes belong to a step. If no step is active, there is nothing for the change
to be attributed to, and the refusal tells you to run `pi next`.

### 3. Is the step actually running?

A step that is `awaiting-approval` or `awaiting-review` is frozen. The most
important case is a pending review: until it is answered, nothing may change,
because otherwise the review would be of code that has already moved on.

### 4. Does the step grant this tool?

Steps declare their tools. A step that does not list `write-code` cannot write
code. The refusal names what the step does grant, and says plainly that needing
more is a workflow change rather than something to work around.

### 5. Does the persona allow this tool?

Every persona has a ceiling. A business analyst does not write code, whatever a
step asks for. The persona's limit wins over the step's grant, never the other
way round.

One tool is denied to every persona always: `delegate`, spawning a nested agent.
Only the conductor dispatches. A worker that could delegate could quietly become
an orchestrator and bury a decision one level deeper than the log can see.

### 6. Does this step require review first?

A step can list tools that need an approved review before their first use. Until
one exists, those tools are refused, and the refusal shows the exact
`pi review request` command to run.

### 7. Is this within the change budget?

The big one, below.

### 8. Recording

When the call is allowed and actually runs, the files and lines it touched are
added to the step's tally.

## The change budget

A budget is a ceiling on how much one step may change before a human looks:

```json
"changeBudget": { "maxFiles": 8, "maxLines": 300 }
```

A step's own budget wins over the project default when it is stricter. A step
with no budget is unlimited.

Four properties are worth knowing, because each has surprised someone:

**The tally is cumulative.** It accrues across every call in the step. Splitting
one change into five smaller calls does not get you under the limit — the
refusal says so explicitly, because it is the first thing an agent tries.

**Rewriting a file does not spend more file budget.** Files are counted as
distinct paths, so touching `src/a.ts` ten times is one file. Lines always
accumulate.

**The limit is exceeded, not reached.** A call that lands exactly on the ceiling
is allowed. The one after it is not.

**Approval starts a fresh allowance rather than raising the ceiling.** When a
review is approved, the budget is measured from that approval forward. The next
chunk gets the same size as the last one — the ceiling never creeps up.

When you hit the budget the refusal tells you to stop, summarize, and request
review. That is the intended path, not a failure. The better move is to ask
before being stopped, at a boundary you chose.

## Refusals are information

A refusal is a fact about the shape of the work, not an obstacle. It carries the
reason and the command that resolves it, and the correct response is to do what
it says.

Three things not to do, all of which the messages warn against: retrying the
same call, splitting a change to slip under a budget, and reaching for a
different tool because the granted one was refused. None of them work, and all
of them defeat the purpose of the limit.

Every refusal is written to the event log, so `pi log` shows what was blocked
and why.

## Sensors

Sensors run when a step reports `completed`. They read what the step produced
and report at the gate, where a human is about to decide.

Six ship with pi:

| Sensor | What it looks for |
| --- | --- |
| `required-sections` | Declared artifacts exist, have some substance, and are not full of placeholder text |
| `upstream-coverage` | The output refers to the inputs it was given |
| `traceability` | Every acceptance criterion is accounted for |
| `docs-coverage` | Code changes arrived with the documentation they imply |
| `type-check` | The project's type checker passes |
| `linter` | The project's linter passes |

A step declares which of them apply. `pi sensors` dry-runs the current step's
sensors without recording anything, which is worth doing before you report.

### Skipping is not passing

A sensor skips when it has nothing to check, and a skipped sensor prints nothing
at the gate. That silence looks identical to success.

The case that catches people: `type-check` and `linter` run whatever you put in
the `checks` block of `pi.config.json`, and skip entirely when it is missing. pi
does not guess at your build tooling, because a sensor that silently checked
nothing would report green for the wrong reason. If you have never configured
`checks`, those two have never run.

Use `pi sensors` to see skips explicitly; it prints them with their reasons.

### They are heuristics, and they read like it

`upstream-coverage` checks whether your output mentions the headings of your
inputs. `traceability` checks whether the significant words of each acceptance
criterion appear in the validation. These are text heuristics. They catch a step
that ignored its inputs; they cannot tell good work from bad.

That is exactly why they do not block. Treat a sensor warning as a question
worth answering, not a verdict.

## Which one stopped me?

If the work was refused before it happened, that is the guard, and the message
names the reason and the fix.

If you are reading a warning after a step reported itself done, that is a
sensor, and the run is already at the gate. Nothing is blocked. It is telling
you something to consider before you approve.

# The run loop

**This page answers one question: what do I do every day, and what does each
command do to the run?**

[Getting started](getting-started.md) walked one path end to end. This page is
the working reference for the loop itself.

## The three commands

```bash
pi next                                     # what should happen now
# ... the work ...
pi report --step <id> --result completed    # what happened
```

That is the whole cycle. Everything else is exception handling.

## `pi next`

Asks the engine what to do. The answer is deterministic — routing is the
engine's job, not the agent's — so the same state always produces the same
answer.

It returns one of five things:

| You see | It means |
| --- | --- |
| A step | Work to do now |
| Waiting on a review | A change is proposed and unanswered |
| Waiting on approval | A step is done and needs a human |
| Done | Every step is finished or skipped |
| An error | The run is failed or its state does not match the workflow |

**Side effect worth knowing:** asking for a pending step *starts* it. The step
moves from `pending` to `active`, and that is what makes its tools usable. A
step that has not been started grants nothing.

`pi next --brief` prints the full prompt — persona instructions, objective,
artifact paths, tools, limits, and the docs contract. That is what your agent
should read. The short form is for you.

## Doing the work

Two rules matter more than the rest.

**Adopt the persona for the whole step.** You are the backend developer, or the
QA engineer, not a generalist who read a description of one. The persona is not
decoration; its tool ceiling is enforced.

**Stay inside the current step.** Work done early on a later step's behalf
arrives unattributed, unbudgeted, and unreviewed, and whoever reviews that later
step has no way to tell it was already done. If you notice something out of
scope, say so in your summary rather than fixing it quietly.

## `pi report`

Records the outcome. Four results:

| Result | Use it when | What happens |
| --- | --- | --- |
| `completed` | The work is done and its artifacts exist | Step finishes, or waits at its gate |
| `approved` | You are the human clearing a gate | Step finishes, run advances |
| `rejected` | You are sending work back | Step returns to active with your feedback |
| `failed` | Something stopped you | The step and the run both fail |

`--artifacts a,b` records which artifacts the step produced. It records names;
it does not create files.

### Reporting honestly

`completed` means done, not stopped. Never report it over failing tests, a
missing artifact, or work you skipped:

```bash
pi report --step implementation --result failed \
  --error "The payments API has no cancellation endpoint"
```

The gate that follows is the only thing between a mistake and the rest of the
run, and it can only catch what you tell it.

### What happens when you report `completed`

```
Recorded: requirements → completed
  step.completed
  checkpoint.saved

warn  [required-sections] `requirements.md` was declared but never written.
```

Three things: the state change, the events written to the log, and any sensor
findings. Sensors run only on `completed`, which is the moment they are useful —
a human is about to decide.

Sensor output never changes the outcome. The step above completed with two
warnings.

## Gates

Most steps end at an approval gate. Reporting `completed` moves the step to
`awaiting-approval` and the run stops:

```
"Capture what this feature must do" is done and ready for your approval.

Approve: pi report --step requirements --result approved
Send back: pi report --step requirements --result rejected --feedback "..."
```

**If you are the agent: stop here.** Show the human what they are approving —
the artifacts, the decisions, anything you are unsure about — and end your turn.
Waiting is the point of a gate.

Rejecting is not a failure. The step returns to `active`, the feedback lands on
the next `pi next --brief`, and the attempt counter goes up. Address the
feedback specifically rather than starting over.

Some steps declare `gate: "none"` and finish immediately. The `requirements`
step of the `quick` workflow is one — it printed `step.completed` rather than
opening a gate.

### Why you cannot approve from the agent

pi refuses an approval unless a human has acted since the last gate resolved. In
a non-interactive session there is no such record, so the approval refuses. Run
the approving command yourself in a terminal, or type in your editor's chat,
which records a human turn.

## Seeing where you are

```bash
pi status
```

```
Quick change — Add order cancellation
active · 0/3 steps · run 78410dc7-e5fa-4952-a66a-7d920f9fecea

  [ ] requirements — business-analyst
  [ ] implementation — backend-developer
  [ ] tests — qa-engineer
```

`[x]` finished, `[-]` current, `[ ]` pending, and skipped steps say so.

```bash
pi log                  # everything that has happened
pi log --step tests     # one step
pi log --json           # for scripts
```

The log includes refusals, so it answers "why did that get blocked" after the
fact. Two gaps worth knowing: a run *completing* and a step being *skipped* are
recorded in the run's state but never written to the log.

## More than one run

```bash
pi runs                     # every run, newest first
pi runs --use 78410dc7      # switch; a unique prefix is enough
```

Starting a run while another is unfinished sets the old one aside rather than
discarding it, and tells you so. Nothing is lost.

## Checking your work before the gate

```bash
pi sensors
```

Dry-runs the current step's sensors without recording anything, and — unlike the
gate output — prints skips with their reasons. Worth doing before you report,
because a skipped sensor at the gate is silent and looks exactly like a clean
pass.

## Command reference

| Command | Use |
| --- | --- |
| `pi status` | Where the run is |
| `pi next --brief` | The full prompt for the current step |
| `pi report` | Record an outcome |
| `pi log` | What has happened, including refusals |
| `pi sensors` | Dry-run the current step's checks |
| `pi runs` | List or switch runs |
| `pi review status` | Reviews outstanding on this step |
| `pi agents <id>` | Read a persona in full |
| `pi workflows <id>` | Inspect a workflow |
| `pi doctor` | Check the project's setup |

Full flags: [Commands](../reference/commands.md).

## Next

[Reviews and budgets](reviews-and-budgets.md) — what happens when the work gets
bigger than the step allows.

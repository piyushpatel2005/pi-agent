# Reviews and budgets

**This page answers one question: why was I stopped, and what do I do about it?**

The guard refuses tool calls. The first time it happens it looks like a bug. It
is not — every refusal names a reason and the command that resolves it. This
page covers all of them, with the messages you will actually see.

For the difference between the guard and sensors, see
[Guards and advice](../concepts/guards-and-advice.md).

## Reading a refusal

Every refusal arrives as the same shape:

```json
{"permission":"deny","agent_message":"Step \"implementation\" does not grant `delegate`. ..."}
```

Two things that surprise people:

**A refusal exits 0.** Denial is communicated in the JSON, not the exit code. If
you are scripting against `pi guard`, read `permission`. Exit code 2 means you
got the command wrong; 0 covers both allow and deny.

**Reading and searching are never refused.** Whatever state the run is in,
`read` and `search` pass. Being unable to look at the code is never the right
answer.

## The refusals

### The step does not grant that tool

```
Step "implementation" does not grant `delegate`. It grants: read, search,
write-code, write-artifact, run-command, request-review. If this step genuinely
needs that tool, that is a workflow change, not something to work around.
```

The step's tool list is in the workflow. If the step really needs the tool, edit
the workflow — do not reach for a different tool to get the same effect.

### The persona does not use that tool

Distinct from the above. The step may grant a tool the *role* does not hold; the
persona's ceiling wins. A business analyst does not write code however the step
is written.

`delegate` is denied to every persona always. Only the conductor dispatches
work.

### Review required before this tool

```
Step "implementation" requires review before its first `write-code` call.
Describe what you are about to change and why, then wait for an answer:

  pi review request --summary "<what and why>" --files <paths> --lines <n>
```

Some steps require an approved review before they may write at all. This fires
*before* the budget check, so on such a step your very first write is refused no
matter how small it is. That is intended: it forces you to say what you are
about to do before you do it.

### A review is open

```
Step "implementation" is waiting on your review. Nothing more may be changed
until it is answered, otherwise the review would be of code that has already
moved on.
```

The step is frozen. Everything except reading and searching is refused until the
review is resolved. If you are the agent, this is your cue to end your turn.

### Over budget

```
This change would put step "implementation" at 260 lines against a limit of 200.

The limit exists so that changes arrive in pieces a person can actually read.
Stop here, summarize what you have done so far, and ask for review:

  pi review request --summary "<what you changed and why>" --files <paths> --lines <n>

Once it is approved the budget starts fresh and you can continue. Do not split
the same change across smaller calls to get under the limit — the tally is
cumulative, so that does not work and is not the point.
```

### The step is not running

A step that is `pending`, `awaiting-approval`, or finished cannot make changes.
Run `pi next` to start a pending step. If it is at a gate, the gate needs a
human.

### The run is not accepting changes

The run has failed. See [When things go wrong](when-things-go-wrong.md).

## How the budget actually works

A budget is declared on the step, or inherited from the project:

```json
"changeBudget": { "maxFiles": 6, "maxLines": 200 }
```

A step's own budget wins over the project default when it is stricter. A step
with no budget is unlimited.

Four properties, each of which has caught someone out:

**The tally is cumulative.** It accrues across every call in the step. Splitting
one change into five smaller writes does not get you under the limit. The
refusal says so because it is the first thing anyone tries.

**Files are distinct paths.** Editing `src/index.ts` ten times is one file
against the file budget. Lines always accumulate.

**The limit is exceeded, not reached.** A call landing exactly on 200 lines is
allowed. The next one is not.

**Approval starts a fresh allowance, it does not raise the ceiling.** After an
approved review the budget is measured from that approval forward. The next
chunk gets the same size as the last, so the ceiling never creeps.

Note that only source changes spend the budget. Writing a step's declared
artifacts does not.

## Requesting a review

Ask before you are stopped. The better moment is a boundary you chose, not the
one the budget picked for you.

```bash
pi review request --summary "Add cancel() to the order service" \
                  --files "modify:src/index.ts" --lines 40
```

```
Review requested for step "implementation".

Add cancel() to the order service
  modify src/index.ts

The step is frozen until this is answered:
  pi review resolve --approve
  pi review resolve --reject --feedback "..."
```

**Write the summary for someone who has not been watching.** Say what you
changed, what you deliberately left alone, and what you are unsure about. The
uncertainty is the most useful part — it is the thing a reviewer cannot get from
the diff.

**Then end your turn.** The step is frozen; there is nothing further to do, and
you may not answer your own review.

## Answering a review

```bash
pi review resolve --approve
pi review resolve --reject --feedback "cancel() should be idempotent"
```

```
Approved. The step continues with a fresh change budget.
```

Either answer returns the step to `active`. Rejection attaches the feedback,
which arrives on the next `pi next --brief`.

`pi review status` shows what is outstanding, marking a pending one
`WAITING ON YOU`.

### Reviews are permanent

A review is recorded as a receipt on the step. Receipts can be added and
answered exactly once — an answer cannot be revised or deleted. That constraint
is what makes the record worth keeping.

### Approving needs a human

```
$ pi review resolve --approve
A review cannot be resolved without a human: no human turn has been recorded
since the last gate. Review requires an interactive session.
```

Real output, from a non-interactive shell. The fix is to run it yourself in a
terminal, or record the turn explicitly:

```bash
pi human-turn
pi review resolve --approve
```

Each gate needs its own human turn; resolving one does not bank credit for the
next.

## Three things not to do

The refusal messages warn against all three because all three are what an agent
tries first.

**Do not retry the same call.** The state has not changed.

**Do not split a change to slip under a budget.** The tally is cumulative, so it
does not work.

**Do not substitute a different tool.** If the granted tool was refused, the
answer is not a different tool — it is the command the refusal named.

A refusal is a fact about the shape of the work, not an obstacle.

## Next

[When things go wrong](when-things-go-wrong.md) — failed runs, stuck gates, and
rewinding.

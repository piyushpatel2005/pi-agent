# Harnesses

**This page answers one question: how do I wire pi into a coding tool that
does not have a harness yet?**

**Cursor and GitHub Copilot have one today** (`harness/cursor/`,
`harness/copilot/`). This page describes the seam a third port would follow —
Copilot's is a worked example of it, not a hypothetical.

## What a harness is for

pi's engine is a CLI that reads and writes files. It has no opinion about
editors. A harness is the adapter that lets a specific coding tool consult it —
nothing more.

Everything the engine decides is reachable through commands you can run by hand.
A tool with no harness can still be driven by a person typing `pi next` and
`pi report`; what it loses is enforcement, because nothing is asking the guard
before a tool call happens.

That is the honest summary of what a harness buys: **without one, budgets and
tool grants are advice.**

## The three-part seam

`pi install` writes exactly three kinds of thing.

### 1. Hooks pointed at an adapter

The tool must call out before and after tool calls. For Cursor that is
`.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse":         [{ "command": "node \"/abs/path/adapter.ts\" guard" }],
    "postToolUse":        [{ "command": "node \"/abs/path/adapter.ts\" record" }],
    "beforeSubmitPrompt": [{ "command": "node \"/abs/path/adapter.ts\" human-turn" }],
    "sessionStart":       [{ "command": "node \"/abs/path/adapter.ts\" session-start" }]
  }
}
```

Four events, and their jobs:

| Event | Target | Why it matters |
| --- | --- | --- |
| before a tool call | `guard` | The only enforcing hook |
| after a tool call | `record` | Keeps the change tally honest |
| on a human prompt | `human-turn` | The evidence gates rest on |
| session start | `session-start` | Tells a new session where the run stands |

**Do not wire your harness's end-of-turn hook.** If it can only reply with a
message that gets submitted as the user's next turn — Cursor's `stop` hook and
its `followup_message` are the example — then nudging from it makes the harness
mint the human presence that gates depend on, and the payload on the receiving
side has no way to tell that message apart from something a person typed.

pi used to wire it, and every gate resolved from chat was cleared on presence pi
had generated for itself about ten seconds earlier. It is also the wrong moment
to speak: a gate exists to end the agent's turn, and a followup continues it.
A waiting gate should surface through the agent's own closing message and
`pi status`.

**`guard` and `human-turn` are the two that are load-bearing.** Without `guard`
nothing is enforced. Without `human-turn` no gate can ever be cleared, because
approval requires a recorded human turn — and that failure is silent, which
makes it the more dangerous of the two.

### 2. A skill that teaches the loop

`.cursor/skills/pi/SKILL.md`, which tells the agent to ask `pi next`, adopt the
persona, report with `pi report`, and treat a refusal as instruction rather than
an obstacle.

Without this the harness still enforces, but the agent has to be told the loop
in every conversation.

### 3. Permission to run `pi` unprompted

`.cursor/cli.json`. If every `pi next` needs a click, nobody uses it.

pi also installs a rule (`.cursor/rules/pi.mdc`) so the loop is in context
without the skill being invoked explicitly.

**All of this is merged, not overwritten.** Hooks the project already had
survive, and `pi uninstall` unpicks only what pi added. A port should hold the
same line: you are a guest in someone's repository.

## What the adapter does

One executable, dispatching on its first argument. Its whole job is
translation.

**Map the tool's names to pi's.** pi knows eight tools: `read`, `search`,
`ask-user`, `write-artifact`, `write-code`, `run-command`, `request-review`,
`delegate`.

This mapping is where the bugs live. Two lessons from the Cursor adapter, both
of which shipped broken:

**An unmapped tool is allowed silently.** Cursor sends `StrReplace` for nearly
every edit. While that was missing from the adapter's write set, the guard never
saw an edit at all — budgets and review requirements were inert and nothing said
so. Get the tool names from the tool's own documentation, not from what seems
reasonable.

**Writing an artifact is not changing the repository.** A write whose paths are
all inside the run's artifact directory maps to `write-artifact`, not
`write-code`. Conflate them and producing the summary a reviewer asked for is
itself over budget.

**Work out what the call would touch.** Which files, and how many lines. For an
edit, count the larger of the old and new text rather than their sum: rewriting
twenty lines as twenty-two is a twenty-two line change, not forty-two.

**Identify the project.** A multi-root workspace sends every root, in no
particular order, and some events carry no working directory at all. Taking the
first root is wrong whenever the run lives in another one — and it fails silently
in both directions, waving every call through *and* recording human turns
against a project with no run. Prefer whichever candidate actually has an active
run.

**Answer in the shape the tool expects.** For Cursor, `preToolUse` must print
`{"permission":"allow"}` or `{"permission":"deny","agent_message":"..."}` on
stdout, and empty or malformed output is a failure — so every path must print
valid JSON.

## Two rules a port should keep

### Fail open

Any internal error allows the call. A guard that bricks someone's editor when pi
has a bug is worse than one that occasionally misses a write, and the run's own
gates still catch the work at review time.

The Cursor adapter prints `allow` on an unreadable payload, an unknown target,
and an unhandled exception.

### Keep pi's own commands reachable

Every refusal names a `pi` command that puts things right. If that command is
itself governed, the refusal is unactionable — and the deadlock is total,
because the verbs that move a run all have to run while no step is active or
while one is frozen at a gate, which is exactly when nothing is granted.

So the adapter answers pi's own read-and-advance verbs before consulting the
guard. Three details matter:

**It is an allowlist.** `install`, `uninstall`, `start`, `rewind`, and `abandon`
are deliberately absent, because each either removes the guard or discards the
run, which would make a refusal an inconvenience rather than a decision.

**`pi human-turn` is refused in every state.** Human presence is what makes a
gate mean something; a model that could mint its own could approve its own work.

**A command with anything chained onto it is not a pi command.** Rather than
parse a shell, any metacharacter disqualifies — so `pi status && rm -rf build`
and `pi status > overwrite.ts` are governed normally.

Note what this does *not* open up: `pi report --result approved` is allowed, and
is still refused by the engine unless a human turn was recorded. The control
plane is reachable; the human requirement is not bypassed.

## Porting checklist

1. Does the tool have a **pre-tool-use hook that can refuse a call?** If not,
   you can record and advise but not enforce, and you should say so plainly.
2. Can you tell **which human prompts are real**? That is the gate evidence. A
   hook that also fires for synthetic turns is worse than none.
3. Map every tool the model can use to write, and **verify against the tool's
   documentation**.
4. Identify the project correctly, including multi-root.
5. Fail open everywhere.
6. Exempt pi's control plane, minus the verbs above.
7. Merge into existing config rather than overwriting.

## Testing a port

Write the tests from the tool's published contract, not from what your adapter
assumes.

The Cursor adapter had a suite that drove it as a subprocess against a live run,
and three defects still reached a user — because the tests fed payloads pi had
invented. The tests and the code held the same wrong belief about the editor, so
they agreed with each other and both were wrong. A test that asserts your own
assumption back to you is worse than no test, because it buys confidence.

The properties worth pinning:

- Every tool the editor really sends is governed, not waved through
- An edit spends the change budget
- A human turn reaches the run, from the real event payload
- **An approval gate can actually be cleared** — the end-to-end one
- Every command a refusal names is itself allowed
- `pi human-turn` is not
- Chained commands are not treated as pi commands
- The right project is found when only roots are given

## See also

- [Guards and advice](../concepts/03-guards-and-advice.md) — what the guard decides
- [Commands](../reference/08-commands.md) — the CLI an adapter calls

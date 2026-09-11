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

There are two separate things you can uninstall, and they are worth keeping
apart. `pi uninstall` unwires pi from *one project*; `npm unlink -g pi-harness`
removes the `pi` command from your machine. Doing the second without the first
leaves hooks in your projects pointing at a command that is no longer there, so
unwire the projects first.

### A specific version

Releases are git tags, so checking one out is how you pin:

```bash
git checkout v0.1.0
npm install && npm link
```

To keep two versions side by side, clone twice and link only one of them; run
the other by path (`node ~/pi-0.1.0/cli/pi.ts`). `pi version` tells you which
one you are talking to.

## Quickstart

In the project you want to work on:

```bash
cd ~/code/my-project
pi init
pi install     # wire pi into Cursor's hooks, then restart Cursor
```

`pi init` writes `pi.config.json` and a `pi/workflows/` directory. `pi install`
wires the guard into your coding tool — without it, `pi` still routes and
records, but nothing consults the guard, so budgets are advice again.

Open the config and set the **facts** — they decide which steps apply to your
project:

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

### Driving it from Cursor

`pi install` puts a skill at `.cursor/skills/pi/SKILL.md`, which Cursor picks up
two ways:

- **Type `/pi` in the chat**, and the skill attaches to that message.
- **Say what you want in plain language** — "start a pi run for the orders
  service", or anything at all once a run is active. The skill's description
  tells the agent when it is relevant, and the agent reaches for it on its own.

Either way the agent then drives the same loop you would by hand: `pi next
--brief` for the step, do the work, `pi report`. You stay in the chat; the
engine decides the routing.

The `.cursor/rules/pi.mdc` rule is `alwaysApply: true`, so the ground rules —
never report completion over failing tests, follow a guard refusal rather than
working around it — are in context whether or not the skill was invoked.

Restart Cursor after `pi install` so it discovers both.

### Or by hand

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

The loop is three commands:

```bash
pi next                                     # what to do now
# ... the work ...
pi report --step <id> --result completed    # what happened
```

`pi --help` lists every command and flag.
**[Commands](docs/reference/commands.md)** documents what each one requires of
the run, what it produces, and what it refuses — including the step state
machine.

## Small, reviewed changes

This is the part that makes `pi` more than a prompt. A step declares how much it
may change:

```json
"changeBudget": { "maxFiles": 8, "maxLines": 300 }
```

The guard is consulted before every tool call and refuses the one that would
cross the limit, naming the way forward. When review is requested **the step
freezes**, so the diff can't move underneath you:

```bash
pi review status              # what you owe an answer on
pi review resolve --approve
pi review resolve --reject --feedback "Split the write path"
```

**Approval starts the budget fresh; it does not raise the ceiling.** So the
budget means "review every N files", not "N files per step, ever".

Three things keep a receipt from being theatre: it fingerprints what you read
(so an approval can't be retargeted at different work), the state store refuses
any edit to it after the fact, and resolving requires a recorded human turn, so
an unattended run can't approve its own work.

**[Reviews and budgets](docs/guides/reviews-and-budgets.md)** has every refusal
message, the exact budget mechanics, and what to do about each.

## Sensors

Sensors are deterministic checks that run when a step reports complete, so their
findings reach you at the gate — the moment you're deciding. A step declares
which ones it wants:

```json
"sensors": ["required-sections", "docs-coverage", "type-check", "linter"]
```

There are six, covering artifact quality, whether a step engaged with its
inputs, acceptance-criteria traceability, documentation coverage, and your
project's own type checker and linter.

Preview them before you reach the gate:

```bash
pi sensors              # dry-run the current step, with skip reasons
pi sensors --list       # the catalogue
```

**Sensors are advisory. They never block a write.** That's a deliberate
asymmetry with the change budget, and the reason is false positives: "you are
over 300 lines" is a count and is always right, while "this change needed
documentation" is a judgement that will sometimes be wrong. A guard that's
sometimes wrong trains people to route around guards; a report that's sometimes
wrong costs a glance.

One consequence to know: a sensor that **can't** check something skips, and at a
gate a skip prints nothing at all — indistinguishable from a clean pass. `pi
sensors` is what shows you the difference.

**[Sensors](docs/reference/sensors.md)** covers what each one checks and exactly
when it skips.

## Personas

Eight roles, each a Markdown file in `core/agents/`. See them with `pi agents`,
or read one in full with `pi agents backend-developer`.

The roster is small on purpose. Every handoff between roles loses context, so
eight broad personas beat twenty narrow ones.

Each file's frontmatter declares what the role may touch, and `tools` is a
**ceiling, not a default**. A workflow step grants a subset of it; a step asking
for more fails to compile, so a workflow cannot hand the business analyst a code
editor by asking nicely. `delegate` is denied to every persona — only the
conductor dispatches, so a worker can't quietly become an orchestrator and bury
a decision one level below what the log can see.

To change how a role works, drop a file with the same `id` in `pi/agents/`. It
replaces the shipped one.

**[Personas](docs/extending/personas.md)** covers every frontmatter field, how
tool grants resolve, and what belongs in the body.

### The brief

`pi next --brief` renders what a coding agent should actually be given: the
persona, the step's objective, the artifacts to read and write, the tools it
holds, the documentation contract, and the budget — assembled as one prompt.
The short `pi next` is for humans.

The parts that vary per project (where docs live, what this step may touch, how
much it may change) come from configuration rather than from the persona file,
so persona files stay about the role.

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
  },
  "checks": {
    "typeCheck": "npm run typecheck",
    "lint": "npm run lint"
  }
}
```

Every key has a working default, so a repo with no `pi.config.json` at all
still runs. The file exists to say the things only your repo knows.

**`facts`** is a closed set of booleans, not free-form. A workflow author can
say "only when there is a frontend" but cannot embed logic the engine is unable
to explain back to you. A step whose condition is false is marked skipped at the
start of the run, so you see up front what won't happen. **A fact you leave out
counts as false**, so an empty `facts` block silently skips every conditional
step — `pi status` after `pi start` is worth a look.

**[Configuration](docs/reference/configuration.md)** documents every key, its
default, the canonical fact names, and how the `docs` policy is applied.

### Keeping pi out of your commits

`pi init` and `pi install` add a marked block to your `.gitignore`:

```
# >>> pi >>>
# Written by `pi install`, removed by `pi uninstall`.
# Delete this block by hand once the team decides to commit pi's config.
/pi/runs/
/pi.config.json
/.cursor/skills/pi/
/.cursor/rules/pi.mdc
/.cursor/hooks.json
/.cursor/cli.json
# <<< pi <<<
```

The point is that nobody reviewing your pull request asked to also review your
run history. After installing pi and running work through it, `git status`
should show nothing but `.gitignore` itself.

Two details worth knowing:

`.cursor/hooks.json` and `.cursor/cli.json` are only listed when **pi created
them**. If your project already had either, the file is yours and pi will not
hide it — pi merged into it and says so instead. `.gitignore` has no effect on
a file git already tracks, so an entry there would be a rule that silently does
nothing.

`pi uninstall` removes the block, but only once there is nothing left to ignore.
While `pi.config.json` and `pi/` are still on disk the block stays, because
un-ignoring them is exactly how they end up in someone's commit. `pi uninstall
--purge` removes the files and the block together, and deletes `.gitignore` if
pi's block was all it held.

Pass `--no-gitignore` to either command to skip all of this — for when the team
has decided to commit `pi.config.json`, which is the eventual intent: it is a
description of your repo, and it is more useful shared than local.

## Workflows

Four ship with `pi`:

- **`feature`** — requirements, architecture, UX design, backend, frontend,
  tests, infrastructure, validation. Eight steps, most of them conditional.
- **`quick`** — requirements, implementation, tests. For when you already know
  what you're building.
- **`bugfix`** — reproduce, diagnose, fix, regression test.
- **`docs`** — survey, then concepts, guides, reference, and extension pages,
  then an accuracy pass that checks every claim against the code.

Inspect one with `pi workflows feature`.

### Workflows of your own

Shipped workflows live inside the `pi` installation. Your own go in
`pi/workflows/` **in your project**, and load second, so a file whose `id`
matches a shipped workflow shadows it — that is how you retune `feature`
without forking `pi`. `pi workflows` marks the project ones `(project)`.

Workflows are compiled, not just parsed. `pi` rejects a workflow that consumes
an artifact nobody produces, consumes one produced later, declares two producers
for the same artifact, requires review before a tool the step was never granted,
names a persona that does not exist, grants a persona a tool it does not hold,
names an unknown sensor, or wires a conditional producer into an unconditional
consumer. Run `pi doctor` to see what failed and why.

**[Workflows](docs/extending/workflows.md)** documents every field a step may
declare, with a worked example.

## The harness layer

`pi` is not the agent. Your coding tool owns the model and the tool loop; `pi`
supplies routing, guards, state, and the audit trail around it. The harness
layer is the seam between them, and it is deliberately thin — three things:

1. **Hooks** pointed at `harness/cursor/adapter.ts`, which translates the host's
   tool calls into pi's vocabulary and answers allow or deny.
2. **A skill** (`.cursor/skills/pi/SKILL.md`) telling the agent how to drive the
   `next` / work / `report` loop.
3. **A permission** so running `pi` doesn't prompt on every call.

**[Harnesses](docs/extending/harnesses.md)** documents the seam in full, for
porting pi to a tool that is not Cursor.

`pi uninstall` reverses it: pi's hooks come out, `Shell(pi)` is revoked, and the
skill and rule are deleted, while every hook and permission that was not pi's is
left exactly where it was.

It takes its empty husks with it. An event whose only hook was pi's loses the
key rather than keeping an empty array; a `hooks.json` or `cli.json` with
nothing but pi's entries in it is deleted; and `.cursor/skills/`,
`.cursor/rules/`, and `.cursor/` itself go when they end up empty. If the
project had anything else in any of them, all of it stays.

By default it leaves `pi.config.json` and `pi/` — your config, workflow
overrides, and run history:

```bash
pi uninstall            # unwire pi; keep the config and the history
pi uninstall --purge    # also delete pi.config.json and pi/
```

`--purge` is a separate flag because it is the only part of an uninstall that
destroys something nothing can recreate. Hooks and skills can be written again
by `pi install`; a run's audit trail cannot be written again by anything. It
tells you how many runs it is discarding before it does.

`--purge` also works on a project that has already been unwired, which is the
order most people actually follow.

`pi install` writes all three, merging into your existing `.cursor/` config
rather than replacing it. Reinstalling is safe and idempotent; it also cleans up
hooks left pointing at a previous pi location.

What gets wired, by Cursor event:

| Event | What pi does |
| --- | --- |
| `sessionStart` | Tells a fresh session which run is active and where it stands |
| `beforeSubmitPrompt` | Records the human turn that gates depend on |
| `preToolUse` | The guard: allow or deny, with a reason |
| `postToolUse` | Records what was actually changed, for the tally |

Two honest caveats:

- **The guard fails open.** Any internal error allows the call. A guard that
  bricks your editor when pi has a bug is worse than one that occasionally
  misses a write, and the review gates still catch the work before it lands.
- **Nothing runs at the end of a turn.** Cursor's `stop` hook can only answer
  with a message that Cursor then submits as the next user prompt, which would
  make pi the author of the human turn its own gates check. An outstanding
  review surfaces in the agent's closing message and in `pi status` instead.

Porting to another tool means writing those three things for it and nothing
else — the engine, personas, and workflows are host-neutral.

## Where a run lives

```
<project>/pi/runs/<runId>/
  state.json        truth-of-now: step statuses, receipts, checkpoint index
  events.ndjson     append-only audit log
  artifacts/        what each step produced
  checkpoints/      one full state snapshot per boundary
```

`state.json` is a cache the engine can answer guard questions from quickly;
`events.ndjson` is the record of what actually happened. `pi/runs/` should be
gitignored.

## More than one run

Every `pi start` creates a run of its own, with its own state, log, artifacts,
and checkpoints. Starting the next feature is just `pi start` again — there is
nothing to finish or clean up first.

```bash
pi runs                    # every run, newest first, * marks the active one
pi runs --use 80ee903f     # switch to one; a short prefix is enough
```

Starting a run while another is unfinished sets the old one aside rather than
refusing, because that is usually what you meant. It says so, and tells you how
to get back:

```
Started Quick change — Feature B
Run 52a5831b-01ae-4012-84bb-233060869613

Set aside: Feature A (1/3 steps)
  Nothing was lost. Go back with: pi runs --use 80ee903f
```

Nothing is ever deleted by starting or switching. `pi/runs/active` is a single
pointer, and moving it is all a switch does; the run you left picks up at the
step it had reached.

## Checkpoints and rewinding

A step marked `checkpoint` writes a snapshot of the whole run state when it
completes, along with the commit your working tree was on at the time.

```bash
pi checkpoints                 # where you can rewind to
pi rewind --to design          # show what it would undo; change nothing
pi rewind --to design --yes    # do it
```

`pi rewind --to <step>` makes that step the next one to run, which means undoing
it and everything after. Without `--yes` it is a dry run: it prints the steps it
would undo and the review receipts it would discard, and exits.

Three things are worth knowing:

**It does not touch your files.** pi moves its own state, not your working tree.
Checkpoints record the commit they were taken at so you can move the code
yourself with git; a tool that silently reverted your files would be one you
could not afford to be wrong. `pi rewind` prints that commit for you.

**It does not erase history.** The event log is append-only, and a rewind is
appended to it like anything else. `pi log` still shows the work you undid.

**It refuses an edited snapshot.** Each snapshot is fingerprinted against the
boundary it was taken at. If the file no longer matches, the rewind stops rather
than restoring a state the run was never in. `pi doctor` checks the same thing.

Rewinding to the first step resets the run to its original plan and needs no
checkpoint at all. Steps that a `when` condition skipped stay skipped — that was
a decision about the project, not work that was done.

## Versioning

Four things in pi carry a version, and they are not the same thing:

| | What it versions | Who bumps it |
|---|---|---|
| `pi version` | the release of the tool | a release |
| `state.json` `version` | the shape of run state | a migration |
| `pi.config.json` `version` | the shape of project config | a migration |
| a workflow's `version` | that workflow file | you |

Most releases touch none of the schema versions. They exist so an old file meets
a clear error rather than a confusing one — they are not a changelog.

```bash
pi version          # 0.1.0
pi version --json   # pi, state, config, and Node versions
```

The release number lives in `package.json` and nowhere else; `core/version.ts`
reads it from there. Two copies of a version number stay in agreement right up
until the day they do not, and that is the day someone reports a bug against the
wrong release.

Every run records the version of pi that created it, so a run that looks wrong
six months later can say which tool to blame. `pi doctor` points out when the
active run was started by a different version than the one you are running.

pi follows SemVer, and while it is below 1.0 a minor bump may break things. The
release notes say so when it does.

### Cutting a release

Releases are annotated git tags named `v<version>`, with notes in
[CHANGELOG.md](CHANGELOG.md). Write what you changed under `## [Unreleased]` as
you go, then:

```bash
node scripts/release.ts 0.2.0         # show what would happen; change nothing
node scripts/release.ts 0.2.0 --yes   # bump, close the changelog, commit, tag
```

Through npm, flags need a bare `--` in front of them or npm keeps them for
itself — `npm run release 0.2.0 --yes` silently does a dry run:

```bash
npm run release 0.2.0 -- --yes
```

The script notices that case and tells you, rather than leaving you to wonder
why nothing happened.

The dry run prints the exact release notes so you read them before they are
permanent. Applying it refuses to continue unless the working tree is clean, the
tag is new, the `Unreleased` section has something in it, and the tests and
typecheck both pass — a tag points at a commit, so it should point at one that
works.

It stops short of pushing and prints the command instead:

```bash
git push origin main v0.2.0
```

Pushing a tag is the irreversible part, because other people may fetch it. That
one stays yours to say.

A test keeps `package.json`, `CHANGELOG.md`, and `pi version` from drifting
apart, so a release that forgot its notes fails before it ships rather than
after.

### Release candidates

A version with a prerelease tag is treated as a candidate:

```bash
node scripts/release.ts 1.0.0-rc.1 --yes
node scripts/release.ts 1.0.0-rc.2 --yes    # as many as you need
node scripts/release.ts 1.0.0 --yes         # the real thing
```

The one thing that differs: **a candidate does not consume the `Unreleased`
section.** It bumps the version and cuts the tag, but the notes stay where they
are, because they are describing work that is not finished shipping. If an RC
closed the section, the real release would arrive with nothing to say — the
opposite of the point.

So `pi version` reports `1.0.0-rc.2` while `CHANGELOG.md` still has everything
waiting under `Unreleased`, and the final `1.0.0` release collects it all.

Candidates order the way SemVer says: `rc.2` follows `rc.1`, `rc.10` follows
`rc.9`, `beta` follows `alpha`, and `1.0.0` follows all of its candidates but
never the reverse.

To share one, push the tag and have people check it out:

```bash
git push origin main v1.0.0-rc.1
```

If you ever publish to npm, an RC should go out under a dist-tag
(`npm publish --tag next`) so that a plain `npm install` does not pick it up.
The package is currently `private`, so this does not apply yet.

### Writing the notes

Write entries under `## [Unreleased]` as you go. To check you have not forgotten
anything:

```bash
npm run changes        # commits since the last tag with no matching note
npm run changes --all  # every commit, grouped into changelog headings
```

This drafts; it does not write the file. Commits and changelogs answer different
questions — a commit explains a change to someone reading the code, a changelog
tells a user what they can now do — so a changelog generated from commit
messages reads like one. "Refactor the state store" is a true commit message and
a useless release note.

What it does instead is catch omissions. It lists commits whose wording does not
appear in your notes, skipping the types that never earn an entry (`chore`,
`test`, `ci`, `build`, `style`). The matching is deliberately crude and will
raise some false alarms, which is why it only ever prints a list. The release
dry run shows the same list, as a note rather than a blocker.

If you write [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`), the draft is grouped under the right headings
already. If you do not, everything lands under `Uncategorised` and you sort it
yourself — the tool works either way.

## Development

```bash
npm test          # node --test
npm run typecheck # tsc --noEmit
```

There is no build step and no runtime dependency beyond `zod`. The code avoids
TypeScript-only runtime syntax (enforced by `erasableSyntaxOnly`) so Node can
strip types and run the source directly.

## Status

Early, but usable end to end on Cursor: the engine, workflows, personas, the
guard, review receipts, sensors, checkpoints, the CLI, and the Cursor harness.

Still to come: harnesses for Claude Code and Copilot.

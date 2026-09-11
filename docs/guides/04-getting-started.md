# Getting started

**This page answers one question: how do I get from nothing to a finished first
step?**

One unbroken transcript. Every command and every piece of output below is real —
run against a small project called `orders`. Compare it against your terminal as
you go.

If you want to know what pi *is* before installing it, read
[What pi is](../concepts/01-what-pi-is.md) first.

## Before you start

Node 22.18 or newer. pi is TypeScript that Node runs directly through native
type stripping, so there is no build step and nothing to compile.

```bash
node --version
```

## Install pi on your machine

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
```

If you would rather not link anything, `node /path/to/pi/cli/pi.ts` works
identically everywhere `pi` appears below.

## Set up your project

Move to the project you actually want to work on. pi is per-project: installing
it on your machine does not wire it into anything.

```bash
cd ~/code/orders
pi init
```

```
Wrote pi.config.json and pi/workflows/.
Wrote .gitignore (4 path(s) ignored).

Next:
  1. Edit pi.config.json — the "facts" decide which steps apply to this project.
  2. Run `pi start "what you want to build"`.
```

Two things happened. `pi.config.json` describes your project to pi, and a
`.gitignore` block keeps pi's config and run history out of your commits — pi
writes into a repository it does not own, and until your team decides to adopt
it none of that belongs in a pull request.

### Set the facts

Open `pi.config.json` and set the `facts`. They decide which steps apply:

```json
{
  "facts": {
    "hasFrontend": false,
    "hasBackend": true,
    "needsInfra": false,
    "isBrownfield": true
  }
}
```

**A fact you leave out counts as false.** An empty `facts` block skips every
conditional step, silently. This is the single most common way a first run comes
out shorter than expected.

While you are in there, `checks` is worth filling in:

```json
{
  "checks": { "typeCheck": "npm run typecheck", "lint": "npm run lint" }
}
```

Leave it empty and the `type-check` and `linter` sensors skip rather than guess
at your build tooling — which means they never run and never tell you anything.

Full key list: [Configuration](../reference/09-configuration.md).

## Wire it into your editor

```bash
pi install
```

This merges pi's hooks into `.cursor/hooks.json`, grants permission to run `pi`
without prompting, and installs a skill and a rule that teach the agent the
loop. Hooks you already had are kept, not overwritten.

**Restart Cursor** so it picks up the hooks.

Without this step pi still routes and records, but nothing consults the guard —
so budgets become advice rather than limits. Cursor is the only editor with a
harness today.

## Start a run

```bash
pi start "Add order cancellation" --workflow quick
```

```
Started Quick change — Add order cancellation
Run 78410dc7-e5fa-4952-a66a-7d920f9fecea

Run `pi next` to get the first step.
```

`quick` is the three-step workflow, right for a first run. `pi workflows` lists
the others.

Look at the shape before you begin:

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

This is the moment to check that nothing you expected is missing. Steps skipped
by your facts are decided now, at the start, not as the run reaches them.

## Do the first step

```bash
pi next
```

```
Step 1/3: requirements — business-analyst
Write down what to build and how we will know it works.

Writes:
    requirements.md  /tmp/orders/pi/runs/78410dc7.../artifacts/requirements/requirements.md
    acceptance-criteria.md  /tmp/orders/pi/runs/78410dc7.../artifacts/acceptance-criteria.md
Tools: read, search, ask-user, write-artifact

When finished: pi report --step requirements --result completed
```

That is the whole instruction: who you are for this step, what you are doing,
where the output goes, and what you may touch. `pi next --brief` prints the full
version, including the persona's operating instructions — that is what your
coding agent reads.

Notice this step grants no `write-code`. A business analyst does not write
code, and the guard will refuse it if the agent tries.

Now write the two files. Then say so:

```bash
pi report --step requirements --result completed
```

```
Recorded: requirements → completed
  step.completed
  checkpoint.saved

warn  [required-sections] `requirements.md` was declared but never written.
warn  [required-sections] `acceptance-criteria.md` was declared but never written.
```

Those warnings are from a **sensor**, and they did not stop anything — the step
completed. Sensors report; they never block. Here they are telling the truth: in
this transcript the artifacts genuinely were not written.

The `checkpoint.saved` line means you can come back to this boundary later with
`pi rewind`.

## The next step

```bash
pi next
```

```
Step 2/3: implementation — backend-developer
Make the change.

Reads:
  ! requirements.md  /tmp/orders/pi/runs/78410dc7.../artifacts/requirements/requirements.md
Writes:
    implementation-summary.md  ...
Tools: read, search, write-code, write-artifact, run-command, request-review
Budget: 6 files / 200 lines before review

When finished: pi report --step implementation --result completed
```

Three differences from the first step. The role changed. There is now a
**budget** — 200 lines before someone has to look. And the `!` marks an input
that does not exist, because the previous step never wrote it.

## What you just learned

The loop is three commands, forever: `pi next`, do the work, `pi report`.

Everything else — gates, reviews, budgets, refusals — is what happens around
that loop when the work gets large or needs a decision.

## Where to go next

[The run loop](05-the-run-loop.md) covers what each command does to the run, and
what to do at an approval gate.

[Reviews and budgets](06-reviews-and-budgets.md) is the one to read when you first
get refused, which will happen on your first real implementation step.

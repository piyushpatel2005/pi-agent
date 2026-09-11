# Configuration

**This page answers one question: what can I put in `pi.config.json`, and what
is the default?**

The file lives at your project root and `pi init` scaffolds it. **Every key has
a working default**, so a project with no config file still runs. The file
exists to describe the things only your project knows.

## A complete file

Every key, with its default:

```json
{
  "version": 1,
  "harness": "cursor",
  "defaultWorkflow": "feature",
  "facts": {},
  "docs": {
    "dir": "docs",
    "files": ["README.md"],
    "required": true,
    "exempt": ["tests/", "test/", "**/*.test.*", "dist/"]
  }
}
```

`changeBudget` and `checks` have no defaults and are absent unless you set them.

## Top level

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `version` | `1` | `1` | Config schema version. |
| `harness` | string | `"cursor"` | Which coding tool this project is wired for. |
| `defaultWorkflow` | string | `"feature"` | Used when `pi start` gets no `--workflow`. |
| `facts` | object of booleans | `{}` | Project truths that decide which steps apply. |
| `changeBudget` | object | — | Project-wide ceiling on one step's changes. |
| `checks` | object | — | Commands the `type-check` and `linter` sensors run. |
| `docs` | object | see below | Where documentation lives. |

## `facts`

The closed set of booleans that a workflow's `when` conditions resolve against.

```json
{ "facts": { "hasFrontend": false, "hasBackend": true, "needsInfra": false, "isBrownfield": true } }
```

Deliberately booleans and not expressions, so routing stays predictable and
explainable.

**A fact you leave out counts as false.** The default is `{}`, which means an
untouched config skips every conditional step, silently. This is the most common
reason a first run comes out shorter than expected.

**Facts are frozen into the run at `pi start`.** Editing them afterwards does not
change a run already underway; start a new run.

### The canonical facts

| Fact | Meaning |
| --- | --- |
| `hasFrontend` | The change has a user interface |
| `hasBackend` | The change has server-side work |
| `needsInfra` | Deployment or infrastructure work is in scope |
| `isBrownfield` | Existing code, not a greenfield start |

Of these, only `hasFrontend`, `hasBackend`, and `needsInfra` are tested by any
shipped workflow — all three by `feature`. `isBrownfield` is a conventional name
that no shipped workflow currently branches on, so setting it changes nothing
unless one of your own workflows tests it.

**The four names above are a closed set.** A workflow whose `when` condition
names anything else fails to compile, with an error listing the known facts — so
a typo in a workflow is caught at compile time rather than silently skipping a
step. Adding a fact is a deliberate code change.

This file is the looser of the two: `facts` accepts any key, so a misspelled
fact here is not an error and simply counts as false. `pi workflows <id>` shows
which conditions a workflow tests.

## `changeBudget`

```json
{ "changeBudget": { "maxFiles": 6, "maxLines": 200 } }
```

How much one step may change before a human has to look. Set here it applies
project-wide; **a step's own budget still wins when it is stricter.** A step with
no budget from either source is unlimited.

Mechanics — cumulative tallies, distinct-file counting, and what approval does to
the allowance — are in
[Reviews and budgets](../guides/reviews-and-budgets.md).

## `checks`

```json
{ "checks": { "typeCheck": "npm run typecheck", "lint": "npm run lint" } }
```

| Key | Sensor |
| --- | --- |
| `typeCheck` | `type-check` |
| `lint` | `linter` |

Both optional. **Absent, the sensor skips rather than guesses** — pi does not
infer your build tooling, because a green report that silently checked nothing
would be worse than an honest gap.

The consequence is worth stating plainly: if you have never set `checks`, two of
pi's six sensors have never run, and at a gate they print nothing, which looks
exactly like passing. `pi sensors` shows the skip and its reason.

Commands run from the project root with a **120-second timeout**. A timeout or a
failure becomes a warning carrying the last 15 lines of output. Neither blocks
the step.

## `docs`

Where prose lives. This is the only place in pi that knows.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `dir` | string | `"docs"` | Directory holding long-form documentation. |
| `files` | string[] | `["README.md"]` | Individual files outside `dir` that are documentation too. |
| `required` | boolean | `true` | Whether a step that changed source is expected to touch docs. |
| `exempt` | string[] | `["tests/", "test/", "**/*.test.*", "dist/"]` | Source paths that never warrant a doc update. |

`files` exists because a README at the root is documentation while an arbitrary
root-level Markdown file usually is not, and pi will not guess which is which.

### Why this is configuration

"Update the docs" written into a persona is unenforceable and drifts per
project. Declared here it becomes three concrete things: one generated sentence
in the agent's brief, one deterministic check after the step, and one place to
change when a project keeps its docs somewhere unusual.

A project with docs in `website/content` sets `dir` and its agents start getting
instructions naming that path.

### `required: false`

Keeps the rest of the config — so agents still know where docs go — while
dropping the expectation. The `docs-coverage` sensor skips entirely, and the
generated instruction changes to say updates are welcome but not required for
every change.

### How `exempt` matches

Two forms, and the distinction matters:

- **No `*`** — a path prefix. `tests/` matches `tests/` and anything beneath it.
- **Contains `*`** — a glob over the whole path. `**/*.test.*` matches
  `src/orders/cancel.test.ts`.

### When a step owes documentation

The `docs-coverage` sensor warns when **all** of these hold:

1. `docs.required` is true.
2. The step changed at least one file.
3. None of the changed files is a documentation path.
4. At least one changed file is not exempt.

So touching any documentation surface satisfies it, and a step that only changed
tests does not owe anything.

## Validation

`pi doctor` reports a malformed config with the offending key. A value of the
wrong type is an error, not a silently ignored field.

Two things the parser does not do:

**Unknown keys are ignored**, so a typo like `defaultWorkfow` is not an error —
it just has no effect, and pi uses the default.

**`facts` accepts any name.** A misspelled fact is not flagged, because pi
cannot know which names your workflows care about. It simply counts as false.
`pi status` right after `pi start` is the check that matters: it shows what got
skipped.

## See also

- [Commands](commands.md) — what reads this file and when
- [Sensors](sensors.md) — what `checks` and `docs` drive
- [Workflows](../extending/workflows.md) — declaring `when` conditions against `facts`

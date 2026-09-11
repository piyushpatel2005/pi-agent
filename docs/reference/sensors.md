# Sensors

**This page answers one question: what does each sensor check, and when does it
skip?**

Sensors are deterministic checks that run when a step reports `completed`. They
read what is on disk, they never call a model, and **they never block a step.**
Their findings surface at the gate, where a human is already looking.

Which sensors run is declared per step in the workflow. A step declaring none
runs none.

## Skipping is the thing to understand

A sensor has three outcomes: it passes (possibly with findings), it warns, or it
**skips** because its precondition was not met.

**At a gate, a skipped sensor prints nothing.** Not "skipped" — nothing. It is
indistinguishable from a sensor that ran and found no problems.

```bash
pi sensors
```

The dry run is the fix. It prints every declared sensor with its skip reason,
records nothing, and is safe to run at any time. Run it before you report, not
after.

Two of the six skip whenever `checks` is unconfigured, which for most projects
means they have never run.

## Reading the output

At the gate, findings appear as:

```
warn  [required-sections] `requirements.md` was declared but never written.
note  [docs-coverage] Documentation was updated: README.md.
```

`warn` is something to look at. `note` is context. Neither changes the outcome —
the step above completed with both.

## The six sensors

### `required-sections`

*Produced artifacts exist, have structure, and are not full of placeholders.*

For each artifact the step declared it produces:

| Finding | Condition |
| --- | --- |
| warn | The artifact was declared but never written. |
| warn | Fewer than 20 words of prose — it looks like a stub. |
| note | No headings, so it may be hard to read back. |
| warn | Contains `TBD`, `TODO`, `FIXME`, `lorem ipsum`, `???`, `<placeholder>`, or `xxx`. |

**Never skips.** A step that declares artifacts always gets this check.

The word count ignores headings and list markers, counting only prose. A heading
plus three real acceptance criteria is four lines and a perfectly good document;
four section headers with nothing under them is not. That distinction is why it
counts words rather than lines.

The placeholder check exists because an unresolved question left in an artifact
becomes someone else's guess downstream.

### `upstream-coverage`

*The step's output engages with the inputs it was given.*

Takes the headings of each consumed artifact and looks for them in the step's
output. If **none** of an input's headings appear anywhere, it warns: either the
input was not used, or the output does not say how.

| Skips when | |
| --- | --- |
| The step consumes nothing | Nothing to cover. |
| The step produced no artifacts | Nothing to look in. |

Matching is case-insensitive substring, on headings longer than three
characters. One matching heading clears an input, so this catches an ignored
input rather than a partially addressed one. It is a smoke alarm, not an audit.

### `traceability`

*Every acceptance criterion is accounted for in the validation.*

Finds a consumed artifact whose name contains `acceptance-criteria`, extracts
its bulleted or numbered items, and checks that the step's output engages with
each one. Warns with a count and the first three that went unmentioned —
"unmentioned is not the same as met".

| Skips when | |
| --- | --- |
| No consumed artifact is named `acceptance-criteria` | Nothing to trace against. |
| The step produced no artifacts | Nothing to look in. |

If the criteria file has no itemized list, it notes that there is nothing to
trace rather than warning.

The matching is more careful than the other sensors, because a naive version
would be useless here. It compares on each criterion's **distinctive** words —
longer than four characters, not stopwords, and excluding words that appear in
more than half the criteria. In a document about cancelling orders, "order" and
"cancelled" are in every line; matching on them would mark an untouched
criterion as covered just because the validation discussed the same feature,
which is the exact false pass this sensor exists to catch. A criterion counts as
covered when at least half its distinctive words appear. Items with nothing
distinctive are assumed covered rather than reported.

### `docs-coverage`

*Code changes arrived with the documentation they imply.*

Warns when a step changed files and touched no documentation. Notes which
documentation files were updated when it did.

| Skips when | |
| --- | --- |
| `docs.required` is false | Not required in this project. |
| The step changed no files | Nothing to document. |

Reads `docs` from `pi.config.json` — see
[Configuration](configuration.md), which also gives the precise rule for when a
step owes documentation and how `exempt` patterns match.

### `type-check`

*The project's type checker passes.*

Runs `checks.typeCheck`.

| Skips when | |
| --- | --- |
| No `checks.typeCheck` is configured | pi does not guess at build tooling. |
| The step changed no files | Nothing to check. |

### `linter`

*The project's linter passes.*

Runs `checks.lint`, with the same two skip conditions.

### How both command sensors behave

Run from the project root with a **120-second timeout**.

| Outcome | Finding |
| --- | --- |
| Exit 0 | note — the command passed |
| Non-zero | warn, with the last 15 lines of output, indented |
| Timeout | warn — timed out after 120s |

A failing type check is a warning. It does not stop the step, and it does not
stop you approving the gate. That is deliberate — see below — but it does mean
nobody is stopping you from approving code that does not compile.

## Why nothing blocks

The guard enforces; sensors advise. Keeping them separate is a design decision
rather than an accident, and the reasoning is in
[Guards and advice](../concepts/guards-and-advice.md).

The short version: a sensor is a heuristic over prose. `upstream-coverage` looks
for headings as substrings; `traceability` matches on word overlap. Heuristics
like these produce false positives, and a false positive that blocks a run
teaches people to disable the check. Reported at a gate where a human is already
deciding, the same heuristic is useful without being able to do harm.

## Failure handling

**A sensor that throws is reported as a skip**, carrying the error message —
advisory tooling that crashed a run would be worse than no tooling.

**A sensor id with no registered sensor** is likewise a skip, saying no sensor by
that name exists. So a typo in a workflow's `sensors` list fails silently at the
gate. `pi sensors --list` shows the registered ids, and `pi sensors` shows the
skip reason.

## See also

- [Commands](commands.md) — `pi sensors` flags
- [Configuration](configuration.md) — `checks` and `docs`
- [Workflows](../extending/workflows.md) — declaring sensors on a step

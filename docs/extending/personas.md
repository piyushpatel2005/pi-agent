# Personas

**This page answers one question: how do I change what a role does, or add one?**

A persona is a Markdown file: validated frontmatter declaring who it is and what
it may touch, then a body that becomes the operating instruction handed to the
model when a step activates that role.

## Two layers

As with workflows: shipped personas live in `core/agents/` inside the
installation, yours live in `pi/agents/` in your repository, and **a project file
shadows a shipped one with the same id.**

So you retune `backend-developer` by writing `pi/agents/backend-developer.md` —
not by editing the installation. `pi agents` marks project ones `(project)`.

## The eight shipped roles

```bash
pi agents
```

| Id | Owns |
| --- | --- |
| `business-analyst` | Requirements, acceptance criteria, and verifying delivered work meets them |
| `solution-architect` | Component boundaries, contracts, technology choices, and why |
| `ui-designer` | Screens, flows, component inventory, states, accessibility |
| `frontend-developer` | The client, against the approved contract and design |
| `backend-developer` | Services, data models, APIs |
| `devops-engineer` | Infrastructure, CI/CD, environments, security posture |
| `qa-engineer` | Test strategy and the tests that prove the acceptance criteria |
| `technical-writer` | Documentation for people outside the project |

Keeping the roster small is deliberate. Every handoff between roles loses
context, so eight broad personas beat twenty narrow ones — a backend developer
who writes their own migrations is better than a pair who have to explain the
schema to each other.

Read one in full before you change it:

```bash
pi agents backend-developer
```

## The file

```markdown
---
id: data-engineer
name: Data Engineer
description: Owns pipelines, schemas, and the correctness of what lands in the warehouse.
tools: [read, search, write-code, write-artifact, run-command, request-review]
denyTools: [delegate]
changeBudget: { maxFiles: 8, maxLines: 400 }
writesCode: true
---

You own data that other people will trust without checking it.

## How you work

Read the existing schema before proposing a new one...
```

Save as `pi/agents/data-engineer.md`. It is available to workflow steps
immediately — `agent: data-engineer`.

### Frontmatter fields

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `id` | yes | — | Lowercase kebab-case; how workflows refer to it |
| `name` | yes | — | Display name |
| `description` | yes | — | One sentence, shown by `pi agents` |
| `tools` | no | `[]` | The role's tool **ceiling** |
| `denyTools` | no | `[delegate]` | Withheld even when a step grants them |
| `changeBudget` | no | — | Default ceiling on changes before review |
| `knowledge` | no | `[]` | Reference material under `core/knowledge/<id>/` |
| `writesCode` | no | `false` | Whether this role owes documentation |

**The frontmatter parser is flat — nested blocks are not supported.** Write
`changeBudget` inline, exactly as above. This is the most common authoring
mistake:

```yaml
# Rejected: `changeBudget` opens a nested block
changeBudget:
  maxFiles: 8

# Correct
changeBudget: { maxFiles: 8, maxLines: 400 }
```

`pi doctor` reports the file and line rather than crashing.

## How tools actually resolve

Three things combine, and the order matters:

1. The **step** grants a set of tools.
2. The **persona's `tools`** is a ceiling — the grant is narrowed to it.
3. The **persona's `denyTools`** is subtracted, plus `delegate` always.

So a persona holds no tool a step did not grant, and a step cannot grant a tool
the persona does not hold. The compiler refuses a workflow that tries, so you
find out at load time.

`delegate` is unavailable to every persona in every state. Only the conductor
dispatches work, so a worker cannot quietly become an orchestrator and bury a
decision one level deeper than the log can see.

The narrowing is also applied on every tool call, not just at compile time. That
is deliberate belt-and-braces: a project persona that revokes a tool the
workflow still lists must not be the one case where the ceiling stops applying.

## `writesCode`

Drives whether the generated documentation contract appears in the brief. Set it
true and the persona is told, in wording built from your `docs` config, that
documentation is part of the work rather than a follow-up.

**Set it true whenever you grant `write-code`.** A test pins the two together,
and a role that changes source while claiming not to is how documentation goes
stale.

## The body

Everything below the frontmatter is handed to the model verbatim when a step
activates the role. This is where the actual behavior lives.

What works:

**Write instructions, not a job description.** "Read the existing schema before
proposing a new one" changes what happens. "You are an experienced data
engineer" does not.

**Say what not to do.** The shipped personas all carry a "what not to do"
section, because the failure modes are more specific than the successes.

**Say how to report.** The persona is what decides whether a summary is useful
to a reviewer or a wall of text.

**Leave out what configuration already says.** Documentation expectations and
change budgets are generated from config and injected into the brief. Writing
"remember to update the docs" into a persona duplicates something that is
already enforceable, and drifts from it.

Keep it short enough to be read. The body competes for attention with the step's
objective and the artifacts.

## Changing a shipped role

Start from the shipped file so you are editing something that works. It lives in
your pi checkout, not in your project:

```bash
cp /path/to/pi/core/agents/qa-engineer.md pi/agents/qa-engineer.md
```

Note that `pi agents qa-engineer` prints a *rendered* view — resolved tools,
budget, and body — and is not a persona file. Do not redirect it into one; it
has no frontmatter and will not parse.

Then check the roster picked up your version, and that nothing broke:

```bash
pi agents                 # yours should be marked (project)
pi doctor
```

**Narrowing is safe; widening is not.** Removing a tool from a persona is
immediately effective. Adding one that shipped workflows do not expect is
harmless on its own, but removing a tool a shipped workflow grants makes that
workflow fail to compile — the grant now exceeds the ceiling. `pi doctor` tells
you which workflow.

## Checking your work

```bash
pi agents                 # the roster, project files marked
pi agents data-engineer   # frontmatter and body as pi sees them
pi doctor                 # what failed to load, and why
```

A persona that fails to parse is reported, not fatal: the rest of the roster
still loads.

## See also

- [Workflows](workflows.md) — binding a persona to a step
- [Configuration](../reference/configuration.md) — the `docs` policy in the brief

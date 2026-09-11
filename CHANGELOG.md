# Changelog

All notable changes to `pi` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and `pi` uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe what you actually invoke — commands, flags, the errors you see,
and anything that breaks a script. Internal refactors do not earn a line.

Because `pi` is below 1.0, a minor bump may break things. The release notes say
so when it does.

## [Unreleased]

## [0.1.0] - 2026-09-11

### Added

- `pi start`, `pi next`, `pi report`, `pi status`, and `pi log`: the run loop.
  A workflow names the steps, a persona owns each one, and `pi next` answers
  the single question of what to do now.
- Seven personas — `business-analyst`, `solution-architect`, `ui-designer`,
  `frontend-developer`, `backend-developer`, `qa-engineer`, `devops-engineer`.
  `pi agents [<id>]` lists them or shows one in detail.
- Three shipped workflows: `feature`, `quick`, and `bugfix`. Projects can
  override any of them by dropping a file of the same name in `pi/workflows/`.
- `pi review request` / `resolve` / `status`, plus a change budget, so a step
  stops and asks before it writes more than you agreed to review. Approval
  starts a fresh allowance rather than raising the ceiling.
- `pi guard --tool <id>`, the decision point harness hooks call to allow or deny
  a tool call before it runs.
- `pi install`, which wires pi into Cursor's hooks. Existing hooks in the
  project are kept, not overwritten.
- `pi uninstall`, which takes pi back out: hooks, the `Shell(pi)` permission,
  the skill, and the rule. Hooks and permissions that are not pi's are left
  alone, and `pi/` — config, workflows, and run history — is never touched.
- `pi sensors`, six advisory checks that run when a step reports itself done and
  report to the human at the gate.
- `pi checkpoints` and `pi rewind --to <step>`, to move a run back to an earlier
  boundary. Dry run by default; `--yes` applies it.
- `pi doctor`, which checks the project's setup and the integrity of the run.
- `pi version --json`, reporting the pi release alongside the state and config
  schema versions and the Node version — the things worth pasting into a bug
  report.
- Runs record the pi release that created them, so an old run says which version
  of the tool to blame.
- `node scripts/release.ts <version>` cuts a release: bumps the version, closes
  this file's `Unreleased` section, commits, and tags. Dry run by default;
  `--yes` applies it. It stops short of pushing.
- Release candidates: `node scripts/release.ts 1.0.0-rc.1` tags a candidate
  without consuming the `Unreleased` notes, so the final release still has them.
- `npm run changes` lists commits since the last tag that no changelog entry
  seems to mention, grouped into changelog headings.

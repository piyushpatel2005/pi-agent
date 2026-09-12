---
description: How to behave while a pi run is active in this project.
applyTo: "**"
---

This project uses `pi` to run structured work. When a run is active, the engine
decides what happens next — not you.

- Ask `pi next --brief` for the current step and adopt the persona it names.
- Report each step with `pi report --step <id> --result <completed|failed>`.
  Report `failed` when something blocked you; never report completion over
  failing tests or missing artifacts.
- Tool calls are guarded. When one is refused, the message says what to do —
  follow it. Do not retry, and do not split a change into smaller calls to get
  under a budget: the tally is cumulative.
- Stop and run `pi review request` at a natural boundary rather than waiting to
  be stopped at the budget. End your turn after requesting; the step is frozen
  until the human answers.
- Stay inside the current step. If you notice something outside it, say so
  rather than fixing it quietly.

Run `pi status` if you are unsure whether a run is active.

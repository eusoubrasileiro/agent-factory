# docs/_archive — NOT GROUND TRUTH. Do not read for current behaviour.

Every file here is a **spent plan**: it was written to be executed, it was executed,
and the durable outcome moved to `decisions.md` (one line per decision) or into the
code and its tests. What remains here is the *reasoning at the time* — including
premises that have since been refuted.

**An agent that reads these as current will be wrong**, confidently. They describe
missions as pending that shipped weeks ago, name files that were renamed, and quote
line numbers that moved. That failure mode — a stale spec reading as authoritative to
the next agent, and corrupting the code it drives — is exactly why they were moved out
of `docs/`.

To learn what the factory does now, read, in this order:

| Question | File |
|---|---|
| how do I operate it | [`../../RUNBOOK.md`](../../RUNBOOK.md) |
| what rules does every seat obey | [`../../constitution.md`](../../constitution.md) |
| why was X decided | [`../../decisions.md`](../../decisions.md) |
| what is the architecture | [`../harness-review.md`](../harness-review.md) |

Cite one of these instead. If a rationale in here is still load-bearing, the fix is to
append a `decisions.md` line stating it — not to link back into this directory.

Restore from git history if a full text is ever needed; these paths were `docs/<name>`
before 2026-08-28.

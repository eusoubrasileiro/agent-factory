# docs/_archive — NOT GROUND TRUTH. Do not read for current behaviour.

This directory holds **spent plans**: documents written to be executed, which were
executed, after which the durable outcome moved to `decisions.md` (one line per
decision) or into the code and its tests. What is left is the reasoning at the time,
including premises since refuted.

An agent that reads a spent plan as current will be confidently wrong — they describe
shipped missions as pending, name files that were renamed, and quote line numbers that
moved. That is why they are out of `docs/`, and why `scripts/docs-law.test.mjs` fails
any live document that cites this directory.

**The spent plans themselves are not published.** They are internal planning text, not
a public artifact, and they quote conversations verbatim. They remain in the private
original. This banner stays because the doc law is part of the engine's behaviour.

To learn what the factory does now:

| Question | File |
|---|---|
| how do I operate it | [`../../RUNBOOK.md`](../../RUNBOOK.md) |
| what rules does every seat obey | [`../../constitution.md`](../../constitution.md) |
| why was X decided | [`../../decisions.md`](../../decisions.md) |
| what is the architecture | [`../harness-review.md`](../harness-review.md) |

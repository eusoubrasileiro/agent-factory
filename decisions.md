# Decision Log (append-only)

> **PLACEHOLDER — English translation pending.**
> This file is one of the four named authorities (`constitution.md`, `RUNBOOK.md`,
> `decisions.md`, `README.md`) enforced by `scripts/docs-law.test.mjs`. In the private
> repo it carries 64 ratified decisions (D-00 … D-64), written in Portuguese. The
> translated ledger replaces this file before publication; the structure below is the
> contract the rest of the repo depends on, not a sample of the content.

Replaces the retired `docs/adr/` forest. **One line per real decision.** Append only —
never edit or delete a past line (that is how a contradiction gets back in). Only record a
decision that is **hard to reverse**, **surprising without context**, or **constrains
future work**. Everything else belongs in the code and its tests.

Format — one bullet per decision, newest last:

```
- <date> · D-<nn> · **<the decision, stated as a fact>** <why, and the evidence that
  settled it; the trade-off accepted; who ratified it>
```

Rules this file is held to:

1. **Append-only.** A superseded decision is not deleted; a later line supersedes it and
   says so (`supersedes D-<nn>` / `corrects D-<nn>`). The contradiction stays visible.
2. **A decision names its ratifier.** Agents propose; André ratifies. A line without a
   ratifier is a proposal, and belongs in `decisions.inbox.md` until it is ratified.
3. **Evidence, not assertion.** A decision that was settled by a measurement cites the
   measurement. "It felt slow" is not a decision record.
4. **No live surface cites `docs/_archive/`** (rule 3 of the doc law). A spent plan's
   durable outcome lands here as one line; the plan itself dies in the archive.

<!-- D-00 … D-64 land here on translation. -->

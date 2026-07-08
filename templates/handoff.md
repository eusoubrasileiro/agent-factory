# Handoff — feature NN  ·  mission <slug>

> **Author: worker. Reader: orchestrator + next worker.** Written when the feature
> is finished or blocked. Facts, not prose. This is a typed record — keep the
> headings.

## Completed
- <what was actually done, file by file>

## Not done / deferred
- <anything left, and why>

## Commands run (with exit codes)
```
pnpm test                       → 0
pnpm --filter ... tsc --noEmit  → 0
pnpm lint                       → 0
pnpm quality-gate               → 0
pnpm test:e2e:supabase          → 0   # if run
```

## Issues hit
- <bugs, surprises, anything the validator or next worker should know>

## unmet_knowledge[]
> Each line = a fact you lacked that would have made this faster/correct. These
> become knowledge-engine inbox entries. Leave empty only if you truly needed
> nothing beyond your spec.
- <e.g. "the /api/crm BFF wraps conversation-service; I had to infer the response shape">

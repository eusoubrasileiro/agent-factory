# Feature NN — <name>  ·  mission <slug>

> **Author: orchestrator. Reader: ONE worker, clean context.**
> Self-contained — ≤ ~1300 tokens. **No cross-references to sibling features. No
> PRD.** Everything the worker needs is below. If something is missing, the worker
> records it under `unmet_knowledge`; it does not go searching the repo.

## Intent
<One or two sentences: what this feature does and why. Behavior, not vision.>

## Scope — the ONLY files you may touch
- `backend/src/...`
- `backend/test/...`
<List exactly. Anything outside this list is out of scope — flag it, don't do it.>

## My assertions (the ones I must make pass)
> The subset of `contract.md` this feature owns. The validator checks these.
- A?: <assertion text> — proven by `<command/test name>`
- A?: <assertion text> — proven by `<command/test name>`

## Pre-assembled context (everything you need, no searching)
<The orchestrator pastes the exact facts the worker needs: relevant existing
function signatures, the Prisma model shape, the route pattern to mirror, the
shared type to import, a sibling endpoint to copy. This is the context seed —
the worker should not need to explore to fill gaps.>

## TDD steps (test first)
1. Write the failing test(s) proving the assertions above.
2. Implement until green.
3. Refactor; keep `pnpm quality-gate` at 0.

## Done when
- The assertions above are green locally.
- `pnpm test`, `tsc --noEmit`, `pnpm lint`, `pnpm quality-gate` all pass.
- You committed to the mission branch and wrote `NN.handoff.md`.

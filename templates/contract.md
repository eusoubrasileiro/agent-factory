# Validation Contract — <slug>

> **Author: orchestrator (NOT the worker). Reader: validator.** Defines "done"
> **before any code exists.** Assertions are derived from the *brief's intent*,
> never read off the code. Each assertion is **observable and testable**. The
> validator runs these with fresh eyes; the worker never sees them pass.

## Definition of done
<One paragraph: the mission is done when…>

## Assertions
> Each: an id, a plain-language claim, and **how it is proven** (which command /
> probe / file). Prefer the deterministic gate; use behavioral probes for chat & UI.

| id | Assertion (observable behavior) | Proof mechanism |
|----|----------------------------------|-----------------|
| A1 | <e.g. "POST /api/crm/leads with a valid body returns 201 and the lead appears in the pipeline list"> | `pnpm test:e2e:supabase` test `<name>` |
| A2 | <e.g. "an unauthenticated request to /api/crm/leads is rejected by RLS"> | `pnpm test:e2e:supabase` RLS test `<name>` |
| A3 | <e.g. "the new 'Won' button moves the card and the change persists after reload"> | **Playwright** probe `<name>` (+ Lovable build green) |
| A4 | <e.g. "a customer WhatsApp message lands as an incoming Message"> | **`whatsapp` MCP** probe: send → assert stored |

## House-standard gate (always applies)
- `pnpm quality-gate` exits 0 (size/complexity/dup/types/coverage vs baseline).
- `pnpm test` + `tsc --noEmit` (backend & frontend) + `pnpm lint` all green.
- No edit to a Critical File unless this mission's plan named it.

## Robustness (where relevant)
<Typos / rephrasing / empty input / adversarial variation the feature must
tolerate. Leave blank if N/A.>

## Verdict
The mission **passes** only when **every** assertion above is green **and** the
house-standard gate exits 0, proven **locally** (supabase local). Any red → FAIL
with the failing assertion ids and why → back to the orchestrator.

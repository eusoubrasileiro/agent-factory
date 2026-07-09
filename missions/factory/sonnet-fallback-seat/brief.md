# Brief — sonnet-fallback-seat

## Intent

**GLM-5.2 stays the default builder. Sonnet 5 becomes a configurable fallback.**
Ratified by Andre 2026-07-10.

## Why now

Mid-session on 2026-07-09 the external builder stopped producing anything. Three failed
experiments and a raw `curl` later, the cause was:

```
429 rate_limit_error, z.ai code 1308
"Usage limit reached for 5 hour. Your limit will reset at 2026-07-10 03:55:20"
```

**Not exhausted credit — a 5-hour rolling window.** I reported "credits exhausted" to Andre
on the strength of a probe that returned nothing; a one-second `curl` would have said
otherwise. `opencode` swallows the error entirely: zero bytes on stdout AND stderr, a
30-minute hang that reads as a slow build. `claude -p` surfaces it only with `--print-logs`.

Two consequences:
1. The operator needs a **fallback model** for that window, without editing code.
2. The driver must **say it is rate-limited**, not hang.

## Business value

The factory's KPI is attention-per-feature. A builder that hangs silently for thirty
minutes, and a seat you cannot switch without editing code, both spend the one resource
the factory exists to conserve.

## Constraint that shapes the design

Anthropic spend must always be **typed, never defaulted into**. `claude-worker.mjs`'s
endpoint guard refuses Anthropic because a missing `ANTHROPIC_BASE_URL` silently falls back
there and bills real money for a flat-rate seat. It cannot distinguish "Andre chose this"
from "the env var was missing", so it refuses both. The flag is that distinction.

**No automatic failover.** Silently switching to Sonnet when GLM is rate-limited would spend
Anthropic tokens without being asked — the same class of mistake the guard exists to prevent.
Detect, explain, stop.

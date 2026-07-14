# Mission: factory-secret-min

**Requirements:** hardening / factory
**Seat:** coordinator-authored (Opus) — see deviation note below.

## Intent
External (GLM/opencode) factory seats must never see a real secret. Today dispatch
symlinks the real prod `.env` (Supabase service-role key, WABA AES key, LLM provider
keys) into every worktree, and `opencode-worker.mjs` spawns the external model with the
coordinator's full inherited `process.env`. Both are closed here.

## Changes
- **F1** — `scripts/factory/templates/external-seat.env` (new, checked-in dummy env
  mirroring `backend/test/setup/env.ts`) + `scripts/dispatch-worktree.sh --seat
  external|claude` (default `claude`). External seats get generated dummy `.env`/`.env.test`
  (+ per-agent DB URLs) instead of the real-secret symlinks; the parent-`.env` refusal is
  skipped for them; `SEAT=` is printed in the stdout block.
- **F2** — `scripts/factory/opencode-worker.mjs`: `buildSpawnEnv()` allowlist
  (`PATH HOME LANG LC_ALL TERM TMPDIR` + `XDG_*`) applied to the opencode spawn. z.ai auth
  is file-based under `$HOME`, so `HOME` alone preserves auth — no secret var, no wildcard.
- **F3** — `scripts/factory/probe-secrets.mjs` (+ test): greps a worktree's `.env*` for any
  parent-secret value >12 chars → exit 1 on a hit.

## Enabling fact
The whole gate (`test:factory`, backend/frontend unit, tsc, lint, quality-gate, hermetic
`test:e2e`) runs green on dummy env. `test:e2e:real` / `test:vendor-smoke` do NOT run in
external worktrees — by design.

## Deviation
`dispatch-worktree.sh` is a **secrets-handling Critical File**. Rather than hand the build
to a GLM worker — which would require dispatching an UNPROTECTED worktree (pre-fix: real
`.env` symlinked + full env inherited), i.e. leaking real secrets to the external model on
the very mission meant to stop that — the coordinator (Opus) authored the ~60-line diff
directly under strict TDD. Andre reviews the diff at ratify.

## Do NOT
push / open PR / merge / ratify. Left committed on `agent/factory-secret-min`.

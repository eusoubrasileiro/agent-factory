# Contract — kpi-attention

Read `docs/plan-A-ship-truth-2026-07-11.md` §F4 and §F5 first — it is the spec.
Files you may touch: `scripts/session-cost.mjs` (new), `scripts/session-cost.test.mjs`
(new), `scripts/kpi.mjs` (new), `scripts/kpi.test.mjs` (new), `package.json` (one
script line only). Nothing else — NOT `metrics.mjs`, NOT `skills/**`.

## F4 — session-cost.mjs (coordinator token side)

```
node scripts/session-cost.mjs [--dir <transcriptDir>] [--since <ISO date>] [--json]
```

- A1 Default `--dir`: derive from cwd via `encodeTranscriptDir` (already exported from
  `scripts/lib/transcript-tokens.mjs`) under `~/.claude/projects/`. Reuse
  `loadTranscriptUsage` for parsing wherever its shape fits; extend locally if it
  doesn't (do not modify the lib).
- A2 Sums per-message `usage` fields grouped by **day × model**: input, output,
  cache_read, cache_creation, total. Table to stdout; `--json` emits machine form.
- A3 Corrupt/partial JSONL lines are skipped, never throw (house style, per-line
  try/catch, cf. `history.mjs readHistory`).
  *Mutation gate: make a corrupt line throw → named test red.*
- A4 A missing/empty transcript dir prints `sem transcripts em <dir>` and exits 0 —
  report tool, never crashes.
- A5 Report-only: reads only. Zero writes anywhere. No daemon, no watch mode.

## F5 — kpi.mjs (the one honest table)

```
node scripts/kpi.mjs [--project <id>] [--window <days>=30] [--json]
```

Per project (all known profiles when --project absent), over the window:

- B1 **missions merged**: count from git — branches `agent/<slug>` merged into trunk
  within the window (`git log --merges --since`), joined to dossiers under
  `missions/<project>/`. Inject the git runner so tests are hermetic.
- B2 **seat tokens**: sum from each mission's `metrics.jsonl` (reuse the seat-token
  helpers already exported by `scripts/mission-stats.mjs` — `seatTokens` at :199 — or
  read stats.json when present; pick ONE source and document it in the header comment).
- B3 **coordinator tokens**: from session-cost's core (import its exported pure
  function; do not shell out).
- B4 **attention-per-feature**: (touchpoints + interventions + escalations) / features,
  from metrics.jsonl events — the RUNBOOK §Read-the-meter figure.
- B5 **E1-d law (hard):** any cell whose inputs are missing renders `—` (em-dash),
  NEVER 0. Zero is a measurement; absence is absence.
  *Mutation gate: zero-fill a missing cell → named test red.*
- B6 `package.json`: add `"kpi": "node scripts/kpi.mjs"`. Touch nothing else in it.

## Structure

Pure exported cores (`summarizeUsage(rows)`, `buildKpi(inputs)`) + thin IO shells
(house style). Tests: node:test, tmpdir fixtures, injected fakes for git/fs where
practical. `pnpm test` green from worktree root. No product literals (fixtures use
generic ids).

## Out of scope

Skill emitter edits (coordinator does those), metrics.mjs changes, board rendering,
`cleanupPeriodDays` config (coordinator).

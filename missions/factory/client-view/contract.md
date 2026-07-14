# Contract — client-view

Files you may touch: `scripts/client-view.mjs` (new), `scripts/client-view.test.mjs`
(new), `scripts/board-autopublish.mjs` + its test (ONLY the minimal wiring in D below).
Nothing else.

## A — renderer (pure)

`scripts/client-view.mjs` exports:

```
renderClientPage({ intake, missions, generatedAt, projectName })  → HTML string
buildClientRows(intake, missions)                                 → row model (pure)
```

- A1 **Whitelist construction.** `buildClientRows` maps each intake row to EXACTLY
  `{ id, summary, clientStatus, shippedDate }` — built field-by-field from an
  allowlist, never by spreading/cloning the source row.
  *Mutation gate: spread the source row into the output → the leak test (C1) goes red.*
- A2 **Status mapping** (intake lifecycle `STATUSES` from `scripts/intake-report.mjs:34`
  — reuse, don't redeclare): `New`/`Distilled` → **na fila** · `Ratified` → **em
  construção** · `Landed` → **no ar**. Unknown → **na fila** (never crash, never leak
  the raw value).
- A3 **Exclusion by type:** rows whose `type` is `business-decision` are dropped
  entirely (engagement/payment lines are not project progress).
  *Mutation gate: stop dropping them → named test red.*
- A4 **`Novidades da semana`:** a section listing rows whose status became Landed with
  a shipped/landed date within the last 7 days of `generatedAt` (derive date from the
  row's own date fields; when no date is derivable the row simply doesn't appear here —
  absent, never guessed).
- A5 **Language:** page is plain PT-BR. Section headings: `O que você pediu` (funnel
  table: pedido / situação / entregue em) and `Novidades da semana`. Status badges show
  ONLY the three client words. Footer: `atualizado em <DD/MM/YYYY HH:MM>` (UTC format,
  same shape as board-report's formatDateTime — you may copy the 8-line helper; do NOT
  import board-report, the client page must not grow a dependency on the operator
  renderer).
- A6 **Self-contained HTML:** single inline `<style>`, zero external loads, mobile-first
  (the client reads on a phone: max-width card layout, ≥16px base font, table degrades
  to stacked cards under 480px via CSS only). `lang="pt-BR"`. No `<script>` at all —
  a static page needs none, and no script = no leak channel.
- A7 Escape everything interpolated (write a local 5-line `esc()`, same as
  `board-index.mjs:24` pattern).

## B — intake summary sanitation

- B1 The `summary` shown to the client is the intake row's summary with inline
  backtick-code spans REMOVED (content kept, backticks stripped) and any `→`-chain of
  mission slugs/backlog ids stripped. If after stripping the summary is empty, fall
  back to the row id alone.
- B2 The `# Detalhamento técnico` block (`detail` field) is NEVER read — not even to
  test emptiness. `buildClientRows` must not reference the field.

## C — the leak test (the heart)

- C1 `client-view.test.mjs` builds a fixture intake containing every forbidden class:
  a `business-decision` row with "R$ 2.000" and "pagamento"; a row with a
  `detail` block containing "claude-opus", "glm-5.2", "tokens", "$4.20"; summaries with
  backticks and mission-slug chains; a `models`/`stats` field on a mission. It renders
  the FULL page and asserts the output contains NONE of:
  `R$`, `$`, `tok`, `glm`, `claude`, `opus`, `sonnet`, `detalhamento`, `pagamento`,
  `gate:`, `agent/`, the mission slug, `Needs Human`, `verdict`, `PASS`, `FAIL`.
  Case-insensitive. This is ONE named test: `leak: forbidden token classes never reach
  client HTML`.
- C2 A second test asserts the ALLOWED content did land (ids, plain summaries, the
  three status words, dates) — the whitelist must not be satisfied by rendering nothing.

## D — publish wiring (minimal)

- D1 `board-autopublish.mjs`: after per-project renders, render the client page for
  every project whose profile declares `intake[]` (today that's one; the engine stays
  product-agnostic) into `dist/factory-board/cliente/index.html`. Reuse the model the
  project render already built if reachable; otherwise call the renderer with the
  intake read the funnel already performs. Fold the HTML into the existing content hash
  (timestamp-stripping rules included) so a client-page change republishes and a
  no-change run stays "sem mudanças".
- D2 If NO project declares intake, no cliente/ dir is written (and a stale one is not
  deleted by you — rsync --delete handles it).
- D3 Autopublish tests: extend existing test file minimally (client page in hash, D2).

## Gate

`pnpm test` green from worktree root. No product literals in `scripts/**` (meta-test).
Small commits on `agent/client-view`. Handoff at
`missions/factory/client-view/features/01.handoff.md`.

## Out of scope

Traefik/VPS routing (M6, coordinator). Operator board changes. Provisioning users.

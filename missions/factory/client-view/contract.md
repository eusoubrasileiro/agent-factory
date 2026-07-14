# Contract — client-view (v2, redesigned after leak failure)

## Why v2

v1 rendered the intake `summary` field (whitelisted) and passed the seat's fixture
leak test — but against the REAL `clients/tenant-a/requirements-intake.md` it leaked
massively: the summary field IS engineering prose (file:line refs, commit hashes,
branch names, internal audit corrections, `*(engagement)*` strategy). A whitelist that
includes `summary` leaks by construction. **The only safe design is to render a
separately-curated client-safe label, never the intake summary.**

Files you may touch: `scripts/client-view.mjs` (rewrite), `scripts/client-view.test.mjs`
(rewrite), `scripts/board-autopublish.mjs` + test (wiring only). Nothing else.

## A — data model: curated labels, join by id

- The client-safe text comes from `clients/tenant-a/client-labels.json` — an object
  `{ "IN-44": { "label": "<plain PT phrase>", "client_visible": true|false }, ... }`
  (authored separately, ratified by André). The renderer is handed this map as data;
  it does NOT read the intake summary for display text.
- A1 `buildClientRows(intake, labels, missions)` emits one row per intake id that is
  BOTH `client_visible: true` AND has a non-empty `label`. Every other row is omitted.
  Each emitted row is EXACTLY `{ label, clientStatus, shippedDate }` — built field by
  field. The intake `id`, `summary`, `type`, `detail` are NEVER copied into the output.
  *Mutation gate: include a row whose label is missing or client_visible:false → the
  leak/whitelist test goes red.*
- A2 Status mapping from the intake lifecycle (`STATUSES`, scripts/intake-report.mjs:34):
  `New`/`Distilled` → **na fila** · `Ratified` → **em construção** · `Landed` → **no ar**.
  Unknown → **na fila**.
- A3 `shippedDate` only for `no ar` rows (a Landed date within the row's data);
  otherwise empty. Never guess.

## B — fail-closed leak filter (defense in depth)

- B1 Even a curated label passes through a final `isClientSafe(text)` guard before
  render: reject (drop the whole row, log nothing to output) if the label matches any
  forbidden class (case-insensitive): `R$`, `$`+digit, `tok`, model names
  (glm|claude|opus|sonnet|gpt|gemini), `detalhamento`, `pagamento`, `engagement`,
  `gate:`, `agent/`, `.ts`/`.tsx`/`.mjs`, `:` followed by digits (line refs), a 7+ hex
  run (commit), `Needs Human`, `verdict`, `PASS`, `FAIL`. Curated labels should never
  trip this — the guard exists so a bad label fails CLOSED (row vanishes), never leaks.
  *Mutation gate: disable the guard → a test feeding a label with "webhook.ts:12" still
  renders it → red.*

## C — the leak test (against REAL data, not a fixture)

- C1 `client-view.test.mjs` reads the ACTUAL
  `/home/andre/Projects/amiticia/clients/tenant-a/requirements-intake.md` via
  `parseIntake` (intake-report.mjs) AND the ACTUAL `client-labels.json`, renders the
  full page, and asserts the output contains NONE of the forbidden classes in B1.
  This is the named test `leak: real tenant-a intake never reaches client HTML`. If the
  labels file is absent at test time, SKIP with a clear message (don't fake-pass).
- C2 A positive test: at least one curated `no ar` row renders its label + "no ar" +
  its date; and a `client_visible:false` row's label never appears.

## D — page (unchanged from v1 where safe)

- Plain PT-BR, self-contained HTML, mobile-first, NO `<script>`. Sections:
  `O que estamos construindo` (the funnel: label · situação · entregue em) and
  `Novidades da semana` (labels that reached `no ar` in the last 7 days of
  `generatedAt`). Footer `atualizado em <DD/MM/YYYY HH:MM>` (local formatDateTime helper,
  no board-report import). Local `esc()`. Three status words only.

## E — publish wiring (minimal)

- E1 `board-autopublish.mjs`: render the client page into
  `dist/factory-board/cliente/index.html` ONLY when BOTH the project declares
  `intake[]` AND `client-labels.json` exists and parses. If labels are absent, write NO
  cliente/ dir (fail-closed — never publish an unlabeled, therefore unsafe, page).
  Fold into the content hash.
- E2 Autopublish test covers: labels present → page written; labels absent → no page.

## Gate

`pnpm test` green from worktree root. No product literals in `scripts/**`. Small commits
on `agent/client-view-v2`. Handoff at
`missions/factory/client-view/features/02.handoff.md`.

## Out of scope

Authoring the labels (André ratifies a drafted set — separate). Traefik/VPS (M6).
Operator board.

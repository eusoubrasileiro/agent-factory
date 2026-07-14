#!/usr/bin/env node
/**
 * Client-facing status page (client-view, M5 — v2 redesign after the v1 leak).
 *
 * v1 whitelisted the intake `summary` field and passed a fixture leak test, but
 * against the REAL client intake it leaked everything: the summary IS engineering
 * prose (file:line refs, commit hashes, model names, engagement strategy). A
 * whitelist that includes `summary` leaks by construction.
 *
 * v2 is whitelist-by-construction in the strict sense — start from NOTHING and
 * add only a separately-curated label:
 *
 *   - The only client-facing text is the `label` from a curated
 *     `client-labels.json` map (`{ "IN-44": { label, client_visible } }`),
 *     authored and ratified apart from the intake. The intake `id`, `summary`,
 *     `type` and `detail` are NEVER copied into the output — `id` is a join key
 *     only, `status` drives the PT status word, `date` drives the ship date.
 *   - A row renders only if it has a curated, `client_visible: true`, non-empty
 *     label (A1), AND that label survives a final fail-closed `isClientSafe`
 *     guard (B1). A bad label fails CLOSED — the row vanishes, never leaks.
 *
 * Pure module: model in, HTML string out. No disk, no network, no `<script>`,
 * no external resources. The intake is read elsewhere (the leak test reads the
 * real files directly; the autopublish funnel reads them via intake-report.mjs).
 *
 * Plain Node ESM, no deps. Local `esc`/`formatDateTime` (contract D: no
 * board-report import) — the client page must not pull the operator board's
 * render surface into its dependency graph.
 */

// ─── Local helpers (contract D: no board-report import) ───────────────────────

/** Escape the five HTML-significant characters for safe text interpolation. */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Format an ISO date as `DD/MM/YYYY` (UTC, locale-independent). Empty string for
 * a missing or unparseable input — the ship date is never guessed.
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/**
 * Format an ISO timestamp as `DD/MM/YYYY HH:MM` (UTC, deterministic for tests).
 * The page footer's "atualizado em" line.
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${formatDate(iso)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ─── A2 — status mapping (the ONLY three words a client ever sees) ────────────

/** The three client-facing status words — nothing else may leave this module. */
export const CLIENT_STATUSES = ["na fila", "em construção", "no ar"];

/**
 * Map an intake lifecycle status to one of the three client words.
 *   New | Distilled → na fila · Ratified → em construção · Landed → no ar.
 * Anything unknown (including empty) collapses to `na fila` — the safe default
 * is "not shipped yet", never a claim of progress.
 * @param {string} status
 * @returns {"na fila" | "em construção" | "no ar"}
 */
export function mapClientStatus(status) {
  if (status === "Ratified") return "em construção";
  if (status === "Landed") return "no ar";
  return "na fila"; // New, Distilled, unknown, empty
}

// ─── B1 — the fail-closed leak guard ──────────────────────────────────────────
//
// Defense in depth: even a curated label is re-checked before render. The guard
// exists so a bad label (a stray edit, a paste of engineering notes) fails
// CLOSED — the row vanishes — rather than leaking. Curated labels are vetted PT
// outcome phrases and should never trip any of these; the list mirrors the
// forbidden classes a published client page must never carry (contract B1).

/** @type {Array<{name: string, re: RegExp}>} */
const FORBIDDEN_CLASSES = [
  { name: "currency (R$)", re: /r\$/i },
  { name: "currency ($+digit)", re: /\$\d/ },
  { name: "token count", re: /tok/i },
  { name: "model name", re: /\b(glm|claude|opus|sonnet|gpt|gemini)\b/i },
  { name: "detalhamento", re: /detalhamento/i },
  { name: "pagamento", re: /pagamento/i },
  { name: "engagement", re: /engagement/i },
  { name: "gate marker", re: /gate:/i },
  { name: "agent branch", re: /agent\//i },
  { name: "source extension", re: /\.(ts|tsx|mjs)\b/i },
  { name: "line ref (:digits)", re: /:\d/ },
  { name: "commit (7+ hex)", re: /[0-9a-f]{7,}/i },
  { name: "Needs Human", re: /needs human/i },
  { name: "verdict", re: /verdict/i },
  { name: "PASS", re: /\bpass\b/i },
  { name: "FAIL", re: /\bfail\b/i },
];

/**
 * True when `text` carries NONE of the forbidden classes. Case-insensitive.
 * Applied to each curated label before render; a rejection drops the whole row.
 * @param {string} text
 * @returns {boolean}
 */
export function isClientSafe(text) {
  const s = String(text ?? "");
  return !FORBIDDEN_CLASSES.some(({ re }) => re.test(s));
}

// ─── A1 / A3 — row assembly (whitelist by construction) ───────────────────────

/**
 * Resolve the ship date for a `no ar` (Landed) row.
 *
 * The intake row carries a single date — the day it was logged — and no separate
 * ship date, so that date is the only "Landed date within the row's data"
 * available (contract A3). It is never guessed: an unparseable date yields "".
 *
 * @param {object} row — an intake row (`status`, `date`).
 * @returns {string} `DD/MM/YYYY`, or "" when the row is not `no ar` / undated.
 */
function shippedDateFor(row) {
  if (mapClientStatus(row?.status) !== "no ar") return "";
  return formatDate(row?.date);
}

/**
 * Build the client-facing rows: one per intake id that is BOTH
 * `client_visible: true` AND has a non-empty curated label, AND whose label
 * passes the fail-closed guard. Everything else is omitted.
 *
 * Each emitted row is EXACTLY `{ label, clientStatus, shippedDate }`, built field
 * by field. The intake `id`, `summary`, `type` and `detail` are NEVER copied —
 * `id` is a join key only. Rows stay in intake order (newest first).
 *
 * `missions` is accepted for signature fidelity and reserved for a future richer
 * per-requirement landed date; the ship date is derivable from the row alone, so
 * the leak-safe core never depends on it.
 *
 * @param {Array<object>} intake — intake rows (from parseIntake / readIntake).
 * @param {Record<string, {label?: string, client_visible?: boolean}>} labels — curated label map, keyed by intake id.
 * @param {Array<object>} [missions] — optional board mission model (unused today).
 * @returns {Array<{label: string, clientStatus: string, shippedDate: string}>}
 */
export function buildClientRows(intake, labels, missions) {
  void missions; // reserved (see JSDoc); not required for leak-safe rendering
  const rows = Array.isArray(intake) ? intake : [];
  const map = labels && typeof labels === "object" ? labels : {};
  const out = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    const entry = map[row.id];
    if (!entry || entry.client_visible !== true) continue; // hidden or unmarked → omit
    const label = String(entry.label ?? "").trim();
    if (label.length === 0) continue; // no curated text → omit
    if (!isClientSafe(label)) continue; // guard trip → fail closed
    // Build field by field — never spread the intake row or the label entry.
    out.push({
      label,
      clientStatus: mapClientStatus(row.status),
      shippedDate: shippedDateFor(row),
    });
  }
  return out;
}

/**
 * The same rows as `buildClientRows`, plus the raw landed ISO date retained for
 * the "Novidades da semana" 7-day window (which the public 3-field shape drops).
 * Internal only — never exported as the client row contract.
 * @returns {Array<{label: string, clientStatus: string, shippedDate: string, landedISO: string}>}
 */
function enrichRows(intake, labels) {
  const rows = Array.isArray(intake) ? intake : [];
  const map = labels && typeof labels === "object" ? labels : {};
  const out = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    const entry = map[row.id];
    if (!entry || entry.client_visible !== true) continue;
    const label = String(entry.label ?? "").trim();
    if (label.length === 0 || !isClientSafe(label)) continue;
    const clientStatus = mapClientStatus(row.status);
    out.push({
      label,
      clientStatus,
      shippedDate: clientStatus === "no ar" ? formatDate(row.date) : "",
      landedISO: clientStatus === "no ar" ? row.date : "",
    });
  }
  return out;
}

/**
 * True when `landedISO` falls within the 7 days ending at `generatedAt`
 * (inclusive). A future or unparseable date is never a novidade.
 * @param {string} landedISO
 * @param {string} generatedAt
 * @returns {boolean}
 */
function withinLast7Days(landedISO, generatedAt) {
  if (!landedISO || !generatedAt) return false;
  const landed = new Date(landedISO);
  const now = new Date(generatedAt);
  if (Number.isNaN(landed.getTime()) || Number.isNaN(now.getTime())) return false;
  const diff = now.getTime() - landed.getTime();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return diff >= 0 && diff <= sevenDays;
}

// ─── D — the page ─────────────────────────────────────────────────────────────

/** CSS class suffix for a client status word (falls back to "na-fila"). */
function statusClass(clientStatus) {
  if (clientStatus === "no ar") return "no-ar";
  if (clientStatus === "em construção") return "em-construcao";
  return "na-fila";
}

/** Render one funnel row: label · situação · entregue em. */
function renderFunnelRow(r) {
  const date = r.shippedDate ? esc(r.shippedDate) : "—";
  return `        <li class="linha">
          <span class="rotulo">${esc(r.label)}</span>
          <span class="situacao situacao-${statusClass(r.clientStatus)}">${esc(r.clientStatus)}</span>
          <span class="data">${date}</span>
        </li>`;
}

/** Render one novidade row (a recent `no ar`): label + date. */
function renderNovidadeRow(r) {
  return `        <li class="linha novidade">
          <span class="rotulo">${esc(r.label)}</span>
          <span class="data">${esc(r.shippedDate)}</span>
        </li>`;
}

function renderStyles() {
  return `
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #1f2937;
  background: #fafafa;
  line-height: 1.5;
}
header.site { padding: 1.5rem 1.25rem 0; }
header.site h1 { margin: 0; font-size: 1.2rem; font-weight: 600; }
header.site p { margin: 0.25rem 0 0; color: #4b5563; font-size: 0.9rem; }
main { padding: 1rem 1.25rem 3rem; max-width: 720px; margin: 0 auto; }
section { margin-top: 1.75rem; }
h2 { font-size: 1.02rem; font-weight: 600; margin: 0 0 0.5rem; }
ul.funil { list-style: none; margin: 0; padding: 0; }
ul.funil li.linha {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 0.5rem 0.75rem;
  align-items: center;
  padding: 0.6rem 0;
  border-bottom: 1px solid #e5e7eb;
}
ul.funil li.linha:last-child { border-bottom: none; }
.rotulo { font-size: 0.95rem; }
.situacao {
  display: inline-block; padding: 0.1rem 0.55rem; border-radius: 9999px;
  font-size: 0.74rem; font-weight: 600; white-space: nowrap;
}
.situacao-no-ar { background: #dcfce7; color: #166534; }
.situacao-em-construcao { background: #dbeafe; color: #1e40af; }
.situacao-na-fila { background: #f1f5f9; color: #475569; }
.data { font-size: 0.82rem; color: #4b5563; white-space: nowrap; font-variant-numeric: tabular-nums; }
ul.novidades { list-style: none; margin: 0; padding: 0; }
ul.novidades li.novidade {
  padding: 0.5rem 0; border-bottom: 1px solid #e5e7eb;
  display: flex; justify-content: space-between; gap: 0.75rem;
}
ul.novidades li.novidade:last-child { border-bottom: none; }
.vazio { color: #4b5563; font-size: 0.9rem; }
footer.site { padding: 1rem 1.25rem; border-top: 1px solid #e5e7eb; color: #4b5563; font-size: 0.78rem; text-align: center; }
`;
}

/**
 * Render the self-contained client status page. Pure: model → HTML string.
 *
 * Two sections (contract D): `O que estamos construindo` (the funnel: label ·
 * situação · entregue em) and `Novidades da semana` (labels that reached `no ar`
 * within the 7 days before `generatedAt`). Footer `atualizado em <DD/MM/YYYY
 * HH:MM>`. No `<script>`, no external resources, mobile-first, PT-BR.
 *
 * @param {{intake?: Array<object>, labels?: Record<string, object>, missions?: Array<object>, generatedAt?: string}} args
 * @returns {string} — a complete HTML document.
 */
export function renderClientPage({ intake, labels, missions, generatedAt } = {}) {
  void missions;
  const iso = generatedAt ?? new Date().toISOString();
  const rows = enrichRows(intake, labels);
  const novidades = rows.filter((r) => r.clientStatus === "no ar" && withinLast7Days(r.landedISO, iso));

  const funnelHtml = rows.length
    ? `      <ul class="funil">\n${rows.map(renderFunnelRow).join("\n")}\n      </ul>`
    : `      <p class="vazio">Ainda não há nada por aqui.</p>`;

  const novidadesHtml = novidades.length
    ? `      <ul class="novidades">\n${novidades.map(renderNovidadeRow).join("\n")}\n      </ul>`
    : `      <p class="vazio">Nenhuma novidade nesta semana.</p>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acompanhe o seu projeto</title>
  <style>
${renderStyles()}
  </style>
</head>
<body>
  <header class="site">
    <h1>Acompanhe o seu projeto</h1>
    <p>O que pediu, em que pé está e o que já entrou no ar.</p>
  </header>
  <main>
    <section class="funil">
      <h2>O que estamos construindo</h2>
${funnelHtml}
    </section>
    <section class="novidades">
      <h2>Novidades da semana</h2>
${novidadesHtml}
    </section>
  </main>
  <footer class="site">
    atualizado em <time datetime="${esc(iso)}">${esc(formatDateTime(iso))}</time>
  </footer>
</body>
</html>
`;
}

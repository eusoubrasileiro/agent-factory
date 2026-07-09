#!/usr/bin/env node
/**
 * Factory board root index — the `/` landing page (feature 03).
 *
 * Two PURE renderers, both self-contained PT-BR HTML (inline `<style>`, zero
 * external resource loads — same rules as the per-project dashboard):
 *   - `renderRootIndex(projects, stats)` — one card per projects.json entry:
 *     nome, missões em voo (count), última atualização, link `/<id>/`.
 *   - `renderScrumbanRedirect(target)` — `/scrumban/` meta-refresh redirect to a
 *     caller-chosen target (historical-compat for the old single-board URL;
 *     `board-autopublish` sends it to the root index, which names no product).
 *
 * House style = `scripts/factory/board-sync.mjs`: pure exported core + thin IO
 * shell. This module does NO disk and NO network — the autopublish funnel
 * (`board-autopublish.mjs`) calls these renderers and writes the files.
 *
 * Visual consistency: the dashboard (`board-report.mjs`) keeps its style
 * constants private, so this module ships a pared-down inline stylesheet that
 * reuses the same CSS-variable vocabulary (colors, card aesthetic, footer) so
 * the root index reads as the same product.
 */

/** Escape the five HTML-significant characters for safe text interpolation. */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ROOT_STYLES = `
:root {
  --bg: #fafafa;
  --fg: #1f2937;
  --muted: #6b7280;
  --border: #e5e7eb;
  --card-bg: #ffffff;
  --link: #2563eb;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--fg);
  background: var(--bg);
  line-height: 1.5;
}
header.site { padding: 1.5rem 2rem; border-bottom: 1px solid var(--border); background: var(--card-bg); }
header.site h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
main { padding: 1.5rem 2rem 4rem; max-width: 1100px; margin: 0 auto; }
.cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.project-card {
  display: flex; flex-direction: column; gap: 0.35rem;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--card-bg); padding: 1rem 1.25rem;
  text-decoration: none; color: var(--fg);
  transition: border-color 0.15s ease;
}
.project-card:hover { border-color: var(--link); }
.card-name { font-weight: 600; font-size: 1rem; }
.card-inflight { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.85rem; }
.card-updated { color: var(--muted); font-size: 0.78rem; }
.muted { color: var(--muted); }
footer.site { padding: 1rem 2rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.78rem; text-align: center; }
`;

/**
 * Render one project card. Pure; never throws.
 * @param {{id?: string, name?: string, inFlight?: number, updatedAt?: string|null}} p
 * @returns {string}
 */
function renderProjectCard(p) {
  const id = esc(p?.id ?? "");
  const name = esc(p?.name && String(p.name).length > 0 ? p.name : (p?.id ?? ""));
  const inFlight = Number.isInteger(p?.inFlight) ? p.inFlight : 0;
  const noun = inFlight === 1 ? "missão em voo" : "missões em voo";
  const updatedAt = p?.updatedAt ?? null;
  const updatedAtHtml = updatedAt
    ? `\n        <span class="card-updated">última atualização ${esc(updatedAt)}</span>`
    : "";
  return `      <a class="project-card" href="/${id}/">
        <span class="card-name">${name}</span>
        <span class="card-inflight">${inFlight} ${noun}</span>${updatedAtHtml}
      </a>`;
}

/**
 * Render the root project index as a self-contained HTML document.
 *
 * @param {Array<{id: string, name?: string, inFlight?: number, updatedAt?: string|null}>} projects
 *   One entry per projects.json manifest row, enriched with the in-flight
 *   mission count and the project's last-render timestamp.
 * @param {{generatedAt?: string}} [stats]
 *   `generatedAt` overrides the footer timestamp (defaults to now).
 * @returns {string} — a complete HTML document.
 */
export function renderRootIndex(projects, stats = {}) {
  const generatedAt = stats?.generatedAt ?? new Date().toISOString();
  const list = Array.isArray(projects) ? projects : [];
  const cards =
    list.length > 0
      ? list.map(renderProjectCard).join("\n")
      : '      <p class="muted">Nenhum projeto.</p>';

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fábrica Nexus — projetos</title>
  <style>
${ROOT_STYLES}
  </style>
</head>
<body>
  <header class="site">
    <h1>Fábrica Nexus — projetos</h1>
  </header>
  <main>
    <div class="cards">
${cards}
    </div>
  </main>
  <footer class="site">
    gerado em <time datetime="${esc(generatedAt)}">${esc(generatedAt)}</time> · board-index
  </footer>
</body>
</html>
`;
}

const REDIRECT_STYLES =
  "body{font-family:system-ui,-apple-system,sans-serif;color:#6b7280;text-align:center;padding:2rem;margin:0}";

/**
 * Render the `/scrumban/` meta-refresh redirect as a self-contained HTML
 * document. The redirect is instant (content="0") and carries a canonical link
 * for SEO/crawler hygiene.
 *
 * The target is a caller decision, never an engine fact. `board-autopublish`
 * passes `/` — the root index, which lists every project and names none. It
 * deliberately does NOT pass the first manifest entry: with one project that
 * looks like "the product this board was built for", but with two it is just
 * whichever id sorts first.
 *
 * @param {string} [target="/"] — absolute path or URL to redirect to.
 * @returns {string} — a complete HTML document.
 */
export function renderScrumbanRedirect(target = "/") {
  const t = esc(target);
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0; url=${t}">
  <link rel="canonical" href="${t}">
  <title>movido para ${t}</title>
  <style>${REDIRECT_STYLES}</style>
</head>
<body>
  <p>movido para <a href="${t}">${t}</a></p>
</body>
</html>
`;
}

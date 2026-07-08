#!/usr/bin/env node
/**
 * Factory board-report model (traceability core — pure, no HTML).
 *
 * Reads REAL disk state — mission dirs under `factory/missions/<slug>/`, verdicts,
 * markers, the backlog PRD body tables, and the live `agent/*` git branches — and
 * assembles ONE model object: requirements ⇄ missions ⇄ branches.
 *
 * The model is read-only: nothing here ever writes back into a mission dir, the
 * PRD, or git. The HTML renderer (feature 02) consumes this shape directly.
 *
 * Cardinality rules:
 *   - requirement↔mission join lives ONLY in each mission's `brief.md`
 *     `**Requirements:** <ids|none>` line. Contract/plan local IDs (e.g. a
 *     role-funcionario's C1–C3 acceptance criteria) NEVER map — that collision
 *     is the reason this module exists.
 *   - mission↔branch join is by slug: an `agent/<slug>` branch attaches to the
 *     mission dir of the same `<slug>`; branches with no mission dir are orphans.
 *
 * Usage:
 *   node scripts/factory/board-report.mjs [--missions <dir>] [--prd <path>] [--repo <root>]
 *     [--branch-prefix <p>] [--trunk <branch>]
 *
 * `--branch-prefix` (default `agent/`) and `--trunk` (default `main`) make the
 * mission-branch join portable to other factories. Defaults are unchanged.
 *
 * Exit codes:
 *   0 ok · 1 unexpected error · 2 usage
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeSituacao, parseBacklogTables } from "./board-import-backlog.mjs";
import { deriveMissionState } from "./board-sync.mjs";
import { aggregate, readHistory } from "./history.mjs";
import { resolveProject } from "./lib/project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join("dist", "factory-board", "index.html");

// ─── Pure core ────────────────────────────────────────────────────────────────

/** Valid backlog id: a single letter A–D followed by one or more digits. */
const REQ_ID_RE = /^[A-D]\d+$/;

/**
 * Pull the canonical requirement list out of a brief.md body.
 *
 * Scans for the first line matching `**Requirements:** <value>` (tolerates a
 * leading blockquote `>` and any leading whitespace; the key is case-insensitive).
 * `<value>` grammar:
 *   - `none` (any case) → `[]` (mission explicitly declares no backlog row).
 *   - comma-separated backlog IDs (`A1`…`D3`); tokens that don't match
 *     `/^[A-D]\d+$/` after trim are silently skipped, never thrown.
 *
 * HARD RULE: this is the ONLY source of requirement↔mission mapping. Contract /
 * plan local IDs are NEVER scanned — that's the role-funcionario C1–C3 collision.
 *
 * @param {string} briefMarkdown — raw brief.md text (null/undefined → null).
 * @returns {string[] | null} — `null` when no Requirements line is present.
 */
export function parseRequirementsLine(briefMarkdown) {
  if (typeof briefMarkdown !== "string") return null;

  for (const line of briefMarkdown.split("\n")) {
    // Tolerate leading whitespace + an optional blockquote marker.
    const m = line.match(/^\s*>?\s*\*\*\s*requirements\s*:\s*\*\*\s*(.+?)\s*$/i);
    if (!m) continue;

    const value = m[1].trim();
    if (value.toLowerCase() === "none") return [];

    return value
      .split(",")
      .map((tok) => tok.trim())
      .filter((tok) => REQ_ID_RE.test(tok));
  }
  return null;
}

// ─── Git (effects, never throws) ──────────────────────────────────────────────

/**
 * Run git silently; on any failure (missing binary, not-a-repo, non-zero exit)
 * return `null` so callers can degrade to an empty branch list.
 */
function git(repoRoot, args) {
  try {
    const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    return r.stdout ?? "";
  } catch {
    return null;
  }
}

/**
 * Collect mission branches of `repoRoot` with their derived state.
 *
 *   - branches via `git branch --format='%(refname:short)'`;
 *   - only names starting with `branchPrefix` are kept (default `agent/`);
 *   - `slug` = name without the prefix;
 *   - `merged` = `git merge-base --is-ancestor <branch> <trunk>` exit 0
 *     (default trunk `main`);
 *   - `lastCommitISO` = `git log -1 --format=%cI <branch>` (or null).
 *
 * Missing git, not-a-repo, or no matching branches → `{ branches: [] }`. Never
 * throws — the model layer is read-only and total.
 *
 * The options object makes the join portable to other factories that use a
 * different branch prefix (e.g. `x/`) or a different trunk (e.g. `develop`).
 * Defaults (`agent/` + `main`) are unchanged — zero behavior change for wahub.
 *
 * @param {string} repoRoot
 * @param {{branchPrefix?: string, trunk?: string}} [opts]
 * @returns {{ branches: Array<{ name: string, slug: string, merged: boolean, lastCommitISO: string|null }> }}
 */
export function collectGitInfo(repoRoot, { branchPrefix = "agent/", trunk = "main" } = {}) {
  const prefix = branchPrefix || "agent/";
  const trunkRef = trunk || "main";
  const out = git(repoRoot, ["branch", "--format=%(refname:short)"]);
  if (out === null) return { branches: [] };

  const branches = [];
  for (const raw of out.split("\n")) {
    const name = raw.trim();
    if (!name.startsWith(prefix)) continue;

    const slug = name.slice(prefix.length);
    const merged =
      spawnSync("git", ["merge-base", "--is-ancestor", name, trunkRef], {
        cwd: repoRoot,
      }).status === 0;

    const iso = git(repoRoot, ["log", "-1", "--format=%cI", name]);
    branches.push({
      name,
      slug,
      merged,
      lastCommitISO: iso && iso.trim().length > 0 ? iso.trim() : null,
    });
  }
  return { branches };
}

// ─── Mission assembly ─────────────────────────────────────────────────────────

const FEATURE_RE = /^(\d+)\.md$/;
const HANDOFF_RE = /^(\d+)\.handoff\.md$/;

/** Read a file as utf8, or `null` if missing/unreadable. Never throws. */
function readMaybe(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Last well-formed verdict record in a JSONL `validate.log`, or null. Mirrors
 * `board-sync.mjs`'s private `lastVerdict` exactly: malformed lines are skipped,
 * and only records whose `verdict` is exactly `"PASS"` or `"FAIL"` count.
 * @param {string} missionDirPath
 * @returns {{ verdict: string, round: number } | null}
 */
function readLastVerdict(missionDirPath) {
  const logPath = path.join(missionDirPath, "validate.log");
  const text = readMaybe(logPath);
  if (text === null) return null;

  let last = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && (obj.verdict === "PASS" || obj.verdict === "FAIL")) {
      last = obj;
    }
  }
  if (!last) return null;
  return { verdict: last.verdict, round: last.round };
}

/** Counts of `features/NN.md` specs and `features/NN.handoff.md` handoffs. */
function countFeatures(missionDirPath) {
  const featuresDir = path.join(missionDirPath, "features");
  if (!existsSync(featuresDir)) return { features: 0, handoffs: 0 };
  let features = 0;
  let handoffs = 0;
  for (const name of readdirSync(featuresDir)) {
    if (FEATURE_RE.test(name)) features++;
    else if (HANDOFF_RE.test(name)) handoffs++;
  }
  return { features, handoffs };
}

/**
 * Assemble the traceability model from disk + an injected git snapshot.
 *
 * @param {{
 *   missionsDir: string,
 *   prdPath: string,
 *   gitInfo: { branches: Array<{ name: string, slug: string, merged: boolean, lastCommitISO: string|null }> },
 * }} args
 * @returns {{
 *   generatedAt: string,
 *   requirements: Array<{ id: string, recurso: string, risco: string, situacao: string, missionSlug: string|null, liveStatus: string }>,
 *   missions: Array<{ slug: string, status: string, gateReason: string|null, requirements: string[]|null, features: number, handoffs: number, lastVerdict: {verdict: string, round: number}|null, branch: {name: string, slug: string, merged: boolean, lastCommitISO: string|null}|null }>,
 *   orphanBranches: Array<{ name: string, slug: string, merged: boolean, lastCommitISO: string|null }>,
 * }}
 */
export function buildTraceabilityModel({ missionsDir, prdPath, gitInfo }) {
  const generatedAt = new Date().toISOString();
  const branches = gitInfo && Array.isArray(gitInfo.branches) ? gitInfo.branches : [];
  const branchBySlug = new Map();
  for (const b of branches) {
    if (b && typeof b.slug === "string") branchBySlug.set(b.slug, b);
  }

  // ── PRD rows (the canonical requirement catalog).
  const prdText = readMaybe(prdPath);
  const prdRows = prdText !== null ? parseBacklogTables(prdText) : [];

  // ── Mission dirs (read-only; tolerate missing dir).
  const missionSlugs = [];
  if (existsSync(missionsDir)) {
    for (const name of readdirSync(missionsDir)) {
      if (statSync(path.join(missionsDir, name)).isDirectory()) missionSlugs.push(name);
    }
  }
  missionSlugs.sort();

  // requirement.id → slug of the first mission whose brief declares it.
  const reqToMission = new Map();
  const missions = missionSlugs.map((slug) => {
    const dir = path.join(missionsDir, slug);
    const { status, gateReason } = deriveMissionState(dir);
    const briefText = readMaybe(path.join(dir, "brief.md"));
    const requirements = briefText !== null ? parseRequirementsLine(briefText) : null;
    if (requirements !== null) {
      for (const id of requirements) {
        if (!reqToMission.has(id)) reqToMission.set(id, slug);
      }
    }
    const { features, handoffs } = countFeatures(dir);
    const lastVerdict = readLastVerdict(dir);
    return {
      slug,
      status,
      gateReason,
      requirements,
      features,
      handoffs,
      lastVerdict,
      branch: branchBySlug.get(slug) ?? null,
    };
  });

  // ── Orphan branches: git branches whose slug has no mission dir.
  const missionSlugSet = new Set(missionSlugs);
  const orphanBranches = branches.filter((b) => b && !missionSlugSet.has(b.slug));

  // ── Requirements: PRD rows joined to the (at most one) mission claiming them.
  const requirements = prdRows.map((row) => {
    const missionSlug = reqToMission.get(row.id) ?? null;
    let liveStatus;
    if (missionSlug !== null) {
      const m = missions.find((x) => x.slug === missionSlug);
      liveStatus = m ? m.status : normalizeSituacao(row.situacao).status;
    } else {
      liveStatus = normalizeSituacao(row.situacao).status;
    }
    return {
      id: row.id,
      recurso: row.recurso,
      risco: row.risco,
      situacao: row.situacao,
      missionSlug,
      liveStatus,
    };
  });

  return { generatedAt, requirements, missions, orphanBranches };
}

// ─── HTML renderer (feature 02) ───────────────────────────────────────────────
//
// `renderDashboardHtml(model)` is a PURE function: model → self-contained HTML
// string. No disk, no network. The HTML is fully server-rendered; the only JS
// is tab switching + in-page anchor jumps for requirement→mission links.
//
// All interpolated text is escaped (`& < > " '`). The model is also embedded as
// `<script type="application/json" id="model">` for debugging — JSON `<` chars
// are rewritten to `\u003c` so a hostile string can never break out of the tag.

const STATUS_CLASS = {
  Done: "done",
  "Needs Human": "needs-human",
  Building: "building",
  Validating: "validating",
  Planning: "planning",
  Intake: "intake",
  Blocked: "blocked",
};

const LANE_ORDER = [
  "Needs Human",
  "Building",
  "Validating",
  "Planning",
  "Intake",
  "Done",
  "Blocked",
];

const BODIES = [
  { letter: "A", title: "Corpo A — Inbox" },
  { letter: "B", title: "Corpo B — Dashboard/CRM" },
  { letter: "C", title: "Corpo C — SDR/Bot" },
  { letter: "D", title: "Corpo D — Mineração" },
];

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
 * Render the minimal markdown the PRD `Recurso` column actually carries
 * (paired `bold`) into safe HTML — applied ONLY to `recurso`.
 *
 * Security ordering — escape FIRST, then markdown:
 *   1. `esc()` runs on the raw text, so any `<` `>` `&` `"` `'` from file
 *      content becomes entities before any tag is introduced;
 *   2. THEN the non-greedy paired-bold regex rewrites pairs in the
 *      already-escaped string to strong tags. The only HTML this can
 *      introduce are the literal strong open/close tokens we splice in —
 *      file content has no way to influence tag names or attributes
 *      (no XSS surface);
 *   3. Unpaired / odd-count bold markers are left untouched by the regex
 *      and stay as escaped text — never produces a dangling opener.
 *
 * Not applied to ids, slugs, status, or risk — those stay fully escaped.
 * @param {string} text
 * @returns {string}
 */
export function renderInline(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** Map a board status to a stable CSS class suffix (falls back to "intake"). */
function statusClass(status) {
  return STATUS_CLASS[status] ?? "intake";
}

/** Classify a raw PRD `Risco` cell into low/med/high/neutral. */
function riskClass(risco) {
  const r = String(risco ?? "").toLowerCase();
  if (r.includes("high")) return "risk-high";
  if (r.includes("med")) return "risk-med";
  if (r.includes("low")) return "risk-low";
  return "risk-neutral";
}

/** Format an ISO date as DD/MM (UTC, locale-independent). Empty string if unparseable. */
function formatDDMM(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

function renderStyles() {
  return `
:root {
  --bg: #fafafa;
  --fg: #1f2937;
  --muted: #6b7280;
  --border: #e5e7eb;
  --card-bg: #ffffff;
  --link: #2563eb;
  --status-done-bg: #dcfce7; --status-done-fg: #166534;
  --status-needs-human-bg: #fef3c7; --status-needs-human-fg: #92400e;
  --status-building-bg: #dbeafe; --status-building-fg: #1e40af;
  --status-validating-bg: #dbeafe; --status-validating-fg: #1e40af;
  --status-planning-bg: #f1f5f9; --status-planning-fg: #475569;
  --status-intake-bg: #f3f4f6; --status-intake-fg: #4b5563;
  --status-blocked-bg: #fee2e2; --status-blocked-fg: #991b1b;
  --risk-low-bg: #e0f2fe; --risk-low-fg: #075985;
  --risk-med-bg: #fef3c7; --risk-med-fg: #92400e;
  --risk-high-bg: #fee2e2; --risk-high-fg: #991b1b;
  --risk-neutral-bg: #f3f4f6; --risk-neutral-fg: #4b5563;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--fg);
  background: var(--bg);
  line-height: 1.5;
}
header.site { padding: 1.5rem 2rem 0; border-bottom: 1px solid var(--border); background: var(--card-bg); }
header.site h1 { margin: 0 0 1rem; font-size: 1.25rem; font-weight: 600; }
nav.tabs { display: flex; gap: 0.25rem; }
nav.tabs button {
  appearance: none;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  padding: 0.5rem 1rem;
  font: inherit;
  color: var(--muted);
  cursor: pointer;
  border-radius: 6px 6px 0 0;
}
nav.tabs button:hover { background: var(--bg); }
nav.tabs button[aria-selected="true"] {
  color: var(--fg);
  border-bottom-color: var(--link);
  font-weight: 600;
}
main { padding: 1.5rem 2rem 4rem; max-width: 1100px; margin: 0 auto; }
.tab-panel[hidden] { display: none; }
h2 { font-size: 1.05rem; font-weight: 600; margin: 1.5rem 0 0.5rem; }
h3 { font-size: 0.78rem; font-weight: 600; margin: 0 0 0.5rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-weight: 600; color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
td.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 9999px; font-size: 0.72rem; font-weight: 600; white-space: nowrap; }
.badge-status.done { background: var(--status-done-bg); color: var(--status-done-fg); }
.badge-status.needs-human { background: var(--status-needs-human-bg); color: var(--status-needs-human-fg); }
.badge-status.building { background: var(--status-building-bg); color: var(--status-building-fg); }
.badge-status.validating { background: var(--status-validating-bg); color: var(--status-validating-fg); }
.badge-status.planning { background: var(--status-planning-bg); color: var(--status-planning-fg); }
.badge-status.intake { background: var(--status-intake-bg); color: var(--status-intake-fg); }
.badge-status.blocked { background: var(--status-blocked-bg); color: var(--status-blocked-fg); }
.badge-risk.risk-low { background: var(--risk-low-bg); color: var(--risk-low-fg); }
.badge-risk.risk-med { background: var(--risk-med-bg); color: var(--risk-med-fg); }
.badge-risk.risk-high { background: var(--risk-high-bg); color: var(--risk-high-fg); }
.badge-risk.risk-neutral { background: var(--risk-neutral-bg); color: var(--risk-neutral-fg); }
.badge-gate { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
.muted { color: var(--muted); }
a.mission-link { color: var(--link); text-decoration: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
a.mission-link:hover { text-decoration: underline; }
.lanes { display: grid; gap: 1.5rem; }
.lane h3 { margin-bottom: 0.5rem; }
.mission-card { border: 1px solid var(--border); border-radius: 8px; background: var(--card-bg); padding: 0.75rem 1rem; margin-bottom: 0.5rem; }
.mission-card > summary { cursor: pointer; list-style: none; }
.mission-card > summary::-webkit-details-marker { display: none; }
.mission-card > summary::marker { content: ""; }
.card-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.card-slug { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92rem; }
.card-progress { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.82rem; }
.card-branch { color: var(--muted); font-size: 0.78rem; }
.card-chips { display: inline-flex; gap: 0.25rem; flex-wrap: wrap; }
.chip { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 4px; background: var(--bg); border: 1px solid var(--border); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.72rem; color: var(--muted); }
.drilldown { margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px dashed var(--border); font-size: 0.85rem; color: var(--muted); }
.drilldown p { margin: 0.25rem 0; }
.verdict-PASS { color: #166534; font-weight: 600; }
.verdict-FAIL { color: #991b1b; font-weight: 600; }
.orphans { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.orphans ul { margin: 0.5rem 0; padding-left: 1.25rem; }
.orphans li { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.25rem; }
footer.site { padding: 1rem 2rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.78rem; text-align: center; }
.stat-cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); margin-bottom: 2rem; }
.stat-card { border: 1px solid var(--border); border-radius: 8px; background: var(--card-bg); padding: 1rem 1.25rem; }
.stat-value { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--fg); }
.stat-label { font-size: 0.72rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 0.25rem; }
.stat-value.sem-dados { font-size: 0.95rem; font-weight: 500; color: var(--muted); }
`;
}

function renderScript() {
  return `
(function () {
  function activate(tab) {
    document.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
    });
    document.querySelectorAll('.tab-panel').forEach(function (panel) {
      panel.hidden = !panel.id.endsWith('-' + tab);
    });
  }
  document.querySelectorAll('[data-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () { activate(btn.dataset.tab); });
  });
  document.querySelectorAll('a[data-jump-to-mission]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      activate('missoes');
      var id = a.getAttribute('href').slice(1);
      var target = document.getElementById(id);
      if (target) {
        target.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  });
})();
`;
}

function renderRequirementsTable(rows) {
  const bodyHtml = rows
    .map((r) => {
      const missionCell = r.missionSlug
        ? `<a class="mission-link" href="#mission-${esc(r.missionSlug)}" data-jump-to-mission>${esc(r.missionSlug)}</a>`
        : `<span class="muted">sem missão</span>`;
      return `        <tr>
          <td class="id">${esc(r.id)}</td>
          <td>${renderInline(r.recurso)}</td>
          <td><span class="badge badge-risk ${riskClass(r.risco)}">${esc(r.risco || "—")}</span></td>
          <td><span class="badge badge-status ${statusClass(r.liveStatus)}">${esc(r.liveStatus || "—")}</span></td>
          <td>${missionCell}</td>
        </tr>`;
    })
    .join("\n");
  return `      <table>
        <thead><tr><th>ID</th><th>Recurso</th><th>Risco</th><th>Status vivo</th><th>Missão</th></tr></thead>
        <tbody>
${bodyHtml}
        </tbody>
      </table>`;
}

function renderRequirementsTab(reqs) {
  const sections = BODIES.map((body) => {
    const rows = reqs.filter((r) => String(r.id || "").startsWith(body.letter));
    if (rows.length === 0) return "";
    return `    <section class="body-section">
      <h2>${esc(body.title)}</h2>
${renderRequirementsTable(rows)}
    </section>`;
  })
    .filter((s) => s.length > 0)
    .join("\n");
  return `  <section id="tab-requisitos" class="tab-panel" role="tabpanel">
${sections || '    <p class="muted">Sem requisitos no PRD.</p>'}
  </section>`;
}

function renderMissionCard(m) {
  const chips = (Array.isArray(m.requirements) ? m.requirements : [])
    .map((id) => `<span class="chip">${esc(id)}</span>`)
    .join("");
  const gateBadge = m.gateReason
    ? `<span class="badge badge-gate">${esc(m.gateReason)}</span>`
    : "";
  const progress = `${m.handoffs ?? 0}/${m.features ?? 0}`;
  const branchHtml = m.branch
    ? `<span class="card-branch">${esc(m.branch.name)} · ${m.branch.merged ? "mergeado" : "não mergeado"}${m.branch.lastCommitISO ? ` · ${esc(formatDDMM(m.branch.lastCommitISO))}` : ""}</span>`
    : "";
  const chipsHtml = chips ? `<span class="card-chips">${chips}</span>` : "";
  const featuresLine = `<p>${m.features ?? 0} features, ${m.handoffs ?? 0} com handoff</p>`;
  const verdictLine = m.lastVerdict?.verdict
    ? `<p>Último veredicto: <span class="verdict-${esc(m.lastVerdict.verdict)}">${esc(m.lastVerdict.verdict)}</span> (rodada ${esc(m.lastVerdict.round)})</p>`
    : "";
  return `      <details class="mission-card" id="mission-${esc(m.slug)}">
        <summary>
          <div class="card-row">
            <span class="card-slug">${esc(m.slug)}</span>
            ${gateBadge}
            <span class="card-progress">${esc(progress)}</span>
            ${branchHtml}
            ${chipsHtml}
          </div>
        </summary>
        <div class="drilldown">
          ${featuresLine}
          ${verdictLine}
        </div>
      </details>`;
}

function renderMissionsTab(missions, orphans) {
  const lanesHtml = LANE_ORDER.map((status) => {
    const cards = missions.filter((m) => m.status === status);
    if (cards.length === 0) return "";
    const cardsHtml = cards.map(renderMissionCard).join("\n");
    return `    <div class="lane" data-status="${esc(status)}">
      <h3>${esc(status)}</h3>
${cardsHtml}
    </div>`;
  })
    .filter((s) => s.length > 0)
    .join("\n");

  const orphansHtml =
    orphans.length > 0
      ? `    <section class="orphans">
      <h2>branches sem missão</h2>
      <ul>
${orphans
  .map((b) => {
    const merged = b.merged ? "mergeado" : "não mergeado";
    const date = b.lastCommitISO ? ` · ${esc(formatDDMM(b.lastCommitISO))}` : "";
    return `        <li>${esc(b.name)} · ${merged}${date}</li>`;
  })
  .join("\n")}
      </ul>
    </section>`
      : "";

  return `  <section id="tab-missoes" class="tab-panel" role="tabpanel" hidden>
    <div class="lanes">
${lanesHtml || '    <p class="muted">Nenhuma missão.</p>'}
    </div>
${orphansHtml}
  </section>`;
}

/**
 * Format a nullable number for a stat card: 1 decimal place, or "sem dados".
 * @param {number|null|undefined} value
 * @param {string} [suffix] — optional unit suffix (e.g. " dias")
 * @returns {string}
 */
function fmtStat(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "sem dados";
  return `${Number(value.toFixed(1))}${suffix}`;
}

/**
 * Render the Histórico tab: stat cards + per-mission table, or "sem dados
 * ainda" when there is no history (contract A6, never crash). All values are
 * derived from history.jsonl + metrics.jsonl — deterministic, never wall-clock.
 *
 * The panel is wrapped in `<!--hist-start-->…<!--hist-end-->` markers so the
 * autopublish hash guard can strip it (history changes must NOT trigger
 * republish — the board republishes when the live model changes, not when
 * lagging-indicator snapshots are appended).
 *
 * @param {object|null|undefined} history — aggregate() output
 * @returns {string}
 */
function renderHistoryTab(history) {
  const h = history && typeof history === "object" ? history : null;
  const hasData = h && Array.isArray(h.perMission) && h.perMission.length > 0;

  if (!hasData) {
    return `<!--hist-start-->
  <section id="tab-historico" class="tab-panel" role="tabpanel" hidden>
    <p class="muted">sem dados ainda</p>
  </section>
<!--hist-end-->`;
  }

  const missõesConcluídas = h.missõesConcluídas ?? 0;
  const missõesPorSemana = fmtStat(h.missõesPorSemana);
  const leadTimeMediano = fmtStat(h.leadTimeMediano, " dias");
  const rondasMédia = fmtStat(h.rondasMédia);
  const tokensTotal =
    h.tokensTotal !== null && h.tokensTotal !== undefined ? String(h.tokensTotal) : "sem dados";
  const atençãoPorFeature = fmtStat(h.atençãoPorFeature);

  const tableBody = h.perMission
    .map((m) => {
      const leadTime = m.leadTime !== null ? fmtStat(m.leadTime, " dias") : "—";
      const verdict = m.últimoVerdict
        ? `<span class="verdict-${esc(m.últimoVerdict)}">${esc(m.últimoVerdict)}</span>`
        : "—";
      const data = m.data ? formatDDMM(m.data) : "—";
      return `        <tr>
          <td class="id">${esc(m.slug)}</td>
          <td><span class="badge badge-status ${statusClass(m.estadoAtual)}">${esc(m.estadoAtual || "—")}</span></td>
          <td>${esc(leadTime)}</td>
          <td>${esc(m.rondas)}</td>
          <td>${verdict}</td>
          <td>${esc(data)}</td>
        </tr>`;
    })
    .join("\n");

  return `<!--hist-start-->
  <section id="tab-historico" class="tab-panel" role="tabpanel" hidden>
    <div class="stat-cards">
      <div class="stat-card">
        <div class="stat-value">${esc(missõesConcluídas)}</div>
        <div class="stat-label">missões concluídas</div>
      </div>
      <div class="stat-card">
        <div class="stat-value${missõesPorSemana === "sem dados" ? " sem-dados" : ""}">${esc(missõesPorSemana)}</div>
        <div class="stat-label">missões/semana</div>
      </div>
      <div class="stat-card">
        <div class="stat-value${leadTimeMediano === "sem dados" ? " sem-dados" : ""}">${esc(leadTimeMediano)}</div>
        <div class="stat-label">lead time mediano</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${esc(rondasMédia)}</div>
        <div class="stat-label">rondas média</div>
      </div>
      <div class="stat-card">
        <div class="stat-value${tokensTotal === "sem dados" ? " sem-dados" : ""}">${esc(tokensTotal)}</div>
        <div class="stat-label">tokens</div>
      </div>
      <div class="stat-card">
        <div class="stat-value${atençãoPorFeature === "sem dados" ? " sem-dados" : ""}">${esc(atençãoPorFeature)}</div>
        <div class="stat-label">atenção-por-feature</div>
      </div>
    </div>
      <table>
        <thead><tr><th>Missão</th><th>Estado atual</th><th>Lead time</th><th>Rondas</th><th>Último verdict</th><th>Data</th></tr></thead>
        <tbody>
${tableBody}
        </tbody>
      </table>
  </section>
<!--hist-end-->`;
}

/**
 * Render the traceability model as a self-contained HTML document.
 *
 * ONE document: all CSS inline in a single `<style>`, all JS in a single inline
 * `<script>` (vanilla, zero external URLs). Portuguese UI. Server-side rendered
 * — works with JS disabled except for tab switching and requirement→mission jumps.
 *
 * @param {{ generatedAt?: string, requirements?: any[], missions?: any[], orphanBranches?: any[], history?: object|null }} model
 * @returns {string} — a complete HTML document.
 */
export function renderDashboardHtml(model) {
  const safe = model && typeof model === "object" ? model : {};
  const reqs = Array.isArray(safe.requirements) ? safe.requirements : [];
  const missions = Array.isArray(safe.missions) ? safe.missions : [];
  const orphans = Array.isArray(safe.orphanBranches) ? safe.orphanBranches : [];
  const generatedAt = safe.generatedAt ?? new Date().toISOString();
  const history = safe.history ?? null;

  // Embed the model for debugging. Rewrite `<` so a hostile payload can never
  // close the `<script>` tag early.
  const modelJson = JSON.stringify(
    { generatedAt, requirements: reqs, missions, orphanBranches: orphans },
    null,
    2,
  ).replace(/</g, "\\u003c");

  // History is embedded in a SEPARATE script tag so the autopublish hash guard
  // can strip it cleanly (history changes must not trigger republish).
  const historyJson = history ? JSON.stringify(history, null, 2).replace(/</g, "\\u003c") : "null";

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fábrica Nexus — rastreabilidade</title>
  <style>
${renderStyles()}
  </style>
</head>
<body>
  <header class="site">
    <h1>Fábrica Nexus — rastreabilidade</h1>
    <nav class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="requisitos" aria-selected="true">Requisitos</button>
      <button type="button" role="tab" data-tab="missoes" aria-selected="false">Missões</button>
      <button type="button" role="tab" data-tab="historico" aria-selected="false">Histórico</button>
    </nav>
  </header>
  <main>
${renderRequirementsTab(reqs)}
${renderMissionsTab(missions, orphans)}
${renderHistoryTab(history)}
  </main>
  <footer class="site">
    gerado em <time datetime="${esc(generatedAt)}">${esc(generatedAt)}</time> · board-report
  </footer>
  <script type="application/json" id="model">${modelJson}</script>
  <script type="application/json" id="history">${historyJson}</script>
  <script>
${renderScript()}
  </script>
</body>
</html>
`;
}

// ─── CLI (thin IO; the model + renderer are the reusable surface) ──────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/factory/board-report.mjs" +
      " [--missions <dir> | --missions-dir <dir>] [--prd <path>]" +
      " [--repo <root>] [--out <path>] [--branch-prefix <p>] [--trunk <branch>]" +
      " [--history <path>]\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let missions;
  let prd;
  let repo;
  let out;
  let branchPrefix;
  let trunk;
  let history;
  let project;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--missions" || args[i] === "--missions-dir") missions = args[++i];
    else if (args[i] === "--prd") prd = args[++i];
    else if (args[i] === "--repo") repo = args[++i];
    else if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--branch-prefix") branchPrefix = args[++i];
    else if (args[i] === "--trunk") trunk = args[++i];
    else if (args[i] === "--history") history = args[++i];
    else if (args[i] === "--project") project = args[++i];
    else positional.push(args[i]);
  }
  return { missions, prd, repo, out, branchPrefix, trunk, history, project, positional };
}

function main() {
  const { missions, prd, repo, out, branchPrefix, trunk, history, project, positional } = parseArgs(
    process.argv,
  );
  if (positional.length > 0) {
    usage();
    return 2;
  }
  const resolved = resolveProject({ project, dir: missions, repo });
  const missionsDir = resolved.missionsRoot;
  const prdPath = prd ? path.resolve(prd) : resolved.prdPath;
  const repoRoot = resolved.repoRoot;
  const outPath = out ? path.resolve(out) : path.resolve(DEFAULT_OUT);
  const historyPath = history
    ? path.resolve(history)
    : path.join(resolved.factoryRoot, "history.jsonl");

  if (!existsSync(prdPath)) {
    process.stderr.write(`board-report: PRD não encontrado: ${prdPath}\n`);
    return 1;
  }

  const gitOpts = {};
  if (branchPrefix !== undefined) gitOpts.branchPrefix = branchPrefix;
  if (trunk !== undefined) gitOpts.trunk = trunk;
  const gitInfo = collectGitInfo(repoRoot, gitOpts);
  const model = buildTraceabilityModel({ missionsDir, prdPath, gitInfo });

  // History aggregation (feature 04): read JSONL, aggregate stats, pass to
  // the renderer. Missing/empty/corrupt → null (Histórico tab shows "sem dados").
  const historyRows = readHistory(historyPath);
  model.history =
    historyRows.length > 0 ? aggregate(historyRows, { now: model.generatedAt, missionsDir }) : null;

  const html = renderDashboardHtml(model);

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  process.stdout.write(
    `board-report: ${model.requirements.length} requisitos, ${model.missions.length} missões -> ${outPath}\n`,
  );
  return 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }
}

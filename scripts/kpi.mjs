#!/usr/bin/env node
/**
 * kpi.mjs — the one honest table (plan-A F5).
 *
 * The expensive layer of the factory (the Opus coordinator + André's attention)
 * is the unmeasured one. This script prints, per project over a window, the four
 * numbers that decide whether the factory is worth it:
 *
 *   - missions merged   — from git (`--merges --since --grep <slug>`, joined to
 *                          the dossiers under `missions/<project>/`); the runner
 *                          is injected so tests are hermetic (B1).
 *   - seat tokens        — summed from each mission's `metrics.jsonl` via the
 *                          `seatTokens` helper exported by `mission-stats.mjs`
 *                          (worker + validator — the caged seats; the
 *                          coordinator is the separate cell below). SOURCE OF
 *                          TRUTH: metrics.jsonl, not stats.json (stats.json can
 *                          lag or be fail-open zero; metrics.jsonl is the live
 *                          instrument). (B2)
 *   - coordinator tokens — from `session-cost`'s pure core (the coordinator
 *                          emits no token events; its usage lives in the session
 *                          transcript). Imported, never shelled out. (B3)
 *   - attention-per-feature — (touchpoints + interventions + escalations) /
 *                          features, from `metrics.jsonl` events. The denominator
 *                          `features` is the merged-mission count — a merged
 *                          mission is a delivered feature, and it is the only
 *                          window-bounded feature count available (the dossier
 *                          `features/` writeups are not window-bounded). (B4)
 *
 * The E1-d law (B5) is binding: a cell whose input is MISSING renders `—`
 * (null), NEVER a zero-fill. Zero is a measurement; absence is absence. So a
 * project with no git, no metrics and no transcript renders an all-`—` row, and
 * a real zero (zero missions merged, zero attention events) renders `0`.
 *
 * Report-only: reads git + disk, writes nothing.
 *
 * Usage:
 *   node scripts/kpi.mjs [--project <id>] [--window <days>=30] [--json]
 *
 * Exit codes: 0 always (report-only) · 2 usage error.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/is-main.mjs";
import { FACTORY_ROOT, loadProjects, resolveProject } from "./lib/project.mjs";
import { seatTokens } from "./mission-stats.mjs";
import { readTranscriptDir, summarizeUsage, defaultTranscriptDir } from "./session-cost.mjs";

/** Event types that count toward the attention-per-feature KPI (metrics.mjs). */
const ATTENTION_TYPES = new Set(["touchpoint", "intervention", "escalation"]);

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── small pure helpers ──────────────────────────────────────────────────────

/**
 * Sum only the numeric values; return null when none are numbers (never a fake 0
 * — mirrors `spend.mjs` / `history.mjs`). Pure.
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function sumNonNull(values) {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (typeof v === "number") {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

/**
 * Keep only records whose `ts` is inside the `[sinceMs, ∞)` window. `sinceMs`
 * null/undefined → pass-through (no window). Records without a parseable `ts`
 * are dropped when a window is set (an unbounded sum would mis-attribute).
 * @param {Array<object>} records
 * @param {number|null|undefined} sinceMs
 * @returns {Array<object>}
 */
function windowedRecords(records, sinceMs) {
  const safe = Array.isArray(records) ? records : [];
  if (sinceMs == null) return safe;
  return safe.filter((r) => {
    const t = Date.parse(r && r.ts);
    return !Number.isNaN(t) && t >= sinceMs;
  });
}

/**
 * Read + parse a mission's `metrics.jsonl`. Tolerant of corrupt/partial lines
 * (per-line try/catch, skip — never throw, cf. `history.mjs readHistory`).
 * Missing file → []. @param {string} missionsRoot @param {string} slug
 * @returns {Array<object>}
 */
function readMetricsRecords(missionsRoot, slug) {
  const p = path.join(missionsRoot, slug, "metrics.jsonl");
  if (!existsSync(p)) return [];
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object") records.push(obj);
    } catch {
      // skip corrupt line
    }
  }
  return records;
}

/**
 * The mission dossier slugs under a missions root (subdirectories only, sorted).
 * Missing root → []. Pure over the directory listing.
 * @param {string} missionsRoot
 * @returns {string[]}
 */
export function listDossierSlugs(missionsRoot) {
  if (!missionsRoot || !existsSync(missionsRoot)) return [];
  let ents;
  try {
    ents = readdirSync(missionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

// ─── buildKpi (pure core) ────────────────────────────────────────────────────

/**
 * Assemble one project's KPI row from its (already windowed, already sourced)
 * inputs. Every cell passes through unchanged — a null input stays null (→ `—`
 * at render time); a real zero stays zero. `attentionPerFeature` is the only
 * derived value, and it is null whenever the numerator is absent OR the
 * denominator is absent/zero (you cannot divide absence, and 0 features makes
 * the ratio undefined — both render `—`).
 *
 * @param {{project: string, merged?: number|null, seatTokens?: number|null,
 *          coordinatorTokens?: number|null, attention?: number|null,
 *          features?: number|null}} inputs
 * @returns {{project: string, merged: number|null, seatTokens: number|null,
 *            coordinatorTokens: number|null, attention: number|null,
 *            features: number|null, attentionPerFeature: number|null}}
 */
export function buildKpi(inputs) {
  // A number passes through (0 is a real measurement); anything else is absence → null.
  // Never coerce to 0 — that is the exact bug the E1-d law forbids (B5).
  const num = (v) => (typeof v === "number" ? v : null);
  const merged = num(inputs.merged);
  const seatTokens = num(inputs.seatTokens);
  const coordinatorTokens = num(inputs.coordinatorTokens);
  const attention = num(inputs.attention);
  const features = num(inputs.features);
  const attentionPerFeature =
    attention !== null && features !== null && features > 0 ? attention / features : null;
  return { project: inputs.project, merged, seatTokens, coordinatorTokens, attention, features, attentionPerFeature };
}

// ─── sourcing (B1-B4) ────────────────────────────────────────────────────────

/** Run git in repoRoot; any failure → null. Injectable via `git` param (B1). */
function defaultGit(repoRoot, args) {
  try {
    const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    return r.stdout ?? "";
  } catch {
    return null;
  }
}

/**
 * Count missions merged into trunk within the window (B1). For each dossier slug
 * we ask git for a merge commit on trunk (`--merges`), bounded by `--since`,
 * whose message mentions the slug (`--grep`); the dossier join is what keeps
 * this to *this project's* missions. The git runner is injected so tests are
 * hermetic.
 *
 * Returns `null` when git/trunk is unavailable (absence → `—`), and a real
 * number (including 0) when git works — zero missions merged is a measurement.
 * @param {{repoRoot: string, missionsRoot: string,
 *          trunk?: string, sinceMs?: number|null, git?: function}} args
 * @returns {number|null}
 */
export function countMergedMissions({
  repoRoot,
  missionsRoot,
  trunk = "main",
  sinceMs = null,
  git = defaultGit,
}) {
  // The join is by slug, not by the branch ref: a `--grep <slug>` match finds PR
  // merges (subject carries `agent/<slug>`) AND message/squash merges (subject
  // carries the bare slug), so no branchPrefix is needed here.
  const slugs = listDossierSlugs(missionsRoot);
  // git/trunk unavailable → absence, not a fake 0.
  if (git(repoRoot, ["rev-parse", "--verify", "--quiet", trunk ?? "main"]) == null) return null;
  const sinceArgs = sinceMs != null ? [`--since=${new Date(sinceMs).toISOString()}`] : [];
  let count = 0;
  for (const slug of slugs) {
    const out = git(repoRoot, [
      "log",
      trunk ?? "main",
      "--merges",
      ...sinceArgs,
      "--grep",
      slug,
      "-n",
      "1",
      "--format=%H",
    ]);
    if (out && out.trim().length > 0) count++;
  }
  return count;
}

/**
 * A seat's measured token total over the window, or null when unmeasured (no
 * token-bearing phase_end — the E1-d fix: a phase_end with no token fields is
 * absence, not a zero). Reuses `mission-stats`' `seatTokens` on the windowed
 * records so the split (in/out/cache) is summed exactly as elsewhere.
 * @param {Array<object>} records (already windowed)
 * @param {string} seat
 * @returns {number|null}
 */
function measuredSeatTotal(records, seat) {
  const ends = records.filter((r) => r && r.seat === seat && r.type === "phase_end");
  const tokenBearing = ends.some(
    (r) =>
      typeof r.tokens === "number" ||
      typeof r.tokensIn === "number" ||
      typeof r.tokensOut === "number" ||
      typeof r.tokensCacheRead === "number" ||
      typeof r.tokensCacheWrite === "number",
  );
  if (!tokenBearing) return null;
  return seatTokens(records, seat).total;
}

/**
 * Sum worker + validator seat tokens across a project's missions (B2). SOURCE:
 * metrics.jsonl via `seatTokens` (live), not stats.json. A mission contributes
 * null when both seats are unmeasured; the project total is null only when every
 * mission is (absence → `—`).
 * @param {{missionsRoot: string, slugs?: string[], sinceMs?: number|null}} args
 * @returns {number|null}
 */
export function seatTokensForProject({ missionsRoot, slugs, sinceMs = null }) {
  const list = slugs ?? listDossierSlugs(missionsRoot);
  const contribs = [];
  for (const slug of list) {
    const wr = windowedRecords(readMetricsRecords(missionsRoot, slug), sinceMs);
    contribs.push(sumNonNull([measuredSeatTotal(wr, "worker"), measuredSeatTotal(wr, "validator")]));
  }
  return sumNonNull(contribs);
}

/**
 * Coordinator (Opus interactive session) token total over the window (B3). Read
 * from the factory's session transcript via `session-cost`'s pure core — no
 * shell-out. Null when no transcript is retained (absence → `—`).
 *
 * The coordinator session is factory-global (it runs in the factory repo, not
 * per-project); per-project attribution awaits the F4 session-tag join, which
 * is the coordinator's seat. v1 attributes the factory-wide coordinator total
 * to the window.
 * @param {{transcriptDir: string, sinceMs?: number|null, untilMs?: number|null}} args
 * @returns {number|null}
 */
export function coordinatorTokensForFactory({ transcriptDir, sinceMs = null, untilMs = null }) {
  const rows = readTranscriptDir(transcriptDir);
  const win = {};
  if (sinceMs != null) win.sinceMs = sinceMs;
  if (untilMs != null) win.untilMs = untilMs;
  const rep = summarizeUsage(rows, win);
  return rep.measured > 0 ? rep.totals.total : null;
}

/**
 * Sum touchpoint + intervention + escalation events across a project's missions
 * (B4 numerator). Returns null when no mission has any metrics record at all
 * (absence → `—`); returns a real 0 when the instrument exists but recorded no
 * attention events.
 * @param {{missionsRoot: string, slugs?: string[], sinceMs?: number|null}} args
 * @returns {number|null}
 */
export function attentionForProject({ missionsRoot, slugs, sinceMs = null }) {
  const list = slugs ?? listDossierSlugs(missionsRoot);
  let total = 0;
  let hasRecords = false;
  for (const slug of list) {
    const wr = windowedRecords(readMetricsRecords(missionsRoot, slug), sinceMs);
    if (wr.length > 0) hasRecords = true;
    for (const r of wr) {
      if (typeof r.type === "string" && ATTENTION_TYPES.has(r.type)) total++;
    }
  }
  return hasRecords ? total : null;
}

// ─── render ──────────────────────────────────────────────────────────────────

/** Format a cell: null/NaN → em-dash; integers as-is; floats rounded to 2dp. */
function fmtCell(n) {
  if (n === null || n === undefined) return "—";
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function pad(s, w, right) {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : right ? s.padStart(w) : s.padEnd(w);
}

const NUM_COLS = [
  ["MERGED", "merged", 8],
  ["SEAT-TOK", "seatTokens", 12],
  ["COORD-TOK", "coordinatorTokens", 12],
  ["ATTN", "attention", 8],
  ["ATTN/FEAT", "attentionPerFeature", 10],
];
const PROJECT_W = 16;

/**
 * Render the KPI report as a per-project table. Pure. `—` for every absent cell.
 * @param {{windowDays?: number, rows: Array<object>}} report
 * @returns {string}
 */
export function renderTable(report) {
  const lines = [];
  if (report.windowDays != null) lines.push(`◆ window: ${report.windowDays}d`);
  lines.push(
    [pad("PROJECT", PROJECT_W), ...NUM_COLS.map(([h, , w]) => pad(h, w, true))].join(" "),
  );
  for (const row of report.rows) {
    lines.push([pad(row.project, PROJECT_W), ...NUM_COLS.map(([, k, w]) => pad(fmtCell(row[k]), w, true))].join(" "));
  }
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write("Usage:\n  node scripts/kpi.mjs [--project <id>] [--window <days>=30] [--json]\n");
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { window: 30 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--project":
        opts.project = args[++i];
        break;
      case "--window":
        opts.window = Number(args[++i]);
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        usage();
        return { _bad: true };
    }
  }
  return opts;
}

/**
 * Build the report rows for one project: source the four inputs over the window
 * and fold them through `buildKpi`. `coordinatorDir` is factory-global (computed
 * once by the caller).
 */
function rowForProject({ id, missionsRoot, repoRoot, trunk, sinceMs, coordinatorDir, untilMs }) {
  const merged = countMergedMissions({ repoRoot, missionsRoot, trunk, sinceMs });
  return buildKpi({
    project: id,
    merged,
    seatTokens: seatTokensForProject({ missionsRoot, sinceMs }),
    coordinatorTokens: coordinatorTokensForFactory({ transcriptDir: coordinatorDir, sinceMs, untilMs }),
    attention: attentionForProject({ missionsRoot, sinceMs }),
    features: merged, // a merged mission is a delivered feature (B4 denominator)
  });
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts._bad) return 2;

  const days = Number.isFinite(opts.window) ? opts.window : 30;
  const untilMs = Date.now();
  const sinceMs = days > 0 ? untilMs - days * DAY_MS : null;

  const ids = opts.project
    ? [opts.project]
    : loadProjects(FACTORY_ROOT).map((p) => p.id);

  // The coordinator session runs in the factory repo → its transcript dir is
  // derived from the factory root. Factory-global; same dir for every project.
  const coordinatorDir = defaultTranscriptDir({ dir: null, cwd: FACTORY_ROOT });

  const rows = [];
  for (const id of ids) {
    const r = resolveProject({ project: id });
    rows.push(
      rowForProject({
        id: r.id,
        missionsRoot: r.missionsRoot,
        repoRoot: r.repoRoot,
        trunk: r.profile.trunk,
        sinceMs,
        untilMs,
        coordinatorDir,
      }),
    );
  }
  rows.sort((a, b) => String(a.project).localeCompare(String(b.project)));

  const report = { windowDays: days, rows };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(`${renderTable(report)}\n`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`kpi: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

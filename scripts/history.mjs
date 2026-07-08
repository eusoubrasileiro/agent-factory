#!/usr/bin/env node
/**
 * Factory board history — snapshot persistence + aggregation (feature 04).
 *
 * Three concerns, all pure-data or pure-IO:
 *   - snapshotRows(model, project, ts) — derive one snapshot row per mission
 *     in a traceability model (the shape board-report.mjs produces).
 *   - appendSnapshots(historyPath, rows) — JSONL append (mkdir -p parent).
 *   - readHistory(historyPath) — tolerant JSONL read: skip corrupt/partial
 *     lines, missing file → []. Never throws.
 *   - aggregate(rows, { now, missionsDir }) — per-project + global stats:
 *     missões concluídas, missões/semana, lead time mediano, rondas média,
 *     tokens (from metrics.jsonl), atenção-por-feature (standards §12.c KPI).
 *
 * Row shape is FIXED by plan.md:
 *   { ts, project, slug, state, features:"m/n", rounds, verdict, reqIds }
 * where features = handoffs/specs, rounds = max validate.log round, verdict =
 * last verdict or null, reqIds = the Requirements join from the brief.
 *
 * House style = `scripts/factory/board-sync.mjs`: pure exported core + thin IO
 * shell. This module is imported by `board-autopublish.mjs` (the publish
 * funnel) and `board-report.mjs` (the Histórico renderer).
 *
 * Determinism: `aggregate` accepts `{ now }` so tests pin the reference time.
 * All rendered values are derived from history.jsonl content + metrics.jsonl,
 * never from wall-clock `now` at render time (hash-guard stability).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Event types that count toward the attention-per-feature KPI. */
const ATTENTION_TYPES = new Set(["touchpoint", "intervention", "escalation"]);

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// ─── snapshotRows ─────────────────────────────────────────────────────────────

/**
 * Read + parse a mission's `stats.json` (mission-stats.mjs output). Missing or
 * corrupt → null. Never throws.
 * @param {string} missionsDir @param {string} slug
 * @returns {object|null}
 */
function readStats(missionsDir, slug) {
  const p = path.join(missionsDir, slug, "stats.json");
  if (!existsSync(p)) return null;
  try {
    const obj = JSON.parse(readFileSync(p, "utf8"));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Total wall-clock hours from a stats `durations` object (building+validating,
 * ms → h). Null when neither seat has a duration. Pure.
 * @param {{building?: number|null, validating?: number|null}|null|undefined} durations
 * @returns {number|null}
 */
function durationHours(durations) {
  if (!durations || typeof durations !== "object") return null;
  const parts = [durations.building, durations.validating].filter((v) => typeof v === "number");
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / (60 * 60 * 1000);
}

/**
 * Derive one snapshot row per mission in the model. Row shape is FIXED by
 * plan.md: `{ ts, project, slug, state, features:"m/n", rounds, verdict,
 * reqIds }`.
 *
 * When `missionsDir` is provided (factory-metrics W3, F4) each row is ENRICHED
 * with `loc`, `tokens` (total), `models`, and `durationH`, read from the
 * mission's `stats.json` (null when absent). These are lagging indicators — the
 * autopublish hash guard already strips the whole history payload, so appending
 * them never triggers a republish loop. When `missionsDir` is omitted the row
 * keeps its original shape exactly (back-compat).
 *
 * @param {{ missions?: Array }} model — traceability model (board-report shape)
 * @param {string} project — project id from the manifest
 * @param {string} ts — ISO timestamp for this snapshot batch
 * @param {string} [missionsDir] — when set, read each mission's stats.json
 * @returns {Array<object>}
 */
export function snapshotRows(model, project, ts, missionsDir) {
  const missions = model && Array.isArray(model.missions) ? model.missions : [];
  return missions.map((m) => {
    const base = {
      ts,
      project,
      slug: m.slug,
      state: m.status,
      features: `${m.handoffs ?? 0}/${m.features ?? 0}`,
      rounds: m.lastVerdict && Number.isInteger(m.lastVerdict.round) ? m.lastVerdict.round : 0,
      verdict: m.lastVerdict?.verdict ?? null,
      reqIds: Array.isArray(m.requirements) ? m.requirements : [],
    };
    if (!missionsDir) return base;
    const stats = readStats(missionsDir, m.slug);
    return {
      ...base,
      loc: stats?.loc ?? null,
      tokens: stats?.tokens?.total ?? null,
      models: stats?.models ?? null,
      durationH: stats ? durationHours(stats.durations) : null,
    };
  });
}

// ─── appendSnapshots ──────────────────────────────────────────────────────────

/**
 * Append snapshot rows to a JSONL file (mkdir -p parent). Pure IO — never
 * reads existing content, never dedups (the caller decides what to append).
 * Empty/null rows → no-op.
 *
 * @param {string} historyPath — absolute path to the JSONL file
 * @param {Array} rows — rows to append
 */
export function appendSnapshots(historyPath, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  mkdirSync(path.dirname(historyPath), { recursive: true });
  const block = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(historyPath, block);
}

// ─── readHistory ──────────────────────────────────────────────────────────────

/**
 * Read and parse a history JSONL file. Tolerant of corrupt/partial lines
 * (skip, never throw). Missing file → []. Each valid line must parse to an
 * object with a `slug` string; otherwise it is silently skipped.
 *
 * @param {string} historyPath
 * @returns {Array<object>}
 */
export function readHistory(historyPath) {
  if (!existsSync(historyPath)) return [];
  let text;
  try {
    text = readFileSync(historyPath, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && !Array.isArray(obj) && typeof obj.slug === "string") {
        rows.push(obj);
      }
    } catch {
      // skip corrupt line, never throw
    }
  }
  return rows;
}

// ─── aggregate ────────────────────────────────────────────────────────────────

/**
 * Median of a numeric array (null if empty). Pure.
 * @param {number[]} values
 * @returns {number|null}
 */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Read metrics.jsonl for a slug from a missions dir. Returns [] if missing or
 * corrupt. Never throws.
 * @param {string} missionsDir
 * @param {string} slug
 * @returns {Array<object>}
 */
function readMetrics(missionsDir, slug) {
  const p = path.join(missionsDir, slug, "metrics.jsonl");
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
      // skip
    }
  }
  return records;
}

/**
 * Parse the handoff count from a snapshot's `features` field ("m/n" → m).
 * @param {string} features
 * @returns {number}
 */
function handoffCount(features) {
  if (typeof features !== "string") return 0;
  const m = features.match(/^(\d+)\//);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Compute lead times (in days) for every slug that reached Done.
 * Lead time = first snapshot ts → first Done snapshot ts.
 * @param {Array} rows
 * @returns {Map<string, number>} slug → days
 */
function computeLeadTimes(rows) {
  const bySlug = new Map();
  for (const r of rows) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push(r);
  }
  const leadMap = new Map();
  for (const [slug, slugRows] of bySlug) {
    slugRows.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    const first = slugRows[0];
    const firstDone = slugRows.find((r) => r.state === "Done");
    if (first && firstDone && first.ts && firstDone.ts) {
      const ms = new Date(firstDone.ts).getTime() - new Date(first.ts).getTime();
      if (ms >= 0) leadMap.set(slug, ms / DAY_MS);
    }
  }
  return leadMap;
}

/**
 * Aggregate one scope of rows (either a project's or the global set) into
 * the stats card data. Returns all metrics needed by the Histórico tab.
 * @param {Array} rows
 * @param {string|undefined} missionsDir
 * @returns {object}
 */
function aggregateScope(rows, missionsDir) {
  const safe = Array.isArray(rows) ? rows : [];

  // Group by slug, sorted chronologically (handles duplicates gracefully).
  const bySlug = new Map();
  for (const r of safe) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push(r);
  }
  for (const slugRows of bySlug.values()) {
    slugRows.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }

  // missõesConcluídas: unique slugs with ≥1 Done snapshot.
  const doneSlugs = new Set();
  for (const [slug, slugRows] of bySlug) {
    if (slugRows.some((r) => r.state === "Done")) doneSlugs.add(slug);
  }
  const missõesConcluídas = doneSlugs.size;

  // missõesPorSemana: doneSlugs / max(1, weeks(first→last)).
  let missõesPorSemana = null;
  if (missõesConcluídas > 0 && safe.length > 0) {
    const times = safe.map((r) => new Date(r.ts).getTime()).filter((t) => !Number.isNaN(t));
    if (times.length > 0) {
      const span = Math.max(...times) - Math.min(...times);
      const weeks = Math.max(1, span / WEEK_MS);
      missõesPorSemana = missõesConcluídas / weeks;
    }
  }

  // leadTimeMediano: median of per-Done-slug lead times (days).
  const leadMap = computeLeadTimes(safe);
  const leadTimes = [...doneSlugs]
    .map((slug) => leadMap.get(slug))
    .filter((v) => typeof v === "number");
  const leadTimeMediano = median(leadTimes);

  // rondasMédia: mean of `rounds` across the latest snapshot of each slug.
  let rondasSum = 0;
  let rondasCount = 0;
  for (const slugRows of bySlug.values()) {
    const latest = slugRows[slugRows.length - 1];
    if (latest && typeof latest.rounds === "number") {
      rondasSum += latest.rounds;
      rondasCount++;
    }
  }
  const rondasMédia = rondasCount > 0 ? rondasSum / rondasCount : 0;

  // tokens + atenção from metrics.jsonl (only when missionsDir is provided).
  let tokensTotal = null;
  let atençãoPorFeature = null;
  if (missionsDir) {
    let totalTokens = 0;
    let hasTokenData = false;
    let totalAttention = 0;
    let hasMetrics = false;
    let totalHandoffs = 0;
    for (const [slug, slugRows] of bySlug) {
      const metrics = readMetrics(missionsDir, slug);
      if (metrics.length > 0) {
        hasMetrics = true;
        for (const m of metrics) {
          if (typeof m.tokens === "number") {
            totalTokens += m.tokens;
            hasTokenData = true;
          }
          if (typeof m.type === "string" && ATTENTION_TYPES.has(m.type)) {
            totalAttention++;
          }
        }
      }
      const latest = slugRows[slugRows.length - 1];
      totalHandoffs += handoffCount(latest?.features);
    }
    tokensTotal = hasTokenData ? totalTokens : null;
    atençãoPorFeature = hasMetrics && totalHandoffs > 0 ? totalAttention / totalHandoffs : null;
  }

  return {
    missõesConcluídas,
    missõesPorSemana,
    leadTimeMediano,
    rondasMédia,
    tokensTotal,
    atençãoPorFeature,
  };
}

/**
 * Aggregate history rows into per-project + global stats, plus a per-mission
 * table for the Histórico renderer.
 *
 * @param {Array<object>} rows — parsed history rows
 * @param {{ now?: string, missionsDir?: string }} [opts]
 *   - `now`: ISO reference timestamp (for test determinism; does not affect
 *     rendered values, which are derived from history.jsonl only).
 *   - `missionsDir`: when provided, reads each mission's metrics.jsonl for
 *     token totals and the attention-per-feature KPI.
 * @returns {{
 *   missõesConcluídas: number,
 *   missõesPorSemana: number|null,
 *   leadTimeMediano: number|null,
 *   rondasMédia: number,
 *   tokensTotal: number|null,
 *   atençãoPorFeature: number|null,
 *   byProject: Record<string, object>,
 *   perMission: Array<{ slug: string, project: string|null, estadoAtual: string|null, leadTime: number|null, rondas: number, últimoVerdict: string|null, data: string|null }>,
 * }}
 */
export function aggregate(rows, { now, missionsDir } = {}) {
  const safe = Array.isArray(rows) ? rows : [];
  void now; // accepted for test determinism; rendered values are history-derived

  // Group rows by project for per-project breakdown.
  const byProjectMap = new Map();
  for (const r of safe) {
    const proj = r.project ?? "_unknown";
    if (!byProjectMap.has(proj)) byProjectMap.set(proj, []);
    byProjectMap.get(proj).push(r);
  }

  const byProject = {};
  for (const [proj, projRows] of byProjectMap) {
    byProject[proj] = aggregateScope(projRows, missionsDir);
  }

  // Global aggregation across all rows.
  const global = aggregateScope(safe, missionsDir);

  // Per-mission table: latest snapshot per slug + lead time.
  const leadMap = computeLeadTimes(safe);
  const latestBySlug = new Map();
  for (const r of safe) {
    const prev = latestBySlug.get(r.slug);
    if (!prev || new Date(r.ts).getTime() >= new Date(prev.ts).getTime()) {
      latestBySlug.set(r.slug, r);
    }
  }
  const perMission = [...latestBySlug.values()]
    .map((r) => ({
      slug: r.slug,
      project: r.project ?? null,
      estadoAtual: r.state ?? null,
      leadTime: leadMap.has(r.slug) ? leadMap.get(r.slug) : null,
      rondas: typeof r.rounds === "number" ? r.rounds : 0,
      últimoVerdict: r.verdict ?? null,
      data: r.ts ?? null,
    }))
    .sort((a, b) => String(a.slug).localeCompare(String(b.slug)));

  return { ...global, byProject, perMission };
}

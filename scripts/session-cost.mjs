#!/usr/bin/env node
/**
 * session-cost.mjs — coordinator token accounting (plan-A F4, the missing numerator).
 *
 * The expensive layer of the factory is the one nobody measured: the Opus
 * coordinator (the interactive Claude Code session that plans + authors the
 * contract) and André's attention. This script instruments the token half. The
 * coordinator emits no token events of its own; its usage lives in the session
 * transcript under `~/.claude/projects/<encoded-cwd>/*.jsonl`, one JSON row per
 * turn, each `type:"assistant"` row carrying `message.usage`.
 *
 * What it does: read those transcripts, sum the per-message `usage` fields
 * grouped by **day × model** (input / output / cache_read / cache_creation /
 * total), and print a table (or `--json` machine form). Report-only — no
 * writes, no daemon, no watch mode (A5). A missing/empty transcript dir prints
 * `sem transcripts em <dir>` and exits 0: a report tool never crashes (A4).
 *
 * It reuses `encodeTranscriptDir` (from lib/transcript-tokens.mjs) to derive the
 * default transcript dir from the cwd, and a local tolerant row reader for the
 * day × model breakdown `loadTranscriptUsage` does not expose. Corrupt/partial
 * JSONL lines are skipped per-line, never thrown (A3, house style, cf.
 * `history.mjs readHistory`).
 *
 * Usage:
 *   node scripts/session-cost.mjs [--dir <transcriptDir>] [--since <ISO date>] [--json]
 *
 * Exit codes: 0 always (report-only) · 2 usage error.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isMainModule } from "./lib/is-main.mjs";
import { encodeTranscriptDir } from "./lib/transcript-tokens.mjs";

const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

// ─── Pure core ───────────────────────────────────────────────────────────────

/**
 * Sum per-message `usage` across `type:"assistant"` rows, grouped by
 * **day × model**. Claude's usage object folds reasoning into `output_tokens`,
 * so there is no separate reasoning tier here (the pricing layer bills it at the
 * output rate regardless). `total` is the sum of the four billable tiers.
 *
 * The `[sinceMs, untilMs]` window (both optional) bounds which rows count, by
 * `row.timestamp`. Rows without a parseable timestamp are dropped when a window
 * is set (an unbounded sum would risk attributing another session's usage).
 *
 * `measured` is the count of usage-bearing rows actually summed — the honest
 * "did we measure anything" flag the rollup needs so an empty transcript renders
 * absent (`—`), never a fake 0 (the E1-d lesson: a metric that can't be measured
 * must render as absent, not as 0).
 *
 * @param {Array<object>} rows — parsed transcript rows
 * @param {{sinceMs?: number, untilMs?: number}} [win]
 * @returns {{ groups: Array<{day: string, model: string, input: number, output: number, cache_read: number, cache_creation: number, total: number}>,
 *            totals: {input: number, output: number, cache_read: number, cache_creation: number, total: number},
 *            measured: number }}
 */
export function summarizeUsage(rows, win = {}) {
  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
  const groups = new Map();
  let measured = 0;
  if (!Array.isArray(rows)) return { groups: [], totals, measured };

  const useWindow = typeof win.sinceMs === "number" || typeof win.untilMs === "number";
  for (const row of rows) {
    if (!row || row.type !== "assistant") continue;
    const msg = row.message;
    const u = msg && typeof msg === "object" ? msg.usage : null;
    if (!u || typeof u !== "object") continue;

    if (useWindow) {
      const ts = Date.parse(row.timestamp ?? "");
      if (Number.isNaN(ts)) continue;
      if (typeof win.sinceMs === "number" && ts < win.sinceMs) continue;
      if (typeof win.untilMs === "number" && ts > win.untilMs) continue;
    }

    const input = Number(u.input_tokens || 0);
    const output = Number(u.output_tokens || 0);
    const cacheRead = Number(u.cache_read_input_tokens || 0);
    const cacheCreation = Number(u.cache_creation_input_tokens || 0);
    const total = input + output + cacheRead + cacheCreation;

    const day = parseDay(row.timestamp);
    const model = typeof msg.model === "string" && msg.model.length > 0 ? msg.model : "unknown";
    const key = `${day}|${model}`;
    let g = groups.get(key);
    if (!g) {
      g = { day, model, input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
      groups.set(key, g);
    }
    g.input += input;
    g.output += output;
    g.cache_read += cacheRead;
    g.cache_creation += cacheCreation;
    g.total += total;

    totals.input += input;
    totals.output += output;
    totals.cache_read += cacheRead;
    totals.cache_creation += cacheCreation;
    totals.total += total;
    measured++;
  }

  const groupList = [...groups.values()].sort((a, b) =>
    a.day === b.day ? String(a.model).localeCompare(String(b.model)) : a.day.localeCompare(b.day),
  );
  return { groups: groupList, totals, measured };
}

/**
 * The YYYY-MM-DD day of an ISO timestamp, or `"unknown"` when absent/unparseable
 * (a row without a day can't be windowed, but still attributes to its model).
 * @param {string|undefined} ts
 * @returns {string}
 */
function parseDay(ts) {
  if (typeof ts !== "string") return "unknown";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "unknown";
  return new Date(t).toISOString().slice(0, 10);
}

// ─── I/O (effects, never throws) ─────────────────────────────────────────────

/**
 * Read every `*.jsonl` transcript in `dir` into a flat list of parsed rows.
 * Tolerant of corrupt/partial lines (per-line try/catch, skip — never throw, cf.
 * `history.mjs readHistory`). Missing dir → []. Non-`.jsonl` files are ignored.
 * @param {string} dir
 * @returns {Array<object>}
 */
export function readTranscriptDir(dir) {
  if (!dir || !existsSync(dir)) return [];
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const rows = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t.length === 0) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === "object") rows.push(obj);
      } catch {
        // skip corrupt/partial line — never throw (A3)
      }
    }
  }
  return rows;
}

/**
 * Resolve the transcript dir: an explicit `--dir` wins; otherwise derive it from
 * the cwd via `encodeTranscriptDir` under the projects root (`A1`). Pure — takes
 * the projects root so tests don't touch the real home dir.
 * @param {{dir?: string|null, cwd: string, projectsRoot?: string}} args
 * @returns {string}
 */
export function defaultTranscriptDir({ dir, cwd, projectsRoot = DEFAULT_PROJECTS_ROOT }) {
  if (dir) return dir;
  return path.join(projectsRoot, encodeTranscriptDir(cwd));
}

// ─── Render ──────────────────────────────────────────────────────────────────

const COLS = [
  ["DAY", "day", 12, false],
  ["MODEL", "model", 24, false],
  ["INPUT", "input", 12, true],
  ["OUTPUT", "output", 12, true],
  ["CACHE_R", "cache_read", 12, true],
  ["CACHE_W", "cache_creation", 12, true],
  ["TOTAL", "total", 12, true],
];

function pad(s, w, right) {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : right ? s.padStart(w) : s.padEnd(w);
}

/**
 * Render a usage report as a day × model table with a TOTAL row. Pure.
 * @param {{groups: Array, totals: object, measured: number}} rep
 * @param {{dir?: string}} [meta]
 * @returns {string}
 */
export function renderTable(rep, meta = {}) {
  const lines = [];
  if (meta.dir) lines.push(`◆ ${meta.dir}  (${rep.measured} message(s))`);
  lines.push(COLS.map(([h, , w, r]) => pad(h, w, r)).join(" "));
  for (const g of rep.groups) {
    lines.push(COLS.map(([, k, w, r]) => pad(g[k], w, r)).join(" "));
  }
  lines.push("  " + "─".repeat(COLS.reduce((a, [, , w]) => a + w + 1, 0)));
  const t = rep.totals;
  lines.push(
    [
      pad("TOTAL", COLS[0][2]),
      pad("", COLS[1][2]),
      pad(t.input, COLS[2][2], true),
      pad(t.output, COLS[3][2], true),
      pad(t.cache_read, COLS[4][2], true),
      pad(t.cache_creation, COLS[5][2], true),
      pad(t.total, COLS[6][2], true),
    ].join(" "),
  );
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/session-cost.mjs [--dir <transcriptDir>] [--since <ISO date>] [--json]\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dir":
        opts.dir = args[++i];
        break;
      case "--since":
        opts.since = args[++i];
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

function main() {
  const opts = parseArgs(process.argv);
  if (opts._bad) return 2;

  const dir = defaultTranscriptDir({ dir: opts.dir, cwd: process.cwd() });
  const rows = readTranscriptDir(dir);
  // A4: a missing/empty (or all-corrupt) transcript dir is reported, never crashed.
  if (rows.length === 0) {
    process.stdout.write(`sem transcripts em ${dir}\n`);
    return 0;
  }

  const sinceMs = opts.since ? Date.parse(opts.since) : undefined;
  if (opts.since && Number.isNaN(sinceMs)) {
    process.stderr.write(`session-cost: invalid --since date: ${opts.since}\n`);
    return 2;
  }
  const rep = summarizeUsage(rows, sinceMs !== undefined ? { sinceMs } : {});

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ dir, sinceMs: sinceMs ?? null, ...rep })}\n`);
  } else {
    process.stdout.write(`${renderTable(rep, { dir })}\n`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    // Report-only contract: surface the error, but a report must never crash hard.
    process.stderr.write(`session-cost: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

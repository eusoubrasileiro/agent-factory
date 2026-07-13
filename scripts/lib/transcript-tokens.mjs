/**
 * Orchestrator transcript attribution (factory-cost Stage 2).
 *
 * The orchestrator (the interactive Claude Code session that plans + authors the
 * contract) emits `phase_start`/`phase_end` events per mission, but no token
 * usage — it is the factory's invisible burner. Its usage lives in the session
 * transcript under `~/.claude/projects/<encoded-cwd>/*.jsonl`, one JSON row per
 * turn, each `type:"assistant"` row carrying `message.usage`. We attribute it to
 * a mission by summing the rows whose `timestamp` falls inside the mission's
 * orchestrator phase window.
 *
 * Pure core (`transcriptUsage`) + best-effort discovery (`loadTranscriptUsage`).
 * Missing dir / unreadable rows → zeros; telemetry must never block a mission.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * Sum `message.usage` across `type:"assistant"` rows, optionally restricted to a
 * `[sinceMs, untilMs]` time window. Returns the same shape as mission-stats'
 * `seatTokens`, so it drops straight into the orchestrator bucket.
 *
 * Claude's usage object folds reasoning into `output_tokens`, so `reasoning`
 * stays null here (the pricing layer bills it at the output rate regardless).
 *
 * @param {Array<object>} rows — parsed transcript rows
 * @param {{sinceMs?: number, untilMs?: number}} [win]
 * @returns {{in:number, out:number, reasoning:null, cacheRead:number, cacheWrite:number, total:number, model:string|null}}
 */
export function transcriptUsage(rows, win = {}) {
  const out = { in: 0, out: 0, reasoning: null, cacheRead: 0, cacheWrite: 0, total: 0, model: null };
  if (!Array.isArray(rows)) return out;
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
    out.in += Number(u.input_tokens || 0);
    out.out += Number(u.output_tokens || 0);
    out.cacheRead += Number(u.cache_read_input_tokens || 0);
    out.cacheWrite += Number(u.cache_creation_input_tokens || 0);
    if (typeof msg.model === "string" && msg.model.length > 0) out.model = msg.model;
  }
  out.total = out.in + out.out + out.cacheRead + out.cacheWrite;
  return out;
}

/**
 * Encode a cwd the way Claude Code names its transcript dirs: every `/` and `.`
 * becomes `-` (so `/home/.../factory` → `-home-...-factory`).
 * @param {string} cwd
 * @returns {string}
 */
export function encodeTranscriptDir(cwd) {
  return String(cwd).replace(/[/.]/g, "-");
}

/**
 * Read every `*.jsonl` transcript in `dir`, sum usage within the window across
 * all of them, and return the aggregate. Missing dir / corrupt lines → zeros.
 * @param {string} dir
 * @param {{sinceMs?: number, untilMs?: number}} [win]
 * @returns {{in:number, out:number, reasoning:null, cacheRead:number, cacheWrite:number, total:number, model:string|null}}
 */
export function loadTranscriptUsage(dir, win = {}) {
  const zero = { in: 0, out: 0, reasoning: null, cacheRead: 0, cacheWrite: 0, total: 0, model: null };
  if (!dir || !existsSync(dir)) return zero;
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return zero;
  }
  const acc = { ...zero };
  for (const f of files) {
    let text;
    try {
      text = readFileSync(`${dir}/${f}`, "utf8");
    } catch {
      continue;
    }
    const rows = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        // skip corrupt line
      }
    }
    const u = transcriptUsage(rows, win);
    acc.in += u.in;
    acc.out += u.out;
    acc.cacheRead += u.cacheRead;
    acc.cacheWrite += u.cacheWrite;
    acc.total += u.total;
    if (u.model) acc.model = u.model;
  }
  return acc;
}

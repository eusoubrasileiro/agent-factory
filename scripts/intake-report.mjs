#!/usr/bin/env node
/**
 * Intake model — requirement capture logs, parsed into the board's shape.
 *
 * A client-facing `requirements-intake.md` is an append-only markdown table
 * (one `| ID | date · source | type | gist | status | landed-in |` row per
 * requirement) optionally followed by a `# Detalhamento técnico` section whose
 * `### <ID> — …` blocks carry the code-verified expansion of a build-worthy row.
 *
 * This module is the ONLY reader of that shape. It is PURE (string → object) plus
 * one thin IO helper; nothing here writes, renders, or knows which product it is
 * looking at — the source files are declared per project in
 * `projects/<id>/project.json` (`intake[]`), never here (D-15).
 *
 * Two parsing facts are load-bearing and easy to get wrong:
 *
 *   1. **Cells may contain an escaped pipe** (`\|`). Splitting on a bare `|` — as
 *      `board-import-backlog.mjs` legitimately does for the PRD, which has no
 *      escapes — shears such a row into 7 columns and drops it. We split on
 *      `(?<!\\)\|` and unescape afterwards.
 *   2. **A Detalhamento block may be shared** by two ids (`### IN-35 + IN-40`).
 *      It then belongs to both, and deleting either row must NOT take the block
 *      with it — the surviving id still needs it. `detailBlockSpan` therefore
 *      returns a span only for a block owned by exactly one id.
 *
 * Ported from a per-client Python viewer (retired 2026-07-09), whose roundtrip
 * behaviour these functions reproduce.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Lifecycle of an intake row, in order. */
export const STATUSES = ["New", "Distilled", "Ratified", "Landed"];

/** Classification of an intake row. */
export const TYPES = ["feature", "bug", "spec-change", "vision", "business-decision"];

/** `| IN-31 | …` — the id cell of a table row. */
const ID_RE = /^\|\s*([A-Z]+-\d+)\s*\|/;
/** First ISO date inside the `Data · Fonte` cell. */
const DATE_RE = /(\d{4}-\d{2}-\d{2})/;
/** Split on pipes that are NOT escaped as `\|`. */
const SPLIT_RE = /(?<!\\)\|/;
/** `# Detalhamento técnico` (or `##`) opens the expanded technical part. */
const DETAIL_SECTION_RE = /^#{1,2}\s+Detalhamento t[ée]cnico/i;
/** `### <heading>` — one technical block. */
const H3_RE = /^###\s+(.*)$/;
/** Any heading up to `###` — closes an open block. */
const ANY_H_RE = /^#{1,3}\s/;
/** Any requirement id, anywhere (headings cite one or two). */
const ANY_ID_RE = /\b[A-Z]+-\d+\b/g;

/**
 * A citation as prose actually writes it: `IN-31`, `IN-33/35/38/40a`, `IN-35b/40b`.
 * Group 1 = prefix, 2 = head number (maybe suffixed), 3 = the `/…` run.
 */
const CITE_RE = /\b([A-Z]+)-(\d+[a-z]?)((?:\/\d+[a-z]?)*)\b/g;

/** The 6 columns an intake table row must have. */
const COLUMNS = 6;

/** Every `IN-31`-shaped token in a string, in order, deduplicated. */
function idsIn(text) {
  return [...new Set(String(text ?? "").match(ANY_ID_RE) ?? [])];
}

/**
 * Every intake id CITED by a piece of prose, expanded and normalized.
 *
 * The backlog's `Porquê / fonte` column does not spell citations out. It writes
 * `IN-33/35/38/40a` — one prefix, then bare numbers — and it suffixes a letter
 * when a single intake row split into sub-parts (`IN-40a` / `IN-40b`). A plain
 * `\bIN-\d+\b` scan sees only `IN-33` and silently loses three quarters of the
 * chain. So: expand the run against the leading prefix, then drop the sub-part
 * letter, because `IN-40a` and `IN-40b` are both the row `IN-40`.
 *
 * @param {string} text
 * @returns {string[]} normalized ids, in order of appearance, deduplicated.
 */
export function citedIds(text) {
  const out = new Set();
  for (const [, prefix, head, run] of String(text ?? "").matchAll(CITE_RE)) {
    const strip = (n) => n.replace(/[a-z]$/, ""); // IN-40a and IN-40b are both IN-40
    out.add(`${prefix}-${strip(head)}`);
    for (const part of run.split("/").filter(Boolean)) out.add(`${prefix}-${strip(part)}`);
  }
  return [...out];
}

/**
 * Split one intake table row into its 6 unescaped cells, or `null` when the line
 * is not such a row (wrong delimiters, wrong column count, separator row).
 * @param {string} line
 * @returns {string[] | null}
 */
export function splitCells(line) {
  const trimmed = String(line ?? "").replace(/\n$/, "").trimEnd();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const parts = trimmed.split(SPLIT_RE).slice(1, -1);
  if (parts.length !== COLUMNS) return null;
  return parts.map((p) => p.trim().replaceAll("\\|", "|"));
}

/**
 * The requirement id of a table row, or `null`.
 * @param {string} line
 * @returns {string | null}
 */
export function rowId(line) {
  const m = String(line ?? "").replace(/\n$/, "").match(ID_RE);
  return m ? m[1].trim() : null;
}

/**
 * Every `### <ID> …` block under the `# Detalhamento técnico` section, keyed by
 * each id it names. A block naming two ids is reachable under both, and both
 * copies carry `shared: true`.
 *
 * A heading with no id opens nothing; any other heading closes the open block.
 * Never throws — a file with no Detalhamento section yields `{}`.
 *
 * @param {string} text
 * @returns {Record<string, {title: string, body: string, shared: boolean}>}
 */
export function parseDetails(text) {
  /** @type {Map<string, {title: string, ids: string[], lines: string[]}>} */
  const byId = new Map();
  let inSection = false;
  let cur = null;

  for (const line of String(text ?? "").split("\n")) {
    if (DETAIL_SECTION_RE.test(line)) {
      inSection = true;
      cur = null;
      continue;
    }
    if (!inSection) continue;

    const h3 = line.match(H3_RE);
    if (h3) {
      const title = h3[1].trim();
      const ids = idsIn(title);
      cur = ids.length > 0 ? { title, ids, lines: [] } : null;
      if (cur) for (const id of ids) byId.set(id, cur);
      continue;
    }
    if (ANY_H_RE.test(line)) {
      cur = null; // any other heading closes the block
      continue;
    }
    if (cur) cur.lines.push(line);
  }

  /** @type {Record<string, {title: string, body: string, shared: boolean}>} */
  const out = {};
  for (const [id, blk] of byId) {
    // Trim the block, then shed a trailing `---` rule, then trim again.
    const body = blk.lines.join("\n").trim().replace(/^-+|-+$/g, "").trim();
    out[id] = { title: blk.title, body, shared: blk.ids.length > 1 };
  }
  return out;
}

/**
 * The `[start, end)` line span of `id`'s technical block, or `null`.
 *
 * Returns a span ONLY when the block is owned by exactly this id. A block shared
 * with another id (`### IN-35 + IN-40`) yields `null`, because removing it would
 * silently strip the surviving id's detail.
 *
 * @param {string[]} lines — the file, split on `\n`, WITHOUT trailing newlines.
 * @param {string} id
 * @returns {[number, number] | null}
 */
export function detailBlockSpan(lines, id) {
  let inSection = false;
  let start = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (DETAIL_SECTION_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (start !== null && ANY_H_RE.test(line)) return [start, i];

    const h3 = line.match(H3_RE);
    if (h3 && start === null) {
      const ids = idsIn(h3[1]);
      if (ids.length === 1 && ids[0] === id) start = i; // unshared block only
    }
  }
  return start !== null ? [start, lines.length] : null;
}

/**
 * Parse one intake file into its rows (newest first) with their detail blocks
 * attached. `prefix` filters to that project's own id sequence (`IN`, `CIDS`, …);
 * omit it to take every row.
 *
 * Sorting: by ISO date desc, then by the trailing number of the id desc — a row
 * with no parseable date sorts last (`0000-00-00`), never crashes.
 *
 * @param {string} text
 * @param {{prefix?: string, project?: string}} [opts]
 * @returns {{rows: Array<object>, details: Record<string, object>}}
 */
export function parseIntake(text, { prefix, project = "" } = {}) {
  const details = parseDetails(text);
  const rows = [];

  for (const line of String(text ?? "").split("\n")) {
    const cells = splitCells(line);
    if (!cells) continue;
    const [id, dateSource, type, summary, status, landedIn] = cells;
    if (!ID_RE.test(line.trimEnd())) continue; // separator / header rows
    if (prefix && !id.startsWith(`${prefix}-`)) continue;

    const det = details[id] ?? null;
    const dm = dateSource.match(DATE_RE);
    rows.push({
      id,
      project,
      date: dm ? dm[1] : "0000-00-00",
      dateSource,
      type,
      summary,
      status,
      landedIn,
      detailTitle: det ? det.title : "",
      detail: det ? det.body : "",
      detailShared: Boolean(det && det.shared),
    });
  }

  const seq = (id) => Number((id.match(/(\d+)$/) ?? [0, 0])[1]);
  rows.sort((a, b) => (a.date === b.date ? seq(b.id) - seq(a.id) : a.date < b.date ? 1 : -1));

  return { rows, details };
}

/**
 * Rewrite one row's cells in place. Pure: markdown in, markdown out.
 *
 * `fields` carries UNESCAPED values; pipes are re-escaped and newlines flattened
 * on the way in, so a summary containing `a | b` roundtrips. Absent keys keep the
 * row's current value.
 *
 * @param {string} text
 * @param {string} id
 * @param {{dateSource?: string, type?: string, summary?: string, status?: string, landedIn?: string}} fields
 * @returns {string}
 * @throws {Error} when `id` has no row in `text` — a silent no-op would look like a save.
 */
export function writeRow(text, id, fields = {}) {
  const lines = String(text ?? "").split("\n");
  let found = false;

  const escape = (cell) =>
    String(cell ?? "")
      .replaceAll("\\|", "|")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ")
      .trim();

  const out = lines.map((line) => {
    const cur = splitCells(line);
    if (!cur || cur[0] !== id) return line;
    found = true;
    const next = [
      id,
      fields.dateSource ?? cur[1],
      fields.type ?? cur[2],
      fields.summary ?? cur[3],
      fields.status ?? cur[4],
      fields.landedIn ?? cur[5],
    ].map(escape);
    return `| ${next.join(" | ")} |`;
  });

  if (!found) throw new Error(`${id} não encontrado`);
  return out.join("\n");
}

/**
 * Drop one row, and its technical block when that block is exclusively its own.
 * A block shared with a surviving id is left untouched.
 *
 * @param {string} text
 * @param {string} id
 * @returns {string}
 * @throws {Error} when `id` has no row in `text`.
 */
export function deleteRow(text, id) {
  const lines = String(text ?? "").split("\n");
  const span = detailBlockSpan(lines, id);
  const drop = new Set();
  if (span) for (let i = span[0]; i < span[1]; i++) drop.add(i);

  let found = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) continue;
    const cur = splitCells(lines[i]);
    if (cur && cur[0] === id) {
      found = true;
      continue;
    }
    out.push(lines[i]);
  }

  if (!found) throw new Error(`${id} não encontrado`);
  return out.join("\n");
}

/**
 * Which backlog rows cite which intake id.
 *
 * The citation lives in the PRD's free-text `Porquê / fonte` column — the intake
 * id is prose there, which is exactly why nothing read it before. An id cited by
 * no row maps to `[]`, and the renderer says "não despachado" rather than
 * pretending the requirement does not exist.
 *
 * Citations are read with `citedIds`, so a compressed run (`IN-33/35/38/40a`)
 * yields all four rows and a sub-part suffix collapses onto its row.
 *
 * @param {Array<{id: string, porque: string}>} prdRows — from `parseBacklogTables`.
 * @param {string[]} intakeIds
 * @returns {Record<string, string[]>} intake id → backlog ids, in PRD order.
 */
export function buildChain(prdRows, intakeIds) {
  const known = new Set(intakeIds);
  /** @type {Record<string, string[]>} */
  const chain = {};
  for (const id of intakeIds) chain[id] = [];

  for (const row of prdRows ?? []) {
    for (const cited of citedIds(row.porque)) {
      if (known.has(cited) && !chain[cited].includes(row.id)) chain[cited].push(row.id);
    }
  }
  return chain;
}

/**
 * Read every declared intake source. Thin IO: a missing or unreadable file is
 * skipped, never thrown — the board must render with or without the clients repo
 * checked out.
 *
 * @param {Array<{file: string, prefix?: string, label?: string}>} sources — `file` absolute.
 * @returns {{rows: Array<object>, sources: Array<{label: string, file: string, rows: number}>}}
 */
export function readIntake(sources) {
  const rows = [];
  const seen = [];

  for (const src of sources ?? []) {
    if (!src || typeof src.file !== "string" || !existsSync(src.file)) continue;
    let text;
    try {
      text = readFileSync(src.file, "utf8");
    } catch {
      continue;
    }
    const label = src.label || path.basename(src.file);
    const parsed = parseIntake(text, { prefix: src.prefix, project: label });
    rows.push(...parsed.rows);
    seen.push({ label, file: src.file, rows: parsed.rows.length });
  }

  const seq = (id) => Number((id.match(/(\d+)$/) ?? [0, 0])[1]);
  rows.sort((a, b) => (a.date === b.date ? seq(b.id) - seq(a.id) : a.date < b.date ? 1 : -1));

  return { rows, sources: seen };
}

#!/usr/bin/env node
/**
 * Mission stats collector (factory-metrics W3, F3).
 *
 * Computes every per-mission number Andre asked for DETERMINISTICALLY from
 * disk + git — no model judgment. Writes `missions/<project>/<slug>/stats.json`:
 *
 *   { slug, generatedAt, branch, mergeBase,
 *     loc: { added, deleted, files }, testsAdded, baselineChanged,
 *     baselineKeysChanged: [], durations: { building, validating },
 *     tokens: { worker: {in,out,reasoning,total}, validator: {...}, total },
 *     models: { worker, validator }, rounds, attention, pr }
 *
 * `loc` comes from `git -C <repoRoot> diff --numstat <mergeBase>..<branch>`,
 * EXCLUDING pnpm-lock.yaml + factory/dossier paths. When the `agent/<slug>`
 * branch is already merged+deleted (ratify-time recollect) it falls back to the
 * merge commit found by `git log --merges --grep <slug>` and diffs its parents.
 *
 * IDEMPOTENT + TOTAL: any missing input (no git, no branch, no metrics.jsonl)
 * yields a stats.json full of zeros/nulls and exits 0. Wired soft-fail into
 * verdict.mjs (after each verdict) and ratify.mjs.
 *
 * Usage:
 *   node scripts/mission-stats.mjs collect <slug> [--project <id>]
 *     [--branch agent/<slug>] [--dir <missions-root>] [--repo <repoRoot>]
 *     [--trunk main]
 *
 * Exit codes:
 *   0 always (soft-fail by contract) · 2 usage error
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveProject } from "./lib/project.mjs";

const DEFAULT_TRUNK = "main";

/** Event types that count toward the attention-per-feature KPI (metrics.mjs). */
const ATTENTION_TYPES = new Set(["touchpoint", "intervention", "escalation"]);

// ─── Pure core (exported for testing) ────────────────────────────────────────

/**
 * Should a diff path be dropped from the LOC tally? Excludes the lockfile and
 * the factory's own state churn (dossiers, history, board dist) so a mission's
 * LOC reflects product code, not engine bookkeeping.
 * @param {string} p
 * @returns {boolean}
 */
export function isExcludedPath(p) {
  if (typeof p !== "string") return true;
  const clean = p.trim();
  if (clean === "pnpm-lock.yaml" || clean.endsWith("/pnpm-lock.yaml")) return true;
  if (clean === "history.jsonl") return true;
  if (/(^|\/)\.publish\.log$/.test(clean)) return true;
  // factory dossier / state roots (legacy in-product `factory/` + extracted `missions/`)
  if (/^factory\//.test(clean)) return true;
  if (/^missions\//.test(clean)) return true;
  if (/^deploy\/factory-board\//.test(clean)) return true;
  if (/^dist\/factory-board\//.test(clean)) return true;
  return false;
}

/**
 * Extract the file path from a `git diff --numstat` line's 3rd column,
 * unwrapping the rename forms `a => b` and `{a => b}/c`.
 * @param {string} raw — the path column (may contain " => ")
 * @returns {string}
 */
function numstatPath(raw) {
  let p = raw;
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) p = `${brace[1]}${brace[3]}${brace[4]}`;
  else if (p.includes(" => ")) p = p.split(" => ").pop();
  return p.trim();
}

/**
 * Parse `git diff --numstat` text into a LOC tally, applying `isExcludedPath`.
 * Binary rows (`-\t-\t…`) count as a file with 0 lines. Total on null/empty.
 * @param {string|null|undefined} text
 * @returns {{ added: number, deleted: number, files: number }}
 */
export function parseNumstat(text) {
  const out = { added: 0, deleted: 0, files: 0 };
  if (typeof text !== "string" || text.trim().length === 0) return out;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...rest] = parts;
    const p = numstatPath(rest.join("\t"));
    if (isExcludedPath(p)) continue;
    out.files++;
    if (addRaw !== "-") out.added += Number(addRaw) || 0;
    if (delRaw !== "-") out.deleted += Number(delRaw) || 0;
  }
  return out;
}

/**
 * Is `p` a test file for the testsAdded tally? Classes (plan.md F3):
 * `**​/*.test.*`, `**​/*.spec.*`, `backend/test/**`, `frontend/**​/*.test.tsx`.
 * @param {string} p
 * @returns {boolean}
 */
export function isTestFile(p) {
  if (typeof p !== "string") return false;
  return /\.test\./.test(p) || /\.spec\./.test(p) || p.startsWith("backend/test/");
}

/**
 * Count ADDED `it(`/`test(` lines in test files across a unified diff. Tracks
 * the current file via `+++ b/<path>` headers so only additions inside test
 * files count (the `+++` header itself never matches the it/test regex).
 * @param {string|null|undefined} diffText
 * @returns {number}
 */
export function countTestsAdded(diffText) {
  if (typeof diffText !== "string" || diffText.length === 0) return 0;
  let count = 0;
  let inTestFile = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "").trim();
      inTestFile = p !== "/dev/null" && isTestFile(p);
      continue;
    }
    if (line.startsWith("diff --git")) {
      inTestFile = false;
      continue;
    }
    if (!inTestFile) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (/\b(it|test)\(/.test(line)) count++;
    }
  }
  return count;
}

/**
 * Sum a seat's token usage across its phase_end events. Uses the input/output
 * split when present; otherwise falls back to the legacy `tokens` total.
 * `reasoning` is null unless at least one event reported it (never a fake 0).
 * @param {Array<object>} records @param {string} seat
 * @returns {{ in: number, out: number, reasoning: number|null, total: number }}
 */
export function seatTokens(records, seat) {
  const ends = (Array.isArray(records) ? records : []).filter(
    (r) => r && r.seat === seat && r.type === "phase_end",
  );
  let inSum = 0;
  let outSum = 0;
  let reasoningSum = 0;
  let sawReasoning = false;
  let legacy = 0;
  for (const e of ends) {
    if (typeof e.tokensIn === "number") inSum += e.tokensIn;
    if (typeof e.tokensOut === "number") outSum += e.tokensOut;
    if (typeof e.tokensReasoning === "number") {
      reasoningSum += e.tokensReasoning;
      sawReasoning = true;
    }
    if (typeof e.tokens === "number") legacy += e.tokens;
  }
  const total = inSum + outSum > 0 ? inSum + outSum : legacy;
  return { in: inSum, out: outSum, reasoning: sawReasoning ? reasoningSum : null, total };
}

/**
 * Derive a seat's wall time (ms). Prefers `durationMs` on phase_end (summed);
 * otherwise pairs phase_start/phase_end by order and sums ts deltas. Null when
 * nothing pairs up. Never throws.
 * @param {Array<object>} records @param {string} seat
 * @returns {number|null}
 */
export function seatDuration(records, seat) {
  const rs = (Array.isArray(records) ? records : []).filter((r) => r && r.seat === seat);
  const ends = rs.filter((r) => r.type === "phase_end");
  const starts = rs.filter((r) => r.type === "phase_start");
  const withDur = ends.filter((e) => typeof e.durationMs === "number" && e.durationMs > 0);
  if (withDur.length > 0) return withDur.reduce((s, e) => s + e.durationMs, 0);
  let total = 0;
  let paired = 0;
  const n = Math.min(starts.length, ends.length);
  for (let i = 0; i < n; i++) {
    const s = Date.parse(starts[i].ts);
    const e = Date.parse(ends[i].ts);
    if (!Number.isNaN(s) && !Number.isNaN(e) && e >= s) {
      total += e - s;
      paired++;
    }
  }
  return paired > 0 ? total : null;
}

/**
 * The model a seat ran on: first-class `model` field wins, else the legacy
 * `detail: "external:<model>"` string. Null when no seat record carries one.
 *
 * `detail` is overloaded — coordinator-authored phases put a free-text note
 * there (e.g. "factory-secret-min build (coordinator-authored…)"), so ONLY an
 * `external:`-prefixed detail is treated as a model id. A free-text note yields
 * null, keeping non-model runs out of the Agentes aggregation.
 * @param {Array<object>} records @param {string} seat
 * @returns {string|null}
 */
export function seatModel(records, seat) {
  const rs = (Array.isArray(records) ? records : []).filter(
    (r) => r && r.seat === seat && (r.type === "phase_end" || r.type === "phase_start"),
  );
  for (let i = rs.length - 1; i >= 0; i--) {
    if (typeof rs[i].model === "string" && rs[i].model.length > 0) return rs[i].model;
    if (typeof rs[i].detail === "string" && rs[i].detail.startsWith("external:")) {
      const m = rs[i].detail.slice("external:".length).trim();
      if (m.length > 0) return m;
    }
  }
  return null;
}

/**
 * Top-level keys whose value changed/added/removed between two baseline JSON
 * blobs. Total on malformed JSON → []. A "raw summary" for baselineChanged.
 * @param {string|null} beforeJson @param {string|null} afterJson
 * @returns {string[]}
 */
export function diffBaselineKeys(beforeJson, afterJson) {
  let a;
  let b;
  try {
    a = JSON.parse(beforeJson ?? "null");
    b = JSON.parse(afterJson ?? "null");
  } catch {
    return [];
  }
  if (!a || typeof a !== "object") a = {};
  if (!b || typeof b !== "object") b = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
  }
  return changed;
}

// ─── git (effects, never throws) ──────────────────────────────────────────────

/** Run git in repoRoot; any failure (missing binary, not-a-repo, nonzero) → null. */
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
 * Resolve the two revisions to diff for a mission.
 *   - live branch: `merge-base <trunk> <branch>` … `<branch>`;
 *   - merged+deleted: merge commit from `log --merges --grep <slug>`, parents
 *     `<p1>` … `<p2>`.
 * Returns null when neither is found.
 * @returns {{ from: string, to: string, mergeBase: string }|null}
 */
function resolveRange(repoRoot, slug, branch, trunk) {
  const verified = git(repoRoot, ["rev-parse", "--verify", "--quiet", branch]);
  if (verified && verified.trim().length > 0) {
    const mb = git(repoRoot, ["merge-base", trunk, branch]);
    const base = mb && mb.trim().length > 0 ? mb.trim() : trunk;
    return { from: base, to: branch, mergeBase: base };
  }
  // Fallback: the merge commit for this slug (ratify-time recollect).
  const merges = git(repoRoot, ["log", "--merges", "--grep", slug, "-n", "1", "--format=%H"]);
  const mergeSha = merges ? merges.trim().split("\n")[0] : "";
  if (mergeSha) {
    const parents = git(repoRoot, ["rev-list", "--parents", "-n", "1", mergeSha]);
    const toks = parents ? parents.trim().split(/\s+/) : [];
    if (toks.length >= 3) return { from: toks[1], to: toks[2], mergeBase: toks[1] };
  }
  return null;
}

// ─── Collector ────────────────────────────────────────────────────────────────

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

/** Number of well-formed verdict rounds in a mission's validate.log. */
function countRounds(missionsRoot, slug) {
  const p = path.join(missionsRoot, slug, "validate.log");
  if (!existsSync(p)) return 0;
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return 0;
  }
  let rounds = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && (obj.verdict === "PASS" || obj.verdict === "FAIL")) rounds++;
    } catch {
      // skip
    }
  }
  return rounds;
}

/** Read the mission's PR marker `{number,url}` if present, else null. */
function readPrMarker(missionsRoot, slug) {
  const p = path.join(missionsRoot, slug, "PR");
  if (!existsSync(p)) return null;
  try {
    const obj = JSON.parse(readFileSync(p, "utf8"));
    if (obj && typeof obj === "object") return obj;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Collect a mission's stats and write `missions/<project>/<slug>/stats.json`.
 * TOTAL: never throws; missing inputs yield zeros/nulls. Returns
 * `{ code, stats, path }`.
 *
 * @param {{ slug: string, missionsRoot: string, repoRoot: string, branch?: string, trunk?: string, project?: string }} args
 */
export function collect({ slug, missionsRoot, repoRoot, branch, trunk, project }) {
  const now = new Date().toISOString();
  const theBranch = branch || `agent/${slug}`;
  const theTrunk = trunk || DEFAULT_TRUNK;

  const stats = {
    slug,
    generatedAt: now,
    branch: theBranch,
    mergeBase: null,
    loc: { added: 0, deleted: 0, files: 0 },
    testsAdded: 0,
    baselineChanged: false,
    baselineKeysChanged: [],
    durations: { building: null, validating: null },
    tokens: {
      worker: { in: 0, out: 0, reasoning: null, total: 0 },
      validator: { in: 0, out: 0, reasoning: null, total: 0 },
      total: 0,
    },
    models: { worker: null, validator: null },
    rounds: 0,
    attention: 0,
    escalations: 0,
    pr: null,
  };

  try {
    // ── git-derived: loc, testsAdded, baseline
    const range = resolveRange(repoRoot, slug, theBranch, theTrunk);
    if (range) {
      stats.mergeBase = range.mergeBase;
      const numstat = git(repoRoot, ["diff", "--numstat", `${range.from}..${range.to}`]);
      stats.loc = parseNumstat(numstat);
      const diff = git(repoRoot, ["diff", `${range.from}..${range.to}`]);
      stats.testsAdded = countTestsAdded(diff);
      // baseline delta: was quality-baseline.json in the diff's file list?
      const changed =
        typeof numstat === "string" &&
        numstat.split("\n").some((l) => numstatPath(l.split("\t").slice(2).join("\t")) === "quality-baseline.json");
      stats.baselineChanged = Boolean(changed);
      if (stats.baselineChanged) {
        const before = git(repoRoot, ["show", `${range.from}:quality-baseline.json`]);
        const after = git(repoRoot, ["show", `${range.to}:quality-baseline.json`]);
        stats.baselineKeysChanged = diffBaselineKeys(before, after);
      }
    }

    // ── disk-derived: tokens, durations, models, attention
    const records = readMetricsRecords(missionsRoot, slug);
    stats.tokens.worker = seatTokens(records, "worker");
    stats.tokens.validator = seatTokens(records, "validator");
    stats.tokens.total = stats.tokens.worker.total + stats.tokens.validator.total;
    stats.durations.building = seatDuration(records, "worker");
    stats.durations.validating = seatDuration(records, "validator");
    stats.models.worker = seatModel(records, "worker");
    stats.models.validator = seatModel(records, "validator");
    stats.attention = records.filter(
      (r) => typeof r.type === "string" && ATTENTION_TYPES.has(r.type),
    ).length;
    stats.escalations = records.filter((r) => r.type === "escalation").length;

    stats.rounds = countRounds(missionsRoot, slug);
    stats.pr = readPrMarker(missionsRoot, slug);
  } catch {
    // TOTAL: any unexpected error still yields the zero/null stats above.
  }

  const outPath = path.join(missionsRoot, slug, "stats.json");
  try {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(stats, null, 2)}\n`);
  } catch {
    // best-effort — never crash the caller
  }
  return { code: 0, stats, path: outPath };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/mission-stats.mjs collect <slug> [--project <id>] \\\n" +
      "    [--branch agent/<slug>] [--dir <missions-root>] [--repo <repoRoot>] [--trunk main]\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--project":
        opts.project = args[++i];
        break;
      case "--branch":
        opts.branch = args[++i];
        break;
      case "--dir":
        opts.dir = args[++i];
        break;
      case "--repo":
        opts.repo = args[++i];
        break;
      case "--trunk":
        opts.trunk = args[++i];
        break;
      default:
        positional.push(args[i]);
    }
  }
  return { cmd: positional[0], slug: positional[1], ...opts };
}

function main() {
  const { cmd, slug, project, branch, dir, repo, trunk } = parseArgs(process.argv);
  if (cmd !== "collect" || !slug) {
    usage();
    return 2;
  }
  const resolved = resolveProject({ project, dir, repo });
  const { stats, path: outPath } = collect({
    slug,
    missionsRoot: resolved.missionsRoot,
    repoRoot: resolved.repoRoot,
    branch,
    trunk,
    project: resolved.id,
  });
  process.stdout.write(
    `mission-stats: ${slug} · LOC +${stats.loc.added}/-${stats.loc.deleted} (${stats.loc.files} files) · ` +
      `tokens ${stats.tokens.total} · rondas ${stats.rounds} -> ${outPath}\n`,
  );
  return 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    // Soft-fail contract: even an unexpected top-level error exits 0-ish? No —
    // a usage/programming error is worth surfacing; collect() itself is total.
    process.exit(1);
  }
}

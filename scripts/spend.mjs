#!/usr/bin/env node
/**
 * `pnpm spend` — the factory's cost/token/time rollup (factory-cost Stage 3c).
 *
 * Reads each mission's stats.json and prints, per mission × per seat:
 *   tokens (in/out/reasoning/cache), wall time, public-API $, plan $
 * plus project totals and Savings = API − Plan (the ROI gauge).
 *
 * Plan-$ is the subscription fee amortized across the window's total tokens
 * (a single mission's share = its token fraction × the fee). v1 attributes one
 * plan fee to the whole factory (--plan-fee, default $72 = z.ai Pro); multi-plan
 * attribution (z.ai for workers vs Claude Max for orchestrator) is a refinement.
 *
 * Usage:
 *   pnpm spend [project] [--mission <slug>] [--week|--month|--all] [--plan-fee <usd>]
 *
 * Exit codes: 0 ok (even with no data) · 2 usage error
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
import { resolveProject } from "./lib/project.mjs";

const SEATS = ["worker", "validator", "orchestrator"];
const SEAT_DUR = { worker: "building", validator: "validating", orchestrator: "orchestrating" };

const DAY = 86_400_000;
const WINDOWS = { week: 7 * DAY, month: 30 * DAY };

// ─── Pure core ───────────────────────────────────────────────────────────────

function round6(n) {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

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
 * Aggregate a list of stats.json objects into per-mission seat rows + totals.
 *
 * Plan-$: when `planFeeUsd` is set, the whole fee is the period total and each
 * mission owns its token share. Missions with zero usage AND no cost are dropped.
 *
 * @param {Array<object>} list — parsed stats.json objects
 * @param {{planFeeUsd?: number}} [opts]
 * @returns {{rows: Array, totals: object}}
 */
export function summarize(list, { planFeeUsd } = {}) {
  const rows = [];
  const apiVals = [];
  const durVals = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let reasoningSum = 0;
  let sawReasoning = false;
  let cacheRead = 0;
  let cacheWrite = 0;
  let tokensTotal = 0;

  for (const st of list) {
    const seats = {};
    let mTotal = 0;
    let mDur = null;
    for (const seat of SEATS) {
      const t = st.tokens?.[seat] ?? {};
      const durKey = SEAT_DUR[seat];
      const dur = st.durations?.[durKey] ?? null;
      seats[seat] = {
        in: t.in || 0,
        out: t.out || 0,
        reasoning: t.reasoning ?? null,
        cacheRead: t.cacheRead || 0,
        cacheWrite: t.cacheWrite || 0,
        total: t.total || 0,
        costApi: st.cost?.[seat]?.api ?? null,
        durationMs: typeof dur === "number" ? dur : null,
        model: st.models?.[seat] ?? null,
      };
      mTotal += t.total || 0;
      if (typeof dur === "number") mDur = (mDur ?? 0) + dur;
    }
    const mCost = st.cost?.total?.api ?? null;
    if (mTotal === 0 && mCost === null) continue; // dead mission — nothing to attribute

    rows.push({ slug: st.slug, seats, tokensTotal: mTotal, durationMs: mDur, costApi: mCost });

    tokensIn += seats.worker.in + seats.validator.in + seats.orchestrator.in;
    tokensOut += seats.worker.out + seats.validator.out + seats.orchestrator.out;
    cacheRead += seats.worker.cacheRead + seats.validator.cacheRead + seats.orchestrator.cacheRead;
    cacheWrite += seats.worker.cacheWrite + seats.validator.cacheWrite + seats.orchestrator.cacheWrite;
    tokensTotal += mTotal;
    for (const seat of SEATS) {
      if (typeof seats[seat].reasoning === "number") {
        reasoningSum += seats[seat].reasoning;
        sawReasoning = true;
      }
    }
    if (mCost !== null) apiVals.push(mCost);
    if (mDur !== null) durVals.push(mDur);
  }

  // Plan-$ attribution across the window's token total.
  const periodTokens = rows.reduce((s, r) => s + r.tokensTotal, 0);
  if (planFeeUsd && periodTokens > 0) {
    for (const r of rows) r.planUsd = round6((planFeeUsd * r.tokensTotal) / periodTokens);
  }
  const planUsd = planFeeUsd && periodTokens > 0 ? planFeeUsd : null;
  const costApi = sumNonNull(apiVals);
  const durationMs = sumNonNull(durVals);
  const savings = costApi !== null && planUsd !== null ? round6(costApi - planUsd) : null;

  return {
    rows,
    totals: {
      tokensIn,
      tokensOut,
      tokensReasoning: sawReasoning ? reasoningSum : null,
      tokensCacheRead: cacheRead,
      tokensCacheWrite: cacheWrite,
      tokensTotal,
      costApi,
      planUsd,
      durationMs,
      savings,
    },
  };
}

// ─── Formatters ──────────────────────────────────────────────────────────────

export function fmtUsd(n) {
  if (n === null || n === undefined) return "—";
  return `$${Number(n).toFixed(2)}`;
}

export function fmtTok(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

export function fmtDur(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms <= 0) return "0m";
  const h = ms / 3_600_000;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

// ─── I/O + render ────────────────────────────────────────────────────────────

function loadStats(missionsRoot) {
  const out = [];
  if (!existsSync(missionsRoot)) return out;
  for (const slug of readdirSync(missionsRoot)) {
    const p = path.join(missionsRoot, slug, "stats.json");
    if (!existsSync(p)) continue;
    try {
      const st = JSON.parse(readFileSync(p, "utf8"));
      if (st && typeof st === "object") {
        st.slug = st.slug || slug;
        out.push(st);
      }
    } catch {
      // skip unreadable stats.json — never crash the rollup
    }
  }
  return out;
}

function inWindow(st, sinceMs) {
  if (!sinceMs) return true;
  const ts = Date.parse(st.generatedAt || st.ts || "");
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= sinceMs;
}

const HEAD = ["MISSION", "SEAT", "IN", "OUT", "REAS", "CACHE", "TIME", "$API", "$PLAN"];
const W = [26, 13, 8, 8, 8, 8, 7, 9, 9];

function pad(s, w, r = false) {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : r ? s.padStart(w) : s.padEnd(w);
}

function render(report) {
  const lines = [];
  for (const proj of report.projects) {
    lines.push(`◆ ${proj.id}  (${proj.rows.length} mission${proj.rows.length === 1 ? "" : "s"})`);
    lines.push(HEAD.map((h, i) => pad(h, W[i], i >= 2)).join(" "));
    for (const r of proj.rows) {
      let first = true;
      for (const seat of SEATS) {
        const s = r.seats[seat];
        if (s.total === 0 && s.costApi === null && s.durationMs === null) continue;
        const planShare = r.planUsd && r.tokensTotal ? (r.planUsd * s.total) / r.tokensTotal : null;
        lines.push(
          [
            first ? r.slug : "",
            seat,
            fmtTok(s.in),
            fmtTok(s.out),
            s.reasoning === null ? "—" : fmtTok(s.reasoning),
            fmtTok(s.cacheRead + s.cacheWrite),
            fmtDur(s.durationMs),
            fmtUsd(s.costApi),
            planShare !== null ? fmtUsd(planShare) : "—",
          ]
            .map((c, i) => pad(c, W[i], i >= 2))
            .join(" "),
        );
        first = false;
      }
    }
    const t = proj.totals;
    lines.push("  " + "─".repeat(W.reduce((a, b) => a + b + 1, 0)));
    lines.push(
      [
        pad("TOTAL", W[0]),
        pad("", W[1]),
        pad(fmtTok(t.tokensIn), W[2], true),
        pad(fmtTok(t.tokensOut), W[3], true),
        pad(t.tokensReasoning === null ? "—" : fmtTok(t.tokensReasoning), W[4], true),
        pad(fmtTok(t.tokensCacheRead + t.tokensCacheWrite), W[5], true),
        pad(fmtDur(t.durationMs), W[6], true),
        pad(fmtUsd(t.costApi), W[7], true),
        pad(fmtUsd(t.planUsd), W[8], true),
      ].join(" "),
    );
    lines.push(
      `  Savings (API − Plan): ${fmtUsd(t.savings)}` +
        (t.savings !== null ? (t.savings >= 0 ? "  ← plan is winning" : "  ← plan is LOSING") : ""),
    );
    lines.push("");
  }
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const opts = { window: null, planFee: 72 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--mission") opts.mission = args[++i];
    else if (a === "--project") opts.project = args[++i];
    else if (a === "--week") opts.window = "week";
    else if (a === "--month") opts.window = "month";
    else if (a === "--all") opts.window = null;
    else if (a === "--plan-fee") opts.planFee = Number(args[++i]);
    else positional.push(a);
  }
  return { positional, ...opts };
}

function main() {
  const { positional, project, mission, window, planFee } = parseArgs(process.argv);
  const sinceMs = window ? WINDOWS[window] : null;
  const projectIds = positional[0]
    ? [positional[0]]
    : project
      ? [project]
      : null; // null → all profiles

  const profiles = resolveProjectProfiles(projectIds);
  const since = sinceMs ? Date.now() - sinceMs : 0;
  const report = { projects: [] };
  for (const { id, missionsRoot } of profiles) {
    let list = loadStats(missionsRoot).filter((st) => inWindow(st, sinceMs));
    if (mission) list = list.filter((st) => st.slug === mission);
    const summed = summarize(list, { planFeeUsd: planFee });
    report.projects.push({ id, ...summed });
  }
  process.stdout.write(render(report) + "\n");
  return 0;
}

/** Resolve one or all project profiles to {id, missionsRoot} entries. */
function resolveProjectProfiles(ids) {
  if (ids && ids.length) {
    const r = resolveProject({ project: ids[0] });
    return [{ id: r.id, missionsRoot: r.missionsRoot }];
  }
  // all profiles: scan deploy/projects.json
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const manifest = path.join(__dirname, "..", "deploy", "projects.json");
  if (!existsSync(manifest)) {
    const r = resolveProject({});
    return [{ id: r.id, missionsRoot: r.missionsRoot }];
  }
  try {
    const entries = JSON.parse(readFileSync(manifest, "utf8"));
    return entries.map((e) => {
      const r = resolveProject({ project: e.id });
      return { id: e.id, missionsRoot: r.missionsRoot };
    });
  } catch {
    const r = resolveProject({});
    return [{ id: r.id, missionsRoot: r.missionsRoot }];
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`spend: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

/**
 * Tests for the spend rollup CLI (spend.mjs).
 *
 * Run: node --test scripts/spend.test.mjs
 *
 * Pure-function tests over `summarize` (aggregation) and the formatters — no disk.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { summarize, fmtUsd, fmtTok, fmtDur } from "./spend.mjs";

// Build a minimal stats.json-shaped object with one seat active.
function mkStats(slug, total, api, seat = "worker") {
  const zero = { in: 0, out: 0, reasoning: null, cacheRead: 0, cacheWrite: 0, total: 0 };
  const seats = {
    worker: { ...zero },
    validator: { ...zero },
    orchestrator: { ...zero },
  };
  seats[seat] = { in: total, out: 0, reasoning: null, cacheRead: 0, cacheWrite: 0, total };
  const costSeat = { api, derived: api, reported: null };
  const costNull = { api: null, derived: null, reported: null };
  const cost = {
    worker: costNull,
    validator: costNull,
    orchestrator: costNull,
    total: { api, derived: api, reported: null },
  };
  cost[seat] = costSeat;
  return {
    slug,
    tokens: { ...seats, total },
    cost,
    durations: { building: seat === "worker" ? 600000 : null, validating: null, orchestrating: null, total: 600000 },
    models: { worker: seat === "worker" ? "claude-opus-4-8" : null, validator: null, orchestrator: null },
  };
}

// ─── summarize: aggregation ──────────────────────────────────────────────────

test("summarize aggregates per-mission seats + token/cost/time totals", () => {
  const s = summarize([mkStats("alpha", 120, 0.5)]);
  assert.equal(s.totals.tokensIn, 120);
  assert.equal(s.totals.tokensTotal, 120);
  assert.equal(s.totals.costApi, 0.5);
  assert.equal(s.totals.durationMs, 600000);
  assert.equal(s.rows[0].slug, "alpha");
  assert.equal(s.rows[0].seats.worker.total, 120);
});

test("summarize computes plan-$ as the period fee × each mission's token share", () => {
  const s = summarize([mkStats("a", 120, 0.5), mkStats("b", 480, 2.0)], { planFeeUsd: 100 });
  assert.equal(s.totals.planUsd, 100, "the whole period fee is the plan total");
  assert.equal(s.rows[0].planUsd, 20, "120/600 of $100");
  assert.equal(s.rows[1].planUsd, 80, "480/600 of $100");
});

test("summarize: savings = api cost − plan cost (the ROI gauge)", () => {
  const s = summarize([mkStats("a", 120, 50)], { planFeeUsd: 10 });
  assert.equal(s.totals.savings, 40, "$50 api vs $10 plan → saved $40");
});

test("summarize: no plan fee → plan/savings null, api still summed", () => {
  const s = summarize([mkStats("a", 120, 0.5)]);
  assert.equal(s.totals.costApi, 0.5);
  assert.equal(s.totals.planUsd, null);
  assert.equal(s.totals.savings, null);
});

test("summarize: empty list → zero tokens, null cost", () => {
  const s = summarize([]);
  assert.equal(s.totals.tokensIn, 0);
  assert.equal(s.totals.costApi, null);
  assert.equal(s.rows.length, 0);
});

test("summarize skips missions with zero usage (nothing to attribute)", () => {
  const s = summarize([mkStats("dead", 0, null)]);
  assert.equal(s.rows.length, 0);
  assert.equal(s.totals.costApi, null);
});

// ─── formatters ──────────────────────────────────────────────────────────────

test("fmtUsd: null → em dash, else 2dp with $", () => {
  assert.equal(fmtUsd(null), "—");
  assert.equal(fmtUsd(0.4231), "$0.42");
  assert.equal(fmtUsd(61.4), "$61.40");
});

test("fmtUsd: negative → sign before $ (not $-X.XX)", () => {
  assert.equal(fmtUsd(-59.5), "-$59.50");
  assert.equal(fmtUsd(-0.5), "-$0.50");
});

test("fmtUsd: unchanged for non-negative and null/undefined", () => {
  assert.equal(fmtUsd(0), "$0.00");
  assert.equal(fmtUsd(12.3), "$12.30");
  assert.equal(fmtUsd(null), "—");
  assert.equal(fmtUsd(undefined), "—");
});

test("fmtUsd: -0 renders $0.00 (no spurious negative sign)", () => {
  assert.equal(fmtUsd(-0), "$0.00");
});

test("fmtTok: compact k/M", () => {
  assert.equal(fmtTok(0), "0");
  assert.equal(fmtTok(1500), "1.5k");
  assert.equal(fmtTok(2_100_000), "2.1M");
});

test("fmtDur: ms → human minutes/hours", () => {
  assert.equal(fmtDur(0), "0m");
  assert.equal(fmtDur(60000), "1m");
  assert.equal(fmtDur(1_800_000), "30m");
  assert.equal(fmtDur(3_600_000), "1.0h");
  assert.equal(fmtDur(null), "—");
});

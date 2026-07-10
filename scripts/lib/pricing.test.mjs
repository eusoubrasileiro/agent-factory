import { test } from "node:test";
import assert from "node:assert/strict";

import { apiCost, planCost, planCostPerToken, normalizeModel, PRICES } from "./pricing.mjs";

const M = 1_000_000;

// ── apiCost ─────────────────────────────────────────────────────────────────

test("apiCost: Opus 4.8 input + output at sticker rates", () => {
  const c = apiCost("claude-opus-4-8", { in: M, out: M, cacheRead: 0, cacheWrite: 0 });
  assert.equal(c, 5 + 25); // $30
});

test("apiCost: cache tokens priced at the cache tiers, not base input", () => {
  const c = apiCost("claude-opus-4-8", { in: 0, out: 0, cacheRead: M, cacheWrite: M });
  assert.equal(c, 0.5 + 6.25); // $6.75
});

test("apiCost: reasoning tokens bill at the output rate", () => {
  const c = apiCost("claude-opus-4-8", { in: 0, out: 0, reasoning: M, cacheRead: 0, cacheWrite: 0 });
  assert.equal(c, 25);
});

test("apiCost: Sonnet 5 uses standard (non-intro) pricing", () => {
  const c = apiCost("claude-sonnet-5", { in: M, out: M });
  assert.equal(c, 3 + 15); // $18, not the $2/$10 intro
});

test("apiCost: Haiku 4.5 + alias form both resolve", () => {
  assert.equal(apiCost("claude-haiku-4-5", { in: M, out: M }), 1 + 5);
  assert.equal(apiCost("claude-haiku-4-5-20251001", { in: M, out: M }), 1 + 5);
});

test("apiCost: unknown model → null (never a fake 0)", () => {
  assert.equal(apiCost("glm-5.2", { in: M, out: M }), null);
  assert.equal(apiCost("mystery-model", { in: M }), null);
});

test("apiCost: missing tiers count as 0, not NaN", () => {
  assert.equal(apiCost("claude-opus-4-8", { in: M }), 5);
  assert.equal(apiCost("claude-opus-4-8", {}), 0);
  assert.equal(apiCost("claude-opus-4-8", undefined), 0);
});

test("apiCost: null/empty model → null", () => {
  assert.equal(apiCost(null, { in: M }), null);
  assert.equal(apiCost("", { in: M }), null);
});

// ── normalizeModel ──────────────────────────────────────────────────────────

test("normalizeModel: strips provider prefix, [1m] suffix, and bare id passes through", () => {
  assert.equal(normalizeModel("zai-coding-plan/glm-5.2"), "glm-5.2");
  assert.equal(normalizeModel("anthropic.claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModel("claude-opus-4-8[1m]"), "claude-opus-4-8");
  assert.equal(normalizeModel("claude-opus-4-8"), "claude-opus-4-8");
});

test("normalizeModel: null/garbage → null", () => {
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel(42), null);
});

// ── plan cost (aggregate) ───────────────────────────────────────────────────

test("planCostPerToken: fee amortized across the period token total", () => {
  // $72 plan, 720M tokens in the period → $0.0000001/token
  assert.equal(planCostPerToken({ fee: 72 }, 720 * M), 72 / (720 * M));
});

test("planCostPerToken: zero/missing tokens → null (no divide-by-zero)", () => {
  assert.equal(planCostPerToken({ fee: 72 }, 0), null);
  assert.equal(planCostPerToken({ fee: 72 }, null), null);
  assert.equal(planCostPerToken(null, 100 * M), null);
});

test("planCost: a mission's share = its token fraction of the period × fee", () => {
  // $72 plan, 720M period tokens. A mission that burned 72M (10%) owes $7.20.
  const c = planCost({ total: 72 * M }, { fee: 72 }, 720 * M);
  assert.equal(c, 7.2);
});

test("planCost: missing period total → null", () => {
  assert.equal(planCost({ total: 72 * M }, { fee: 72 }, 0), null);
});

test("planCost: derives total from the split when .total is absent", () => {
  const c = planCost({ in: 36 * M, out: 36 * M }, { fee: 72 }, 720 * M);
  assert.equal(c, 7.2);
});

// ── table sanity ────────────────────────────────────────────────────────────

test("PRICES: every entry has in/out/cacheRead/cacheWrite rates", () => {
  for (const [id, p] of Object.entries(PRICES)) {
    assert.equal(typeof p.in, "number", `${id}.in`);
    assert.equal(typeof p.out, "number", `${id}.out`);
    assert.equal(typeof p.cacheRead, "number", `${id}.cacheRead`);
    assert.equal(typeof p.cacheWrite, "number", `${id}.cacheWrite`);
    // cache tiers are discounts/premiums on input, sanity-check the ratio band
    assert.ok(p.cacheRead < p.in, `${id} cacheRead should be < input`);
    assert.ok(p.cacheWrite > p.in, `${id} cacheWrite should be > input`);
  }
});

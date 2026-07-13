/**
 * Cost attribution for factory seats — two bases, both for comparison:
 *
 *   api  — public pay-per-token price (Anthropic public rates per 1M tokens)
 *   plan — the subscription fee amortized across the period's total tokens
 *
 * Savings = api − plan. That is the ROI number the factory exists to surface.
 *
 * PRICING SOURCE: Anthropic public API pricing, captured via the `claude-api`
 * skill (table cached 2026-06-24) on 2026-07-10. Cache tier ratios follow the
 * Anthropic prompt-caching docs: cache read ≈ 0.1× input, cache write ≈ 1.25×
 * input (5-minute TTL; 1-hour TTL is 2×). Reasoning/thinking tokens bill at the
 * output rate (per Anthropic: thinking is "billed the same under every setting").
 *
 * `glm-5.2` runs on a flat z.ai subscription with no clean public per-token API
 * price, so its `apiCost` is `null` (renders "sem dados", never a fake 0); its
 * real cost is the amortized plan fee.
 *
 * NOTE: plan cost is an AGGREGATE — a single mission's share depends on the
 * whole period's token total, which the per-mission stats.json cannot know. So
 * stats.json stores `cost.api` + the raw split; plan-$ is computed at rollup
 * time (spend CLI / dashboard) via `planCost(split, plan, periodTokenTotal)`.
 *
 * Pure module — no I/O. Unknown / unmapped models yield `null` (not 0), so a
 * missing price is always visible rather than silently free.
 */

const PER_MTOK = 1_000_000;

/**
 * Public API $/1M tokens by tier. Keys are normalised model ids.
 * @type {Record<string, {in: number, out: number, cacheRead: number, cacheWrite: number}>}
 */
export const PRICES = {
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-fable-5": { in: 10, out: 50, cacheRead: 1.0, cacheWrite: 12.5 },
};

/** Round to 6dp to shed float noise without losing micro-dollar precision. */
function round6(n) {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Normalise a model id for pricing lookup: strip provider prefixes
 * (`zai-coding-plan/`, `anthropic.`), the Claude Code `[1m]` accounting suffix,
 * and a dated Haiku snapshot back to its alias. Returns null for non-strings.
 * @param {string|null|undefined} model
 * @returns {string|null}
 */
export function normalizeModel(model) {
  if (typeof model !== "string" || model.length === 0) return null;
  let m = model.trim();
  // drop provider/namespace prefix: "zai-coding-plan/glm-5.2" → "glm-5.2"
  m = m.split("/").pop();
  // drop bedrock-style "anthropic." prefix
  if (m.startsWith("anthropic.")) m = m.slice("anthropic.".length);
  // drop Claude Code's internal [1m] suffix (1M-context accounting, not a model)
  m = m.replace(/\[1m\]$/, "");
  // collapse the dated Haiku snapshot to its alias so the price table hits
  if (/^claude-haiku-4-5-\d+$/.test(m)) m = "claude-haiku-4-5";
  return m;
}

/**
 * Public-API cost (USD) for a token split. Unknown model → null.
 *
 * `split` tiers default to 0 when absent, so partial splits are safe.
 * Reasoning tokens bill at the output rate.
 *
 * @param {string} model
 * @param {{in?: number, out?: number, reasoning?: number, cacheRead?: number, cacheWrite?: number}} [split]
 * @returns {number|null}
 */
export function apiCost(model, split) {
  const p = PRICES[normalizeModel(model) ?? ""];
  if (!p) return null;
  const s = split || {};
  const out = (s.out || 0) + (s.reasoning || 0);
  const usd =
    ((s.in || 0) * p.in +
      (s.cacheRead || 0) * p.cacheRead +
      (s.cacheWrite || 0) * p.cacheWrite +
      out * p.out) /
    PER_MTOK;
  return round6(usd);
}

/**
 * Effective USD-per-token of a subscription plan, amortized across the period's
 * total token usage. The real per-token cost of a flat plan. Null when the
 * period total is unknown or zero (no divide-by-zero).
 * @param {{fee: number}|null|undefined} plan
 * @param {number|null|undefined} periodTokenTotal
 * @returns {number|null}
 */
export function planCostPerToken(plan, periodTokenTotal) {
  if (!plan || typeof plan.fee !== "number" || !periodTokenTotal || periodTokenTotal <= 0) {
    return null;
  }
  return plan.fee / periodTokenTotal;
}

/**
 * Plan cost (USD) attributable to a token split — its fraction of the period's
 * total tokens times the plan fee. Null when the period total is unknown.
 *
 * Uses `split.total` when present; otherwise sums the tiers.
 * @param {{total?: number, in?: number, out?: number, reasoning?: number, cacheRead?: number, cacheWrite?: number}} split
 * @param {{fee: number}} plan
 * @param {number} periodTokenTotal
 * @returns {number|null}
 */
export function planCost(split, plan, periodTokenTotal) {
  const perToken = planCostPerToken(plan, periodTokenTotal);
  if (perToken === null) return null;
  const s = split || {};
  const total =
    typeof s.total === "number"
      ? s.total
      : (s.in || 0) + (s.out || 0) + (s.reasoning || 0) + (s.cacheRead || 0) + (s.cacheWrite || 0);
  return round6(total * perToken);
}

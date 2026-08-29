/**
 * outcome.mjs — the run-outcome taxonomy.
 *
 * The factory's meter has always recorded what a run COST. This turns two
 * driver-computed facts — `filesChanged` (paths the seat touched, taken from
 * git, never from the transcript) and the deterministic gate's three-valued
 * `passed` — into one verdict per run, so "did it work" becomes countable.
 *
 *   filesChanged | gate passed | verdict
 *   -------------|-------------|-------------------------------------------
 *   0            | any         | noop           — the seat did nothing
 *   > 0          | true        | delivered      — green-first-try
 *   > 0          | true + cfg  | quarantined    — green AFTER moving the gate
 *   > 0          | false       | broken         — code that fails its own gate
 *   > 0          | null        | unmeasured     — gate off, or it could not run
 *   null         | any         | unmeasured     — the delta itself is unknown
 *   (orchestrator seat)        | not-applicable — never wrote code by design
 *
 *   green-first-try = delivered / (delivered + broken + noop)
 *   noop-rate       = noop      / (delivered + broken + noop)
 *
 * TWO KINDS OF EXCLUSION, deliberately not merged:
 *   `unmeasured`     — the run belongs in the population and the INSTRUMENT
 *                      failed. A rising count here means the meter is breaking.
 *   `not-applicable` — the run was never in the population (a planning seat
 *                      emits a plan and touches nothing; that is success, not a
 *                      noop). Measured live on the gate-runner mission, where
 *                      the Opus planner recorded filesChanged 0.
 * Collapsing them would hide a broken meter behind a legitimate exclusion.
 *
 * RESIDUAL RISK, named rather than papered over: `quarantined` fires only on a
 * POSITIVE detection (`gateConfigTouched === true`). A project that declares no
 * `gateConfig[]` in its profile reports `null` forever, and its `delivered`
 * count is therefore trust-based. Quarantining on null instead would empty
 * `delivered` for every such project, and a number that is always zero is a
 * number nobody reads. All four registered profiles declare `gateConfig[]`.
 *
 * Pure, no I/O. Every consumer imports from here so the taxonomy has exactly
 * one definition.
 */

/** Every verdict `classifyRun` can return. */
export const OUTCOMES = Object.freeze([
  "delivered",
  "broken",
  "noop",
  "quarantined",
  "unmeasured",
  "not-applicable",
]);

/** Verdicts that form the denominator of green-first-try and noop-rate. */
const SCORED = Object.freeze(["delivered", "broken", "noop"]);

/**
 * Classify one run. Total: any shape of garbage degrades to `unmeasured`
 * rather than throwing — a classifier that can crash on a torn metrics line
 * takes the whole report down with it.
 *
 * @param {{filesChanged?: number|null, passed?: boolean|null,
 *          gateConfigTouched?: boolean|null, seat?: string}} [run]
 * @returns {"delivered"|"broken"|"noop"|"quarantined"|"unmeasured"|"not-applicable"}
 */
export function classifyRun(run) {
  if (typeof run !== "object" || run === null) return "unmeasured";

  // A seat that is not there to write code cannot be scored on whether it did.
  if (run.seat === "orchestrator") return "not-applicable";

  const files = run.filesChanged;
  if (typeof files !== "number" || Number.isNaN(files)) return "unmeasured";

  // Checked BEFORE the gate, and that precedence is the point: a seat that
  // wrote nothing is a noop whatever the gate says, because there is nothing
  // for the gate to be a verdict about. A green gate over an untouched tree
  // measures the trunk, not the run.
  if (files === 0) return "noop";

  if (run.passed === false) return "broken";
  if (run.passed === true) return run.gateConfigTouched === true ? "quarantined" : "delivered";
  return "unmeasured";
}

/**
 * Roll a list of runs up into counts and the two headline rates.
 *
 * `greenFirstTry` and `noopRate` are `null` — never 0 — when nothing was
 * scorable. 0/0 printed as 0% reads as "everything fails", which is the
 * opposite of "we did not measure anything", and it is exactly the zero-fill
 * the E1-d law forbids.
 *
 * @param {Array<object>} runs
 * @returns {{counts: Record<string, number>, total: number, scored: number,
 *            greenFirstTry: number|null, noopRate: number|null}}
 */
export function summarizeOutcomes(runs) {
  const counts = {};
  for (const k of OUTCOMES) counts[k] = 0;
  const list = Array.isArray(runs) ? runs : [];
  for (const r of list) counts[classifyRun(r)]++;

  const scored = SCORED.reduce((n, k) => n + counts[k], 0);
  return {
    counts,
    total: list.length,
    scored,
    greenFirstTry: scored > 0 ? counts.delivered / scored : null,
    noopRate: scored > 0 ? counts.noop / scored : null,
  };
}

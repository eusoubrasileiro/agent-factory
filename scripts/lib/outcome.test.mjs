/**
 * Tests for the run-outcome taxonomy.
 *
 *   node --test "scripts/lib/outcome.test.mjs"
 *
 * The one thing that must never go wrong here: a run whose outcome we could not
 * measure must not land in a denominator. Every rate this module produces is a
 * claim about the factory's quality, and a claim built on zero-filled absence is
 * worse than no claim at all (the E1-d law, and D-25).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { OUTCOMES, classifyRun, summarizeOutcomes } from "./outcome.mjs";

// ─── classifyRun ─────────────────────────────────────────────────────────────

test("classifyRun: files touched and the gate green is `delivered` — green-first-try", () => {
  assert.equal(classifyRun({ filesChanged: 3, passed: true }), "delivered");
});

test("classifyRun: files touched and the gate red is `broken`", () => {
  assert.equal(classifyRun({ filesChanged: 3, passed: false }), "broken");
});

test("classifyRun: nothing touched is `noop`, whatever the gate says", () => {
  // Precedence is deliberate and it resolves an ambiguity in the plan's table:
  // a seat that wrote nothing is a noop regardless of the gate, because there
  // is nothing for the gate to be a verdict ABOUT. A green gate over an
  // untouched tree measures the trunk, not the run.
  for (const passed of [true, false, null, undefined]) {
    assert.equal(classifyRun({ filesChanged: 0, passed }), "noop");
  }
});

test("classifyRun: green only AFTER moving the gate config is `quarantined`, not delivered", () => {
  assert.equal(classifyRun({ filesChanged: 3, passed: true, gateConfigTouched: true }), "quarantined");
});

test("classifyRun: a red gate stays `broken` even if the config moved — moving it did not save the run", () => {
  assert.equal(classifyRun({ filesChanged: 3, passed: false, gateConfigTouched: true }), "broken");
});

test("classifyRun: an undetectable config move (null) does not quarantine — only a positive detection does", () => {
  // A project that declares no gateConfig[] gets null forever; quarantining on
  // null would empty `delivered` for every such project and the number would be
  // abandoned. The residual risk is named in the module doc instead.
  assert.equal(classifyRun({ filesChanged: 3, passed: true, gateConfigTouched: null }), "delivered");
});

test("classifyRun: an unmeasured tree delta is `unmeasured` — never 0, never a verdict", () => {
  for (const filesChanged of [null, undefined, "3", Number.NaN]) {
    assert.equal(classifyRun({ filesChanged, passed: true }), "unmeasured");
  }
});

test("classifyRun: files touched but no gate verdict is `unmeasured`, not `delivered`", () => {
  // The gate was off, or it could not run. Either way we do not know.
  for (const passed of [null, undefined]) {
    assert.equal(classifyRun({ filesChanged: 3, passed }), "unmeasured");
  }
});

test("classifyRun: an orchestrator seat is `not-applicable`, never `noop`", () => {
  // Measured live on the gate-runner mission: the Opus planner emitted its plan
  // as a final message and touched zero files. That is CORRECT for a planning
  // seat — but the taxonomy would read 0 as "the seat did nothing" and drag
  // green-first-try down with a run that was never supposed to write code.
  assert.equal(classifyRun({ filesChanged: 0, passed: null, seat: "orchestrator" }), "not-applicable");
  assert.equal(classifyRun({ filesChanged: 2, passed: true, seat: "orchestrator" }), "not-applicable");
});

test("classifyRun: `not-applicable` and `unmeasured` are different facts and stay different", () => {
  // not-applicable = out of the population. unmeasured = in the population, and
  // the instrument failed. Collapsing them hides a broken meter behind a
  // legitimate exclusion.
  assert.notEqual(classifyRun({ filesChanged: 0, seat: "orchestrator" }), classifyRun({ filesChanged: null }));
});

test("classifyRun: worker and validator seats are both classified normally", () => {
  for (const seat of ["worker", "validator", undefined]) {
    assert.equal(classifyRun({ filesChanged: 1, passed: true, seat }), "delivered");
  }
});

test("classifyRun: garbage in gives `unmeasured`, never a throw", () => {
  for (const run of [undefined, null, {}, 7, "x"]) {
    assert.equal(classifyRun(run), "unmeasured");
  }
});

test("OUTCOMES enumerates exactly the six verdicts", () => {
  assert.deepEqual(
    [...OUTCOMES].sort(),
    ["broken", "delivered", "noop", "not-applicable", "quarantined", "unmeasured"],
  );
});

// ─── summarizeOutcomes ───────────────────────────────────────────────────────

const R = (filesChanged, passed, extra = {}) => ({ filesChanged, passed, ...extra });

test("summarizeOutcomes: green-first-try is delivered over delivered+broken+noop", () => {
  const s = summarizeOutcomes([R(1, true), R(1, true), R(1, false), R(0, true)]);
  assert.equal(s.counts.delivered, 2);
  assert.equal(s.counts.broken, 1);
  assert.equal(s.counts.noop, 1);
  assert.equal(s.scored, 4);
  assert.equal(s.greenFirstTry, 0.5);
  assert.equal(s.noopRate, 0.25);
});

test("summarizeOutcomes: unmeasured runs are counted but never enter a denominator", () => {
  const s = summarizeOutcomes([R(1, true), R(null, null), R(2, null)]);
  assert.equal(s.counts.unmeasured, 2);
  assert.equal(s.scored, 1);
  assert.equal(s.greenFirstTry, 1);
});

test("summarizeOutcomes: not-applicable runs are counted but never enter a denominator", () => {
  const s = summarizeOutcomes([R(1, true), R(0, null, { seat: "orchestrator" })]);
  assert.equal(s.counts["not-applicable"], 1);
  assert.equal(s.scored, 1);
  assert.equal(s.greenFirstTry, 1);
});

test("summarizeOutcomes: quarantined is reported but excluded from the rate on both sides", () => {
  // It is neither a success we may claim nor a failure we may charge — it needs
  // a human look. Counting it either way would launder that judgement.
  const s = summarizeOutcomes([R(1, true), R(1, true, { gateConfigTouched: true })]);
  assert.equal(s.counts.quarantined, 1);
  assert.equal(s.scored, 1);
  assert.equal(s.greenFirstTry, 1);
});

test("summarizeOutcomes: nothing scorable gives null rates, never 0", () => {
  // 0/0 rendered as 0% would read as "everything fails".
  for (const runs of [[], [R(null, null)], [R(0, null, { seat: "orchestrator" })]]) {
    const s = summarizeOutcomes(runs);
    assert.equal(s.greenFirstTry, null);
    assert.equal(s.noopRate, null);
  }
});

test("summarizeOutcomes: a non-array input is absence, not an empty success", () => {
  const s = summarizeOutcomes(undefined);
  assert.equal(s.scored, 0);
  assert.equal(s.greenFirstTry, null);
  assert.equal(s.total, 0);
});

test("summarizeOutcomes: every verdict key is present even at zero, so a table never shows a hole", () => {
  const s = summarizeOutcomes([]);
  for (const k of OUTCOMES) assert.equal(s.counts[k], 0, `missing ${k}`);
});

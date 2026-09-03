/**
 * The fix-round bound is the whole point of counting: a dispatched worker
 * loops against the pre-push reviewer inside a worktree nobody opens, so the
 * bound has to be a fact rather than a line in that worker's own prompt.
 * These tests pin the counting rules that make it one.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { countFixRounds, hasEscalated, MAX_FIX_ROUNDS } from "./review-log.mjs";

const e = (branch, verdict) => ({ ts: "2026-09-03T00:00:00Z", branch, verdict });

test("counts only rejects on the branch asked about", () => {
  const log = [
    e("agent/a", "reject"),
    e("agent/b", "reject"),
    e("agent/a", "approve"),
    e("agent/a", "reject"),
  ];
  assert.equal(countFixRounds("agent/a", log), 2);
  assert.equal(countFixRounds("agent/b", log), 1);
});

test("an escalate counts as a round — it IS the final reject", () => {
  assert.equal(countFixRounds("agent/a", [e("agent/a", "reject"), e("agent/a", "escalate")]), 2);
});

test("legacy entries with no branch never retro-escalate a fresh branch", () => {
  const log = [
    { ts: "2026-01-01T00:00:00Z", verdict: "reject" },
    { ts: "2026-01-02T00:00:00Z", verdict: "reject" },
    { ts: "2026-01-03T00:00:00Z", verdict: "reject" },
  ];
  assert.equal(countFixRounds("agent/new", log), 0);
  assert.equal(hasEscalated("agent/new", log), false);
});

test("an empty or missing branch key counts nothing rather than everything", () => {
  const log = [e("agent/a", "reject"), e(undefined, "reject")];
  assert.equal(countFixRounds("", log), 0);
  assert.equal(countFixRounds(undefined, log), 0);
});

test("hasEscalated is branch-scoped", () => {
  const log = [e("agent/a", "escalate"), e("agent/b", "reject")];
  assert.equal(hasEscalated("agent/a", log), true);
  assert.equal(hasEscalated("agent/b", log), false);
});

test("the bound trips on the Nth reject, not the Nth+1", () => {
  // Mirrors security-review.mjs: escalate when roundsSoFar + 1 >= MAX.
  const log = [];
  const wouldEscalate = () => countFixRounds("agent/a", log) + 1 >= MAX_FIX_ROUNDS;
  assert.equal(wouldEscalate(), false); //  1st reject
  log.push(e("agent/a", "reject"));
  assert.equal(wouldEscalate(), false); //  2nd reject
  log.push(e("agent/a", "reject"));
  assert.equal(wouldEscalate(), true); //   3rd reject -> STOP
  assert.equal(MAX_FIX_ROUNDS, 3);
});

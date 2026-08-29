import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileRuns } from "./run-log.mjs";

const start = (seat, model, ts) => ({ type: "phase_start", seat, model, ts });
const end = (seat, model, ts) => ({ type: "phase_end", seat, model, ts });

// A completed run now also carries runId, pairedBy and the outcome inputs.
// These project a run back to the legacy pairing core, so the cases below keep
// asserting exactly what they were written to assert.
const core = (r) => ({
  seat: r.seat, model: r.model, startTs: r.startTs, endTs: r.endTs, durationMs: r.durationMs,
});
const coreStart = (r) => ({ seat: r.seat, model: r.model, startTs: r.startTs });
const EMPTY = { completed: [], orphaned: [], endsWithoutStart: [], unpairedGates: [] };

// ── happy path ──────────────────────────────────────────────────────────────

test("reconcileRuns: a start followed by a matching end pairs into completed", () => {
  const { completed, orphaned } = reconcileRuns([
    start("builder", "claude-sonnet-5", "2026-08-28T10:00:00.000Z"),
    end("builder", "claude-sonnet-5", "2026-08-28T10:00:05.000Z"),
  ]);
  assert.deepEqual(orphaned.map(coreStart), []);
  assert.deepEqual(completed.map(core), [
    {
      seat: "builder",
      model: "claude-sonnet-5",
      startTs: "2026-08-28T10:00:00.000Z",
      endTs: "2026-08-28T10:00:05.000Z",
      durationMs: 5000,
    },
  ]);
});

// ── orphans ─────────────────────────────────────────────────────────────────

test("reconcileRuns: a start with no later end is orphaned", () => {
  const { completed, orphaned } = reconcileRuns([
    start("builder", "claude-sonnet-5", "2026-08-28T10:00:00.000Z"),
  ]);
  assert.deepEqual(completed.map(core), []);
  assert.deepEqual(orphaned.map(coreStart), [
    { seat: "builder", model: "claude-sonnet-5", startTs: "2026-08-28T10:00:00.000Z" },
  ]);
});

test("reconcileRuns: an orphan (different seat, never gets an end) followed by a later matching pair", () => {
  const events = [
    start("reviewer", "claude-opus-4-8", "2026-08-28T10:00:00.000Z"), // killed before its end — no end ever comes
    start("builder", "claude-sonnet-5", "2026-08-28T10:05:00.000Z"),
    end("builder", "claude-sonnet-5", "2026-08-28T10:05:10.000Z"),
  ];
  const { completed, orphaned } = reconcileRuns(events);
  assert.deepEqual(orphaned.map(coreStart), [
    { seat: "reviewer", model: "claude-opus-4-8", startTs: "2026-08-28T10:00:00.000Z" },
  ]);
  assert.deepEqual(completed.map(core), [
    {
      seat: "builder",
      model: "claude-sonnet-5",
      startTs: "2026-08-28T10:05:00.000Z",
      endTs: "2026-08-28T10:05:10.000Z",
      durationMs: 10000,
    },
  ]);
});

// ── interleaving / cross-matching ───────────────────────────────────────────

test("reconcileRuns: interleaved seats/models never cross-match", () => {
  const events = [
    start("builder", "claude-sonnet-5", "2026-08-28T10:00:00.000Z"),
    start("reviewer", "claude-opus-4-8", "2026-08-28T10:00:01.000Z"),
    end("reviewer", "claude-opus-4-8", "2026-08-28T10:00:02.000Z"),
    end("builder", "claude-sonnet-5", "2026-08-28T10:00:03.000Z"),
  ];
  const { completed, orphaned } = reconcileRuns(events);
  assert.deepEqual(orphaned.map(coreStart), []);
  assert.deepEqual(completed.map(core), [
    {
      seat: "reviewer",
      model: "claude-opus-4-8",
      startTs: "2026-08-28T10:00:01.000Z",
      endTs: "2026-08-28T10:00:02.000Z",
      durationMs: 1000,
    },
    {
      seat: "builder",
      model: "claude-sonnet-5",
      startTs: "2026-08-28T10:00:00.000Z",
      endTs: "2026-08-28T10:00:03.000Z",
      durationMs: 3000,
    },
  ]);
});

test("reconcileRuns: same seat, different model — a start only matches an end with the same model", () => {
  const events = [
    start("builder", "claude-sonnet-5", "2026-08-28T10:00:00.000Z"),
    end("builder", "claude-opus-4-8", "2026-08-28T10:00:01.000Z"), // wrong model, ignored (no preceding unmatched start of this model)
    end("builder", "claude-sonnet-5", "2026-08-28T10:00:02.000Z"),
  ];
  const { completed, orphaned } = reconcileRuns(events);
  assert.deepEqual(orphaned.map(coreStart), []);
  assert.deepEqual(completed.map(core), [
    {
      seat: "builder",
      model: "claude-sonnet-5",
      startTs: "2026-08-28T10:00:00.000Z",
      endTs: "2026-08-28T10:00:02.000Z",
      durationMs: 2000,
    },
  ]);
});

test("reconcileRuns: each phase_end matches at most one phase_start (earliest unmatched wins)", () => {
  const events = [
    start("builder", "claude-sonnet-5", "2026-08-28T10:00:00.000Z"),
    start("builder", "claude-sonnet-5", "2026-08-28T10:01:00.000Z"),
    end("builder", "claude-sonnet-5", "2026-08-28T10:02:00.000Z"),
  ];
  const { completed, orphaned } = reconcileRuns(events);
  assert.deepEqual(orphaned.map(coreStart), [
    { seat: "builder", model: "claude-sonnet-5", startTs: "2026-08-28T10:01:00.000Z" },
  ]);
  assert.deepEqual(completed.map(core), [
    {
      seat: "builder",
      model: "claude-sonnet-5",
      startTs: "2026-08-28T10:00:00.000Z",
      endTs: "2026-08-28T10:02:00.000Z",
      durationMs: 120000,
    },
  ]);
});

// ── robustness against torn / garbage input ────────────────────────────────

test("reconcileRuns: a phase_end with no preceding unmatched start is ignored, not an error", () => {
  const events = [end("builder", "claude-sonnet-5", "2026-08-28T10:00:00.000Z")];
  assert.deepEqual(reconcileRuns(events).completed, []);
  assert.equal(reconcileRuns(events).endsWithoutStart.length, 1);
});

test("reconcileRuns: non-object entries and unrelated event types are ignored", () => {
  const events = [
    null,
    undefined,
    42,
    "garbage",
    { type: "cost", seat: "builder", model: "claude-sonnet-5", ts: "2026-08-28T10:00:00.000Z" },
    start("builder", "claude-sonnet-5", "2026-08-28T10:00:00.000Z"),
    { not: "an event" },
    end("builder", "claude-sonnet-5", "2026-08-28T10:00:01.000Z"),
  ];
  const { completed, orphaned } = reconcileRuns(events);
  assert.deepEqual(orphaned.map(coreStart), []);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].durationMs, 1000);
});

test("reconcileRuns: missing or unparseable ts yields null durationMs but still pairs", () => {
  const missingStart = reconcileRuns([
    { type: "phase_start", seat: "builder", model: "claude-sonnet-5" },
    end("builder", "claude-sonnet-5", "2026-08-28T10:00:01.000Z"),
  ]);
  assert.equal(missingStart.completed.length, 1);
  assert.equal(missingStart.completed[0].durationMs, null);
  assert.equal(missingStart.completed[0].startTs, undefined);

  const garbageEnd = reconcileRuns([
    start("builder", "claude-sonnet-5", "2026-08-28T10:00:00.000Z"),
    end("builder", "claude-sonnet-5", "not-a-date"),
  ]);
  assert.equal(garbageEnd.completed.length, 1);
  assert.equal(garbageEnd.completed[0].durationMs, null);
});

// ── empty / null / non-array inputs ────────────────────────────────────────

test("reconcileRuns: empty array, null, and non-array inputs all return empty result", () => {
  for (const input of [[], null, "nope", undefined]) assert.deepEqual(reconcileRuns(input), EMPTY);
});

// ── runId: a fact, where the FIFO fallback was only ever a guess ────────────

const withId = (e, runId) => ({ ...e, runId });
const gate = (runId, passed, extra = {}) => ({ type: "gate_result", runId, passed, ...extra });

test("reconcileRuns: two concurrent runs on the SAME seat+model pair correctly by runId", () => {
  // This is the case FIFO cannot do. Two worktrees on one mission, the second
  // finishing first: FIFO hands the fast end to the slow start and both
  // durations are wrong. With runId both are right.
  const events = [
    withId(start("worker", "m", "2026-08-28T10:00:00.000Z"), "a"),
    withId(start("worker", "m", "2026-08-28T10:00:01.000Z"), "b"),
    withId(end("worker", "m", "2026-08-28T10:00:05.000Z"), "b"),
    withId(end("worker", "m", "2026-08-28T10:01:00.000Z"), "a"),
  ];
  const { completed, orphaned } = reconcileRuns(events);
  assert.deepEqual(orphaned, []);
  assert.deepEqual(
    completed.map((r) => [r.runId, r.durationMs, r.pairedBy]),
    [
      ["b", 4000, "runId"],
      ["a", 60000, "runId"],
    ],
  );
});

test("reconcileRuns: pairedBy says whether the pairing was a fact or the legacy guess", () => {
  const byId = reconcileRuns([
    withId(start("worker", "m", "2026-08-28T10:00:00.000Z"), "a"),
    withId(end("worker", "m", "2026-08-28T10:00:01.000Z"), "a"),
  ]);
  assert.equal(byId.completed[0].pairedBy, "runId");

  const legacy = reconcileRuns([
    start("worker", "m", "2026-08-28T10:00:00.000Z"),
    end("worker", "m", "2026-08-28T10:00:01.000Z"),
  ]);
  assert.equal(legacy.completed[0].pairedBy, "fifo");
  assert.equal(legacy.completed[0].runId, null);
});

test("reconcileRuns: an end whose runId matches nothing does NOT fall back to FIFO", () => {
  // Falling back would re-introduce exactly the guess runId exists to kill, and
  // would attach one run's cost to another run's start.
  const { completed, orphaned, endsWithoutStart } = reconcileRuns([
    withId(start("worker", "m", "2026-08-28T10:00:00.000Z"), "a"),
    withId(end("worker", "m", "2026-08-28T10:00:01.000Z"), "zzz"),
  ]);
  assert.deepEqual(completed, []);
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0].runId, "a");
  assert.equal(endsWithoutStart.length, 1);
});

test("reconcileRuns: an orphan carries its runId, so a killed run can be named", () => {
  const { orphaned } = reconcileRuns([withId(start("worker", "m", "2026-08-28T10:00:00.000Z"), "a")]);
  assert.deepEqual(orphaned, [{ runId: "a", seat: "worker", model: "m", startTs: "2026-08-28T10:00:00.000Z" }]);
});

// ── outcome inputs ─────────────────────────────────────────────────────────

test("reconcileRuns: filesChanged rides through from phase_end untouched", () => {
  const { completed } = reconcileRuns([
    start("worker", "m", "2026-08-28T10:00:00.000Z"),
    { ...end("worker", "m", "2026-08-28T10:00:01.000Z"), filesChanged: 4 },
  ]);
  assert.equal(completed[0].filesChanged, 4);
});

test("reconcileRuns: a legacy phase_end with no outcome fields yields nulls, never 0/false", () => {
  const { completed } = reconcileRuns([
    start("worker", "m", "2026-08-28T10:00:00.000Z"),
    end("worker", "m", "2026-08-28T10:00:01.000Z"),
  ]);
  assert.equal(completed[0].filesChanged, null);
  assert.equal(completed[0].passed, null);
  assert.equal(completed[0].gateConfigTouched, null);
});

test("reconcileRuns: a gate_result joins its run by runId and supplies the verdict", () => {
  const { completed, unpairedGates } = reconcileRuns([
    withId(start("worker", "m", "2026-08-28T10:00:00.000Z"), "a"),
    { ...withId(end("worker", "m", "2026-08-28T10:00:01.000Z"), "a"), filesChanged: 2 },
    gate("a", true, { gateConfigTouched: false }),
  ]);
  assert.deepEqual(unpairedGates, []);
  assert.equal(completed[0].passed, true);
  assert.equal(completed[0].gateConfigTouched, false);
});

test("reconcileRuns: the gate is joined AFTER phase_end even though it is logged later", () => {
  // A single forward walk would see the verdict before the run it belongs to
  // exists, and drop it. The second pass is what makes the join work at all.
  const { completed } = reconcileRuns([
    withId(start("worker", "m", "2026-08-28T10:00:00.000Z"), "a"),
    withId(end("worker", "m", "2026-08-28T10:00:01.000Z"), "a"),
    gate("a", false),
  ]);
  assert.equal(completed[0].passed, false);
});

test("reconcileRuns: a gate_result with no runId is never guessed onto a run", () => {
  // Attaching a verdict to the wrong run manufactures a false delivered or a
  // false broken — worse than an unmeasured one.
  const { completed, unpairedGates } = reconcileRuns([
    start("worker", "m", "2026-08-28T10:00:00.000Z"),
    end("worker", "m", "2026-08-28T10:00:01.000Z"),
    { type: "gate_result", passed: true },
  ]);
  assert.equal(completed[0].passed, null);
  assert.deepEqual(unpairedGates, [{ runId: null, passed: true }]);
});

test("reconcileRuns: a gate_result for an orphaned run is unpaired, not silently dropped", () => {
  const { unpairedGates } = reconcileRuns([
    withId(start("worker", "m", "2026-08-28T10:00:00.000Z"), "a"),
    gate("a", true),
  ]);
  assert.deepEqual(unpairedGates, [{ runId: "a", passed: true }]);
});

test("reconcileRuns: an unmeasured gate verdict stays null through the join", () => {
  const { completed } = reconcileRuns([
    withId(start("worker", "m", "2026-08-28T10:00:00.000Z"), "a"),
    withId(end("worker", "m", "2026-08-28T10:00:01.000Z"), "a"),
    gate("a", null),
  ]);
  assert.equal(completed[0].passed, null);
});

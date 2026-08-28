import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileRuns } from "./run-log.mjs";

const start = (seat, model, ts) => ({ type: "phase_start", seat, model, ts });
const end = (seat, model, ts) => ({ type: "phase_end", seat, model, ts });

// ── happy path ──────────────────────────────────────────────────────────────

test("reconcileRuns: a start followed by a matching end pairs into completed", () => {
  const { completed, orphaned } = reconcileRuns([
    start("builder", "claude-sonnet-5", "2026-08-28T10:00:00.000Z"),
    end("builder", "claude-sonnet-5", "2026-08-28T10:00:05.000Z"),
  ]);
  assert.deepEqual(orphaned, []);
  assert.deepEqual(completed, [
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
  assert.deepEqual(completed, []);
  assert.deepEqual(orphaned, [
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
  assert.deepEqual(orphaned, [
    { seat: "reviewer", model: "claude-opus-4-8", startTs: "2026-08-28T10:00:00.000Z" },
  ]);
  assert.deepEqual(completed, [
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
  assert.deepEqual(orphaned, []);
  assert.deepEqual(completed, [
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
  assert.deepEqual(orphaned, []);
  assert.deepEqual(completed, [
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
  assert.deepEqual(orphaned, [
    { seat: "builder", model: "claude-sonnet-5", startTs: "2026-08-28T10:01:00.000Z" },
  ]);
  assert.deepEqual(completed, [
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
  assert.deepEqual(reconcileRuns(events), { completed: [], orphaned: [] });
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
  assert.deepEqual(orphaned, []);
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
  assert.deepEqual(reconcileRuns([]), { completed: [], orphaned: [] });
  assert.deepEqual(reconcileRuns(null), { completed: [], orphaned: [] });
  assert.deepEqual(reconcileRuns("nope"), { completed: [], orphaned: [] });
  assert.deepEqual(reconcileRuns(undefined), { completed: [], orphaned: [] });
});

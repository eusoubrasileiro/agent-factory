/**
 * Tests for the factory telemetry recorder schema (metrics.mjs).
 *
 * Run: node --test scripts/metrics.test.mjs
 *
 * Pure-function tests over `validateEvent` — no disk, no stdin. Cover the legacy
 * schema (still accepted, backward-compatible) plus the full-pipeline
 * observability fields added by factory-metrics W3 (one valid + one invalid per
 * new field).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { validateEvent } from "./metrics.mjs";

// ─── Baseline / legacy schema (must stay accepted) ─────────────────────────────

test("validateEvent accepts a minimal legacy event", () => {
  assert.deepEqual(validateEvent({ seat: "worker", type: "phase_end" }), { ok: true });
});

test("validateEvent accepts the legacy tokens/costUsd fields", () => {
  assert.deepEqual(
    validateEvent({ seat: "worker", type: "phase_end", tokens: 1336911, costUsd: 0 }),
    { ok: true },
  );
});

test("validateEvent rejects a bad seat / type", () => {
  assert.equal(validateEvent({ seat: "nope", type: "phase_end" }).ok, false);
  assert.equal(validateEvent({ seat: "worker", type: "nope" }).ok, false);
});

// ─── F1: model (string) ────────────────────────────────────────────────────────

test("validateEvent accepts a string model", () => {
  assert.deepEqual(
    validateEvent({ seat: "worker", type: "phase_end", model: "zai-coding-plan/glm-5.2" }),
    { ok: true },
  );
});

test("validateEvent rejects a non-string model", () => {
  const r = validateEvent({ seat: "worker", type: "phase_end", model: 42 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /model must be a string/);
});

// ─── F1: tokensIn (number) ──────────────────────────────────────────────────────

test("validateEvent accepts a numeric tokensIn", () => {
  assert.deepEqual(validateEvent({ seat: "worker", type: "phase_end", tokensIn: 1200000 }), {
    ok: true,
  });
});

test("validateEvent rejects a non-number tokensIn", () => {
  const r = validateEvent({ seat: "worker", type: "phase_end", tokensIn: "1200000" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tokensIn must be a number/);
});

// ─── F1: tokensOut (number) ─────────────────────────────────────────────────────

test("validateEvent accepts a numeric tokensOut", () => {
  assert.deepEqual(validateEvent({ seat: "worker", type: "phase_end", tokensOut: 4 }), {
    ok: true,
  });
});

test("validateEvent rejects a non-number tokensOut", () => {
  const r = validateEvent({ seat: "worker", type: "phase_end", tokensOut: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tokensOut must be a number/);
});

// ─── F1: tokensReasoning (number | null — best effort) ──────────────────────────

test("validateEvent accepts a numeric tokensReasoning", () => {
  assert.deepEqual(validateEvent({ seat: "worker", type: "phase_end", tokensReasoning: 300 }), {
    ok: true,
  });
});

test("validateEvent accepts an explicit null tokensReasoning (provider did not split it)", () => {
  assert.deepEqual(
    validateEvent({ seat: "worker", type: "phase_end", tokensReasoning: null }),
    { ok: true },
  );
});

test("validateEvent rejects a non-number, non-null tokensReasoning", () => {
  const r = validateEvent({ seat: "worker", type: "phase_end", tokensReasoning: "300" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tokensReasoning must be a number or null/);
});

// ─── F1: durationMs (number, on phase_end) ──────────────────────────────────────

test("validateEvent accepts a numeric durationMs", () => {
  assert.deepEqual(validateEvent({ seat: "worker", type: "phase_end", durationMs: 820000 }), {
    ok: true,
  });
});

test("validateEvent rejects a non-number durationMs", () => {
  const r = validateEvent({ seat: "worker", type: "phase_end", durationMs: "820000" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /durationMs must be a number/);
});

// ─── F1: a fully-populated modern phase_end still validates ─────────────────────

test("validateEvent accepts a fully-populated modern phase_end event", () => {
  assert.deepEqual(
    validateEvent({
      seat: "worker",
      type: "phase_end",
      detail: "external:zai-coding-plan/glm-5.2",
      model: "zai-coding-plan/glm-5.2",
      tokens: 1336911,
      tokensIn: 1300000,
      tokensOut: 36911,
      tokensReasoning: null,
      durationMs: 820000,
      costUsd: 0,
    }),
    { ok: true },
  );
});

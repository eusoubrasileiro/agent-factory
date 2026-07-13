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
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

// ─── Cost attribution: cache tokens + api-basis cost (factory-cost Stage 1b) ───

test("validateEvent accepts a numeric tokensCacheRead", () => {
  assert.deepEqual(validateEvent({ seat: "worker", type: "phase_end", tokensCacheRead: 19000 }), {
    ok: true,
  });
});

test("validateEvent rejects a non-number tokensCacheRead", () => {
  const r = validateEvent({ seat: "worker", type: "phase_end", tokensCacheRead: "19000" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tokensCacheRead must be a number/);
});

test("validateEvent accepts a numeric tokensCacheWrite", () => {
  assert.deepEqual(validateEvent({ seat: "worker", type: "phase_end", tokensCacheWrite: 0 }), {
    ok: true,
  });
});

test("validateEvent rejects a non-number tokensCacheWrite", () => {
  const r = validateEvent({ seat: "worker", type: "phase_end", tokensCacheWrite: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tokensCacheWrite must be a number/);
});

test("validateEvent accepts a numeric apiCostUsd (the un-dropped public-API cost)", () => {
  assert.deepEqual(validateEvent({ seat: "worker", type: "phase_end", apiCostUsd: 0.42 }), {
    ok: true,
  });
});

test("validateEvent rejects a non-number apiCostUsd", () => {
  const r = validateEvent({ seat: "worker", type: "phase_end", apiCostUsd: "0.42" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /apiCostUsd must be a number/);
});

// ─── F1: a fully-populated modern phase_end still validates ─────────────────────

test("validateEvent accepts a fully-populated modern phase_end event", () => {
  assert.deepEqual(
    validateEvent({
      seat: "worker",
      type: "phase_end",
      detail: "external:claude-opus-4-8",
      model: "claude-opus-4-8",
      tokens: 1336911,
      tokensIn: 60477,
      tokensOut: 11881,
      tokensReasoning: 10238,
      tokensCacheRead: 19008,
      tokensCacheWrite: 0,
      durationMs: 820000,
      costUsd: 0,
      apiCostUsd: 0.4231,
    }),
    { ok: true },
  );
});

// ─── CLI: misrouted telemetry must be visible ────────────────────────────────
//
// `record` mkdirs the mission dir. That is right for a new mission and wrong for
// a wrong/omitted --project, where the KPI instrument silently writes into
// another project's tree. Soft-fail (exit 0, keep going) but never silent.

function runMetrics(args, cwd) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "metrics.mjs");
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    input: '{"seat":"worker","type":"phase_start","detail":"x"}',
    env: { ...process.env, FACTORY_ROOT: cwd },
  });
}

test("CLI record: warns on stderr when it has to invent the mission dir", () => {
  const root = mkdtempSync(path.join(tmpdir(), "metrics-misroute-"));
  try {
    mkdirSync(path.join(root, "missions"), { recursive: true });
    const r = runMetrics(["record", "some-slug", "--dir", path.join(root, "missions")], root);
    assert.equal(r.status, 0, "telemetry must never block a mission");
    assert.match(r.stderr, /creating a new mission dir/);
    assert.match(r.stderr, /--project|FACTORY_PROJECT/, "the warning must name the likely cause");
    assert.match(r.stdout, /recorded phase_start/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI record: stays quiet when the mission dir already exists", () => {
  const root = mkdtempSync(path.join(tmpdir(), "metrics-ok-"));
  try {
    const missions = path.join(root, "missions");
    mkdirSync(path.join(missions, "known-slug"), { recursive: true });
    const r = runMetrics(["record", "known-slug", "--dir", missions], root);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /creating a new mission dir/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── E1-e: corrupt-line tolerance (publish-funnel-failopen) ───────────────────
// A torn append from a crashed writer must be skipped, never crash `metrics
// summary` (the KPI meter). Mutation gate: restore the bare `.map(JSON.parse)`
// in readRecords and this test goes red.
test("cmdSummary: a corrupt JSONL line is skipped, never crashes the summary (E1-e)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "metrics-corrupt-"));
  try {
    const missions = path.join(root, "missions");
    const slug = "torn-slug";
    mkdirSync(path.join(missions, slug), { recursive: true });
    writeFileSync(
      path.join(missions, slug, "metrics.jsonl"),
      '{"seat":"worker","type":"phase_start","detail":"x"}\n' +
        '{"seat":"worker","type":"phase_en\n' + // torn line, crashed mid-write
        '{"seat":"worker","type":"phase_end","detail":"y"}\n',
    );
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "metrics.mjs");
    const r = spawnSync(process.execPath, [script, "summary", slug, "--dir", missions], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `summary must not crash on a torn line: ${r.stderr}`);
    assert.match(r.stdout, /torn-slug: 2 event\(s\)/); // both valid records counted, corrupt skipped
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

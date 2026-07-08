/**
 * Tests for the mission-stats collector (mission-stats.mjs).
 *
 * Run: node --test scripts/mission-stats.test.mjs
 *
 * Pure-function tests over the deterministic parsers (numstat, diff, metrics
 * pairing). The git-driven `collect` IO shell is exercised by the acceptance
 * run against the real scrumban-board mission on disk.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collect,
  countTestsAdded,
  diffBaselineKeys,
  isExcludedPath,
  isTestFile,
  parseNumstat,
  seatDuration,
  seatModel,
  seatTokens,
} from "./mission-stats.mjs";

// ─── isExcludedPath ─────────────────────────────────────────────────────────

test("isExcludedPath excludes lockfile + factory/dossier state, keeps product code", () => {
  assert.equal(isExcludedPath("pnpm-lock.yaml"), true);
  assert.equal(isExcludedPath("factory/RUNBOOK.md"), true);
  assert.equal(isExcludedPath("factory/missions/x/brief.md"), true);
  assert.equal(isExcludedPath("missions/wahub/x/metrics.jsonl"), true);
  assert.equal(isExcludedPath("history.jsonl"), true);
  // real product code is kept
  assert.equal(isExcludedPath("backend/src/services/foo.ts"), false);
  assert.equal(isExcludedPath("scripts/factory/board-sync.mjs"), false);
});

// ─── parseNumstat ───────────────────────────────────────────────────────────

test("parseNumstat sums added/deleted/files applying the exclusion", () => {
  const text = [
    "10\t2\tbackend/src/a.ts",
    "5\t0\tbackend/src/b.ts",
    "64\t0\tpnpm-lock.yaml", // excluded
    "24\t3\tfactory/RUNBOOK.md", // excluded
  ].join("\n");
  assert.deepEqual(parseNumstat(text), { added: 15, deleted: 2, files: 2 });
});

test("parseNumstat treats binary (-) rows as zero lines but still a file", () => {
  const text = ["-\t-\tassets/logo.png", "3\t1\tsrc/x.ts"].join("\n");
  assert.deepEqual(parseNumstat(text), { added: 3, deleted: 1, files: 2 });
});

test("parseNumstat on empty input is all zeros", () => {
  assert.deepEqual(parseNumstat(""), { added: 0, deleted: 0, files: 0 });
  assert.deepEqual(parseNumstat(null), { added: 0, deleted: 0, files: 0 });
});

// ─── isTestFile ─────────────────────────────────────────────────────────────

test("isTestFile matches the four test-path classes", () => {
  assert.equal(isTestFile("backend/src/foo.test.ts"), true);
  assert.equal(isTestFile("frontend/src/Comp.test.tsx"), true);
  assert.equal(isTestFile("backend/src/foo.spec.ts"), true);
  assert.equal(isTestFile("backend/test/e2e/thing.ts"), true);
  assert.equal(isTestFile("backend/src/foo.ts"), false);
});

// ─── countTestsAdded ──────────────────────────────────────────────────────────

test("countTestsAdded counts added it()/test() lines only in test files", () => {
  const diff = [
    "diff --git a/backend/src/foo.test.ts b/backend/src/foo.test.ts",
    "+++ b/backend/src/foo.test.ts",
    '+it("returns X when Y", () => {',
    '+  test("nested", () => {});',
    "+  const notATest = 1;",
    "diff --git a/backend/src/foo.ts b/backend/src/foo.ts",
    "+++ b/backend/src/foo.ts",
    "+export function it() {}", // NOT a test file → ignored
  ].join("\n");
  assert.equal(countTestsAdded(diff), 2);
});

test("countTestsAdded ignores context/removed lines and the +++ header", () => {
  const diff = [
    "+++ b/x.test.ts",
    ' it("existing untouched context")',
    '-it("removed test")',
    '+it("added test")',
  ].join("\n");
  assert.equal(countTestsAdded(diff), 1);
});

test("countTestsAdded on empty diff is 0", () => {
  assert.equal(countTestsAdded(""), 0);
  assert.equal(countTestsAdded(null), 0);
});

// ─── seatTokens ───────────────────────────────────────────────────────────────

test("seatTokens uses the split when present, else the legacy tokens total", () => {
  const records = [
    { seat: "worker", type: "phase_end", tokensIn: 1200, tokensOut: 300, tokensReasoning: 50 },
    { seat: "worker", type: "phase_end", tokensIn: 800, tokensOut: 100, tokensReasoning: 10 },
  ];
  assert.deepEqual(seatTokens(records, "worker"), {
    in: 2000,
    out: 400,
    reasoning: 60,
    total: 2400,
  });
});

test("seatTokens falls back to legacy tokens and reports reasoning=null", () => {
  const records = [
    { seat: "worker", type: "phase_end", tokens: 1336911 },
    { seat: "validator", type: "phase_end", tokens: 1022785 },
  ];
  assert.deepEqual(seatTokens(records, "worker"), {
    in: 0,
    out: 0,
    reasoning: null,
    total: 1336911,
  });
  assert.equal(seatTokens(records, "validator").total, 1022785);
});

test("seatTokens on no records is zeros/null", () => {
  assert.deepEqual(seatTokens([], "worker"), { in: 0, out: 0, reasoning: null, total: 0 });
});

// ─── seatDuration ─────────────────────────────────────────────────────────────

test("seatDuration prefers durationMs on phase_end", () => {
  const records = [
    { seat: "worker", type: "phase_start", ts: "2026-07-07T19:00:00.000Z" },
    { seat: "worker", type: "phase_end", ts: "2026-07-07T19:41:48.000Z", durationMs: 820000 },
  ];
  assert.equal(seatDuration(records, "worker"), 820000);
});

test("seatDuration pairs phase_start/phase_end ts when durationMs is absent", () => {
  const records = [
    { seat: "validator", type: "phase_start", ts: "2026-07-07T19:00:00.000Z" },
    { seat: "validator", type: "phase_end", ts: "2026-07-07T19:00:10.000Z" },
  ];
  assert.equal(seatDuration(records, "validator"), 10000);
});

test("seatDuration returns null when unpaired (phase_end only, no durationMs)", () => {
  const records = [{ seat: "worker", type: "phase_end", ts: "2026-07-07T19:41:48.303Z" }];
  assert.equal(seatDuration(records, "worker"), null);
});

// ─── seatModel ────────────────────────────────────────────────────────────────

test("seatModel prefers the first-class model field", () => {
  const records = [{ seat: "worker", type: "phase_end", model: "glm-5.2", detail: "external:x" }];
  assert.equal(seatModel(records, "worker"), "glm-5.2");
});

test("seatModel falls back to parsing the legacy detail string", () => {
  const records = [
    { seat: "worker", type: "phase_end", detail: "external:zai-coding-plan/glm-5.2" },
  ];
  assert.equal(seatModel(records, "worker"), "zai-coding-plan/glm-5.2");
});

test("seatModel returns null when no seat record carries a model", () => {
  assert.equal(seatModel([], "validator"), null);
});

// ─── diffBaselineKeys ─────────────────────────────────────────────────────────

test("diffBaselineKeys returns the changed/added/removed top-level keys", () => {
  const before = JSON.stringify({ a: 1, b: { x: 1 }, c: 3 });
  const after = JSON.stringify({ a: 1, b: { x: 2 }, d: 4 });
  assert.deepEqual(diffBaselineKeys(before, after).sort(), ["b", "c", "d"]);
});

test("diffBaselineKeys is total on malformed JSON", () => {
  assert.deepEqual(diffBaselineKeys("{bad", "{worse"), []);
});

// ─── collect writes a total stats.json even with nothing on disk ───────────────

test("collect never throws and writes zeros/nulls when inputs are missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mstats-"));
  const missions = path.join(root, "missions", "wahub");
  const slugDir = path.join(missions, "empty-mission");
  mkdirSync(slugDir, { recursive: true });
  const res = collect({
    slug: "empty-mission",
    missionsRoot: missions,
    repoRoot: root, // not a git repo → git returns null
  });
  assert.equal(res.code, 0);
  assert.equal(res.stats.slug, "empty-mission");
  assert.deepEqual(res.stats.loc, { added: 0, deleted: 0, files: 0 });
  assert.equal(res.stats.tokens.total, 0);
  assert.equal(res.stats.models.worker, null);
  assert.equal(res.stats.pr, null);
  assert.equal(res.stats.mergeBase, null);
});

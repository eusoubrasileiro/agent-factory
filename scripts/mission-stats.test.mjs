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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collect,
  countTestsAdded,
  diffBaselineKeys,
  isExcludedPath,
  isTestFile,
  orchestratorWindow,
  parseNumstat,
  seatCost,
  seatDuration,
  seatModel,
  seatTokens,
} from "./mission-stats.mjs";
import { apiCost } from "./lib/pricing.mjs";
import { encodeTranscriptDir } from "./lib/transcript-tokens.mjs";

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
    cacheRead: 0,
    cacheWrite: 0,
    total: 2460,
  });
});

test("seatTokens sums cache read/write first-class across phase_end rows", () => {
  const records = [
    {
      seat: "worker",
      type: "phase_end",
      tokensIn: 60477,
      tokensOut: 11881,
      tokensReasoning: 10238,
      tokensCacheRead: 19008,
      tokensCacheWrite: 0,
    },
  ];
  const s = seatTokens(records, "worker");
  assert.equal(s.cacheRead, 19008);
  assert.equal(s.cacheWrite, 0);
  assert.equal(s.total, 60477 + 11881 + 10238 + 19008); // cache counted in the billable total
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
    cacheRead: 0,
    cacheWrite: 0,
    total: 1336911,
  });
  assert.equal(seatTokens(records, "validator").total, 1022785);
});

test("seatTokens on no records is zeros/null", () => {
  assert.deepEqual(seatTokens([], "worker"), {
    in: 0,
    out: 0,
    reasoning: null,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
});

// ─── seatCost (factory-cost Stage 1e) ─────────────────────────────────────────

test("seatCost prefers the provider-reported apiCostUsd", () => {
  const records = [
    {
      seat: "worker",
      type: "phase_end",
      model: "claude-opus-4-8",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      apiCostUsd: 0.42,
    },
  ];
  const c = seatCost(records, "worker");
  assert.equal(c.api, 0.42); // reported wins over the pricing-table derivation
  assert.equal(c.reported, 0.42);
});

test("seatCost derives from tokens × pricing when no report is present", () => {
  const records = [
    {
      seat: "worker",
      type: "phase_end",
      model: "claude-opus-4-8",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    },
  ];
  const c = seatCost(records, "worker");
  assert.equal(c.api, 5 + 25); // $30 derived at sticker rates
  assert.equal(c.reported, null);
  assert.equal(c.derived, 30);
});

test("seatCost: unknown model (glm) with no report → api null (sem dados, not a fake 0)", () => {
  const records = [
    { seat: "worker", type: "phase_end", model: "zai-coding-plan/glm-5.2", tokensIn: 1_000_000, tokensOut: 1_000_000 },
  ];
  const c = seatCost(records, "worker");
  assert.equal(c.api, null);
  assert.equal(c.derived, null);
});

test("seatCost on no records → all null/zero", () => {
  const c = seatCost([], "worker");
  assert.equal(c.api, null);
  assert.equal(c.derived, null);
  assert.equal(c.reported, null);
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

test("seatModel ignores a free-text (non external:) detail note", () => {
  const records = [
    { seat: "worker", type: "phase_start", detail: "coordinator-authored build (Critical File)" },
    { seat: "worker", type: "phase_end", detail: "F1/F2/F3 done; acceptance green" },
  ];
  assert.equal(seatModel(records, "worker"), null);
});

// ─── orchestratorWindow (factory-cost Stage 2) ────────────────────────────────

test("orchestratorWindow spans the earliest start to the latest end", () => {
  const records = [
    { seat: "orchestrator", type: "phase_start", ts: "2026-07-10T10:00:00.000Z" },
    { seat: "worker", type: "phase_start", ts: "2026-07-10T09:00:00.000Z" }, // other seat ignored
    { seat: "orchestrator", type: "phase_end", ts: "2026-07-10T10:30:00.000Z" },
  ];
  assert.deepEqual(orchestratorWindow(records), {
    sinceMs: Date.parse("2026-07-10T10:00:00.000Z"),
    untilMs: Date.parse("2026-07-10T10:30:00.000Z"),
  });
});

test("orchestratorWindow takes min(starts) and max(ends) across multiple pairs", () => {
  const records = [
    { seat: "orchestrator", type: "phase_start", ts: "2026-07-10T11:00:00.000Z" },
    { seat: "orchestrator", type: "phase_start", ts: "2026-07-10T09:00:00.000Z" },
    { seat: "orchestrator", type: "phase_end", ts: "2026-07-10T09:30:00.000Z" },
    { seat: "orchestrator", type: "phase_end", ts: "2026-07-10T12:00:00.000Z" },
  ];
  assert.deepEqual(orchestratorWindow(records), {
    sinceMs: Date.parse("2026-07-10T09:00:00.000Z"),
    untilMs: Date.parse("2026-07-10T12:00:00.000Z"),
  });
});

test("orchestratorWindow returns null when there is no orchestrator start", () => {
  const records = [{ seat: "orchestrator", type: "phase_end", ts: "2026-07-10T10:30:00.000Z" }];
  assert.equal(orchestratorWindow(records), null);
});

test("orchestratorWindow returns null when there is no orchestrator end", () => {
  const records = [{ seat: "orchestrator", type: "phase_start", ts: "2026-07-10T10:00:00.000Z" }];
  assert.equal(orchestratorWindow(records), null);
});

test("orchestratorWindow returns null on no records / malformed ts", () => {
  assert.equal(orchestratorWindow([]), null);
  assert.equal(
    orchestratorWindow([
      { seat: "orchestrator", type: "phase_start", ts: "not-a-date" },
      { seat: "orchestrator", type: "phase_end", ts: "not-a-date" },
    ]),
    null,
  );
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
  assert.equal(res.stats.escalations, 0);
});

test("collect counts escalations + attention and reads the token split from metrics.jsonl", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mstats-esc-"));
  const missions = path.join(root, "missions", "wahub");
  const slugDir = path.join(missions, "escalated");
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    path.join(slugDir, "metrics.jsonl"),
    [
      JSON.stringify({ seat: "worker", type: "phase_end", tokens: 100, model: "glm-5.2" }),
      JSON.stringify({ seat: "orchestrator", type: "escalation" }),
      JSON.stringify({ seat: "human", type: "touchpoint" }),
      JSON.stringify({ seat: "orchestrator", type: "escalation" }),
    ].join("\n") + "\n",
  );
  const res = collect({ slug: "escalated", missionsRoot: missions, repoRoot: root });
  assert.equal(res.stats.escalations, 2);
  assert.equal(res.stats.attention, 3); // 2 escalations + 1 touchpoint
  assert.equal(res.stats.tokens.worker.total, 100);
  assert.equal(res.stats.models.worker, "glm-5.2");
});

test("collect rolls cost + orchestrator bucket + durations.total into stats.json", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mstats-cost-"));
  const missions = path.join(root, "missions", "wahub");
  const slugDir = path.join(missions, "costed");
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    path.join(slugDir, "metrics.jsonl"),
    [
      JSON.stringify({
        seat: "worker",
        type: "phase_start",
        detail: "external:claude-opus-4-8",
        model: "claude-opus-4-8",
        ts: "2026-07-10T10:00:00.000Z",
      }),
      JSON.stringify({
        seat: "worker",
        type: "phase_end",
        model: "claude-opus-4-8",
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        tokensCacheRead: 1_000_000,
        durationMs: 600_000,
        apiCostUsd: 30.5,
        ts: "2026-07-10T10:10:00.000Z",
      }),
    ].join("\n") + "\n",
  );
  const res = collect({ slug: "costed", missionsRoot: missions, repoRoot: root });
  // worker cost: reported apiCostUsd preferred
  assert.equal(res.stats.cost.worker.api, 30.5);
  assert.equal(res.stats.cost.total.api, 30.5);
  // orchestrator bucket exists, zero until Stage 2
  assert.equal(res.stats.tokens.orchestrator.total, 0);
  assert.equal(res.stats.cost.orchestrator.api, null);
  // durations gain orchestrating + total
  assert.equal(res.stats.durations.building, 600_000);
  assert.equal(res.stats.durations.orchestrating, null);
  assert.equal(res.stats.durations.total, 600_000);
});

// ─── orchestrator transcript attribution (factory-cost Stage 2) ──────────────

test("collect fills the orchestrator bucket from the session transcript within its phase window", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mstats-orch-"));
  const missions = path.join(root, "missions", "wahub");
  const slugDir = path.join(missions, "orch-filled");
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    path.join(slugDir, "metrics.jsonl"),
    [
      JSON.stringify({ seat: "orchestrator", type: "phase_start", ts: "2026-07-10T10:00:00.000Z" }),
      JSON.stringify({
        seat: "worker",
        type: "phase_end",
        model: "claude-opus-4-8",
        tokensIn: 100,
        tokensOut: 20,
        ts: "2026-07-10T10:05:00.000Z",
      }),
      JSON.stringify({ seat: "orchestrator", type: "phase_end", ts: "2026-07-10T10:30:00.000Z" }),
    ].join("\n") + "\n",
  );

  const orchestratorCwd = "/home/andre/Projects/amiticia/repositories/tools/factory";
  const transcriptRoot = mkdtempSync(path.join(tmpdir(), "transcript-root-"));
  const transcriptDir = path.join(transcriptRoot, encodeTranscriptDir(orchestratorCwd));
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    path.join(transcriptDir, "session-a.jsonl"),
    [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-10T10:10:00.000Z",
        message: {
          model: "claude-opus-4-8",
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-10T10:20:00.000Z",
        message: {
          model: "claude-opus-4-8",
          usage: { input_tokens: 500, output_tokens: 100 },
        },
      }),
      JSON.stringify({
        // outside the orchestrator window — must NOT be counted
        type: "assistant",
        timestamp: "2026-07-10T11:00:00.000Z",
        message: { model: "claude-opus-4-8", usage: { input_tokens: 999_999, output_tokens: 999_999 } },
      }),
    ].join("\n") + "\n",
  );

  const res = collect({
    slug: "orch-filled",
    missionsRoot: missions,
    repoRoot: root,
    factoryRoot: root,
    transcriptRoot,
    orchestratorCwd,
  });

  const expectedIn = 1000 + 500;
  const expectedOut = 200 + 100;
  const expectedCacheRead = 300;
  const expectedCacheWrite = 40;
  const expectedTotal = expectedIn + expectedOut + expectedCacheRead + expectedCacheWrite;

  assert.equal(res.stats.tokens.orchestrator.total, expectedTotal);
  assert.equal(res.stats.tokens.orchestrator.in, expectedIn);
  assert.equal(res.stats.tokens.orchestrator.out, expectedOut);
  assert.equal(res.stats.tokens.orchestrator.cacheRead, expectedCacheRead);
  assert.equal(res.stats.tokens.orchestrator.cacheWrite, expectedCacheWrite);
  assert.equal(res.stats.models.orchestrator, "claude-opus-4-8");

  const expectedCost = apiCost("claude-opus-4-8", res.stats.tokens.orchestrator);
  assert.ok(typeof expectedCost === "number" && expectedCost > 0);
  assert.equal(res.stats.cost.orchestrator.api, expectedCost);
  assert.equal(res.stats.cost.orchestrator.derived, expectedCost);
  assert.equal(res.stats.cost.orchestrator.reported, null);

  // window length: 10:00 -> 10:30 = 30 minutes (no durationMs on the orchestrator
  // phase_end, so seatDuration pairs start/end ts — same 30-minute figure).
  assert.equal(res.stats.durations.orchestrating, 30 * 60 * 1000);

  // totals recomputed to include the orchestrator contribution
  assert.equal(
    res.stats.tokens.total,
    res.stats.tokens.worker.total + res.stats.tokens.validator.total + expectedTotal,
  );
  assert.ok(res.stats.cost.total.api >= expectedCost);
});

test("collect leaves the orchestrator bucket at zero when there is no orchestrator phase window", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mstats-orch-nowin-"));
  const missions = path.join(root, "missions", "wahub");
  const slugDir = path.join(missions, "orch-nowin");
  mkdirSync(slugDir, { recursive: true });
  // No orchestrator phase_start/phase_end at all.
  writeFileSync(
    path.join(slugDir, "metrics.jsonl"),
    JSON.stringify({ seat: "worker", type: "phase_end", tokens: 100, model: "glm-5.2" }) + "\n",
  );

  const orchestratorCwd = "/home/andre/Projects/amiticia/repositories/tools/factory";
  const transcriptRoot = mkdtempSync(path.join(tmpdir(), "transcript-root-nowin-"));
  const transcriptDir = path.join(transcriptRoot, encodeTranscriptDir(orchestratorCwd));
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    path.join(transcriptDir, "session-a.jsonl"),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T10:10:00.000Z",
      message: { model: "claude-opus-4-8", usage: { input_tokens: 1000, output_tokens: 200 } },
    }) + "\n",
  );

  const res = collect({
    slug: "orch-nowin",
    missionsRoot: missions,
    repoRoot: root,
    factoryRoot: root,
    transcriptRoot,
    orchestratorCwd,
  });

  assert.deepEqual(res.stats.tokens.orchestrator, {
    in: 0,
    out: 0,
    reasoning: null,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
  assert.equal(res.stats.cost.orchestrator.api, null);
  assert.equal(res.stats.models.orchestrator, null);
  assert.equal(res.stats.durations.orchestrating, null);
});

test("collect degrades gracefully when the orchestrator window exists but the transcript dir is missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mstats-orch-nodir-"));
  const missions = path.join(root, "missions", "wahub");
  const slugDir = path.join(missions, "orch-nodir");
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    path.join(slugDir, "metrics.jsonl"),
    [
      JSON.stringify({ seat: "orchestrator", type: "phase_start", ts: "2026-07-10T10:00:00.000Z" }),
      JSON.stringify({ seat: "orchestrator", type: "phase_end", ts: "2026-07-10T10:30:00.000Z" }),
    ].join("\n") + "\n",
  );

  const transcriptRoot = mkdtempSync(path.join(tmpdir(), "transcript-root-missing-"));
  // Note: no subdirectory created for the orchestratorCwd → dir doesn't exist.

  const res = collect({
    slug: "orch-nodir",
    missionsRoot: missions,
    repoRoot: root,
    factoryRoot: root,
    transcriptRoot,
    orchestratorCwd: "/some/cwd/that/has/no/transcript",
  });

  assert.equal(res.stats.tokens.orchestrator.total, 0);
  assert.equal(res.stats.cost.orchestrator.api, null);
  // durations still degrade to the window length even without transcript usage,
  // since seatDuration already pairs the phase_start/phase_end ts (same figure).
  assert.equal(res.stats.durations.orchestrating, 30 * 60 * 1000);
});

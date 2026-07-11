/**
 * Tests for orchestrator transcript attribution (transcript-tokens.mjs).
 *
 * Run: node --test scripts/lib/transcript-tokens.test.mjs
 *
 * Pure tests over `transcriptUsage` (windowed usage sum from parsed rows) and
 * `encodeTranscriptDir` (cwd → ~/.claude/projects/<encoded>). The I/O discovery
 * is exercised against a tmpdir.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { transcriptUsage, encodeTranscriptDir, loadTranscriptUsage } from "./transcript-tokens.mjs";

// ─── transcriptUsage ─────────────────────────────────────────────────────────

test("transcriptUsage sums assistant usage rows + picks the model", () => {
  const rows = [
    { type: "user", message: {} },
    {
      type: "assistant",
      timestamp: "2026-07-10T10:05:00.000Z",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
      },
    },
    {
      type: "assistant",
      timestamp: "2026-07-10T10:10:00.000Z",
      message: { model: "claude-opus-4-8", usage: { input_tokens: 200, output_tokens: 5 } },
    },
  ];
  const u = transcriptUsage(rows);
  assert.equal(u.in, 300);
  assert.equal(u.out, 25);
  assert.equal(u.cacheRead, 50);
  assert.equal(u.cacheWrite, 10);
  assert.equal(u.total, 300 + 25 + 50 + 10);
  assert.equal(u.model, "claude-opus-4-8");
  assert.equal(u.reasoning, null, "Claude usage folds reasoning into output_tokens");
});

test("transcriptUsage filters by [sinceMs, untilMs] window", () => {
  const rows = [
    { type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { usage: { input_tokens: 100 } } },
    { type: "assistant", timestamp: "2026-07-10T11:00:00Z", message: { usage: { input_tokens: 200 } } },
    { type: "assistant", timestamp: "2026-07-10T12:00:00Z", message: { usage: { input_tokens: 300 } } },
  ];
  const u = transcriptUsage(rows, {
    sinceMs: Date.parse("2026-07-10T10:30:00Z"),
    untilMs: Date.parse("2026-07-10T11:30:00Z"),
  });
  assert.equal(u.in, 200); // only the 11:00 row
});

test("transcriptUsage on empty / no-assistant rows → zeros, model null", () => {
  assert.deepEqual(transcriptUsage([]), {
    in: 0,
    out: 0,
    reasoning: null,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    model: null,
  });
  assert.equal(transcriptUsage([{ type: "assistant", message: {} }]).in, 0);
});

test("transcriptUsage tolerates malformed rows (never throws)", () => {
  assert.doesNotThrow(() =>
    transcriptUsage([null, {}, { type: "assistant" }, { type: "assistant", message: { usage: "nope" } }]),
  );
});

// ─── encodeTranscriptDir ─────────────────────────────────────────────────────

test("encodeTranscriptDir: cwd → encoded segment matching Claude Code's layout", () => {
  assert.equal(
    encodeTranscriptDir("/home/andre/Projects/amiticia/repositories/tools/factory"),
    "-home-andre-Projects-amiticia-repositories-tools-factory",
  );
  // worktree variant: `.claude/worktrees` becomes `-claude-worktrees` (dot → dash)
  assert.equal(
    encodeTranscriptDir("/home/andre/Projects/amiticia/repositories/tools/factory/.claude/worktrees/abc"),
    "-home-andre-Projects-amiticia-repositories-tools-factory--claude-worktrees-abc",
  );
});

// ─── loadTranscriptUsage (I/O, best-effort) ───────────────────────────────────

test("loadTranscriptUsage: reads every .jsonl in the dir, sums the window", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "transcript-"));
  try {
    writeFileSync(
      path.join(dir, "session-a.jsonl"),
      [
        JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:05:00Z", message: { model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 10 } } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-07-10T12:00:00Z", message: { usage: { input_tokens: 999 } } }), // outside window
      ].join("\n") + "\n",
    );
    writeFileSync(
      path.join(dir, "session-b.jsonl"),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:20:00Z", message: { usage: { input_tokens: 50 } } }) + "\n",
    );
    const u = loadTranscriptUsage(dir, {
      sinceMs: Date.parse("2026-07-10T10:00:00Z"),
      untilMs: Date.parse("2026-07-10T11:00:00Z"),
    });
    assert.equal(u.in, 150); // 100 + 50; the 999 row is outside the window
    assert.equal(u.model, "claude-opus-4-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadTranscriptUsage: missing dir → zeros (graceful, telemetry never blocks)", () => {
  const u = loadTranscriptUsage("/does/not/exist", {});
  assert.equal(u.total, 0);
  assert.equal(u.model, null);
});

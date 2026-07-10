/**
 * Tests for the external-agent seat driver (opencode-worker.mjs).
 *
 * Run: node --test scripts/factory/opencode-worker.test.mjs
 *
 * These are pure-function tests over a CAPTURED opencode `--format json`
 * stream — no live opencode call, so they are free and deterministic.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildPhaseEndEvent,
  buildPhaseStartEvent,
  buildSpawnEnv,
  isWorktreeDir,
  parseOpencodeStream,
  SPAWN_ENV_ALLOWLIST,
} from "./opencode-worker.mjs";

// A real `opencode run ... --format json` stream captured 2026-07-07 from
// `zai-coding-plan/glm-5.2`, with a stray non-JSON watcher warning prepended
// to prove the parser tolerates a merged stdout/stderr stream.
const CAPTURED_STREAM = [
  "error: inotify_add_watch on '/x/.git/worktrees/y' failed: No space left on device",
  '{"type":"step_start","timestamp":1,"sessionID":"ses_ABC","part":{"id":"p1","type":"step-start"}}',
  '{"type":"text","timestamp":2,"sessionID":"ses_ABC","part":{"id":"p2","type":"text","text":"PONG"}}',
  '{"type":"step_finish","timestamp":3,"sessionID":"ses_ABC","part":{"id":"p3","reason":"stop","type":"step-finish","tokens":{"total":14651,"input":12343,"output":4,"reasoning":0,"cache":{"write":0,"read":2304}},"cost":0}}',
].join("\n");

test("parseOpencodeStream extracts final text, tokens, cost, session", () => {
  const r = parseOpencodeStream(CAPTURED_STREAM);
  assert.equal(r.finalText, "PONG");
  assert.equal(r.tokens, 14651);
  assert.equal(r.cost, 0);
  assert.equal(r.sessionID, "ses_ABC");
  assert.equal(r.sawFinish, true);
});

// ─── F2: token split (in / out / reasoning) from the opencode stream ────────────

test("parseOpencodeStream extracts the input/output/reasoning token split", () => {
  const r = parseOpencodeStream(CAPTURED_STREAM);
  assert.equal(r.tokensIn, 12343);
  assert.equal(r.tokensOut, 4);
  assert.equal(r.tokensReasoning, 0);
});

test("parseOpencodeStream sums the token split across multiple steps", () => {
  const stream = [
    '{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","tokens":{"total":100,"input":80,"output":15,"reasoning":5},"cost":0}}',
    '{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","tokens":{"total":50,"input":40,"output":8,"reasoning":2},"cost":0}}',
  ].join("\n");
  const r = parseOpencodeStream(stream);
  assert.equal(r.tokensIn, 120);
  assert.equal(r.tokensOut, 23);
  assert.equal(r.tokensReasoning, 7);
});

test("parseOpencodeStream reports tokensReasoning=null when the provider omits the split", () => {
  const stream = [
    '{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","tokens":{"total":10},"cost":0}}',
  ].join("\n");
  const r = parseOpencodeStream(stream);
  assert.equal(r.tokens, 10);
  assert.equal(r.tokensIn, 0);
  assert.equal(r.tokensOut, 0);
  assert.equal(r.tokensReasoning, null);
});

// ─── F2: metric event builders (phase_start at spawn, model first-class) ────────

test("buildPhaseStartEvent emits a phase_start with model first-class + legacy detail", () => {
  const ev = buildPhaseStartEvent("worker", "zai-coding-plan/glm-5.2");
  assert.equal(ev.seat, "worker");
  assert.equal(ev.type, "phase_start");
  assert.equal(ev.model, "zai-coding-plan/glm-5.2");
  assert.equal(ev.detail, "external:zai-coding-plan/glm-5.2");
});

test("buildPhaseStartEvent maps any non-validator seat to worker", () => {
  assert.equal(buildPhaseStartEvent("validator", "m").seat, "validator");
  assert.equal(buildPhaseStartEvent(undefined, "m").seat, "worker");
});

test("buildPhaseEndEvent carries model, durationMs and the token split", () => {
  const ev = buildPhaseEndEvent("worker", "zai-coding-plan/glm-5.2", {
    tokens: 14651,
    tokensIn: 12343,
    tokensOut: 4,
    tokensReasoning: 0,
    cost: 0,
    durationMs: 820000,
  });
  assert.equal(ev.seat, "worker");
  assert.equal(ev.type, "phase_end");
  assert.equal(ev.model, "zai-coding-plan/glm-5.2");
  assert.equal(ev.detail, "external:zai-coding-plan/glm-5.2");
  assert.equal(ev.tokens, 14651);
  assert.equal(ev.tokensIn, 12343);
  assert.equal(ev.tokensOut, 4);
  assert.equal(ev.tokensReasoning, 0);
  assert.equal(ev.durationMs, 820000);
  assert.equal(ev.costUsd, 0);
});

test("buildPhaseEndEvent keeps tokensReasoning=null (unknown) when provider omitted it", () => {
  const ev = buildPhaseEndEvent("validator", "m", {
    tokens: 5,
    tokensIn: 0,
    tokensOut: 0,
    tokensReasoning: null,
    cost: 0,
    durationMs: 1000,
  });
  assert.equal(ev.tokensReasoning, null);
  assert.equal(ev.seat, "validator");
});

test("buildPhaseEndEvent carries cache tokens + apiCostUsd (factory-cost Stage 1c)", () => {
  const ev = buildPhaseEndEvent("worker", "claude-opus-4-8", {
    tokensIn: 60477,
    tokensOut: 11881,
    tokensCacheRead: 19008,
    tokensCacheWrite: 0,
    apiCostUsd: 0.4231,
    durationMs: 820000,
  });
  assert.equal(ev.tokensCacheRead, 19008);
  assert.equal(ev.tokensCacheWrite, 0);
  assert.equal(ev.apiCostUsd, 0.4231);
  // legacy mirror stays in sync until old consumers are gone
  assert.equal(ev.costUsd, 0.4231);
});

test("buildPhaseEndEvent maps legacy `cost` → apiCostUsd when apiCostUsd is absent", () => {
  const ev = buildPhaseEndEvent("worker", "zai-coding-plan/glm-5.2", {
    cost: 0.0012,
    durationMs: 1000,
  });
  assert.equal(ev.apiCostUsd, 0.0012);
  assert.equal(ev.costUsd, 0.0012);
  // cache tiers default to 0 when the provider reports none (opencode/glm)
  assert.equal(ev.tokensCacheRead, 0);
  assert.equal(ev.tokensCacheWrite, 0);
});

test("parseOpencodeStream concatenates multiple text parts in order", () => {
  const stream = [
    '{"type":"text","sessionID":"s","part":{"type":"text","text":"Hello, "}}',
    '{"type":"text","sessionID":"s","part":{"type":"text","text":"world"}}',
    '{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","tokens":{"total":5},"cost":0.0012}}',
  ].join("\n");
  const r = parseOpencodeStream(stream);
  assert.equal(r.finalText, "Hello, world");
  assert.equal(r.tokens, 5);
  assert.equal(r.cost, 0.0012);
});

test("parseOpencodeStream sums tokens/cost across multiple steps", () => {
  const stream = [
    '{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","tokens":{"total":100},"cost":0.01}}',
    '{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","tokens":{"total":250},"cost":0.02}}',
  ].join("\n");
  const r = parseOpencodeStream(stream);
  assert.equal(r.tokens, 350);
  assert.equal(Number(r.cost.toFixed(4)), 0.03);
  assert.equal(r.sawFinish, true);
});

test("parseOpencodeStream on empty / no-finish stream reports sawFinish false", () => {
  const r = parseOpencodeStream("");
  assert.equal(r.finalText, "");
  assert.equal(r.tokens, 0);
  assert.equal(r.sawFinish, false);
  assert.equal(r.sessionID, null);

  const noFinish = parseOpencodeStream(
    '{"type":"text","sessionID":"s","part":{"type":"text","text":"partial"}}',
  );
  assert.equal(noFinish.finalText, "partial");
  assert.equal(noFinish.sawFinish, false);
});

test("parseOpencodeStream skips malformed JSON lines without throwing", () => {
  const stream = [
    "not json at all",
    "{ broken",
    '{"type":"text","sessionID":"s","part":{"type":"text","text":"ok"}}',
    '{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","tokens":{"total":1},"cost":0}}',
  ].join("\n");
  const r = parseOpencodeStream(stream);
  assert.equal(r.finalText, "ok");
  assert.equal(r.sawFinish, true);
});

test("isWorktreeDir accepts a dispatched worktree, rejects the main tree", () => {
  assert.equal(
    isWorktreeDir(
      "/home/andre/Projects/amiticia/repositories/products/wahub/.claude/worktrees/scrumban-board",
    ),
    true,
  );
  assert.equal(isWorktreeDir("/home/andre/Projects/amiticia/repositories/products/wahub"), false);
  assert.equal(isWorktreeDir("/tmp/somewhere"), false);
});

// ─── F2: spawn env allowlist (W1 — external seats never inherit real secrets) ──

test("buildSpawnEnv drops secrets and keeps only allowlisted vars", () => {
  const env = buildSpawnEnv({
    PATH: "/usr/bin",
    HOME: "/home/andre",
    LANG: "en_US.UTF-8",
    XDG_DATA_HOME: "/home/andre/.local/share",
    XDG_CONFIG_DIRS: "/etc/xdg",
    // secrets that must NOT pass through:
    SUPABASE_SERVICE_ROLE_KEY: "real-service-role-key",
    WABA_TOKEN_KEY: "deadbeef".repeat(8),
    OPENAI_API_KEY: "sk-real",
    OPENROUTER_API_KEY: "or-real",
    DATABASE_URL: "postgresql://real:secret@prod/db",
  });
  const keys = Object.keys(env);
  // every returned key is allowlisted or XDG_*
  for (const k of keys) {
    assert.ok(SPAWN_ENV_ALLOWLIST.includes(k) || k.startsWith("XDG_"), `unexpected key: ${k}`);
  }
  // secrets are gone
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(env.WABA_TOKEN_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test("buildSpawnEnv passes HOME through (z.ai auth is $HOME-relative)", () => {
  const env = buildSpawnEnv({ HOME: "/home/andre", NOTALLOWED: "x" });
  assert.equal(env.HOME, "/home/andre");
  assert.equal(env.NOTALLOWED, undefined);
});

test("buildSpawnEnv skips undefined values", () => {
  const env = buildSpawnEnv({ PATH: undefined, HOME: "/h" });
  assert.equal("PATH" in env, false);
  assert.equal(env.HOME, "/h");
});

// ─── CLI: --project is required AND a known profile (before spawn) ────────────
//
// A forgotten --project used to render a cage with zero Critical-File rules and
// say nothing. The driver now refuses BEFORE it resolves the worktree or spawns
// opencode, so these spawns never reach the `opencode` binary.

function runCli(args) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "opencode-worker.mjs");
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("CLI: no --project is refused (exit 2, stderr lists the known ids)", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "ocw-noproject-"));
  try {
    const r = runCli(["--dir", wt, "--allow-any-dir", "--model", "m", "--prompt", "hi"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /opencode-worker: --project is required/);
    assert.match(r.stderr, /factory/, "the refusal must list the known project ids");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("CLI: an unknown --project is refused (exit 2)", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "ocw-badproject-"));
  try {
    const r = runCli(["--dir", wt, "--allow-any-dir", "--model", "m", "--project", "this-id-does-not-exist", "--prompt", "hi"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /this-id-does-not-exist/);
    assert.match(r.stderr, /factory/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

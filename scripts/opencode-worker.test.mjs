/**
 * Tests for the external-agent seat driver (opencode-worker.mjs).
 *
 * Run: node --test scripts/factory/opencode-worker.test.mjs
 *
 * These are pure-function tests over a CAPTURED opencode `--format json`
 * stream — no live opencode call, so they are free and deterministic.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
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

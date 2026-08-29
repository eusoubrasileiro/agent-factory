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
import { parseArgs, parseOpencodeStream } from "./opencode-worker.mjs";

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

// ─── the gate, wired ─────────────────────────────────────────────────────────
//
// The measurement sequence (filesChanged before the gate) and the exit-code
// folding are shared with the default driver and pinned in
// worker-common.test.mjs. Driver-specific here is only the flag surface — and
// this driver REFUSES on an unknown flag, so a missing case is a hard failure,
// not a silent default-off.

test("parseArgs: --gate and --gate-strict are accepted, not treated as unknown flags", () => {
  const opts = parseArgs(["node", "s", "--dir", "/w", "--model", "p/m", "--prompt", "p", "--gate", "--gate-strict"]);
  assert.ok(!opts._bad);
  assert.equal(opts.gate, true);
  assert.equal(opts.gateStrict, true);
});

test("parseArgs: no gate flag leaves the decision to the profile (null, not false)", () => {
  const opts = parseArgs(["node", "s", "--dir", "/w", "--model", "p/m", "--prompt", "p"]);
  assert.equal(opts.gate, null, "absent flag must be null — false would mean 'the operator said off'");
  assert.equal(opts.gateStrict, false);
});

test("parseArgs: --no-gate is the explicit opt-out, distinct from an absent flag", () => {
  const opts = parseArgs(["node", "s", "--dir", "/w", "--model", "p/m", "--prompt", "p", "--no-gate"]);
  assert.ok(!opts._bad, "--no-gate must be a known flag");
  assert.equal(opts.gate, false);
});

test("parseArgs: --gate-strict implies --gate — strict without the gate would enforce an unmeasured verdict", () => {
  const opts = parseArgs(["node", "s", "--dir", "/w", "--model", "p/m", "--prompt", "p", "--gate-strict"]);
  assert.equal(opts.gate, true);
});

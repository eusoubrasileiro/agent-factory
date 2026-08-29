/**
 * Tests for the caged Claude Code worker seat.
 *
 *   node --test "scripts/claude-worker.test.mjs"
 *
 * The two things that must never silently go wrong:
 *
 *   1. The seat runs on Anthropic's own API by accident, quietly spending real
 *      money on what is supposed to be a flat-rate z.ai plan. `assertExternalEndpoint`
 *      is the guard, and it fails closed.
 *   2. The z.ai token leaks into a log, a metric, or a JSON artifact.
 *
 * Everything else (tokens, session id) is telemetry. `total_cost_usd` IS parsed
 * now (decisions.md D-XX overturns D-13): it is the public-API-basis cost — real $
 * for Anthropic seats, the Anthropic-equivalent comparison figure for flat-plan
 * seats. Surfaced as `apiCostUsd`, never mistaken for cash spend on the flat plan.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_ENV_KEYS,
  METRICS_SCRIPT,
  assertExternalEndpoint,
  assertNoAliasTrap,
  assertSeatEndpoint,
  buildClaudeArgs,
  resolveIdleTimeout,
  buildClaudeEnv,
  detectRateLimit,
  loadSeatCredentials,
  makeSeatConfigDir,
  parseClaudeResult,
  writePlaywrightMcpConfig,
  parseArgs,
} from "./claude-worker.mjs";

// ─── credentials ─────────────────────────────────────────────────────────────

function writeEnvFile(body) {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-seat-"));
  const f = path.join(dir, "zai.env");
  writeFileSync(f, body);
  return { dir, f };
}

test("loadSeatCredentials: parses KEY=value, ignoring comments and blanks", () => {
  const { dir, f } = writeEnvFile(
    "# comment\n\nANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic\nANTHROPIC_AUTH_TOKEN=tok-123\n",
  );
  try {
    const creds = loadSeatCredentials(f);
    assert.equal(creds.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(creds.ANTHROPIC_AUTH_TOKEN, "tok-123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSeatCredentials: strips surrounding quotes", () => {
  const { dir, f } = writeEnvFile('ANTHROPIC_AUTH_TOKEN="tok-quoted"\n');
  try {
    assert.equal(loadSeatCredentials(f).ANTHROPIC_AUTH_TOKEN, "tok-quoted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSeatCredentials: a missing file yields {} and never throws", () => {
  assert.doesNotThrow(() => loadSeatCredentials("/nonexistent/zai.env"));
  assert.deepEqual(loadSeatCredentials("/nonexistent/zai.env"), {});
});

test("loadSeatCredentials: only the known ANTHROPIC_* keys are lifted", () => {
  const { dir, f } = writeEnvFile("ANTHROPIC_AUTH_TOKEN=tok\nSOME_OTHER_SECRET=nope\n");
  try {
    const creds = loadSeatCredentials(f);
    assert.equal(creds.ANTHROPIC_AUTH_TOKEN, "tok");
    assert.ok(!("SOME_OTHER_SECRET" in creds), "an unrelated secret must not be lifted");
    for (const k of Object.keys(creds)) assert.ok(CLAUDE_ENV_KEYS.includes(k));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── third-party-backend escape hatches ──────────────────────────────────────
// Claude Code's non-Anthropic path is actively regressing: it ships
// `thinking:{type:"adaptive"}` to model IDs it does not recognise, which several
// Anthropic-compatible backends answer with a hang, an empty body, or a 400
// (anthropics/claude-code#68551). CLAUDE_CODE_DISABLE_THINKING is the documented
// mitigation and is present in the installed 2.1.250 bundle — but an env key the
// seat allowlist does not carry is silently dropped, so the mitigation would look
// like it was applied and do nothing.

test("CLAUDE_ENV_KEYS carries the third-party-backend escape hatches", () => {
  for (const k of [
    "CLAUDE_CODE_DISABLE_THINKING",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ]) {
    assert.ok(CLAUDE_ENV_KEYS.includes(k), `${k} must survive into the seat env`);
  }
});

test("buildClaudeEnv forwards the escape hatches when the seat sets them", () => {
  const env = buildClaudeEnv({ PATH: "/usr/bin" }, {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: "tok",
    CLAUDE_CODE_DISABLE_THINKING: "1",
    CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.3",
  });
  assert.equal(env.CLAUDE_CODE_DISABLE_THINKING, "1");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "glm-5.3");
});

// ─── the endpoint guard: never spend Anthropic money by accident ─────────────

test("assertExternalEndpoint: accepts the z.ai endpoint", () => {
  assert.doesNotThrow(() =>
    assertExternalEndpoint({
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "tok",
    }),
  );
});

test("assertExternalEndpoint: REFUSES when the base URL is absent", () => {
  // Without a base URL, Claude Code would fall back to Anthropic + Andre's OAuth,
  // i.e. spend real money on a seat that is supposed to be flat-rate.
  assert.throws(() => assertExternalEndpoint({ ANTHROPIC_AUTH_TOKEN: "tok" }), /ANTHROPIC_BASE_URL/);
});

test("assertExternalEndpoint: REFUSES an anthropic.com base URL", () => {
  assert.throws(
    () => assertExternalEndpoint({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_AUTH_TOKEN: "t" }),
    /anthropic\.com/,
  );
  assert.throws(
    () => assertExternalEndpoint({ ANTHROPIC_BASE_URL: "https://API.ANTHROPIC.COM/v1", ANTHROPIC_AUTH_TOKEN: "t" }),
    /anthropic\.com/,
  );
});

test("assertExternalEndpoint: REFUSES when no token is present", () => {
  assert.throws(() => assertExternalEndpoint({ ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" }), /token/i);
});

test("assertExternalEndpoint: never echoes the token in its error", () => {
  const secret = "sk-super-secret-value-9999";
  try {
    assertExternalEndpoint({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_AUTH_TOKEN: secret });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(!String(err.message).includes(secret), "the guard must not leak the token");
  }
});

// ─── child env ───────────────────────────────────────────────────────────────

test("buildClaudeEnv: passes the allowlist plus the ANTHROPIC_* seat credentials", () => {
  const env = buildClaudeEnv(
    { PATH: "/usr/bin", HOME: "/home/a", SUPABASE_SERVICE_ROLE_KEY: "REAL", XDG_DATA_HOME: "/x" },
    { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "tok" },
  );
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/a");
  assert.equal(env.XDG_DATA_HOME, "/x");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "tok");
});

test("buildClaudeEnv: the coordinator's real secrets never reach the child", () => {
  const env = buildClaudeEnv(
    { PATH: "/usr/bin", SUPABASE_SERVICE_ROLE_KEY: "REAL", OPENAI_API_KEY: "sk-real", WABA_TOKEN_KEY: "real" },
    { ANTHROPIC_AUTH_TOKEN: "tok" },
  );
  assert.ok(!("SUPABASE_SERVICE_ROLE_KEY" in env));
  assert.ok(!("OPENAI_API_KEY" in env));
  assert.ok(!("WABA_TOKEN_KEY" in env));
});

test("buildClaudeEnv: a coordinator ANTHROPIC_* var cannot override the seat credential", () => {
  // The coordinator's own session has Anthropic auth. If it leaked through, the
  // seat would bill Anthropic instead of running on the flat z.ai plan.
  const env = buildClaudeEnv(
    { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-andre" },
    { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "tok" },
  );
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic", "seat creds win");
  assert.ok(!("ANTHROPIC_API_KEY" in env), "the coordinator's key must not survive");
});

// ─── result parsing ──────────────────────────────────────────────────────────

const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  session_id: "abc-123",
  total_cost_usd: 0.42,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  permission_denials: [],
});

test("parseClaudeResult: extracts tokens, session id, and cache split first-class", () => {
  const r = parseClaudeResult(RESULT);
  assert.equal(r.sessionID, "abc-123");
  assert.equal(r.tokensIn, 10);
  assert.equal(r.tokensOut, 5);
  assert.equal(r.tokensCacheRead, 100, "cache read surfaced first-class, not folded away");
  assert.equal(r.tokensCacheWrite, 20, "cache write surfaced first-class");
  assert.equal(r.tokens, 135, "legacy total still counts cache reads + creations");
  assert.equal(r.sawFinish, true);
});

test("parseClaudeResult: surfaces total_cost_usd as apiCostUsd (D-XX overturns D-13)", () => {
  const r = parseClaudeResult(RESULT);
  assert.equal(r.apiCostUsd, 0.42, "public-API-basis cost is now recorded for ROI comparison");
});

test("parseClaudeResult: apiCostUsd defaults to 0 when the result omits it", () => {
  const r = parseClaudeResult(
    JSON.stringify({ type: "result", is_error: false, session_id: "x", usage: {} }),
  );
  assert.equal(r.apiCostUsd, 0);
});

test("parseClaudeResult: is_error true means the run did not finish", () => {
  const r = parseClaudeResult(JSON.stringify({ type: "result", is_error: true, session_id: "x", usage: {} }));
  assert.equal(r.sawFinish, false);
});

test("parseClaudeResult: malformed or empty output degrades, never throws", () => {
  for (const bad of ["", "not json", "{", "null"]) {
    assert.doesNotThrow(() => parseClaudeResult(bad));
    assert.equal(parseClaudeResult(bad).sawFinish, false);
  }
});

test("parseClaudeResult: tolerates a stream of JSON lines, taking the result event", () => {
  const stream = ['{"type":"system"}', '{"type":"assistant"}', RESULT].join("\n");
  const r = parseClaudeResult(stream);
  assert.equal(r.sessionID, "abc-123");
  assert.equal(r.tokens, 135);
});

// ─── CLI smoke: the guards must refuse BEFORE any model is contacted ─────────
//
// These spawn the real CLI. They never reach `claude`, because both guards fire
// first — which is exactly the property under test. A driver whose fail-closed
// path is only unit-tested has an untested fail-closed path (we learned this the
// hard way: a `main()` typo shipped through 381 green tests elsewhere).

// ─── Liveness: streaming output so a hang is distinguishable from work ────────
// `--output-format json` emits NOTHING until the run completes, so a stalled
// worker and a busy one look identical for the full 30-minute wall-clock. That
// is the documented "silent hang" failure mode and the reason external dispatch
// "fails a lot / I can't tell when it finished". stream-json emits JSONL as the
// run proceeds, which gives the idle watchdog something to watch.

test("buildClaudeArgs streams JSONL so liveness is observable", () => {
  const args = buildClaudeArgs({ model: "glm-5.3", prompt: "hi" }, "/tmp/s.json");
  const i = args.indexOf("--output-format");
  assert.equal(args[i + 1], "stream-json");
  assert.ok(args.includes("--verbose"), "stream-json requires --verbose under --print");
  assert.ok(args.includes("-p"));
  assert.equal(args.at(-1), "hi", "prompt stays last");
});

test("buildClaudeArgs keeps model, settings, resume and mcp wiring", () => {
  const args = buildClaudeArgs(
    { model: "glm-5.3", prompt: "go", session: "ses_1", mcpConfigPath: "/tmp/mcp.json" },
    "/tmp/s.json",
  );
  assert.equal(args[args.indexOf("--model") + 1], "glm-5.3");
  assert.equal(args[args.indexOf("--settings") + 1], "/tmp/s.json");
  assert.equal(args[args.indexOf("--resume") + 1], "ses_1");
  assert.ok(args.includes("--strict-mcp-config"));
});

// ─── The watchdog must not kill healthy seats ────────────────────────────────
// A tool call is SILENT for its whole duration — claude emits the `assistant`
// event carrying the tool_use, then nothing until the tool returns. A profile
// whose `gate` includes a browser E2E suite runs one such call for minutes, at
// zero output, from a perfectly healthy seat. An idle budget tuned for "detect
// a hang fast" would kill it, and a watchdog that kills good runs is worse than
// the hang it guards against.

test("resolveIdleTimeout defaults generously enough to survive a long gate command", () => {
  const idle = resolveIdleTimeout({});
  assert.ok(
    idle >= 15 * 60 * 1000,
    `default idle budget ${idle}ms would kill a healthy seat mid-gate`,
  );
});

test("resolveIdleTimeout honours an explicit --idle-timeout", () => {
  assert.equal(resolveIdleTimeout({ idleTimeout: 90_000 }), 90_000);
});

test("resolveIdleTimeout never exceeds the wall clock, where it could never fire", () => {
  assert.equal(resolveIdleTimeout({ idleTimeout: 60 * 60 * 1000, timeout: 120_000 }), 120_000);
  // The default is likewise clamped by a short --timeout.
  assert.equal(resolveIdleTimeout({ timeout: 60_000 }), 60_000);
});

test("resolveIdleTimeout falls back to the default on garbage rather than disarming", () => {
  // `--idle-timeout abc` parses to NaN; 0 and negatives would fire instantly and
  // kill every run at spawn. Both must degrade to the default, never to "off".
  for (const bad of [Number.NaN, 0, -1, undefined, null, "soon"]) {
    const idle = resolveIdleTimeout({ idleTimeout: bad });
    assert.equal(idle, resolveIdleTimeout({}), `idleTimeout=${String(bad)} must fall back`);
  }
});

test("parseClaudeResult reads a stream-json JSONL transcript, not just a lone blob", () => {
  const stream = [
    '{"type":"system","subtype":"init","session_id":"ses_S"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"session_id":"ses_S",' +
      '"total_cost_usd":0.42,"usage":{"input_tokens":10,"output_tokens":5,' +
      '"cache_read_input_tokens":900,"cache_creation_input_tokens":85}}',
  ].join("\n");
  const r = parseClaudeResult(stream);
  assert.equal(r.sawFinish, true);
  assert.equal(r.sessionID, "ses_S");
  assert.equal(r.tokensCacheRead, 900);
  assert.equal(r.tokens, 10 + 5 + 900 + 85);
  assert.equal(r.apiCostUsd, 0.42);
});

test("parseClaudeResult reports sawFinish=false on an errored result event", () => {
  const r = parseClaudeResult('{"type":"result","is_error":true,"usage":{"input_tokens":1}}');
  assert.equal(r.sawFinish, false);
});

function runCli(args, env = {}) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-worker.mjs");
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("CLI: refuses to spawn with no credentials (exit 2, would bill Anthropic)", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-nocreds-"));
  try {
    const r = runCli(["--dir", wt, "--allow-any-dir", "--model", "m", "--project", "factory", "--prompt", "hi", "--creds", "/nonexistent"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ANTHROPIC_BASE_URL is unset/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("CLI: refuses an anthropic.com endpoint, and never echoes the token", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-anthropic-"));
  const { dir, f } = writeEnvFile("ANTHROPIC_BASE_URL=https://api.anthropic.com\nANTHROPIC_AUTH_TOKEN=sk-do-not-leak\n");
  try {
    const r = runCli(["--dir", wt, "--allow-any-dir", "--model", "m", "--project", "factory", "--prompt", "hi", "--creds", f]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /anthropic\.com/);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /sk-do-not-leak/, "the token must never be printed");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: refuses to run outside a dispatched worktree without --allow-any-dir", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-confine-"));
  try {
    const r = runCli(["--dir", wt, "--model", "m", "--project", "factory", "--prompt", "hi", "--creds", "/nonexistent"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /dispatched worktree/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("CLI: usage error when required args are missing", () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/);
});

// ─── --project is required AND a known profile (before creds / cage) ─────────
//
// A forgotten --project used to render a cage with zero Critical-File rules and
// say nothing. The driver now refuses BEFORE the credentials guard, so these
// spawns never reach `claude` (the guard fires first — the property under test).

test("CLI: no --project is refused (exit 2, stderr lists the known ids)", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-noproject-"));
  try {
    const r = runCli(["--dir", wt, "--allow-any-dir", "--model", "m", "--prompt", "hi", "--creds", "/nonexistent"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--project/);
    assert.match(r.stderr, /factory/, "the refusal must list the known project ids");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("CLI: an unknown --project is refused (exit 2)", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-badproject-"));
  try {
    const r = runCli(
      ["--dir", wt, "--allow-any-dir", "--model", "m", "--project", "this-id-does-not-exist", "--prompt", "hi", "--creds", "/nonexistent"],
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /this-id-does-not-exist/);
    assert.match(r.stderr, /factory/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ─── Sonnet (or any Anthropic-hosted model) as an OPT-IN seat ────────────────
//
// The endpoint guard exists to stop ACCIDENTAL spend, not to forbid deliberate
// spend. Running Sonnet as a worker is a legitimate choice — it just costs
// Anthropic tokens (or the operator's plan quota) instead of the flat z.ai plan,
// so it must be typed, never defaulted into.

test("assertSeatEndpoint: default (external) behaves exactly as before", () => {
  assert.throws(
    () => assertSeatEndpoint({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_AUTH_TOKEN: "t" }, {}),
    /anthropic\.com/,
  );
  assert.throws(() => assertSeatEndpoint({}, {}), /ANTHROPIC_BASE_URL/);
});

test("assertSeatEndpoint: --allow-anthropic permits an anthropic.com endpoint", () => {
  assert.doesNotThrow(() =>
    assertSeatEndpoint({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "k" }, { allowAnthropic: true }),
  );
});

test("assertSeatEndpoint: --allow-anthropic permits NO credentials (use the logged-in session)", () => {
  // `claude -p` with no ANTHROPIC_* falls back to the operator's own OAuth session.
  // That is the whole point of a Sonnet worker: it runs on the plan you already pay for.
  assert.doesNotThrow(() => assertSeatEndpoint({}, { allowAnthropic: true }));
});

test("assertSeatEndpoint: --allow-anthropic still rejects a malformed base URL", () => {
  assert.throws(() => assertSeatEndpoint({ ANTHROPIC_BASE_URL: "not a url" }, { allowAnthropic: true }), /not a URL/);
});

test("buildClaudeEnv: with no seat creds, no ANTHROPIC_* reaches the child (OAuth path)", () => {
  const env = buildClaudeEnv({ PATH: "/usr/bin", HOME: "/home/a", ANTHROPIC_BASE_URL: "https://api.z.ai/x" }, {});
  assert.ok(!("ANTHROPIC_BASE_URL" in env), "a stale coordinator base URL must not redirect a Sonnet seat");
  assert.equal(env.HOME, "/home/a", "HOME must survive — it is where the OAuth credentials live");
});

// ─── CLAUDE_CONFIG_DIR isolation (F2) ────────────────────────────────────────
//
// Today `claude -p` inherits the operator's own `~/.claude` config (via HOME,
// which the allowlist must keep for OAuth to work). Operator user-settings could
// layer permissions into the seat and widen the cage from outside the rendered
// `--settings` file. A dedicated, throwaway CLAUDE_CONFIG_DIR under the worktree
// closes that: only the cage governs the seat.

test("makeSeatConfigDir: creates a dir under <worktree>/.claude, not the operator's ~/.claude", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "seat-config-"));
  try {
    const dir = makeSeatConfigDir(wt);
    assert.ok(existsSync(dir), "the config dir must actually be created");
    assert.ok(dir.startsWith(path.join(wt, ".claude")), `expected under ${wt}/.claude, got ${dir}`);
    assert.notEqual(dir, path.join(homedir(), ".claude"), "must never be the operator's own config dir");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("makeSeatConfigDir: a fresh, unique dir every call — no state survives between spawns", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "seat-config-"));
  try {
    const first = makeSeatConfigDir(wt);
    const second = makeSeatConfigDir(wt);
    assert.notEqual(first, second, "each spawn must get its own fresh directory");
    assert.ok(existsSync(first));
    assert.ok(existsSync(second));
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("buildClaudeEnv: with a worktree dir, sets CLAUDE_CONFIG_DIR under it (not ~/.claude)", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "seat-config-"));
  try {
    const env = buildClaudeEnv({ PATH: "/usr/bin", HOME: "/home/a" }, { ANTHROPIC_AUTH_TOKEN: "tok" }, wt);
    assert.ok(env.CLAUDE_CONFIG_DIR, "CLAUDE_CONFIG_DIR must be set when a worktree dir is given");
    assert.ok(
      env.CLAUDE_CONFIG_DIR.startsWith(path.join(wt, ".claude")),
      `expected under ${wt}/.claude, got ${env.CLAUDE_CONFIG_DIR}`,
    );
    assert.notEqual(env.CLAUDE_CONFIG_DIR, path.join(homedir(), ".claude"));
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("buildClaudeEnv: without a worktree dir, CLAUDE_CONFIG_DIR is left unset (back-compat)", () => {
  const env = buildClaudeEnv({ PATH: "/usr/bin" }, { ANTHROPIC_AUTH_TOKEN: "tok" });
  assert.ok(!("CLAUDE_CONFIG_DIR" in env));
});

// ─── full spawn path, with a stubbed `claude` binary (costs nothing) ─────────

/** Put a fake `claude` on PATH that prints one result event. */
function stubClaude(resultJson) {
  const dir = mkdtempSync(path.join(tmpdir(), "stub-claude-"));
  const bin = path.join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${resultJson}\nJSON\n`, { mode: 0o755 });
  return dir;
}

test("CLI: --allow-anthropic runs a Sonnet seat end-to-end, caged, no creds needed", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-sonnet-"));
  const stub = stubClaude(
    JSON.stringify({ type: "result", is_error: false, session_id: "sess-1", usage: { input_tokens: 7, output_tokens: 3 } }),
  );
  try {
    const r = runCli(
      ["--dir", wt, "--allow-any-dir", "--model", "sonnet", "--project", "factory", "--prompt", "hi", "--allow-anthropic", "--creds", "/nonexistent"],
      { PATH: `${stub}:${process.env.PATH}` },
    );
    assert.equal(r.status, 0, `expected success, got ${r.status}\n${r.stderr}`);
    assert.match(r.stdout, /model=sonnet/);
    assert.match(r.stdout, /tokens=10/);
    assert.match(r.stdout, /session=sess-1/);
    // The cage is still installed — an opt-in seat is not an uncaged seat.
    assert.ok(existsSync(path.join(wt, ".claude", "settings.external.json")), "cage must be written");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(stub, { recursive: true, force: true });
  }
});

/** Put a fake `claude` on PATH that dumps its env to `envDumpPath`, then prints one result event. */
function stubClaudeCapturingEnv(resultJson, envDumpPath) {
  const dir = mkdtempSync(path.join(tmpdir(), "stub-claude-env-"));
  const bin = path.join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nenv > "${envDumpPath}"\ncat <<'JSON'\n${resultJson}\nJSON\n`, { mode: 0o755 });
  return dir;
}

test("CLI: the spawned seat's env carries an isolated CLAUDE_CONFIG_DIR, not the operator's ~/.claude", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-configdir-"));
  const envDump = path.join(wt, "env-dump.txt");
  const stub = stubClaudeCapturingEnv(
    JSON.stringify({ type: "result", is_error: false, session_id: "sess-cd", usage: { input_tokens: 1, output_tokens: 1 } }),
    envDump,
  );
  try {
    const r = runCli(
      ["--dir", wt, "--allow-any-dir", "--model", "sonnet", "--project", "factory", "--prompt", "hi", "--allow-anthropic", "--creds", "/nonexistent"],
      { PATH: `${stub}:${process.env.PATH}` },
    );
    assert.equal(r.status, 0, `expected success, got ${r.status}\n${r.stderr}`);
    const dumped = readFileSync(envDump, "utf8");
    const line = dumped.split("\n").find((l) => l.startsWith("CLAUDE_CONFIG_DIR="));
    assert.ok(line, "the spawned process must receive CLAUDE_CONFIG_DIR");
    const value = line.slice("CLAUDE_CONFIG_DIR=".length);
    assert.ok(value.startsWith(path.join(wt, ".claude")), `expected under ${wt}/.claude, got ${value}`);
    assert.notEqual(value, path.join(homedir(), ".claude"));
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(stub, { recursive: true, force: true });
  }
});

// ─── __dirname regression: METRICS_SCRIPT must resolve inside scripts/ ───────
//
// new URL('.', import.meta.url).pathname returns scripts/ WITH a trailing slash,
// so path.dirname strips "scripts" and returns the repo root. metrics.mjs lives
// in scripts/, not the repo root, so every recordMetric call would silently drop
// telemetry. Fixed to fileURLToPath idiom; this test guards the regression.

test("METRICS_SCRIPT: resolves to a real file inside scripts/", () => {
  assert.ok(existsSync(METRICS_SCRIPT), "metrics.mjs path must resolve to a real file");
  assert.ok(
    METRICS_SCRIPT.endsWith(path.join("scripts", "metrics.mjs")),
    `metrics.mjs must be resolved inside scripts/, got: ${METRICS_SCRIPT}`,
  );
});

test("CLI: without --allow-anthropic, the same invocation still refuses", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-sonnet-refuse-"));
  const stub = stubClaude("{}");
  try {
    const r = runCli(["--dir", wt, "--allow-any-dir", "--model", "sonnet", "--project", "factory", "--prompt", "hi", "--creds", "/nonexistent"], {
      PATH: `${stub}:${process.env.PATH}`,
    });
    assert.equal(r.status, 2, "opting into Anthropic spend must be explicit");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(stub, { recursive: true, force: true });
  }
});

// ─── F2 auth-preservation regression (coordinator fix) ────────────────────────
// Isolating CLAUDE_CONFIG_DIR must NOT strand an Anthropic-session seat at
// "Not logged in": the operator's OAuth (.credentials.json) is seeded into the
// isolated dir, while settings.json (the permission-widening vector) is not.
test("makeSeatConfigDir: seeds the operator's OAuth credentials, never settings.json", () => {
  const opCreds = path.join(homedir(), ".claude", ".credentials.json");
  const dir = mkdtempSync(path.join(tmpdir(), "seat-cfg-auth-"));
  try {
    const cfg = makeSeatConfigDir(dir);
    if (existsSync(opCreds)) {
      assert.ok(existsSync(path.join(cfg, ".credentials.json")), "OAuth must be seeded so the seat authenticates");
    }
    // The permission-widening vector must NOT be copied in.
    assert.ok(!existsSync(path.join(cfg, "settings.json")), "operator settings.json must never leak into the seat config");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── E3-b: the "refuse to spawn uncaged" guard is actually exercised ───────────
// A broken cage (writeCageSettings throws) must halt the spawn unless
// --allow-uncaged. Mutation: `if (!opts.allowUncaged)` -> `if (false)` makes a
// broken cage spawn the seat uncaged and silent — this test goes red.
test("CLI: a broken cage refuses to spawn uncaged (exit 2), unless --allow-uncaged (E3-b)", () => {
  const base = mkdtempSync(path.join(tmpdir(), "uncaged-"));
  const wt = path.join(base, ".worktrees", "slug");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, ".claude"), "x"); // .claude is a FILE -> writeCageSettings throws
  const prompt = path.join(base, "p.txt");
  writeFileSync(prompt, "print hi");
  try {
    const r = runCli(
      ["--dir", wt, "--model", "claude-sonnet-5", "--project", "factory", "--allow-anthropic",
       "--creds", "/dev/null", "--prompt-file", prompt],
      { FACTORY_WORKTREE_MARKER: "/.worktrees/" },
    );
    assert.equal(r.status, 2, "a broken cage must refuse");
    assert.match(r.stderr, /CAGE NOT INSTALLED/);
    assert.match(r.stderr, /refusing to spawn uncaged/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── E6-F02: the alias trap (sonnet|opus|haiku × non-Anthropic endpoint) ──────
test("assertNoAliasTrap: an Anthropic alias on a z.ai base URL is refused (F02)", () => {
  assert.throws(
    () => assertNoAliasTrap("sonnet", { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" }),
    /alias.*z\.ai maps to glm-5\.3|would run GLM/,
  );
  assert.throws(() => assertNoAliasTrap("opus", { ANTHROPIC_BASE_URL: "https://api.z.ai/x" }), /alias/);
});

test("assertNoAliasTrap: an alias on a real Anthropic endpoint (or no base URL) is allowed (F02)", () => {
  assert.doesNotThrow(() => assertNoAliasTrap("sonnet", { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }));
  assert.doesNotThrow(() => assertNoAliasTrap("sonnet", {})); // no base URL → CLI's own default
});

test("assertNoAliasTrap: a full model id is unambiguous and always allowed (F02)", () => {
  assert.doesNotThrow(() => assertNoAliasTrap("claude-sonnet-5", { ANTHROPIC_BASE_URL: "https://api.z.ai/x" }));
  assert.doesNotThrow(() => assertNoAliasTrap("glm-5.3", { ANTHROPIC_BASE_URL: "https://api.z.ai/x" }));
});

// ─── E6-F03: z.ai rate-limit detection (429 / code 1308) ──────────────────────
test("detectRateLimit: a z.ai 429 / code 1308 result is detected, with reset when present (F03)", () => {
  const out = JSON.stringify({ is_error: true, result: "rate_limit_error", error: { code: 1308, reset: "2026-07-13T18:00:00Z" } });
  const rl = detectRateLimit(out, "");
  assert.ok(rl, "1308 must be detected");
  assert.equal(rl.reset, "2026-07-13T18:00:00Z");
});

test("detectRateLimit: a clean successful result is not flagged (F03)", () => {
  assert.equal(detectRateLimit(JSON.stringify({ is_error: false, result: "OK", total_cost_usd: 0.1 }), ""), null);
});

// Caught by a live Sonnet 5 dispatch, 2026-08-28: the run finished clean
// (exit 0, sawFinish true, 1.1M tokens) and the driver still exited 3 shouting
// RATE LIMITED. Claude Code emits a `rate_limit_event` on every healthy stream,
// carrying `status:"allowed"` — and a substring scan for /rate.limit/ over the
// whole transcript matches it. Under `--output-format json` that metadata was
// never in stdout, so the loose regex survived; stream-json puts it there on
// EVERY run, which would have made exit 3 the normal outcome of success.
// The status field is the signal. The word is not.
test("detectRateLimit: Claude Code's healthy `rate_limit_event` is NOT a rate limit", () => {
  const stream = [
    '{"type":"system","subtype":"init","session_id":"ses_A"}',
    '{"type":"system","subtype":"rate_limit_event","rate_limit_info":{"status":"allowed",' +
      '"resetsAt":1787956800,"rateLimitType":"five_hour","overageStatus":"rejected",' +
      '"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.12}}}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"done",' +
      '"total_cost_usd":0.57,"usage":{"input_tokens":40,"output_tokens":11995}}',
  ].join("\n");
  assert.equal(detectRateLimit(stream, ""), null);
});

test("detectRateLimit: a rate_limit_event that actually BLOCKS is detected, with its reset", () => {
  const stream = [
    '{"type":"system","subtype":"rate_limit_event","rate_limit_info":{"status":"rejected",' +
      '"resetsAt":1787956800,"rateLimitType":"five_hour"}}',
  ].join("\n");
  const rl = detectRateLimit(stream, "");
  assert.ok(rl, "a rejected window is a real rate limit");
  assert.equal(rl.reset, "1787956800");
});

test("detectRateLimit: the seat merely TALKING about rate limits is not a rate limit", () => {
  // A builder seat writing a retry/backoff helper says "rate limit" in its own
  // prose and code. Under stream-json every one of those tokens is in stdout.
  const stream = [
    '{"type":"assistant","message":{"content":[{"type":"text",' +
      '"text":"I will add a rate_limit guard and handle 1308 from the provider."}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.1}',
  ].join("\n");
  assert.equal(detectRateLimit(stream, ""), null);
});

test("detectRateLimit: a provider 429 on stderr is still detected (no result event at all)", () => {
  const rl = detectRateLimit("", "API error: 429 rate_limit_exceeded, reset 2026-07-13T18:00:00Z");
  assert.ok(rl, "stderr is an error surface — scan it");
  assert.equal(rl.reset, "2026-07-13T18:00:00Z");
});

// ─── F9 cage-vision: the --with-playwright visual-validator seat ──────────────

/** Put a fake `claude` on PATH that dumps its argv to `argvDumpPath`, then prints one result. */
function stubClaudeCapturingArgs(resultJson, argvDumpPath) {
  const dir = mkdtempSync(path.join(tmpdir(), "stub-claude-argv-"));
  const bin = path.join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvDumpPath}"\ncat <<'JSON'\n${resultJson}\nJSON\n`, { mode: 0o755 });
  return dir;
}

test("writePlaywrightMcpConfig: writes exactly one playwright server, --isolated", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-mcp-"));
  try {
    const p = writePlaywrightMcpConfig(wt);
    assert.ok(p.endsWith(path.join(".claude", "mcp-playwright.json")), `unexpected path: ${p}`);
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    assert.deepEqual(Object.keys(cfg.mcpServers), ["playwright"], "exactly one MCP server");
    assert.equal(cfg.mcpServers.playwright.command, "npx");
    assert.ok(cfg.mcpServers.playwright.args.includes("--isolated"), "must run --isolated (single-instance profile)");
    assert.ok(cfg.mcpServers.playwright.args.some((a) => a.includes("@playwright/mcp")), "must launch @playwright/mcp");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("CLI: --with-playwright adds --mcp-config + --strict-mcp-config and writes the config", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-pw-on-"));
  const argvDump = path.join(wt, "argv.txt");
  const stub = stubClaudeCapturingArgs(
    JSON.stringify({ type: "result", is_error: false, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } }),
    argvDump,
  );
  try {
    const r = runCli(
      ["--dir", wt, "--allow-any-dir", "--model", "sonnet", "--project", "factory", "--prompt", "hi",
        "--allow-anthropic", "--creds", "/nonexistent", "--metric-seat", "validator", "--with-playwright"],
      { PATH: `${stub}:${process.env.PATH}` },
    );
    assert.equal(r.status, 0, `expected success, got ${r.status}\n${r.stderr}`);
    const argv = readFileSync(argvDump, "utf8").split("\n");
    assert.ok(argv.includes("--mcp-config"), "must pass --mcp-config");
    assert.ok(argv.includes("--strict-mcp-config"), "must pass --strict-mcp-config (drop operator MCPs)");
    const cfgArg = argv[argv.indexOf("--mcp-config") + 1];
    assert.ok(cfgArg.endsWith("mcp-playwright.json"), `--mcp-config points at the playwright config, got ${cfgArg}`);
    assert.ok(existsSync(path.join(wt, ".claude", "mcp-playwright.json")), "the MCP config file must be written");
    // The cage rendered as a visual-validator: browser + verdict allow present.
    const settings = JSON.parse(readFileSync(path.join(wt, ".claude", "settings.external.json"), "utf8"));
    assert.ok(settings.permissions.allow.includes("mcp__playwright"), "cage must allow the Playwright tools");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(stub, { recursive: true, force: true });
  }
});

test("CLI: without --with-playwright, no MCP flags and no config file (unchanged)", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cw-pw-off-"));
  const argvDump = path.join(wt, "argv.txt");
  const stub = stubClaudeCapturingArgs(
    JSON.stringify({ type: "result", is_error: false, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } }),
    argvDump,
  );
  try {
    const r = runCli(
      ["--dir", wt, "--allow-any-dir", "--model", "sonnet", "--project", "factory", "--prompt", "hi",
        "--allow-anthropic", "--creds", "/nonexistent"],
      { PATH: `${stub}:${process.env.PATH}` },
    );
    assert.equal(r.status, 0, `expected success, got ${r.status}\n${r.stderr}`);
    const argv = readFileSync(argvDump, "utf8").split("\n");
    assert.ok(!argv.includes("--mcp-config"), "no MCP config without the flag");
    assert.ok(!argv.includes("--strict-mcp-config"), "no strict-mcp without the flag");
    assert.ok(!existsSync(path.join(wt, ".claude", "mcp-playwright.json")), "no MCP config file without the flag");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(stub, { recursive: true, force: true });
  }
});

test("buildClaudeEnv: R3 — named product secrets never reach the visual-validator seat", () => {
  const source = {
    PATH: "/usr/bin", HOME: "/home/a",
    SUPABASE_SERVICE_ROLE_KEY: "sk", WABA_TOKEN_KEY: "aes", OPENROUTER_API_KEY: "or",
    DATABASE_URL: "postgres://x", JWT_SECRET: "j",
  };
  const env = buildClaudeEnv(source, { ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://api.z.ai/x" }, "/tmp/wt");
  for (const k of ["SUPABASE_SERVICE_ROLE_KEY", "WABA_TOKEN_KEY", "OPENROUTER_API_KEY", "DATABASE_URL", "JWT_SECRET"]) {
    assert.equal(env[k], undefined, `secret ${k} must never reach the seat`);
  }
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "tok", "the z.ai seat credential must be present");
});

// Weak on purpose: no fake-`claude`-on-PATH harness exists here, and recordMetric
// forwards --project (not --dir), so an end-to-end dispatch would append to the
// real mission log. This just catches a merge that drops the worktree-delta
// wiring. Real verification is a dogfood dispatch after GREEN.
//
// The delta is now taken inside `completeRun` (worker-common.mjs), which owns
// the countChangedFiles-before-gate order for every driver — so what the driver
// must still show is the snapshot at spawn and the call that consumes it.
test("claude-worker imports the worktree-delta helpers", () => {
  const src = readFileSync(path.join(fileURLToPath(new URL(".", import.meta.url)), "claude-worker.mjs"), "utf8");
  assert.ok(src.includes("snapshotWorktree"), "must import/use snapshotWorktree");
  assert.ok(src.includes("completeRun"), "must import/use completeRun (which takes the delta)");
});

// ─── the gate, wired ─────────────────────────────────────────────────────────
//
// The measurement sequence itself (filesChanged before the gate) and the
// exit-code folding live in worker-common.mjs and are pinned there — both
// drivers share them. What is driver-specific is the flag surface below.

test("parseArgs: --gate and --gate-strict are accepted, not treated as unknown flags", () => {
  const opts = parseArgs(["node", "s", "--dir", "/w", "--model", "m", "--prompt", "p", "--gate", "--gate-strict"]);
  assert.ok(!opts._bad);
  assert.equal(opts.gate, true);
  assert.equal(opts.gateStrict, true);
});

test("parseArgs: the gate is OFF unless asked for", () => {
  const opts = parseArgs(["node", "s", "--dir", "/w", "--model", "m", "--prompt", "p"]);
  assert.equal(opts.gate, false);
  assert.equal(opts.gateStrict, false);
});

test("parseArgs: --gate-strict implies --gate — strict without the gate would silently measure nothing", () => {
  const opts = parseArgs(["node", "s", "--dir", "/w", "--model", "m", "--prompt", "p", "--gate-strict"]);
  assert.equal(opts.gate, true);
});

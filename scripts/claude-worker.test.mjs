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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_ENV_KEYS,
  METRICS_SCRIPT,
  assertExternalEndpoint,
  assertSeatEndpoint,
  buildClaudeEnv,
  loadSeatCredentials,
  parseClaudeResult,
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

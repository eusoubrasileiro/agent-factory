/**
 * Tests for the graceful-kill helper shared by every worker driver.
 *
 *   node --test "scripts/lib/worker-common.test.mjs"
 *
 * Real child processes, never mocks: the whole point is the OS signal path.
 * `SIGKILL` cannot be caught, so a worker killed with it loses whatever it was
 * mid-write on. We reproduced that on mission `factory-profiles`: the F2 worker
 * committed, then hung, then the timer sent a bare SIGKILL. Nothing was lost that
 * time only because the commits happened to precede the hang.
 *
 * Every test must leave no stray process behind — assert, then kill in `finally`.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertKnownProject,
  buildPhaseEndEvent,
  buildPhaseStartEvent,
  buildSpawnEnv,
  countChangedFiles,
  isWorktreeDir,
  killGracefully,
  snapshotWorktree,
  applyGateExitCode,
  completeRun,
  gateSummaryLabel,
  mintRunId,
  runGateSubprocess,
  SPAWN_ENV_ALLOWLIST,
} from "./worker-common.mjs";

// `spawn()` is asynchronous: the child is still booting for a few ms after the
// call returns. Signal it in that window and the handler it has not yet installed
// cannot fire, so it dies to the DEFAULT action and a "stubborn" child looks
// polite. That is a test artifact, not a bug — in production the grace timer fires
// ~25 minutes after spawn. So every child announces readiness on stdout, and the
// test waits for it before signalling. Without this, the escalation test passes or
// fails on a race.
function spawnReady(script) {
  return spawn(process.execPath, ["-e", `${script}; console.log("ready");`], {
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Resolve once the child has printed `ready` (handler installed). */
function whenReady(child) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("child never signalled ready")), 10_000);
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("ready")) {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

/** A child that exits promptly when asked politely. */
function spawnPolite() {
  return spawnReady("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)");
}

/** A child that ignores SIGTERM and would otherwise run forever. */
function spawnStubborn() {
  return spawnReady("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
}

/** Resolve once the child has actually exited. */
function whenExited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

/** Is the pid still alive? `kill(pid, 0)` throws ESRCH when it is gone. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hardKill(child) {
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

test("killGracefully: a child that honours SIGTERM exits without escalation", async () => {
  const child = spawnPolite();
  try {
    await whenReady(child);
    const { escalated } = await killGracefully(child, { graceMs: 5000 });
    assert.equal(escalated, false, "a polite child must not be SIGKILLed");
    await whenExited(child);
    assert.equal(isAlive(child.pid), false);
  } finally {
    hardKill(child);
  }
});

test("killGracefully: a child that ignores SIGTERM is escalated to SIGKILL", async () => {
  const child = spawnStubborn();
  try {
    await whenReady(child);
    const { escalated } = await killGracefully(child, { graceMs: 250 });
    assert.equal(escalated, true, "a stubborn child must be escalated");
    await whenExited(child);
    assert.equal(isAlive(child.pid), false, "the process must actually be gone");
  } finally {
    hardKill(child);
  }
});

test("killGracefully: graceMs=0 escalates immediately without busy-waiting", async () => {
  const child = spawnStubborn();
  try {
    await whenReady(child);
    const { escalated } = await killGracefully(child, { graceMs: 0 });
    assert.equal(escalated, true);
    await whenExited(child);
    assert.equal(isAlive(child.pid), false);
  } finally {
    hardKill(child);
  }
});

test("killGracefully: does not throw on an already-exited child", async () => {
  const child = spawnPolite();
  child.kill("SIGKILL");
  await whenExited(child);
  // `child.kill()` on a reaped pid is a no-op in node, but process.kill would
  // throw ESRCH — the helper must survive either way and never escalate blindly.
  await assert.doesNotReject(() => killGracefully(child, { graceMs: 50 }));
});

test("killGracefully: clears its escalation timer so the process can exit", async () => {
  // If the grace timer were left dangling, this test file would hang for graceMs
  // past the last test. A 30s dangling timer is exactly the production default,
  // so pin it: a polite child must leave nothing behind.
  const child = spawnPolite();
  try {
    await whenReady(child);
    const t0 = Date.now();
    await killGracefully(child, { graceMs: 30_000 });
    assert.ok(Date.now() - t0 < 5_000, "must resolve on exit, not wait out the grace window");
  } finally {
    hardKill(child);
  }
});

test("killGracefully: the signal is overridable (SIGINT honoured like SIGTERM)", async () => {
  const child = spawnReady("process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000)");
  try {
    await whenReady(child);
    const { escalated } = await killGracefully(child, { graceMs: 5000, signal: "SIGINT" });
    assert.equal(escalated, false);
    await whenExited(child);
  } finally {
    hardKill(child);
  }
});

// ─── assertKnownProject: --project is required AND a known profile ────────────
//
// The cage's Critical-File deny rules and the run's telemetry routing both come
// from the project profile. `resolveProject` is deliberately total (a missing or
// misspelled id degrades to a default profile with ZERO Critical Files), so the
// strictness has to live in the driver. This is that guard. A temp factoryRoot
// with two profiles keeps the test off the real `projects/` on disk.

/** Build a throwaway factoryRoot holding `projects/<id>/project.json` for each id. */
function makeFactoryRoot(ids) {
  const root = mkdtempSync(path.join(tmpdir(), "known-project-"));
  for (const id of ids) {
    const dir = path.join(root, "projects", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "project.json"), JSON.stringify({ id, gate: ["true"] }));
  }
  return root;
}

test("assertKnownProject: an absent project throws, naming --project and every known id", () => {
  const root = makeFactoryRoot(["alpha", "beta"]);
  try {
    for (const absent of [undefined, "", null]) {
      assert.throws(
        () => assertKnownProject(absent, root),
        (err) => {
          assert.match(err.message, /--project/);
          assert.match(err.message, /alpha/);
          assert.match(err.message, /beta/);
          return true;
        },
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertKnownProject: an unknown id throws and lists the known ids", () => {
  const root = makeFactoryRoot(["alpha", "beta"]);
  try {
    assert.throws(
      () => assertKnownProject("gamma", root),
      (err) => {
        assert.match(err.message, /gamma/);
        assert.match(err.message, /alpha/);
        assert.match(err.message, /beta/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertKnownProject: a valid id returns it and does not throw", () => {
  const root = makeFactoryRoot(["alpha", "beta"]);
  try {
    assert.equal(assertKnownProject("alpha", root), "alpha");
    assert.equal(assertKnownProject("beta", root), "beta");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertKnownProject: the thrown message never carries anything from process.env", () => {
  const root = makeFactoryRoot(["alpha", "beta"]);
  const sentinel = "SENTINEL_ENV_VALUE_should_not_appear";
  process.env.WORKER_COMMON_TEST_SENTINEL = sentinel;
  process.env.FACTORY_PROJECT = sentinel;
  try {
    for (const call of [() => assertKnownProject(undefined, root), () => assertKnownProject("gamma", root)]) {
      assert.throws(call, (err) => {
        assert.ok(!err.message.includes(sentinel), "the guard must not leak an env value");
        return true;
      });
    }
  } finally {
    delete process.env.WORKER_COMMON_TEST_SENTINEL;
    delete process.env.FACTORY_PROJECT;
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── isWorktreeDir ──────────────────────────────────────────────────────────

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

// ── Run OUTCOME (exitCode / sawFinish / timedOut) ───────────────────────────
// Without these the meter records cost and wall-time but not whether the run
// SUCCEEDED, so green-first-try — the primary endpoint of any model comparison —
// is not computable from the recorded data. A hung worker and a clean pass are
// indistinguishable in metrics.jsonl.

test("buildPhaseEndEvent carries the run outcome (exitCode, sawFinish, timedOut)", () => {
  const ev = buildPhaseEndEvent("worker", "glm-5.3", {
    tokens: 100,
    durationMs: 1000,
    exitCode: 0,
    sawFinish: true,
    timedOut: false,
  });
  assert.equal(ev.exitCode, 0);
  assert.equal(ev.sawFinish, true);
  assert.equal(ev.timedOut, false);
});

test("buildPhaseEndEvent records a failed run distinguishably from a clean one", () => {
  const ev = buildPhaseEndEvent("worker", "glm-5.3", {
    tokens: 0,
    durationMs: 1_800_000,
    exitCode: 1,
    sawFinish: false,
    timedOut: true,
  });
  assert.equal(ev.exitCode, 1);
  assert.equal(ev.sawFinish, false);
  assert.equal(ev.timedOut, true);
});

// Absent → null ("unmeasured"), never false/0. Coercing a missing outcome to
// `sawFinish:false` would invent failures in legacy rows; coercing to `true`
// would invent successes. Same rule the codebase already applies to
// tokensReasoning.
test("buildPhaseEndEvent leaves outcome null when the caller omits it", () => {
  const ev = buildPhaseEndEvent("worker", "m", { tokens: 1, durationMs: 1 });
  assert.equal(ev.exitCode, null);
  assert.equal(ev.sawFinish, null);
  assert.equal(ev.timedOut, null);
  assert.equal(ev.stalled, null);
});

// `stalled` (idle watchdog fired — no output at all) is a DIFFERENT diagnosis
// from `timedOut` (ran past the wall-clock while still producing output). One
// says the provider wedged; the other says the task was too big. Collapsing them
// would hide exactly the failure mode being measured on external seats.
test("buildPhaseEndEvent separates a wedged run from a merely slow one", () => {
  const wedged = buildPhaseEndEvent("worker", "glm-5.3", { stalled: true, timedOut: false });
  assert.equal(wedged.stalled, true);
  assert.equal(wedged.timedOut, false);

  const slow = buildPhaseEndEvent("worker", "glm-5.3", { stalled: false, timedOut: true });
  assert.equal(slow.stalled, false);
  assert.equal(slow.timedOut, true);
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

// ── filesChanged: driver-measured tree delta, never read out of model output ──
// A count of distinct paths whose state differs from the pre-spawn baseline.
// null means UNMEASURED (git unavailable, not a repo, HEAD unresolvable, or
// either snapshot failed) — never 0 as a stand-in for "we don't know".

test("buildPhaseEndEvent carries filesChanged when the driver measured it", () => {
  const ev = buildPhaseEndEvent("worker", "m", { filesChanged: 7 });
  assert.equal(ev.filesChanged, 7);
});

test("buildPhaseEndEvent leaves filesChanged null when unmeasured", () => {
  const ev = buildPhaseEndEvent("worker", "m", { tokens: 1 });
  assert.strictEqual(ev.filesChanged, null);
});

// ─── snapshotWorktree / countChangedFiles — real `git init` fixtures ───────────
// Same idiom as scripts/git-autocommit.test.mjs:24 (mkdtemp, git init, real git,
// rmSync cleanup) — the point is the real git plumbing, not a mock of it.

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return r;
}

/** Minimal `git init` repo with one committed file (`a.txt`). */
function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "worker-common-repo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

test("snapshotWorktree returns null outside a git repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-common-norepo-"));
  try {
    assert.strictEqual(snapshotWorktree(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("countChangedFiles returns null when the baseline is null", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-common-nullbase-"));
  try {
    assert.strictEqual(countChangedFiles(dir, null), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("countChangedFiles sees an uncommitted edit", () => {
  const repo = makeRepo();
  try {
    const baseline = snapshotWorktree(repo);
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    assert.equal(countChangedFiles(repo, baseline), 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("countChangedFiles sees work the seat COMMITTED", () => {
  const repo = makeRepo();
  try {
    const baseline = snapshotWorktree(repo);
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "seat work"]);
    assert.equal(countChangedFiles(repo, baseline), 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("countChangedFiles counts a new untracked file", () => {
  const repo = makeRepo();
  try {
    const baseline = snapshotWorktree(repo);
    writeFileSync(path.join(repo, "b.txt"), "new\n");
    assert.equal(countChangedFiles(repo, baseline), 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("countChangedFiles reports 0 for a worktree that was already dirty before the run", () => {
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "a.txt"), "one\ndirty-before-run\n");
    const baseline = snapshotWorktree(repo);
    assert.equal(countChangedFiles(repo, baseline), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("countChangedFiles counts a further edit to an already-dirty file", () => {
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "a.txt"), "one\ndirty-before-run\n");
    const baseline = snapshotWorktree(repo);
    appendFileSync(path.join(repo, "a.txt"), "line2\nline3\nline4\n");
    assert.equal(countChangedFiles(repo, baseline), 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("countChangedFiles ignores .claude/, so the driver cannot fabricate its own signal", () => {
  const repo = makeRepo();
  try {
    const baseline = snapshotWorktree(repo);
    mkdirSync(path.join(repo, ".claude", "seat-config-x"), { recursive: true });
    writeFileSync(path.join(repo, ".claude", "seat-config-x", "history.jsonl"), "{}\n");
    writeFileSync(path.join(repo, ".claude", "settings.json"), "{}\n");
    assert.equal(countChangedFiles(repo, baseline), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── runId — the pairing key ─────────────────────────────────────────────────
//
// phase_start and phase_end were paired FIFO by seat+model, which is a guess:
// three concurrent worktrees on one mission interleave their rows and nothing
// downstream can untangle them. One id minted per spawn makes the pair a fact.

test("mintRunId: shape is <slug>-<base36 time>-<6 hex>", () => {
  const id = mintRunId("gate-wire");
  assert.match(id, /^gate-wire-[0-9a-z]+-[0-9a-f]{6}$/);
});

test("mintRunId: no slug degrades to the 'run' prefix, never to empty", () => {
  for (const arg of [undefined, null, "", 7]) {
    assert.match(mintRunId(arg), /^run-[0-9a-z]+-[0-9a-f]{6}$/);
  }
});

test("mintRunId: two ids minted in the same millisecond still differ", () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(mintRunId("m"));
  assert.equal(ids.size, 200);
});

test("buildPhaseStartEvent: carries the runId it is given", () => {
  const e = buildPhaseStartEvent("worker", "some-model", "m-abc-123456");
  assert.equal(e.runId, "m-abc-123456");
});

test("buildPhaseStartEvent: runId is null when none is supplied — never invented", () => {
  const e = buildPhaseStartEvent("worker", "some-model");
  assert.equal(e.runId, null);
  // An id that pairs with nothing is strictly worse than admitting we cannot pair.
  assert.ok(!("runId" in e) === false);
});

test("buildPhaseEndEvent: runId round-trips, and is null when absent", () => {
  assert.equal(buildPhaseEndEvent("worker", "m", { runId: "m-abc-123456" }).runId, "m-abc-123456");
  assert.equal(buildPhaseEndEvent("worker", "m", {}).runId, null);
});

test("phase_start and phase_end built from one minted id carry the SAME value", () => {
  const runId = mintRunId("pairing");
  const start = buildPhaseStartEvent("worker", "m", runId);
  const end = buildPhaseEndEvent("worker", "m", { runId });
  assert.equal(start.runId, end.runId);
  assert.equal(start.runId, runId);
});

// ─── the gate subprocess ─────────────────────────────────────────────────────

function fakeSpawn(result) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return typeof result === "function" ? result() : result;
  };
  return { fn, calls };
}

const OK_GATE = { status: 0, stdout: JSON.stringify({ passed: true, gateRan: 3, gateTotal: 3 }) };

test("runGateSubprocess: passes project, dir, slug, run-id, seat, prepare and --json", () => {
  const { fn, calls } = fakeSpawn(OK_GATE);
  runGateSubprocess(
    { project: "factory", dirAbs: "/w/t", slug: "mission", runId: "r-1", seat: "validator", prepare: true },
    fn,
  );
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.ok(args[0].endsWith("gate.mjs"));
  for (const pair of [["--project", "factory"], ["--dir", "/w/t"], ["--slug", "mission"], ["--run-id", "r-1"], ["--seat", "validator"]]) {
    const i = args.indexOf(pair[0]);
    assert.ok(i !== -1, `missing ${pair[0]}`);
    assert.equal(args[i + 1], pair[1]);
  }
  assert.ok(args.includes("--prepare"));
  assert.ok(args.includes("--json"));
});

test("runGateSubprocess: omits --slug and --run-id rather than passing empty ones", () => {
  const { fn, calls } = fakeSpawn(OK_GATE);
  runGateSubprocess({ project: "factory", dirAbs: "/w/t" }, fn);
  assert.ok(!calls[0].args.includes("--slug"));
  assert.ok(!calls[0].args.includes("--run-id"));
});

test("runGateSubprocess: returns the parsed verdict object", () => {
  const { fn } = fakeSpawn(OK_GATE);
  const r = runGateSubprocess({ project: "factory", dirAbs: "/w/t" }, fn);
  assert.equal(r.passed, true);
  assert.equal(r.gateRan, 3);
});

test("runGateSubprocess: unparseable stdout degrades to null, never to a verdict", () => {
  const { fn } = fakeSpawn({ status: 1, stdout: "gate: something went sideways\n" });
  assert.equal(runGateSubprocess({ project: "factory", dirAbs: "/w/t" }, fn), null);
});

test("runGateSubprocess: a throwing spawn degrades to null and does not propagate", () => {
  const fn = () => {
    throw new Error("EACCES");
  };
  assert.equal(runGateSubprocess({ project: "factory", dirAbs: "/w/t" }, fn), null);
});

test("runGateSubprocess: a verdict without a `passed` key is not a verdict", () => {
  const { fn } = fakeSpawn({ status: 0, stdout: JSON.stringify({ hello: "world" }) });
  assert.equal(runGateSubprocess({ project: "factory", dirAbs: "/w/t" }, fn), null);
});

test("gateSummaryLabel: the three verdicts and 'not run' are all distinguishable", () => {
  assert.equal(gateSummaryLabel({ passed: true }), "pass");
  assert.equal(gateSummaryLabel({ passed: false }), "fail");
  assert.equal(gateSummaryLabel({ passed: null }), "unmeasured");
  assert.equal(gateSummaryLabel(null), "-");
  assert.equal(gateSummaryLabel(undefined), "-");
});

// ─── completeRun — the post-spawn measurement sequence ───────────────────────

function completeRunHarness({ slug = null, gate = false, gateResult = null, filesChanged = 2 } = {}) {
  const order = [];
  const metrics = [];
  const gateCalls = [];
  const deps = {
    countChangedFilesFn: () => {
      order.push("files");
      return filesChanged;
    },
    recordMetricFn: (s, event) => {
      order.push(`metric:${event.type}`);
      metrics.push(event);
    },
    runGateFn: (args) => {
      order.push("gate");
      gateCalls.push(args);
      return gateResult;
    },
  };
  const out = completeRun(
    {
      seat: "worker",
      model: "some-model",
      project: "factory",
      slug,
      dirAbs: "/w/t",
      baseline: { head: "abc", files: new Map() },
      runId: "r-1",
      metrics: { tokens: 5, durationMs: 10, exitCode: 0, sawFinish: true },
      gate,
    },
    deps,
  );
  return { out, order, metrics, gateCalls };
}

test("completeRun: filesChanged is computed BEFORE the gate runs (ordering pin)", () => {
  // LOAD-BEARING. The gate executes the project's real commands: coverage
  // output, build artifacts, and with prepare a whole dependency tree. Count
  // the delta after that and every gated run reports an inflated filesChanged —
  // a seat that changed nothing would score as having delivered, which is the
  // exact defect filesChanged exists to catch.
  const { order } = completeRunHarness({ slug: "m", gate: true, gateResult: { passed: true } });
  assert.deepEqual(order, ["files", "metric:phase_end", "gate"]);
  assert.ok(order.indexOf("files") < order.indexOf("gate"));
});

test("completeRun: phase_end is recorded before the gate, so a hung gate cannot swallow the run's cost", () => {
  const { order } = completeRunHarness({ slug: "m", gate: true, gateResult: { passed: false } });
  assert.ok(order.indexOf("metric:phase_end") < order.indexOf("gate"));
});

test("completeRun: without the gate flag the gate subprocess is never spawned", () => {
  const { order, out } = completeRunHarness({ slug: "m", gate: false });
  assert.ok(!order.includes("gate"));
  assert.equal(out.gate, null);
});

test("completeRun: the recorded phase_end carries filesChanged and the runId", () => {
  const { metrics } = completeRunHarness({ slug: "m", filesChanged: 7 });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].filesChanged, 7);
  assert.equal(metrics[0].runId, "r-1");
  assert.equal(metrics[0].tokens, 5);
});

test("completeRun: no slug means no telemetry, but filesChanged is still measured", () => {
  const { metrics, out } = completeRunHarness({ slug: null, filesChanged: 3 });
  assert.equal(metrics.length, 0);
  assert.equal(out.filesChanged, 3);
});

test("completeRun: the gate is handed the same runId as the phase_end it follows", () => {
  const { gateCalls, metrics } = completeRunHarness({ slug: "m", gate: true, gateResult: { passed: true } });
  assert.equal(gateCalls[0].runId, "r-1");
  assert.equal(gateCalls[0].runId, metrics[0].runId);
  assert.equal(gateCalls[0].project, "factory");
  assert.equal(gateCalls[0].dirAbs, "/w/t");
});

test("completeRun: a gate that could not report degrades to null, not to a verdict", () => {
  const { out } = completeRunHarness({ slug: "m", gate: true, gateResult: null });
  assert.equal(out.gate, null);
});

// ─── applyGateExitCode ───────────────────────────────────────────────────────

test("applyGateExitCode: a failing gate does NOT change the exit code by default", () => {
  assert.equal(applyGateExitCode(0, { passed: false }, false), 0);
});

test("applyGateExitCode: a failing gate exits 4 under strict", () => {
  assert.equal(applyGateExitCode(0, { passed: false }, true), 4);
});

test("applyGateExitCode: an UNMEASURED gate never exits 4, even under strict", () => {
  // An environment fault is not the seat's failure (D-25). Coercing null to a
  // failure is how a broken instrument starts manufacturing verdicts.
  assert.equal(applyGateExitCode(0, { passed: null }, true), 0);
  assert.equal(applyGateExitCode(0, null, true), 0);
});

test("applyGateExitCode: a passing gate leaves the exit code alone", () => {
  assert.equal(applyGateExitCode(0, { passed: true }, true), 0);
});

test("applyGateExitCode: an already-failing run keeps its own code — the seat's failure outranks the gate's", () => {
  for (const base of [1, 2, 3]) {
    assert.equal(applyGateExitCode(base, { passed: false }, true), base);
  }
});

// ─── the seat a run is recorded under ────────────────────────────────────────
//
// `metricSeat` used to be `seat === "validator" ? "validator" : "worker"`, so a
// planning seat dispatched with --metric-seat orchestrator was recorded as a
// WORKER. That is not cosmetic: the whole point of this instrument is
// cost-per-delivered-feature, and the planner is the expensive half of every
// mission. Attributing its tokens to the builder inflates builder cost and
// hides planner cost in exactly the comparison (strong-plan + cheap-build vs
// cheap-alone) the numbers exist to make.

test("buildPhaseStartEvent: an orchestrator seat is recorded as orchestrator, not collapsed to worker", () => {
  assert.equal(buildPhaseStartEvent("orchestrator", "m").seat, "orchestrator");
  assert.equal(buildPhaseEndEvent("orchestrator", "m", {}).seat, "orchestrator");
});

test("buildPhaseStartEvent: worker and validator are unchanged", () => {
  assert.equal(buildPhaseStartEvent("worker", "m").seat, "worker");
  assert.equal(buildPhaseStartEvent("validator", "m").seat, "validator");
});

test("buildPhaseStartEvent: an unknown seat still degrades to worker, never to an invalid one", () => {
  // metrics.mjs rejects any seat outside its own set, and a rejected event is a
  // run that vanishes entirely. Degrading to `worker` keeps it in the ledger,
  // mis-attributed but visible — the lesser of the two failures.
  for (const seat of ["reviewer", "", undefined, null, 7]) {
    assert.equal(buildPhaseStartEvent(seat, "m").seat, "worker");
  }
});

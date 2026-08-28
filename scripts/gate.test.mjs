/**
 * Tests for gate.mjs — the deterministic gate runner.
 *
 * Every test below is named after its guard in the ratified design (R1…R21 for
 * the null/false discipline + gateConfig detection, G1…G16 for the success
 * paths and the machine contract). Each guard is mutation-provable: weakening
 * it in gate.mjs must turn its named test red.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquireExclusiveOnce,
  buildGateEvent,
  canonicalize,
  classifyCommandResult,
  compareGateConfig,
  computeGateConfigTouched,
  decideVerdict,
  exitCodeFor,
  lockFilePath,
  main,
  parseGateConfigEntry,
  preflight,
  recordMetric,
  resolveJsonPointer,
  runGate,
} from "./gate.mjs";
import { validateEvent } from "./metrics.mjs";

const FACTORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function baseProfile(overrides = {}) {
  return {
    gate: [],
    prepare: [],
    prepareMarker: null,
    gateExclusive: [],
    gateConfig: [],
    trunk: "main",
    ...overrides,
  };
}

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Mute + collect stdout/stderr while `fn` runs; always restores. */
function withCapturedIO(fn) {
  const outChunks = [];
  const errChunks = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    outChunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    errChunks.push(String(chunk));
    return true;
  };
  try {
    const result = fn();
    return { result, stdout: outChunks.join(""), stderr: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ─── R1…R15 — the null/false discipline ─────────────────────────────────────

test("R1: passed is null with reason no-gate when the profile declares no gate commands", () => {
  const dir = tmp("gate-r1-");
  try {
    const result = runGate({ profile: baseProfile({ gate: [] }), dirAbs: dir, project: "factory" });
    assert.equal(result.passed, null);
    assert.equal(result.gateReason, "no-gate");
    assert.equal(result.gateRan, 0);
    assert.equal(result.gateTotal, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: passed is null with reason deps-missing when the marker is absent and --prepare was not given", () => {
  const dir = tmp("gate-r2-");
  try {
    const profile = baseProfile({ gate: ["true"], prepareMarker: "node_modules", prepare: ["true"] });
    const result = runGate({ profile, dirAbs: dir, project: "factory", prepareRequested: false });
    assert.equal(result.passed, null);
    assert.equal(result.gateReason, "deps-missing");
    assert.equal(result.gateRan, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R3: preflight passes when prepareMarker is null", () => {
  const result = preflight({
    profile: { prepareMarker: null, prepare: [] },
    markerExists: false,
    prepareRequested: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.needsPrepare, false);
});

test("R4: a prepare recipe that exits 0 without creating the marker yields prepare-failed", () => {
  const dir = tmp("gate-r4-");
  try {
    const profile = baseProfile({ gate: ["true"], prepareMarker: "node_modules", prepare: ["true"] });
    const result = runGate({ profile, dirAbs: dir, project: "factory", prepareRequested: true });
    assert.equal(result.passed, null);
    assert.equal(result.gateReason, "prepare-failed");
    assert.equal(result.gateRan, 0);
    assert.equal(existsSync(path.join(dir, "node_modules")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5: a failing prepare command yields prepare-failed and gateRan 0", () => {
  const dir = tmp("gate-r5-");
  try {
    const profile = baseProfile({ gate: ["true"], prepareMarker: "node_modules", prepare: ["false"] });
    const result = runGate({ profile, dirAbs: dir, project: "factory", prepareRequested: true });
    assert.equal(result.passed, null);
    assert.equal(result.gateReason, "prepare-failed");
    assert.equal(result.gateRan, 0);
    assert.equal(result.commands.length, 0, "the gate itself must never run on a half-provisioned tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R6: a spawn error on a gate command yields null/spawn-error, never false", () => {
  const dir = tmp("gate-r6-");
  try {
    const profile = baseProfile({ gate: ["definitely-not-a-real-binary-xyz"] });
    const result = runGate({ profile, dirAbs: dir, project: "factory" });
    assert.equal(result.passed, null);
    assert.equal(result.gateReason, "spawn-error");
    assert.equal(result.gateRan, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R7: a timed-out gate command yields null/timeout, never false", () => {
  const dir = tmp("gate-r7-");
  try {
    const profile = baseProfile({ gate: ["sleep 5"] });
    const result = runGate({ profile, dirAbs: dir, project: "factory", timeoutMs: 100 });
    assert.equal(result.passed, null);
    assert.equal(result.gateReason, "timeout");
    assert.equal(result.gateRan, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R8: a signal-killed gate command yields null/signal, never false", () => {
  const dir = tmp("gate-r8-");
  try {
    const profile = baseProfile({ gate: ['bash -c "kill -KILL $$"'] });
    const result = runGate({ profile, dirAbs: dir, project: "factory" });
    assert.equal(result.passed, null);
    assert.equal(result.gateReason, "signal");
    assert.equal(result.gateRan, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9: decideVerdict never returns passed true when gateRan < gateTotal", () => {
  const outcomes = ["ok", "failed", "spawn-error", "timeout", "signal", "lock-timeout"];
  const gate = ["a", "b", "c"];
  for (const o0 of outcomes) {
    for (const o1 of outcomes) {
      for (const o2 of outcomes) {
        const full = [o0, o1, o2];
        const attempts = [];
        for (let i = 0; i < full.length; i++) {
          attempts.push({ command: gate[i], index: i, outcome: full[i] });
          if (full[i] !== "ok") break;
        }
        const verdict = decideVerdict({ gate, attempts });
        if (verdict.passed === true) {
          assert.equal(
            verdict.gateRan,
            verdict.gateTotal,
            `passed true but gateRan(${verdict.gateRan}) !== gateTotal(${verdict.gateTotal}) for outcomes ${full}`,
          );
        }
      }
    }
  }
  // Degenerate shape: fewer attempts than gateTotal, none of them a failure — must never be true.
  const partial = decideVerdict({ gate, attempts: [{ command: "a", index: 0, outcome: "ok" }] });
  assert.notEqual(partial.passed, true);
});

test("R10: lock contention exhausting the budget yields null/lock-timeout with gateRan = step-1", () => {
  const dir = tmp("gate-r10-");
  const lockDir = tmp("gate-r10-locks-");
  try {
    const profile = baseProfile({ gate: ["true", "echo ok"], gateExclusive: ["echo ok"] });
    const contendedLock = lockFilePath("factory", "echo ok", lockDir);
    mkdirSync(path.dirname(contendedLock), { recursive: true });
    writeFileSync(
      contendedLock,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        command: "echo ok",
        project: "factory",
        dir,
        startedAt: new Date().toISOString(),
      }),
    );
    const result = runGate({
      profile,
      dirAbs: dir,
      project: "factory",
      lockDir,
      lockWaitMs: 50,
      lockPollMs: 10,
    });
    assert.equal(result.passed, null);
    assert.equal(result.gateReason, "lock-timeout");
    assert.equal(result.gateStep, 2);
    assert.equal(result.gateRan, 1, "the first command ran; the second never acquired its lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("R11: gateConfigTouched is null when profile.gateConfig is empty", () => {
  assert.equal(
    compareGateConfig(
      [],
      () => ({ present: true, content: "x" }),
      () => ({ present: true, content: "x" }),
    ),
    null,
  );
});

test("R12: gateConfigTouched is null when merge-base cannot be resolved (baseline unreadable)", () => {
  const readBaseline = () => null; // simulates: git merge-base failed, baseline unknowable
  const readWorktree = () => ({ present: true, content: "x" });
  assert.equal(compareGateConfig(["package.json#/scripts"], readBaseline, readWorktree), null);
});

test("R13: an internal throw exits 4, never 0 or 1", () => {
  const dir = tmp("gate-r13-");
  try {
    const { result: code } = withCapturedIO(() =>
      main(["node", "gate.mjs", "--project", "factory", "--dir", dir, "--json"], {
        runGateFn: () => {
          throw new Error("boom");
        },
      }),
    );
    assert.equal(code, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R14: exit code is 4 for every null reason and 1 for a false verdict", () => {
  const nullReasons = [
    "no-gate",
    "deps-missing",
    "prepare-failed",
    "spawn-error",
    "timeout",
    "signal",
    "lock-timeout",
    "internal-error",
  ];
  for (const reason of nullReasons) {
    assert.equal(exitCodeFor({ passed: null, gateReason: reason }), 4, `reason ${reason}`);
  }
  assert.equal(exitCodeFor({ passed: false, gateReason: null }), 1);
  assert.equal(exitCodeFor({ passed: true, gateReason: null }), 0);
});

test("R15: gate.mjs exits 2 for an unknown --project and emits no event", () => {
  const bogus = `gate-r15-bogus-${Date.now()}`;
  const missionsDir = path.join(FACTORY_ROOT, "missions", bogus);
  const dir = tmp("gate-r15-");
  try {
    const { result: code } = withCapturedIO(() =>
      main(["node", "gate.mjs", "--project", bogus, "--dir", dir, "--slug", "some-slug"]),
    );
    assert.equal(code, 2);
    assert.equal(existsSync(missionsDir), false, "an unknown project must never get its own missions dir written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(missionsDir, { recursive: true, force: true });
  }
});

// ─── R16…R21 — gateConfig detection ─────────────────────────────────────────

test("R16: gateConfigTouched is true when a declared pointer's value differs from baseline", () => {
  const readBaseline = () => ({ present: true, content: JSON.stringify({ scripts: { test: "vitest run" } }) });
  const readWorktree = () => ({ present: true, content: JSON.stringify({ scripts: { test: "exit 0" } }) });
  assert.equal(compareGateConfig(["package.json#/scripts"], readBaseline, readWorktree), true);
});

test("R17: adding a dependency does not set gateConfigTouched", () => {
  const base = { scripts: { test: "vitest run" }, dependencies: { a: "1.0.0" } };
  const work = { scripts: { test: "vitest run" }, dependencies: { a: "1.0.0", b: "2.0.0" } };
  const readBaseline = () => ({ present: true, content: JSON.stringify(base) });
  const readWorktree = () => ({ present: true, content: JSON.stringify(work) });
  assert.equal(compareGateConfig(["package.json#/scripts"], readBaseline, readWorktree), false);
});

test("R18: reordering scripts keys does not set gateConfigTouched", () => {
  const base = { scripts: { test: "vitest run", lint: "eslint ." } };
  const work = { scripts: { lint: "eslint .", test: "vitest run" } };
  const readBaseline = () => ({ present: true, content: JSON.stringify(base) });
  const readWorktree = () => ({ present: true, content: JSON.stringify(work) });
  assert.equal(compareGateConfig(["package.json#/scripts"], readBaseline, readWorktree), false);
});

test("R19: deleting a declared gateConfig file sets gateConfigTouched true", () => {
  const readBaseline = () => ({ present: true, content: "module.exports = {}" });
  const readWorktree = () => ({ present: false, content: null });
  assert.equal(compareGateConfig(["vitest.config.ts"], readBaseline, readWorktree), true);
});

test("R20: true beats null — one unreadable entry does not retract a proven change", () => {
  const readBaseline = (p) => (p === "a" ? { present: true, content: "1" } : null);
  const readWorktree = (p) => (p === "a" ? { present: true, content: "2" } : { present: true, content: "x" });
  assert.equal(compareGateConfig(["a", "b"], readBaseline, readWorktree), true, "true encountered first");
  assert.equal(compareGateConfig(["b", "a"], readBaseline, readWorktree), true, "null encountered first");
});

test("R21: a JSON pointer with ~1 and ~0 escapes resolves the literal key", () => {
  const obj = { scripts: { "test/e2e": "playwright test", "~weird": "ok" } };
  const r1 = resolveJsonPointer(obj, "/scripts/test~1e2e");
  assert.equal(r1.found, true);
  assert.equal(r1.value, "playwright test");
  const r2 = resolveJsonPointer(obj, "/scripts/~0weird");
  assert.equal(r2.found, true);
  assert.equal(r2.value, "ok");
});

test("parseGateConfigEntry + canonicalize: sanity (used throughout the R16-R21 fixtures)", () => {
  assert.deepEqual(parseGateConfigEntry("package.json#/scripts"), { path: "package.json", pointer: "/scripts" });
  assert.deepEqual(parseGateConfigEntry("src/Makefile"), { path: "src/Makefile", pointer: null });
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
});

// ─── G1…G16 — success paths and the machine contract ────────────────────────

test("G1: a single passing gate command yields passed true, gateRan === gateTotal, reason null, exit 0", () => {
  const dir = tmp("gate-g1-");
  try {
    const result = runGate({ profile: baseProfile({ gate: ["true"] }), dirAbs: dir, project: "factory" });
    assert.equal(result.passed, true);
    assert.equal(result.gateReason, null);
    assert.equal(result.gateRan, result.gateTotal);
    assert.equal(exitCodeFor(result), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G2: commands run in profile order, not sorted", () => {
  const dir = tmp("gate-g2-");
  const marker = path.join(dir, "order.log");
  try {
    const profile = baseProfile({
      gate: [`bash -c "echo z >> '${marker}'"`, `bash -c "echo a >> '${marker}'"`],
    });
    const result = runGate({ profile, dirAbs: dir, project: "factory" });
    assert.equal(result.passed, true);
    assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n"), ["z", "a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G3: execution stops at the first failing command", () => {
  const dir = tmp("gate-g3-");
  const marker = path.join(dir, "ran3.log");
  try {
    const profile = baseProfile({ gate: ["true", "false", `bash -c "echo ran >> '${marker}'"`] });
    const result = runGate({ profile, dirAbs: dir, project: "factory" });
    assert.equal(result.passed, false);
    assert.equal(result.gateStep, 2);
    assert.equal(existsSync(marker), false, "command 3 must never run when command 2 failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G4: gateStep is the 1-based index of the failing command and gateCommand is its exact string", () => {
  const dir = tmp("gate-g4-");
  try {
    const profile = baseProfile({ gate: ["true", "true", "false"] });
    const result = runGate({ profile, dirAbs: dir, project: "factory" });
    assert.equal(result.passed, false);
    assert.equal(result.gateStep, 3);
    assert.equal(result.gateCommand, "false");
    assert.equal(result.gateRan, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G5: --prepare is a no-op when the marker already exists", () => {
  const dir = tmp("gate-g5-");
  const prepareRanFile = path.join(dir, "prepare-ran");
  try {
    mkdirSync(path.join(dir, "node_modules"));
    const profile = baseProfile({
      gate: ["true"],
      prepareMarker: "node_modules",
      prepare: [`bash -c "touch '${prepareRanFile}'"`],
    });
    const result = runGate({ profile, dirAbs: dir, project: "factory", prepareRequested: true });
    assert.equal(result.passed, true);
    assert.equal(existsSync(prepareRanFile), false, "prepare must not run when the marker already exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G6: an exclusive command takes the lock; a non-exclusive one does not", () => {
  const dir = tmp("gate-g6-");
  const lockDir = tmp("gate-g6-locks-");
  try {
    // The lock's filename is a hash of the command's own text (lockKey), so a
    // command cannot literally embed its own lock path. Break the cycle with one
    // level of indirection: the command reads its expected lock path from a file
    // written by the test *after* the command text (and hence its hash) is fixed.
    const expectedPathFile = path.join(dir, "expected-lock.txt");
    const sentinel = path.join(dir, "had-lock");
    const cmd = `bash -c "test -f $(cat ${expectedPathFile}) && touch ${sentinel} || true"`;
    const lockPath = lockFilePath("factory", cmd, lockDir);
    writeFileSync(expectedPathFile, lockPath);

    // (a) declared exclusive: the lock file must exist DURING the command's own run.
    const exclResult = runGate({
      profile: baseProfile({ gate: [cmd], gateExclusive: [cmd] }),
      dirAbs: dir,
      project: "factory",
      lockDir,
    });
    assert.equal(exclResult.passed, true);
    assert.equal(existsSync(sentinel), true, "an exclusive command must observe its own lock held during its run");
    rmSync(sentinel, { force: true });

    // (b) the exact same command, NOT declared exclusive: no lock file for it at all.
    const plainResult = runGate({
      profile: baseProfile({ gate: [cmd], gateExclusive: [] }),
      dirAbs: dir,
      project: "factory",
      lockDir,
    });
    assert.equal(plainResult.passed, true);
    assert.equal(existsSync(sentinel), false, "a non-exclusive command must never have a lock taken for it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("G7: a lock held by a dead pid is stolen immediately", () => {
  const lockDir = tmp("gate-g7-");
  try {
    const lockPath = path.join(lockDir, "dead.lock");
    const deadPid = spawnSync("true", []).pid; // already exited by the time spawnSync returns
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, host: hostname(), command: "x", project: "factory", dir: "/tmp" }),
    );
    // Freshly written lock (mtime "now") — stolen anyway, proving liveness (not the TTL) drives it.
    const acquired = acquireExclusiveOnce(lockPath, { pid: process.pid, host: hostname(), command: "x" });
    assert.equal(acquired, true);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("G8: a lock held by a live pid is not stolen inside the TTL", () => {
  const lockDir = tmp("gate-g8-");
  try {
    const lockPath = path.join(lockDir, "live.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), command: "x", project: "factory", dir: "/tmp" }),
    );
    const acquired = acquireExclusiveOnce(lockPath, { pid: 999999, host: hostname(), command: "x" });
    assert.equal(acquired, false);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("G9: a corrupt lock file falls back to the mtime TTL", () => {
  const lockDir = tmp("gate-g9-");
  try {
    const lockPath = path.join(lockDir, "corrupt.lock");
    writeFileSync(lockPath, "{not json");
    const old = new Date(Date.now() - 1000);
    utimesSync(lockPath, old, old);
    const acquired = acquireExclusiveOnce(lockPath, { pid: process.pid, host: hostname() }, 500);
    assert.equal(acquired, true, "a corrupt lock older than the (short, test) staleMs must be reclaimed");
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("G10: the lock is released even when the gate command fails", () => {
  const dir = tmp("gate-g10-");
  const lockDir = tmp("gate-g10-locks-");
  try {
    const profile = baseProfile({ gate: ["false"], gateExclusive: ["false"] });
    const lockPath = lockFilePath("factory", "false", lockDir);
    const result = runGate({ profile, dirAbs: dir, project: "factory", lockDir });
    assert.equal(result.passed, false);
    assert.equal(existsSync(lockPath), false, "the lock must be released even on a failing exclusive command");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("G11: a gateExclusive entry absent from gate[] warns on stderr and does not fail", () => {
  const dir = tmp("gate-g11-");
  try {
    const profile = baseProfile({ gate: ["true"], gateExclusive: ["pnpm test:e2e"] });
    const { result, stderr } = withCapturedIO(() => runGate({ profile, dirAbs: dir, project: "factory" }));
    assert.equal(result.passed, true);
    assert.match(stderr, /dead config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G12: --json prints exactly one parseable object on stdout on pass, fail and null alike", () => {
  const cases = [
    { passed: true, gateReason: null, gateCommand: null, gateStep: null, expectCode: 0 },
    { passed: false, gateReason: null, gateCommand: "pnpm test", gateStep: 1, expectCode: 1 },
    { passed: null, gateReason: "no-gate", gateCommand: null, gateStep: null, expectCode: 4 },
  ];
  for (const c of cases) {
    const dir = tmp("gate-g12-");
    try {
      const { result: code, stdout } = withCapturedIO(() =>
        main(["node", "gate.mjs", "--project", "factory", "--dir", dir, "--json"], {
          runGateFn: () => ({
            passed: c.passed,
            gateReason: c.gateReason,
            gateCommand: c.gateCommand,
            gateStep: c.gateStep,
            gateTotal: 1,
            gateRan: c.passed === true ? 1 : 0,
            gateConfigTouched: null,
            commands: [],
          }),
        }),
      );
      assert.equal(code, c.expectCode);
      const parsed = JSON.parse(stdout); // throws if anything but one clean JSON object landed on stdout
      assert.equal(parsed.passed, c.passed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("G13: buildGateEvent output is accepted by metrics.validateEvent", () => {
  const result = {
    project: "factory",
    passed: true,
    gateReason: null,
    gateCommand: null,
    gateStep: null,
    gateTotal: 1,
    gateRan: 1,
    gateConfigTouched: false,
    durationMs: 123,
  };
  const event = buildGateEvent(result, { seat: "worker", runId: "abc" });
  const check = validateEvent(event);
  assert.equal(check.ok, true, check.reason);
});

test("G14: buildGateEvent carries runId through and emits null when absent", () => {
  const result = {
    project: "factory",
    passed: true,
    gateReason: null,
    gateCommand: null,
    gateStep: null,
    gateTotal: 1,
    gateRan: 1,
    gateConfigTouched: null,
    durationMs: 1,
  };
  assert.equal(buildGateEvent(result, { runId: "run-42" }).runId, "run-42");
  assert.equal(buildGateEvent(result, {}).runId, null);
  assert.equal(buildGateEvent(result).runId, null);
});

test("G15: telemetry failure does not change the exit code", () => {
  assert.doesNotThrow(() => {
    recordMetric("some-slug", { seat: "worker", type: "gate_result" }, "factory", () => {
      throw new Error("missions root unwritable");
    });
  });
});

test("G16: a run without --slug still exits with the right code and warns on stderr", () => {
  const dir = tmp("gate-g16-");
  try {
    const { result: code, stderr } = withCapturedIO(() =>
      main(["node", "gate.mjs", "--project", "factory", "--dir", dir], {
        runGateFn: () => ({
          passed: true,
          gateReason: null,
          gateCommand: null,
          gateStep: null,
          gateTotal: 1,
          gateRan: 1,
          gateConfigTouched: null,
          commands: [],
        }),
      }),
    );
    assert.equal(code, 0);
    assert.match(stderr, /no --slug/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Bonus: the real git wiring behind gateConfigTouched (not in the R/G list,
// but the riskiest untested seam if left unchecked) ──────────────────────────

test("bonus: computeGateConfigTouched (real git) is false on a clean worktree and true after an edit", () => {
  const dir = tmp("gate-git-");
  try {
    const git = (args) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    git(["add", "package.json"]);
    git(["commit", "-q", "-m", "init"]);
    git(["branch", "-M", "main"]);

    const profile = baseProfile({ gate: ["true"], gateConfig: ["package.json#/scripts"] });
    const clean = runGate({ profile, dirAbs: dir, project: "factory" });
    assert.equal(clean.gateConfigTouched, false);

    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));
    const dirty = runGate({ profile, dirAbs: dir, project: "factory" });
    assert.equal(dirty.gateConfigTouched, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── R12b: the IO seam that WIRES the merge-base guard ───────────────────────
// R12 proves the pure comparator returns null on an unreadable side. It does NOT
// prove the caller does — `computeGateConfigTouched` was unexported and untested,
// so `if (mergeBase === null) return null` could be flipped to `false` and the
// whole suite stayed green. Found by mutation, 2026-08-28. This is the line the
// plan called most consequential: coercing it to false lets one broken-git
// environment launder every quarantined run into `delivered`.

test("R12b: computeGateConfigTouched is null when the merge-base resolver fails", () => {
  const profile = { trunk: "main", gateConfig: ["package.json#/scripts"] };
  const deps = {
    mergeBase: () => null, // git ref absent, shallow clone, --dir not a repo
    show: () => {
      throw new Error("must not be reached — the baseline is unresolvable");
    },
    read: () => {
      throw new Error("must not be reached");
    },
  };
  assert.equal(computeGateConfigTouched(profile, "/nowhere", deps), null);
});

test("R12b: computeGateConfigTouched is null when the profile declares no gateConfig", () => {
  const deps = {
    mergeBase: () => {
      throw new Error("must not be reached — nothing was declared to compare");
    },
    show: () => null,
    read: () => null,
  };
  assert.equal(computeGateConfigTouched({ trunk: "main", gateConfig: [] }, "/x", deps), null);
});

test("R12b: computeGateConfigTouched delegates to the comparator once a merge-base resolves", () => {
  const deps = {
    mergeBase: () => "abc123",
    show: () => ({ present: true, content: JSON.stringify({ scripts: { test: "node --test" } }) }),
    read: () => ({ present: true, content: JSON.stringify({ scripts: { test: "exit 0" } }) }),
  };
  const profile = { trunk: "main", gateConfig: ["package.json#/scripts"] };
  assert.equal(computeGateConfigTouched(profile, "/x", deps), true);
});

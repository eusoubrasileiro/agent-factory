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
import { spawn } from "node:child_process";
import test from "node:test";

import { killGracefully } from "./worker-common.mjs";

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

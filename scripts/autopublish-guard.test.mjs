/**
 * Source-level invariant tests for the FACTORY_AUTOPUBLISH=0 test-isolation
 * guard (factory-live-board hotfix, orchestrator).
 *
 * Why: verdict.test.mjs / ratify.test.mjs exercise the real recordVerdict /
 * ratify code paths, whose triggerAutopublish() spawns a DETACHED
 * board-autopublish.mjs child with no --repo. Those children inherit the test
 * runner's cwd/env, resolve the REAL repo root, and — once projects.json and
 * the root index exist — execute a REAL rsync publish to the VPS and append
 * test-induced rows to factory/history.jsonl (corrupting feature-04 metrics).
 * Observed 2026-07-08: ~25 detached publishes per `pnpm test:factory` run.
 *
 * The guard: triggerAutopublish() returns early when
 * process.env.FACTORY_AUTOPUBLISH === "0", and the test:factory npm script
 * sets that variable so every spawned descendant inherits it.
 *
 * Style follows the A3 source-level invariant test in
 * board-autopublish.test.mjs: assert on source text, cheap and unambiguous.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const GUARD = 'process.env.FACTORY_AUTOPUBLISH === "0"';

for (const file of ["verdict.mjs", "ratify.mjs"]) {
  test(`${file}: triggerAutopublish is guarded by FACTORY_AUTOPUBLISH=0 before spawning`, () => {
    const src = readFileSync(path.join(here, file), "utf8");
    const fnStart = src.indexOf("function triggerAutopublish");
    assert.notEqual(fnStart, -1, `${file} must define triggerAutopublish`);
    const guardAt = src.indexOf(GUARD, fnStart);
    const spawnAt = src.indexOf("spawn(", fnStart);
    assert.notEqual(guardAt, -1, `${file} triggerAutopublish must check ${GUARD}`);
    assert.notEqual(spawnAt, -1, `${file} triggerAutopublish must spawn the funnel`);
    assert.ok(guardAt < spawnAt, `${file}: the guard must run BEFORE spawn()`);
  });
}

test("package.json test script sets FACTORY_AUTOPUBLISH=0 so test-spawned recorders never publish", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const script = pkg.scripts.test;
  assert.ok(script, "test script must exist");
  assert.match(script, /FACTORY_AUTOPUBLISH=0/, "test must export FACTORY_AUTOPUBLISH=0");
});

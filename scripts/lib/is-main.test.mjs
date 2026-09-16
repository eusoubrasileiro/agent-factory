/**
 * Tests for the total isMain guard.
 *
 *   node --test "scripts/lib/is-main.test.mjs"
 *
 * The bug this pins: `pathToFileURL(process.argv[1])` throws when argv[1] is
 * undefined, so `node -e "import('./scripts/metrics.mjs')"` crashed on IMPORT.
 * Twelve engine scripts shared the guard, so twelve scripts shared the bug.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isMainModule } from "./is-main.mjs";

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("isMainModule: true when argv[1] is this module's own path", () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(isMainModule(import.meta.url, ["node", self]), true);
});

test("isMainModule: false when argv[1] is a different script", () => {
  assert.equal(isMainModule(import.meta.url, ["node", "/somewhere/else.mjs"]), false);
});

// THE regression. `node -e` leaves argv[1] undefined.
test("isMainModule: false — never throws — when argv[1] is absent (node -e)", () => {
  assert.doesNotThrow(() => isMainModule(import.meta.url, ["node"]));
  assert.equal(isMainModule(import.meta.url, ["node"]), false);
  assert.equal(isMainModule(import.meta.url, []), false);
});

test("isMainModule: false — never throws — when argv[1] is not a string", () => {
  assert.equal(isMainModule(import.meta.url, ["node", undefined]), false);
  assert.equal(isMainModule(import.meta.url, ["node", ""]), false);
});

test("isMainModule: agrees with the pathToFileURL identity it replaces", () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(pathToFileURL(self).href, import.meta.url);
  assert.equal(isMainModule(import.meta.url, ["node", self]), true);
});

// The whole point: every engine script must be importable without running its CLI
// and without crashing, from a context that has no argv[1].
test("every engine script imports cleanly from a `node -e` context (no argv[1])", () => {
  const scripts = [
    "metrics.mjs",
    "verdict.mjs",
    "ratify.mjs",
    "board-report.mjs",
    "board-sync.mjs",
    "board-index.mjs",
    "board-autopublish.mjs",
    "board-import-backlog.mjs",
    "mission-stats.mjs",
    "pr-record.mjs",
    "probe-secrets.mjs",
    "cage-settings.mjs",
  ];
  for (const s of scripts) {
    const abs = path.join(SCRIPTS_DIR, s);
    const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(pathToFileURL(abs).href)})`], {
      encoding: "utf8",
      env: { ...process.env, FACTORY_AUTOPUBLISH: "0", FACTORY_PR: "0" },
    });
    assert.equal(r.status, 0, `importing ${s} from node -e failed:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ERR_INVALID_ARG_TYPE/, `${s} still crashes on import`);
  }
});

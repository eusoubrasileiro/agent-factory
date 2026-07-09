/**
 * Tests for the cage probe's static checks.
 *
 * The probe is the cage's regression contract, so its own checks must be able to
 * FAIL. A probe that cannot go red is a green tick, not a guarantee.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { renderOpencodeCage } from "./cage-opencode.mjs";
import { staticChecks } from "./probe-cage.mjs";

const GLOBS = ["backend/src/bot/**", "prisma/schema.prisma"];
const WT = "/tmp/wt";
const CAGE_OUT = "/tmp/amiticia-cages/wt.opencode.json";

const names = (cs) => cs.filter((c) => !c.ok).map((c) => c.name);

test("staticChecks: a correct cage passes every class", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  assert.deepEqual(names(staticChecks(cage, GLOBS, WT, CAGE_OUT)), []);
});

test("staticChecks: FAILS when a critical file is not denied", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  delete cage.permission.edit["prisma/schema.prisma"];
  assert.ok(names(staticChecks(cage, GLOBS, WT, CAGE_OUT)).includes("critical-file edits denied"));
});

test("staticChecks: FAILS when git push is allowed", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  cage.permission.bash["git push *"] = "allow";
  assert.ok(names(staticChecks(cage, GLOBS, WT, CAGE_OUT)).includes("git push denied"));
});

test("staticChecks: FAILS when the wildcard is last (the order trap)", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  const reordered = {};
  for (const [k, v] of Object.entries(cage.permission.edit)) if (k !== "*") reordered[k] = v;
  reordered["*"] = "allow";
  cage.permission.edit = reordered;
  const failed = names(staticChecks(cage, GLOBS, WT, CAGE_OUT));
  assert.ok(failed.some((n) => /wildcard is first/.test(n)), "the order trap must be caught");
});

test("staticChecks: FAILS when the cage does not protect itself", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  delete cage.permission.edit["opencode.json"];
  assert.ok(names(staticChecks(cage, GLOBS, WT, CAGE_OUT)).includes("cage protects itself"));
});

test("staticChecks: FAILS when the cage file sits inside the worktree it guards", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  const inside = path.join(WT, ".opencode-cage.json");
  assert.ok(names(staticChecks(cage, GLOBS, WT, inside)).includes("cage file lives outside the worktree"));
});

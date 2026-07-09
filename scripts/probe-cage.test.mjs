/**
 * Tests for the cage probe's static checks.
 *
 * The probe is the cage's regression contract, so its own checks must be able to
 * FAIL. A probe that cannot go red is a green tick, not a guarantee.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadTemplate, renderCageSettings } from "./cage-settings.mjs";
import { renderOpencodeCage } from "./cage-opencode.mjs";
import { claudeStaticChecks, staticChecks } from "./probe-cage.mjs";

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

// ─── the Claude cage's static checks must be able to go RED ──────────────────

const CC_WT = "/tmp/wt";
const CC_CAGE = "/tmp/wt/.claude/settings.external.json";

function ccCage(globs = GLOBS) {
  return renderCageSettings(loadTemplate(), CC_WT, { criticalFiles: globs, sandboxEnabled: false });
}

test("claudeStaticChecks: a correct Claude cage passes every class", () => {
  assert.deepEqual(names(claudeStaticChecks(ccCage(), GLOBS, CC_WT, CC_CAGE)), []);
});

test("claudeStaticChecks: FAILS when a critical file loses its Write deny", () => {
  const cage = ccCage();
  cage.permissions.deny = cage.permissions.deny.filter((r) => !r.startsWith("Write(//tmp/wt/prisma"));
  assert.ok(names(claudeStaticChecks(cage, GLOBS, CC_WT, CC_CAGE)).includes("critical-file Edit+Write denied"));
});

test("claudeStaticChecks: FAILS on a mis-anchored rule (the single-slash trap)", () => {
  const cage = ccCage();
  cage.permissions.deny.push("Edit(/tmp/wt/backend/src/bot/**)"); // single slash = anchored to the settings dir
  const failed = names(claudeStaticChecks(cage, GLOBS, CC_WT, CC_CAGE));
  assert.ok(failed.some((n) => /mis-anchored/.test(n)));
});

test("claudeStaticChecks: FAILS on a wholesale .claude/** deny (M11: it bricks the seat)", () => {
  const cage = ccCage();
  cage.permissions.deny.push("Write(//tmp/wt/.claude/**)");
  const failed = names(claudeStaticChecks(cage, GLOBS, CC_WT, CC_CAGE));
  assert.ok(failed.some((n) => /wholesale-deny/.test(n)));
});

test("claudeStaticChecks: FAILS when git push is not denied", () => {
  const cage = ccCage();
  cage.permissions.deny = cage.permissions.deny.filter((r) => !/git push/.test(r));
  assert.ok(names(claudeStaticChecks(cage, GLOBS, CC_WT, CC_CAGE)).includes("git push denied"));
});

test("claudeStaticChecks: FAILS on an unsubstituted placeholder", () => {
  const cage = ccCage();
  cage.permissions.deny.push("Edit(//{{WORKTREE}}/x)");
  assert.ok(names(claudeStaticChecks(cage, GLOBS, CC_WT, CC_CAGE)).includes("no unsubstituted {{placeholder}}"));
});

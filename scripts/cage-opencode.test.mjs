/**
 * Tests for the opencode-native cage.
 *
 *   node --test "scripts/cage-opencode.test.mjs"
 *
 * Why this file exists: `cage-settings.mjs` renders a Claude Code cage that NOTHING
 * installs, and opencode — the driver we actually run — does not read Claude Code's
 * settings schema. So the Critical-File denies were never enforced for the seat that
 * does our work. This cage is the one that bites.
 *
 * The load-bearing invariant is ORDER. opencode resolves permissions by
 * last-matching-rule-wins, so `"*": "allow"` must come FIRST; put it last and every
 * deny below it is dead. That is not a style preference, it is the difference between
 * a cage and a decoration.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SELF_PROTECT_GLOBS,
  auditOpencodeCage,
  opencodeCagePath,
  renderOpencodeCage,
  writeOpencodeCage,
} from "./cage-opencode.mjs";

const GLOBS = ["backend/src/bot/**", "prisma/schema.prisma", "quality-baseline.json"];

/** A throwaway factory root holding one profile. */
function makeFactoryRoot(prefix, { id, criticalFiles }) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const dir = path.join(root, "projects", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.json"), JSON.stringify({ id, path: ".", gate: ["true"] }));
  if (criticalFiles) {
    writeFileSync(path.join(dir, "critical-files.json"), JSON.stringify(criticalFiles));
  }
  return root;
}

// ─── ordering: the invariant everything else rests on ────────────────────────

test('renderOpencodeCage: "*" is the FIRST key of edit and of bash (last match wins)', () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  assert.equal(Object.keys(cage.permission.edit)[0], "*", "edit: '*' must come first");
  assert.equal(Object.keys(cage.permission.bash)[0], "*", "bash: '*' must come first");
});

test('renderOpencodeCage: "*" maps to allow, so the seat stays productive', () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  assert.equal(cage.permission.edit["*"], "allow");
  assert.equal(cage.permission.bash["*"], "allow");
});

// ─── what the cage must deny ─────────────────────────────────────────────────

test("renderOpencodeCage: every profile critical file becomes an edit deny", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  for (const g of GLOBS) assert.equal(cage.permission.edit[g], "deny", `not denied: ${g}`);
});

test("renderOpencodeCage: the cage denies edits to its own config (self-protection)", () => {
  // A project `opencode.json` outranks $OPENCODE_CONFIG, so an uncaged agent could
  // simply write one and override us. Deny that from the first turn.
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  for (const g of SELF_PROTECT_GLOBS) {
    assert.equal(cage.permission.edit[g], "deny", `self-protect glob not denied: ${g}`);
  }
  assert.ok(SELF_PROTECT_GLOBS.includes("opencode.json"));
  assert.ok(SELF_PROTECT_GLOBS.includes(".opencode/**"));
});

test("renderOpencodeCage: git push is denied", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  assert.equal(cage.permission.bash["git push *"], "deny");
  assert.equal(cage.permission.bash["git push"], "deny");
});

test("renderOpencodeCage: with no project, emits the generic base and zero product paths", () => {
  const cage = renderOpencodeCage();
  const edits = Object.keys(cage.permission.edit);
  assert.deepEqual(edits, ["*", ...SELF_PROTECT_GLOBS], "base = wildcard + self-protect only");
  assert.equal(cage.permission.bash["git push *"], "deny");
  const serialized = JSON.stringify(cage);
  for (const bad of ["backend/", "frontend/", "prisma/", "demo/"]) {
    assert.ok(!serialized.includes(bad), `base cage names a product path: ${bad}`);
  }
});

test("renderOpencodeCage: tolerates a nullish / non-array criticalFiles", () => {
  assert.doesNotThrow(() => renderOpencodeCage({ criticalFiles: null }));
  assert.doesNotThrow(() => renderOpencodeCage({ criticalFiles: "nope" }));
  assert.doesNotThrow(() => renderOpencodeCage({}));
});

// ─── audit: fail closed ──────────────────────────────────────────────────────

test("auditOpencodeCage: a clean cage has zero problems", () => {
  assert.deepEqual(auditOpencodeCage(renderOpencodeCage({ criticalFiles: GLOBS })), []);
});

test("auditOpencodeCage: rejects a cage whose wildcard is not first (the order trap)", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  // Rebuild `edit` with the wildcard LAST — every deny above it is then overridden.
  const reordered = {};
  for (const [k, v] of Object.entries(cage.permission.edit)) if (k !== "*") reordered[k] = v;
  reordered["*"] = "allow";
  cage.permission.edit = reordered;
  const problems = auditOpencodeCage(cage);
  assert.ok(problems.length > 0, "a wildcard-last cage must be refused");
  assert.match(problems.join("\n"), /first key/i);
});

test("auditOpencodeCage: rejects a missing self-protect entry", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  delete cage.permission.edit["opencode.json"];
  assert.match(auditOpencodeCage(cage).join("\n"), /opencode\.json/);
});

test("auditOpencodeCage: rejects an undenied git push", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  cage.permission.bash["git push *"] = "allow";
  assert.match(auditOpencodeCage(cage).join("\n"), /git push/);
});

test("auditOpencodeCage: rejects a value that is not allow/deny/ask", () => {
  const cage = renderOpencodeCage({ criticalFiles: GLOBS });
  cage.permission.edit["prisma/schema.prisma"] = "maybe";
  assert.match(auditOpencodeCage(cage).join("\n"), /maybe/);
});

test("auditOpencodeCage: rejects a missing permission block", () => {
  assert.ok(auditOpencodeCage({}).length > 0);
  assert.ok(auditOpencodeCage({ permission: { edit: {} } }).length > 0);
  assert.ok(auditOpencodeCage(null).length > 0);
});

// ─── write: never persist a broken cage ──────────────────────────────────────

test("writeOpencodeCage: writes a cage that survives a JSON round-trip and re-audit", () => {
  const root = makeFactoryRoot("cage-oc-write-", { id: "proj", criticalFiles: GLOBS });
  const dest = path.join(root, "cage.json");
  try {
    const out = writeOpencodeCage(dest, { project: "proj", factoryRoot: root });
    assert.equal(out, dest);
    const reread = JSON.parse(readFileSync(dest, "utf8"));
    assert.deepEqual(auditOpencodeCage(reread), []);
    assert.equal(Object.keys(reread.permission.edit)[0], "*", "order survives serialization");
    for (const g of GLOBS) assert.equal(reread.permission.edit[g], "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeOpencodeCage: an unknown project still yields a base cage, never throws", () => {
  const root = makeFactoryRoot("cage-oc-unknown-", { id: "proj", criticalFiles: GLOBS });
  const dest = path.join(root, "cage.json");
  try {
    assert.doesNotThrow(() => writeOpencodeCage(dest, { project: "nope", factoryRoot: root }));
    const cage = JSON.parse(readFileSync(dest, "utf8"));
    assert.deepEqual(auditOpencodeCage(cage), []);
    assert.equal(cage.permission.bash["git push *"], "deny", "base cage still denies push");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeOpencodeCage: REFUSES to write a cage that fails its own audit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cage-oc-refuse-"));
  const dest = path.join(root, "cage.json");
  try {
    // A render hook that returns a wildcard-last cage — the exact silent-failure shape.
    assert.throws(
      () => writeOpencodeCage(dest, { renderFn: () => ({ permission: { edit: { "a": "deny", "*": "allow" }, bash: {} } }) }),
      /refusing to write a broken cage/,
    );
    assert.throws(() => readFileSync(dest, "utf8"), /ENOENT/, "nothing may be written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencodeCagePath: lands outside the worktree it guards", () => {
  const p = opencodeCagePath("/some/worktree", "/tmp/cages");
  assert.ok(path.isAbsolute(p));
  assert.ok(!p.startsWith("/some/worktree"), "an agent must not be able to edit its own cage");
});

#!/usr/bin/env node
/**
 * Tests for the project resolver profile extension (feature 02).
 *
 *   node --test "scripts/project-resolver.test.mjs"
 *
 * Layers:
 *   1. resolveProject against the REAL factory root — wahub exposes its
 *      checked-in profile (gate, criticalFiles, seat.env, validation.md).
 *   2. profile-less entry → synthesized defaults, never throws.
 *   3. corrupt project.json → defaults, never throws.
 *   4. unknown id resolves as itself with a default profile (no "wahub" literal).
 *   5. loadProjects scans "projects/ID/project.json" and merges deploy/projects.json.
 *   6. dir/repo overrides still win over the manifest.
 *
 * House style mirrors history.test.mjs: mkdtempSync fixtures, rmSync finally.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadProjects, resolveProject } from "./lib/project.mjs";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** The REAL factory root derived the same way project.mjs derives FACTORY_ROOT. */
const REAL_FACTORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Assert `actual` matches a default profile (independent of any project dir).
 * Used by the soft-fail / fallback tests.
 */
function assertDefaultProfile(actual) {
  assert.deepEqual(actual, {
    gate: [],
    trunk: "main",
    branchPrefix: "agent/",
    worktreeMarker: "/.claude/worktrees/",
    criticalFiles: [],
    seatEnvPath: null,
    validationPath: null,
    intake: [],
  });
}

/** Write a `projects/<id>/project.json` and optional sibling files under root. */
function writeProject(root, id, projectJson, siblings = {}) {
  const dir = path.join(root, "projects", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.json"), JSON.stringify(projectJson));
  for (const [name, content] of Object.entries(siblings)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// ─── 1. Real factory root: wahub exposes its checked-in profile ────────────────

test("resolveProject: wahub profile exposes gate, criticalFiles, seat.env, validation.md", () => {
  const r = resolveProject({ project: "wahub" }, REAL_FACTORY_ROOT);

  // Identity & shape sanity.
  assert.equal(r.id, "wahub");
  assert.ok(r.profile, "profile key must exist");

  // gate from projects/wahub/project.json (5 commands, verbatim first/last).
  assert.ok(Array.isArray(r.profile.gate));
  assert.equal(r.profile.gate.length, 5);
  assert.equal(r.profile.gate[0], "pnpm quality-gate");
  assert.equal(r.profile.gate.at(-1), "pnpm lint");

  // trunk / branchPrefix from project.json.
  assert.equal(r.profile.trunk, "main");
  assert.equal(r.profile.branchPrefix, "agent/");

  // critical-files.json is a JSON array of glob strings. Pin by IDENTITY, not
  // count (E3-a): a count assertion greenlights a silent swap/removal — the exact
  // failure mode of D-37, where the dead path `prisma/schema.prisma` sat unnoticed
  // until it was corrected to `backend/prisma/schema.prisma` (+ migrations/**),
  // which is what took this list 12 -> 13 and broke the old `length === 12` pin.
  assert.ok(Array.isArray(r.profile.criticalFiles));
  assert.ok(
    r.profile.criticalFiles.every((g) => typeof g === "string"),
    "every critical file is a glob string",
  );
  // The security-consequential globs whose silent absence would open a hole.
  for (const glob of [
    "backend/src/bot/**",
    "backend/src/lib/waba.ts",
    "backend/prisma/schema.prisma",
    "backend/prisma/migrations/**",
  ]) {
    assert.ok(
      r.profile.criticalFiles.includes(glob),
      `critical-files must protect ${glob} by identity`,
    );
  }

  // seat.env + validation.md resolved to ABS paths under projects/wahub/.
  assert.equal(
    r.profile.seatEnvPath,
    path.join(REAL_FACTORY_ROOT, "projects", "wahub", "seat.env"),
  );
  assert.equal(
    r.profile.validationPath,
    path.join(REAL_FACTORY_ROOT, "projects", "wahub", "validation.md"),
  );
});

// ─── 2. Profile-less entry → synthesized defaults, never throws ────────────────

test("resolveProject: profile-less entry gets synthesized defaults, never throws", () => {
  const root = makeTmpDir("proj-noprofile-");
  try {
    // Entry with id/path only — no gate, trunk, branchPrefix, no sibling files.
    writeProject(root, "plain", { id: "plain", name: "Plain", path: "." });

    const r = resolveProject({ project: "plain" }, root);
    assert.equal(r.id, "plain");
    assert.ok(r.profile, "profile key always present");
    assertDefaultProfile(r.profile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 3. Corrupt project.json → defaults, never throws ─────────────────────────

test("resolveProject: corrupt project.json → defaults, never throws", () => {
  const root = makeTmpDir("proj-corrupt-");
  try {
    const dir = path.join(root, "projects", "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "project.json"), "{ not valid json");

    const r = resolveProject({ project: "broken" }, root);
    assert.equal(r.id, "broken", "id preserved on fallback");
    assert.ok(r.profile, "profile key always present");
    assertDefaultProfile(r.profile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 4. Unknown id resolves as itself with a default profile ──────────────────

test("resolveProject: no 'wahub' literal fallback — unknown id resolves as itself with default profile", () => {
  const root = makeTmpDir("proj-unknown-");
  try {
    // Empty projects/ — nothing matches.
    mkdirSync(path.join(root, "projects"), { recursive: true });

    const r = resolveProject({ project: "does-not-exist-xyz" }, root);
    assert.equal(r.id, "does-not-exist-xyz", "unknown id resolves as itself");
    assert.notEqual(r.id, "wahub", "no 'wahub' literal fallback");
    assert.ok(r.profile, "profile key always present");
    assertDefaultProfile(r.profile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 5. loadProjects: projects/* + deploy/projects.json merge ─────────────────

test("loadProjects: scans projects/*/project.json and merges deploy/projects.json back-compat", () => {
  const root = makeTmpDir("proj-load-");
  try {
    // projects/alpha and projects/beta — the new shape.
    writeProject(root, "alpha", {
      id: "alpha",
      name: "Alpha from projects/",
      path: ".",
      fromProjects: true,
    });
    writeProject(root, "beta", {
      id: "beta",
      name: "Beta from projects/",
      path: ".",
    });

    // deploy/projects.json — old shape, has alpha (must LOSE) + gamma (back-compat).
    const deployDir = path.join(root, "deploy");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(
      path.join(deployDir, "projects.json"),
      JSON.stringify([
        { id: "alpha", name: "Alpha from deploy", fromDeploy: true },
        { id: "gamma", name: "Gamma from deploy", path: "." },
      ]),
    );

    const projects = loadProjects(root);
    const byId = Object.fromEntries(projects.map((p) => [p.id, p]));

    // All three ids present.
    assert.ok(byId.alpha, "alpha merged in");
    assert.ok(byId.beta, "beta picked up from projects/");
    assert.ok(byId.gamma, "gamma picked up from deploy/ (back-compat)");

    // Conflict resolution: projects/ wins for alpha.
    assert.equal(
      byId.alpha.fromProjects,
      true,
      "projects/<id>/project.json entry wins on conflict",
    );
    assert.equal(
      byId.alpha.fromDeploy,
      undefined,
      "deploy fields do NOT bleed into a projects/ entry",
    );
    assert.equal(byId.alpha.name, "Alpha from projects/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 6. dir and repo overrides still win over the manifest ────────────────────

test("resolveProject: dir and repo overrides still win over the manifest", () => {
  const root = makeTmpDir("proj-overrides-");
  try {
    writeProject(root, "myid", {
      id: "myid",
      name: "MyId",
      path: "../../somewhere/in/manifest",
    });

    const r = resolveProject(
      { project: "myid", dir: "/custom/missions", repo: "/custom/repo" },
      root,
    );

    assert.equal(r.id, "myid");
    // dir overrides missionsRoot.
    assert.equal(r.missionsRoot, path.resolve("/custom/missions"));
    // repo overrides repoRoot (legacy alias for path).
    assert.equal(r.repoRoot, path.resolve("/custom/repo"));
    // prdPath is null because the entry has no prd; profile still synthesized.
    assert.equal(r.prdPath, null);
    assert.ok(r.profile, "profile present even when overrides are used");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── E4-a: worktreeMarker is a profile FACT, not an engine constant (D-27) ─────
test("resolveProject: worktreeMarker comes from project.json (factory = /.worktrees/)", () => {
  assert.equal(resolveProject({ project: "factory" }).profile.worktreeMarker, "/.worktrees/");
});

test("resolveProject: worktreeMarker defaults to /.claude/worktrees/ when absent", () => {
  const root = makeTmpDir("proj-wtmarker-");
  try {
    writeProject(root, "nomark", { id: "nomark", name: "NoMark", path: "." });
    assert.equal(resolveProject({ project: "nomark" }, root).profile.worktreeMarker, "/.claude/worktrees/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

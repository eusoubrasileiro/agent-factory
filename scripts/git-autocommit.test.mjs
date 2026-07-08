/**
 * Tests for the factory auto-commit helper.
 *
 *   node --test "scripts/factory/*.test.mjs"
 *
 * Exercises `autoCommit` against real `git init` fixture repos: pathspec
 * isolation (other dirty files left out), silent no-op on nothing-to-commit,
 * silent no-op outside a git repo, and never throws on git errors.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { autoCommit } from "./git-autocommit.mjs";

const SLUG = "demo-mission";

/** Minimal `git init` in a temp dir + the factory-repo missions layout under it. */
function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "autocommit-repo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  // Commit an initial anchor so later commits have a parent.
  writeFileSync(path.join(repo, "README.md"), "# init\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  // Post-extraction factory layout: missions root = repo/missions/<project>;
  // history.jsonl lives at the repo (factory) root.
  const missionsRoot = path.join(repo, "missions", "wahub");
  mkdirSync(path.join(missionsRoot, SLUG), { recursive: true });
  return { repo, missionsRoot };
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return r;
}

function headMessage(repo) {
  return git(repo, ["log", "-1", "--pretty=%B"]).stdout.trim();
}

function statusPorcelain(repo) {
  return git(repo, ["status", "--porcelain"]).stdout;
}

// ─── pathspec isolation ───────────────────────────────────────────────────────

test("autoCommit commits only the pathspec'd mission dir, leaving other dirty files untouched", () => {
  const { repo, missionsRoot } = makeRepo();
  try {
    // mission dossier file (in-pathspec) + unrelated dirty file (out-of-pathspec)
    writeFileSync(path.join(missionsRoot, SLUG, "validate.log"), '{"round":1}\n');
    mkdirSync(path.join(repo, "backend", "src"), { recursive: true });
    writeFileSync(path.join(repo, "backend", "src", "x.ts"), "export const x = 1;\n");

    const res = autoCommit(missionsRoot, SLUG, `chore(factory): verdict ${SLUG} round 1 FAIL`);
    assert.equal(res.committed, true, res.reason ?? "");

    // the mission file is committed (clean in working tree, present in HEAD)
    assert.equal(
      git(repo, ["show", `HEAD:missions/wahub/${SLUG}/validate.log`]).status,
      0,
      "mission file should be in HEAD",
    );
    assert.match(headMessage(repo), /^chore\(factory\): verdict demo-mission round 1 FAIL$/);

    // the backend file is still untracked/dirty, NOT committed
    assert.match(statusPorcelain(repo), /backend/, "unrelated dirty file remains");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("autoCommit includes factory/history.jsonl in the pathspec when present", () => {
  const { repo, missionsRoot } = makeRepo();
  try {
    writeFileSync(path.join(repo, "history.jsonl"), '{"ts":"x"}\n');
    writeFileSync(path.join(missionsRoot, SLUG, "RATIFIED"), "ratified 2026-07-08\n");

    const res = autoCommit(missionsRoot, SLUG, `chore(factory): ratify ${SLUG}`);
    assert.equal(res.committed, true, res.reason ?? "");
    assert.equal(
      git(repo, ["show", "HEAD:history.jsonl"]).status,
      0,
      "history.jsonl should be in HEAD",
    );
    assert.equal(
      git(repo, ["show", `HEAD:missions/wahub/${SLUG}/RATIFIED`]).status,
      0,
      "RATIFIED should be in HEAD",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── nothing to commit ─────────────────────────────────────────────────────────

test("autoCommit is a silent no-op when nothing in the pathspec has changed", () => {
  const { repo, missionsRoot } = makeRepo();
  try {
    // commit the mission dir once so a second run has nothing new
    writeFileSync(path.join(missionsRoot, SLUG, "validate.log"), '{"round":1}\n');
    autoCommit(missionsRoot, SLUG, "chore(factory): verdict demo-mission round 1 FAIL");
    assert.equal(existsSync(path.join(repo, ".git")), true);

    const res = autoCommit(missionsRoot, SLUG, "chore(factory): verdict demo-mission round 1 FAIL");
    assert.equal(res.committed, false);
    assert.equal(res.reason, "nothing-to-commit");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── not a repo ────────────────────────────────────────────────────────────────

test("autoCommit is a silent no-op outside a git repo", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autocommit-nogit-"));
  try {
    mkdirSync(path.join(root, SLUG), { recursive: true });
    writeFileSync(path.join(root, SLUG, "validate.log"), '{"round":1}\n');
    const res = autoCommit(root, SLUG, "chore(factory): verdict demo-mission round 1 FAIL");
    assert.equal(res.committed, false);
    assert.equal(res.reason, "not-a-repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── soft-fail ─────────────────────────────────────────────────────────────────

test("autoCommit never throws even when git errors (returns committed:false)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autocommit-throw-"));
  try {
    // no .git, no mission dir, nothing — must not throw
    const res = autoCommit(root, "nope", "chore(factory): whatever");
    assert.equal(res.committed, false);
    assert.equal(typeof res.reason, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

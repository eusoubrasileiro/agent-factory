/**
 * Tests for the factory ratification recorder.
 *
 *   node --test "scripts/factory/*.test.mjs"
 *
 * Exercises the CLI (`ratify <slug>`) through a real child process against a
 * temp mission dir: unknown slug, no/green/red validate.log, --force override,
 * idempotent re-run. The last test proves a RATIFIED marker — the thing this
 * command writes — moves the card to `Done` via `deriveMissionState` (imported
 * from board-sync.mjs, the projector that consumes it).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveMissionState } from "./board-sync.mjs";

const CLI = fileURLToPath(new URL("./ratify.mjs", import.meta.url));
const SLUG = "demo-mission";

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ratify-test-"));
  mkdirSync(path.join(root, SLUG), { recursive: true });
  return root;
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--dir", root], { encoding: "utf8" });
}

const jsonl = (...objs) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
const verdict = (round, v) => ({
  slug: SLUG,
  round,
  verdict: v,
  assertions: [{ id: "A1", status: v === "PASS" ? "green" : "red", proof: "x" }],
  escalate: false,
});

function writeLog(root, slug, contents) {
  writeFileSync(path.join(root, slug, "validate.log"), contents);
}

function ratified(root, slug) {
  return existsSync(path.join(root, slug, "RATIFIED"));
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

test("ratify refuses an unknown mission slug with exit 1", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ratify-test-"));
  try {
    const r = runCli(root, ["no-such-mission"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown mission slug/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ratify refuses a mission with no validate.log (exit 1)", () => {
  const root = makeRoot();
  try {
    const r = runCli(root, [SLUG]);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /PASS|verdict|validate/i);
    assert.equal(ratified(root, SLUG), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ratify refuses when the last verdict is FAIL (exit 1)", () => {
  const root = makeRoot();
  try {
    writeLog(root, SLUG, jsonl(verdict(1, "FAIL")));
    const r = runCli(root, [SLUG]);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /PASS|verdict/i);
    assert.equal(ratified(root, SLUG), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ratify --force overrides a FAIL verdict and writes RATIFIED (exit 0)", () => {
  const root = makeRoot();
  try {
    writeLog(root, SLUG, jsonl(verdict(1, "FAIL")));
    const r = runCli(root, [SLUG, "--force"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ratified(root, SLUG), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ratify --force overrides an absent validate.log (exit 0)", () => {
  const root = makeRoot();
  try {
    const r = runCli(root, [SLUG, "--force"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ratified(root, SLUG), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ratify writes RATIFIED with a `ratified <date>` line when last verdict is PASS (exit 0)", () => {
  const root = makeRoot();
  try {
    writeLog(root, SLUG, jsonl(verdict(1, "FAIL"), verdict(2, "PASS")));
    const r = runCli(root, [SLUG]);
    assert.equal(r.status, 0, r.stderr);
    const content = readFileSync(path.join(root, SLUG, "RATIFIED"), "utf8");
    assert.match(content, /^ratified \d{4}-\d{2}-\d{2}\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ratify is idempotent: a second run exits 0 and says so", () => {
  const root = makeRoot();
  try {
    writeLog(root, SLUG, jsonl(verdict(1, "PASS")));
    assert.equal(runCli(root, [SLUG]).status, 0);
    const r2 = runCli(root, [SLUG]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /already|ratified/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a RATIFIED mission derives Done via board-sync.deriveMissionState", () => {
  const root = makeRoot();
  try {
    writeLog(root, SLUG, jsonl(verdict(1, "PASS")));
    runCli(root, [SLUG]);
    const dir = path.join(root, SLUG);
    assert.deepEqual(deriveMissionState(dir), { status: "Done", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── auto-commit (factory-live-board feature 01) ──────────────────────────────

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return r;
}

/** A real `git init` repo with the factory/missions layout the CLI expects. */
function makeGitRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "ratify-git-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "README.md"), "# init\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const missionsRoot = path.join(repo, "factory", "missions");
  mkdirSync(path.join(missionsRoot, SLUG), { recursive: true });
  return { repo, missionsRoot };
}

test("ratify auto-commits the RATIFIED marker in a git repo", () => {
  const { repo, missionsRoot } = makeGitRepo();
  try {
    writeFileSync(path.join(missionsRoot, SLUG, "validate.log"), jsonl(verdict(1, "PASS")));
    const r = runCli(missionsRoot, [SLUG]);
    assert.equal(r.status, 0, r.stderr);

    const head = git(repo, ["log", "-1", "--pretty=%B"]).stdout.trim();
    assert.match(head, new RegExp(`^chore\\(factory\\): ratify ${SLUG}$`));
    assert.equal(
      git(repo, ["show", `HEAD:factory/missions/${SLUG}/RATIFIED`]).status,
      0,
      "RATIFIED should be in HEAD",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ratify soft-fails autoCommit outside a git repo (still exits 0)", () => {
  // Non-git temp dir: autoCommit must no-op and ratify must still succeed.
  const root = makeRoot();
  try {
    writeLog(root, SLUG, jsonl(verdict(1, "PASS")));
    const r = runCli(root, [SLUG]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ratified(root, SLUG), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Tests for the cage probe's static checks.
 *
 * The probe is the cage's regression contract, so its own checks must be able to
 * FAIL. A probe that cannot go red is a green tick, not a guarantee.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadTemplate, renderCageSettings } from "./cage-settings.mjs";
import { renderOpencodeCage } from "./cage-opencode.mjs";
import {
  armPushDetector,
  buildParentEnvFixture,
  captureRemoteRefs,
  checkTag,
  checksPass,
  claudeStaticChecks,
  disarmPushDetector,
  restoreFile,
  sentinelPathFor,
  snapshotFile,
  staticChecks,
} from "./probe-cage.mjs";

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

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

// ─── Defect 1: a disarmed cage must not certify (CONTROL + known-project gate) ──
//
// With no `--project`, or a misspelled one, `criticalFiles` is `[]`, so the deny
// check `missing = [].filter(...)` is `[]` → `ok:true` VACUOUSLY. The probe whose
// job is to catch a disarmed cage green-lights one. `runLive` already guards this
// (it throws "declares no critical files"); static mode did not. Two fixes: a
// CONTROL check FIRST in the static arrays (the precondition that makes the denies
// meaningful), and a CLI gate on `assertKnownProject` (an absent/unknown id never
// reaches the renderer).

test("staticChecks: CONTROL is FIRST and FAILS when no Critical Files are declared (vacuous denies)", () => {
  const cage = renderOpencodeCage({ criticalFiles: [] });
  const cs = staticChecks(cage, [], WT, CAGE_OUT);
  assert.equal(cs[0].name, "CONTROL: the cage declares Critical Files to enforce");
  assert.equal(cs[0].ok, false, "an empty Critical-File set must fail the CONTROL");
  assert.match(cs[0].detail, /VACUOUS/, "the detail must say the denies below prove nothing");
});

test("staticChecks: CONTROL passes when Critical Files are present", () => {
  const cs = staticChecks(renderOpencodeCage({ criticalFiles: GLOBS }), GLOBS, WT, CAGE_OUT);
  assert.equal(cs[0].ok, true);
});

test("claudeStaticChecks: CONTROL is FIRST and FAILS when no Critical Files are declared", () => {
  const cs = claudeStaticChecks(ccCage([]), [], CC_WT, CC_CAGE);
  assert.match(cs[0].name, /CONTROL/);
  assert.equal(cs[0].ok, false);
  assert.match(cs[0].detail, /VACUOUS/);
});

test("claudeStaticChecks: CONTROL passes when Critical Files are present", () => {
  const cs = claudeStaticChecks(ccCage(), GLOBS, CC_WT, CC_CAGE);
  assert.equal(cs[0].ok, true);
});

/** Spawn the probe CLI; returns {status, stdout, stderr}. */
function runProbe(args) {
  const script = path.join(SCRIPTS_DIR, "probe-cage.mjs");
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("CLI: exits 2 and lists known projects when --project is absent", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "probe-cage-cli-"));
  try {
    const r = runProbe([wt, "--driver", "claude"]); // no --project
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /--project is required/);
    assert.match(r.stderr, /Known projects:/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("CLI: exits 2 on an unknown --project id", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "probe-cage-cli-"));
  try {
    const r = runProbe([wt, "--project", "whaub", "--driver", "claude"]);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /unknown/);
    assert.match(r.stderr, /Known projects:/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ─── Defect 3: the push check must really detect a push (SKIPPED, never PASS) ────
//
// `git push` never moves local HEAD, so the old "HEAD unchanged (no push, no
// commit)" check passed whether or not the push succeeded — a placebo for the push
// half. The HEAD check now says what it proves (no COMMIT); a real push detector
// compares a local bare remote's refs before/after. A check that cannot run must
// print SKIP, never PASS, and must not let the run exit 0.

test("checkTag: SKIP for a skipped check — never PASS — (PASS/FAIL otherwise)", () => {
  assert.equal(checkTag({ ok: true, skipped: true }), "SKIP");
  assert.equal(checkTag({ ok: false, skipped: true }), "SKIP");
  assert.equal(checkTag({ ok: true }), "PASS");
  assert.equal(checkTag({ ok: false }), "FAIL");
});

test("checksPass: a SKIPPED check does not count as a pass (run must not exit 0)", () => {
  // A skipped check that carries ok:true still must not pass — a check that could
  // not run proves nothing, so it must not let the process exit 0 implying success.
  assert.equal(checksPass([{ ok: true, skipped: true }]), false);
  assert.equal(checksPass([{ ok: true }, { ok: true, skipped: true }]), false);
  assert.equal(checksPass([{ ok: false }]), false);
  assert.equal(checksPass([{ ok: true }]), true);
  assert.equal(checksPass([{ ok: true }, { ok: true }]), true);
});

/** A temp git repo with one commit, for push-detector tests (no model involved). */
function makeGitRepo(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const g = (args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "probe@test"]);
  g(["config", "user.name", "probe"]);
  writeFileSync(path.join(dir, "file.txt"), "one\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "init"]);
  return dir;
}

test("captureRemoteRefs: empty for a fresh bare remote, unchanged without a push, changed after one", () => {
  const repo = makeGitRepo("probe-push-bare-");
  try {
    const arm = armPushDetector(repo);
    assert.ok(arm, "arming must succeed against a real git repo");
    try {
      const before = captureRemoteRefs(arm.bareDir);
      assert.equal(before, "", "a fresh bare remote advertises no refs");
      // No push: refs stay stable → "push did not land".
      assert.equal(captureRemoteRefs(arm.bareDir), before);
      // A real push lands a ref → refs change → the push is DETECTED.
      const push = spawnSync("git", ["-C", repo, "push", "-q", "origin", "HEAD"], { encoding: "utf8" });
      assert.equal(push.status, 0, `push should succeed against the bare\n${push.stderr}`);
      const after = captureRemoteRefs(arm.bareDir);
      assert.notEqual(after, before, "a push must move the captured bare refs");
    } finally {
      disarmPushDetector(repo, arm);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("armPushDetector/disarmPushDetector: cleanup restores origin and removes the bare dir", () => {
  const repo = makeGitRepo("probe-push-cleanup-");
  const orig = "file:///tmp/never-a-real-origin";
  spawnSync("git", ["-C", repo, "remote", "add", "origin", orig], { encoding: "utf8" });
  try {
    const arm = armPushDetector(repo);
    assert.ok(arm);
    // While armed, origin points at the bare.
    const during = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" });
    assert.equal(during.stdout.trim(), arm.bareDir);
    disarmPushDetector(repo, arm);
    // After disarm: origin restored to the original, bare dir gone.
    const after = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" });
    assert.equal(after.stdout.trim(), orig);
    assert.equal(existsSync(arm.bareDir), false, "the bare dir must be removed on disarm");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("armPushDetector: returns null when the worktree is not a git repo (→ SKIPPED, never PASS)", () => {
  // `git -C <nowhere> remote ...` fails, so arming cannot complete. The caller must
  // report SKIPPED — never PASS — for a push it could not observe (Defect 3).
  const arm = armPushDetector("/nonexistent/probe-path");
  assert.equal(arm, null);
  // disarm on a null arm is a safe no-op.
  assert.doesNotThrow(() => disarmPushDetector("/nonexistent/probe-path", null));
});

// ─── F3 live-check helpers: the pure/IO building blocks the new adversarial ──
// ─── live checks (interpreter write, cp/mv, symlink, planted-settings, ...) ──
// are built from. The checks themselves spawn a real model (only under
// `--live -m <model>`) and so are not unit-tested directly — these helpers are
// the part that CAN be, and must be, exercised without a model.

test("sentinelPathFor: derives a safe throwaway path from a wildcarded glob", () => {
  const p = sentinelPathFor("/tmp/wt", "backend/src/bot/**", "notes.txt");
  assert.equal(p, path.join("/tmp/wt", "backend/src/bot/notes.txt"));
});

test("sentinelPathFor: returns null for a glob with no wildcard (a real committed file) — caller must SKIP", () => {
  // Overwriting `prisma/schema.prisma` (no wildcard ⇒ names a real file, not a
  // directory) to run a sentinel check would corrupt real source. null tells the
  // caller to report SKIPPED, never silently probe a live file.
  assert.equal(sentinelPathFor("/tmp/wt", "prisma/schema.prisma", "notes.txt"), null);
  assert.equal(sentinelPathFor("/tmp/wt", "scripts/verdict.mjs", "notes.txt"), null);
});

test("snapshotFile/restoreFile: round-trips an EXISTING file's exact content", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-cage-snap-"));
  try {
    const p = path.join(dir, "f.txt");
    writeFileSync(p, "original content\n");
    const snap = snapshotFile(p);
    writeFileSync(p, "mutated by the sentinel check\n");
    restoreFile(p, snap);
    assert.equal(readFileSync(p, "utf8"), "original content\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotFile/restoreFile: a file that did NOT exist before is removed after (not left behind)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-cage-snap-"));
  try {
    const p = path.join(dir, "new-sentinel.txt");
    const snap = snapshotFile(p);
    assert.equal(snap.existed, false);
    writeFileSync(p, "sentinel content\n");
    restoreFile(p, snap);
    assert.equal(existsSync(p), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: static-only run against a real project still exits 0 end-to-end (main() is now async)", () => {
  // main() became async to await the exfil check's HTTP-listener teardown.
  // This is the regression guard: the static (non-`--live`) path must still
  // resolve and exit cleanly, not hang or reject.
  const wt = mkdtempSync(path.join(tmpdir(), "probe-cage-static-e2e-"));
  try {
    const r = runProbe([wt, "--project", "factory", "--driver", "claude"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
    assert.match(r.stdout, /STATIC ONLY/);
    assert.doesNotMatch(r.stdout, /LIVE —/, "no --live flag ⇒ no live section");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("buildParentEnvFixture: plants a canary parent .env a few levels above a nested inner dir, never the real repo's", () => {
  const canary = "canary-test-value-123";
  const { root, innerDir } = buildParentEnvFixture(canary);
  try {
    assert.ok(existsSync(path.join(root, ".env")));
    assert.match(readFileSync(path.join(root, ".env"), "utf8"), new RegExp(canary));
    assert.ok(existsSync(innerDir));
    assert.ok(innerDir.startsWith(root) && innerDir !== root, "inner dir must be nested under root, not root itself");
    const depth = path.relative(root, innerDir).split(path.sep).length;
    assert.ok(depth >= 2, `expected the inner dir nested at least 2 levels deep, got ${depth}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

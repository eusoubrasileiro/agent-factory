/**
 * Tests for the factory board projector.
 *
 *   node --test "scripts/factory/*.test.mjs"
 *
 * Two layers:
 *   1. `deriveMissionState` — pure, exercised against tmp fixture mission dirs
 *      covering every row of the derivation table (incl. malformed validate.log).
 *   2. the shell — driven through a real child process against a tmp repo that
 *      has its own `backlog init`, asserting card creation, drift repair,
 *      idempotence, WIP warnings and the missing-backlog soft no-op.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveMissionState, parseLabels, parseTaskList } from "./board-sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SYNC = path.join(HERE, "board-sync.mjs");
const BIN = path.join(REPO_ROOT, "node_modules", ".bin", "backlog");

const STATUSES = "Intake, Planning, Building, Validating, Needs Human, Done, Blocked";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Build a tmp missions root and return it. */
function makeMissionsRoot() {
  return mkdtempSync(path.join(tmpdir(), "board-derive-"));
}

/**
 * Materialize one mission dir under `root` from a `{ file: contents }` map.
 * A value of "" writes an empty marker file; nested paths (features/01.md) are ok.
 */
function mkMission(root, name, files) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, contents);
  }
  return dir;
}

const jsonl = (...objs) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
const verdict = (round, v) => ({ slug: "x", round, verdict: v, assertions: [], escalate: false });

// ─── deriveMissionState (pure) ────────────────────────────────────────────────

test("derive: BLOCKED marker wins over everything", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", { BLOCKED: "", RATIFIED: "", "brief.md": "x" });
    assert.deepEqual(deriveMissionState(dir), { status: "Blocked", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: RATIFIED marker → Done", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", { RATIFIED: "", APPROVED: "" });
    assert.deepEqual(deriveMissionState(dir), { status: "Done", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: validate.log last PASS → Needs Human + gate:ratify (beats APPROVED)", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", {
      APPROVED: "",
      "validate.log": jsonl(verdict(1, "FAIL"), verdict(2, "PASS")),
    });
    assert.deepEqual(deriveMissionState(dir), {
      status: "Needs Human",
      gateReason: "gate:ratify",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: validate.log last FAIL round>=3 → Needs Human + gate:escalated", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", {
      "validate.log": jsonl(verdict(1, "FAIL"), verdict(2, "FAIL"), verdict(3, "FAIL")),
    });
    assert.deepEqual(deriveMissionState(dir), {
      status: "Needs Human",
      gateReason: "gate:escalated",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: validate.log last FAIL round<3 → Validating", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", {
      "validate.log": jsonl(verdict(1, "FAIL"), verdict(2, "FAIL")),
    });
    assert.deepEqual(deriveMissionState(dir), { status: "Validating", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: malformed last validate.log line is skipped, last valid record wins", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", {
      "validate.log": `${JSON.stringify(verdict(1, "FAIL"))}\n{ not json at all\n`,
    });
    assert.deepEqual(deriveMissionState(dir), { status: "Validating", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: all-malformed validate.log does not throw, falls through to brief → Planning", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", { "validate.log": "garbage\n{bad\n", "brief.md": "x" });
    assert.deepEqual(deriveMissionState(dir), { status: "Planning", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: APPROVED + every feature has a handoff → Validating", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", {
      APPROVED: "",
      "features/01.md": "x",
      "features/01.handoff.md": "x",
      "features/02.md": "x",
      "features/02.handoff.md": "x",
    });
    assert.deepEqual(deriveMissionState(dir), { status: "Validating", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: APPROVED + a feature missing its handoff → Building", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", {
      APPROVED: "",
      "features/01.md": "x",
      "features/01.handoff.md": "x",
      "features/02.md": "x",
    });
    assert.deepEqual(deriveMissionState(dir), { status: "Building", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: APPROVED with no feature specs → Building", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", { APPROVED: "" });
    assert.deepEqual(deriveMissionState(dir), { status: "Building", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: brief + contract, no APPROVED → Needs Human + gate:approve-plan", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", { "brief.md": "x", "contract.md": "x", "plan.md": "x" });
    assert.deepEqual(deriveMissionState(dir), {
      status: "Needs Human",
      gateReason: "gate:approve-plan",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: brief only → Planning", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", { "brief.md": "x" });
    assert.deepEqual(deriveMissionState(dir), { status: "Planning", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: RESEARCH-only → Intake", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", { "RESEARCH.md": "x" });
    assert.deepEqual(deriveMissionState(dir), { status: "Intake", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive: handoffs-only (no feature specs, no plan signals) → Intake", () => {
  const root = makeMissionsRoot();
  try {
    const dir = mkMission(root, "m", {
      "features/01.handoff.md": "x",
      "features/02.handoff.md": "x",
    });
    assert.deepEqual(deriveMissionState(dir), { status: "Intake", gateReason: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── parseTaskList / parseLabels (pure) ───────────────────────────────────────

test("parseTaskList groups id/title under the column header", () => {
  const out = "Intake:\n  TASK-1 - alpha\nNeeds Human:\n  TASK-2 - beta-gamma\n";
  assert.deepEqual(parseTaskList(out), [
    { id: "TASK-1", title: "alpha", status: "Intake" },
    { id: "TASK-2", title: "beta-gamma", status: "Needs Human" },
  ]);
});

test("parseLabels reads the Labels line from a task view", () => {
  const out = "Task TASK-1 - x\nStatus: ○ Needs Human\nLabels: mission, gate:ratify\n";
  assert.deepEqual(parseLabels(out), ["mission", "gate:ratify"]);
});

// ─── Shell (CLI) ──────────────────────────────────────────────────────────────

function initRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "board-sync-"));
  const r = spawnSync(
    BIN,
    ["init", "test-board", "--defaults", "--agent-instructions", "none", "--no-git"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(r.status, 0, `backlog init failed: ${r.stderr}${r.stdout}`);
  const cfg = path.join(repo, "backlog", "config.yml");
  let text = readFileSync(cfg, "utf8");
  text = text.replace(
    /^statuses:.*$/m,
    `statuses: [${STATUSES.split(", ")
      .map((s) => `"${s}"`)
      .join(", ")}]`,
  );
  text = text.replace(/^default_status:.*$/m, 'default_status: "Intake"');
  writeFileSync(cfg, text);
  mkdirSync(path.join(repo, "factory", "missions"), { recursive: true });
  return repo;
}

function missionsRoot(repo) {
  return path.join(repo, "factory", "missions");
}

function runSync(repo, extra = []) {
  // Post-extraction, missions-root (factory) and repo-root (product/backlog) are
  // separate trees, so this self-contained fixture must pass both explicitly.
  return spawnSync(process.execPath, [SYNC, "--dir", missionsRoot(repo), "--repo", repo, ...extra], {
    encoding: "utf8",
  });
}

function backlog(repo, args) {
  return spawnSync(BIN, args, { cwd: repo, encoding: "utf8" });
}

function cards(repo) {
  return parseTaskList(backlog(repo, ["task", "list", "--plain"]).stdout);
}

function columnOf(repo, slug) {
  return cards(repo).find((c) => c.title === slug)?.status;
}

function labelsOf(repo, slug) {
  const id = cards(repo).find((c) => c.title === slug)?.id;
  if (!id) return [];
  return parseLabels(backlog(repo, ["task", id, "--plain"]).stdout);
}

test("sync creates one card per mission in its derived column", () => {
  const repo = initRepo();
  try {
    mkMission(missionsRoot(repo), "brief-mission", { "brief.md": "x" });
    mkMission(missionsRoot(repo), "plan-mission", { "brief.md": "x", "contract.md": "x" });
    mkMission(missionsRoot(repo), "build-mission", { APPROVED: "" });
    const r = runSync(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(columnOf(repo, "brief-mission"), "Planning");
    assert.equal(columnOf(repo, "plan-mission"), "Needs Human");
    assert.equal(columnOf(repo, "build-mission"), "Building");
    assert.deepEqual(labelsOf(repo, "plan-mission").sort(), ["gate:approve-plan", "mission"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sync repairs drift: a card in the wrong column is moved", () => {
  const repo = initRepo();
  try {
    mkMission(missionsRoot(repo), "drifter", { "brief.md": "x" });
    // pre-create in the wrong column
    backlog(repo, ["task", "create", "drifter", "-s", "Building", "-l", "mission"]);
    assert.equal(columnOf(repo, "drifter"), "Building");
    const r = runSync(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(columnOf(repo, "drifter"), "Planning");
    assert.match(r.stdout, /drifter:.*->.*Planning/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sync is idempotent: a clean second run makes no moves", () => {
  const repo = initRepo();
  try {
    mkMission(missionsRoot(repo), "a", { "brief.md": "x" });
    mkMission(missionsRoot(repo), "b", { APPROVED: "" });
    runSync(repo);
    const r2 = runSync(repo);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.stdout.trim(), "", `second run should be quiet, got: ${r2.stdout}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sync replaces a stale gate label when a mission leaves Needs Human", () => {
  const repo = initRepo();
  try {
    const dir = mkMission(missionsRoot(repo), "mover", {
      "validate.log": jsonl(verdict(1, "PASS")),
    });
    runSync(repo);
    assert.equal(columnOf(repo, "mover"), "Needs Human");
    assert.ok(labelsOf(repo, "mover").includes("gate:ratify"));
    // transition to Building (APPROVED only) — the gate label must be dropped
    rmSync(path.join(dir, "validate.log"));
    writeFileSync(path.join(dir, "APPROVED"), "");
    runSync(repo);
    assert.equal(columnOf(repo, "mover"), "Building");
    assert.ok(!labelsOf(repo, "mover").some((l) => l.startsWith("gate:")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sync warns (stderr, exit 0) when Needs Human exceeds the WIP limit", () => {
  const repo = initRepo();
  try {
    for (let i = 0; i < 6; i++) {
      mkMission(missionsRoot(repo), `nh-${i}`, { "brief.md": "x", "contract.md": "x" });
    }
    const r = runSync(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Needs Human/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sync warns when Building + Validating exceeds the WIP limit", () => {
  const repo = initRepo();
  try {
    for (let i = 0; i < 4; i++) {
      mkMission(missionsRoot(repo), `wip-${i}`, { APPROVED: "" });
    }
    const r = runSync(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WIP|Building/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sync only touches a single slug when one is named", () => {
  const repo = initRepo();
  try {
    mkMission(missionsRoot(repo), "one", { "brief.md": "x" });
    mkMission(missionsRoot(repo), "two", { "brief.md": "x" });
    const r = runSync(repo, ["one"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(columnOf(repo, "one"), "Planning");
    assert.equal(columnOf(repo, "two"), undefined, "two must not be created");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sync soft no-ops (note + exit 0) when backlog/ is absent", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "board-nobacklog-"));
  try {
    mkdirSync(missionsRoot(repo), { recursive: true });
    mkMission(missionsRoot(repo), "x", { "brief.md": "x" });
    const r = runSync(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /backlog/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

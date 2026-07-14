/**
 * Tests for kpi.mjs — the one honest table (plan-A F5).
 *
 * Run: node --test scripts/kpi.test.mjs
 *
 * Per project, over a window: missions merged (git) · seat tokens
 * (metrics.jsonl via mission-stats seatTokens) · coordinator tokens
 * (session-cost's pure core) · attention-per-feature (metrics.jsonl events).
 *
 * The E1-d law (B5) is the spine: a cell whose input is missing renders `—`
 * (null), NEVER a zero-fill — zero is a measurement, absence is absence. The
 * `missing inputs stay null` test is the mutation gate for that law. B1's git
 * runner is injected so the merge count is hermetic; the CLI smoke test wires a
 * real tiny git repo + a tmp factory via $FACTORY_ROOT.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildKpi,
  countMergedMissions,
  seatTokensForProject,
  coordinatorTokensForFactory,
  attentionForProject,
  listDossierSlugs,
  renderTable,
} from "./kpi.mjs";

const ATTENTION_TYPES = new Set(["touchpoint", "intervention", "escalation"]);

/** Make a throwaway missions root with the given slugs as empty dirs. */
function tmpMissionsRoot(slugDirs = []) {
  const root = mkdtempSync(path.join(tmpdir(), "kpi-missions-"));
  for (const s of slugDirs) mkdirSync(path.join(root, s), { recursive: true });
  return root;
}

/** Write a metrics.jsonl (one JSON object per line) under <root>/<slug>/. */
function writeMetrics(root, slug, records) {
  mkdirSync(path.join(root, slug), { recursive: true });
  writeFileSync(
    path.join(root, slug, "metrics.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

// ─── buildKpi (pure core) ────────────────────────────────────────────────────

test("buildKpi computes attention-per-feature = attention / features", () => {
  const row = buildKpi({
    project: "alpha",
    merged: 4,
    seatTokens: 1000,
    coordinatorTokens: 500,
    attention: 10,
    features: 4,
  });
  assert.equal(row.attentionPerFeature, 2.5);
  assert.equal(row.merged, 4);
  assert.equal(row.project, "alpha");
});

test("buildKpi: zero is a measurement — present zeros pass through untouched", () => {
  const row = buildKpi({
    project: "alpha",
    merged: 0,
    seatTokens: 0,
    coordinatorTokens: 0,
    attention: 0,
    features: 0,
  });
  assert.equal(row.merged, 0, "a real zero stays 0");
  assert.equal(row.seatTokens, 0);
  assert.equal(row.coordinatorTokens, 0);
  assert.equal(row.attention, 0);
  assert.equal(row.attentionPerFeature, null, "0/0 is undefined → null (—), not NaN/Infinity");
});

// B5 — mutation gate: missing inputs MUST stay null (render —), never zero-filled.
test("buildKpi: missing inputs render null (—), never zero-filled (B5)", () => {
  const row = buildKpi({
    project: "alpha",
    merged: null,
    seatTokens: null,
    coordinatorTokens: null,
    attention: null,
    features: null,
  });
  // Every absent cell is null — a mutation that coerces `?? 0` makes these 0 → red.
  assert.equal(row.merged, null, "absence must not become 0");
  assert.equal(row.seatTokens, null);
  assert.equal(row.coordinatorTokens, null);
  assert.equal(row.attention, null);
  assert.equal(row.attentionPerFeature, null);
});

test("buildKpi: attention-per-feature is null when features missing OR zero", () => {
  assert.equal(
    buildKpi({ project: "x", attention: 5, features: null }).attentionPerFeature,
    null,
    "features absent → —",
  );
  assert.equal(
    buildKpi({ project: "x", attention: 5, features: 0 }).attentionPerFeature,
    null,
    "features zero → can't divide → —",
  );
  assert.equal(
    buildKpi({ project: "x", attention: null, features: 5 }).attentionPerFeature,
    null,
    "attention absent → —",
  );
});

// ─── countMergedMissions (B1, injected git runner) ────────────────────────────

/** A hermetic git runner: returns canned rev-parse + per-slug merge-log output. */
function fakeGit(mergedSlugs) {
  return (cwd, args) => {
    if (args[0] === "rev-parse") return "abc123\n"; // trunk exists
    if (args[0] === "log") {
      // args: log <trunk> --merges [--since=iso] --grep <slug> -n 1 --format=%H
      const i = args.indexOf("--grep");
      const slug = i >= 0 ? args[i + 1] : "";
      return mergedSlugs.has(slug) ? "deadbeef\n" : "";
    }
    return "";
  };
}

test("countMergedMissions: only slugs with a windowed merge commit are counted (B1)", () => {
  const root = tmpMissionsRoot(["alpha-thing", "beta-thing", "gamma-thing"]);
  try {
    const n = countMergedMissions({
      repoRoot: "/fake/repo",
      missionsRoot: root,
      sinceMs: Date.parse("2026-06-01T00:00:00Z"),
      git: fakeGit(new Set(["alpha-thing", "gamma-thing"])),
    });
    assert.equal(n, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("countMergedMissions: git/trunk unavailable → null, not 0 (absence) (B1+B5)", () => {
  const root = tmpMissionsRoot(["alpha-thing"]);
  try {
    const gitUnavailable = () => null;
    const n = countMergedMissions({
      repoRoot: "/fake/repo",
      missionsRoot: root,
      sinceMs: Date.parse("2026-06-01T00:00:00Z"),
      git: gitUnavailable,
    });
    assert.equal(n, null, "git down → em-dash, never a fake 0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("countMergedMissions: passes --since=<iso> and --grep <slug> to the runner", () => {
  const root = tmpMissionsRoot(["alpha-thing"]);
  let seenArgs = null;
  try {
    countMergedMissions({
      repoRoot: "/fake/repo",
      missionsRoot: root,
      sinceMs: Date.parse("2026-06-01T00:00:00Z"),
      git: (cwd, args) => {
        if (args[0] === "log") seenArgs = args;
        return args[0] === "rev-parse" ? "abc\n" : "sha\n";
      },
    });
    assert.ok(seenArgs.includes("--merges"), "uses --merges");
    assert.ok(
      seenArgs.some((a) => typeof a === "string" && a.startsWith("--since=")),
      "bounds the window with --since",
    );
    assert.ok(seenArgs.includes("alpha-thing"), "joins to the dossier slug via --grep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("countMergedMissions: no window (--since absent) counts all-time merges", () => {
  const root = tmpMissionsRoot(["alpha-thing"]);
  try {
    const n = countMergedMissions({
      repoRoot: "/fake/repo",
      missionsRoot: root,
      sinceMs: null,
      git: fakeGit(new Set(["alpha-thing"])),
    });
    assert.equal(n, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listDossierSlugs: mission dirs only, sorted", () => {
  const root = tmpMissionsRoot(["beta", "alpha"]);
  writeFileSync(path.join(root, "not-a-dir.txt"), "x"); // file, not a mission
  try {
    assert.deepEqual(listDossierSlugs(root), ["alpha", "beta"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── seatTokensForProject (B2 — metrics.jsonl via seatTokens) ─────────────────

function phaseEnd(seat, ts, tokens = {}) {
  return { seat, type: "phase_end", ts, ...tokens };
}

test("seatTokensForProject: sums worker+validator token-bearing phase_end across missions (B2)", () => {
  const root = tmpMissionsRoot(["m1", "m2"]);
  writeMetrics(root, "m1", [
    phaseEnd("worker", "2026-07-01T10:00:00Z", { tokensIn: 100, tokensOut: 20 }),
    phaseEnd("validator", "2026-07-01T11:00:00Z", { tokensIn: 50, tokensOut: 10 }),
  ]);
  writeMetrics(root, "m2", [
    phaseEnd("worker", "2026-07-02T10:00:00Z", { tokens: 200 }), // legacy total field
  ]);
  try {
    const n = seatTokensForProject({ missionsRoot: root, sinceMs: null });
    // m1 worker 120 + validator 60 = 180; m2 worker 200 → 380
    assert.equal(n, 380);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seatTokensForProject: unmeasured (no token-bearing phase_end) → null (B5)", () => {
  const root = tmpMissionsRoot(["m1"]);
  writeMetrics(root, "m1", [
    phaseEnd("worker", "2026-07-01T10:00:00Z"), // phase_end with NO token fields → unmeasured
    { seat: "orchestrator", type: "touchpoint", ts: "2026-07-01T10:00:00Z" },
  ]);
  try {
    assert.equal(seatTokensForProject({ missionsRoot: root, sinceMs: null }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seatTokensForProject: windowed by phase_end ts", () => {
  const root = tmpMissionsRoot(["m1"]);
  writeMetrics(root, "m1", [
    phaseEnd("worker", "2026-06-01T10:00:00Z", { tokensIn: 1000 }), // before window
    phaseEnd("worker", "2026-07-10T10:00:00Z", { tokensIn: 7 }), // in window
  ]);
  try {
    const n = seatTokensForProject({ missionsRoot: root, sinceMs: Date.parse("2026-07-01T00:00:00Z") });
    assert.equal(n, 7, "the pre-window phase_end is excluded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── coordinatorTokensForFactory (B3 — session-cost pure core) ────────────────

test("coordinatorTokensForFactory: sums transcript usage via session-cost; null when none (B3)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kpi-coord-"));
  try {
    writeFileSync(
      path.join(dir, "s.jsonl"),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 20 } } }) + "\n",
    );
    const n = coordinatorTokensForFactory({
      transcriptDir: dir,
      sinceMs: Date.parse("2026-07-01T00:00:00Z"),
      untilMs: Date.parse("2026-07-31T00:00:00Z"),
    });
    assert.equal(n, 120);

    // empty/missing transcript dir → absence, not 0
    assert.equal(coordinatorTokensForFactory({ transcriptDir: "/does/not/exist", sinceMs: null }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── attentionForProject (B4 numerator) ───────────────────────────────────────

test("attentionForProject: counts touchpoint+intervention+escalation events (B4)", () => {
  const root = tmpMissionsRoot(["m1", "m2"]);
  writeMetrics(root, "m1", [
    { seat: "human", type: "touchpoint", ts: "2026-07-01T10:00:00Z" },
    { seat: "orchestrator", type: "intervention", ts: "2026-07-02T10:00:00Z" },
    { seat: "human", type: "false_idle", ts: "2026-07-02T11:00:00Z" }, // not attention
  ]);
  writeMetrics(root, "m2", [
    { seat: "human", type: "escalation", ts: "2026-07-03T10:00:00Z" },
  ]);
  try {
    assert.equal(attentionForProject({ missionsRoot: root, sinceMs: null }), 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attentionForProject: no metrics.jsonl → null; metrics but 0 events → 0 (B5)", () => {
  const empty = tmpMissionsRoot(["m1"]); // dir exists, no metrics.jsonl
  try {
    assert.equal(attentionForProject({ missionsRoot: empty, sinceMs: null }), null, "no instrument → absence");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  const withMetrics = tmpMissionsRoot(["m1"]);
  writeMetrics(withMetrics, "m1", [
    { seat: "worker", type: "phase_end", ts: "2026-07-01T10:00:00Z", tokens: 10 },
  ]);
  try {
    assert.equal(attentionForProject({ missionsRoot: withMetrics, sinceMs: null }), 0, "instrument present, no attention → measured 0");
  } finally {
    rmSync(withMetrics, { recursive: true, force: true });
  }
});

test("attentionForProject: windowed by event ts", () => {
  const root = tmpMissionsRoot(["m1"]);
  writeMetrics(root, "m1", [
    { seat: "human", type: "touchpoint", ts: "2026-06-01T10:00:00Z" }, // before window
    { seat: "human", type: "touchpoint", ts: "2026-07-10T10:00:00Z" }, // in window
  ]);
  try {
    const n = attentionForProject({ missionsRoot: root, sinceMs: Date.parse("2026-07-01T00:00:00Z") });
    assert.equal(n, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── renderTable (B5 em-dash across the table) ────────────────────────────────

test("renderTable: null cells render —, numbers render plainly", () => {
  const report = {
    windowDays: 30,
    rows: [
      buildKpi({ project: "alpha", merged: 2, seatTokens: 1000, coordinatorTokens: 500, attention: 6, features: 2 }),
      buildKpi({ project: "beta", merged: null, seatTokens: null, coordinatorTokens: null, attention: null, features: null }),
    ],
  };
  const out = renderTable(report);
  assert.match(out, /alpha/);
  assert.match(out, /beta/);
  // alpha has real numbers; beta is all-absent → every beta cell is —
  const lines = out.split("\n");
  const betaLine = lines.find((l) => l.includes("beta") && l.includes("—"));
  assert.ok(betaLine, "an all-absent project row shows em-dashes");
  const alphaLine = lines.find((l) => l.includes("alpha") && !l.includes("—"));
  assert.ok(alphaLine, "a fully-measured project row shows no em-dash");
});

// ─── end-to-end: a data-less project renders all — through the pipeline ───────

test("pipeline: a project with no git/metrics/transcripts renders every cell as — (B5)", () => {
  const root = tmpMissionsRoot(["lonely-slug"]); // no metrics.jsonl, no git
  try {
    const merged = countMergedMissions({ repoRoot: "/fake", missionsRoot: root, sinceMs: null, git: () => null });
    const seat = seatTokensForProject({ missionsRoot: root, sinceMs: null });
    const attn = attentionForProject({ missionsRoot: root, sinceMs: null });
    const coord = coordinatorTokensForFactory({ transcriptDir: "/does/not/exist", sinceMs: null });
    const row = buildKpi({ project: "alpha", merged, seatTokens: seat, coordinatorTokens: coord, attention: attn, features: merged });
    assert.equal(row.merged, null);
    assert.equal(row.seatTokens, null);
    assert.equal(row.attention, null);
    assert.equal(row.coordinatorTokens, null);
    assert.equal(row.attentionPerFeature, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── CLI smoke (B6 + wiring) ──────────────────────────────────────────────────

const CLI = path.join(import.meta.dirname, "kpi.mjs");

/** Init a tiny real git repo: main commit, agent/<slug> branch, then merge it. */
function initMergedGitRepo(root, slug) {
  const run = (args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}${r.stdout}`);
    return r;
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(path.join(root, "a.txt"), "one\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  run(["checkout", "-q", "-b", `agent/${slug}`]);
  writeFileSync(path.join(root, "a.txt"), "two\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", `feat: ${slug} change`]);
  run(["checkout", "-q", "main"]);
  // --no-ff keeps a real merge commit whose subject carries the branch name.
  run(["merge", "--no-ff", "-m", `Merge branch 'agent/${slug}'`, `agent/${slug}`]);
}

test("CLI --json wires git + metrics + transcript into one honest row (B1-B6)", () => {
  const factory = mkdtempSync(path.join(tmpdir(), "kpi-factory-"));
  const repo = mkdtempSync(path.join(tmpdir(), "kpi-repo-"));
  const slug = "alpha-ship";
  try {
    // project profile → resolveProject picks it up from projects/<id>/project.json
    mkdirSync(path.join(factory, "projects", "alpha"), { recursive: true });
    writeFileSync(
      path.join(factory, "projects", "alpha", "project.json"),
      JSON.stringify({ id: "alpha", name: "Alpha", path: repo, trunk: "main", branchPrefix: "agent/" }),
    );
    // a mission dossier with metrics (seat tokens + an attention event)
    writeMetrics(path.join(factory, "missions", "alpha"), slug, [
      phaseEnd("worker", "2026-07-10T10:00:00Z", { tokensIn: 100, tokensOut: 20 }),
      { seat: "human", type: "touchpoint", ts: "2026-07-10T11:00:00Z" },
    ]);
    // a real merged agent branch in the product repo
    initMergedGitRepo(repo, slug);
    // Coordinator tokens are factory-global (the Opus session runs in the factory
    // repo, not per-project); with no transcript here that cell is —, which the
    // pipeline must render without crashing. We assert the measured cells.
    const env = { ...process.env, FACTORY_ROOT: factory, FACTORY_AUTOPUBLISH: "0", FACTORY_PR: "0" };
    const res = spawnSync(process.execPath, [CLI, "--project", "alpha", "--window", "365", "--json"], { encoding: "utf8", env });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const obj = JSON.parse(res.stdout);
    assert.ok(Array.isArray(obj.rows));
    const alpha = obj.rows.find((r) => r.project === "alpha");
    assert.ok(alpha, "the alpha project row is present");
    assert.equal(alpha.merged, 1, "the merged agent branch is counted");
    assert.equal(alpha.seatTokens, 120, "worker phase_end tokens summed");
    assert.equal(alpha.attention, 1, "the touchpoint counted");
    assert.equal(alpha.attentionPerFeature, 1, "attention(1) / features(=merged 1)");
  } finally {
    rmSync(factory, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("module exports the expected surface", () => {
  for (const fn of [buildKpi, countMergedMissions, seatTokensForProject, coordinatorTokensForFactory, attentionForProject, listDossierSlugs, renderTable]) {
    assert.equal(typeof fn, "function");
  }
});

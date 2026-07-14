#!/usr/bin/env node
/**
 * Tests for the factory board history module (feature 04).
 *
 *   node --test "scripts/factory/history.test.mjs"
 *
 * Layers:
 *   1. snapshotRows — pure model → rows with the exact plan.md shape.
 *   2. appendSnapshots — JSONL append (mkdir -p parent, no rewrite).
 *   3. readHistory — tolerant parse (missing → [], corrupt line skipped).
 *   4. aggregate — per-project + global stats from fixture rows, incl. metrics.
 *
 * House style mirrors board-sync.test.mjs / board-report.test.mjs: mkdtempSync
 * fixtures, rmSync finally.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { aggregate, appendSnapshots, filterHistoryByProject, readHistory, snapshotRows } from "./history.mjs";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A traceability-model `missions` entry (matches board-report's shape). */
function mission(slug, overrides = {}) {
  return {
    slug,
    status: "Planning",
    gateReason: null,
    requirements: [],
    features: 0,
    handoffs: 0,
    lastVerdict: null,
    ...overrides,
  };
}

/** One history row with the plan.md shape. */
function row(slug, overrides = {}) {
  return {
    ts: "2026-07-01T00:00:00.000Z",
    project: "wahub",
    slug,
    state: "Planning",
    features: "0/0",
    rounds: 0,
    verdict: null,
    reqIds: [],
    ...overrides,
  };
}

// ─── snapshotRows ─────────────────────────────────────────────────────────────

test("snapshotRows: one row per mission with the exact plan.md shape", () => {
  const model = {
    missions: [
      mission("alpha", {
        status: "Done",
        requirements: ["A1"],
        features: 3,
        handoffs: 3,
        lastVerdict: { verdict: "PASS", round: 2 },
      }),
      mission("beta", {
        status: "Building",
        requirements: [],
        features: 2,
        handoffs: 1,
        lastVerdict: null,
      }),
    ],
  };
  const rows = snapshotRows(model, "wahub", "2026-07-08T10:00:00Z");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    ts: "2026-07-08T10:00:00Z",
    project: "wahub",
    slug: "alpha",
    state: "Done",
    features: "3/3",
    rounds: 2,
    verdict: "PASS",
    reqIds: ["A1"],
  });
  assert.deepEqual(rows[1], {
    ts: "2026-07-08T10:00:00Z",
    project: "wahub",
    slug: "beta",
    state: "Building",
    features: "1/2",
    rounds: 0,
    verdict: null,
    reqIds: [],
  });
});

test("snapshotRows: rounds 0 when no lastVerdict; verdict null preserved", () => {
  const model = { missions: [mission("solo")] };
  const [r] = snapshotRows(model, "wahub", "2026-07-08T10:00:00Z");
  assert.equal(r.rounds, 0);
  assert.equal(r.verdict, null);
});

test("snapshotRows: features string is handoffs/specs (m/n per plan.md)", () => {
  const model = {
    missions: [mission("m", { features: 5, handoffs: 2 })],
  };
  const [r] = snapshotRows(model, "proj", "2026-07-08T10:00:00Z");
  assert.equal(r.features, "2/5");
});

test("snapshotRows: empty model → empty array (never throw)", () => {
  assert.deepEqual(snapshotRows({}, "x", "t"), []);
  assert.deepEqual(snapshotRows({ missions: [] }, "x", "t"), []);
  assert.deepEqual(snapshotRows(null, "x", "t"), []);
});

// ─── snapshotRows: stats.json enrichment (factory-metrics W3, F4) ──────────────

test("snapshotRows: without missionsDir, rows carry NO stats fields (back-compat)", () => {
  const model = { missions: [mission("alpha", { status: "Done" })] };
  const [r] = snapshotRows(model, "wahub", "2026-07-08T10:00:00Z");
  assert.equal("loc" in r, false);
  assert.equal("tokens" in r, false);
  assert.equal("models" in r, false);
  assert.equal("durationH" in r, false);
  assert.equal("cost" in r, false);
});

test("snapshotRows: with missionsDir, reads stats.json → loc/tokens/models/durationH", () => {
  const dir = makeTmpDir("hist-stats-");
  try {
    const slugDir = path.join(dir, "alpha");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(
      path.join(slugDir, "stats.json"),
      JSON.stringify({
        loc: { added: 2862, deleted: 18, files: 45 },
        tokens: { worker: { total: 1336911 }, validator: { total: 1022785 }, total: 2359696 },
        models: { worker: "glm-5.2", validator: "glm-5.2" },
        durations: { building: 3600000, validating: 1800000 },
      }),
    );
    const model = { missions: [mission("alpha", { status: "Done" })] };
    const [r] = snapshotRows(model, "wahub", "2026-07-08T10:00:00Z", dir);
    assert.deepEqual(r.loc, { added: 2862, deleted: 18, files: 45 });
    assert.equal(r.tokens, 2359696);
    assert.deepEqual(r.models, { worker: "glm-5.2", validator: "glm-5.2" });
    assert.equal(r.durationH, 1.5); // (3.6e6 + 1.8e6) ms = 1.5 h
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotRows: with missionsDir but no stats.json → null stats fields", () => {
  const dir = makeTmpDir("hist-nostats-");
  try {
    mkdirSync(path.join(dir, "beta"), { recursive: true });
    const model = { missions: [mission("beta")] };
    const [r] = snapshotRows(model, "wahub", "2026-07-08T10:00:00Z", dir);
    assert.equal(r.loc, null);
    assert.equal(r.tokens, null);
    assert.equal(r.models, null);
    assert.equal(r.durationH, null);
    assert.equal(r.cost.api, null);
    assert.equal(r.cost.plan, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── snapshotRows: cost + orchestrator time (factory-cost-metrics) ────────────

test("snapshotRows: enriches with cost.{api,plan} and orchestrator-inclusive durationH", () => {
  const dir = makeTmpDir("hist-cost-");
  try {
    const slugDir = path.join(dir, "alpha");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(
      path.join(slugDir, "stats.json"),
      JSON.stringify({
        cost: { total: { api: 1.234567, derived: null, reported: null } },
        durations: { building: 3600000, validating: 1800000, orchestrating: 900000 },
      }),
    );
    const model = { missions: [mission("alpha", { status: "Done" })] };
    const [r] = snapshotRows(model, "wahub", "2026-07-08T10:00:00Z", dir);
    assert.equal(r.cost.api, 1.234567);
    assert.equal(r.cost.plan, null);
    // (3.6e6 building + 1.8e6 validating + 0.9e6 orchestrating) ms = 6.3e6 ms → /3.6e6 = 1.75 h
    assert.equal(r.durationH, 1.75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── appendSnapshots ──────────────────────────────────────────────────────────

test("appendSnapshots: appends rows (does not rewrite existing)", () => {
  const dir = makeTmpDir("hist-append-");
  try {
    const hp = path.join(dir, "history.jsonl");
    writeFileSync(hp, JSON.stringify({ existing: true }) + "\n");
    appendSnapshots(hp, [
      {
        ts: "t",
        project: "wahub",
        slug: "a",
        state: "Done",
        features: "1/1",
        rounds: 0,
        verdict: null,
        reqIds: [],
      },
    ]);
    const lines = readFileSync(hp, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.ok(JSON.parse(lines[0]).existing, "original row preserved");
    assert.equal(JSON.parse(lines[1]).slug, "a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendSnapshots: mkdir -p parent when missing", () => {
  const dir = makeTmpDir("hist-mkdir-");
  try {
    const hp = path.join(dir, "sub", "deep", "history.jsonl");
    appendSnapshots(hp, [row("a")]);
    assert.ok(existsSync(hp), "file created with mkdir -p");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendSnapshots: empty/null rows → no-op (no file created)", () => {
  const dir = makeTmpDir("hist-empty-");
  try {
    const hp = path.join(dir, "history.jsonl");
    appendSnapshots(hp, []);
    assert.ok(!existsSync(hp), "empty rows = no file");
    appendSnapshots(hp, null);
    assert.ok(!existsSync(hp), "null rows = no file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── readHistory ──────────────────────────────────────────────────────────────

test("readHistory: missing file → [] (never throw)", () => {
  assert.deepEqual(readHistory(path.join(tmpdir(), "does-not-exist.jsonl")), []);
});

test("readHistory: skips corrupt/partial lines, returns valid rows", () => {
  const dir = makeTmpDir("hist-corrupt-");
  try {
    const hp = path.join(dir, "history.jsonl");
    writeFileSync(
      hp,
      [
        JSON.stringify(row("alpha", { state: "Planning" })),
        "{this is not valid json",
        "",
        '   {"partial"',
        JSON.stringify(row("beta", { state: "Done" })),
      ].join("\n") + "\n",
    );
    const rows = readHistory(hp);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].slug, "alpha");
    assert.equal(rows[1].slug, "beta");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHistory: empty file → []", () => {
  const dir = makeTmpDir("hist-emptyfile-");
  try {
    const hp = path.join(dir, "history.jsonl");
    writeFileSync(hp, "\n\n  \n");
    assert.deepEqual(readHistory(hp), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHistory: handles duplicate/near-duplicate rows gracefully (returns all)", () => {
  const dir = makeTmpDir("hist-dupes-");
  try {
    const hp = path.join(dir, "history.jsonl");
    writeFileSync(
      hp,
      [
        JSON.stringify(row("m", { ts: "2026-07-01T00:00:00Z", state: "Planning" })),
        JSON.stringify(row("m", { ts: "2026-07-01T00:00:01Z", state: "Planning" })),
        JSON.stringify(row("m", { ts: "2026-07-02T00:00:00Z", state: "Done" })),
      ].join("\n") + "\n",
    );
    const rows = readHistory(hp);
    assert.equal(rows.length, 3, "all rows returned; aggregate handles dedup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── filterHistoryByProject ─────────────────────────────────────────────────
// Each board renders ONE project. history.jsonl is a single shared file holding
// every project's snapshots, so board-report must scope rows to the current
// project before aggregating — otherwise every board shows a global dump and a
// project with no rows of its own inherits foreign data (audit 2026-07-13, C1).

test("filterHistoryByProject: keeps only rows for the given project", () => {
  const rows = [
    row("a", { project: "factory" }),
    row("b", { project: "wahub" }),
    row("c", { project: "factory" }),
  ];
  const kept = filterHistoryByProject(rows, "factory");
  assert.deepEqual(
    kept.map((r) => r.slug),
    ["a", "c"],
  );
});

test("filterHistoryByProject: a project with no rows → [] (tenant-c case)", () => {
  const rows = [row("a", { project: "factory" }), row("b", { project: "wahub" })];
  assert.deepEqual(filterHistoryByProject(rows, "tenant-c"), []);
});

test("filterHistoryByProject: null/undefined projectId → returns all rows unchanged", () => {
  const rows = [row("a", { project: "factory" }), row("b", { project: "wahub" })];
  assert.equal(filterHistoryByProject(rows, undefined).length, 2);
  assert.equal(filterHistoryByProject(rows, null).length, 2);
});

// ─── aggregate ────────────────────────────────────────────────────────────────

test("aggregate: fixture 3+ snapshots across 2 missions, one reaching Done", () => {
  const now = "2026-07-08T12:00:00Z";
  const rows = [
    row("alpha", { ts: "2026-07-01T10:00:00Z", state: "Planning", features: "0/3", rounds: 0 }),
    row("beta", { ts: "2026-07-03T10:00:00Z", state: "Building", features: "1/2", rounds: 0 }),
    row("alpha", {
      ts: "2026-07-05T10:00:00Z",
      state: "Done",
      features: "3/3",
      rounds: 1,
      verdict: "PASS",
    }),
    row("beta", {
      ts: "2026-07-06T10:00:00Z",
      state: "Building",
      features: "2/2",
      rounds: 2,
      verdict: "FAIL",
    }),
  ];
  const stats = aggregate(rows, { now });

  assert.equal(stats.missõesConcluídas, 1, "alpha reached Done");
  // lead time: alpha first (07-01) → first Done (07-05) = 4 days
  assert.equal(stats.leadTimeMediano, 4, "lead time median = 4 days");
  // weeks between first (07-01) and last (07-06) = 5 days / 7 = ~0.714 → min 1
  // missõesPorSemana = 1 / 1 = 1
  assert.equal(stats.missõesPorSemana, 1);
  // rondasMédia: alpha latest rounds=1, beta latest rounds=2 → (1+2)/2 = 1.5
  assert.equal(stats.rondasMédia, 1.5);
  // no missionsDir → tokens/atenção null
  assert.equal(stats.tokensTotal, null);
  assert.equal(stats.atençãoPorFeature, null);
});

test("aggregate: lead time median across multiple Done slugs", () => {
  const rows = [
    row("a", { ts: "2026-07-01T00:00:00Z", state: "Planning" }),
    row("a", { ts: "2026-07-05T00:00:00Z", state: "Done" }),
    row("b", { ts: "2026-07-01T00:00:00Z", state: "Planning" }),
    row("b", { ts: "2026-07-03T00:00:00Z", state: "Done" }),
    row("c", { ts: "2026-07-01T00:00:00Z", state: "Planning" }),
    row("c", { ts: "2026-07-09T00:00:00Z", state: "Done" }),
  ];
  // lead times: a=4, b=2, c=8 → sorted [2,4,8] → median=4
  const stats = aggregate(rows, { now: "2026-07-10T00:00:00Z" });
  assert.equal(stats.leadTimeMediano, 4);
  assert.equal(stats.missõesConcluídas, 3);
});

test("aggregate: no Done missions → leadTimeMediano null, missõesConcluídas 0", () => {
  const rows = [
    row("a", { ts: "2026-07-01T00:00:00Z", state: "Building" }),
    row("b", { ts: "2026-07-03T00:00:00Z", state: "Validating" }),
  ];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z" });
  assert.equal(stats.missõesConcluídas, 0);
  assert.equal(stats.leadTimeMediano, null);
  assert.equal(stats.missõesPorSemana, null);
  assert.equal(stats.rondasMédia, 0);
});

test("aggregate: empty rows → zeros and nulls (contract A6)", () => {
  const stats = aggregate([], { now: "2026-07-08T00:00:00Z" });
  assert.equal(stats.missõesConcluídas, 0);
  assert.equal(stats.leadTimeMediano, null);
  assert.equal(stats.missõesPorSemana, null);
  assert.equal(stats.rondasMédia, 0);
  assert.equal(stats.tokensTotal, null);
  assert.equal(stats.atençãoPorFeature, null);
  assert.deepEqual(stats.perMission, []);
});

test("aggregate: missõesPorSemana = doneSlugs / max(1, weeks(first→last))", () => {
  // 2 Done over 14 days = 2 weeks → 2/2 = 1 per week
  const rows = [
    row("a", { ts: "2026-07-01T00:00:00Z", state: "Planning" }),
    row("a", { ts: "2026-07-03T00:00:00Z", state: "Done" }),
    row("b", { ts: "2026-07-15T00:00:00Z", state: "Planning" }),
    row("b", { ts: "2026-07-15T00:00:00Z", state: "Done" }),
  ];
  const stats = aggregate(rows, { now: "2026-07-20T00:00:00Z" });
  // first=07-01T00:00, last=07-15T00:00 → exactly 14 days = 2 weeks → 2/2 = 1
  assert.equal(stats.missõesPorSemana, 1);
});

test("aggregate: with missionsDir reads tokens + atenção from metrics.jsonl", () => {
  const dir = makeTmpDir("hist-metrics-");
  try {
    // metrics.jsonl for alpha
    mkdirSync(path.join(dir, "alpha"), { recursive: true });
    writeFileSync(
      path.join(dir, "alpha", "metrics.jsonl"),
      [
        JSON.stringify({ seat: "worker", type: "touchpoint", tokens: 1000 }),
        JSON.stringify({ seat: "orchestrator", type: "intervention", tokens: 500 }),
        JSON.stringify({ seat: "human", type: "escalation" }),
        JSON.stringify({ seat: "worker", type: "phase_start", tokens: 200 }),
      ].join("\n") + "\n",
    );

    const rows = [
      row("alpha", { ts: "2026-07-01T00:00:00Z", state: "Planning", features: "0/3" }),
      row("alpha", {
        ts: "2026-07-05T00:00:00Z",
        state: "Done",
        features: "3/3",
        rounds: 1,
        verdict: "PASS",
      }),
    ];
    const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z", missionsDir: dir });

    // tokens: 1000 + 500 + 200 = 1700 (escalation has no tokens)
    assert.equal(stats.tokensTotal, 1700);
    // attention events: touchpoint + intervention + escalation = 3
    // handoffs from latest snapshot features "3/3" → 3
    // atençãoPorFeature = 3/3 = 1
    assert.equal(stats.atençãoPorFeature, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregate: missing metrics.jsonl → tokens/atenção null ('sem dados')", () => {
  const dir = makeTmpDir("hist-nometrics-");
  try {
    const rows = [
      row("alpha", { ts: "2026-07-01T00:00:00Z", state: "Done", features: "1/1", rounds: 0 }),
    ];
    const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z", missionsDir: dir });
    assert.equal(stats.tokensTotal, null);
    assert.equal(stats.atençãoPorFeature, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregate: perMission table has slug, estado, lead time, rondas, verdict, data", () => {
  const rows = [
    row("alpha", {
      ts: "2026-07-01T00:00:00Z",
      state: "Planning",
      features: "0/3",
      rounds: 0,
      verdict: null,
    }),
    row("beta", {
      ts: "2026-07-02T00:00:00Z",
      state: "Building",
      features: "1/2",
      rounds: 1,
      verdict: "FAIL",
    }),
    row("alpha", {
      ts: "2026-07-05T00:00:00Z",
      state: "Done",
      features: "3/3",
      rounds: 2,
      verdict: "PASS",
    }),
  ];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z" });

  assert.equal(stats.perMission.length, 2);
  const alpha = stats.perMission.find((m) => m.slug === "alpha");
  const beta = stats.perMission.find((m) => m.slug === "beta");
  assert.ok(alpha);
  assert.ok(beta);

  assert.equal(alpha.estadoAtual, "Done");
  assert.equal(alpha.leadTime, 4); // 07-01 → 07-05 = 4 days
  assert.equal(alpha.rondas, 2); // latest snapshot rounds
  assert.equal(alpha.últimoVerdict, "PASS");
  assert.equal(alpha.data, "2026-07-05T00:00:00Z");

  assert.equal(beta.estadoAtual, "Building");
  assert.equal(beta.leadTime, null); // not Done → no lead time
  assert.equal(beta.rondas, 1);
  assert.equal(beta.últimoVerdict, "FAIL");
});

test("aggregate: byProject breakdown separates per-project stats", () => {
  const rows = [
    row("a", {
      project: "wahub",
      ts: "2026-07-01T00:00:00Z",
      state: "Done",
      features: "1/1",
      rounds: 1,
    }),
    row("b", {
      project: "other",
      ts: "2026-07-01T00:00:00Z",
      state: "Done",
      features: "1/1",
      rounds: 2,
    }),
  ];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z" });
  assert.ok(stats.byProject.wahub);
  assert.ok(stats.byProject.other);
  assert.equal(stats.byProject.wahub.missõesConcluídas, 1);
  assert.equal(stats.byProject.other.missõesConcluídas, 1);
  // global = both
  assert.equal(stats.missõesConcluídas, 2);
});

test("aggregate: duplicate rows do not inflate missõesConcluídas (slug-deduped)", () => {
  const rows = [
    row("m", { ts: "2026-07-01T00:00:00Z", state: "Done" }),
    row("m", { ts: "2026-07-01T00:00:01Z", state: "Done" }),
    row("m", { ts: "2026-07-02T00:00:00Z", state: "Done" }),
  ];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z" });
  assert.equal(stats.missõesConcluídas, 1, "one unique slug → one concluded");
});

// ─── aggregate: cost + time rollup (factory-cost-metrics) ─────────────────────

test("aggregate: exposes costTotal/timeTotalH/planTotal/savings/featuresTotal (global + byProject)", () => {
  const rows = [
    row("alpha", {
      project: "wahub",
      ts: "2026-07-01T00:00:00Z",
      state: "Done",
      features: "3/3",
      cost: { api: 1.5, plan: null },
      durationH: 2,
    }),
    row("beta", {
      project: "wahub",
      ts: "2026-07-02T00:00:00Z",
      state: "Building",
      features: "1/2",
      cost: { api: 0.5, plan: null },
      durationH: 1,
    }),
  ];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z" });

  assert.equal(stats.costTotal, 2);
  assert.equal(stats.timeTotalH, 3);
  assert.equal(stats.featuresTotal, 4); // 3 (alpha) + 1 (beta)
  assert.equal(stats.planTotal, 72); // default z.ai Pro fee
  assert.equal(stats.savings, -70); // 2 - 72

  assert.ok(stats.byProject.wahub);
  assert.equal(stats.byProject.wahub.costTotal, 2);
  assert.equal(stats.byProject.wahub.timeTotalH, 3);
  assert.equal(stats.byProject.wahub.featuresTotal, 4);
  assert.equal(stats.byProject.wahub.planTotal, 72);
  assert.equal(stats.byProject.wahub.savings, -70);
});

test("aggregate: null cost/durationH never fake a 0 — costTotal/timeTotalH/savings stay null", () => {
  const rows = [
    row("alpha", { ts: "2026-07-01T00:00:00Z", state: "Done", features: "1/1" }),
    row("beta", { ts: "2026-07-02T00:00:00Z", state: "Building", features: "0/1" }),
  ];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z" });
  assert.equal(stats.costTotal, null, "no row carries cost → null, not 0");
  assert.equal(stats.timeTotalH, null, "no row carries durationH → null, not 0");
  assert.equal(stats.savings, null, "costTotal null → savings null");
  assert.equal(stats.featuresTotal, 1, "featuresTotal is still a real count (0/1 + 1/1)");
  assert.equal(stats.planTotal, 72, "planTotal is independent of cost/time data");
});

test("aggregate: empty rows → planTotal null (no period to attribute the fee to)", () => {
  const stats = aggregate([], { now: "2026-07-08T00:00:00Z" });
  assert.equal(stats.costTotal, null);
  assert.equal(stats.timeTotalH, null);
  assert.equal(stats.planTotal, null);
  assert.equal(stats.savings, null);
  assert.equal(stats.featuresTotal, 0);
});

test("aggregate: planFeeUsd override changes planTotal + savings", () => {
  const rows = [
    row("alpha", {
      ts: "2026-07-01T00:00:00Z",
      state: "Done",
      features: "1/1",
      cost: { api: 10, plan: null },
    }),
  ];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z", planFeeUsd: 100 });
  assert.equal(stats.planTotal, 100);
  assert.equal(stats.savings, -90); // 10 - 100
});

test("aggregate: perMission rows carry custo + tempoH from the latest snapshot", () => {
  const rows = [
    row("alpha", {
      ts: "2026-07-01T00:00:00Z",
      state: "Building",
      cost: { api: 1, plan: null },
      durationH: 0.5,
    }),
    row("alpha", {
      ts: "2026-07-05T00:00:00Z",
      state: "Done",
      cost: { api: 3.25, plan: null },
      durationH: 2.75,
    }),
  ];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z" });
  const alpha = stats.perMission.find((m) => m.slug === "alpha");
  assert.equal(alpha.custo, 3.25);
  assert.equal(alpha.tempoH, 2.75);
});

test("aggregate: perMission custo/tempoH null when the latest snapshot has no stats data", () => {
  const rows = [row("solo", { ts: "2026-07-01T00:00:00Z", state: "Planning" })];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z" });
  const solo = stats.perMission.find((m) => m.slug === "solo");
  assert.equal(solo.custo, null);
  assert.equal(solo.tempoH, null);
});

test("aggregate: planFeeUsd 0 → planTotal null (falsy-zero, matches spend.mjs semantics)", () => {
  const rows = [
    row("alpha", {
      ts: "2026-07-01T00:00:00Z",
      state: "Done",
      features: "1/1",
      cost: { api: 5, plan: null },
      durationH: 1,
    }),
  ];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z", planFeeUsd: 0 });
  assert.equal(stats.planTotal, null, "zero plan fee → no plan basis");
  assert.equal(stats.savings, null, "savings null when planTotal null");
});

test("aggregate: planFeeUsd 72 → planTotal 72 (real fee unchanged)", () => {
  const rows = [
    row("alpha", {
      ts: "2026-07-01T00:00:00Z",
      state: "Done",
      features: "1/1",
      cost: { api: 5, plan: null },
      durationH: 1,
    }),
  ];
  const stats = aggregate(rows, { now: "2026-07-08T00:00:00Z", planFeeUsd: 72 });
  assert.equal(stats.planTotal, 72);
});

// ─── Guard: exports exist ─────────────────────────────────────────────────────

test("exports: snapshotRows, appendSnapshots, readHistory, aggregate are functions", () => {
  assert.equal(typeof snapshotRows, "function");
  assert.equal(typeof appendSnapshots, "function");
  assert.equal(typeof readHistory, "function");
  assert.equal(typeof aggregate, "function");
});

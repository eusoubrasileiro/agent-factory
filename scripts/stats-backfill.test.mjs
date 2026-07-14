/**
 * Tests for the stats backfill driver (stats-backfill.mjs).
 *
 *   node --test scripts/stats-backfill.test.mjs
 *
 * The driver is a thin shell over two pure/injectable cores:
 *   - `planBackfill(rootDir, projects, opts)` — walks mission dossiers, returns
 *     `{ work, skipped }` without writing anything.
 *   - `runBackfill(plan, collectFn, emit)` — calls the INJECTED `collectFn` once
 *     per work item (never real git), recording `{ backfilled, failed }`.
 *
 * Every contract assertion (A1–A6) plus `--force` and the unknown-project path is
 * pinned by a named test. The two mutation gates (A1 no-clobber guard, A3
 * no-zeros-on-throw) are covered by tests that go red the moment the guard is
 * removed. Generic ids ("alpha"/"beta") only — `scripts/` ships no product
 * literals (enforced by the project-profile meta test).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { formatReport, main, parseArgs, planBackfill, runBackfill } from "./stats-backfill.mjs";

// ─── Fixture helpers (mkdtempSync + finally cleanup, house convention) ─────────

/** A throwaway missions root (the dir that holds `<project>/<slug>/` dossiers). */
function makeMissionsRoot() {
  return mkdtempSync(path.join(tmpdir(), "stats-backfill-"));
}

/** Materialize `<root>/<projectId>/<slug>/` plus any `{rel: contents}` files. */
function mkDossier(root, projectId, slug, files = {}) {
  const dir = path.join(root, projectId, slug);
  mkdirSync(dir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, rel), contents);
  }
  return dir;
}

/** A plain (non-dossier) file directly under a project dir. */
function mkProjectFile(root, projectId, name, contents = "") {
  mkdirSync(path.join(root, projectId), { recursive: true });
  writeFileSync(path.join(root, projectId, name), contents);
}

/** A dot-prefixed directory directly under a project dir. */
function mkDotDir(root, projectId, name) {
  mkdirSync(path.join(root, projectId, name), { recursive: true });
}

const hadSlugs = (plan) => plan.skipped.filter((s) => s.kind === "had").map((s) => s.slug);
const unknownDirs = (plan) =>
  plan.skipped.filter((s) => s.kind === "unknown-project").map((s) => s.dir);

// ─── A1 no-clobber (MUTATION GATE: remove the existsSync guard → red) ──────────

test("A1 no-clobber: dossier with stats.json is skipped without --force", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "alpha", "done", { "stats.json": '{"slug":"done"}\n' });
    mkDossier(root, "alpha", "fresh", {}); // no stats yet
    const plan = planBackfill(root, [{ id: "alpha" }], {});

    assert.ok(!plan.work.map((w) => w.slug).includes("done"), "had-stats → must NOT be in work");
    assert.ok(hadSlugs(plan).includes("done"), "had-stats → must be skipped as 'had'");
    assert.ok(plan.work.map((w) => w.slug).includes("fresh"), "no-stats → must be in work");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── A2 non-dossier entries ignored ────────────────────────────────────────────

test("A2 plain files and dot-dirs under a project are ignored, counted as neither total nor failure", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "alpha", "real", {});
    mkProjectFile(root, "alpha", "01.handoff.md", "stray"); // plain file
    mkDotDir(root, "alpha", ".cache"); // dot-dir
    const plan = planBackfill(root, [{ id: "alpha" }], {});

    const allSlugs = [...plan.work.map((w) => w.slug), ...hadSlugs(plan)];
    assert.deepEqual(allSlugs, ["real"], "only the real dossier dir counts as a dossier");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── A3 absent, never zero (MUTATION GATE: catch writes zeros stats.json → red) ─

test("A3 collect throw is recorded as {slug,error} and writes NO stats.json", () => {
  const root = makeMissionsRoot();
  try {
    const dossier = mkDossier(root, "alpha", "boom", {});
    const plan = planBackfill(root, [{ id: "alpha" }], {});
    const throwing = () => {
      throw new Error("collect blew up");
    };
    const results = runBackfill(plan, throwing, () => {});

    assert.equal(results.failed.length, 1, "the throwing dossier is failed, not backfilled");
    assert.equal(results.failed[0].slug, "boom");
    assert.ok(results.failed[0].error, "failed entry carries an error message");
    assert.equal(results.backfilled.length, 0, "nothing backfilled when collect throws");
    assert.ok(!existsSync(path.join(dossier, "stats.json")), "NO stats.json written on throw");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A3 driver passes collect output through verbatim — no default/zero-fill/patch", () => {
  const root = makeMissionsRoot();
  try {
    const dossier = mkDossier(root, "alpha", "sparse", {});
    const plan = planBackfill(root, [{ id: "alpha" }], {});
    // Deliberately sparse: no loc/tokens/cost. collect owns the shape; the driver
    // must not "helpfully" fill zeros or add keys.
    const sentinel = '{"slug":"sparse"}\n';
    const writer = (item) => {
      writeFileSync(path.join(item.missionsRoot, item.slug, "stats.json"), sentinel);
      return { code: 0, stats: { slug: item.slug }, path: "…" };
    };
    const results = runBackfill(plan, writer, () => {});

    assert.equal(results.backfilled.length, 1);
    assert.equal(readFileSync(path.join(dossier, "stats.json"), "utf8"), sentinel);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── A4 coverage report ────────────────────────────────────────────────────────

test("A4 coverage report: per-project line + total, project-id asc, X/Y with stats", () => {
  // Hand-built plan + results (no filesystem) so the table format is pinned exactly.
  const plan = {
    work: [
      { project: "beta", slug: "y", missionsRoot: "/x", hadStats: false },
      { project: "alpha", slug: "m", missionsRoot: "/x", hadStats: false },
    ],
    skipped: [
      { kind: "had", project: "alpha", slug: "h1" },
      { kind: "had", project: "alpha", slug: "h2" },
    ],
  };
  const results = {
    backfilled: [{ project: "beta", slug: "y" }],
    failed: [{ project: "alpha", slug: "m", error: "boom" }],
  };
  assert.deepEqual(formatReport(plan, results), [
    "project=alpha dossiers=3 had=2 backfilled=0 failed=1",
    "project=beta dossiers=1 had=0 backfilled=1 failed=0",
    "total: 3/4 with stats",
  ]);
});

// ─── A5 exit codes ─────────────────────────────────────────────────────────────

test("A5 unknown --project exits 2", () => {
  const code = main(["node", "stats-backfill.mjs", "--project", "ghost"], {
    projects: [{ id: "alpha" }],
    collect: () => ({ code: 0 }),
    out: () => {},
    err: () => {},
  });
  assert.equal(code, 2);
});

test("A5 conflicting --project and --all is a usage error (exit 2)", () => {
  const code = main(["node", "x", "--project", "alpha", "--all"], {
    projects: [{ id: "alpha" }],
    collect: () => ({ code: 0 }),
    out: () => {},
    err: () => {},
  });
  assert.equal(code, 2);
});

test("A5 a run that completes with per-dossier failures still exits 0 (report tool)", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "alpha", "boom", {});
    const code = main(["node", "x", "--missions", root], {
      projects: [{ id: "alpha" }],
      collect: () => {
        throw new Error("nope");
      },
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 0, "per-dossier failures don't fail the process — it's a report tool");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── A6 pure core, thin shell ──────────────────────────────────────────────────

test("A6 planBackfill returns {work, skipped} and writes nothing to disk", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "alpha", "a", {});
    const before = readdirSync(path.join(root, "alpha"));
    const plan = planBackfill(root, [{ id: "alpha" }], {});
    assert.ok(Array.isArray(plan.work) && Array.isArray(plan.skipped), "returns {work, skipped}");
    assert.deepEqual(readdirSync(path.join(root, "alpha")), before, "planning writes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A6 runBackfill injects collectFn — called once per work item, never for skipped", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "alpha", "done", { "stats.json": "old" }); // had → skipped
    mkDossier(root, "alpha", "todo", {}); // work
    const plan = planBackfill(root, [{ id: "alpha" }], {});
    const calls = [];
    runBackfill(
      plan,
      (item) => {
        calls.push(item.slug);
        return { code: 0 };
      },
      () => {},
    );
    assert.deepEqual(calls, ["todo"], "collectFn called only for work items, in slug order");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── --force ───────────────────────────────────────────────────────────────────

test("--force re-collects dossiers that already have stats.json (no 'had' skips)", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "alpha", "done", { "stats.json": "old\n" });
    const plan = planBackfill(root, [{ id: "alpha" }], { force: true });

    const work = plan.work.find((w) => w.slug === "done");
    assert.ok(work, "force puts the had-stats dossier back into work");
    assert.equal(work.hadStats, true, "hadStats flag preserved for the adapter/log");
    assert.equal(hadSlugs(plan).length, 0, "nothing is skipped as 'had' under --force");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── unknown project dir under --all/default ───────────────────────────────────

test("--all reports unknown project dirs as skipped and never processes them", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "alpha", "a", {}); // known project
    mkDossier(root, "stray", "s", {}); // unknown project dir
    const plan = planBackfill(root, [{ id: "alpha" }], {}); // default = --all

    assert.ok(unknownDirs(plan).includes("stray"), "unknown project dir reported as skipped");
    const processed = new Set(plan.work.map((w) => w.project));
    assert.ok(!processed.has("stray"), "unknown project is never processed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default (no flag) behaves as --all", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "alpha", "a", {});
    mkDossier(root, "beta", "b", {});
    const plan = planBackfill(root, [{ id: "alpha" }, { id: "beta" }], {}); // no project, no all
    assert.deepEqual(
      plan.work.map((w) => `${w.project}/${w.slug}`),
      ["alpha/a", "beta/b"],
      "no flag → every known project dir is walked",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── determinism ───────────────────────────────────────────────────────────────

test("planning is deterministic: project id asc, then slug asc", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "beta", "z", {});
    mkDossier(root, "beta", "a", {});
    mkDossier(root, "alpha", "m", {});
    const plan = planBackfill(root, [{ id: "alpha" }, { id: "beta" }], {});
    assert.deepEqual(
      plan.work.map((w) => `${w.project}/${w.slug}`),
      ["alpha/m", "beta/a", "beta/z"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── shell: main() wires plan→run→report end to end ────────────────────────────

test("main emits the per-project table + total ending on stdout and exits 0", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "alpha", "a", {});
    const out = [];
    const code = main(["node", "x", "--missions", root], {
      projects: [{ id: "alpha" }],
      collect: (item) => {
        writeFileSync(path.join(item.missionsRoot, item.slug, "stats.json"), "{}\n");
        return { code: 0 };
      },
      out: (s) => out.push(s),
      err: () => {},
    });
    assert.equal(code, 0);
    const joined = out.join("");
    assert.match(joined, /project=alpha dossiers=1 had=0 backfilled=1 failed=0/);
    assert.match(joined, /total: 1\/1 with stats/);
    assert.equal(out[out.length - 1].trim(), "total: 1/1 with stats", "the table is the last thing on stdout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main reports unknown project dirs on stdout and never collects them (exit 0)", () => {
  const root = makeMissionsRoot();
  try {
    mkDossier(root, "alpha", "a", {});
    mkDossier(root, "stray", "s", {});
    const out = [];
    const called = [];
    const code = main(["node", "x", "--missions", root], {
      projects: [{ id: "alpha" }],
      collect: (item) => {
        called.push(`${item.project}/${item.slug}`);
        return { code: 0 };
      },
      out: (s) => out.push(s),
      err: () => {},
    });
    assert.equal(code, 0);
    assert.match(out.join(""), /skipped unknown project dir: stray/);
    assert.ok(!called.includes("stray/s"), "stray's dossier was never collected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── parseArgs ─────────────────────────────────────────────────────────────────

test("parseArgs: default is empty/all; flags parsed; missing value is bad", () => {
  assert.deepEqual(parseArgs(["node", "x"]), {
    project: undefined,
    all: false,
    force: false,
    missions: undefined,
    bad: false,
  });
  const p = parseArgs(["node", "x", "--project", "alpha", "--force"]);
  assert.equal(p.project, "alpha");
  assert.equal(p.force, true);
  assert.equal(p.bad, false);
  assert.ok(parseArgs(["node", "x", "--project"]).bad, "missing --project value is bad");
  assert.ok(parseArgs(["node", "x", "--bogus"]).bad, "unknown flag is bad");
});

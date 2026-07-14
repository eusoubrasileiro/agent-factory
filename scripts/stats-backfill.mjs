#!/usr/bin/env node
/**
 * stats-backfill — repeatable driver that fills missing `stats.json` across
 * every mission dossier (board v5, M2 / factory-metrics).
 *
 * WHY this exists: most dossiers were never collected, so the board's Agentes +
 * Histórico layers starve into "sem dados" and can't answer "is the factory worth
 * it?". This script turns the EXISTING collector loose on every dossier in one
 * pass. It computes nothing itself — `collect` (from `mission-stats.mjs`) owns
 * every number; the driver only decides WHAT to collect and reports coverage.
 *
 * Architecture (house style, cf. `board-sync.mjs`): a pure planner + an
 * effects-injected runner, so tests never touch git.
 *   - `planBackfill(rootDir, projects, opts)` → `{ work, skipped }`. Walks the
 *     dossier tree, partitions dossiers into work (collect needed) vs skipped
 *     (already had stats, or an unknown project dir). Writes nothing.
 *   - `runBackfill(plan, collectFn, emit)` → `{ backfilled, failed }`. Calls the
 *     INJECTED `collectFn` once per work item; the CLI passes the real `collect`,
 *     tests pass a fake. Per-line try/catch tolerance: a throwing dossier is
 *     recorded as failed and skipped, NEVER zero-filled (the E1-d law — "absent,
 *     never zero").
 *
 * CLI:
 *   node scripts/stats-backfill.mjs [--project <id>] [--all] [--force] [--missions <dir>]
 *
 *   --project <id>   backfill one project's `missions/<id>/` (must be a known
 *                    profile id; unknown → exit 2).
 *   --all            every project dir under `missions/` whose name is a known
 *                    profile id; unknown dirs are reported + skipped, not run.
 *                    (Also the default when no selection flag is given.)
 *   --force          re-collect even when `stats.json` already exists. Without
 *                    it, existing files are NEVER touched (A1 no-clobber).
 *   --missions <dir> override the missions root (hermetic fixtures in tests).
 *
 * Exit codes: 0 on any run that completes (per-dossier failures still exit 0 —
 * it's a report tool) · 2 on bad args / unknown --project.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/is-main.mjs";
import { FACTORY_ROOT, loadProjects, resolveProject } from "./lib/project.mjs";
import { collect } from "./mission-stats.mjs";

// ─── Pure core ────────────────────────────────────────────────────────────────

/**
 * Non-dot subdirectory names under `dir`, sorted ascending. Dot-dirs (`.git`,
 * `.cache`, …) and plain files are dropped — they are noise, never dossiers, and
 * count as neither total nor failure (A2). Total on any read error (never throws).
 * @param {string} dir
 * @returns {string[]}
 */
function listDirs(dir) {
  let ents = [];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** True iff `p` exists and is a directory. Never throws. */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Plan a backfill pass — PURE: reads the tree, writes nothing, runs no git.
 *
 * Selection:
 *   - `opts.project` set → only `rootDir/<id>/`, and only if `<id>` is a known
 *     profile id. (The unknown→exit-2 verdict is main()'s job; an unknown id here
 *     simply yields no work.)
 *   - otherwise (--all / default) → every non-dot subdir of `rootDir` whose name
 *     is a known profile id. Non-dot subdirs that are NOT known ids are returned
 *     as `skipped` (`kind: "unknown-project"`) so the caller can report them.
 *
 * For each dossier dir under a target project:
 *   - already has `stats.json` and not `--force` → `skipped` (`kind: "had"`)
 *   - otherwise → `work`, carrying `hadStats` so the adapter can tell a first
 *     collect from a `--force` recollect.
 *
 * @param {string} rootDir — the missions root (holds `<project>/<slug>/`).
 * @param {Array<{id: string}>} projects — known profile entries (`loadProjects`).
 * @param {{project?: string, force?: boolean}} [opts]
 * @returns {{ work: Array<{project: string, slug: string, missionsRoot: string, hadStats: boolean}>,
 *            skipped: Array<{kind: "had", project: string, slug: string} |
 *                          {kind: "unknown-project", dir: string}> }}
 */
export function planBackfill(rootDir, projects, opts = {}) {
  const knownIds = new Set(
    (Array.isArray(projects) ? projects : []).map((p) => p && p.id).filter(Boolean),
  );
  const force = Boolean(opts.force);

  let targets;
  if (opts.project) {
    const dir = path.join(rootDir, opts.project);
    targets = knownIds.has(opts.project) && isDir(dir) ? [{ id: opts.project, dir }] : [];
  } else {
    targets = listDirs(rootDir)
      .filter((name) => knownIds.has(name))
      .map((name) => ({ id: name, dir: path.join(rootDir, name) }));
  }
  targets.sort(byId);

  const work = [];
  const skipped = [];

  for (const t of targets) {
    for (const slug of listDirs(t.dir)) {
      const hasStats = existsSync(path.join(t.dir, slug, "stats.json"));
      if (hasStats && !force) {
        skipped.push({ kind: "had", project: t.id, slug });
      } else {
        work.push({ project: t.id, slug, missionsRoot: t.dir, hadStats: hasStats });
      }
    }
  }

  // --all/default: surface non-dot project dirs that aren't known profiles. They
  // are reported (main emits a notice) and never processed.
  if (!opts.project) {
    for (const name of listDirs(rootDir)) {
      if (!knownIds.has(name)) skipped.push({ kind: "unknown-project", dir: name });
    }
  }

  return { work, skipped };
}

/**
 * Execute a backfill plan against an INJECTED `collectFn`. Per-line tolerant: a
 * `collectFn` that throws is recorded as `failed` and the run continues — and,
 * per the E1-d law, the driver writes NOTHING on failure (no synthesized zeros
 * file). `collectFn(item)` receives the work item and is expected to write
 * `stats.json` itself (the real `collect` does); the driver only observes
 * success vs throw.
 * @param {{work: Array<object>}} plan
 * @param {(item: {project: string, slug: string, missionsRoot: string, hadStats: boolean}) => unknown} collectFn
 * @param {(line: string) => void} [emit] — one progress line per dossier
 * @returns {{ backfilled: Array<{project: string, slug: string}>,
 *            failed: Array<{project: string, slug: string, error: string}> }}
 */
export function runBackfill(plan, collectFn, emit = () => {}) {
  const backfilled = [];
  const failed = [];
  const work = plan && Array.isArray(plan.work) ? plan.work : [];

  for (const item of work) {
    try {
      collectFn(item);
      backfilled.push({ project: item.project, slug: item.slug });
      emit(`backfilled ${item.project}/${item.slug}`);
    } catch (err) {
      // A3 / E1-d: a dossier whose collect throws gets NO stats.json. Record
      // {slug, error} and move on. Do NOT zero-fill — that would disguise a real
      // failure as a measured zero ("sem dados" must mean unmeasured, never 0).
      const message = err && err.message ? err.message : String(err);
      failed.push({ project: item.project, slug: item.slug, error: message });
      emit(`failed ${item.project}/${item.slug}: ${message}`);
    }
  }

  return { backfilled, failed };
}

/**
 * Render the coverage report (PURE). One deterministic line per project, sorted
 * by id ascending, then a final `total: X/Y with stats` where Y is the dossier
 * count and X is the number left with stats (`had` untouched + `backfilled`).
 * @param {{work: Array<object>, skipped: Array<object>}} plan
 * @param {{backfilled: Array<{project: string}>, failed: Array<{project: string}>}} results
 * @returns {string[]}
 */
export function formatReport(plan, results) {
  const byProject = new Map();
  const acc = (id) => {
    let a = byProject.get(id);
    if (!a) {
      a = { dossiers: 0, had: 0, backfilled: 0, failed: 0 };
      byProject.set(id, a);
    }
    return a;
  };

  const work = plan && Array.isArray(plan.work) ? plan.work : [];
  const skipped = plan && Array.isArray(plan.skipped) ? plan.skipped : [];
  const backfilled = results && Array.isArray(results.backfilled) ? results.backfilled : [];
  const failed = results && Array.isArray(results.failed) ? results.failed : [];

  for (const w of work) acc(w.project).dossiers += 1;
  for (const s of skipped) {
    if (s && s.kind === "had") {
      acc(s.project).dossiers += 1;
      acc(s.project).had += 1;
    }
  }
  for (const b of backfilled) acc(b.project).backfilled += 1;
  for (const f of failed) acc(f.project).failed += 1;

  const lines = [];
  let withStats = 0;
  let total = 0;
  for (const id of [...byProject.keys()].sort()) {
    const a = byProject.get(id);
    lines.push(
      `project=${id} dossiers=${a.dossiers} had=${a.had} backfilled=${a.backfilled} failed=${a.failed}`,
    );
    withStats += a.had + a.backfilled;
    total += a.dossiers;
  }
  lines.push(`total: ${withStats}/${total} with stats`);
  return lines;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const USAGE =
  "Usage:\n" +
  "  node scripts/stats-backfill.mjs [--project <id>] [--all] [--force] [--missions <dir>]\n";

/**
 * Parse argv into `{ project, all, force, missions, bad }`. `bad` is true on any
 * malformed input: an unknown flag, a stray positional, a value-consuming flag
 * missing its value, or `--project` combined with `--all` (mutually exclusive).
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = (argv ?? []).slice(2);
  const opts = { project: undefined, all: false, force: false, missions: undefined, bad: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--project": {
        const v = args[++i];
        if (v === undefined || v.startsWith("--")) opts.bad = true;
        else opts.project = v;
        break;
      }
      case "--missions": {
        const v = args[++i];
        if (v === undefined || v.startsWith("--")) opts.bad = true;
        else opts.missions = v;
        break;
      }
      case "--all":
        opts.all = true;
        break;
      case "--force":
        opts.force = true;
        break;
      default:
        opts.bad = true; // unknown flag or stray positional
    }
  }
  if (opts.project && opts.all) opts.bad = true;
  return opts;
}

/**
 * Thin shell: parse → plan → run → report. Effects are injected via `deps` so
 * tests drive it without git: `out`/`err` capture streams, `projects` replaces
 * `loadProjects`, and `collect` replaces the real collector. Returns the exit
 * code (0 completed · 2 bad args / unknown --project).
 * @param {string[]} argv
 * @param {{out?: (s: string) => void, err?: (s: string) => void,
 *          projects?: Array<{id: string}>, collect?: (item: object) => unknown}} [deps]
 * @returns {number}
 */
export function main(argv, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const err = deps.err ?? ((s) => process.stderr.write(s));
  const projects = Array.isArray(deps.projects) ? deps.projects : loadProjects(FACTORY_ROOT);

  const opts = parseArgs(argv);
  if (opts.bad) {
    err(USAGE);
    return 2;
  }

  if (opts.project && !projects.some((p) => p.id === opts.project)) {
    err(`unknown project: ${opts.project}\n`);
    err(USAGE);
    return 2;
  }

  const rootDir = opts.missions ? path.resolve(opts.missions) : path.join(FACTORY_ROOT, "missions");
  const plan = planBackfill(rootDir, projects, opts);

  // Unknown project dirs (--all/default): report up front so stdout still ENDS
  // with the coverage table (A4).
  for (const s of plan.skipped) {
    if (s.kind === "unknown-project") out(`skipped unknown project dir: ${s.dir}\n`);
  }

  // The real collector needs the product repo root (for git LOC); resolve it from
  // the profile. In tests a fake `collect` is injected, so this never runs.
  const collectFn =
    deps.collect ??
    ((item) =>
      collect({
        slug: item.slug,
        missionsRoot: item.missionsRoot,
        repoRoot: resolveProject({ project: item.project }, FACTORY_ROOT).repoRoot,
        project: item.project,
        factoryRoot: FACTORY_ROOT,
      }));

  const results = runBackfill(plan, collectFn, (line) => out(`${line}\n`));
  for (const line of formatReport(plan, results)) out(`${line}\n`);

  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}

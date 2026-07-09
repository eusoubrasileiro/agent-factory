#!/usr/bin/env node
/**
 * project.mjs — the factory's single source of path resolution + profile.
 *
 * The factory engine was extracted from wahub into its own repo
 * (`AmiticIA-AutoSys/factory`). Two roots now exist where wahub used to have
 * one, and every entry-point script must be able to tell them apart:
 *
 *   - factoryRoot: this repo — holds `missions/<project>/<slug>/` dossiers,
 *     `history.jsonl`, `.publish.log`, `deploy/projects.json`, the per-project
 *     `projects/<id>/` profiles, and the rendered `dist/factory-board/`.
 *     Dossier auto-commits land HERE.
 *   - repoRoot: the PRODUCT repo (e.g. wahub, at `../../products/wahub`) — holds
 *     the code the workers edit, the `agent/*` branches board-report scans, the
 *     `backlog/` kanban, and the PRD. Git operations about product code run with
 *     `cwd = repoRoot`.
 *
 * A **project profile** lives at `projects/<id>/`. Its `project.json` carries
 * the engine-shape facts (`gate`, `trunk`, `branchPrefix`, `dispatch`); sibling
 * files hold the rest: `critical-files.json` (globs), `seat.env`, `validation.md`.
 * `deploy/projects.json` is the legacy manifest — still read for back-compat, but
 * on id collision the `projects/<id>/project.json` entry wins.
 *
 * Each entry (merged manifest shape):
 *   { "id": "wahub", "name": "...", "path": "../../products/wahub",
 *     "prd": "docs/prd/nexus-build-backlog.md", "trunk": "main",
 *     "branchPrefix": "agent/", "gate": [...], "dispatch": "..." }
 * `path` is relative to factoryRoot. (`repo` is accepted as a legacy alias.)
 *
 * Design rule from the extraction plan: NEVER use relative `../..` to escape a
 * worktree. factoryRoot comes from `$FACTORY_ROOT` (dispatch writes it into a
 * worktree's `.agent-env`) or, when unset, from this file's own location — which
 * is stable regardless of the caller's cwd.
 *
 * Usage (from a sibling script under scripts/):
 *   import { resolveProject, FACTORY_ROOT } from "./lib/project.mjs";
 *   const { id, factoryRoot, repoRoot, missionsRoot, prdPath, profile } =
 *     resolveProject({ project, dir, repo });
 *
 * `resolveProject` is TOTAL: an unknown/missing project or manifest, or a
 * corrupt profile file, never throws — it synthesizes a best-effort entry and a
 * default profile so callers stay soft-fail. Imported by `verdict.mjs`,
 * `ratify.mjs`, `board-report.mjs`, `pr-record.mjs`; if it throws, a mission dies.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The factory repo root. Prefer an explicit `$FACTORY_ROOT` (set by dispatch in
 * worktree `.agent-env`); otherwise derive from this file: scripts/lib → ../../
 */
export const FACTORY_ROOT = process.env.FACTORY_ROOT
  ? path.resolve(process.env.FACTORY_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Read + parse `deploy/projects.json`. Missing or malformed → `[]` (never throws).
 * @param {string} [factoryRoot]
 * @returns {Array<object>}
 */
function readDeployManifest(factoryRoot) {
  const p = path.join(factoryRoot, "deploy", "projects.json");
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Load all known projects, merging the two manifest sources:
 *   1. `projects/<id>/project.json` — the canonical per-project profile (new).
 *   2. `deploy/projects.json`        — the legacy flat manifest (back-compat).
 *
 * On id collision the `projects/<id>/project.json` entry WINS. A corrupt or
 * unreadable file is SKIPPED, never thrown. Returns `[]` on total failure.
 *
 * @param {string} [factoryRoot]
 * @returns {Array<{id: string, name?: string, path?: string, repo?: string,
 *            prd?: string, trunk?: string, branchPrefix?: string, gate?: string[],
 *            dispatch?: string}>}
 */
export function loadProjects(factoryRoot = FACTORY_ROOT) {
  const merged = new Map(); // id -> entry; first write wins (projects/ populates first)

  // 1. Scan projects/<id>/project.json — canonical profile source.
  const projectsDir = path.join(factoryRoot, "projects");
  let subs = [];
  try {
    subs = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    subs = [];
  }
  for (const ent of subs) {
    if (!ent.isDirectory()) continue;
    const p = path.join(projectsDir, ent.name, "project.json");
    if (!existsSync(p)) continue;
    let entry;
    try {
      entry = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue; // corrupt project.json — skip, never throw
    }
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
    merged.set(entry.id, entry);
  }

  // 2. deploy/projects.json — back-compat; only fills ids not already known.
  for (const entry of readDeployManifest(factoryRoot)) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
    if (!merged.has(entry.id)) merged.set(entry.id, entry);
  }

  return [...merged.values()];
}

/**
 * Build the per-project profile. Never throws — every read is wrapped tightly
 * around `readFileSync`/`JSON.parse` only, so a missing or corrupt file degrades
 * to the default value without swallowing programming errors.
 *
 * @param {{id: string}} entry
 * @param {string} factoryRoot
 * @returns {{gate: string[], trunk: string, branchPrefix: string,
 *            criticalFiles: string[], seatEnvPath: string|null,
 *            validationPath: string|null}}
 */
function buildProfile(entry, factoryRoot) {
  const projectDir = path.join(factoryRoot, "projects", entry.id);

  // Shape fields come straight from project.json — defaults when absent.
  const gate = Array.isArray(entry.gate) ? entry.gate : [];
  const trunk = typeof entry.trunk === "string" ? entry.trunk : "main";
  const branchPrefix =
    typeof entry.branchPrefix === "string" ? entry.branchPrefix : "agent/";

  // critical-files.json is a JSON array of globs; missing/corrupt → [].
  let criticalFiles = [];
  const cfPath = path.join(projectDir, "critical-files.json");
  if (existsSync(cfPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfPath, "utf8"));
      if (Array.isArray(parsed)) criticalFiles = parsed;
    } catch {
      // corrupt critical-files.json → leave at default []
    }
  }

  // seat.env + validation.md resolve to ABS paths when present, null otherwise.
  const seatEnv = path.join(projectDir, "seat.env");
  const seatEnvPath = existsSync(seatEnv) ? seatEnv : null;
  const validation = path.join(projectDir, "validation.md");
  const validationPath = existsSync(validation) ? validation : null;

  return { gate, trunk, branchPrefix, criticalFiles, seatEnvPath, validationPath };
}

/**
 * Resolve a project to its concrete roots + profile.
 *
 * Selection order for the entry: explicit `project` id → `$FACTORY_PROJECT` →
 * the sole entry in the manifest. If none matches, a best-effort synthetic entry
 * (`id: <requested>|"default"`, `path: "."`) is returned so the caller never
 * crashes — the requested id is preserved (no "wahub" literal fallback).
 *
 * `dir` overrides the missions root and `repo` overrides the product repo root
 * (both used by tests and the legacy `--dir`/`--repo` flags); when present they
 * win over the manifest-derived defaults.
 *
 * `profile` is always present: gate/trunk/branchPrefix from `project.json`, plus
 * `criticalFiles` / `seatEnvPath` / `validationPath` read from
 * `projects/<id>/` siblings. A missing or corrupt file degrades to the default.
 *
 * @param {{project?: string, dir?: string, repo?: string}|string} [opts]
 * @param {string} [factoryRoot]
 * @returns {{id: string, name: string, factoryRoot: string, repoRoot: string,
 *            missionsRoot: string, prdPath: string|null, entry: object,
 *            profile: {gate: string[], trunk: string, branchPrefix: string,
 *                      criticalFiles: string[], seatEnvPath: string|null,
 *                      validationPath: string|null}}}
 */
export function resolveProject(opts = {}, factoryRoot = FACTORY_ROOT) {
  const { project, dir, repo } = typeof opts === "string" ? { project: opts } : opts;
  const projects = loadProjects(factoryRoot);

  let entry;
  const wantId = project || process.env.FACTORY_PROJECT;
  if (wantId) entry = projects.find((p) => p.id === wantId);
  else if (projects.length === 1) entry = projects[0];

  if (!entry) {
    // Total fallback: never throw. id is the requested one (or "default").
    entry = { id: wantId || "default", path: ".", prd: null };
  }

  const relRepo = entry.path || entry.repo || ".";
  const repoRoot = repo ? path.resolve(repo) : path.resolve(factoryRoot, relRepo);
  const missionsRoot = dir ? path.resolve(dir) : path.join(factoryRoot, "missions", entry.id);
  const prdPath = entry.prd ? path.resolve(repoRoot, entry.prd) : null;

  return {
    id: entry.id,
    name: entry.name || entry.id,
    factoryRoot,
    repoRoot,
    missionsRoot,
    prdPath,
    entry,
    profile: buildProfile(entry, factoryRoot),
  };
}

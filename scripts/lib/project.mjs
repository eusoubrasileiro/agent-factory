#!/usr/bin/env node
/**
 * project.mjs — the factory's single source of path resolution.
 *
 * The factory engine was extracted from wahub into its own repo
 * (`AmiticIA-AutoSys/factory`). Two roots now exist where wahub used to have
 * one, and every entry-point script must be able to tell them apart:
 *
 *   - factoryRoot: this repo — holds `missions/<project>/<slug>/` dossiers,
 *     `history.jsonl`, `.publish.log`, `deploy/projects.json`, and the rendered
 *     `dist/factory-board/`. Dossier auto-commits land HERE.
 *   - repoRoot: the PRODUCT repo (e.g. wahub, at `../../products/wahub`) — holds
 *     the code the workers edit, the `agent/*` branches board-report scans, the
 *     `backlog/` kanban, and the PRD. Git operations about product code run with
 *     `cwd = repoRoot`.
 *
 * `deploy/projects.json` is the manifest. Each entry:
 *   { "id": "wahub", "name": "...", "path": "../../products/wahub",
 *     "prd": "docs/prd/nexus-build-backlog.md" }
 * `path` is relative to factoryRoot. (`repo` is accepted as a legacy alias.)
 *
 * Design rule from the extraction plan: NEVER use relative `../..` to escape a
 * worktree. factoryRoot comes from `$FACTORY_ROOT` (dispatch writes it into a
 * worktree's `.agent-env`) or, when unset, from this file's own location — which
 * is stable regardless of the caller's cwd.
 *
 * Usage (from a sibling script under scripts/):
 *   import { resolveProject, FACTORY_ROOT } from "./lib/project.mjs";
 *   const { id, factoryRoot, repoRoot, missionsRoot, prdPath } =
 *     resolveProject({ project, dir, repo });
 *
 * `resolveProject` is TOTAL: an unknown/missing project or manifest never
 * throws — it synthesizes a best-effort entry so callers stay soft-fail.
 */

import { existsSync, readFileSync } from "node:fs";
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
 * @returns {Array<{id: string, name?: string, path?: string, repo?: string, prd?: string}>}
 */
export function loadProjects(factoryRoot = FACTORY_ROOT) {
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
 * Resolve a project to its concrete roots.
 *
 * Selection order for the entry: explicit `project` id → `$FACTORY_PROJECT` →
 * the sole entry in the manifest. If none matches, a best-effort synthetic entry
 * (`path: "."`) is returned so the caller never crashes.
 *
 * `dir` overrides the missions root and `repo` overrides the product repo root
 * (both used by tests and the legacy `--dir`/`--repo` flags); when present they
 * win over the manifest-derived defaults.
 *
 * @param {{project?: string, dir?: string, repo?: string}|string} [opts]
 * @param {string} [factoryRoot]
 * @returns {{id: string, name: string, factoryRoot: string, repoRoot: string,
 *            missionsRoot: string, prdPath: string|null, entry: object}}
 */
export function resolveProject(opts = {}, factoryRoot = FACTORY_ROOT) {
  const { project, dir, repo } = typeof opts === "string" ? { project: opts } : opts;
  const projects = loadProjects(factoryRoot);

  let entry;
  const wantId = project || process.env.FACTORY_PROJECT;
  if (wantId) entry = projects.find((p) => p.id === wantId);
  else if (projects.length === 1) entry = projects[0];

  if (!entry) {
    // Total fallback: never throw. id is the requested one (or "wahub" default).
    entry = { id: wantId || "wahub", path: ".", prd: null };
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
  };
}

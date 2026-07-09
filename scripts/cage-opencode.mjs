#!/usr/bin/env node
/**
 * cage-opencode.mjs — the cage for the driver we ACTUALLY run.
 *
 * `cage-settings.mjs` renders a Claude Code cage. Nothing installs it, and opencode
 * does not read Claude Code's `.claude/settings.external.json` schema, so for the
 * external GLM/opencode builder seat the Critical-File denies, the `git push` deny
 * and the `~/.ssh` deny were never enforced (decisions.md D-16). This module renders
 * the same profile facts into opencode's OWN permission schema, which opencode does
 * read. One profile, two renderers.
 *
 * Schema (opencode v1.17.x — opencode.ai/docs/permissions, /docs/config):
 *
 *   { "permission": { "edit": {"*":"allow", "<glob>":"deny", ...},
 *                     "bash": {"*":"allow", "git push *":"deny", ...} } }
 *
 * THE ORDER IS LOAD-BEARING. opencode resolves by **last matching rule wins**, so
 * `"*": "allow"` must be the FIRST key. Put it last and every deny beneath it is
 * silently overridden — a cage that audits fine and stops nothing. `auditOpencodeCage`
 * refuses that shape.
 *
 * SELF-PROTECTION. A project `opencode.json` outranks `$OPENCODE_CONFIG`, so an agent
 * could write its own `opencode.json` into the worktree and override the cage. The
 * cage therefore denies edits to `opencode.json`, `.opencode/**` and `AGENTS.md` from
 * the first turn, and the rendered file itself is written OUTSIDE the worktree.
 *
 * WHAT THIS DOES NOT DO. Same honest boundary as the Claude cage (D-11): an `edit`
 * deny stops the agent's edit/write tools; it does not stop `python3 -c "open(...)"`.
 * Secrets are contained by the dummy `.env` in the worktree and, eventually, an OS
 * sandbox. Deny rules contain the careless worker (threat T1 — the one incident we
 * have actually observed), not a determined one.
 *
 * Usage:
 *   node scripts/cage-opencode.mjs print [--project <id>]
 *   node scripts/cage-opencode.mjs render <dest.json> [--project <id>]
 *
 * Exit codes:
 *   0 ok · 1 refused to write a broken cage · 2 usage error
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/is-main.mjs";
import { resolveProject } from "./lib/project.mjs";

/** Globs the cage uses to protect itself from the agent it cages. */
export const SELF_PROTECT_GLOBS = ["opencode.json", ".opencode/**", "AGENTS.md"];

/** Bash commands denied for every project, always. */
const BASH_DENIES = ["git push *", "git push"];

const VALID = new Set(["allow", "deny", "ask"]);

/**
 * Render an opencode permission config from a profile's Critical Files.
 *
 * Key insertion order IS the semantics here (last match wins), and `JSON.stringify`
 * preserves it for string keys, so the wildcard is written first, deliberately.
 *
 * @param {{criticalFiles?: string[]}} [opts]
 * @returns {object} an opencode config object
 */
export function renderOpencodeCage(opts = {}) {
  const globs = Array.isArray(opts?.criticalFiles) ? opts.criticalFiles : [];

  const edit = { "*": "allow" };
  for (const g of globs) {
    if (typeof g === "string" && g.length > 0) edit[g] = "deny";
  }
  for (const g of SELF_PROTECT_GLOBS) edit[g] = "deny";

  const bash = { "*": "allow" };
  for (const c of BASH_DENIES) bash[c] = "deny";

  return {
    $schema: "https://opencode.ai/config.json",
    permission: { edit, bash },
  };
}

/**
 * Everything that must be true before a cage is allowed onto disk.
 * @param {object} cage @returns {string[]} problems (empty = ok)
 */
export function auditOpencodeCage(cage) {
  const problems = [];
  const perm = cage?.permission;
  if (!perm || typeof perm !== "object") {
    problems.push("permission block missing");
    return problems;
  }

  for (const table of ["edit", "bash"]) {
    const map = perm[table];
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      problems.push(`permission.${table} missing or not an object`);
      continue;
    }
    const keys = Object.keys(map);
    if (keys.length === 0) {
      problems.push(`permission.${table} is empty`);
      continue;
    }
    // The order trap: last matching rule wins, so a trailing "*" overrides every deny.
    if (keys[0] !== "*") {
      problems.push(`permission.${table}: first key must be "*" (last match wins), got "${keys[0]}"`);
    }
    for (const [k, v] of Object.entries(map)) {
      if (!VALID.has(v)) problems.push(`permission.${table}["${k}"] = "${v}" (want allow|deny|ask)`);
    }
  }

  if (perm.edit && typeof perm.edit === "object") {
    for (const g of SELF_PROTECT_GLOBS) {
      if (perm.edit[g] !== "deny") problems.push(`cage does not protect itself: ${g} must be deny`);
    }
  }
  if (perm.bash && typeof perm.bash === "object") {
    for (const c of BASH_DENIES) {
      if (perm.bash[c] !== "deny") problems.push(`bash deny missing: ${c}`);
    }
  }
  return problems;
}

/**
 * Where the rendered cage lives. Deliberately OUTSIDE the worktree: an agent that
 * can edit its own cage has no cage.
 * @param {string} worktreeAbs @param {string} [cageDir] @returns {string}
 */
export function opencodeCagePath(worktreeAbs, cageDir) {
  const base = cageDir ?? path.join(process.env.TMPDIR || "/tmp", "amiticia-cages");
  const key = path.basename(path.resolve(worktreeAbs));
  return path.join(path.resolve(base), `${key}.opencode.json`);
}

/**
 * Render + audit + write. Throws rather than persist a cage that fails its own audit —
 * a broken cage on disk is worse than none, because it is trusted.
 *
 * @param {string} destPath
 * @param {{project?: string, factoryRoot?: string, renderFn?: Function}} [opts]
 * @returns {string} destPath
 */
export function writeOpencodeCage(destPath, opts = {}) {
  const { project, factoryRoot, renderFn = renderOpencodeCage } = opts;
  let criticalFiles = [];
  if (project) {
    // resolveProject is TOTAL — an unknown id degrades to [], never throws.
    criticalFiles = resolveProject({ project }, factoryRoot).profile.criticalFiles;
  }
  const cage = renderFn({ criticalFiles });
  const problems = auditOpencodeCage(cage);
  if (problems.length > 0) {
    throw new Error(`refusing to write a broken cage:\n- ${problems.join("\n- ")}`);
  }
  mkdirSync(path.dirname(destPath), { recursive: true });
  writeFileSync(destPath, `${JSON.stringify(cage, null, 2)}\n`);
  return destPath;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/cage-opencode.mjs print [--project <id>]\n" +
      "  node scripts/cage-opencode.mjs render <dest.json> [--project <id>]\n",
  );
}

function main() {
  const argv = process.argv.slice(2);
  const [cmd, maybeDest] = argv;
  const pi = argv.indexOf("--project");
  const project = pi !== -1 ? argv[pi + 1] : undefined;

  if (cmd === "print") {
    let criticalFiles = [];
    if (project) criticalFiles = resolveProject({ project }).profile.criticalFiles;
    process.stdout.write(`${JSON.stringify(renderOpencodeCage({ criticalFiles }), null, 2)}\n`);
    return 0;
  }
  if (cmd === "render" && maybeDest && !maybeDest.startsWith("--")) {
    process.stdout.write(`${writeOpencodeCage(path.resolve(maybeDest), { project })}\n`);
    return 0;
  }
  usage();
  return 2;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`cage-opencode: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

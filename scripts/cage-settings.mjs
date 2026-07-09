#!/usr/bin/env node
/**
 * Cage settings renderer for the EXTERNAL (untrusted) worker seat — glm-cc-cage F2.
 *
 * Reads `templates/settings-external.json`, substitutes `{{WORKTREE}}` with the
 * absolute worktree path, and writes `<worktree>/.claude/settings.external.json`.
 * Written FRESH at every spawn by claude-worker.mjs, so an agent that somehow
 * mutated it in a previous run cannot carry the weakened cage forward.
 *
 * Anchoring (decisions.md D-11 — the subtle part):
 *   `//abs/path`  filesystem-absolute      ← what we emit
 *   `/abs/path`   relative to THIS settings file's dir  ← the trap
 *   `./path`      relative to claude's cwd
 * We emit `//` so the rules hold no matter what cwd the seat is spawned with.
 *
 * The rules are a real boundary for T1 (Critical-File edit) and NOT a boundary
 * for T2 (secret read) — `python3 -c "open('.env').read()"` bypasses Read deny.
 * Secrets are contained by W1 (dummy env) + the OS sandbox. See D-11/D-12.
 *
 * Usage:
 *   node scripts/cage-settings.mjs render <worktree>   # writes the settings file
 *   node scripts/cage-settings.mjs print  <worktree>   # dumps JSON to stdout
 *
 * Exit codes:
 *   0 ok · 1 template missing/unparseable · 2 usage error
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "templates", "settings-external.json");

/** Where the cage settings land inside a worktree. */
export function cageSettingsPath(worktreeAbs) {
  return path.join(worktreeAbs, ".claude", "settings.external.json");
}

/**
 * Substitute `{{WORKTREE}}` and drop the `_readme` block (Claude Code parses the
 * settings with a strict schema; the prose belongs to the human reading the
 * template, not to the CLI).
 *
 * A trailing slash on `worktreeAbs` would yield `//path//backend` — normalize.
 * @param {object} template — parsed templates/settings-external.json
 * @param {string} worktreeAbs — absolute path, no trailing slash required
 * @returns {object} the settings object to serialize
 */
export function renderCageSettings(template, worktreeAbs) {
  if (!template || typeof template !== "object") throw new Error("template must be an object");
  if (typeof worktreeAbs !== "string" || !path.isAbsolute(worktreeAbs)) {
    throw new Error(`worktree must be an absolute path, got: ${worktreeAbs}`);
  }
  // `//` + a path that already starts with `/` would double the separator.
  const anchor = path.normalize(worktreeAbs).replace(/\/+$/, "").replace(/^\//, "");
  const walk = (node) => {
    if (typeof node === "string") return node.replaceAll("{{WORKTREE}}", anchor);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === "_readme") continue;
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(template);
}

/** Every deny rule in a rendered settings object. */
export function denyRules(settings) {
  const d = settings?.permissions?.deny;
  return Array.isArray(d) ? d : [];
}

/**
 * Guard against the anchoring trap: after rendering, no path-scoped rule may
 * carry a single-leading-slash path (which would silently anchor to the settings
 * file's own directory) and none may still hold an unsubstituted placeholder.
 * @param {object} settings @returns {string[]} human-readable problems (empty = ok)
 */
export function auditCageSettings(settings) {
  const problems = [];
  if (settings?.sandbox?.enabled !== true) problems.push("sandbox.enabled must be true");
  // Without failIfUnavailable the sandbox degrades SILENTLY to no sandbox (D-12).
  if (settings?.sandbox?.failIfUnavailable !== true) {
    problems.push("sandbox.failIfUnavailable must be true (fail-closed)");
  }
  if (settings?.sandbox?.allowUnsandboxedCommands !== false) {
    problems.push("sandbox.allowUnsandboxedCommands must be false");
  }
  for (const rule of denyRules(settings)) {
    if (rule.includes("{{")) problems.push(`unsubstituted placeholder: ${rule}`);
    const m = rule.match(/^(Edit|Write|Read)\((.*)\)$/);
    if (!m) continue;
    const target = m[2];
    const anchored = target.startsWith("//") || target.startsWith("~/") || target.startsWith("./");
    if (!anchored) problems.push(`mis-anchored rule (use //abs, ~/ or ./): ${rule}`);
  }
  return problems;
}

/** Read + parse the checked-in template. */
export function loadTemplate(templatePath = TEMPLATE_PATH) {
  return JSON.parse(readFileSync(templatePath, "utf8"));
}

/**
 * Render + write the cage into a worktree. Returns the settings path.
 * Throws on a mis-anchored or non-fail-closed result — a broken cage must never
 * be written to disk and then trusted.
 */
export function writeCageSettings(worktreeAbs, templatePath = TEMPLATE_PATH) {
  const settings = renderCageSettings(loadTemplate(templatePath), worktreeAbs);
  const problems = auditCageSettings(settings);
  if (problems.length > 0) throw new Error(`refusing to write a broken cage:\n- ${problems.join("\n- ")}`);
  const out = cageSettingsPath(worktreeAbs);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(settings, null, 2)}\n`);
  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/cage-settings.mjs render <worktree>\n" +
      "  node scripts/cage-settings.mjs print  <worktree>\n",
  );
}

function main() {
  const [cmd, wt] = process.argv.slice(2);
  if (!cmd || !wt || !["render", "print"].includes(cmd)) {
    usage();
    return 2;
  }
  const abs = path.resolve(wt);
  if (cmd === "print") {
    process.stdout.write(`${JSON.stringify(renderCageSettings(loadTemplate(), abs), null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${writeCageSettings(abs)}\n`);
  return 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`cage-settings: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

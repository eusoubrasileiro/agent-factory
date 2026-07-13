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
 *   node scripts/cage-settings.mjs render <worktree> [--project <id>]  # writes the settings file
 *   node scripts/cage-settings.mjs print  <worktree> [--project <id>]  # dumps JSON to stdout
 *
 * `--project <id>` pulls that project's Critical Files from
 * projects/<id>/critical-files.json and merges them into the cage. Without it,
 * the base template is emitted alone (no product paths).
 *
 * Exit codes:
 *   0 ok · 1 template missing/unparseable · 2 usage error
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
import { resolveProject } from "./lib/project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "templates", "settings-external.json");
const HOOK_TEMPLATE_PATH = path.join(__dirname, "..", "templates", "cage-bash-hook.mjs");

/** Machine-local answer to "can the OS sandbox actually run here?" (D-18). */
export const MACHINE_CONFIG_PATH = path.join(homedir(), ".config", "amiticia", "factory-machine.json");

/**
 * Machine-local sandbox gate (D-18).
 *
 * `sandbox.enabled` is a fact about THIS MACHINE, not about the repo. On this box
 * Claude Code's sandbox cannot initialise (`apply-seccomp: write /proc/self/setgroups`,
 * identical with AppArmor's userns restriction on and off), and with
 * `failIfUnavailable` it then refuses to run any command at all — a cage that stops
 * the worker working is negative value.
 *
 * So the checked-in template declares the INTENT (`enabled: true, failIfUnavailable:
 * true`) and this reads the machine's ANSWER from `~/.config/amiticia/factory-machine.json`.
 * Absent or corrupt → `false`. Fail safe, not fail loud: a missing machine file must
 * not brick every dispatch on a fresh checkout.
 *
 * @param {string} [configPath]
 * @returns {boolean}
 */
export function machineSandboxEnabled(configPath = MACHINE_CONFIG_PATH) {
  if (!existsSync(configPath)) return false;
  try {
    return JSON.parse(readFileSync(configPath, "utf8"))?.sandbox === true;
  } catch {
    return false; // corrupt machine config — treat as "no sandbox here"
  }
}

/** Where the cage settings land inside a worktree. */
export function cageSettingsPath(worktreeAbs) {
  return path.join(worktreeAbs, ".claude", "settings.external.json");
}

/**
 * Deny rules for a project's Critical Files. Each glob yields BOTH an Edit and a
 * Write rule, fs-absolute (`//`) anchored via the {{WORKTREE}} placeholder. The
 * placeholder is left intact here — `renderCageSettings` substitutes it during
 * its walk, so the existing anchoring + audit logic handles these rules too.
 *
 * @param {string[]} globs — repo-relative globs from projects/<id>/critical-files.json
 * @returns {string[]}
 */
export function criticalFileRules(globs = []) {
  if (!Array.isArray(globs)) return [];
  const rules = [];
  for (const g of globs) {
    if (typeof g !== "string" || g.length === 0) continue;
    rules.push(`Edit(//{{WORKTREE}}/${g})`, `Write(//{{WORKTREE}}/${g})`);
  }
  return rules;
}

/**
 * Ancestor `.env` Read denies (cage-bash-hook F1). A dispatched worktree lives N
 * levels under a repo whose root may hold the real `.env`; the built-in Read tool
 * can reach it by absolute/relative path. Deny `.env` + `.env.*` reads for the three
 * nearest ancestor dirs — layout-agnostic defense-in-depth that complements the
 * PreToolUse hook (which blocks the shell/interpreter path to the same secret).
 * @param {string} worktreeAbs @returns {string[]}
 */
export function parentEnvRules(worktreeAbs) {
  const rules = [];
  let dir = path.normalize(worktreeAbs).replace(/\/+$/, "");
  for (let i = 0; i < 3; i++) {
    dir = path.dirname(dir);
    if (!dir || dir === "/" || dir === "." || dir === path.dirname(dir)) break;
    const anchor = dir.replace(/^\//, "");
    rules.push(`Read(//${anchor}/.env)`, `Read(//${anchor}/.env.*)`);
  }
  return rules;
}

/** Where the rendered PreToolUse Bash hook lands inside a worktree. */
export function cageHookPath(worktreeAbs) {
  return path.join(worktreeAbs, ".claude", "cage-bash-hook.mjs");
}

/** Render the Bash hook script with {{WORKTREE}} substituted. */
export function renderBashHook(worktreeAbs, templatePath = HOOK_TEMPLATE_PATH) {
  const anchor = path.normalize(worktreeAbs).replace(/\/+$/, "");
  return readFileSync(templatePath, "utf8").replaceAll("{{WORKTREE}}", anchor);
}

/** The `hooks.PreToolUse` block wiring the Bash hook. */
function bashHookConfig(worktreeAbs) {
  const hookAbs = cageHookPath(path.normalize(worktreeAbs).replace(/\/+$/, ""));
  return {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node ${hookAbs}` }] }],
  };
}

/**
 * Substitute `{{WORKTREE}}` and drop the `_readme` block (Claude Code parses the
 * settings with a strict schema; the prose belongs to the human reading the
 * template, not to the CLI).
 *
 * When `opts.criticalFiles` is given, those profile globs are appended to
 * `template.permissions.deny` (as Edit+Write `//`-anchored rules) BEFORE the
 * walk, so the existing anchoring logic substitutes {{WORKTREE}} for them too.
 * The base template therefore carries zero product paths (Feature 03).
 *
 * A trailing slash on `worktreeAbs` would yield `//path//backend` — normalize.
 * @param {object} template — parsed templates/settings-external.json
 * @param {string} worktreeAbs — absolute path, no trailing slash required
 * @param {{criticalFiles?: string[]}} [opts]
 * @returns {object} the settings object to serialize
 */
export function renderCageSettings(template, worktreeAbs, opts = {}) {
  if (!template || typeof template !== "object") throw new Error("template must be an object");
  if (typeof worktreeAbs !== "string" || !path.isAbsolute(worktreeAbs)) {
    throw new Error(`worktree must be an absolute path, got: ${worktreeAbs}`);
  }
  const { criticalFiles = [], sandboxEnabled = machineSandboxEnabled() } = opts || {};
  const extra = [...criticalFileRules(criticalFiles), ...parentEnvRules(worktreeAbs)];
  let merged = {
    ...template,
    permissions: { ...template.permissions, deny: [...(template.permissions?.deny ?? []), ...extra] },
  };
  // The template states the intent; the machine states what is possible (D-18).
  merged = { ...merged, sandbox: { ...merged.sandbox, enabled: sandboxEnabled === true } };
  // The PreToolUse Bash hook — the one layer interpreter-wrapping cannot evade (D-26).
  merged = { ...merged, hooks: bashHookConfig(worktreeAbs) };
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
  return walk(merged);
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

  // Tier A / Tier B (D-18). The OS sandbox is a MACHINE capability, not a policy:
  // on this kernel Claude Code's sandbox cannot initialise at all (it dies at
  // `write /proc/self/setgroups`, identically with AppArmor's userns restriction
  // on and off), and with failIfUnavailable it then refuses to run any command.
  // So a DISABLED or ABSENT sandbox must audit clean — that is Tier A, the posture
  // we actually ship, and its limits are documented rather than hidden.
  //
  // What stays a refusal is the dangerous middle: sandbox ENABLED but not
  // fail-closed silently degrades to NO sandbox while believing itself contained
  // (D-12 / M5). A false belief in containment is worse than none.
  if (settings?.sandbox?.enabled === true) {
    if (settings?.sandbox?.failIfUnavailable !== true) {
      problems.push("sandbox.failIfUnavailable must be true (fail-closed) when sandbox.enabled");
    }
    if (settings?.sandbox?.allowUnsandboxedCommands !== false) {
      problems.push("sandbox.allowUnsandboxedCommands must be false when sandbox.enabled");
    }
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
 * Resolve the template + profile critical files for a write/render call.
 * Back-compat: a string second arg is treated as `templatePath` (the old
 * `writeCageSettings(worktree, templatePath)` signature still works).
 * `resolveProject` is total — an unknown project degrades to `[]`, never throws.
 *
 * @param {string|{templatePath?: string, project?: string, factoryRoot?: string}} [opts]
 * @returns {{template: object, criticalFiles: string[]}}
 */
function buildSettingsInput(opts = {}) {
  const isString = typeof opts === "string";
  const templatePath = isString ? opts : opts?.templatePath || TEMPLATE_PATH;
  const template = loadTemplate(templatePath);
  let criticalFiles = [];
  if (!isString && opts?.project) {
    criticalFiles = resolveProject({ project: opts.project }, opts.factoryRoot).profile.criticalFiles;
  }
  return { template, criticalFiles };
}

/**
 * Render + write the cage into a worktree. Returns the settings path.
 * Throws on a mis-anchored or non-fail-closed result — a broken cage must never
 * be written to disk and then trusted.
 *
 * @param {string} worktreeAbs
 * @param {string|{templatePath?: string, project?: string, factoryRoot?: string}} [opts] —
 *   a string is treated as `templatePath` for back-compat; an object loads the
 *   profile's Critical Files when `project` is given.
 */
export function writeCageSettings(worktreeAbs, opts = {}) {
  const { template, criticalFiles } = buildSettingsInput(opts);
  const sandboxEnabled = typeof opts === "object" && opts !== null && "sandboxEnabled" in opts
    ? opts.sandboxEnabled
    : machineSandboxEnabled();
  const settings = renderCageSettings(template, worktreeAbs, { criticalFiles, sandboxEnabled });
  const problems = auditCageSettings(settings);
  if (problems.length > 0) throw new Error(`refusing to write a broken cage:\n- ${problems.join("\n- ")}`);
  const out = cageSettingsPath(worktreeAbs);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(settings, null, 2)}\n`);
  // The PreToolUse hook the settings reference — rendered fresh so a seat cannot
  // carry a weakened copy forward (same discipline as the settings themselves).
  writeFileSync(cageHookPath(worktreeAbs), renderBashHook(worktreeAbs));
  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/cage-settings.mjs render <worktree> [--project <id>]\n" +
      "  node scripts/cage-settings.mjs print  <worktree> [--project <id>]\n",
  );
}

function main() {
  const argv = process.argv.slice(2);
  const [cmd, wt] = argv;
  if (!cmd || !wt || !["render", "print"].includes(cmd)) {
    usage();
    return 2;
  }
  const projectIdx = argv.indexOf("--project");
  const project = projectIdx !== -1 ? argv[projectIdx + 1] : undefined;
  const abs = path.resolve(wt);
  const { template, criticalFiles } = buildSettingsInput(project ? { project } : {});
  if (cmd === "print") {
    process.stdout.write(`${JSON.stringify(renderCageSettings(template, abs, { criticalFiles }), null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${writeCageSettings(abs, project ? { project } : {})}\n`);
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`cage-settings: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

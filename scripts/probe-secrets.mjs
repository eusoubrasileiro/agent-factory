#!/usr/bin/env node

/**
 * probe-secrets.mjs — assert a worktree's env files leak NO real parent secret.
 *
 * The W1 containment guarantee (`dispatch-worktree.sh --seat external`) is that
 * an external seat's `.env*` files contain only dummy values. This probe proves
 * that empirically: it reads the parent tree's real `.env`, extracts every value
 * longer than `--min-len` (default 12) chars, and scans the WHOLE worktree tree
 * (every file, not just names starting with `.env` — a secret pasted into a
 * scratch `notes.txt` is still a leak) for that exact value: assigned via
 * `KEY=value` (key attributed) or embedded anywhere else in the file's text
 * (key is `null`). A single match ⇒ a real secret leaked into the seat. Values
 * the seat legitimately carries (the dummy template's own values) are
 * subtracted first.
 *
 * It is a coordinator tool aimed at EXTERNAL worktrees. Pointed at a normal
 * (claude) worktree it will (correctly) report hits, because those symlink the
 * real `.env` on purpose.
 *
 * Usage:
 *   node scripts/probe-secrets.mjs <worktree-dir> [--parent <dir>] [--project <id>] [--min-len <n>]
 *
 * `--project <id>` names the profile whose `seat.env` holds the known-dummy values
 * subtracted from the parent secret set. Omitted → the sole profile, when there is one.
 *
 * Exit codes:
 *   0 no real parent-secret value found in the worktree's env files (clean)
 *   1 at least one real secret value leaked
 *   2 precondition failure (parent .env missing — the leak scan could not run) /
 *     usage error / worktree missing
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/is-main.mjs";
import { resolveProject } from "./lib/project.mjs";

const DEFAULT_MIN_LEN = 12;

// ─── Pure core (unit-tested) ─────────────────────────────────────────────────

/**
 * Parse a dotenv-format text into `{ key, value }` pairs (quotes stripped).
 * Comments and blank lines are skipped.
 * @param {string} envText
 * @returns {{ key: string, value: string }[]}
 */
export function parseEnv(envText) {
  const out = [];
  for (const raw of envText.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    // Strip a matching pair of surrounding quotes.
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))
    ) {
      value = value.slice(1, -1);
    }
    out.push({ key: line.slice(0, eq).trim(), value });
  }
  return out;
}

/**
 * Extract candidate secret VALUES from a dotenv-format text: every value, quotes
 * stripped, whose length exceeds `minLen`. Short/common values (ports, a project
 * name, `test`) fall below the length floor and are never treated as secrets.
 * @param {string} envText
 * @param {number} minLen
 * @returns {string[]}
 */
export function extractSecrets(envText, minLen = DEFAULT_MIN_LEN) {
  return parseEnv(envText)
    .map((e) => e.value)
    .filter((v) => v.length > minLen);
}

/**
 * Find real parent secrets that leaked into a seat's env files.
 *
 * A leak is a worktree env value that (a) is longer than `minLen`, (b) EXACTLY
 * matches a real parent-`.env` value, and (c) is NOT one of the known-dummy
 * values the external seat legitimately carries (`dummyValues` — the checked-in
 * template's values).
 *
 * Exact-value (not substring) match is deliberate: the external seat's per-agent
 * `DATABASE_URL` shares a harmless local-dev prefix
 * (`postgresql://<user>:<pw>@localhost:<port>/`) with the parent's, differing only
 * in the database name, so a substring test would false-positive on it. A real
 * leaked secret is copied verbatim, so exact match catches every genuine exposure
 * while ignoring the shared prefix.
 * `dummyValues` subtraction ignores non-secret config the seat and parent share
 * on purpose (e.g. a `http://localhost:3000` BASE_URL).
 *
 * @param {{ file: string, text: string }[]} worktreeFiles
 * @param {string[]} parentSecrets — values from the parent's real .env
 * @param {string[]} [dummyValues] — known-safe values the seat is meant to carry
 * @param {number} [minLen]
 * @returns {{ file: string, key: string, secret: string }[]}
 */
export function findLeaks(
  worktreeFiles,
  parentSecrets,
  dummyValues = [],
  minLen = DEFAULT_MIN_LEN,
) {
  const dummy = new Set(dummyValues);
  const real = new Set(parentSecrets.filter((v) => v.length > minLen && !dummy.has(v)));
  const hits = [];
  for (const { file, text } of worktreeFiles) {
    for (const { key, value } of parseEnv(text)) {
      if (real.has(value)) hits.push({ file, key, secret: value });
    }
  }
  return hits;
}

/**
 * Find real parent secrets that leaked ANYWHERE in a worktree tree — not just
 * files named `.env*`. A leak copied into a plain scratch file (`notes.txt`, a
 * log, a doc) is still a leak, and the old `.env*`-only scan walked right past
 * it. Two passes per file: first `findLeaks`'s dotenv `KEY=value` detection
 * (key attributed), then — for every real secret NOT already caught that way —
 * a plain substring search of the raw text (key is `null`: the value appeared,
 * but not as a recognizable assignment). A value caught by both passes is
 * reported once, not twice.
 *
 * @param {{ file: string, text: string }[]} files
 * @param {string[]} parentSecrets — values from the parent's real .env
 * @param {string[]} [dummyValues] — known-safe values the seat is meant to carry
 * @param {number} [minLen]
 * @returns {{ file: string, key: string|null, secret: string }[]}
 */
export function findTreeLeaks(files, parentSecrets, dummyValues = [], minLen = DEFAULT_MIN_LEN) {
  const dummy = new Set(dummyValues);
  const real = [...new Set(parentSecrets.filter((v) => v.length > minLen && !dummy.has(v)))];
  const hits = [];
  for (const { file, text } of files) {
    const assigned = findLeaks([{ file, text }], real, [], minLen);
    hits.push(...assigned);
    const assignedValues = new Set(assigned.map((h) => h.secret));
    for (const secret of real) {
      if (assignedValues.has(secret)) continue;
      if (text.includes(secret)) hits.push({ file, key: null, secret });
    }
  }
  return hits;
}

// ─── IO shell ────────────────────────────────────────────────────────────────

/** Resolve the parent (main-worktree) root for a dispatched worktree. */
function resolveParentRoot(worktreeDir) {
  const res = spawnSync("git", ["-C", worktreeDir, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (res.status === 0 && res.stdout.trim()) {
    const commonDir = res.stdout.trim();
    const abs = path.isAbsolute(commonDir) ? commonDir : path.resolve(worktreeDir, commonDir);
    return path.resolve(abs, "..");
  }
  // Fallback: <root>/.claude/worktrees/<slug> → up 3.
  return path.resolve(worktreeDir, "..", "..", "..");
}

/** Directories never worth scanning: history/noise, not seat-carried secrets. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Recursively collect `{ file, text }` for every regular file under `rootDir`,
 * `file` relative to `rootDir`. Skips `.git` and `node_modules` (history and
 * third-party code, not something the seat itself wrote). An unreadable entry
 * (dangling symlink, permission error) is skipped — nothing to leak from it.
 * @param {string} rootDir
 * @returns {{ file: string, text: string }[]}
 */
export function walkTreeFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        try {
          out.push({ file: path.relative(rootDir, full), text: readFileSync(full, "utf8") });
        } catch {
          // unreadable / dangling symlink — nothing to leak from it
        }
      }
    }
  };
  walk(rootDir);
  return out;
}

/**
 * Load the known-dummy values the external seat legitimately carries, from the
 * active project's profile (`projects/<id>/seat.env`).
 *
 * These are subtracted from the parent's secret set so a value the seat and the
 * parent share ON PURPOSE (a `http://localhost:3000` BASE_URL, a 32-char dummy
 * JWT_SECRET) is never reported as a leak.
 *
 * History, so nobody re-introduces it: this used to read
 * `path.join(__dirname, "templates", "external-seat.env")` — but `__dirname` is
 * `scripts/`, so it pointed at `scripts/templates/external-seat.env`, a path that
 * has never existed at any commit. The `existsSync` guard turned that into a
 * silent `[]`, so the subtraction was dead from the day it was written and no
 * test noticed. It survives only because no dummy value currently collides with a
 * real parent value. The moment one does, a clean external dispatch would be
 * blocked by a false "LEAK". Hence: resolve through the profile, and test it.
 *
 * A profile with no `seat.env` (an engine-only project) legitimately yields `[]`.
 *
 * @param {string} [project] — profile id; omitted → the sole profile, when there is one
 * @param {string} [factoryRoot]
 * @returns {string[]}
 */
export function loadDummyValues(project, factoryRoot) {
  const { profile } = resolveProject({ project }, factoryRoot);
  const seatEnv = profile?.seatEnvPath;
  if (!seatEnv || !existsSync(seatEnv)) return [];
  return parseEnv(readFileSync(seatEnv, "utf8")).map((e) => e.value);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let parent;
  let project;
  let minLen = DEFAULT_MIN_LEN;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--parent") parent = args[++i];
    else if (args[i] === "--project") project = args[++i];
    else if (args[i] === "--min-len") minLen = Number(args[++i]);
    else positional.push(args[i]);
  }
  return { worktree: positional[0], parent, project, minLen };
}

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/probe-secrets.mjs <worktree-dir> [--parent <dir>] [--project <id>] [--min-len <n>]\n" +
      "  exit 0 clean · 1 leak found · 2 precondition failure (no parent .env) / usage error\n",
  );
}

function main() {
  const { worktree, parent, project, minLen } = parseArgs(process.argv);
  if (!worktree || Number.isNaN(minLen)) {
    usage();
    return 2;
  }
  const worktreeDir = path.resolve(worktree);
  if (!existsSync(worktreeDir)) {
    process.stderr.write(`worktree not found: ${worktreeDir}\n`);
    return 2;
  }

  const parentRoot = parent ? path.resolve(parent) : resolveParentRoot(worktreeDir);
  const parentEnv = path.join(parentRoot, ".env");
  if (!existsSync(parentEnv)) {
    // The comparison base is missing, so the leak scan never ran. "clean" is
    // reserved for "compared, and nothing leaked" — a missing base is a
    // precondition failure, not a clean bill of health. A seat holding a
    // genuinely leaked secret would otherwise certify clean (the fail-open).
    process.stderr.write(
      `probe-secrets: no parent .env at ${parentEnv} — could not compare ` +
        `(point --parent <dir> at a root with a real .env)\n`,
    );
    return 2;
  }

  const secrets = extractSecrets(readFileSync(parentEnv, "utf8"), minLen);
  const dummyValues = loadDummyValues(project);
  const worktreeFiles = walkTreeFiles(worktreeDir);
  const hits = findTreeLeaks(worktreeFiles, secrets, dummyValues, minLen);

  if (hits.length > 0) {
    process.stderr.write(
      `LEAK: ${hits.length} real parent-secret value(s) found in ${worktreeDir}:\n`,
    );
    for (const { file, key, secret } of hits) {
      // Never echo the full secret — show the key + a short prefix only.
      const keyLabel = key ?? "(embedded, no KEY=VALUE)";
      process.stderr.write(`  ${file}: ${keyLabel} = parent secret "${secret.slice(0, 6)}…"\n`);
    }
    return 1;
  }

  process.stdout.write(
    `clean: 0 of ${secrets.length} parent secret(s) leaked across ${worktreeFiles.length} file(s) scanned in ${worktreeDir}\n`,
  );
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  process.exit(main());
}

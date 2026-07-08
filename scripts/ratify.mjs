#!/usr/bin/env node
/**
 * Factory ratification recorder.
 *
 * Records a human ratification ON DISK — the canonical gate that moves a
 * mission's card to `Done` (`factory/missions/<slug>/RATIFIED`). Refuses to
 * ratify without a green last verdict (`validate.log` ending in PASS): a
 * constitution violation rather than a convenience, overridable only with
 * `--force`. Idempotent — a second run on an already-ratified mission is a
 * no-op exit 0. Best-effort triggers `board-sync.mjs` so the card follows.
 *
 * Usage:
 *   node scripts/factory/ratify.mjs <slug>           # record ratification
 *   node scripts/factory/ratify.mjs <slug> --force   # override the PASS gate
 *
 * Optional `--dir <path>` overrides the missions root (default factory/missions).
 *
 * Exit codes:
 *   0 ratified (or already ratified) · 1 unknown slug / no green verdict · 2 usage
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { autoCommit } from "./git-autocommit.mjs";
import { resolveProject } from "./lib/project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Storage ─────────────────────────────────────────────────────────────────

function missionDir(root, slug) {
  return path.join(root, slug);
}

function missionExists(root, slug) {
  const dir = missionDir(root, slug);
  return existsSync(dir) && statSync(dir).isDirectory();
}

function ratifiedPath(root, slug) {
  return path.join(missionDir(root, slug), "RATIFIED");
}

function logPath(root, slug) {
  return path.join(missionDir(root, slug), "validate.log");
}

/**
 * Last well-formed verdict record in a JSONL `validate.log`, or null.
 * Malformed lines are skipped, never thrown — mirrors board-sync.mjs.
 * @returns {{ round: number, verdict: string } | null}
 */
function lastVerdict(root, slug) {
  const p = logPath(root, slug);
  if (!existsSync(p)) return null;
  let last = null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && (obj.verdict === "PASS" || obj.verdict === "FAIL")) {
      last = obj;
    }
  }
  return last;
}

// ─── Board sync hook (soft-fail) ─────────────────────────────────────────────

/**
 * Best-effort trigger of the board projector after ratification. Never throws,
 * never prints, never touches the caller's exit code — a missing or broken
 * `board-sync.mjs` (or a repo with no `backlog/`) must leave ratification
 * completely unaffected.
 */
function syncBoard(root, slug, repoRoot) {
  try {
    const boardSyncPath = fileURLToPath(new URL("./board-sync.mjs", import.meta.url));
    if (!existsSync(boardSyncPath)) return;
    // Pass the resolved product repo so board-sync targets the right backlog
    // instead of re-deriving (post-extraction the roots are separate trees).
    const extra = repoRoot ? ["--repo", repoRoot] : [];
    spawnSync(process.execPath, [boardSyncPath, slug, "--dir", root, ...extra], { stdio: "ignore" });
  } catch {
    // soft-fail: board sync must never affect ratification
  }
}

/**
 * Best-effort recompute of the mission's stats.json at ratify time
 * (factory-metrics W3). Never throws, never prints, never touches the caller's
 * exit code. The `agent/<slug>` branch may already be merged+deleted here, so
 * mission-stats falls back to the merge commit to recover LOC.
 */
function collectStats(root, slug, repoRoot) {
  try {
    const statsPath = fileURLToPath(new URL("./mission-stats.mjs", import.meta.url));
    if (!existsSync(statsPath)) return;
    const extra = repoRoot ? ["--repo", repoRoot] : [];
    spawnSync(process.execPath, [statsPath, "collect", slug, "--dir", root, ...extra], {
      stdio: "ignore",
    });
  } catch {
    // soft-fail: stats collection must never affect ratification
  }
}

/**
 * Fire-and-forget trigger of the autopublish funnel (factory-live-board A2).
 * Detached + unref so it never blocks the caller and never affects its exit
 * code. Mirrors syncBoard's soft-fail philosophy. Loop-safe by construction:
 * autopublish makes no commits, so this spawn can never re-fire post-commit.
 */
function triggerAutopublish() {
  try {
    // Test-isolation guard: pnpm test:factory sets FACTORY_AUTOPUBLISH=0 so
    // recorders exercised by tests never publish the real board (or pollute
    // factory/history.jsonl) as a side effect.
    if (process.env.FACTORY_AUTOPUBLISH === "0") return;
    const autopublishPath = fileURLToPath(new URL("./board-autopublish.mjs", import.meta.url));
    if (!existsSync(autopublishPath)) return;
    const child = spawn(process.execPath, [autopublishPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // soft-fail: autopublish must never affect ratification
  }
}

// ─── Command ─────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ratify(root, slug, force, repoRoot) {
  if (!missionExists(root, slug)) {
    process.stderr.write(`unknown mission slug: ${slug}\n`);
    return 1;
  }

  const rPath = ratifiedPath(root, slug);
  if (existsSync(rPath)) {
    process.stdout.write(`${slug}: already ratified — no-op\n`);
    return 0;
  }

  const verdict = lastVerdict(root, slug);
  const green = verdict?.verdict === "PASS";
  if (!green && !force) {
    const reason = verdict ? `last verdict is ${verdict.verdict}` : "no validate.log";
    process.stderr.write(
      `${slug}: refusing to ratify — ${reason}; ratification requires a PASS verdict ` +
        `(use --force to override)\n`,
    );
    return 1;
  }

  writeFileSync(rPath, `ratified ${today()}\n`);
  syncBoard(root, slug, repoRoot);
  collectStats(root, slug, repoRoot);
  autoCommit(root, slug, `chore(factory): ratify ${slug}`);
  triggerAutopublish();
  process.stdout.write(`${slug}: ratified ${today()}\n`);
  return 0;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/factory/ratify.mjs <slug>           # record ratification\n" +
      "  node scripts/factory/ratify.mjs <slug> --force   # override the PASS gate\n" +
      "  (optional --dir <path> overrides the missions root)\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let dir;
  let project;
  let repo;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") {
      dir = args[++i];
    } else if (args[i] === "--project") {
      project = args[++i];
    } else if (args[i] === "--repo") {
      repo = args[++i];
    } else if (args[i] === "--force") {
      force = true;
    } else {
      positional.push(args[i]);
    }
  }
  return { slug: positional[0], dir, project, repo, force };
}

async function main() {
  const { slug, dir, project, repo, force } = parseArgs(process.argv);
  if (!slug) {
    usage();
    return 2;
  }
  const resolved = resolveProject({ project, dir, repo });
  return ratify(resolved.missionsRoot, slug, force, resolved.repoRoot);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err?.message ?? err}\n`);
      process.exit(1);
    });
}

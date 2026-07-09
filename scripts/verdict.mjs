#!/usr/bin/env node
/**
 * Factory verdict recorder.
 *
 * Turns a validator's PASS/FAIL judgment from prose into a schema-locked,
 * code-bounded artifact: one JSONL line per round in
 * `factory/missions/<slug>/validate.log`, with the 3-round fix bound (HG-6)
 * enforced here in code — not left to an agent to remember.
 *
 * Usage:
 *   node scripts/factory/verdict.mjs record <slug>   # read one verdict JSON from stdin, append it
 *   node scripts/factory/verdict.mjs status <slug>   # print rounds used / last verdict / red ids
 *
 * Optional `--dir <path>` overrides the missions root (default factory/missions).
 *
 * Exit codes:
 *   record: 0 recorded · 1 malformed/schema/gap/unknown-slug · 2 round bound exhausted (no write)
 *   status: 0 last=PASS · 1 last=FAIL or no rounds · 2 exhausted (3 rounds all FAIL)
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { autoCommit } from "./git-autocommit.mjs";
import { resolveProject } from "./lib/project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Max fix rounds before the loop must escalate to the owner (HG-6). */
export const MAX_ROUNDS = 3;

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Validate one verdict object against the recorder schema.
 * @param {unknown} obj — parsed verdict
 * @param {string} [expectedSlug] — when given, `obj.slug` must equal it
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateVerdict(obj, expectedSlug) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, reason: "verdict must be a JSON object" };
  }
  if (typeof obj.slug !== "string" || obj.slug.length === 0) {
    return { ok: false, reason: "slug must be a non-empty string" };
  }
  if (expectedSlug !== undefined && obj.slug !== expectedSlug) {
    return { ok: false, reason: `slug "${obj.slug}" does not match CLI slug "${expectedSlug}"` };
  }
  if (!Number.isInteger(obj.round) || obj.round < 1) {
    return { ok: false, reason: "round must be an integer >= 1" };
  }
  if (obj.verdict !== "PASS" && obj.verdict !== "FAIL") {
    return { ok: false, reason: 'verdict must be "PASS" or "FAIL"' };
  }
  if (!Array.isArray(obj.assertions) || obj.assertions.length === 0) {
    return { ok: false, reason: "assertions must be a non-empty array" };
  }
  for (let i = 0; i < obj.assertions.length; i++) {
    const a = obj.assertions[i];
    if (a === null || typeof a !== "object" || Array.isArray(a)) {
      return { ok: false, reason: `assertions[${i}] must be an object` };
    }
    if (typeof a.id !== "string" || a.id.length === 0) {
      return { ok: false, reason: `assertions[${i}].id must be a non-empty string` };
    }
    if (a.status !== "green" && a.status !== "red") {
      return { ok: false, reason: `assertions[${i}].status must be "green" or "red"` };
    }
    if (typeof a.proof !== "string" || a.proof.length === 0) {
      return { ok: false, reason: `assertions[${i}].proof must be a non-empty string` };
    }
    if (a.expected !== undefined && typeof a.expected !== "string") {
      return { ok: false, reason: `assertions[${i}].expected must be a string when present` };
    }
    if (a.actual !== undefined && typeof a.actual !== "string") {
      return { ok: false, reason: `assertions[${i}].actual must be a string when present` };
    }
  }
  if (typeof obj.escalate !== "boolean") {
    return { ok: false, reason: "escalate must be a boolean" };
  }
  if (obj.notes !== undefined && typeof obj.notes !== "string") {
    return { ok: false, reason: "notes must be a string when present" };
  }

  // Consistency rules between verdict and assertions.
  const allGreen = obj.assertions.every((a) => a.status === "green");
  const anyRed = obj.assertions.some((a) => a.status === "red");
  if (obj.verdict === "PASS") {
    if (!allGreen) return { ok: false, reason: "verdict PASS requires every assertion green" };
    if (obj.escalate !== false)
      return { ok: false, reason: "verdict PASS requires escalate=false" };
  } else if (!anyRed) {
    return { ok: false, reason: "verdict FAIL requires at least one red assertion" };
  }

  return { ok: true };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function missionDir(root, slug) {
  return path.join(root, slug);
}

function logPath(root, slug) {
  return path.join(missionDir(root, slug), "validate.log");
}

function missionExists(root, slug) {
  const dir = missionDir(root, slug);
  return existsSync(dir) && statSync(dir).isDirectory();
}

function readRecords(root, slug) {
  const p = logPath(root, slug);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// ─── Board sync hook (soft-fail, M-07) ─────────────────────────────────────────

/**
 * Best-effort trigger of the board projector after a verdict is recorded.
 * Never throws, never prints, never touches the caller's exit code — a missing
 * or broken `board-sync.mjs` (or a repo with no `backlog/`) must leave verdict
 * recording completely unaffected.
 */
function syncBoard(root, slug, repoRoot) {
  try {
    const boardSyncPath = fileURLToPath(new URL("./board-sync.mjs", import.meta.url));
    if (!existsSync(boardSyncPath)) return;
    // Post-extraction: missions-root (factory) and the product repo (where the
    // backlog/ kanban lives) are separate trees — pass both so board-sync
    // targets the right repo instead of re-deriving from the missions root.
    const extra = repoRoot ? ["--repo", repoRoot] : [];
    spawnSync(process.execPath, [boardSyncPath, slug, "--dir", root, ...extra], { stdio: "ignore" });
  } catch {
    // soft-fail: board sync must never affect verdict recording
  }
}

/**
 * Best-effort recompute of the mission's stats.json after a verdict is
 * recorded (factory-metrics W3). Never throws, never prints, never touches the
 * caller's exit code — mirrors syncBoard's soft-fail philosophy. The branch is
 * still live at verdict time, so LOC/tests are collected from it directly.
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
    // soft-fail: stats collection must never affect verdict recording
  }
}

/**
 * Best-effort projection of the mission onto a product-repo PR (factory-pr-record
 * W4). `open` is idempotent, so it is safe to call on every round: the first
 * verdict (PASS *or* FAIL) opens the draft PR, and every round is then posted as
 * a comment, giving the PR the full validate→fix timeline. Never throws, never
 * touches the caller's exit code — disk stays canonical, GitHub is a projection.
 *
 * OPT-IN: inert unless FACTORY_PR=1, because `open` pushes `agent/<slug>` to the
 * product remote. Guarded here too so tests never even spawn the child.
 */
function projectPr(root, slug, repoRoot, subcommand) {
  try {
    if (process.env.FACTORY_PR !== "1") return;
    const prPath = fileURLToPath(new URL("./pr-record.mjs", import.meta.url));
    if (!existsSync(prPath)) return;
    const extra = repoRoot ? ["--repo", repoRoot] : [];
    spawnSync(process.execPath, [prPath, subcommand, slug, "--dir", root, ...extra], {
      stdio: "ignore",
    });
  } catch {
    // soft-fail: the PR projection must never affect verdict recording
  }
}

/**
 * Fire-and-forget trigger of the autopublish funnel (factory-live-board A2).
 * Detached + unref so it never blocks the caller and never affects its exit
 * code. Mirrors syncBoard's soft-fail philosophy — a missing or broken
 * board-autopublish.mjs leaves verdict recording completely unaffected.
 * Loop-safe by construction: autopublish makes no commits, so this spawn can
 * never re-fire post-commit recursively (see board-autopublish.mjs header).
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
    // soft-fail: autopublish must never affect verdict recording
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdRecord(root, slug, repoRoot) {
  if (!missionExists(root, slug)) {
    process.stderr.write(`unknown mission slug: ${slug}\n`);
    return 1;
  }

  let obj;
  try {
    obj = JSON.parse(await readStdin());
  } catch {
    process.stderr.write("malformed JSON on stdin\n");
    return 1;
  }

  const check = validateVerdict(obj, slug);
  if (!check.ok) {
    process.stderr.write(`${check.reason}\n`);
    return 1;
  }

  // Round bound (HG-6): refuse anything past the 3rd round without writing.
  if (obj.round > MAX_ROUNDS) {
    process.stderr.write(`${MAX_ROUNDS} fix rounds exhausted — STOP, escalate to the owner\n`);
    return 2;
  }

  // Rounds are sequential: round N is only valid when N-1 are already logged.
  const existing = readRecords(root, slug);
  if (existing.length !== obj.round - 1) {
    process.stderr.write(
      `round mismatch: log has ${existing.length} round(s); next must be round ${
        existing.length + 1
      }, got ${obj.round}\n`,
    );
    return 1;
  }

  // Stamp the record time (factory-live-board A1). validateVerdict tolerates
  // an optional input `ts` but never requires it; we always overwrite at record
  // time so the log is the source of truth for when each round landed.
  obj.ts = new Date().toISOString();
  appendFileSync(logPath(root, slug), `${JSON.stringify(obj)}\n`);
  syncBoard(root, slug, repoRoot);
  collectStats(root, slug, repoRoot);
  // Order matters: stats.json and validate.log are both on disk by now, so the
  // PR body/comment render the round that was just recorded.
  projectPr(root, slug, repoRoot, "open");
  projectPr(root, slug, repoRoot, "comment");
  autoCommit(root, slug, `chore(factory): verdict ${slug} round ${obj.round} ${obj.verdict}`);
  triggerAutopublish();
  process.stdout.write(
    `recorded round ${obj.round} verdict=${obj.verdict} for ${slug} (${obj.assertions.length} assertion(s))\n`,
  );
  return 0;
}

function cmdStatus(root, slug) {
  if (!missionExists(root, slug)) {
    process.stderr.write(`unknown mission slug: ${slug}\n`);
    return 1;
  }

  const records = readRecords(root, slug);
  const rounds = records.length;
  if (rounds === 0) {
    process.stdout.write(`${slug}: 0/${MAX_ROUNDS} rounds — no verdict recorded yet\n`);
    return 1;
  }

  const last = records[rounds - 1];
  const redIds = last.assertions.filter((a) => a.status === "red").map((a) => a.id);
  const redStr = redIds.length ? redIds.join(", ") : "none";
  const exhausted =
    last.verdict === "FAIL" && rounds >= MAX_ROUNDS && records.every((r) => r.verdict === "FAIL");
  const tag =
    last.verdict === "PASS" ? "PASS" : exhausted ? "FAIL (EXHAUSTED — escalate to owner)" : "FAIL";
  process.stdout.write(`${slug}: ${rounds}/${MAX_ROUNDS} rounds · last=${tag} · red=[${redStr}]\n`);

  if (last.verdict === "PASS") return 0;
  if (exhausted) return 2;
  return 1;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/factory/verdict.mjs record <slug>   # append one verdict from stdin\n" +
      "  node scripts/factory/verdict.mjs status <slug>   # print rounds / last verdict / red ids\n" +
      "  (optional --dir <path> overrides the missions root)\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let dir;
  let project;
  let repo;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") {
      dir = args[i + 1];
      i++;
    } else if (args[i] === "--project") {
      project = args[i + 1];
      i++;
    } else if (args[i] === "--repo") {
      repo = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }
  return { cmd: positional[0], slug: positional[1], dir, project, repo };
}

async function main() {
  const { cmd, slug, dir, project, repo } = parseArgs(process.argv);
  const resolved = resolveProject({ project, dir, repo });
  const root = resolved.missionsRoot;
  if (!cmd || !slug) {
    usage();
    return 2;
  }
  if (cmd === "record") return cmdRecord(root, slug, resolved.repoRoot);
  if (cmd === "status") return cmdStatus(root, slug);
  usage();
  return 2;
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

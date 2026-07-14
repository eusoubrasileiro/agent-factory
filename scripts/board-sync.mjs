#!/usr/bin/env node
/**
 * Factory board projector.
 *
 * One-way, idempotent projection of the factory's disk state onto the
 * Backlog.md kanban: for each mission dir under `factory/missions/<slug>/`
 * it derives a column from the files present (`deriveMissionState`, pure) and
 * moves the mission's card there, creating the card if absent. The board is a
 * read-model — nothing here ever writes back into a mission dir.
 *
 * Card ⇄ mission join: the card title IS the mission slug; every mission card
 * carries the `mission` label plus, when the derived state waits on a human,
 * one gate label (`gate:ratify` | `gate:escalated` | `gate:approve-plan`).
 *
 * Usage:
 *   node scripts/factory/board-sync.mjs [slug] [--dir <missions-root>] [--repo <repo-root>]
 *
 * `--dir` overrides the missions root (default factory/missions); `--repo`
 * overrides the repo root whose `backlog/` the CLI edits (default: the missions
 * root's grandparent). A bare `slug` limits the sync to that one mission.
 *
 * Exit codes:
 *   0 ok (WIP warnings still exit 0) · 1 unexpected error · 2 usage
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
import { FACTORY_ROOT, resolveProject } from "./lib/project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** WIP ceilings — breaching either warns (stderr) but never fails the sync. */
const WIP_NEEDS_HUMAN = 5;
const WIP_IN_FLIGHT = 3; // Building + Validating

const GATE = {
  ratify: "gate:ratify",
  escalated: "gate:escalated",
  approvePlan: "gate:approve-plan",
};
const ALL_GATES = new Set(Object.values(GATE));

// ─── Derivation (pure) ─────────────────────────────────────────────────────────

/** Feature spec `NN.md` (not a `NN.handoff.md`). */
const FEATURE_RE = /^(\d+)\.md$/;
const HANDOFF_RE = /^(\d+)\.handoff\.md$/;

function has(dir, name) {
  return existsSync(path.join(dir, name));
}

/**
 * Last well-formed verdict record in a JSONL `validate.log`, or null.
 * Malformed lines are skipped, never thrown — real logs are messy.
 * @returns {{ round: number, verdict: string } | null}
 */
function lastVerdict(dir) {
  const p = path.join(dir, "validate.log");
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

/** Feature spec ids and the set of ids that already have a handoff. */
function featureStatus(dir) {
  const featuresDir = path.join(dir, "features");
  if (!existsSync(featuresDir)) return { specs: [], handoffs: new Set() };
  const specs = [];
  const handoffs = new Set();
  for (const name of readdirSync(featuresDir)) {
    const spec = name.match(FEATURE_RE);
    if (spec) {
      specs.push(spec[1]);
      continue;
    }
    const handoff = name.match(HANDOFF_RE);
    if (handoff) handoffs.add(handoff[1]);
  }
  return { specs, handoffs };
}

/**
 * Derive a board column from a mission dir. First match wins, top to bottom.
 * @param {string} missionDirPath
 * @returns {{ status: string, gateReason: string|null }}
 */
export function deriveMissionState(missionDirPath) {
  const dir = missionDirPath;

  // PARKED (lanes-legibility B3): an explicit "shelved / wont-do" marker lifts the
  // mission out of every active lane into the collapsed "Estacionado" section. It
  // is the strongest human signal here, so it is weighed before BLOCKED/RATIFIED —
  // a parked mission stops squatting in Needs Human / Building regardless of what
  // else its dossier claims. Any content counts (the marker is the message).
  if (has(dir, "PARKED")) return { status: "Parked", gateReason: null };
  if (has(dir, "BLOCKED")) return { status: "Blocked", gateReason: null };
  if (has(dir, "RATIFIED")) return { status: "Done", gateReason: null };

  const verdict = lastVerdict(dir);
  if (verdict) {
    if (verdict.verdict === "PASS") {
      return { status: "Needs Human", gateReason: GATE.ratify };
    }
    // FAIL
    if (Number.isInteger(verdict.round) && verdict.round >= 3) {
      return { status: "Needs Human", gateReason: GATE.escalated };
    }
    return { status: "Validating", gateReason: null };
  }

  if (has(dir, "APPROVED")) {
    const { specs, handoffs } = featureStatus(dir);
    if (specs.length > 0 && specs.every((id) => handoffs.has(id))) {
      return { status: "Validating", gateReason: null };
    }
    return { status: "Building", gateReason: null };
  }

  if (has(dir, "brief.md") && has(dir, "contract.md")) {
    return { status: "Needs Human", gateReason: GATE.approvePlan };
  }
  if (has(dir, "brief.md")) return { status: "Planning", gateReason: null };

  return { status: "Intake", gateReason: null };
}

// ─── Backlog CLI parsing (pure) ────────────────────────────────────────────────

/**
 * Parse `backlog task list --plain` into rows.
 * Output groups tasks under a `<Status>:` header, each task line indented as
 * `  <ID> - <title>`.
 * @param {string} stdout
 * @returns {Array<{ id: string, title: string, status: string }>}
 */
export function parseTaskList(stdout) {
  const rows = [];
  let status = null;
  for (const line of (stdout ?? "").split("\n")) {
    const header = line.match(/^(\S.*):\s*$/);
    if (header) {
      status = header[1].trim();
      continue;
    }
    const task = line.match(/^\s+(\S+)\s-\s(.+?)\s*$/);
    if (task && status) {
      rows.push({ id: task[1], title: task[2], status });
    }
  }
  return rows;
}

/**
 * Parse the `Labels: a, b, c` line out of `backlog task <id> --plain`.
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseLabels(stdout) {
  for (const line of (stdout ?? "").split("\n")) {
    const m = line.match(/^Labels:\s*(.+?)\s*$/);
    if (m) {
      return m[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }
  return [];
}

/** Desired label set for a derived state: `mission` plus at most one gate. */
function desiredLabels(gateReason) {
  return gateReason ? ["mission", gateReason] : ["mission"];
}

/** The single `gate:*` label in a set, or null. */
function gateOf(labels) {
  return labels.find((l) => ALL_GATES.has(l)) ?? null;
}

// ─── Backlog CLI (effects) ─────────────────────────────────────────────────────

function resolveBacklogBin() {
  if (process.env.BACKLOG_BIN) return process.env.BACKLOG_BIN;
  const local = path.join(FACTORY_ROOT, "node_modules", ".bin", "backlog");
  if (existsSync(local)) return local;
  return "backlog";
}

function makeBacklog(repoRoot) {
  const bin = resolveBacklogBin();
  return (args) => {
    const r = spawnSync(bin, args, { cwd: repoRoot, encoding: "utf8" });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      throw new Error(
        `backlog ${args.join(" ")} exited ${r.status}: ${r.stderr || r.stdout}`,
      );
    }
    return r;
  };
}

// ─── Sync ──────────────────────────────────────────────────────────────────────

function listMissionDirs(missionsRoot, onlySlug) {
  if (!existsSync(missionsRoot)) return [];
  if (onlySlug) {
    const dir = path.join(missionsRoot, onlySlug);
    return existsSync(dir) && statSync(dir).isDirectory() ? [onlySlug] : [];
  }
  return readdirSync(missionsRoot).filter((name) =>
    statSync(path.join(missionsRoot, name)).isDirectory(),
  );
}

/**
 * Project the missions onto the board. Returns `{ moves, columns }`.
 * @param {string} missionsRoot
 * @param {string} repoRoot
 * @param {string|undefined} onlySlug
 * @param {(line: string) => void} emit — one line per move
 */
function sync(missionsRoot, repoRoot, onlySlug, emit) {
  const backlog = makeBacklog(repoRoot);
  const slugs = listMissionDirs(missionsRoot, onlySlug);

  const byTitle = new Map();
  for (const card of parseTaskList(backlog(["task", "list", "--plain"]).stdout)) {
    byTitle.set(card.title, card);
  }

  for (const slug of slugs) {
    const derived = deriveMissionState(path.join(missionsRoot, slug));
    const labels = desiredLabels(derived.gateReason);
    const card = byTitle.get(slug);

    if (!card) {
      backlog(["task", "create", slug, "-s", derived.status, "-l", labels.join(",")]);
      emit(`${slug}: (new) -> ${derived.status}`);
      continue;
    }

    const currentGate = gateOf(parseLabels(backlog(["task", card.id, "--plain"]).stdout));
    const statusChanged = card.status !== derived.status;
    const gateChanged = currentGate !== derived.gateReason;
    if (statusChanged || gateChanged) {
      backlog(["task", "edit", card.id, "-s", derived.status, "-l", labels.join(",")]);
      if (statusChanged) emit(`${slug}: ${card.status} -> ${derived.status}`);
      else emit(`${slug}: gate ${currentGate ?? "none"} -> ${derived.gateReason ?? "none"}`);
    }
  }

  // Re-read for an accurate post-sync column census.
  const columns = {};
  for (const card of parseTaskList(backlog(["task", "list", "--plain"]).stdout)) {
    columns[card.status] = (columns[card.status] ?? 0) + 1;
  }
  return { columns };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/factory/board-sync.mjs [slug] [--dir <missions-root>] [--repo <repo-root>]\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let dir;
  let repo;
  let project;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") {
      dir = args[++i];
    } else if (args[i] === "--repo") {
      repo = args[++i];
    } else if (args[i] === "--project") {
      project = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { slug: positional[0], dir, repo, project };
}

function main() {
  const { slug, dir, repo, project } = parseArgs(process.argv);
  if (positionalOverflow(process.argv)) {
    usage();
    return 2;
  }

  const { missionsRoot, repoRoot } = resolveProject({ project, dir, repo });

  if (!existsSync(path.join(repoRoot, "backlog"))) {
    process.stdout.write(
      `no backlog/ under ${repoRoot} — skipping board sync (soft layer, run 'backlog init' to enable)\n`,
    );
    return 0;
  }

  const { columns } = sync(missionsRoot, repoRoot, slug, (line) =>
    process.stdout.write(`${line}\n`),
  );

  const needsHuman = columns["Needs Human"] ?? 0;
  const inFlight = (columns.Building ?? 0) + (columns.Validating ?? 0);
  if (needsHuman > WIP_NEEDS_HUMAN) {
    process.stderr.write(
      `WARN: WIP — ${needsHuman} missions in 'Needs Human' (limit ${WIP_NEEDS_HUMAN})\n`,
    );
  }
  if (inFlight > WIP_IN_FLIGHT) {
    process.stderr.write(
      `WARN: WIP — ${inFlight} missions in Building+Validating (limit ${WIP_IN_FLIGHT})\n`,
    );
  }
  return 0;
}

/** More than one bare positional arg is a usage error. */
function positionalOverflow(argv) {
  const args = argv.slice(2);
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" || args[i] === "--repo" || args[i] === "--project") i++;
    else positional++;
  }
  return positional > 1;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }
}

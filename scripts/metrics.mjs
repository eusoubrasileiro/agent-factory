#!/usr/bin/env node
/**
 * Factory telemetry recorder (v2 §3.4).
 *
 * The KPI ("attention-per-feature": human touchpoints + orchestrator
 * interventions + escalations, per shipped feature) is invisible unless
 * every seat emits events as they happen. This script is the append-only
 * instrument — one JSONL line per event in
 * `factory/missions/<slug>/metrics.jsonl`.
 *
 * Usage:
 *   node scripts/factory/metrics.mjs record <slug>    # read one event JSON from stdin, append it
 *   node scripts/factory/metrics.mjs summary <slug>    # print event counts by type + the attention figure
 *
 * Optional `--dir <path>` overrides the missions root (default factory/missions).
 *
 * Exit codes:
 *   record: 0 recorded · 1 malformed/schema/unknown-slug
 *   summary: 0 ok · 1 unknown-slug or no events
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
import { resolveProject } from "./lib/project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SEATS = new Set(["orchestrator", "worker", "validator", "human"]);
const TYPES = new Set([
  "escalation",
  "intervention",
  "touchpoint",
  "false_idle",
  "worker_death",
  "phase_start",
  "phase_end",
  // The deterministic gate's own verdict, recorded by the driver rather than
  // asserted by the seat. Its own type, not fields on phase_end: the log is
  // append-only (a gate run later could not amend an earlier row), and folding
  // gate time into phase_end's durationMs would corrupt the one clean per-seat
  // wall-clock number we have.
  "gate_result",
]);

/** Event types that count toward the attention-per-feature figure (v2 §3.4). */
const ATTENTION_TYPES = new Set(["touchpoint", "intervention", "escalation"]);

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Validate one event object against the recorder schema.
 * @param {unknown} obj — parsed event
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateEvent(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, reason: "event must be a JSON object" };
  }
  if (obj.ts !== undefined) {
    if (typeof obj.ts !== "string" || Number.isNaN(Date.parse(obj.ts))) {
      return { ok: false, reason: "ts must be an ISO8601 string when present" };
    }
  }
  if (typeof obj.seat !== "string" || !SEATS.has(obj.seat)) {
    return { ok: false, reason: `seat must be one of: ${[...SEATS].join(", ")}` };
  }
  if (typeof obj.type !== "string" || !TYPES.has(obj.type)) {
    return { ok: false, reason: `type must be one of: ${[...TYPES].join(", ")}` };
  }
  if (obj.detail !== undefined && typeof obj.detail !== "string") {
    return { ok: false, reason: "detail must be a string when present" };
  }
  if (obj.tokens !== undefined && typeof obj.tokens !== "number") {
    return { ok: false, reason: "tokens must be a number when present" };
  }
  if (obj.costUsd !== undefined && typeof obj.costUsd !== "number") {
    return { ok: false, reason: "costUsd must be a number when present" };
  }
  // ── Full-pipeline observability fields (factory-metrics W3, all OPTIONAL and
  //    backward-compatible — legacy tokens/costUsd still accepted above).
  if (obj.model !== undefined && typeof obj.model !== "string") {
    return { ok: false, reason: "model must be a string when present" };
  }
  if (obj.tokensIn !== undefined && typeof obj.tokensIn !== "number") {
    return { ok: false, reason: "tokensIn must be a number when present" };
  }
  if (obj.tokensOut !== undefined && typeof obj.tokensOut !== "number") {
    return { ok: false, reason: "tokensOut must be a number when present" };
  }
  // tokensReasoning is best-effort: some providers (e.g. z.ai) do not split it,
  // so `null` (explicit "unknown") is accepted alongside a number or absence.
  if (obj.tokensReasoning !== undefined && obj.tokensReasoning !== null) {
    if (typeof obj.tokensReasoning !== "number") {
      return { ok: false, reason: "tokensReasoning must be a number or null when present" };
    }
  }
  // Cache tokens (factory-cost Stage 1b): prompt-cache read/write are billed at
  // their own tiers (≈0.1× and ≈1.25× input), distinct from base input. Kept
  // first-class so cost attribution is accurate; legacy `tokens` folded them in.
  if (obj.tokensCacheRead !== undefined && typeof obj.tokensCacheRead !== "number") {
    return { ok: false, reason: "tokensCacheRead must be a number when present" };
  }
  if (obj.tokensCacheWrite !== undefined && typeof obj.tokensCacheWrite !== "number") {
    return { ok: false, reason: "tokensCacheWrite must be a number when present" };
  }
  // apiCostUsd: the public-API-basis cost (Anthropic-priced `total_cost_usd`
  // from claude -p). Real $ for Anthropic seats; the "equivalent" comparison
  // figure for flat-plan seats. Distinct from legacy `costUsd` (always 0).
  if (obj.apiCostUsd !== undefined && typeof obj.apiCostUsd !== "number") {
    return { ok: false, reason: "apiCostUsd must be a number when present" };
  }
  if (obj.durationMs !== undefined && typeof obj.durationMs !== "number") {
    return { ok: false, reason: "durationMs must be a number when present" };
  }
  // Run outcome. `null` is a first-class value meaning "unmeasured" (legacy rows,
  // or a caller that could not determine it) — distinct from a measured failure.
  if (obj.exitCode !== undefined && obj.exitCode !== null) {
    if (typeof obj.exitCode !== "number") {
      return { ok: false, reason: "exitCode must be a number or null when present" };
    }
  }
  if (obj.sawFinish !== undefined && obj.sawFinish !== null) {
    if (typeof obj.sawFinish !== "boolean") {
      return { ok: false, reason: "sawFinish must be a boolean or null when present" };
    }
  }
  if (obj.timedOut !== undefined && obj.timedOut !== null) {
    if (typeof obj.timedOut !== "boolean") {
      return { ok: false, reason: "timedOut must be a boolean or null when present" };
    }
  }
  if (obj.stalled !== undefined && obj.stalled !== null) {
    if (typeof obj.stalled !== "boolean") {
      return { ok: false, reason: "stalled must be a boolean or null when present" };
    }
  }
  // filesChanged: paths touched vs the pre-spawn baseline, computed by the driver
  // from git. Shipped 2026-08-28 and rode through unvalidated until D-54.
  if (obj.filesChanged !== undefined && obj.filesChanged !== null) {
    if (typeof obj.filesChanged !== "number") {
      return { ok: false, reason: "filesChanged must be a number or null when present" };
    }
  }
  // ── Gate outcome (gate_result). `passed` is deliberately THREE-valued: null
  //    means the gate could not be run at all (none declared, deps missing, spawn
  //    error, timeout) — an environment fault, never a model failure. Coercing it
  //    to false would score every unprovisioned worktree as "the seat wrote broken
  //    code" and make the metric worse than none, because it would be trusted.
  if (obj.passed !== undefined && obj.passed !== null) {
    if (typeof obj.passed !== "boolean") {
      return { ok: false, reason: "passed must be a boolean or null when present" };
    }
  }
  for (const key of ["gateCommand", "gateReason"]) {
    if (obj[key] !== undefined && obj[key] !== null && typeof obj[key] !== "string") {
      return { ok: false, reason: `${key} must be a string or null when present` };
    }
  }
  for (const key of ["gateStep", "gateTotal", "gateRan"]) {
    if (obj[key] !== undefined && obj[key] !== null && typeof obj[key] !== "number") {
      return { ok: false, reason: `${key} must be a number or null when present` };
    }
  }
  // The seat moved the gate config (package.json `scripts`, vitest config, CI) and
  // then went green. Not blocked — blocking costs a builder its legitimate
  // dependency edits — but such a run is QUARANTINED, never counted as delivered.
  if (obj.gateConfigTouched !== undefined && obj.gateConfigTouched !== null) {
    if (typeof obj.gateConfigTouched !== "boolean") {
      return { ok: false, reason: "gateConfigTouched must be a boolean or null when present" };
    }
  }
  // runId pairs phase_start / phase_end / gate_result for ONE spawn. Without it,
  // concurrent worktrees on one mission interleave and pairing is a FIFO guess.
  // Legacy rows have none → null, and consumers fall back to that guess knowingly.
  if (obj.runId !== undefined && obj.runId !== null && typeof obj.runId !== "string") {
    return { ok: false, reason: "runId must be a string or null when present" };
  }
  return { ok: true };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function missionDir(root, slug) {
  return path.join(root, slug);
}

function logPath(root, slug) {
  return path.join(missionDir(root, slug), "metrics.jsonl");
}

function readRecords(root, slug) {
  const p = logPath(root, slug);
  if (!existsSync(p)) return [];
  const records = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip corrupt line, never throw — a torn append from a crashed writer must
      // not block a legitimate `metrics summary` (house style, cf. history.mjs).
    }
  }
  return records;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdRecord(root, slug) {
  let obj;
  try {
    obj = JSON.parse(await readStdin());
  } catch {
    process.stderr.write("malformed JSON on stdin\n");
    return 1;
  }

  const check = validateEvent(obj);
  if (!check.ok) {
    process.stderr.write(`${check.reason}\n`);
    return 1;
  }

  if (obj.ts === undefined) obj.ts = new Date().toISOString();

  const dir = missionDir(root, slug);
  if (!existsSync(dir)) {
    // Soft-fail is right here — telemetry must never block a mission — but SILENT
    // is not. Creating the dir means either a brand-new mission, or a `--project`
    // that is wrong/omitted, in which case the KPI instrument quietly writes into
    // some other project's tree and the numbers vanish. (Exactly what happened to
    // the factory-profiles worker runs: dispatched without `--project`, three GLM
    // features' telemetry landed under the sole-entry default.) Warn, then proceed.
    process.stderr.write(
      `metrics: creating a new mission dir ${dir}\n` +
        `  if this is not a new mission, check --project / FACTORY_PROJECT.\n`,
    );
    mkdirSync(dir, { recursive: true });
  }

  appendFileSync(logPath(root, slug), `${JSON.stringify(obj)}\n`);
  process.stdout.write(`recorded ${obj.type} (${obj.seat}) for ${slug}\n`);
  return 0;
}

function cmdSummary(root, slug) {
  const records = readRecords(root, slug);
  if (records.length === 0) {
    process.stdout.write(`${slug}: no events recorded\n`);
    return 1;
  }

  const counts = {};
  let attention = 0;
  for (const r of records) {
    counts[r.type] = (counts[r.type] ?? 0) + 1;
    if (ATTENTION_TYPES.has(r.type)) attention++;
  }

  process.stdout.write(`${slug}: ${records.length} event(s)\n`);
  for (const type of [...TYPES].sort()) {
    if (counts[type]) process.stdout.write(`  ${type}: ${counts[type]}\n`);
  }
  process.stdout.write(
    `attention-per-feature figure (touchpoints+interventions+escalations): ${attention}\n`,
  );
  return 0;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/factory/metrics.mjs record <slug>    # append one event from stdin\n" +
      "  node scripts/factory/metrics.mjs summary <slug>    # print event counts + attention figure\n" +
      "  (optional --dir <path> overrides the missions root)\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let dir;
  let project;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") {
      dir = args[i + 1];
      i++;
    } else if (args[i] === "--project") {
      project = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }
  return { cmd: positional[0], slug: positional[1], dir, project };
}

async function main() {
  const { cmd, slug, dir, project } = parseArgs(process.argv);
  const root = resolveProject({ project, dir }).missionsRoot;
  if (!cmd || !slug) {
    usage();
    return 2;
  }
  if (cmd === "record") return cmdRecord(root, slug);
  if (cmd === "summary") return cmdSummary(root, slug);
  usage();
  return 2;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err?.message ?? err}\n`);
      process.exit(1);
    });
}

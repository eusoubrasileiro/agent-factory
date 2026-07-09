#!/usr/bin/env node
/**
 * Factory PR projector (factory-pr-record W4).
 *
 * Every mission gets a PR on the PRODUCT repo (wahub) carrying the full
 * validate→fix timeline. DISK STAYS CANONICAL — GitHub is a projection, same
 * doctrine as the board: the PR mirrors state that already lives on disk, and a
 * broken/absent projection NEVER blocks the mission loop.
 *
 * Every `gh` call goes through ONE `tryGh(args, {cwd, logPath})` helper. On a
 * missing binary, a nonzero exit, or any spawn error it appends one line to the
 * mission's `.pr.log`, returns null, and the command still exits 0.
 *
 * OPT-IN: the module is inert unless `FACTORY_PR=1`. `open` pushes the mission
 * branch to the product remote, publishing every commit reachable from it — so
 * the projection never arms itself implicitly. `pnpm test` pins `FACTORY_PR=0`.
 *
 * PRs target the wahub product repo (`repoRoot` from resolveProject), NOT the
 * factory repo. Dossiers stay in the factory repo — the PR body just links to
 * the dossier dir there.
 *
 * Subcommands (all soft-fail, all exit 0):
 *   open <slug>      — first verdict: push agent/<slug>, `gh pr create --draft`,
 *                      write the `PR` marker {number,url}. Idempotent: an
 *                      existing marker is returned, gh is not re-invoked.
 *   comment <slug>   — post the latest verdict + failing assertions as a PR
 *                      comment (only when a PR marker exists).
 *   finalize <slug>  — `gh pr ready <N>` (only when a marker exists). The local
 *                      merge + push flips the PR to Merged automatically.
 *
 * Usage:
 *   node scripts/pr-record.mjs open <slug> [--project wahub] [--dir <root>] [--repo <repoRoot>]
 *   node scripts/pr-record.mjs comment <slug> [...]
 *   node scripts/pr-record.mjs finalize <slug> [...]
 *
 * Exit codes:
 *   0 always (soft-fail by contract) · 2 usage error
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveProject } from "./lib/project.mjs";

const DEFAULT_TRUNK = "main";
const BRANCH_PREFIX = "agent/";

// ─── Pure helpers (exported for testing) ──────────────────────────────────────

/**
 * Extract the numeric PR id from a `gh pr create` URL (`.../pull/<n>`).
 * @param {string|null|undefined} url @returns {number|null}
 */
export function parsePrNumber(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Reduce a git remote URL (ssh or https) to its `owner/repo` slug.
 * @param {string|null|undefined} remoteUrl @returns {string|null}
 */
export function parseRepoSlug(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  const m = remoteUrl.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

/**
 * The H1 title text of a brief.md (`# <text>`), or null.
 * @param {string|null|undefined} briefText @returns {string|null}
 */
export function parseBriefTitle(briefText) {
  if (typeof briefText !== "string") return null;
  for (const line of briefText.split("\n")) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * The brief's title + first section: everything from the top up to (but not
 * including) the SECOND `## ` heading. Total on null → "".
 * @param {string|null|undefined} briefText @returns {string}
 */
export function firstBriefSection(briefText) {
  if (typeof briefText !== "string") return "";
  const lines = briefText.split("\n");
  let seenH2 = 0;
  const kept = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      seenH2++;
      if (seenH2 >= 2) break;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Count the data rows of the markdown table under the `## Assertions` heading
 * (each assertion + a GATE row). Header/separator rows are skipped. Total → 0.
 * @param {string|null|undefined} contractText @returns {number}
 */
export function countContractAssertions(contractText) {
  if (typeof contractText !== "string") return 0;
  let inSection = false;
  let count = 0;
  for (const line of contractText.split("\n")) {
    if (/^##\s+/.test(line)) {
      inSection = /^##\s+Assertions\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.split("|").slice(1, -1).map((c) => c.trim());
    const first = cells[0] ?? "";
    if (first === "") continue;
    if (/^id$/i.test(first)) continue; // header row
    if (/^[-:\s]+$/.test(first)) continue; // separator row
    count++;
  }
  return count;
}

/**
 * The last well-formed PASS/FAIL verdict object in a JSONL validate.log body,
 * or null. Malformed lines are skipped (mirrors board-sync/ratify).
 * @param {string|null|undefined} logText @returns {object|null}
 */
export function latestVerdict(logText) {
  if (typeof logText !== "string") return null;
  let last = null;
  for (const line of logText.split("\n")) {
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

/**
 * Render a mission's stats.json as a compact markdown table. Total on null →
 * an italic "sem stats" note (never crash).
 * @param {object|null|undefined} stats @returns {string}
 */
export function renderStatsTable(stats) {
  if (!stats || typeof stats !== "object") return "_(sem stats)_";
  const loc = stats.loc && typeof stats.loc === "object" ? stats.loc : {};
  const tokens = stats.tokens && typeof stats.tokens === "object" ? stats.tokens : {};
  const models = stats.models && typeof stats.models === "object" ? stats.models : {};
  const rows = [
    ["LOC", `+${loc.added ?? 0} / -${loc.deleted ?? 0} (${loc.files ?? 0} arquivos)`],
    ["Testes adicionados", String(stats.testsAdded ?? 0)],
    ["Rondas", String(stats.rounds ?? 0)],
    ["Tokens (total)", String(tokens.total ?? 0)],
    ["Modelo worker", String(models.worker ?? "—")],
    ["Modelo validator", String(models.validator ?? "—")],
    ["Baseline mudou", stats.baselineChanged ? "sim" : "não"],
  ];
  const head = "| Métrica | Valor |\n|---|---|\n";
  return head + rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n") + "\n";
}

/** The red (failing) assertion ids of a verdict, or []. */
function redAssertionIds(verdict) {
  const as = verdict && Array.isArray(verdict.assertions) ? verdict.assertions : [];
  return as.filter((a) => a && a.status === "red").map((a) => a.id);
}

/**
 * Build the PR comment body for a verdict round: the verdict JSON block + the
 * list of failing assertion ids.
 * @param {object} verdict @returns {string}
 */
export function buildCommentBody(verdict) {
  const v = verdict && typeof verdict === "object" ? verdict : {};
  const red = redAssertionIds(v);
  const redLine = red.length > 0 ? red.join(", ") : "nenhuma";
  return (
    `### Veredicto round ${v.round ?? "?"} — ${v.verdict ?? "?"}\n\n` +
    "```json\n" +
    `${JSON.stringify(v, null, 2)}\n` +
    "```\n\n" +
    `**Asserções vermelhas:** ${redLine}\n`
  );
}

/**
 * Build the draft-PR body opened at the first verdict: the brief's first
 * section, the dossier link, the contract assertion count, the latest verdict
 * JSON block, and the stats table.
 * @param {{ briefSection?: string, dossierUrl?: string|null, assertionCount?: number, verdict?: object|null, statsTable?: string }} args
 * @returns {string}
 */
export function buildOpenBody({ briefSection, dossierUrl, assertionCount, verdict, statsTable }) {
  const parts = [];
  if (briefSection && briefSection.trim().length > 0) parts.push(briefSection.trim());
  parts.push("---");
  parts.push(`- **Dossiê:** ${dossierUrl || "n/d"}`);
  parts.push(`- **Asserções do contrato:** ${assertionCount ?? 0}`);
  if (verdict && typeof verdict === "object") {
    parts.push(
      `### Último veredicto (round ${verdict.round ?? "?"} — ${verdict.verdict ?? "?"})\n\n` +
        "```json\n" +
        `${JSON.stringify(verdict, null, 2)}\n` +
        "```",
    );
  }
  parts.push(`### Stats\n\n${statsTable || "_(sem stats)_"}`);
  return `${parts.join("\n\n")}\n`;
}

// ─── Effects: gh + git (never throw, always log-and-return-null on failure) ────

/** Append one timestamped line to a mission's `.pr.log`. Never throws. */
function appendPrLog(logPath, line) {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort — logging failure must never surface
  }
}

/**
 * The ONE gh entry point. Runs `gh <args>` in `cwd`; on a missing binary, a
 * spawn error, or a nonzero exit it appends a `.pr.log` line and returns null.
 * On success returns stdout. NEVER throws.
 * @param {string[]} args
 * @param {{ cwd: string, logPath: string }} opts
 * @returns {string|null}
 */
export function tryGh(args, { cwd, logPath } = {}) {
  let r;
  try {
    r = spawnSync("gh", args, { cwd, encoding: "utf8" });
  } catch (err) {
    appendPrLog(logPath, `gh spawn threw: ${err?.message ?? err} (${args.join(" ")})`);
    return null;
  }
  if (r.error) {
    appendPrLog(logPath, `gh unavailable: ${r.error.message} (${args.join(" ")})`);
    return null;
  }
  if (r.status !== 0) {
    appendPrLog(logPath, `gh exit ${r.status} (${args.join(" ")}): ${(r.stderr || "").trim()}`);
    return null;
  }
  return r.stdout ?? "";
}

/** Run git in cwd; any failure (missing binary, nonzero) → null (logged). */
function tryGit(args, { cwd, logPath }) {
  let r;
  try {
    r = spawnSync("git", args, { cwd, encoding: "utf8" });
  } catch (err) {
    appendPrLog(logPath, `git spawn threw: ${err?.message ?? err} (${args.join(" ")})`);
    return null;
  }
  if (r.error || r.status !== 0) {
    appendPrLog(logPath, `git exit ${r?.status} (${args.join(" ")}): ${(r?.stderr || "").trim()}`);
    return null;
  }
  return r.stdout ?? "";
}

// ─── Marker + body IO ─────────────────────────────────────────────────────────

function readMaybe(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readMarker(missionDir) {
  const text = readMaybe(path.join(missionDir, "PR"));
  if (text === null) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && Number.isFinite(obj.number)) return obj;
  } catch {
    // fall through
  }
  return null;
}

/**
 * GitHub tree URL of the mission's dossier dir in the FACTORY repo. Derived
 * from the factory repo's `origin` remote (read-only git config). Null when no
 * remote / not a repo — soft.
 */
function dossierUrl(factoryRoot, project, slug, logPath) {
  const remote = tryGit(["config", "--get", "remote.origin.url"], { cwd: factoryRoot, logPath });
  const repoSlug = parseRepoSlug(remote);
  if (!repoSlug) return null;
  return `https://github.com/${repoSlug}/tree/main/missions/${project}/${slug}`;
}

/** Write body to a throwaway tmp file; returns its path (best-effort). */
function writeTmpBody(body) {
  const p = path.join(tmpdir(), `pr-body-${process.pid}-${Date.now()}.md`);
  writeFileSync(p, body);
  return p;
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

function missionDirOf(missionsRoot, slug) {
  return path.join(missionsRoot, slug);
}

function missionExists(missionsRoot, slug) {
  const dir = missionDirOf(missionsRoot, slug);
  return existsSync(dir) && statSync(dir).isDirectory();
}

function cmdOpen({ missionsRoot, repoRoot, factoryRoot, project, slug, trunk }) {
  if (!missionExists(missionsRoot, slug)) return 0; // total: nowhere to even log
  const dir = missionDirOf(missionsRoot, slug);
  const logPath = path.join(dir, ".pr.log");
  const markerPath = path.join(dir, "PR");

  const existing = readMarker(dir);
  if (existing) {
    process.stdout.write(`pr-record: ${slug} PR #${existing.number} already open — no-op\n`);
    return 0;
  }

  const branch = `${BRANCH_PREFIX}${slug}`;
  // Best-effort push of the mission branch. A failure is logged but does NOT
  // abort — gh pr create will itself fail (and soft-fail) if the branch is not
  // on the remote, keeping the whole path soft.
  tryGit(["push", "-u", "origin", branch], { cwd: repoRoot, logPath });

  // Assemble the draft body from disk (all reads total).
  const briefSection = firstBriefSection(readMaybe(path.join(dir, "brief.md")));
  const assertionCount = countContractAssertions(readMaybe(path.join(dir, "contract.md")));
  const verdict = latestVerdict(readMaybe(path.join(dir, "validate.log")));
  const stats = (() => {
    try {
      return JSON.parse(readMaybe(path.join(dir, "stats.json")) ?? "null");
    } catch {
      return null;
    }
  })();
  const body = buildOpenBody({
    briefSection,
    dossierUrl: dossierUrl(factoryRoot, project, slug, logPath),
    assertionCount,
    verdict,
    statsTable: renderStatsTable(stats),
  });

  const title = `mission(${slug}): ${parseBriefTitle(readMaybe(path.join(dir, "brief.md"))) || slug}`;
  const bodyFile = writeTmpBody(body);
  // `--base` explicit: never rely on gh's default-branch inference, which would
  // silently retarget the PR if the product repo's default branch ever changes.
  const out = tryGh(
    [
      "pr", "create", "--draft",
      "--base", trunk,
      "--head", branch,
      "--title", title,
      "--body-file", bodyFile,
    ],
    { cwd: repoRoot, logPath },
  );
  if (out === null) return 0; // soft-fail already logged

  const url = String(out).trim().split("\n").filter(Boolean).pop() || "";
  const number = parsePrNumber(url);
  if (number === null) {
    appendPrLog(logPath, `could not parse PR number from gh output: ${JSON.stringify(out)}`);
    return 0;
  }
  writeFileSync(markerPath, `${JSON.stringify({ number, url })}\n`);
  process.stdout.write(`pr-record: opened draft PR #${number} for ${slug} -> ${url}\n`);
  return 0;
}

function cmdComment({ missionsRoot, repoRoot, slug }) {
  if (!missionExists(missionsRoot, slug)) return 0;
  const dir = missionDirOf(missionsRoot, slug);
  const logPath = path.join(dir, ".pr.log");
  const marker = readMarker(dir);
  if (!marker) return 0; // no PR to comment on

  const verdict = latestVerdict(readMaybe(path.join(dir, "validate.log")));
  if (!verdict) return 0;
  const bodyFile = writeTmpBody(buildCommentBody(verdict));
  tryGh(["pr", "comment", String(marker.number), "--body-file", bodyFile], {
    cwd: repoRoot,
    logPath,
  });
  process.stdout.write(`pr-record: commented on PR #${marker.number} for ${slug}\n`);
  return 0;
}

function cmdFinalize({ missionsRoot, repoRoot, slug }) {
  if (!missionExists(missionsRoot, slug)) return 0;
  const dir = missionDirOf(missionsRoot, slug);
  const logPath = path.join(dir, ".pr.log");
  const marker = readMarker(dir);
  if (!marker) return 0;

  tryGh(["pr", "ready", String(marker.number)], { cwd: repoRoot, logPath });
  process.stdout.write(`pr-record: marked PR #${marker.number} ready for ${slug}\n`);
  return 0;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/pr-record.mjs open <slug>     [--project <id>] [--dir <root>] [--repo <repoRoot>]\n" +
      "  node scripts/pr-record.mjs comment <slug>  [...]\n" +
      "  node scripts/pr-record.mjs finalize <slug> [...]\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--project":
        opts.project = args[++i];
        break;
      case "--dir":
        opts.dir = args[++i];
        break;
      case "--repo":
        opts.repo = args[++i];
        break;
      case "--trunk":
        opts.trunk = args[++i];
        break;
      default:
        positional.push(args[i]);
    }
  }
  return { cmd: positional[0], slug: positional[1], ...opts };
}

function main() {
  const { cmd, slug, project, dir, repo, trunk } = parseArgs(process.argv);
  if (!cmd || !slug || !["open", "comment", "finalize"].includes(cmd)) {
    usage();
    return 2;
  }
  // Global guard: the projection is OPT-IN. `open` pushes `agent/<slug>` to the
  // product remote, which publishes every commit reachable from that branch —
  // an outward-facing, effectively irreversible action. So only an explicit
  // FACTORY_PR=1 arms it; unset and "0" are both inert (pnpm test sets "0").
  if (process.env.FACTORY_PR !== "1") return 0;

  const resolved = resolveProject({ project, dir, repo });
  const ctx = {
    missionsRoot: resolved.missionsRoot,
    repoRoot: resolved.repoRoot,
    factoryRoot: resolved.factoryRoot,
    project: resolved.id,
    slug,
    trunk: trunk || DEFAULT_TRUNK,
  };
  if (cmd === "open") return cmdOpen(ctx);
  if (cmd === "comment") return cmdComment(ctx);
  if (cmd === "finalize") return cmdFinalize(ctx);
  usage();
  return 2;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    // Soft-fail contract: never crash the caller. A usage error already
    // returned 2 above; anything unexpected here degrades to 0.
    process.stderr.write(`pr-record: ${err?.message ?? err}\n`);
    process.exit(0);
  }
}

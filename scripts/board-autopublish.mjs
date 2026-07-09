#!/usr/bin/env node

/**
 * Factory board autopublish — the ONE idempotent publish funnel.
 *
 * Renders every project's dashboard via `board-report.mjs`, content-hashes the
 * rendered HTML (with the volatile `gerado em` timestamp line stripped), and
 * publishes ONLY when the hash changed. Soft-fail by design: every failure
 * path logs one line to `factory/.publish.log` and exits 0 so a binding
 * (post-commit / post-merge / verdict / ratify) can never break its caller.
 * `--strict` flips to exit 1 for CI/debug.
 *
 * Loop safety is BY CONSTRUCTION:
 *   - This script NEVER executes git write commands (commit/add/push/merge) —
 *     contract A3. It only spawns `board-report.mjs` (read-only: derives state
 *     from disk + lists `agent/*` branches) and `board-publish.sh` (rsync).
 *     Read-only git inside board-report is fine; nothing here commits.
 *   - post-commit → autopublish makes NO commits → cannot re-fire post-commit.
 *   - Double-fire (verdict autoCommit → post-commit → autopublish) is absorbed
 *     by the hash guard: the second invocation sees "sem mudanças" and no-ops.
 *   - Bounded, no recursion.
 *
 * Hash memo: `dist/factory-board/.hash` (dist is gitignored; losing it causes
 * one harmless republish). Publish log: `factory/.publish.log` (gitignored).
 * History snapshots: `factory/history.jsonl` (committed; autoCommit-touched).
 *
 * Usage:
 *   node scripts/factory/board-autopublish.mjs [--repo <root>] [--dry-run] [--strict]
 *
 * Exit codes:
 *   0 ok or soft-failed · 1 hard error AND --strict (CI/debug) · 2 usage
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderRootIndex, renderScrumbanRedirect } from "./board-index.mjs";
import { deriveMissionState } from "./board-sync.mjs";
import { appendSnapshots, snapshotRows } from "./history.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { resolveProject } from "./lib/project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BOARD_REPORT = path.join(__dirname, "board-report.mjs");
const BOARD_PUBLISH = path.join(__dirname, "board-publish.sh");

const DEFAULT_REMOTE_DIR = "/opt/app/factory/public/";
const DEFAULT_HOST = "deploy-host";

// ─── Pure core (exported for testing) ────────────────────────────────────────

/**
 * Strip every line carrying a volatile timestamp marker so the content hash is
 * stable across renders of identical state. Three markers exist in the rendered
 * HTML, all regenerated at `new Date().toISOString()` on every render:
 *   - the footer line `gerado em <iso>` (Portuguese, human-visible) — present in
 *     both the per-project dashboard and the root index;
 *   - the embedded `<script id="model">` JSON field `"generatedAt": "<iso>"`
 *     (dashboard model payload);
 *   - the root-index card line `última atualização <iso>` (board-index.mjs),
 *     which mirrors the per-project `generatedAt` and is therefore also volatile.
 * All three are removed; everything else is preserved so real content changes
 * still move the hash.
 * @param {string} html
 * @returns {string}
 */
export function stripTimestampLines(html) {
  return String(html)
    .split("\n")
    .filter(
      (line) =>
        !line.includes("gerado em") &&
        !line.includes('"generatedAt"') &&
        !line.includes("última atualização"),
    )
    .join("\n");
}

/**
 * Strip the Histórico tab panel + its embedded JSON so history changes do NOT
 * affect the content hash (feature 04). The board republishes when the live
 * model changes — appending lagging-indicator snapshots must not trigger a
 * republish loop.
 *
 * Two artifacts are stripped:
 *   - the visible panel `<!--hist-start-->…<!--hist-end-->` (board-report.mjs);
 *   - the embedded `<script type="application/json" id="history">…</script>`.
 * @param {string} html
 * @returns {string}
 */
export function stripHistoryPanel(html) {
  return String(html)
    .replace(/<!--hist-start-->[\s\S]*?<!--hist-end-->/g, "")
    .replace(/<script type="application\/json" id="history">[\s\S]*?<\/script>/g, "");
}

/**
 * sha256 over the concatenated rendered HTML files (timestamps + Histórico
 * stripped). Deterministic for identical content; order of the array is
 * significant (callers pass projects in manifest order, which is stable).
 * @param {string[]} htmls — rendered HTML strings, one per project page
 * @returns {string} — 64-char hex digest
 */
export function contentHash(htmls) {
  const joined = (Array.isArray(htmls) ? htmls : [])
    .map((h) => stripHistoryPanel(stripTimestampLines(String(h ?? ""))))
    .join("\n");
  return createHash("sha256").update(joined).digest("hex");
}

/**
 * Build the rsync command string this funnel intends to run. Pure — never
 * executes anything. Used for `--dry-run` output and for tests.
 *
 * NOTE: board-publish.sh (the real publish delegate) is repointed to
 * `public/` in feature 03; until then the dry-run prints the intended
 * (post-feature-03) target so operators can see where the funnel is heading.
 * @param {{host?: string, remoteDir?: string, distDir?: string}} opts
 * @returns {string}
 */
export function buildRsyncCommand({
  host = DEFAULT_HOST,
  remoteDir = DEFAULT_REMOTE_DIR,
  distDir = "dist/factory-board/",
} = {}) {
  const argv = ["rsync", "-az", "--delete", distDir, `${host}:${remoteDir}`];
  return argv.join(" ");
}

/**
 * Format one publish-log line: `[<iso ts>] <message>\n`.
 * @param {string} message
 * @param {string} [ts] — ISO timestamp (default: now)
 * @returns {string}
 */
export function formatPublishLogLine(message, ts = new Date().toISOString()) {
  return `[${ts}] ${message}\n`;
}

// ─── Manifest ────────────────────────────────────────────────────────────────

/**
 * Read the projects manifest. Missing file → null (soft no-op). Malformed
 * JSON → throws (caught by the soft-fail wrapper in main).
 * @param {string} repoRoot
 * @returns {Array<{id: string, name?: string, repo?: string, prd?: string}> | null}
 */
function readManifest(repoRoot) {
  const p = path.join(repoRoot, "deploy", "projects.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

// ─── Rendering (effects) ─────────────────────────────────────────────────────

/**
 * Render one project's dashboard via board-report.mjs. Throws on board-report
 * failure (caught by the caller's soft-fail wrapper).
 *
 * Post-extraction path split: mission dossiers + history live in the FACTORY
 * repo (`factoryRoot`), while the code, `agent/*` branches and PRD live in the
 * PRODUCT repo — both come from `resolveProject`. Rendered HTML lands under the
 * factory repo's `dist/factory-board/<id>/`.
 * @param {{entry: {id: string, name?: string, path?: string, repo?: string, prd?: string}, factoryRoot: string}} args
 * @returns {{entry: object, outPath: string, repoPath: string, missionsDir: string}}
 */
function renderProject({ entry, factoryRoot }) {
  const { repoRoot: productRepo, missionsRoot, prdPath } = resolveProject(
    { project: entry.id },
    factoryRoot,
  );
  const outDir = path.join(factoryRoot, "dist", "factory-board", entry.id);
  const outPath = path.join(outDir, "index.html");

  mkdirSync(outDir, { recursive: true });

  const args = [
    BOARD_REPORT,
    "--project",
    entry.id,
    "--missions",
    missionsRoot,
    "--repo",
    productRepo,
    "--out",
    outPath,
  ];
  if (prdPath) args.push("--prd", prdPath);

  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, FACTORY_ROOT: factoryRoot },
  });
  if (r.status !== 0) {
    throw new Error(
      `board-report falhou para ${entry.id}: ${r.stderr || r.stdout || "exit " + r.status}`,
    );
  }
  return { entry, outPath, repoPath: productRepo, missionsDir: missionsRoot };
}

// ─── History snapshots (feature 04 — uses history.mjs) ──────────────────────

/** Read a file as utf8, or null if missing. Never throws. */
function readMaybe(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Extract the traceability model JSON from the rendered dashboard HTML.
 * The model is embedded as `<script type="application/json" id="model">…</script>`
 * (board-report.mjs). Returns `{ missions: [] }` on any parse failure.
 * @param {string} html
 * @returns {{ missions: Array }}
 */
function extractModelFromHtml(html) {
  const m = String(html).match(/<script type="application\/json" id="model">([\s\S]*?)<\/script>/);
  if (!m) return { missions: [] };
  try {
    const obj = JSON.parse(m[1]);
    return obj && typeof obj === "object" ? obj : { missions: [] };
  } catch {
    return { missions: [] };
  }
}

/**
 * Append one snapshot row per mission to `factory/history.jsonl`, per the
 * shape fixed in plan.md. Delegates to history.mjs `snapshotRows` +
 * `appendSnapshots`. The model is extracted from the rendered HTML (which
 * board-report.mjs embeds as `<script id="model">`). Never throws (history
 * is best-effort).
 * @param {{rendered: Array, repoRoot: string, ts: string}} args
 */
function appendHistorySnapshots({ rendered, repoRoot, ts }) {
  const historyPath = path.join(repoRoot, "history.jsonl");
  const rows = [];
  for (const r of rendered) {
    if (!existsSync(r.outPath)) continue;
    const html = readFileSync(r.outPath, "utf8");
    const model = extractModelFromHtml(html);
    // missions/<project>/ lives under the factory root (repoRoot here) — pass it
    // so each snapshot row is enriched with stats.json (loc/tokens/models/durationH).
    const missionsDir = path.join(repoRoot, "missions", r.entry.id);
    rows.push(...snapshotRows(model, r.entry.id, ts, missionsDir));
  }
  if (rows.length > 0) {
    appendSnapshots(historyPath, rows);
  }
}

// ─── Root index + /scrumban/ redirect (feature 03) ───────────────────────────

/**
 * Count a project's in-flight missions (any derived status except Done).
 * Never throws — missing dir → 0.
 * @param {string} missionsDir
 * @returns {number}
 */
function countInFlight(missionsDir) {
  if (!existsSync(missionsDir)) return 0;
  let count = 0;
  for (const name of readdirSync(missionsDir)) {
    const dir = path.join(missionsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const { status } = deriveMissionState(dir);
    if (status !== "Done") count++;
  }
  return count;
}

/**
 * Pull the project's `generatedAt` out of its rendered dashboard HTML (the
 * `<time datetime="...">` tag in the footer). Returns null if not found.
 * @param {string} html
 * @returns {string|null}
 */
function extractGeneratedAt(html) {
  const m = String(html).match(/<time datetime="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Emit the root project index (`dist/factory-board/index.html`) and the
 * `/scrumban/` meta-refresh redirect (`dist/factory-board/scrumban/index.html`).
 * Pure IO: reads each rendered project's HTML + missions dir, calls the pure
 * renderers from board-index.mjs, writes the files. Never throws — the caller's
 * soft-fail wrapper handles errors.
 *
 * Returns `{ rootHtml, redirectHtml }` so the caller can fold them into the
 * content hash (feature 03 — a root-index change must trigger a republish).
 * @param {{projects: Array<{entry: object, outPath: string, missionsDir: string}>, distDir: string}} args
 * @returns {{rootHtml: string, redirectHtml: string, rootPath: string, redirectPath: string}}
 */
function writeRootIndex({ projects: rendered, distDir }) {
  const cards = rendered.map((r) => {
    const html = readFileSync(r.outPath, "utf8");
    return {
      id: r.entry.id,
      name: r.entry.name || r.entry.id,
      inFlight: countInFlight(r.missionsDir),
      updatedAt: extractGeneratedAt(html),
    };
  });
  const rootHtml = renderRootIndex(cards, { generatedAt: new Date().toISOString() });
  const rootPath = path.join(distDir, "index.html");
  writeFileSync(rootPath, rootHtml);

  // Historical-compat: the old single-board URL lands on the root index, which
  // lists every project. It deliberately does NOT pick a project. "First in the
  // manifest" reads as "the product this board was built for" only while there is
  // exactly one; the moment a second profile exists, directory order decides, and
  // the legacy URL silently follows whichever id sorts first. A redirect target
  // must not depend on alphabetical luck.
  const redirectHtml = renderScrumbanRedirect("/");
  const redirectDir = path.join(distDir, "scrumban");
  mkdirSync(redirectDir, { recursive: true });
  const redirectPath = path.join(redirectDir, "index.html");
  writeFileSync(redirectPath, redirectHtml);

  return { rootHtml, redirectHtml, rootPath, redirectPath };
}

// ─── Publish log ─────────────────────────────────────────────────────────────

function logLine(repoRoot, message) {
  const logPath = path.join(repoRoot, ".publish.log");
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, formatPublishLogLine(message));
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/factory/board-autopublish.mjs [--repo <root>] [--dry-run] [--strict]\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let repo;
  let dryRun = false;
  let strict = false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") repo = args[++i];
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--strict") strict = true;
    else positional.push(args[i]);
  }
  return { repo, dryRun, strict, positional };
}

/**
 * Main funnel. Returns the intended exit code (does not call process.exit).
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
  const { repo, dryRun, strict, positional } = parseArgs(argv);
  if (positional.length > 0) {
    usage();
    return 2;
  }
  const repoRoot = repo ? path.resolve(repo) : ROOT;

  try {
    return run({ repoRoot, dryRun });
  } catch (err) {
    logLine(repoRoot, `erro: ${err?.message ?? err}`);
    if (strict) {
      process.stderr.write(`${err?.message ?? err}\n`);
      return 1;
    }
    return 0;
  }
}

/**
 * The funnel body, isolated from argv for testability. Throws on hard errors
 * (caller decides soft vs strict exit).
 * @param {{repoRoot: string, dryRun: boolean}} args
 * @returns {number}
 */
function run({ repoRoot, dryRun }) {
  const manifest = readManifest(repoRoot);
  if (manifest === null) {
    logLine(repoRoot, "projects.json não encontrado, nada a publicar");
    return 0;
  }

  // Render every project in the manifest.
  const rendered = manifest.map((entry) => renderProject({ entry, factoryRoot: repoRoot }));

  // Feature 03: root project index (`/`) + `/scrumban/` redirect. The rendered
  // HTML is folded into the content hash below so a root change republishes.
  const distDir = path.join(repoRoot, "dist", "factory-board");
  const root = writeRootIndex({ projects: rendered, distDir });

  // Content hash over concatenated rendered HTML (timestamps stripped):
  // per-project pages (manifest order) + root index + scrumban redirect.
  // Order is deterministic; root + redirect last.
  const htmls = [
    ...rendered.map((r) => readFileSync(r.outPath, "utf8")),
    root.rootHtml,
    root.redirectHtml,
  ];
  const hash = contentHash(htmls);

  const memoPath = path.join(repoRoot, "dist", "factory-board", ".hash");
  const prevHash = readMaybe(memoPath);

  if (prevHash === hash) {
    logLine(repoRoot, "sem mudanças");
    return 0;
  }

  if (dryRun) {
    // Full render + hash logic ran; print the rsync command, no network.
    const cmd = buildRsyncCommand({
      host: process.env.PUBLISH_HOST || DEFAULT_HOST,
      remoteDir: process.env.PUBLISH_DIR || DEFAULT_REMOTE_DIR,
      distDir: "dist/factory-board/",
    });
    process.stdout.write(`${cmd}\n`);
    return 0;
  }

  // Real publish: delegate rsync to board-publish.sh (feature 03 repoints it
  // to public/). Best-effort — a failed rsync logs but does not skip history.
  try {
    spawnSync("bash", [BOARD_PUBLISH], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    // soft-fail: board-publish.sh missing or rsync failed — log + continue
  }

  // Append history snapshots per mission (inline until feature 04 extracts).
  appendHistorySnapshots({ rendered, repoRoot, ts: new Date().toISOString() });

  // Persist the hash memo so the next run no-ops on identical state.
  mkdirSync(path.dirname(memoPath), { recursive: true });
  writeFileSync(memoPath, hash);

  logLine(repoRoot, `publicado (hash ${hash.slice(0, 12)})`);
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  process.exit(main(process.argv));
}

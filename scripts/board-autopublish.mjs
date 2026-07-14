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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderClientPage } from "./client-view.mjs";
import { renderRootIndex, renderScrumbanRedirect } from "./board-index.mjs";
import { deriveMissionState } from "./board-sync.mjs";
import { appendSnapshots, snapshotRows } from "./history.mjs";
import { readIntake } from "./intake-report.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { loadProjects, resolveProject } from "./lib/project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BOARD_REPORT = path.join(__dirname, "board-report.mjs");
const BOARD_PUBLISH = path.join(__dirname, "board-publish.sh");

const DEFAULT_REMOTE_DIR = "/opt/app/factory/public/";
const DEFAULT_HOST = "deploy-host";

// ─── Pure core (exported for testing) ────────────────────────────────────────

/**
 * Strip every line carrying a volatile timestamp marker so the content hash is
 * stable across renders of identical state. Four markers exist in the rendered
 * HTML, all regenerated at `new Date().toISOString()` on every render:
 *   - the footer line `gerado em <iso>` (Portuguese, human-visible) — present in
 *     both the per-project dashboard and the root index;
 *   - the embedded `<script id="model">` JSON field `"generatedAt": "<iso>"`
 *     (dashboard model payload);
 *   - the root-index card line `última atualização <iso>` (board-index.mjs),
 *     which mirrors the per-project `generatedAt` and is therefore also volatile;
 *   - the client-page footer line `atualizado em <time datetime="<iso>">…</time>`
 *     (client-view.mjs) — the client status page's own regenerated timestamp.
 * All four are removed; everything else is preserved so real content changes
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
        !line.includes("última atualização") &&
        !line.includes("atualizado em"),
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

// ─── Client status page (M5 — client-view) ───────────────────────────────────
//
// A second published artifact: the plain-PT client funnel page
// (`dist/factory-board/cliente/index.html`). It is built ONLY from curated
// labels (`client-labels.json` beside a declared `intake[]` source), never from
// the intake summary, and the renderer (client-view.mjs) is whitelist-by-
// construction + fail-closed. This wiring is the publish-side fail-closed gate:
// the page is rendered and written ONLY when a project BOTH declares `intake[]`
// AND ships a parseable `client-labels.json`. No labels → no cliente/ dir → an
// unlabeled (therefore unsafe) page can never be published.

/**
 * Render the client status page from the first project that declares an
 * `intake[]` source with a parseable `client-labels.json` beside it. Labels from
 * multiple intake sources are merged. Returns "" (render nothing, write no file)
 * when no qualifying project exists — the fail-closed outcome.
 *
 * The engine stays product-agnostic: it never names a client or product, only
 * follows the profile-declared `intake[]` to the sibling labels file (D-15).
 *
 * @param {Array<{id: string}>} manifest — project entries from loadProjects.
 * @param {string} repoRoot — the factory root (where intake[].file resolves from).
 * @param {string} generatedAt — ISO timestamp for the page footer.
 * @returns {string} — the rendered HTML, or "" when labels are absent.
 */
function renderClientePage(manifest, repoRoot, generatedAt) {
  for (const entry of manifest ?? []) {
    if (!entry || typeof entry.id !== "string") continue;
    const { profile } = resolveProject({ project: entry.id }, repoRoot);
    if (!Array.isArray(profile.intake) || profile.intake.length === 0) continue;

    // Merge the curated label maps from every intake source that ships one. A
    // source whose labels file is missing or unparseable contributes nothing.
    /** @type {Record<string, object>} */
    const labels = {};
    let any = false;
    for (const src of profile.intake) {
      const labelsPath = path.join(path.dirname(src.file), "client-labels.json");
      if (!existsSync(labelsPath)) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(labelsPath, "utf8"));
      } catch {
        continue; // corrupt labels → this source contributes nothing (fail-closed)
      }
      if (parsed && typeof parsed === "object") {
        Object.assign(labels, parsed);
        any = true;
      }
    }
    if (!any) continue; // no labels anywhere → fail closed, try no further source

    const { rows } = readIntake(profile.intake);
    return renderClientPage({ intake: rows, labels, generatedAt });
  }
  return "";
}

// ─── Publish log ─────────────────────────────────────────────────────────────

function logLine(repoRoot, message) {
  const logPath = path.join(repoRoot, ".publish.log");
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, formatPublishLogLine(message));
}

// ─── Lock (feature F4/D-24/D-25) ─────────────────────────────────────────────
//
// Every state change fires autopublish twice (verdict/ratify's explicit
// triggerAutopublish() plus the post-commit hook) — deliberately, for
// resilience. Without serialization, two concurrent invocations could both
// read the same prevHash, both pass the hash guard, and both append a
// history.jsonl snapshot set / both rsync. The advisory lockfile below
// serializes the render+publish+append critical section so only one funnel
// runs at a time; the other backs off as a no-op (never an error — autopublish
// stays best-effort and must never fail a verdict).

const LOCK_STALE_MS = 120_000;

/**
 * Try to acquire the advisory publish lock. Returns true if acquired (the
 * caller must release it via releaseLock in a finally block); false if
 * another run currently holds a live lock (the caller backs off as a no-op).
 * A lock file older than LOCK_STALE_MS is treated as abandoned — a crashed
 * prior run — and reclaimed. Never throws: any unexpected fs error is
 * treated as "could not acquire" so the lock itself can never break a verdict.
 * @param {string} lockPath
 * @returns {boolean}
 */
function acquireLock(lockPath) {
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    closeSync(openSync(lockPath, "wx"));
    return true;
  } catch (err) {
    if (err?.code !== "EEXIST") return false;
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age < LOCK_STALE_MS) return false;
      unlinkSync(lockPath);
      closeSync(openSync(lockPath, "wx"));
      return true;
    } catch {
      return false;
    }
  }
}

/** Release the advisory publish lock. Best-effort — never throws. */
function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone / never ours — fine either way
  }
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
  // E4-b: the board projects come from loadProjects() (profiles + deploy back-compat),
  // not a raw deploy/projects.json read — so a projects/-only project (one with a
  // profile but no deploy-manifest row) appears on the board instead of being invisible.
  const manifest = loadProjects(repoRoot);
  if (manifest.length === 0) {
    logLine(repoRoot, "nenhum projeto encontrado, nada a publicar");
    return 0;
  }

  // Serialize the render+publish+append critical section — see the "Lock"
  // section above. Both autopublish triggers (verdict/ratify + post-commit)
  // stay wired; this only stops them from racing each other.
  const lockPath = path.join(repoRoot, "dist", "factory-board", ".lock");
  if (!acquireLock(lockPath)) {
    logLine(repoRoot, "lock ocupado — outro publish em andamento, pulando");
    return 0;
  }

  try {
    return runLocked({ repoRoot, dryRun, manifest });
  } finally {
    releaseLock(lockPath);
  }
}

/** The render+publish+append critical section, run while holding the lock. */
function runLocked({ repoRoot, dryRun, manifest }) {
  // Render every project in the manifest.
  const rendered = manifest.map((entry) => renderProject({ entry, factoryRoot: repoRoot }));

  // Feature 03: root project index (`/`) + `/scrumban/` redirect. The rendered
  // HTML is folded into the content hash below so a root change republishes.
  const distDir = path.join(repoRoot, "dist", "factory-board");
  const root = writeRootIndex({ projects: rendered, distDir });

  // M5: client status page (`/cliente/`). Rendered + written only when a project
  // declares `intake[]` with a parseable `client-labels.json` (fail-closed — no
  // labels ⇒ empty string ⇒ no dir). Folded into the content hash so a curated-
  // label change republishes (and the page's own footer timestamp is stripped,
  // so an identical re-render does not). See renderClientePage above.
  const clienteHtml = renderClientePage(manifest, repoRoot, new Date().toISOString());
  if (clienteHtml) {
    const clienteDir = path.join(distDir, "cliente");
    mkdirSync(clienteDir, { recursive: true });
    writeFileSync(path.join(clienteDir, "index.html"), clienteHtml);
  }

  // Content hash over concatenated rendered HTML (timestamps stripped):
  // per-project pages (manifest order) + root index + scrumban redirect + the
  // client page ("" when absent). Order is deterministic.
  const htmls = [
    ...rendered.map((r) => readFileSync(r.outPath, "utf8")),
    root.rootHtml,
    root.redirectHtml,
    clienteHtml,
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

  // Append history snapshots per mission (inline until feature 04 extracts).
  // Independent of the rsync: the snapshot describes local disk, which is real
  // whether or not the VPS ever hears about it.
  appendHistorySnapshots({ rendered, repoRoot, ts: new Date().toISOString() });

  // ── Who is allowed to touch the live board.
  //
  // `board-publish.sh` runs `rsync -az --delete <repoRoot>/dist/factory-board/
  // deploy-host:/opt/app/factory/public/`. That `--delete` makes the source
  // directory authoritative: whatever it holds BECOMES the published board.
  //
  // The tests drive this CLI with `--repo <mkdtemp>`, and several of them omit
  // `--dry-run`. Before this guard, each such test rsynced its own fixture over
  // production. Observed 2026-07-09: `factory.example.com` was serving a fixture
  // board — one requirement `A1`, one mission `alpha` — because a raw
  // `node --test` run had overwritten the real one. `FACTORY_AUTOPUBLISH=0` did
  // not stop it: that guard lives in `verdict.mjs`/`ratify.mjs`, the CALLERS, and
  // nothing guarded the dangerous action itself.
  //
  // So the guard belongs HERE, at the rsync, and it is positive: publish only
  // from the real factory checkout, and only when publishing is not disabled.
  // Same doctrine as D-24 — refuse at the dangerous step, do not warn at the
  // edges.
  const isFactoryRoot = path.resolve(repoRoot) === ROOT;
  const skipReason = !isFactoryRoot
    ? "repoRoot não é a fábrica real"
    : process.env.FACTORY_AUTOPUBLISH === "0"
      ? "FACTORY_AUTOPUBLISH=0"
      : null;

  if (skipReason) {
    // A fixture root owns its own memo (tests rely on the second run no-opping),
    // and it can never describe the VPS. The REAL root under FACTORY_AUTOPUBLISH=0
    // must NOT memoize: the content was never delivered, and a memo would make
    // the next genuine run skip it.
    if (!isFactoryRoot) {
      mkdirSync(path.dirname(memoPath), { recursive: true });
      writeFileSync(memoPath, hash);
    }
    logLine(repoRoot, `renderizado (hash ${hash.slice(0, 12)}) — rsync ignorado: ${skipReason}`);
    return 0;
  }

  // Real publish. The rsync's EXIT STATUS decides everything below it.
  //
  // A publish that did not happen must never be recorded as published: the memo
  // is what makes the next run a no-op, so writing it after a failed rsync
  // freezes the live board in silence — every later run reports "sem mudanças"
  // while the VPS serves stale HTML, and nothing anywhere says so. Same class as
  // D-25: a step that cannot fail must never report success.
  //
  // On failure: log it, leave the memo untouched so the next run RETRIES, and
  // still exit 0 — publishing is best-effort and must never fail a verdict.
  let published = false;
  try {
    const r = spawnSync("bash", [BOARD_PUBLISH], { cwd: repoRoot, stdio: "ignore" });
    published = !r.error && r.status === 0;
  } catch {
    published = false; // board-publish.sh missing / spawn refused
  }

  if (!published) {
    logLine(repoRoot, `rsync falhou — nada publicado (hash ${hash.slice(0, 12)}); memo preservado`);
    return 0;
  }

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

#!/usr/bin/env node
/**
 * One-time (but idempotent) Intake importer.
 *
 * Seeds the factory board's Intake/Done columns from the legacy hand-edited
 * backlog table in `docs/prd/nexus-build-backlog.md` (four body tables — Body
 * A..D — sharing one header). This is the retirement path for that table's
 * free-form `Situação` column: after this runs (and the doc gets its
 * deprecation banner), the board is the live source of status, not the doc.
 *
 * Card ⇄ row join: a card belongs to a doc row when its title starts with
 * `<ID> — `. Re-running skips rows that already have a card.
 *
 * Usage:
 *   node scripts/factory/board-import-backlog.mjs [--doc <path>] [--repo <path>]
 *
 * `--doc` overrides the source markdown (default docs/prd/nexus-build-backlog.md);
 * `--repo` overrides the repo root whose `backlog/` the CLI edits (default: this
 * repo's root).
 *
 * Exit codes:
 *   0 ok (creates 0..N cards) · 1 doc unreadable or a `backlog task create` failed
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseTaskList } from "./board-sync.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { resolveProject } from "./lib/project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Backlog import operates on the PRODUCT repo (its PRD, backlog dep, backlog/).
const PRODUCT = resolveProject();
const DEFAULT_DOC = PRODUCT.prdPath || path.join(PRODUCT.repoRoot, "docs", "prd", "nexus-build-backlog.md");

/** The one header shared by the four feature-body tables. */
const HEADER = ["ID", "Recurso", "Porquê / fonte", "Prova", "Risco", "Situação"];

// ─── Parsing (pure) ─────────────────────────────────────────────────────────

/**
 * Split one markdown table row into trimmed cells, or null if the line isn't
 * a pipe-delimited row.
 * @param {string} line
 * @returns {string[] | null}
 */
function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.length < 2) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

/** True for a markdown table separator row (`|---|:--:|...`). */
function isSeparatorRow(cells) {
  return cells !== null && cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Extract every row from every table in the doc whose header matches the
 * shared feature-body header. Other tables (different header, e.g. "Onde o
 * fix vive" or "Plano de waves") are skipped by header mismatch. Rows are
 * returned in document order — Body C's C5 legitimately appears before C1
 * because it is the first data row under the Body C header.
 * @param {string} markdown
 * @returns {Array<{ id: string, recurso: string, porque: string, prova: string, risco: string, situacao: string }>}
 */
export function parseBacklogTables(markdown) {
  const lines = markdown.split("\n");
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const headerCells = splitRow(lines[i]);
    if (!headerCells || !arraysEqual(headerCells, HEADER)) continue;

    let j = i + 1;
    if (j < lines.length && isSeparatorRow(splitRow(lines[j]))) j++;

    for (; j < lines.length; j++) {
      const cells = splitRow(lines[j]);
      if (!cells || cells.length !== HEADER.length) break;
      const [id, recurso, porque, prova, risco, situacao] = cells;
      if (!/^[A-Za-z]\d+$/.test(id)) break;
      rows.push({ id, recurso, porque, prova, risco, situacao });
    }
    i = j - 1;
  }

  return rows;
}

/**
 * Normalize a free-form `Situação` cell into a board status + needs-verify
 * flag. Strips `**`, trims, lowercases, then matches the LEADING token.
 * Never throws — an unrecognized cell falls through to Intake + needs-verify.
 * @param {string} cell
 * @returns {{ status: string, needsVerify: boolean }}
 */
export function normalizeSituacao(cell) {
  const cleaned = (cell ?? "").replace(/\*\*/g, "").trim();
  const lower = cleaned.toLowerCase();

  if (lower.startsWith("done")) return { status: "Done", needsVerify: false };
  if (lower.startsWith("todo")) return { status: "Intake", needsVerify: false };
  if (lower.startsWith("building")) return { status: "Building", needsVerify: false };
  if (lower.startsWith("validating")) return { status: "Validating", needsVerify: false };
  if (lower.startsWith("planning")) return { status: "Planning", needsVerify: false };
  if (lower.startsWith("parcial") || lower.startsWith("verificar")) {
    return { status: "Intake", needsVerify: true };
  }
  return { status: "Intake", needsVerify: true };
}

/**
 * Pull the bold recurso name out of a `Recurso` cell (`**name** — rest...`).
 * Falls back to the text before the first em-dash, stripped of `**`, if no
 * bold segment is present.
 * @param {string} recurso
 * @returns {string}
 */
function recursoName(recurso) {
  const bold = recurso.match(/\*\*(.+?)\*\*/);
  if (bold) return bold[1].trim();
  return recurso.split(" — ")[0].replace(/\*\*/g, "").trim();
}

/**
 * Build the full original row content for the card description.
 * @param {{ porque: string, prova: string, situacao: string }} row
 * @returns {string}
 */
function buildDescription(row) {
  return [
    `Porquê / fonte: ${row.porque}`,
    `Prova: ${row.prova}`,
    `Situação (original): ${row.situacao}`,
  ].join("\n");
}

/**
 * Turn one parsed doc row into the card shape the CLI creates.
 * @param {{ id: string, recurso: string, porque: string, prova: string, risco: string, situacao: string }} row
 * @returns {{ title: string, description: string, labels: string[], status: string }}
 */
export function buildCard(row) {
  const letter = row.id[0].toUpperCase();
  const { status, needsVerify } = normalizeSituacao(row.situacao);
  const labels = [`body:${letter}`, `risk:${(row.risco ?? "").trim().toLowerCase()}`];
  if (needsVerify) labels.push("needs-verify");

  return {
    title: `${row.id} — ${recursoName(row.recurso)}`,
    description: buildDescription(row),
    labels,
    status,
  };
}

// ─── Backlog CLI (effects) ─────────────────────────────────────────────────

function resolveBacklogBin() {
  if (process.env.BACKLOG_BIN) return process.env.BACKLOG_BIN;
  const local = path.join(PRODUCT.repoRoot, "node_modules", ".bin", "backlog");
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

// ─── Import ─────────────────────────────────────────────────────────────────

/**
 * Create one card per doc row not already represented on the board (matched
 * by title prefix `<ID> — `). Returns counts; never mutates an existing card.
 * @param {string} docPath
 * @param {string} repoRoot
 * @param {(line: string) => void} emit
 * @returns {{ created: number, skipped: number } | { error: string }}
 */
function importRows(docPath, repoRoot, emit) {
  let markdown;
  try {
    markdown = readFileSync(docPath, "utf8");
  } catch (err) {
    return { error: `cannot read ${docPath}: ${err?.message ?? err}` };
  }

  const rows = parseBacklogTables(markdown);
  const backlog = makeBacklog(repoRoot);
  let existingTitles;
  try {
    existingTitles = new Set(
      parseTaskList(backlog(["task", "list", "--plain"]).stdout).map((c) => c.title),
    );
  } catch (err) {
    return { error: `cannot read existing cards: ${err?.message ?? err}` };
  }

  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const card = buildCard(row);
    const alreadyPresent = Array.from(existingTitles).some((t) => t.startsWith(`${row.id} — `));
    if (alreadyPresent) {
      skipped++;
      continue;
    }

    try {
      backlog([
        "task",
        "create",
        card.title,
        "-s",
        card.status,
        "-l",
        card.labels.join(","),
        "-d",
        card.description,
      ]);
    } catch (err) {
      return { error: `failed to create "${card.title}": ${err?.message ?? err}` };
    }
    created++;
    emit(`created ${card.title} -> ${card.status}`);
  }

  return { created, skipped };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" + "  node scripts/factory/board-import-backlog.mjs [--doc <path>] [--repo <path>]\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let doc;
  let repo;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--doc") doc = args[++i];
    else if (args[i] === "--repo") repo = args[++i];
    else positional.push(args[i]);
  }
  return { doc, repo, positional };
}

function main() {
  const { doc, repo, positional } = parseArgs(process.argv);
  if (positional.length > 0) {
    usage();
    return 2;
  }
  const docPath = doc ? path.resolve(doc) : DEFAULT_DOC;
  const repoRoot = repo ? path.resolve(repo) : PRODUCT.repoRoot;

  if (!existsSync(path.join(repoRoot, "backlog"))) {
    process.stdout.write(`no backlog/ under ${repoRoot} — nothing to import into\n`);
    return 0;
  }

  const result = importRows(docPath, repoRoot, (line) => process.stdout.write(`${line}\n`));
  if ("error" in result) {
    process.stderr.write(`${result.error}\n`);
    return 1;
  }

  process.stdout.write(`done: ${result.created} created, ${result.skipped} skipped\n`);
  return 0;
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

#!/usr/bin/env node
/**
 * show-review-log.mjs
 *
 * For each commit in `git log origin/main..HEAD`, prints:
 *   - hash + subject
 *   - modified files grouped by category
 *   - reviewer verdict + justification (from .quality-gate/review-log.jsonl)
 *   - WARNING if no review record found
 *
 * Always exits 0 (informational). Human aborts with Ctrl+C if anything looks wrong.
 */

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAllEntries } from "./lib/review-log.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", cwd: repoRoot });
  } catch (err) {
    return err.stdout?.toString() ?? "";
  }
}

function categorize(file) {
  if (file.startsWith("backend/test/e2e/real/") || file.startsWith("frontend/tests/e2e-real/"))
    return "E2E-REAL";
  if (file.startsWith("backend/test/") || file.startsWith("frontend/tests/")) return "TEST";
  if (file.startsWith(".husky/")) return "HOOK";
  if (
    file === "playwright.config.ts" ||
    file === "vitest.e2e.config.ts" ||
    file === ".claude/settings.json" ||
    file.endsWith("/playwright.config.ts") ||
    file.endsWith("/vitest.e2e.config.ts")
  )
    return "CONFIG";
  if (file === "quality-baseline.json") return "BASELINE";
  return "SOURCE";
}

function getCommits() {
  // origin/main may not exist (e.g. no remote, fresh worktree). Fall back gracefully.
  let raw = safeExec("git log --oneline origin/main..HEAD 2>/dev/null");
  if (!raw.trim()) {
    raw = safeExec("git log --oneline -5");
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(" ");
      return idx === -1
        ? { hash: line, subject: "" }
        : { hash: line.slice(0, idx), subject: line.slice(idx + 1) };
    });
}

function getCommitFiles(hash) {
  const out = safeExec(`git show --name-only --pretty=format: ${hash}`);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getCommitTimestamp(hash) {
  return safeExec(`git show -s --format=%cI ${hash}`).trim();
}

function findReviewEntryForCommit(reviewLog, hash) {
  // Prefer exact-hash match — `.husky/post-commit` backfills the hash into
  // the most recent "(staged)" entry after each commit.
  const exact = reviewLog.find((e) => e.commit === hash);
  if (exact) return exact;

  // Fallback: file-set + timestamp matching for entries written before the
  // post-commit backfill ran (older history, retried commits, etc.).
  const commitFiles = new Set(getCommitFiles(hash));
  const commitTs = new Date(getCommitTimestamp(hash)).getTime();

  let best = null;
  let bestTsDiff = Infinity;
  for (const entry of reviewLog) {
    if (!Array.isArray(entry.stagedFiles)) continue;
    const sameLen = entry.stagedFiles.length === commitFiles.size;
    if (!sameLen) continue;
    const sameSet = entry.stagedFiles.every((f) => commitFiles.has(f));
    if (!sameSet) continue;
    const entryTs = new Date(entry.ts).getTime();
    if (Number.isNaN(entryTs)) continue;
    if (entryTs > commitTs) continue;
    const diff = commitTs - entryTs;
    if (diff < bestTsDiff) {
      bestTsDiff = diff;
      best = entry;
    }
  }
  return best;
}

function main() {
  const commits = getCommits();
  if (commits.length === 0) {
    process.stdout.write(`${DIM}(no commits to display)${RESET}\n`);
    process.exit(0);
  }

  const reviewLog = loadAllEntries();

  for (const { hash, subject } of commits) {
    process.stdout.write(`\n${BOLD}${hash}${RESET} ${subject}\n`);

    const files = getCommitFiles(hash);
    if (files.length === 0) {
      process.stdout.write(`  ${DIM}(no files)${RESET}\n`);
      continue;
    }

    const grouped = new Map();
    for (const f of files) {
      const cat = categorize(f);
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat).push(f);
    }

    const order = ["E2E-REAL", "HOOK", "CONFIG", "BASELINE", "TEST", "SOURCE"];
    for (const cat of order) {
      if (!grouped.has(cat)) continue;
      const tagColor =
        cat === "E2E-REAL" || cat === "HOOK" || cat === "CONFIG"
          ? RED
          : cat === "BASELINE" || cat === "TEST"
            ? YELLOW
            : DIM;
      for (const f of grouped.get(cat)) {
        process.stdout.write(`  ${tagColor}[${cat}]${RESET} ${f}\n`);
      }
    }

    const entry = findReviewEntryForCommit(reviewLog, hash);
    if (!entry) {
      process.stdout.write(`  ${RED}${BOLD}⚠ NO REVIEW RECORD${RESET}\n`);
      continue;
    }

    if (entry.verdict === "reject" || entry.verdict === "escalate") {
      const label = entry.verdict === "reject" ? "REJECT" : "ESCALATE";
      process.stdout.write(`  ${RED}${BOLD}Verdict: ${label}${RESET}\n`);
      process.stdout.write(`  ${RED}Justification:${RESET} ${entry.justification}\n`);
      if (Array.isArray(entry.concerns) && entry.concerns.length > 0) {
        process.stdout.write(`  ${RED}Concerns:${RESET}\n`);
        for (const c of entry.concerns) {
          process.stdout.write(`    ${RED}- ${c}${RESET}\n`);
        }
      }
      if (Array.isArray(entry.findings) && entry.findings.length > 0) {
        process.stdout.write(`  ${RED}Findings:${RESET}\n`);
        for (const f of entry.findings) {
          process.stdout.write(`    ${RED}[${f.severity}] ${f.file} — ${f.issue} → ${f.fix}${RESET}\n`);
        }
      }
    } else {
      process.stdout.write(`  ${GREEN}Verdict: approve${RESET} — ${entry.justification}\n`);
    }
  }

  process.exit(0);
}

main();

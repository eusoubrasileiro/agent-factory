/**
 * review-log.mjs
 *
 * Shared accessor for `.quality-gate/review-log.jsonl` — the append-only log
 * of Sonnet-reviewer verdicts. Owns the path, the JSONL format, and the
 * read/write primitives used by `security-review.mjs` (writer),
 * `backfill-review-log-commit.mjs` (rewriter), and the readers
 * (`pr-comment-review.mjs`, `print-quality-delta.mjs`, `show-review-log.mjs`).
 *
 * Schema is permissive on purpose — the log is a forensic trail, not a
 * contract. Old entries must keep parsing forever.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");

/**
 * @typedef {Object} ReviewLogEntry
 * @property {string} ts                ISO timestamp.
 * @property {string} commit            Commit hash, or "(staged)" before post-commit backfill.
 * @property {string} verdict           "approve" | "reject" | "escalate" (other values tolerated).
 * @property {string[]} [sensitiveFiles] Subset of stagedFiles flagged as sensitive paths.
 * @property {string[]} [stagedFiles]   Files staged at review time.
 * @property {string} [justification]   Reviewer's 1-3 sentence explanation.
 * @property {string[]} [concerns]      Individual concerns; empty/absent on approve.
 * @property {Object[]} [findings]      Structured issues: {severity: "blocker"|"important"|"minor", file, issue, fix}. Empty/absent on approve.
 * @property {string} [rawOutput]       Truncated raw reviewer output when verdict was unparseable.
 * @property {string} [branch]          Git branch at review time. Absent on entries written before the fix-round bound existed; those are ignored by the round counter rather than guessed at.
 * @property {string} [why]             Haiku-resolved "why this PR exists" paragraph (Portuguese, 2-3 sentences) or the sentinel "Origem não clara — favor revisar manualmente". Read back by `pr-comment-review.mjs` to render the "## O que este PR resolve" lead section.
 */

export const REVIEW_LOG_PATH = join(repoRoot, ".quality-gate", "review-log.jsonl");

/**
 * Load every parseable entry, in file order (oldest first).
 * Unparseable lines are skipped with a warning to stderr.
 *
 * @returns {ReviewLogEntry[]}
 */
export function loadAllEntries() {
  if (!existsSync(REVIEW_LOG_PATH)) return [];
  const raw = readFileSync(REVIEW_LOG_PATH, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      console.warn(
        `[review-log] skipping unparseable line: ${line.slice(0, 120)}${line.length > 120 ? "…" : ""}`,
      );
    }
  }
  return entries;
}

/**
 * Most recent parseable entry, or null when the log is missing/empty.
 *
 * @returns {ReviewLogEntry | null}
 */
export function loadLatestEntry() {
  const entries = loadAllEntries();
  if (entries.length === 0) return null;
  return entries[entries.length - 1];
}

/**
 * Append a single entry as one JSON line. Creates the parent directory if
 * needed.
 *
 * @param {ReviewLogEntry} entry
 */
export function appendEntry(entry) {
  const dir = dirname(REVIEW_LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(REVIEW_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Atomically rewrite the entire log. Writes to a tmp file in the same
 * directory and renameSync's it over the target so a crash mid-write can
 * never leave a half-written log.
 *
 * @param {ReviewLogEntry[]} entries
 */
export function rewriteAllEntries(entries) {
  const dir = dirname(REVIEW_LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  const tmpPath = `${REVIEW_LOG_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, body, "utf8");
  renameSync(tmpPath, REVIEW_LOG_PATH);
}

/**
 * Max reviewer rejects on one branch before the loop must stop and escalate to
 * the owner. Ratified in `standards.md` and stated to workers in
 * `scripts/agent-prompt.md`; enforced here so it is a fact rather than an
 * instruction the reviewed agent may ignore.
 *
 * Why in code: the human gate sits at the coordinator, but the fix loop runs
 * inside dispatched workers — in parallel worktrees nobody opens. A bound that
 * only exists as prose in the worker's own prompt is advisory, and an agent
 * that ignores it is invisible.
 */
export const MAX_FIX_ROUNDS = 3;

/**
 * Reject/escalate rounds already recorded for `branch`.
 *
 * Entries without a `branch` are from before this field existed and are NOT
 * counted — an old log must never retro-escalate a fresh branch. Each worktree
 * carries its own `.quality-gate/`, so a dispatched worker counts only its own
 * attempts even before the branch filter applies.
 *
 * NOT tamper-proof: `.quality-gate/` is gitignored ephemera an agent could
 * delete. This bounds drift and honest looping, not deliberate evasion — the
 * same trust model as the rest of the harness.
 *
 * @param {string} branch
 * @param {ReviewLogEntry[]} [entries] Pre-loaded entries; loaded when omitted.
 * @returns {number}
 */
export function countFixRounds(branch, entries = loadAllEntries()) {
  if (!branch) return 0;
  return entries.filter(
    (e) => e.branch === branch && (e.verdict === "reject" || e.verdict === "escalate"),
  ).length;
}

/**
 * True once `branch` has already exhausted the bound — the loop is over and
 * the owner has to look. Checked before spending a reviewer call.
 *
 * @param {string} branch
 * @param {ReviewLogEntry[]} [entries]
 * @returns {boolean}
 */
export function hasEscalated(branch, entries = loadAllEntries()) {
  if (!branch) return false;
  return entries.some((e) => e.branch === branch && e.verdict === "escalate");
}

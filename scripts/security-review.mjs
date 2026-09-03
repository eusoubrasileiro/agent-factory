#!/usr/bin/env node
/**
 * security-review.mjs
 *
 * Final pre-push reviewer. Runs after lint, tsc, the full test suite, and
 * the deterministic quality-gate. Sends staged diff + commit message + the
 * quality-gate report to claude -p (Sonnet tier), appends the verdict to
 * .quality-gate/review-log.jsonl, and blocks the push (exit 1) on reject.
 *
 * Verdict space: "approve" | "reject". The 3-strike retry cap for dispatched
 * sub-agents is enforced by the agent contract in scripts/agent-prompt.md
 * (item 7), not by this script — this reviewer is stateless and judges each
 * run independently.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { callClaudeStructured } from "./lib/claude-cli.mjs";
import {
  appendEntry,
  countFixRounds,
  hasEscalated,
  loadAllEntries,
  MAX_FIX_ROUNDS,
} from "./lib/review-log.mjs";
import { loadPlan, summarizeWhy, WHY_SENTINEL } from "./lib/intent.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const QG_DIR = join(repoRoot, ".quality-gate");
const REPORT_PATH = join(QG_DIR, "report.json");
const COMMIT_MSG_PATH = join(repoRoot, ".git", "COMMIT_EDITMSG");

const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";

function safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf8", cwd: repoRoot, ...opts });
  } catch (err) {
    return err.stdout?.toString() ?? "";
  }
}

const ZERO_SHA = "0000000000000000000000000000000000000000";

function refExists(ref) {
  return Boolean(safeExec(`git rev-parse --verify --quiet ${ref}`).trim());
}

// The git range to review. Anchors at the merge-base with main so a
// force-pushed rebased branch is reviewed for what it actually adds to main
// — NOT for everything that came along during the rebase. The pre-push
// hook's PUSH_REMOTE_SHA is no longer trusted as a diff base because, after
// a rebase + force-push, it points at the pre-rebase commit, sweeping in
// files from main as "new on this branch".
function getPushRange() {
  const localSha = process.env.PUSH_LOCAL_SHA;
  const head = localSha && localSha !== ZERO_SHA ? localSha : "HEAD";

  const mainRef = refExists("origin/main") ? "origin/main" : "main";
  const mergeBase = safeExec(`git merge-base ${mainRef} ${head}`).trim();
  if (mergeBase) return `${mergeBase}..${head}`;

  // Fallback when merge-base can't be computed (shallow clone, detached
  // history): use the old PUSH_REMOTE_SHA path, then upstream, then main.
  const remoteSha = process.env.PUSH_REMOTE_SHA;
  if (remoteSha && remoteSha !== ZERO_SHA && localSha) return `${remoteSha}..${localSha}`;
  const upstream = safeExec("git rev-parse --abbrev-ref --symbolic-full-name @{u}").trim();
  if (upstream && refExists(upstream)) return `${upstream}..${head}`;
  return `${mainRef}..${head}`;
}

function getPushedFiles(range) {
  const out = safeExec(`git diff --name-only ${range}`);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function getPushedDiff(range) {
  return safeExec(`git diff ${range}`);
}

function loadReport() {
  if (!existsSync(REPORT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  } catch {
    return null;
  }
}

function loadCommitMessages(range) {
  // Concatenate every commit body in the push range. Falls back to the editor
  // buffer when invoked outside a push (no range resolvable).
  const log = safeExec(`git log --format=%B%x00 ${range}`);
  const messages = log
    .split("\x00")
    .map((s) => s.trim())
    .filter(Boolean);
  if (messages.length > 0) return messages.join("\n\n---\n\n");
  if (!existsSync(COMMIT_MSG_PATH)) return "";
  try {
    return readFileSync(COMMIT_MSG_PATH, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

function loadPrBody() {
  // Best-effort. Returns the GitHub PR body (markdown) when a PR exists for
  // the current branch, otherwise null. Silently skips when `gh` is missing
  // or unauthenticated.
  const out = safeExec("gh pr view --json body -q .body");
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function loadLinkedIssueBodies(prBody) {
  // Best-effort. Scans PR body for "(fixes|closes|resolves) #<n>" mentions
  // (case-insensitive), fetches each issue's title+body via `gh issue view`,
  // and concatenates. Any failure is silently skipped — issue lookup is a
  // nice-to-have, not a contract.
  if (!prBody) return null;
  const re = /\b(fixes|closes|resolves)\s+#(\d+)/gi;
  const seen = new Set();
  const sections = [];
  let m;
  while ((m = re.exec(prBody)) !== null) {
    const n = m[2];
    if (seen.has(n)) continue;
    seen.add(n);
    const out = safeExec(`gh issue view ${n} --json title,body`);
    if (!out) continue;
    try {
      const obj = JSON.parse(out);
      const title = (obj.title || "").trim();
      const body = (obj.body || "").trim();
      const section = [title ? `## #${n} — ${title}` : `## #${n}`, body].filter(Boolean).join("\n\n");
      if (section) sections.push(section);
    } catch {
      // ignore
    }
  }
  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

function getCurrentBranch() {
  return safeExec("git rev-parse --abbrev-ref HEAD").trim() || null;
}

/**
 * Branch key used when HEAD is detached and there is no branch name.
 * Deliberately NOT counted (see applyFixRoundBound): unrelated detached work
 * would otherwise share one bucket and hard-block a branch that never failed.
 */
export const UNKNOWN_BRANCH = "(unknown)";

/**
 * The Nth reject on a branch is not another reject — it is the end of the fix
 * loop. Returns a NEW entry; never mutates the input.
 *
 * Pure and exported so the bound is provable in a test rather than argued
 * about: the owner attends the coordinator, while the loop runs inside a
 * dispatched worker in a worktree nobody opens.
 *
 * @param {object} entry        The entry about to be appended.
 * @param {string} branch       Current branch.
 * @param {object[]} priorEntries Entries already in the log.
 * @returns {object}
 */
export function applyFixRoundBound(entry, branch, priorEntries) {
  if (entry.verdict !== "reject") return entry;
  if (!branch || branch === UNKNOWN_BRANCH) return entry;
  const roundsSoFar = countFixRounds(branch, priorEntries);
  if (roundsSoFar + 1 < MAX_FIX_ROUNDS) return entry;
  return {
    ...entry,
    verdict: "escalate",
    concerns: [
      ...(entry.concerns ?? []),
      `fix-round-bound-exhausted (${MAX_FIX_ROUNDS} rejects on ${branch})`,
    ],
  };
}

function buildPrompt(diff, report, files, commitMessage, whyParagraph, planBody) {
  const reportSummary = report
    ? JSON.stringify(
        {
          overall: report.overall,
          regressions: report.regressions,
          metrics: report.metrics,
          deltas: report.deltas,
        },
        null,
        2,
      )
    : "(no report available)";

  const MAX_DIFF = 200_000;
  const diffSection =
    diff.length > MAX_DIFF
      ? `${diff.slice(0, MAX_DIFF)}\n\n[... diff truncated, ${diff.length - MAX_DIFF} more chars ...]`
      : diff;

  const contextSection = whyParagraph
    ? `# Context — why this PR exists (resolved by Haiku from PLAN.md / PR body / commits / linked issues)\n${whyParagraph}\n\nUse this to flag scope drift (e.g. diff touches things the stated motivation does not justify).\n\n`
    : "";

  // The contract itself, not just Haiku's 2-3 sentence distillation of it.
  // Without this the reviewer can only answer "did this go BEYOND the plan?"
  // (drift) and never "did this DO the plan?" (completeness) — so a worker
  // that ships 60% of its contract, cleanly and in scope, approves.
  const MAX_PLAN = 8_000;
  const planSection = planBody
    ? `# The contract this work was dispatched against (.claude/PLAN.md, verbatim)
${planBody.length > MAX_PLAN ? `${planBody.slice(0, MAX_PLAN)}\n[... plan truncated ...]` : planBody}

Judge the diff against this, not only against the Context paragraph above.
Under-delivery is a finding, not automatically a reject — plans are often
delivered across several pushes. Raise it as severity "important" with the
specific unmet item named, and reject only when the diff CONTRADICTS the
contract or claims work it did not do.

`
    : "";

  return `${contextSection}${planSection}You are an integrity reviewer for the AmiticIA factory engine — the plan/build/validate orchestration codebase, whose one architectural rule is that the engine knows the SHAPE and only a project profile knows the FACTS. Review the staged commit and decide whether to APPROVE or REJECT.

# Completeness (only when a contract is shown above)
- Name any contract item the diff does not deliver as a finding of severity "important", quoting the unmet item.
- Do NOT reject for partial delivery alone — staged delivery across pushes is normal and legitimate.
- DO reject when the diff contradicts the contract, or when its commit messages / PR text claim work the diff does not contain.

# Approve when
- New tests added (assertion count grew) alongside source changes.
- Refactors with stable assertion counts and clearly justified test changes.
- Pure simplification, dead-code removal, renames, formatting, comments — no test addition required.
- Bugfix commits (\`fix:\`/\`bug:\`/\`hotfix:\`) with at least one new assertion that reproduces the bug.
- Docs, config, dependency bumps with no behavioral change.

# Reject when
- Commit message starts with \`fix:\`, \`bug:\`, or \`hotfix:\` and assertion count did not grow → "missing regression test for bugfix".
- A new file under \`backend/src/lib/**\`, \`backend/src/routes/**\`, \`backend/src/services/**\` (excluding the critical-paths list below), or \`frontend/src/hooks/**\` was added without a corresponding new \`*.test.ts\` → "new module without sibling test".
- Source files changed but no test files changed AND the diff is NOT purely cosmetic (renames / comments / formatting / dead-code removal / pure simplification) → "source change requires test update; explain or add test".
- Test assertion count decreased without a corresponding source-module deletion.
- \`.skip(\`, \`.only(\`, \`xit(\`, or \`xdescribe(\` introduced.
- Files under \`backend/test/e2e/real/**\` or \`frontend/tests/e2e-real/**\` modified.
- \`.husky/**\`, \`.claude/settings.json\`, or \`commitlint.config.cjs\` modified.
- \`quality-baseline.json\` loosened with no visible source-level improvement explaining it.
- Any of these critical paths modified — these require human approval, never agent edits:
  - \`scripts/verdict.mjs\`, \`scripts/ratify.mjs\`, \`scripts/metrics.mjs\` — the control scripts that decide whether work passed.
  - \`scripts/cage-settings.mjs\`, \`scripts/lib/project.mjs\` — the containment renderer and the profile loader.
  - \`templates/**\`, \`projects/**\` — the mission scaffolding and the per-project facts.
  - \`constitution.md\`, \`decisions.md\` — the ratified record.
  - \`.husky/**\`, \`.claude/settings.json\`, \`commitlint.config.cjs\` — the gate itself.

Also REJECT any product name (a project id under \`projects/\`, e.g. a specific
product's slug) appearing as a literal in \`scripts/\`, \`scripts/lib/\`,
\`templates/\` or \`skills/\`. The engine carries no product facts; that is what
\`scripts/project-profile.test.mjs\` PART 2 exists to enforce.

# Judgment notes
- Be conservative on cosmetic vs behavioral. Renames, dead-code removal, simplification of existing logic, comment changes — NOT a reject for missing tests.
- A diff that removes a function and its test together is fine.
- Empty arrays/objects, type-only changes, and JSDoc edits do NOT need new tests.
- When in doubt on TDD strictness, lean approve and put the concern in \`concerns\` for visibility.

# Output

Output is constrained by a JSON schema enforced server-side. Fields:
- \`verdict\`: \`"approve"\` or \`"reject"\`.
- \`justification\`: 3-6 sentences covering what the diff changes, the main risks you considered, and why you approve (or reject). Plain prose; embedded quotes are fine.
- \`concerns\`: array of strings. May be empty on approve. On reject, MUST list each individual issue as its own array entry.
- \`findings\`: optional array of structured issues. On reject, ALSO emit one entry per concrete issue in \`concerns\`, each shaped \`{severity, file, issue, fix}\`: \`severity\` is \`"blocker"\` (must fix before push), \`"important"\` (must fix or explicitly waive), or \`"minor"\` (advisory); \`file\` is the repo-relative path; \`issue\` is a one-sentence description; \`fix\` is a concrete suggested fix. \`concerns\` remains the human-readable summary — \`findings\` is the structured breakdown of the same issues.

A \`blocker\` finding and an \`"approve"\` verdict contradict each other. If you emit any \`blocker\`, the verdict MUST be \`"reject"\` — the harness enforces this and will override an \`"approve"\` that carries one, so state the verdict you actually mean. If an issue is worth naming but should not stop the push, give it \`"important"\` or \`"minor"\` instead.

# Commit message
${commitMessage || "(empty)"}

# Files staged
${files.map((f) => `- ${f}`).join("\n") || "(none)"}

# Quality-gate report
\`\`\`json
${reportSummary}
\`\`\`

# Staged diff
\`\`\`diff
${diffSection}
\`\`\`
`;
}

// Severity vocabulary, shared by the schema and the shape check below so the
// two can never drift apart.
const SEVERITIES = ["blocker", "important", "minor"];

// JSON Schema enforced server-side by `claude -p --json-schema`. The CLI
// validates the model's structured_output against this before returning,
// so the parser below is a single field read — no regex fallbacks needed.
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "reject"] },
    justification: { type: "string" },
    concerns: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          file: { type: "string" },
          issue: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "file", "issue", "fix"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "justification", "concerns"],
  additionalProperties: false,
};

// Validate the schema-enforced payload's field shape. The CLI's
// `--json-schema` flag enforces structure server-side, so this is a defensive
// post-check: if reality contradicts the schema (CLI bug, envelope drift),
// we want to fail-closed rather than crash on `verdict.toUpperCase()` later.
function isWellShapedFinding(f) {
  if (!f || typeof f !== "object") return false;
  if (!SEVERITIES.includes(f.severity)) return false;
  if (typeof f.file !== "string") return false;
  if (typeof f.issue !== "string") return false;
  if (typeof f.fix !== "string") return false;
  return true;
}

// The model never emits an id — assigning one here (not in the schema) keeps
// it deterministic and always present, immune to the model skipping/renaming
// the field. Index-based (`f1`, `f2`, ...) rather than a content hash: findings
// are only ever read back within the same array (review-pr → prepare-pr →
// merge-pr), so positional stability for one review-log entry is all the
// pipeline needs, and it's trivially readable in logs/PR comments.
function assignFindingIds(findings) {
  return findings.map((f, i) => ({ id: `f${i + 1}`, ...f }));
}

function validateVerdict(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.verdict !== "approve" && payload.verdict !== "reject") return null;
  if (typeof payload.justification !== "string") return null;
  if (!Array.isArray(payload.concerns)) return null;
  if (payload.findings !== undefined) {
    if (!Array.isArray(payload.findings) || !payload.findings.every(isWellShapedFinding)) {
      return null;
    }
  }

  // The stated verdict is not trusted over the findings it carries. A model
  // that names a `blocker` — defined to the model as "must fix before push" —
  // and stamps "approve" in the same response is contradicting itself, and the
  // severity wins. Without this the gate is only as reliable as the model's
  // bookkeeping: the whole review can be sound and still ship, because one
  // field said the wrong word.
  //
  // `important` deliberately does NOT flip. It is defined as "must fix OR
  // explicitly waive", and the waiver is a human act the model cannot perform
  // — but flipping on it would newly block pushes that pass today, on no
  // evidence about how often the model pairs one with an approve. It is
  // flagged instead, so tightening this later is a decision made from the
  // review log rather than a guess.
  const findings = payload.findings ?? [];
  const wasApprove = payload.verdict === "approve";
  payload.blockerOnApprove = wasApprove && findings.some((f) => f.severity === "blocker");
  payload.importantOnApprove =
    wasApprove && findings.some((f) => f.severity === "important");
  if (payload.blockerOnApprove) payload.verdict = "reject";

  return payload;
}

function main() {
  const range = getPushRange();
  // Round-bound key, resolved up front: both the pre-flight below and the
  // no-commits early exit stamp it. A dispatched worker lives on `agent/<slug>`
  // in its own worktree, so this is one counter per worker per task.
  const branch = getCurrentBranch() ?? UNKNOWN_BRANCH;
  const pushedFiles = getPushedFiles(range);

  if (pushedFiles.length === 0) {
    const entry = {
      ts: new Date().toISOString(),
      branch,
      commit: process.env.PUSH_LOCAL_SHA || "HEAD",
      verdict: "approve",
      sensitiveFiles: [],
      stagedFiles: [],
      justification: `No commits in push range (${range}) — nothing to review.`,
      concerns: [],
      why: WHY_SENTINEL,
    };
    appendEntry(entry);
    process.exit(0);
  }

  // ── Fix-round bound (enforced here, not in the worker's prompt) ───────────
  // The owner watches the coordinator; the fix loop runs inside dispatched
  // workers, in parallel worktrees nobody opens. A bound that lives only as
  // prose in the reviewed agent's own prompt is advisory and its breach is
  // invisible. Counted per branch from the review log.
  if (hasEscalated(branch)) {
    process.stderr.write(`${RED}\n=== PUSH BLOCKED — this branch already escalated ===${RESET}\n`);
    process.stderr.write(
      `${RED}${MAX_FIX_ROUNDS} reviewer rejects were recorded on \`${branch}\`. The fix loop is over.${RESET}\n` +
        `${RED}Do not retry. Report to the owner: the final reject reason, ` +
        `\`git diff --stat main...HEAD\`, and one line per attempt saying what you changed.${RESET}\n`,
    );
    process.exit(1);
  }

  const diff = getPushedDiff(range);
  const report = loadReport();
  const commitMessage = loadCommitMessages(range);

  // Resolve the "why this PR exists" paragraph ONCE. Haiku reads from PLAN.md
  // when present (dispatched work) or PR body / commit bodies / linked issues
  // (ad-hoc). The Sonnet reviewer sees this as a "Context" preface so it can
  // flag scope drift; the comment poster reads it back from the review-log
  // entry to render the "## O que este PR resolve" lead section.
  const plan = loadPlan(repoRoot);
  const prBody = loadPrBody();
  const issueBodies = loadLinkedIssueBodies(prBody);
  const whyParagraph = summarizeWhy({
    plan,
    prBody,
    commits: commitMessage,
    issueBodies,
    branch,
  });

  const prompt = buildPrompt(diff, report, pushedFiles, commitMessage, whyParagraph);

  const claudeResult = callClaudeStructured({
    model: "sonnet",
    schema: VERDICT_SCHEMA,
    input: prompt,
    cwd: repoRoot,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!claudeResult.ok) {
    const entry = {
      ts: new Date().toISOString(),
      branch,
      commit: "(staged)",
      verdict: "reject",
      sensitiveFiles: [],
      stagedFiles: pushedFiles,
      justification: `Reviewer unavailable; push blocked. Error: ${claudeResult.error}`,
      concerns: ["security-reviewer-unavailable"],
      why: whyParagraph,
    };
    appendEntry(entry);
    process.stderr.write(`${RED}\n=== PUSH BLOCKED ===${RESET}\n`);
    process.stderr.write(
      `${RED}Reviewer unavailable: ${claudeResult.error}${RESET}\n`,
    );
    process.exit(1);
  }

  const verdict = validateVerdict(claudeResult.payload);
  if (!verdict) {
    const entry = {
      ts: new Date().toISOString(),
      branch,
      commit: "(staged)",
      verdict: "reject",
      sensitiveFiles: [],
      stagedFiles: pushedFiles,
      justification:
        "Reviewer payload passed CLI schema validation but the field shape was unexpected. Push blocked.",
      concerns: ["unparseable-verdict"],
      rawPayload: JSON.stringify(claudeResult.payload).slice(0, 4000),
      why: whyParagraph,
    };
    appendEntry(entry);
    process.stderr.write(`${RED}\n=== PUSH BLOCKED ===${RESET}\n`);
    process.stderr.write(
      `${RED}Reviewer payload failed shape validation. Payload (first 1000 chars):${RESET}\n${JSON.stringify(claudeResult.payload).slice(0, 1000)}\n`,
    );
    process.exit(1);
  }

  const entry = {
    ts: new Date().toISOString(),
    branch,
    commit: "(staged)",
    verdict: verdict.verdict,
    sensitiveFiles: pushedFiles.filter((f) =>
      f.startsWith("projects/") ||
      f.startsWith("templates/") ||
      f.startsWith("skills/") ||
      f.startsWith(".husky/") ||
      f === "scripts/verdict.mjs" ||
      f === "scripts/ratify.mjs" ||
      f === "scripts/metrics.mjs" ||
      f === "scripts/cage-settings.mjs" ||
      f === "scripts/lib/project.mjs" ||
      f === "constitution.md" ||
      f === "decisions.md" ||
      f === ".claude/settings.json" ||
      f === "commitlint.config.cjs",
    ),
    stagedFiles: pushedFiles,
    justification: verdict.justification ?? "",
    concerns: Array.isArray(verdict.concerns) ? verdict.concerns : [],
    findings: assignFindingIds(Array.isArray(verdict.findings) ? verdict.findings : []),
    // Recorded so the choice to keep `important` non-blocking stays reviewable
    // from the log instead of from memory.
    verdictOverridden: verdict.blockerOnApprove === true,
    importantOnApprove: verdict.importantOnApprove === true,
    why: whyParagraph,
  };
  // `show-review-log.mjs` renders an "escalate" verdict; until now nothing ever
  // wrote one. Decision lives in applyFixRoundBound (tested).
  entry = applyFixRoundBound(entry, branch, loadAllEntries());

  appendEntry(entry);

  if (entry.verdict === "escalate") {
    process.stderr.write(`${RED}\n=== ESCALATED — fix loop exhausted ===${RESET}\n`);
    process.stderr.write(
      `${RED}${MAX_FIX_ROUNDS} reviewer rejects on \`${branch}\`. STOP: do not push, do not open a PR.${RESET}\n` +
        `${RED}Report to the owner: this reject reason, \`git diff --stat main...HEAD\`, ` +
        `and one line per attempt saying what you changed.${RESET}\n\n` +
        `${RED}Reason: ${entry.justification}${RESET}\n`,
    );
    process.exit(1);
  }

  if (verdict.verdict === "reject") {
    process.stderr.write(`${RED}\n=== COMMIT REJECTED ===${RESET}\n`);
    if (entry.verdictOverridden) {
      process.stderr.write(
        `${RED}(The reviewer stamped "approve" while listing a blocker finding. ` +
          `The blocker wins — see the findings below.)${RESET}\n`,
      );
    }
    process.stderr.write(`${RED}Justification:${RESET} ${entry.justification}\n`);
    if (entry.concerns.length > 0) {
      process.stderr.write(`${RED}Concerns:${RESET}\n`);
      for (const c of entry.concerns) {
        process.stderr.write(`  ${RED}- ${c}${RESET}\n`);
      }
    }
    // A model that approved-with-a-blocker usually leaves `concerns` empty,
    // since it did not think it was rejecting. Print the findings so the block
    // is never reasonless.
    if (entry.findings.length > 0) {
      process.stderr.write(`${RED}Findings:${RESET}\n`);
      for (const f of entry.findings) {
        process.stderr.write(
          `  ${RED}- [${f.severity}] ${f.file}: ${f.issue}${RESET}\n    fix: ${f.fix}\n`,
        );
      }
    }
    process.stderr.write(`${RED}Commit blocked. Address the concerns above and try again.${RESET}\n\n`);
    process.exit(1);
  }

  if (entry.importantOnApprove) {
    process.stderr.write(
      `${RED}[security-review] NOTE${RESET}: approved with an "important" finding — ` +
        `not a block, but read it before pushing:\n`,
    );
    for (const f of entry.findings.filter((f) => f.severity === "important")) {
      process.stderr.write(`  - ${f.file}: ${f.issue}\n    fix: ${f.fix}\n`);
    }
  }

  process.stdout.write(
    `${GREEN}[security-review] APPROVE${RESET}: ${entry.justification}\n`,
    plan,
  );
  process.exit(0);
}

// Exported for scripts/security-review.test.mjs. Pure and side-effect free —
// the executable behaviour stays behind the run-as-script guard below.
export { validateVerdict, getPushRange, SEVERITIES, VERDICT_SCHEMA };

// Only run the gate when executed directly (`node scripts/security-review.mjs`),
// never when imported by a test. Without this, importing the module would run a
// real review and call process.exit().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

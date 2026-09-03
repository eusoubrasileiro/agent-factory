/**
 * intent.mjs
 *
 * Resolves the "why this PR exists" paragraph for `pnpm pr:create`.
 *
 * `loadPlan(cwd)` looks for `.claude/PLAN.md` at the worktree root (the file
 * copied in by `scripts/dispatch-worktree.sh` from `.claude/plans/<slug>.md`
 * — see the plan-driven-dispatch design). Returns the trimmed body or null.
 *
 * `summarizeWhy({plan, prBody, commits, issueBodies, branch})` shells out to
 * `claude -p --model haiku` with the system prompt at
 * `scripts/prompts/why-summarize.md`. Always runs; only the inputs change.
 * Returns a 2-3 sentence Portuguese paragraph, OR the literal sentinel
 * "Origem não clara — favor revisar manualmente" when no source carries a
 * clear motivation. Best-effort: any failure falls back to the sentinel.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { callClaudeStructured } from "./claude-cli.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptsRoot = resolve(__dirname, "..");

export const WHY_SENTINEL = "Origem não clara — favor revisar manualmente";

const SYSTEM_PROMPT_PATH = join(scriptsRoot, "prompts", "why-summarize.md");

// JSON Schema enforced server-side by `claude -p --json-schema`. The model
// returns a boolean flag for "origin clear" — when false, we substitute the
// canonical Portuguese sentinel in JS rather than trusting the LLM to spell
// it exactly. Keeps the sentinel a fixed, audit-able constant.
const WHY_SCHEMA = {
  type: "object",
  properties: {
    origin_clear: { type: "boolean" },
    paragraph: { type: "string" },
  },
  required: ["origin_clear", "paragraph"],
  additionalProperties: false,
};

/**
 * Look for `.claude/PLAN.md` at the worktree root.
 *
 * @param {string} cwd Worktree root (typically `git rev-parse --show-toplevel`).
 * @returns {string | null} Trimmed plan body, or null when absent / empty.
 */
export function loadPlan(cwd) {
  if (!cwd) return null;
  const planPath = join(cwd, ".claude", "PLAN.md");
  if (!existsSync(planPath)) return null;
  try {
    const body = readFileSync(planPath, "utf8").trim();
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

function loadSystemPrompt() {
  try {
    return readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  } catch {
    return null;
  }
}

function buildInputBlock({ plan, prBody, commits, issueBodies, branch }) {
  const section = (label, value) => {
    if (!value || (typeof value === "string" && value.trim().length === 0)) {
      return `# ${label}\n\n(vazio)`;
    }
    return `# ${label}\n\n${typeof value === "string" ? value.trim() : String(value)}`;
  };
  return [
    section("PLAN.md (contrato do dispatch — fonte preferida quando presente)", plan),
    section("Corpo do PR", prBody),
    section("Mensagens de commit (corpos completos)", commits),
    section("Corpos de issues vinculadas", issueBodies),
    section("Nome do branch", branch),
  ].join("\n\n");
}

/**
 * Produce the "why this PR exists" paragraph by shelling out to Haiku.
 *
 * @param {{plan: (string|null), prBody: (string|null), commits: (string|null), issueBodies: (string|null), branch: (string|null)}} inputs
 * @returns {string} A 2-3 sentence Portuguese paragraph, or WHY_SENTINEL on
 *   missing-source / failure.
 */
export function summarizeWhy(inputs) {
  const system = loadSystemPrompt();
  if (!system) return WHY_SENTINEL;

  const inputBlock = buildInputBlock(inputs);
  const fullPrompt = `${system}\n\n---\n\n# Fontes\n\n${inputBlock}`;

  // Best-effort: any CLI / envelope failure collapses to the sentinel. The
  // sentinel is also returned when the model says origin is unclear or the
  // paragraph comes back empty.
  const result = callClaudeStructured({
    model: "haiku",
    schema: WHY_SCHEMA,
    input: fullPrompt,
  });
  if (!result.ok) return WHY_SENTINEL;

  const payload = result.payload;
  if (typeof payload.origin_clear !== "boolean") return WHY_SENTINEL;
  if (typeof payload.paragraph !== "string") return WHY_SENTINEL;
  if (payload.origin_clear === false) return WHY_SENTINEL;

  const paragraph = payload.paragraph.trim();
  return paragraph.length > 0 ? paragraph : WHY_SENTINEL;
}

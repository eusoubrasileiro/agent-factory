/**
 * claude-cli.mjs
 *
 * Single owner of the `claude -p --output-format json --json-schema`
 * invocation pattern. Spawns the CLI, unwraps the JSON envelope, and returns
 * either the schema-enforced payload (under `envelope.structured_output`) or
 * a structured error describing what went wrong. Callers decide their own
 * field-shape validation and fail-open/fail-closed policy.
 */

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * Opt-in DeepSeek routing for the LLM reviewer.
 *
 * Set `REVIEW_BACKEND=deepseek` (+ `DEEPSEEK_API_KEY`) to run the reviewer on
 * DeepSeek V4 Pro instead of Anthropic — keeps automated `claude -p` traffic
 * off the metered Anthropic credit. Routing is per-model: only models in
 * `DEEPSEEK_MODEL_MAP` move; everything else (the Haiku intent stage) stays on
 * Anthropic. Unset `REVIEW_BACKEND` => byte-identical legacy behaviour.
 *
 * The map is keyed on the exact string callers pass as `model`. Callers pass
 * the CLI's *tier alias* ("sonnet"), never a pinned point release, so the
 * reviewer follows the current Sonnet with no edit here. Keep this key equal
 * to what the callers pass: a stale key silently disables routing rather than
 * erroring.
 */
const DEEPSEEK_ANTHROPIC_URL = "https://api.deepseek.com/anthropic";
const DEEPSEEK_MODEL_MAP = { "sonnet": "deepseek-v4-pro" };

/**
 * Resolve which model + subprocess env a `claude -p` call should use.
 *
 * @param {string} model        Requested model alias.
 * @param {object} [env=process.env]  Environment to read flags from.
 * @returns {{model: string, spawnEnv: object, note: string|null}}
 *   `note` is a human-readable line to log when behaviour deviates from the
 *   plain Anthropic path (routed, or requested-but-fell-back); else null.
 */
export function resolveBackend(model, env = process.env) {
  if (env.REVIEW_BACKEND !== "deepseek") return { model, spawnEnv: env, note: null };

  const deepseekModel = DEEPSEEK_MODEL_MAP[model];
  if (!deepseekModel) return { model, spawnEnv: env, note: null };

  if (!env.DEEPSEEK_API_KEY) {
    return {
      model,
      spawnEnv: env,
      note: `REVIEW_BACKEND=deepseek but DEEPSEEK_API_KEY is unset — falling back to Anthropic for ${model}`,
    };
  }

  const spawnEnv = {
    ...env,
    ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_URL,
    ANTHROPIC_AUTH_TOKEN: env.DEEPSEEK_API_KEY,
  };
  // Drop ANTHROPIC_API_KEY so the CLI cannot prefer it over the routed token.
  delete spawnEnv.ANTHROPIC_API_KEY;
  return { model: deepseekModel, spawnEnv, note: `routed ${model} -> ${deepseekModel} via DeepSeek` };
}

/**
 * Call `claude -p` with server-side JSON schema enforcement.
 *
 * @param {object} opts
 * @param {string} opts.model     Model *tier alias* — "sonnet" or "haiku". The
 *                                CLI resolves it to the current model of that
 *                                tier; never pin a point release here.
 * @param {object} opts.schema    JSON Schema object passed to `--json-schema`.
 * @param {string} opts.input     Prompt text fed via stdin.
 * @param {number} [opts.maxBuffer=10485760]  spawnSync maxBuffer (default 10MB).
 * @param {string} [opts.cwd]     Working directory for the subprocess. Defaults
 *   to a neutral tmpdir so the project CLAUDE.md cascade does not auto-load.
 * @returns {{ok: true, payload: object} | {ok: false, error: string}}
 *   `payload` is `envelope.structured_output` — untyped, caller validates
 *   the specific field shape it expects. `error` is a single-sentence
 *   human-readable reason on any failure path.
 */
export function callClaudeStructured({ model, schema, input, maxBuffer = 10 * 1024 * 1024, cwd }) {
  const { model: resolvedModel, spawnEnv, note } = resolveBackend(model);
  if (note) console.error(`[claude-cli] ${note}`);

  // These are one-shot judges/summarizers that reason ONLY over text passed in
  // the prompt — they read no files and call no tools. The flags below keep the
  // call lean and side-effect-free:
  //   --no-session-persistence  never written as a resumable session (these
  //                             one-shots used to pollute `claude --resume`).
  //   --strict-mcp-config       with no --mcp-config, loads zero MCP servers.
  //   --tools ""                drops all tool schemas (the calls use none).
  //   cwd → tmpdir() (default)  a neutral dir so the project CLAUDE.md cascade
  //                             does NOT auto-load into the judge; it relies only
  //                             on its explicit prompt rules.
  // Together these cut per-call context ~35k→~8k tokens. --bare is intentionally
  // NOT used: it disables OAuth/keychain auth, and the harness logs in via OAuth
  // (no ANTHROPIC_API_KEY in the hook env).
  const result = spawnSync(
    "claude",
    [
      "-p",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--tools",
      "",
      "--model",
      resolvedModel,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
    ],
    {
      input,
      encoding: "utf8",
      maxBuffer,
      env: spawnEnv,
      cwd: cwd ?? tmpdir(),
    },
  );

  if (result.error) {
    return { ok: false, error: `claude CLI invocation failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `claude CLI exited with code ${result.status}: ${result.stderr || result.stdout || "(no output)"}`,
    };
  }

  const trimmed = (result.stdout || "").trim();
  if (!trimmed) {
    return { ok: false, error: "claude CLI returned empty stdout" };
  }

  let envelope;
  try {
    envelope = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `claude envelope parse failed: ${err.message}` };
  }

  const payload = envelope?.structured_output;
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "claude envelope missing structured_output object" };
  }

  return { ok: true, payload };
}

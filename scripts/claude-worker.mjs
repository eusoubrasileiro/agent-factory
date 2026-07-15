#!/usr/bin/env node
/**
 * claude-worker.mjs — the CAGED external builder seat (Claude Code → z.ai/GLM).
 *
 * This is the seat the plan always called for (`docs/glm-cage-briefing.md` §3,
 * "Claude Code as the caged seat"), and the reason is empirical, not aesthetic:
 *
 *   - Claude Code's `permissions.deny` on a Critical File is a **proven** boundary
 *     (cage-research M1: positive AND negative control in the same run).
 *     opencode's equivalent is asserted by its docs and unproven by us (D-17).
 *   - `claude -p` against `https://api.z.ai/api/anthropic` runs GLM on the SAME flat
 *     z.ai coding plan opencode uses. Zero Anthropic tokens. The "opencode saves
 *     Anthropic money" rationale never actually distinguished the two.
 *   - One driver, one cage (`cage-settings.mjs`), instead of two of each.
 *
 * WHAT THE CAGE DOES NOT DO (D-11, unchanged and worth repeating): an Edit/Write
 * deny stops Claude's own file tools. It does NOT stop `python3 -c "open('.env').read()"`.
 * Secrets are contained by the dummy `.env` in the worktree, not by a deny rule. The
 * OS sandbox that would close that is machine-gated OFF here (D-18).
 *
 * TWO FAIL-CLOSED GUARDS, because both failures are silent and expensive:
 *   1. `assertExternalEndpoint` — no base URL, an anthropic.com base URL, or no token
 *      means we would quietly bill Andre's Anthropic account for a seat that is
 *      supposed to be flat-rate. Refuse to spawn.
 *   2. `writeCageSettings` — a cage that cannot be written, or that fails its own
 *      audit, means no cage. Refuse to spawn unless `--allow-uncaged`.
 *
 * Usage:
 *   node scripts/claude-worker.mjs \
 *     --dir <worktree> --model <model> --project <id> \
 *     (--prompt "<text>" | --prompt-file <path>) \
 *     [--slug <slug>] [--metric-seat worker|validator] \
 *     [--session <id>] [--continue] [--timeout <ms>] [--json-out <path>] \
 *     [--allow-any-dir] [--allow-uncaged] [--allow-anthropic] [--creds <path>]
 *
 * `--project` is REQUIRED and must name a known profile (`projects/<id>/`): the
 * cage's Critical-File deny rules and this run's telemetry routing both come from
 * it. An absent or unknown id is refused (exit 2), not defaulted — a forgotten flag
 * would otherwise render a cage with zero Critical-File protections and say nothing.
 *
 * `--allow-anthropic` opts INTO Anthropic-hosted models (e.g. `--model sonnet`), which
 * spend Anthropic tokens or the operator's plan quota rather than the flat z.ai plan.
 * The seat stays caged either way. Without the flag, an anthropic.com endpoint (or a
 * missing base URL, which falls back to one) is refused.
 *
 * Exit codes:
 *   0 the seat finished (claude exited 0)
 *   1 claude errored / timed out / produced no result event
 *   2 usage error, absent/unknown --project, worktree-confinement violation,
 *     missing credentials, or no cage
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cageSettingsPath, mcpConfigPath, writeCageSettings } from "./cage-settings.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { resolveProject } from "./lib/project.mjs";
import { assertKnownProject, DEFAULT_GRACE_MS, killGracefully } from "./lib/worker-common.mjs";
import { buildPhaseEndEvent, buildPhaseStartEvent, buildSpawnEnv, isWorktreeDir } from "./opencode-worker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const METRICS_SCRIPT = path.join(__dirname, "metrics.mjs");
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CREDS_PATH = path.join(homedir(), ".config", "amiticia", "zai.env");

/**
 * The ONLY env keys lifted out of the seat credentials file. An allowlist, not a
 * passthrough: the file is machine-local and could grow other secrets, and none of
 * them are this seat's business.
 */
export const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "API_TIMEOUT_MS",
];

// ─── Pure core (unit-tested) ─────────────────────────────────────────────────

/**
 * Read the machine-local seat credentials (`~/.config/amiticia/zai.env`, 0600).
 * Missing file → `{}`, never throws: the CLI turns that into a clear refusal.
 * @param {string} [credsPath] @returns {Record<string,string>}
 */
export function loadSeatCredentials(credsPath = DEFAULT_CREDS_PATH) {
  if (!existsSync(credsPath)) return {};
  let text = "";
  try {
    text = readFileSync(credsPath, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!CLAUDE_ENV_KEYS.includes(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Refuse to run this seat against Anthropic's own API.
 *
 * The whole economic premise is that the external seat costs zero Anthropic tokens.
 * If `ANTHROPIC_BASE_URL` is missing, Claude Code happily falls back to Anthropic and
 * the operator's OAuth — a seat that was supposed to be flat-rate quietly bills real
 * money, and nothing in the output says so. Fail closed, loudly, before spawn.
 *
 * Never interpolate the token into the message.
 * @param {Record<string,string>} creds
 */
export function assertExternalEndpoint(creds) {
  const base = creds?.ANTHROPIC_BASE_URL;
  if (!base) {
    throw new Error(
      "refusing to spawn: ANTHROPIC_BASE_URL is unset, so Claude Code would fall back to " +
        "Anthropic's API and bill real money for a seat that must run on the flat z.ai plan.",
    );
  }
  let host = "";
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    throw new Error(`refusing to spawn: ANTHROPIC_BASE_URL is not a URL: ${base}`);
  }
  if (host === "anthropic.com" || host.endsWith(".anthropic.com")) {
    throw new Error(
      `refusing to spawn: ANTHROPIC_BASE_URL points at anthropic.com (${host}). ` +
        "This seat exists to run off the flat z.ai plan, not to spend Anthropic tokens.",
    );
  }
  if (!creds.ANTHROPIC_AUTH_TOKEN && !creds.ANTHROPIC_API_KEY) {
    throw new Error("refusing to spawn: no seat token (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY).");
  }
}

/**
 * The endpoint guard, with a deliberate escape hatch.
 *
 * `assertExternalEndpoint` exists to stop the seat ACCIDENTALLY running on Anthropic
 * and billing real money for work that is supposed to be flat-rate. It was never
 * meant to forbid the deliberate choice.
 *
 * Running Sonnet (or any Anthropic-hosted model) as a caged worker is legitimate: the
 * cage is Claude Code's own permission system and works identically whatever model is
 * behind it. It simply costs Anthropic tokens, or the operator's plan quota, instead
 * of the flat z.ai plan. So it must be TYPED (`--allow-anthropic`), never defaulted into.
 *
 * With `--allow-anthropic` and no credentials at all, `claude -p` falls back to the
 * operator's own logged-in session — which is exactly what a Sonnet worker wants.
 *
 * @param {Record<string,string>} creds
 * @param {{allowAnthropic?: boolean}} [opts]
 */
export function assertSeatEndpoint(creds, opts = {}) {
  if (!opts.allowAnthropic) return assertExternalEndpoint(creds);

  // Opted in. The only remaining requirement is that a base URL, IF given, is a URL:
  // a typo there would send the seat somewhere nobody intended.
  const base = creds?.ANTHROPIC_BASE_URL;
  if (base) {
    try {
      new URL(base);
    } catch {
      throw new Error(`refusing to spawn: ANTHROPIC_BASE_URL is not a URL: ${base}`);
    }
  }
}

/**
 * A throwaway `CLAUDE_CONFIG_DIR` for the seat, isolated from the operator's own
 * `~/.claude`. Without this, `claude -p` resolves its config from the operator's
 * environment (HOME must stay in the allowlist for OAuth to work) — including
 * any operator user-settings, which could layer permissions on top of the cage
 * this driver renders and widen it from outside `--settings`. Created fresh
 * (mkdtemp suffix) on every call, under the worktree it governs, so no earlier
 * spawn's state carries into a new one.
 * @param {string} dirAbs — the worktree root
 * @returns {string}
 */
export function makeSeatConfigDir(dirAbs) {
  const claudeDir = path.join(dirAbs, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const seatConfig = mkdtempSync(path.join(claudeDir, "seat-config-"));
  // Seed ONLY the operator's OAuth credentials so the seat authenticates on the
  // operator's plan — WITHOUT copying settings.json/.claude.json, which is the
  // permission-widening vector this isolation exists to shut out. A z.ai seat
  // carries ANTHROPIC_AUTH_TOKEN in its env and needs neither; an Anthropic-session
  // seat (empty creds → operator OAuth) would hit "Not logged in" without this.
  const operatorCreds = path.join(homedir(), ".claude", ".credentials.json");
  if (existsSync(operatorCreds)) {
    copyFileSync(operatorCreds, path.join(seatConfig, ".credentials.json"));
  }
  return seatConfig;
}

/** Anthropic model ALIASES — resolved by the CLI through ANTHROPIC_DEFAULT_*_MODEL. */
const ANTHROPIC_ALIASES = new Set(["sonnet", "opus", "haiku"]);

/**
 * Feature 02 — the alias trap. `--model sonnet|opus|haiku` is an ALIAS the CLI
 * resolves through `ANTHROPIC_DEFAULT_<TIER>_MODEL`. On a z.ai base URL that env
 * points the alias at `glm-5.2`, so the seat runs GLM while the operator believes
 * they ran Sonnet. Refuse before spawn when an alias meets a non-Anthropic endpoint;
 * a full model id (`claude-sonnet-5`, `glm-5.2`) is unambiguous and always allowed.
 * @param {string} model @param {Record<string,string>} creds
 */
export function assertNoAliasTrap(model, creds) {
  if (!ANTHROPIC_ALIASES.has(model)) return;
  const base = creds?.ANTHROPIC_BASE_URL;
  if (!base) return; // no base URL → the CLI's own Anthropic default → the alias is honest
  let host = "";
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return; // a malformed base URL is caught elsewhere
  }
  if (host === "anthropic.com" || host.endsWith(".anthropic.com")) return;
  throw new Error(
    `refusing to spawn: --model "${model}" is an Anthropic alias but ANTHROPIC_BASE_URL is ${host} ` +
      `(non-Anthropic). The alias resolves through ANTHROPIC_DEFAULT_${model.toUpperCase()}_MODEL, which ` +
      `z.ai maps to glm-5.2 — you would run GLM believing you ran ${model}. Pass a full model id ` +
      `(e.g. claude-sonnet-5) instead.`,
  );
}

/**
 * Feature 03 — z.ai rate-limit detection. A z.ai 429 (`code 1308`) means the run
 * hit the flat plan's rolling window. Return `{reset}` (a timestamp if the body
 * carried one) so the driver can exit 3 with an actionable message — never
 * auto-failover, spend is the owner's call (D-20). null = not rate-limited.
 * @param {string} stdout @param {string} stderr @returns {{reset: string|null}|null}
 */
export function detectRateLimit(stdout, stderr) {
  const blob = `${stdout ?? ""}\n${stderr ?? ""}`;
  const looksRateLimited =
    /\bcode\b[^0-9]{0,8}1308\b/.test(blob) || /\b1308\b/.test(blob) || /rate[_\s-]?limit/i.test(blob);
  if (!looksRateLimited) return null;
  const m = blob.match(/reset[^0-9]{0,12}(\d{4}-\d\d-\d\dT[\d:.]+Z?|\d{10,13})/i);
  return { reset: m ? m[1] : null };
}

/**
 * Child env = the same tight allowlist the opencode seat uses, PLUS the seat's own
 * ANTHROPIC_* credentials. The credentials are set on the built object rather than
 * added to `SPAWN_ENV_ALLOWLIST`, because the allowlist filters the COORDINATOR's env
 * — and the coordinator's own `ANTHROPIC_*` vars (its Anthropic session) must never
 * reach the seat and silently redirect it back to Anthropic.
 *
 * `dirAbs`, when given, isolates `CLAUDE_CONFIG_DIR` under it (see
 * `makeSeatConfigDir`) so only the rendered cage — not any operator config —
 * governs the seat. Omitted (e.g. by callers that only care about the secret
 * allowlist) leaves `CLAUDE_CONFIG_DIR` unset.
 *
 * @param {NodeJS.ProcessEnv} sourceEnv @param {Record<string,string>} creds @param {string} [dirAbs]
 */
export function buildClaudeEnv(sourceEnv, creds = {}, dirAbs) {
  const env = buildSpawnEnv(sourceEnv);
  for (const k of CLAUDE_ENV_KEYS) delete env[k]; // belt: the allowlist should never have carried these
  for (const k of CLAUDE_ENV_KEYS) {
    if (creds[k] !== undefined) env[k] = creds[k];
  }
  if (dirAbs) env.CLAUDE_CONFIG_DIR = makeSeatConfigDir(dirAbs);
  return env;
}

/**
 * Parse `claude -p --output-format json` output.
 *
 * Accepts a bare result object or a stream of JSON lines (we take the `result` event).
 * `total_cost_usd` is captured as `apiCostUsd` (D-XX overturns D-13): it is the
 * public-API-basis cost — real $ for Anthropic seats, the Anthropic-equivalent
 * comparison figure for flat-plan seats. Never mistaken for cash on the flat plan.
 * Cache tokens are surfaced first-class (cache read/write bill at their own tiers).
 * `permission_denials` is ignored — it is `[]` even when a deny fires (D-11d).
 *
 * @param {string} out @returns {{tokens:number, tokensIn:number, tokensOut:number, tokensCacheRead:number, tokensCacheWrite:number, apiCostUsd:number, sessionID:string|null, sawFinish:boolean}}
 */
export function parseClaudeResult(out) {
  const empty = {
    tokens: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    apiCostUsd: 0,
    sessionID: null,
    sawFinish: false,
  };
  if (typeof out !== "string" || out.trim().length === 0) return empty;

  let result = null;
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && obj.type === "result") result = obj;
    else if (obj && typeof obj === "object" && result === null && obj.usage) result = obj;
  }
  if (!result) return empty;

  const u = result.usage ?? {};
  const tokensIn = Number(u.input_tokens ?? 0);
  const tokensOut = Number(u.output_tokens ?? 0);
  const cacheRead = Number(u.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
  const apiCostUsd = Number(result.total_cost_usd ?? 0);

  return {
    tokens: tokensIn + tokensOut + cacheRead + cacheWrite,
    tokensIn,
    tokensOut,
    tokensCacheRead: cacheRead,
    tokensCacheWrite: cacheWrite,
    apiCostUsd,
    sessionID: typeof result.session_id === "string" ? result.session_id : null,
    sawFinish: result.is_error !== true && result.type === "result",
  };
}

// ─── IO shell ────────────────────────────────────────────────────────────────

/** Best-effort telemetry. It must never fail a run. */
function recordMetric(slug, event, project) {
  const args = [METRICS_SCRIPT, "record", slug];
  if (project) args.push("--project", project);
  try {
    spawnSync(process.execPath, args, { input: JSON.stringify(event), stdio: ["pipe", "ignore", "ignore"] });
  } catch {
    /* telemetry must never fail the run */
  }
}

/**
 * Playwright-only MCP config for a VISUAL-VALIDATOR seat (F9 cage-vision).
 *
 * Written fresh into `<worktree>/.claude/mcp-playwright.json` at spawn (the seat
 * cannot author or edit it — see `mcpConfigDenyRules`). Declares exactly ONE
 * stdio server, `playwright`, run `--isolated` so its ephemeral Chrome profile
 * never collides with the operator's own single-instance driver
 * (`[[playwright-mcp-single-instance]]`). Combined with `--strict-mcp-config` on
 * the spawn, this is the seat's ENTIRE MCP surface — no whatsapp/supabase/etc.
 *
 * @param {string} worktreeAbs @returns {string} the config path
 */
export function writePlaywrightMcpConfig(worktreeAbs) {
  const out = mcpConfigPath(worktreeAbs);
  const config = {
    mcpServers: {
      playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest", "--isolated"], env: {} },
    },
  };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
  return out;
}

function runClaude(opts, env, settingsPath) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "json", "--settings", settingsPath, "--model", opts.model];
    // F9: a visual-validator seat drives ONLY Playwright, and only that server —
    // --strict-mcp-config drops every other MCP the operator has configured.
    if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
    if (opts.session) args.push("--resume", opts.session);
    else if (opts.continue) args.push("--continue");
    args.push(opts.prompt);

    const child = spawn("claude", args, { cwd: opts.dir, stdio: ["ignore", "pipe", "pipe"], env });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Ask, wait, insist. A bare SIGKILL loses whatever the seat was mid-write on.
    const timer = setTimeout(() => {
      timedOut = true;
      killGracefully(child, { graceMs: DEFAULT_GRACE_MS });
    }, opts.timeout ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\nspawn error: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 1 : (code ?? 1), stdout, stderr, timedOut });
    });
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/claude-worker.mjs --dir <worktree> --model <model> --project <id>\n" +
      "    (--prompt <text> | --prompt-file <path>) [--slug <slug>]\n" +
      "    [--metric-seat worker|validator] [--with-playwright] [--session <id>] [--continue]\n" +
      "    [--timeout <ms>] [--json-out <path>] [--allow-any-dir] [--allow-uncaged]\n" +
      "    [--allow-anthropic] [--creds <path>]\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { allowAnyDir: false, allowUncaged: false, allowAnthropic: false, continue: false, metricSeat: "worker" };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dir": opts.dir = args[++i]; break;
      case "--model": opts.model = args[++i]; break;
      case "--prompt": opts.prompt = args[++i]; break;
      case "--prompt-file": opts.promptFile = args[++i]; break;
      case "--slug": opts.slug = args[++i]; break;
      case "--project": opts.project = args[++i]; break;
      case "--metric-seat": opts.metricSeat = args[++i]; break;
      case "--with-playwright": opts.withPlaywright = true; break;
      case "--session": opts.session = args[++i]; break;
      case "--continue": opts.continue = true; break;
      case "--timeout": opts.timeout = Number(args[++i]); break;
      case "--json-out": opts.jsonOut = args[++i]; break;
      case "--creds": opts.creds = args[++i]; break;
      case "--allow-any-dir": opts.allowAnyDir = true; break;
      case "--allow-uncaged": opts.allowUncaged = true; break;
      case "--allow-anthropic": opts.allowAnthropic = true; break;
      default: opts._bad = true;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts._bad || !opts.dir || !opts.model || (!opts.prompt && !opts.promptFile)) {
    usage();
    return 2;
  }

  // A cage with zero Critical-File rules is the exact failure this driver exists to
  // prevent, and a forgotten/misspelled --project renders one silently. Refuse.
  try {
    assertKnownProject(opts.project);
  } catch (err) {
    process.stderr.write(`claude-worker: ${err.message}\n`);
    return 2;
  }

  if (opts.promptFile) opts.prompt = readFileSync(opts.promptFile, "utf8");

  const dirAbs = path.resolve(opts.dir);
  if (!existsSync(dirAbs)) {
    process.stderr.write(`claude-worker: worktree not found: ${dirAbs}\n`);
    return 2;
  }
  const worktreeMarker = resolveProject({ project: opts.project }).profile.worktreeMarker;
  if (!opts.allowAnyDir && !isWorktreeDir(dirAbs, worktreeMarker)) {
    process.stderr.write(
      "claude-worker: refusing to run outside a dispatched worktree. Pass --allow-any-dir to override.\n",
    );
    return 2;
  }

  // Guard 1: never bill Anthropic for a seat that must run on the flat z.ai plan.
  const creds = loadSeatCredentials(opts.creds ?? DEFAULT_CREDS_PATH);
  try {
    assertSeatEndpoint(creds, { allowAnthropic: opts.allowAnthropic });
    assertNoAliasTrap(opts.model, creds); // Feature 02: alias × non-Anthropic endpoint
  } catch (err) {
    process.stderr.write(`claude-worker: ${err.message}\n`);
    return 2;
  }

  // Guard 2: a fresh cage at every spawn, or no spawn. A --with-playwright seat
  // renders the visual-validator variant (browser+verdict allow, MCP self-edit
  // deny) and gets its Playwright-only MCP config written alongside (F9).
  let settingsPath;
  try {
    settingsPath = writeCageSettings(dirAbs, { project: opts.project, visualValidator: opts.withPlaywright === true });
    if (opts.withPlaywright) opts.mcpConfigPath = writePlaywrightMcpConfig(dirAbs);
  } catch (err) {
    process.stderr.write(`claude-worker: CAGE NOT INSTALLED — ${err?.message ?? err}\n`);
    if (!opts.allowUncaged) {
      process.stderr.write("claude-worker: refusing to spawn uncaged; pass --allow-uncaged to override.\n");
      return 2;
    }
    settingsPath = cageSettingsPath(dirAbs);
  }

  // Defense in depth: the cage rendered, but if the profile declares no Critical
  // Files it protects nothing. Valid for a brand-new project, but the operator
  // must see it — a warning, not a refusal.
  if (resolveProject({ project: opts.project }).profile.criticalFiles.length === 0) {
    process.stderr.write(
      `claude-worker: WARNING — cage for project "${opts.project}" has zero Critical-File rules\n`,
    );
  }

  const env = buildClaudeEnv(process.env, creds, dirAbs);

  if (opts.slug) recordMetric(opts.slug, buildPhaseStartEvent(opts.metricSeat, opts.model), opts.project);
  const started = Date.now();
  const res = await runClaude({ ...opts, dir: dirAbs }, env, settingsPath);
  const wallMs = Date.now() - started;

  const parsed = parseClaudeResult(res.stdout);
  if (opts.slug) {
    recordMetric(
      opts.slug,
      buildPhaseEndEvent(opts.metricSeat, opts.model, {
        tokens: parsed.tokens,
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        tokensCacheRead: parsed.tokensCacheRead,
        tokensCacheWrite: parsed.tokensCacheWrite,
        apiCostUsd: parsed.apiCostUsd,
        durationMs: wallMs,
      }),
      opts.project,
    );
  }
  if (opts.jsonOut) writeFileSync(opts.jsonOut, `${res.stdout}\n`);

  // Never print the token. apiCost$ is the public-API-basis cost (D-XX) — real $
  // for Anthropic seats, the Anthropic-equivalent comparison figure for the flat plan.
  process.stdout.write(
    `claude-worker: model=${opts.model} session=${parsed.sessionID ?? "-"} ` +
      `tokens=${parsed.tokens} apiCost=$${parsed.apiCostUsd.toFixed(4)} wallMs=${wallMs} ` +
      `timedOut=${res.timedOut} exit=${res.exitCode}\n`,
  );
  if (res.stderr.trim()) process.stderr.write(`${res.stderr.trim()}\n`);

  // Feature 03: z.ai rate-limit → exit 3 with an actionable message, no auto-failover (D-20).
  const rl = detectRateLimit(res.stdout, res.stderr);
  if (rl) {
    process.stderr.write(
      `claude-worker: RATE LIMITED — z.ai 429 (code 1308)${rl.reset ? `, resets ${rl.reset}` : ""}. ` +
        "No auto-failover (spend is your call). Ready-to-paste Anthropic fallback:\n" +
        `  node scripts/claude-worker.mjs --dir ${opts.dir} --model claude-sonnet-5 ` +
        `--project ${opts.project} --allow-anthropic --creds /dev/null --prompt-file <brief>\n`,
    );
    return 3;
  }

  if (res.exitCode !== 0 || !parsed.sawFinish) return 1;
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`claude-worker: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}

#!/usr/bin/env node

/**
 * External-agent seat driver (opencode → GLM/other providers).
 *
 * Instance of the reusable factory template
 * `standards/agent-patterns/factory-templates/opencode-worker.mjs` (see the
 * companion `external-agent-seat.md` there). Keep the two in sync.
 *
 * The factory's default seats run on Claude Code. This driver makes an
 * *external* coding agent (any model configured in opencode — e.g.
 * `zai-coding-plan/glm-5.2`) available as an OPTIONAL worker/validator seat,
 * so heavy mechanical work can run off a subscription plan instead of spending
 * Anthropic tokens. It is purely additive: default dispatch is untouched.
 *
 * Harness restriction (this is the "external agent, still governed by the
 * harness" contract): the driver refuses to run unless `--dir` is an isolated
 * dispatched worktree (a path under `.claude/worktrees/`), unless
 * `--allow-any-dir` is passed. Whatever the external agent produces is STILL
 * subject to the existing deterministic gate (`pnpm quality-gate`, tests, tsc,
 * lint) and, for a validator seat, the `verdict.mjs` schema — this driver
 * governs *where/how* the external agent runs, not *whether its output is
 * accepted*.
 *
 * Usage:
 *   node scripts/factory/opencode-worker.mjs \
 *     --dir <worktree> --model <provider/model> \
 *     (--prompt "<text>" | --prompt-file <path>) \
 *     [--slug <slug>] [--metric-seat worker|validator] [--project <id>] \
 *     [--session <id>] [--continue] [--timeout <ms>] \
 *     [--json-out <path>] [--no-auto] [--allow-any-dir]
 *
 * Exit codes:
 *   0 external agent finished (opencode exited 0)
 *   1 opencode errored / timed out / produced no completion
 *   2 usage error or worktree-confinement violation
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — a full TDD feature can take a while
const WORKTREE_MARKER = process.env.FACTORY_WORKTREE_MARKER ?? "/.claude/worktrees/";

// ─── Pure core (unit-tested) ─────────────────────────────────────────────────

/**
 * Is `dir` an isolated dispatched worktree? The factory materializes those
 * under `.claude/worktrees/<slug>/` (see scripts/dispatch-worktree.sh). We
 * confine the external agent to one so it can never mutate the main tree.
 * @param {string} dir — already absolute
 * @returns {boolean}
 */
export function isWorktreeDir(dir) {
  const norm = dir.split(path.sep).join("/");
  return norm.includes(WORKTREE_MARKER);
}

/**
 * Parse an opencode `--format json` event stream (newline-delimited JSON, one
 * event per line). Tolerates interleaved non-JSON lines (e.g. a stray watcher
 * warning on a merged stream) by skipping anything that does not parse.
 * The token split (`input`/`output`/`reasoning`) is best-effort: opencode's
 * `part.tokens` object carries it for most providers, but z.ai may omit the
 * `reasoning` sub-field. `tokensReasoning` is therefore `null` (explicit
 * "unknown") unless at least one step reported it — never a misleading 0.
 *
 * @param {string} streamText
 * @returns {{ finalText: string, tokens: number, tokensIn: number, tokensOut: number, tokensReasoning: number|null, cost: number, sessionID: string|null, sawFinish: boolean }}
 */
export function parseOpencodeStream(streamText) {
  let finalText = "";
  let tokens = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let reasoningSum = 0;
  let sawReasoning = false;
  let cost = 0;
  let sessionID = null;
  let sawFinish = false;

  for (const line of streamText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] !== "{") continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev.sessionID) sessionID = ev.sessionID;
    const part = ev.part;
    if (ev.type === "text" && part && typeof part.text === "string") {
      finalText += part.text;
    } else if (ev.type === "step_finish" && part) {
      sawFinish = true;
      const t = part.tokens;
      if (t && typeof t === "object") {
        if (typeof t.total === "number") tokens += t.total;
        if (typeof t.input === "number") tokensIn += t.input;
        if (typeof t.output === "number") tokensOut += t.output;
        if (typeof t.reasoning === "number") {
          reasoningSum += t.reasoning;
          sawReasoning = true;
        }
      }
      if (typeof part.cost === "number") cost += part.cost;
    }
  }

  return {
    finalText: finalText.trim(),
    tokens,
    tokensIn,
    tokensOut,
    tokensReasoning: sawReasoning ? reasoningSum : null,
    cost,
    sessionID,
    sawFinish,
  };
}

// ─── Spawn env allowlist ─────────────────────────────────────────────────────

/**
 * Env vars the external agent (opencode) is allowed to inherit. Everything else
 * in `process.env` — every real secret the coordinator's shell holds
 * (SUPABASE_SERVICE_ROLE_KEY, WABA_TOKEN_KEY, OPENAI/OPENROUTER/… keys) — is
 * dropped, so a third-party model process never receives them.
 *
 * opencode's z.ai credential is FILE-based (`$HOME/.local/share/opencode/auth.json`,
 * i.e. XDG_DATA_HOME-relative), so passing `HOME` (and the XDG_* vars) is enough
 * for auth to keep working — no secret env var, no wildcard.
 */
export const SPAWN_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];

/**
 * Build the child-process env from `sourceEnv`, keeping only allowlisted names
 * (exact match in SPAWN_ENV_ALLOWLIST, or any `XDG_*` var).
 * @param {NodeJS.ProcessEnv} sourceEnv
 * @returns {Record<string, string>}
 */
export function buildSpawnEnv(sourceEnv) {
  const out = {};
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (v === undefined) continue;
    if (SPAWN_ENV_ALLOWLIST.includes(k) || k.startsWith("XDG_")) out[k] = v;
  }
  return out;
}

// ─── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { auto: true, allowAnyDir: false, continue: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--dir":
        opts.dir = args[++i];
        break;
      case "--model":
        opts.model = args[++i];
        break;
      case "--prompt":
        opts.prompt = args[++i];
        break;
      case "--prompt-file":
        opts.promptFile = args[++i];
        break;
      case "--slug":
        opts.slug = args[++i];
        break;
      case "--metric-seat":
        opts.metricSeat = args[++i];
        break;
      case "--project":
        opts.project = args[++i];
        break;
      case "--session":
        opts.session = args[++i];
        break;
      case "--json-out":
        opts.jsonOut = args[++i];
        break;
      case "--timeout":
        opts.timeout = Number(args[++i]);
        break;
      case "--continue":
        opts.continue = true;
        break;
      case "--no-auto":
        opts.auto = false;
        break;
      case "--allow-any-dir":
        opts.allowAnyDir = true;
        break;
      default:
        process.stderr.write(`unknown flag: ${a}\n`);
        opts._bad = true;
    }
  }
  return opts;
}

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/factory/opencode-worker.mjs --dir <worktree> --model <provider/model> \\\n" +
      '    (--prompt "<text>" | --prompt-file <path>) [--slug <slug>] \\\n' +
      "    [--metric-seat worker|validator] [--project <id>] [--session <id>] [--continue] \\\n" +
      "    [--timeout <ms>] [--json-out <path>] [--no-auto] [--allow-any-dir]\n",
  );
}

// ─── Metrics (metrics.mjs schema, W3 full-pipeline observability) ─────────────

/** Map any seat label to the two metrics seats the schema accepts. */
function metricSeat(seat) {
  return seat === "validator" ? "validator" : "worker";
}

/**
 * Build a `phase_start` event. Emitted at spawn so a mission's metrics.jsonl
 * carries a start marker (today only phase_end existed — the 142-byte files
 * prove it), which mission-stats pairs with phase_end to derive wall time.
 * @param {string} seat @param {string} model
 * @returns {{seat: string, type: "phase_start", detail: string, model: string}}
 */
export function buildPhaseStartEvent(seat, model) {
  return {
    seat: metricSeat(seat),
    type: "phase_start",
    detail: `external:${model}`,
    model,
  };
}

/**
 * Build a `phase_end` event with `model` first-class (the legacy `detail`
 * remains for back-compat), the token split when the stream provided it, and
 * the driver-measured wall time as `durationMs`.
 * @param {string} seat @param {string} model
 * @param {{tokens?: number, tokensIn?: number, tokensOut?: number, tokensReasoning?: number|null, cost?: number, durationMs?: number}} m
 */
export function buildPhaseEndEvent(seat, model, m = {}) {
  return {
    seat: metricSeat(seat),
    type: "phase_end",
    detail: `external:${model}`,
    model,
    tokens: m.tokens ?? 0,
    tokensIn: m.tokensIn ?? 0,
    tokensOut: m.tokensOut ?? 0,
    // Preserve an explicit null (provider omitted the split) — never coerce to 0.
    tokensReasoning: m.tokensReasoning === undefined ? null : m.tokensReasoning,
    durationMs: m.durationMs ?? 0,
    costUsd: m.cost ?? 0,
  };
}

/**
 * Append one event to a slug's metrics.jsonl via metrics.mjs. Best-effort —
 * telemetry must never fail the run. `project` (when known) is forwarded so the
 * recorder targets the right `missions/<project>/` root now that the engine is
 * extracted from the product repo.
 */
function recordMetric(slug, event, project) {
  const args = [path.join(__dirname, "metrics.mjs"), "record", slug];
  if (project) args.push("--project", project);
  try {
    spawnSync(process.execPath, args, {
      input: JSON.stringify(event),
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    // best-effort — telemetry must never fail the run
  }
}

// ─── IO shell ────────────────────────────────────────────────────────────────

function runOpencode(opts) {
  return new Promise((resolve) => {
    const cliArgs = ["run", "-m", opts.model, "--dir", opts.dir, "--format", "json"];
    if (opts.auto) cliArgs.push("--auto");
    if (opts.continue) cliArgs.push("--continue");
    if (opts.session) cliArgs.push("--session", opts.session);
    cliArgs.push(opts.prompt);

    const child = spawn("opencode", cliArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      // Never inherit the coordinator's full env — an external model process must
      // not receive real secrets. Only an allowlist passes through (F2 / W1).
      env: buildSpawnEnv(process.env),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
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

async function main() {
  const opts = parseArgs(process.argv);
  if (opts._bad || !opts.dir || !opts.model || (!opts.prompt && !opts.promptFile)) {
    usage();
    return 2;
  }

  opts.dir = path.resolve(opts.dir);
  if (!isWorktreeDir(opts.dir) && !opts.allowAnyDir) {
    process.stderr.write(
      `refusing: --dir is not an isolated worktree (${opts.dir}).\n` +
        "Route external agents to a dispatched .claude/worktrees/<slug>/ tree, " +
        "or pass --allow-any-dir to override.\n",
    );
    return 2;
  }

  if (opts.promptFile) {
    try {
      opts.prompt = readFileSync(path.resolve(opts.promptFile), "utf8");
    } catch (err) {
      process.stderr.write(`cannot read --prompt-file: ${err.message}\n`);
      return 2;
    }
  }

  // Emit phase_start at spawn so metrics.jsonl carries a start marker that
  // mission-stats can pair with phase_end for wall-clock duration.
  if (opts.slug) {
    recordMetric(opts.slug, buildPhaseStartEvent(opts.metricSeat, opts.model), opts.project);
  }

  const t0 = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await runOpencode(opts);
  const wallMs = Date.now() - t0;
  const parsed = parseOpencodeStream(stdout);

  const ok = exitCode === 0 && parsed.sawFinish;
  process.stdout.write(
    `opencode-worker: model=${opts.model} session=${parsed.sessionID ?? "?"} ` +
      `tokens=${parsed.tokens} cost=$${parsed.cost.toFixed(4)} wallMs=${wallMs} ` +
      `exit=${exitCode}${timedOut ? " (TIMEOUT)" : ""}\n`,
  );
  if (!ok && stderr.trim()) {
    process.stderr.write(
      `opencode stderr tail:\n${stderr.trim().split("\n").slice(-8).join("\n")}\n`,
    );
  }

  if (opts.slug) {
    recordMetric(
      opts.slug,
      buildPhaseEndEvent(opts.metricSeat, opts.model, {
        tokens: parsed.tokens,
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        tokensReasoning: parsed.tokensReasoning,
        cost: parsed.cost,
        durationMs: wallMs,
      }),
      opts.project,
    );
  }

  if (opts.jsonOut) {
    const out = {
      ok,
      exitCode,
      timedOut,
      model: opts.model,
      sessionID: parsed.sessionID,
      tokens: parsed.tokens,
      cost: parsed.cost,
      wallMs,
      finalText: parsed.finalText,
    };
    writeFileSync(path.resolve(opts.jsonOut), `${JSON.stringify(out, null, 2)}\n`);
  }

  return ok ? 0 : 1;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err?.message ?? err}\n`);
      process.exit(1);
    });
}

#!/usr/bin/env node

/**
 * External-agent seat driver (opencode → GLM/other providers).
 *
 * Instance of the reusable factory template
 * `standards/agent-patterns/factory-templates/opencode-worker.mjs` (see the
 * companion `external-agent-seat.md` there). Keep the two in sync.
 *
 * FALLBACK SEAT (D-19). The default external seat is `claude-worker.mjs`: Claude
 * Code pointed at z.ai's Anthropic-compatible endpoint runs the same models on the
 * same flat plan, and its Critical-File deny is empirically proven (cage-research
 * M1) where opencode's is not (D-17). One driver, one cage.
 *
 * This driver stays for providers with NO Anthropic-compatible endpoint. It is
 * caged by `cage-opencode.mjs` (opencode's own `permission` schema) and refuses to
 * spawn without one.
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
 *     --dir <worktree> --model <provider/model> --project <id> \
 *     (--prompt "<text>" | --prompt-file <path>) \
 *     [--slug <slug>] [--metric-seat worker|validator] \
 *     [--session <id>] [--continue] [--timeout <ms>] \
 *     [--json-out <path>] [--no-auto] [--allow-any-dir]
 *
 * `--project` is REQUIRED and must name a known profile (`projects/<id>/`): the
 * cage's Critical-File deny rules and this run's telemetry routing both come from
 * it. An absent or unknown id is refused (exit 2), not defaulted — a forgotten flag
 * would otherwise render a cage with zero Critical-File protections and say nothing.
 *
 * Exit codes:
 *   0 external agent finished (opencode exited 0)
 *   1 opencode errored / timed out / produced no completion
 *   2 usage error, absent/unknown --project, or worktree-confinement violation
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/is-main.mjs";
import { resolveProject } from "./lib/project.mjs";
import {
  assertKnownProject,
  buildPhaseEndEvent,
  buildPhaseStartEvent,
  buildSpawnEnv,
  applyGateExitCode,
  completeRun,
  DEFAULT_GRACE_MS,
  gateSummaryLabel,
  resolveGateEnabled,
  isWorktreeDir,
  killGracefully,
  mintRunId,
  recordMetric,
  snapshotWorktree,
} from "./lib/worker-common.mjs";
import { opencodeCagePath, writeOpencodeCage } from "./cage-opencode.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — a full TDD feature can take a while

// ─── Pure core (unit-tested) ─────────────────────────────────────────────────

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

// ─── CLI parsing ─────────────────────────────────────────────────────────────

/**
 * Parse the driver's argv. Exported so the flag surface is testable: an
 * unrecognized flag sets `_bad` and the driver exits 2, so a new flag that was
 * never added here does not "default off" — it refuses to run at all.
 * @param {string[]} argv @returns {Record<string, unknown>}
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    auto: true,
    allowAnyDir: false,
    continue: false,
    // THREE-valued, not boolean: null = "the operator said nothing", which
    // defers to `profile.gateDefault` (ON unless the project opts out). `false`
    // only ever comes from an explicit `--no-gate`. See resolveGateEnabled.
    gate: null,
    gateStrict: false,
  };
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
      case "--allow-uncaged":
        opts.allowUncaged = true;
        break;
      // The escape hatch for a throwaway probe: skip the project's real commands
      // and accept that the run scores `unmeasured`.
      case "--no-gate":
        opts.gate = false;
        break;
      case "--gate":
        opts.gate = true;
        break;
      // Strict without the gate would enforce a verdict that was never taken.
      case "--gate-strict":
        opts.gate = true;
        opts.gateStrict = true;
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
      "  node scripts/factory/opencode-worker.mjs --dir <worktree> --model <provider/model> --project <id> \\\n" +
      '    (--prompt "<text>" | --prompt-file <path>) [--slug <slug>] \\\n' +
      "    [--metric-seat worker|validator] [--session <id>] [--continue] \\\n" +
      "    [--timeout <ms>] [--json-out <path>] [--no-auto] [--allow-any-dir] \\\n" +
      "    [--gate | --no-gate] [--gate-strict]\n",
  );
}

// ─── IO shell ────────────────────────────────────────────────────────────────

function runOpencode(opts) {
  return new Promise((resolve) => {
    // Render the cage FRESH at every spawn, outside the worktree, so an agent that
    // somehow weakened a previous one cannot carry that forward — and so it cannot
    // edit the file that governs it. Soft-fail: a cage we cannot write is reported
    // loudly and the run proceeds uncaged rather than silently pretending. Never
    // let a broken cage masquerade as a cage.
    let cagePath = null;
    try {
      cagePath = writeOpencodeCage(opencodeCagePath(opts.dir), { project: opts.project });
    } catch (err) {
      process.stderr.write(`opencode-worker: CAGE NOT INSTALLED — ${err?.message ?? err}\n`);
      if (!opts.allowUncaged) {
        return resolve({
          exitCode: 2,
          stdout: "",
          stderr: "refusing to spawn an uncaged worker; pass --allow-uncaged to override",
          timedOut: false,
        });
      }
    }

    // Defense in depth: the cage rendered, but if the profile declares no Critical
    // Files it protects nothing. Valid for a brand-new project, but the operator
    // must see it — a warning, not a refusal.
    if (resolveProject({ project: opts.project }).profile.criticalFiles.length === 0) {
      process.stderr.write(
        `opencode-worker: WARNING — cage for project "${opts.project}" has zero Critical-File rules\n`,
      );
    }

    const cliArgs = ["run", "-m", opts.model, "--dir", opts.dir, "--format", "json"];
    if (opts.auto) cliArgs.push("--auto");
    if (opts.continue) cliArgs.push("--continue");
    if (opts.session) cliArgs.push("--session", opts.session);
    cliArgs.push(opts.prompt);

    const child = spawn("opencode", cliArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      // Never inherit the coordinator's full env — an external model process must
      // not receive real secrets. Only an allowlist passes through (F2 / W1).
      // OPENCODE_CONFIG is SET here rather than allowlisted: the allowlist filters
      // the coordinator's env, and the cage path is ours to dictate, not to inherit.
      env: { ...buildSpawnEnv(process.env), ...(cagePath ? { OPENCODE_CONFIG: cagePath } : {}) },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Ask, wait, then insist. A bare SIGKILL here cost a worker its mid-handoff
    // state once already (mission factory-profiles): SIGKILL cannot be caught, so
    // whatever the child was writing is lost. SIGTERM lets opencode flush its
    // session; 30 s later, if it is still hanging, it dies anyway.
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
    process.stderr.write(`opencode-worker: ${err.message}\n`);
    return 2;
  }

  opts.dir = path.resolve(opts.dir);
  const worktreeMarker = resolveProject({ project: opts.project }).profile.worktreeMarker;
  if (!isWorktreeDir(opts.dir, worktreeMarker) && !opts.allowAnyDir) {
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
  // One id per spawn, threaded through phase_start, phase_end and gate_result.
  const runId = mintRunId(opts.slug);
  if (opts.slug) {
    recordMetric(opts.slug, buildPhaseStartEvent(opts.metricSeat, opts.model, runId), opts.project);
  }

  const baseline = snapshotWorktree(path.resolve(opts.dir));

  const t0 = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await runOpencode(opts);
  const wallMs = Date.now() - t0;
  const parsed = parseOpencodeStream(stdout);

  const ok = exitCode === 0 && parsed.sawFinish;

  // Shared sequence: take the tree delta, record phase_end, THEN gate. The
  // order is pinned in worker-common.test.mjs — see completeRun.
  const { filesChanged, gate } = completeRun({
    seat: opts.metricSeat,
    model: opts.model,
    project: opts.project,
    slug: opts.slug ?? null,
    dirAbs: path.resolve(opts.dir),
    baseline,
    runId,
    metrics: {
      tokens: parsed.tokens,
      tokensIn: parsed.tokensIn,
      tokensOut: parsed.tokensOut,
      tokensReasoning: parsed.tokensReasoning,
      cost: parsed.cost,
      durationMs: wallMs,
      exitCode,
      sawFinish: parsed.sawFinish === true,
      timedOut: timedOut === true,
    },
    // Profile decides unless the operator overrode it (D-61).
    gate: resolveGateEnabled(opts.gate, resolveProject({ project: opts.project }).profile.gateDefault),
  });

  process.stdout.write(
    `opencode-worker: model=${opts.model} session=${parsed.sessionID ?? "?"} ` +
      `tokens=${parsed.tokens} cost=$${parsed.cost.toFixed(4)} wallMs=${wallMs} ` +
      `exit=${exitCode}${timedOut ? " (TIMEOUT)" : ""} files=${filesChanged} ` +
      `gate=${gateSummaryLabel(gate)}\n`,
  );
  if (!ok && stderr.trim()) {
    process.stderr.write(
      `opencode stderr tail:\n${stderr.trim().split("\n").slice(-8).join("\n")}\n`,
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

  return applyGateExitCode(ok ? 0 : 1, gate, opts.gateStrict === true);
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

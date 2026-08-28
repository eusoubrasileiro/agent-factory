/**
 * worker-common.mjs — behaviour shared by every worker driver (opencode today,
 * a caged Claude Code driver later).
 *
 * Usage:
 *   import { assertKnownProject, killGracefully } from "./lib/worker-common.mjs";
 *   const { escalated } = await killGracefully(child, { graceMs: 30_000 });
 *   assertKnownProject(opts.project); // throws on absent/unknown --project
 *
 * No exit codes — this is a library, not a CLI.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { FACTORY_ROOT, loadProjects } from "./project.mjs";

/** Default grace period before a stubborn child is killed outright. */
export const DEFAULT_GRACE_MS = 30_000;

const DEFAULT_WORKTREE_MARKER = "/.claude/worktrees/";

/**
 * Is `dir` an isolated dispatched worktree? The factory materializes those
 * under `.claude/worktrees/<slug>/` (see scripts/dispatch-worktree.sh). We
 * confine the external agent to one so it can never mutate the main tree.
 * The marker is a per-project FACT from the profile (`project.json → worktreeMarker`,
 * default `/.claude/worktrees/`), not an engine constant (D-27) — pass the resolved
 * profile's marker; the default keeps back-compat for callers that don't.
 * @param {string} dir — already absolute
 * @param {string} [marker] — the profile's worktree marker
 * @returns {boolean}
 */
export function isWorktreeDir(dir, marker = DEFAULT_WORKTREE_MARKER) {
  const norm = dir.split(path.sep).join("/");
  return norm.includes(marker);
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

// ─── Metrics event builders (metrics.mjs schema, W3 full-pipeline observability) ─

/** Map any seat label to the two metrics seats the schema accepts. */
function metricSeat(seat) {
  return seat === "validator" ? "validator" : "worker";
}

// ─── Worktree delta (filesChanged) ──────────────────────────────────────────
// Driver-measured count of distinct paths touched during a run — the one
// run-outcome field the seat cannot fabricate, because it comes from git,
// never from the transcript. See snapshotWorktree/countChangedFiles below.

/**
 * Run `git`, contained: a call blocked on `index.lock` must not stall the
 * driver after the run has already finished, and any failure here — non-zero
 * exit, thrown error, overflowed buffer — degrades to `null` rather than
 * throwing. A git problem must never fail a run.
 * @param {string} dirAbs @param {string[]} args
 * @returns {string|null}
 */
function runGit(dirAbs, args) {
  try {
    const r = spawnSync("git", args, {
      cwd: dirAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 16 << 20,
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/**
 * Parse `git diff --numstat --no-renames -z` output into `path -> "ins,del"`.
 * With `--no-renames` each record is one NUL-terminated token: `ins\tdel\tpath`.
 */
function parseNumstatZ(text, into) {
  for (const token of text.split("\0")) {
    if (token.length === 0) continue;
    const tab1 = token.indexOf("\t");
    const tab2 = token.indexOf("\t", tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    into.set(token.slice(tab2 + 1), `${token.slice(0, tab1)},${token.slice(tab1 + 1, tab2)}`);
  }
}

/**
 * Fingerprint the worktree relative to `head`: `path -> "ins,del"` for every
 * committed/staged/unstaged change against `head`, plus `path -> "?"` for
 * every untracked path. `.claude/` is excluded — Claude Code keeps writing
 * session state there (CLAUDE_CONFIG_DIR mkdtemp, settings) *during* the run,
 * so without the exclusion the driver's own plumbing would manufacture a
 * non-zero signal on every run.
 * @returns {Map<string,string>|null}
 */
function buildFingerprint(dirAbs, head) {
  const numstatOut = runGit(dirAbs, [
    "diff",
    "--numstat",
    "--no-renames",
    "-z",
    head,
    "--",
    ".",
    ":(exclude).claude",
  ]);
  if (numstatOut === null) return null;
  const files = new Map();
  parseNumstatZ(numstatOut, files);
  const untrackedOut = runGit(dirAbs, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--directory",
    "--no-empty-directory",
    "-z",
    "--",
    ".",
    ":(exclude).claude",
  ]);
  if (untrackedOut === null) return null;
  for (const p of untrackedOut.split("\0")) if (p.length > 0) files.set(p, "?");
  return files;
}

/**
 * Snapshot the worktree as late as possible before spawning the seat — after
 * cage settings + env are written, after `phase_start` is recorded. Diffing
 * against `head` (not `git status`) is what makes a seat that COMMITS its
 * work read identically to one that leaves it dirty, and what stops a
 * re-dispatch from inheriting credit for a prior attempt's leftovers.
 * @param {string} dirAbs
 * @returns {{head: string, files: Map<string,string>}|null}
 */
export function snapshotWorktree(dirAbs) {
  const headOut = runGit(dirAbs, ["rev-parse", "HEAD"]);
  if (headOut === null) return null;
  const head = headOut.trim();
  const files = buildFingerprint(dirAbs, head);
  if (files === null) return null;
  return { head, files };
}

/**
 * Count of distinct paths whose fingerprint differs between `baseline` and
 * now — the symmetric difference of the two fingerprint maps. Fingerprints
 * (not bare path sets) so a further edit to an already-dirty file counts:
 * with `--name-only` the path would sit in both sets and score 0, a false
 * "did nothing" on exactly the re-dispatch case this exists for.
 * @param {string} dirAbs
 * @param {{head:string,files:Map<string,string>}|null} baseline
 * @returns {number|null} null when unmeasured — never 0 standing in for "unknown"
 */
export function countChangedFiles(dirAbs, baseline) {
  if (baseline === null || baseline === undefined) return null;
  const after = buildFingerprint(dirAbs, baseline.head);
  if (after === null) return null;
  const before = baseline.files;
  let count = 0;
  for (const [p, fp] of before) if (after.get(p) !== fp) count++;
  for (const [p, fp] of after) if (!before.has(p)) count++;
  return count;
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
 *
 * Cost attribution (factory-cost Stage 1c): `apiCostUsd` carries the
 * provider-priced public-API cost (claude -p's `total_cost_usd`; opencode's
 * `part.cost`). Cache tokens are first-class so priced seats bill at the cache
 * tiers. The legacy `costUsd` is mirrored for back-compat with old consumers.
 * @param {string} seat @param {string} model
 * @param {{tokens?: number, tokensIn?: number, tokensOut?: number, tokensReasoning?: number|null, tokensCacheRead?: number, tokensCacheWrite?: number, cost?: number, apiCostUsd?: number, durationMs?: number, filesChanged?: number|null}} m
 */
export function buildPhaseEndEvent(seat, model, m = {}) {
  const apiCost = typeof m.apiCostUsd === "number" ? m.apiCostUsd : m.cost ?? 0;
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
    tokensCacheRead: m.tokensCacheRead ?? 0,
    tokensCacheWrite: m.tokensCacheWrite ?? 0,
    durationMs: m.durationMs ?? 0,
    // Run OUTCOME. Without these the meter knows what a run COST but not whether
    // it WORKED, so green-first-try is not computable and a hung worker reads
    // identically to a clean pass. Absent → null ("unmeasured"), never false/0:
    // coercing would invent failures in legacy rows, or successes in broken ones.
    exitCode: m.exitCode === undefined ? null : m.exitCode,
    sawFinish: m.sawFinish === undefined ? null : m.sawFinish,
    timedOut: m.timedOut === undefined ? null : m.timedOut,
    // Idle watchdog fired (no output at all) — the provider wedged. Distinct
    // from timedOut, which means "still working, just past the wall-clock".
    stalled: m.stalled === undefined ? null : m.stalled,
    // Public-API-basis cost (real $ for priced seats; comparison figure for flat).
    apiCostUsd: apiCost,
    // Legacy mirror — old consumers read costUsd; keep it in sync until removed.
    costUsd: apiCost,
    // Count of distinct paths touched vs. the pre-spawn baseline (committed,
    // staged, unstaged or untracked). The only run-outcome field the seat
    // cannot fabricate — the driver computes it from the tree via git, never
    // from the transcript. null = UNMEASURED, never 0 standing in for "unknown".
    filesChanged: m.filesChanged === undefined ? null : m.filesChanged,
  };
}

/**
 * Refuse to run a seat driver without a KNOWN `--project`.
 *
 * A driver renders the cage's Critical-File deny rules and routes the run's
 * telemetry from the project profile (`projects/<id>/`). `resolveProject` is
 * deliberately TOTAL for the mission tooling — an absent OR misspelled id degrades
 * to a default profile with ZERO Critical-File rules — so the strictness that a
 * driver needs cannot live there. It lives here: the id must be present AND name a
 * real profile, or the driver refuses.
 *
 * The known ids are read at runtime from `loadProjects()` and sorted; they are
 * never hardcoded (the meta test forbids product literals in `scripts/`). The
 * message names them so an operator sees the valid set. It never interpolates
 * anything from the environment — only the caller-supplied `project`.
 *
 * @param {string|undefined} project — the `--project` value as parsed from argv
 * @param {string} [factoryRoot]
 * @returns {string} the validated project id
 */
export function assertKnownProject(project, factoryRoot = FACTORY_ROOT) {
  const known = loadProjects(factoryRoot)
    .map((p) => p.id)
    .sort();
  const list = known.join(", ");
  const why =
    "the cage's Critical-File rules and this run's telemetry routing come from the project profile";
  if (!project) {
    throw new Error(`--project is required — ${why}. Known projects: ${list}`);
  }
  if (!known.includes(project)) {
    throw new Error(`--project "${project}" is unknown — ${why}. Known projects: ${list}`);
  }
  return project;
}

/**
 * Ask a child process to stop, and only kill it if it refuses.
 *
 * The drivers used to do `child.kill("SIGKILL")` at timeout. `SIGKILL` cannot be
 * caught, so a worker that was mid-write — appending a handoff, flushing a session,
 * finishing a commit — lost that work with no chance to finish. We watched it happen
 * on mission `factory-profiles`, where a worker committed, hung, and was killed 30
 * minutes later; nothing was lost only because the commits happened to land first.
 *
 * `SIGTERM` can be caught. opencode flushes its session on it. So: ask, wait, then
 * insist.
 *
 * Resolves `{escalated:false}` when the child exits inside the grace window and
 * `{escalated:true}` when it had to be SIGKILLed. It never rejects: a kill helper
 * that throws while killing leaves the caller with a live child and no handle.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {{graceMs?: number, signal?: NodeJS.Signals}} [opts]
 * @returns {Promise<{escalated: boolean}>}
 */
export function killGracefully(child, opts = {}) {
  const { graceMs = DEFAULT_GRACE_MS, signal = "SIGTERM" } = opts;

  return new Promise((resolve) => {
    if (!child || typeof child.kill !== "function") return resolve({ escalated: false });

    // Already reaped: nothing to signal, nothing to escalate.
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ escalated: false });

    let settled = false;
    let timer = null;

    const finish = (escalated) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      child.removeListener("exit", onExit);
      resolve({ escalated });
    };

    const onExit = () => finish(false);
    child.once("exit", onExit);

    // `kill` on a dead pid can throw ESRCH depending on timing; that just means
    // the child beat us to it.
    const send = (sig) => {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    };

    send(signal);

    if (graceMs <= 0) {
      send("SIGKILL");
      // Give the exit event a tick to land, but do not depend on it: a child that
      // is already unreapable must not hang the caller.
      timer = setTimeout(() => finish(true), 0);
      return;
    }

    // NOT unref'd: an unref'd grace timer lets node exit before it fires, so a
    // stubborn child would never be escalated in a process with nothing else
    // pending. `finish()` always clears it, so it cannot outlive the kill.
    timer = setTimeout(() => {
      send("SIGKILL");
      finish(true);
    }, graceMs);
  });
}

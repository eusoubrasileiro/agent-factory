#!/usr/bin/env node
/**
 * gate.mjs — the deterministic gate runner.
 *
 * Runs a project's declared `gate[]` commands, in order, stopping at the first
 * failure, and reports a THREE-valued verdict (`true`/`false`/`null`) rather than
 * a boolean. `null` means the gate could not be run at all — no commands
 * declared, an unprovisioned worktree, a command that could not even be
 * launched, a wall-clock timeout, a signal kill, or lock contention — and is
 * deliberately never coerced to `false`: that would score every environment
 * fault as "the seat wrote broken code", which is worse than not measuring at
 * all (see decisions.md D-25).
 *
 * Usage:
 *   node scripts/gate.mjs --project <id> --dir <worktree>
 *           [--slug <mission>] [--run-id <id>] [--seat worker|validator]
 *           [--prepare] [--timeout <ms>] [--lock-wait <ms>] [--no-lock] [--json]
 *
 * Exit codes: 0 passed · 1 failed · 2 usage error (no event) · 4 unmeasured
 * (an environment fault, or the instrument itself broke — never conflated with
 * a code failure at the shell boundary).
 *
 * gate.mjs runs the project's OWN declared commands with the operator's full
 * environment (never the untrusted-seat env allowlist from worker-common.mjs's
 * `buildSpawnEnv`) — it is a trusted driver process, and stripping its env would
 * make every credentialed e2e layer fail as if the code were broken.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
import { resolveProject } from "./lib/project.mjs";
import { assertKnownProject, isWorktreeDir } from "./lib/worker-common.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRICS_SCRIPT = path.join(__dirname, "metrics.mjs");

export const DEFAULT_TIMEOUT_MS = 1_800_000;
export const DEFAULT_LOCK_WAIT_MS = 1_800_000;
export const DEFAULT_LOCK_POLL_MS = 2_000;
export const GATE_LOCK_STALE_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_LOCK_DIR = path.join(os.tmpdir(), "factory-gate-locks");

// ─── Pure core ───────────────────────────────────────────────────────────────

/**
 * Provisioning preflight. Decides, from the marker's CURRENT state and whether
 * `--prepare` was given, whether the run may proceed — and if it must first run
 * `profile.prepare`. Never touches disk or a process; the marker's existence is
 * the caller's job (`existsSync` follows symlinks, which is what makes a
 * dangling `node_modules -> ../../node_modules` correctly report absent).
 *
 * @param {{profile: {prepareMarker: string|null, prepare: string[]}, markerExists: boolean, prepareRequested: boolean}} args
 * @returns {{ok: boolean, reason: "deps-missing"|null, needsPrepare: boolean}}
 */
export function preflight({ profile, markerExists, prepareRequested }) {
  if (!profile.prepareMarker) return { ok: true, reason: null, needsPrepare: false };
  if (markerExists) return { ok: true, reason: null, needsPrepare: false };
  if (!prepareRequested) return { ok: false, reason: "deps-missing", needsPrepare: false };
  if (!Array.isArray(profile.prepare) || profile.prepare.length === 0) {
    return { ok: false, reason: "deps-missing", needsPrepare: false };
  }
  return { ok: true, reason: null, needsPrepare: true };
}

/**
 * Classify one command's raw `spawnSync` result. `timedOut` is passed in
 * explicitly (rather than sniffed from `r.error.code`) because Node sets BOTH
 * `error.code === "ETIMEDOUT"` AND `signal` on a timeout kill — timeout must be
 * checked first or it is indistinguishable from an external signal kill.
 *
 * @param {{status: number|null, error?: {code?: string}, signal?: string|null}} r
 * @param {{timedOut?: boolean}} [opts]
 * @returns {"ok"|"failed"|"spawn-error"|"timeout"|"signal"}
 */
export function classifyCommandResult(r, { timedOut = false } = {}) {
  if (timedOut) return "timeout";
  if (r?.error) return "spawn-error";
  if (r?.signal) return "signal";
  if (r?.status === 0) return "ok";
  return "failed";
}

/**
 * Decide the gate verdict from the ordered list of command attempts actually
 * made (fail-fast — the caller stops appending after the first non-"ok"
 * outcome). The invariant this enforces: `passed === true` implies
 * `gateRan === gateTotal`; any attempt that did not cleanly run makes `passed`
 * null, never `true` with a partial count.
 *
 * @param {{gate: string[], attempts: Array<{command: string, index: number, outcome: "ok"|"failed"|"spawn-error"|"timeout"|"signal"|"lock-timeout"}>}} args
 * @returns {{passed: boolean|null, gateReason: string|null, gateCommand: string|null, gateStep: number|null, gateTotal: number, gateRan: number}}
 */
export function decideVerdict({ gate, attempts }) {
  const gateTotal = Array.isArray(gate) ? gate.length : 0;
  for (const a of attempts) {
    if (a.outcome === "ok") continue;
    if (a.outcome === "failed") {
      return {
        passed: false,
        gateReason: null,
        gateCommand: a.command,
        gateStep: a.index + 1,
        gateTotal,
        gateRan: a.index + 1,
      };
    }
    // spawn-error | timeout | signal | lock-timeout — the command did not
    // cleanly complete, so it does not count toward gateRan.
    return {
      passed: null,
      gateReason: a.outcome,
      gateCommand: a.command,
      gateStep: a.index + 1,
      gateTotal,
      gateRan: a.index,
    };
  }
  if (gateTotal > 0 && attempts.length === gateTotal) {
    return { passed: true, gateReason: null, gateCommand: null, gateStep: null, gateTotal, gateRan: gateTotal };
  }
  // Fewer attempts than declared, none of them a failure/null outcome — the
  // caller stopped early without recording why. An instrument bug, not a
  // verdict this function may fabricate as true.
  return {
    passed: null,
    gateReason: "internal-error",
    gateCommand: null,
    gateStep: null,
    gateTotal,
    gateRan: attempts.length,
  };
}

/** Split `path[#json-pointer]` on the FIRST `#`. */
export function parseGateConfigEntry(entry) {
  const idx = entry.indexOf("#");
  if (idx === -1) return { path: entry, pointer: null };
  return { path: entry.slice(0, idx), pointer: entry.slice(idx + 1) };
}

function unescapePointerToken(tok) {
  return tok.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * RFC 6901 JSON Pointer resolution. `pointer === null` (no pointer declared)
 * or `""` (the whole-document pointer) both resolve to `value` itself.
 * @param {unknown} value
 * @param {string|null} pointer
 * @returns {{found: boolean, value: unknown}}
 */
export function resolveJsonPointer(value, pointer) {
  if (pointer === null || pointer === undefined || pointer === "") {
    return { found: true, value };
  }
  if (!pointer.startsWith("/")) return { found: false, value: undefined };
  const tokens = pointer.split("/").slice(1).map(unescapePointerToken);
  let cur = value;
  for (const tok of tokens) {
    if (cur === null || typeof cur !== "object") return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      const idx = Number(tok);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return { found: false, value: undefined };
      cur = cur[tok];
    }
  }
  return { found: true, value: cur };
}

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

/** Canonical JSON — object keys sorted recursively, so key reordering is not a "change". */
export function canonicalize(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * One `gateConfig[]` entry's contribution: `true` (changed), `false` (unchanged
 * / absent both sides / pointer resolves on neither side), or `null`
 * (unreadable on either side — baseline or worktree reader returned `null`, or
 * a declared pointer's file is not valid JSON).
 * @param {string} entry
 * @param {(relPath: string) => {present: boolean, content: string|null}|null} readBaseline
 * @param {(relPath: string) => {present: boolean, content: string|null}|null} readWorktree
 * @returns {boolean|null}
 */
function compareEntry(entry, readBaseline, readWorktree) {
  const { path: p, pointer } = parseGateConfigEntry(entry);
  const base = readBaseline(p);
  const work = readWorktree(p);
  if (base === null || work === null) return null;
  if (!base.present && !work.present) return false;
  if (base.present !== work.present) return true;
  if (pointer === null) {
    return base.content !== work.content;
  }
  let baseParsed;
  let workParsed;
  try {
    baseParsed = JSON.parse(base.content);
    workParsed = JSON.parse(work.content);
  } catch {
    return null; // not valid JSON — cannot resolve the pointer, unreadable
  }
  const baseRes = resolveJsonPointer(baseParsed, pointer);
  const workRes = resolveJsonPointer(workParsed, pointer);
  if (!baseRes.found && !workRes.found) return false;
  if (baseRes.found !== workRes.found) return true;
  return canonicalize(baseRes.value) !== canonicalize(workRes.value);
}

/**
 * Whether the seat moved its OWN declared gate config, across every declared
 * entry. Precedence `true > null > false`: one proven change cannot be
 * retracted by an unrelated unreadable sibling entry. `[]` (nothing declared)
 * is `null` ("unchecked"), never `false` ("checked and clean") — D-25.
 *
 * Readers are INJECTED so this needs no git repo at all in tests.
 * @param {string[]} entries
 * @param {(relPath: string) => {present: boolean, content: string|null}|null} readBaseline
 * @param {(relPath: string) => {present: boolean, content: string|null}|null} readWorktree
 * @returns {boolean|null}
 */
export function compareGateConfig(entries, readBaseline, readWorktree) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let sawNull = false;
  for (const entry of entries) {
    const result = compareEntry(entry, readBaseline, readWorktree);
    if (result === true) return true;
    if (result === null) sawNull = true;
  }
  return sawNull ? null : false;
}

/** Filesystem-safe key for one project+command's exclusive lock. */
export function lockKey(project, command) {
  const hash = createHash("sha1").update(command).digest("hex").slice(0, 12);
  return `${project}--${hash}`;
}

/** Absolute path to one project+command's exclusive lock file. */
export function lockFilePath(project, command, lockDir = DEFAULT_LOCK_DIR) {
  return path.join(lockDir, `${lockKey(project, command)}.lock`);
}

/**
 * Build the `gate_result` metrics event from a gate run's result. Field names
 * are identical to the metrics schema (`metrics.mjs`) — this just picks fields
 * and adds `seat`/`type`/`detail`; a rename layer here would be a place for a
 * translation bug. `runId` is NEVER invented: absent means `null`.
 * @param {{project: string, passed: boolean|null, gateReason: string|null, gateCommand: string|null, gateStep: number|null, gateTotal: number, gateRan: number, gateConfigTouched: boolean|null, durationMs: number}} result
 * @param {{seat?: "worker"|"validator", runId?: string|null}} [opts]
 */
export function buildGateEvent(result, { seat = "worker", runId = null } = {}) {
  return {
    seat: seat === "validator" ? "validator" : "worker",
    type: "gate_result",
    detail: `gate:${result.project}`,
    runId: runId ?? null,
    passed: result.passed,
    gateReason: result.gateReason,
    gateCommand: result.gateCommand,
    gateStep: result.gateStep,
    gateTotal: result.gateTotal,
    gateRan: result.gateRan,
    gateConfigTouched: result.gateConfigTouched,
    durationMs: result.durationMs,
  };
}

/** Map the three-valued verdict to the shell exit code (§7): 0 / 1 / 4. */
export function exitCodeFor(result) {
  if (result.passed === true) return 0;
  if (result.passed === false) return 1;
  return 4;
}

// ─── IO shell ────────────────────────────────────────────────────────────────

/**
 * Split a `gate[]` command string into argv WITHOUT a shell. Deliberate: with
 * `shell: true`, a missing binary (`pnpm` off PATH) is swallowed by the shell
 * itself (`sh -c` reports "command not found", exit 127 — a COMMAND failure,
 * not a launch failure). Spawning the binary directly is what makes
 * `spawnSync().error` (ENOENT) mean what `spawn-error` claims it means.
 * @param {string} command
 * @returns {string[]}
 */
function tokenizeCommand(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/**
 * Run one gate/prepare command. Inherits the FULL operator environment
 * (no `env` override — never `buildSpawnEnv`, see the file header).
 * @param {string} command @param {string} cwd @param {number} timeoutMs
 */
function runOne(command, cwd, timeoutMs) {
  const [file, ...args] = tokenizeCommand(command);
  const startedAt = Date.now();
  const raw = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { raw, timedOut: raw.error?.code === "ETIMEDOUT", durationMs: Date.now() - startedAt };
}

// ─── Exclusive lock (§4) ─────────────────────────────────────────────────────

function readLockPayload(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null; // corrupt / torn write
  }
}

/** `true` alive, `false` confirmed dead (ESRCH), `null` unknowable. */
function isHolderAlive(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.host !== os.hostname()) return null;
  if (typeof payload.pid !== "number") return null;
  try {
    process.kill(payload.pid, 0);
    return true;
  } catch (err) {
    return err?.code === "ESRCH" ? false : null;
  }
}

function tryCreateLock(lockPath, payload) {
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, JSON.stringify(payload));
    closeSync(fd);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return null; // signal: needs staleness check
    return false;
  }
}

/**
 * One acquisition attempt (no waiting). PID liveness is layer 1 (frees a
 * crashed holder in milliseconds); the mtime TTL is layer 2, the backstop for
 * when liveness cannot be determined at all (corrupt lock, different host).
 * @param {string} lockPath @param {object} payload @param {number} staleMs
 * @returns {boolean}
 */
export function acquireExclusiveOnce(lockPath, payload, staleMs = GATE_LOCK_STALE_MS) {
  const created = tryCreateLock(lockPath, payload);
  if (created === true) return true;
  if (created === false) return false;

  const existing = readLockPayload(lockPath);
  const alive = isHolderAlive(existing);
  if (alive === true) return false;
  if (alive === false) {
    try {
      unlinkSync(lockPath);
    } catch {
      return false; // lost the race to reclaim it — someone else has it now
    }
    return tryCreateLock(lockPath, payload) === true;
  }
  // Unknowable liveness — fall back to the mtime TTL backstop.
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age < staleMs) return false;
    unlinkSync(lockPath);
    return tryCreateLock(lockPath, payload) === true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wait for the exclusive lock up to `waitMs`, polling every `pollMs`.
 * Skipping on contention would manufacture a false pass (§4) — waiting is the
 * only option that does not corrupt the verdict.
 */
export function acquireExclusiveWithWait(
  lockPath,
  payload,
  { waitMs, pollMs = DEFAULT_LOCK_POLL_MS, staleMs = GATE_LOCK_STALE_MS, now = Date.now, sleep = sleepSync } = {},
) {
  const deadline = now() + waitMs;
  for (;;) {
    if (acquireExclusiveOnce(lockPath, payload, staleMs)) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    sleep(Math.min(pollMs, remaining));
  }
}

/** Best-effort release — never throws. */
export function releaseExclusive(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone / never ours — fine either way
  }
}

// ─── gateConfig git wiring ───────────────────────────────────────────────────

function gitMergeBase(dirAbs, trunk) {
  try {
    const r = spawnSync("git", ["merge-base", trunk, "HEAD"], {
      cwd: dirAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
    const sha = r.stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

function gitShowFile(dirAbs, ref, relPath) {
  try {
    const r = spawnSync("git", ["show", `${ref}:${relPath}`], {
      cwd: dirAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) return null;
    if (r.status === 0) return { present: true, content: r.stdout };
    const stderr = r.stderr || "";
    if (stderr.includes("does not exist in") || stderr.includes("exists on disk, but not in")) {
      return { present: false, content: null };
    }
    return null; // some other git failure — unresolvable, not "absent"
  } catch {
    return null;
  }
}

function readWorktreeFile(dirAbs, relPath) {
  const abs = path.join(dirAbs, relPath);
  if (!existsSync(abs)) return { present: false, content: null };
  try {
    return { present: true, content: readFileSync(abs, "utf8") };
  } catch {
    return null; // e.g. EACCES
  }
}

/**
 * `gateConfigTouched` for a real worktree: merge-base baseline vs. the tree on
 * disk. Computed INDEPENDENTLY of `passed` — quarantine only matters when
 * `passed === true`, but the two measurements stay orthogonal on purpose.
 * Dependencies are injected (defaulting to the real git/fs calls) so the two
 * null-guards below are reachable from a test WITHOUT a git repo. They were not,
 * before: `mergeBase === null -> null` survived being flipped to `false` with the
 * whole suite green (mutation-found 2026-08-28). Coercing it would let one broken
 * git environment launder every quarantined run into `delivered`.
 * @param {{trunk: string, gateConfig: string[]}} profile @param {string} dirAbs
 * @param {{mergeBase?: Function, show?: Function, read?: Function}} [deps]
 * @returns {boolean|null}
 */
export function computeGateConfigTouched(profile, dirAbs, deps = {}) {
  const mergeBaseFn = deps.mergeBase ?? gitMergeBase;
  const showFn = deps.show ?? gitShowFile;
  const readFn = deps.read ?? readWorktreeFile;
  const entries = Array.isArray(profile.gateConfig) ? profile.gateConfig : [];
  if (entries.length === 0) return null;
  const mergeBase = mergeBaseFn(dirAbs, profile.trunk);
  if (mergeBase === null) return null;
  return compareGateConfig(
    entries,
    (relPath) => showFn(dirAbs, mergeBase, relPath),
    (relPath) => readFn(dirAbs, relPath),
  );
}

// ─── Telemetry (best-effort, house shape — cf. claude-worker.mjs:452) ────────

function spawnMetricsRecord(slug, event, project) {
  const args = [METRICS_SCRIPT, "record", slug];
  if (project) args.push("--project", project);
  spawnSync(process.execPath, args, { input: JSON.stringify(event), stdio: ["pipe", "ignore", "ignore"] });
}

/** Telemetry must never fail a run. */
export function recordMetric(slug, event, project, spawnFn = spawnMetricsRecord) {
  try {
    spawnFn(slug, event, project);
  } catch {
    /* telemetry must never fail the run */
  }
}

// ─── Gate run orchestration ──────────────────────────────────────────────────

function warnDeadGateExclusive(profile) {
  for (const cmd of profile.gateExclusive ?? []) {
    if (!profile.gate.includes(cmd)) {
      process.stderr.write(`gate: gateExclusive entry has no matching gate[] command (dead config): ${cmd}\n`);
    }
  }
}

/**
 * Run the full gate for one worktree: preflight, optional prepare, then the
 * declared `gate[]` commands in order, fail-fast. `gateConfigTouched` is always
 * computed, on every path, independently of the verdict.
 *
 * @param {object} opts
 * @param {{gate: string[], prepare: string[], prepareMarker: string|null, gateExclusive: string[], gateConfig: string[], trunk: string}} opts.profile
 * @param {string} opts.dirAbs @param {string} opts.project
 * @param {boolean} [opts.prepareRequested] @param {number} [opts.timeoutMs]
 * @param {number} [opts.lockWaitMs] @param {number} [opts.lockPollMs]
 * @param {boolean} [opts.noLock] @param {string} [opts.lockDir]
 * @param {() => number} [opts.now] @param {(ms:number)=>void} [opts.sleep]
 * @param {(cmd:string, cwd:string, timeoutMs:number) => {raw: object, timedOut: boolean, durationMs: number}} [opts.spawnCommand]
 */
export function runGate(opts) {
  const {
    profile,
    dirAbs,
    project,
    prepareRequested = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    lockWaitMs = DEFAULT_LOCK_WAIT_MS,
    lockPollMs = DEFAULT_LOCK_POLL_MS,
    noLock = false,
    lockDir = DEFAULT_LOCK_DIR,
    now = Date.now,
    sleep = sleepSync,
    spawnCommand = runOne,
  } = opts;

  warnDeadGateExclusive(profile);

  const gate = Array.isArray(profile.gate) ? profile.gate : [];
  const gateTotal = gate.length;
  const gateConfigTouched = computeGateConfigTouched(profile, dirAbs);

  if (gateTotal === 0) {
    return {
      passed: null,
      gateReason: "no-gate",
      gateCommand: null,
      gateStep: null,
      gateTotal,
      gateRan: 0,
      gateConfigTouched,
      commands: [],
    };
  }

  const markerExists = profile.prepareMarker ? existsSync(path.join(dirAbs, profile.prepareMarker)) : false;
  const pf = preflight({ profile, markerExists, prepareRequested });

  if (!pf.ok) {
    return {
      passed: null,
      gateReason: pf.reason,
      gateCommand: null,
      gateStep: null,
      gateTotal,
      gateRan: 0,
      gateConfigTouched,
      commands: [],
    };
  }

  if (pf.needsPrepare) {
    for (const cmd of profile.prepare) {
      const r = spawnCommand(cmd, dirAbs, timeoutMs);
      const status = classifyCommandResult(r.raw, { timedOut: r.timedOut });
      if (status !== "ok") {
        return {
          passed: null,
          gateReason: "prepare-failed",
          gateCommand: null,
          gateStep: null,
          gateTotal,
          gateRan: 0,
          gateConfigTouched,
          commands: [],
        };
      }
    }
    const provisioned = profile.prepareMarker ? existsSync(path.join(dirAbs, profile.prepareMarker)) : true;
    if (!provisioned) {
      return {
        passed: null,
        gateReason: "prepare-failed",
        gateCommand: null,
        gateStep: null,
        gateTotal,
        gateRan: 0,
        gateConfigTouched,
        commands: [],
      };
    }
  }

  const attempts = [];
  const commandsOut = [];
  for (let i = 0; i < gate.length; i++) {
    const cmd = gate[i];
    let lockPath = null;
    let lockHeld = false;
    if (!noLock && profile.gateExclusive.includes(cmd)) {
      lockPath = lockFilePath(project, cmd, lockDir);
      const payload = {
        pid: process.pid,
        host: os.hostname(),
        command: cmd,
        project,
        dir: dirAbs,
        startedAt: new Date().toISOString(),
      };
      lockHeld = acquireExclusiveWithWait(lockPath, payload, { waitMs: lockWaitMs, pollMs: lockPollMs, now, sleep });
      if (!lockHeld) {
        attempts.push({ command: cmd, index: i, outcome: "lock-timeout" });
        break;
      }
    }
    try {
      const r = spawnCommand(cmd, dirAbs, timeoutMs);
      const status = classifyCommandResult(r.raw, { timedOut: r.timedOut });
      attempts.push({ command: cmd, index: i, outcome: status });
      commandsOut.push({ command: cmd, status, exitCode: r.raw?.status ?? null, durationMs: r.durationMs });
      if (status !== "ok") break;
    } finally {
      if (lockHeld) releaseExclusive(lockPath);
    }
  }

  const verdict = decideVerdict({ gate, attempts });
  return { ...verdict, gateConfigTouched, commands: commandsOut };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/gate.mjs --project <id> --dir <worktree>\n" +
      "    [--slug <mission>] [--run-id <id>] [--seat worker|validator]\n" +
      "    [--prepare] [--timeout <ms>] [--lock-wait <ms>] [--no-lock] [--json]\n",
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    project: undefined,
    dir: undefined,
    slug: undefined,
    runId: undefined,
    seat: "worker",
    prepareRequested: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    lockWaitMs: DEFAULT_LOCK_WAIT_MS,
    noLock: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project") opts.project = args[++i];
    else if (a === "--dir") opts.dir = args[++i];
    else if (a === "--slug") opts.slug = args[++i];
    else if (a === "--run-id") opts.runId = args[++i];
    else if (a === "--seat") opts.seat = args[++i];
    else if (a === "--prepare") opts.prepareRequested = true;
    else if (a === "--timeout") opts.timeoutMs = Number(args[++i]);
    else if (a === "--lock-wait") opts.lockWaitMs = Number(args[++i]);
    else if (a === "--no-lock") opts.noLock = true;
    else if (a === "--json") opts.json = true;
  }
  return opts;
}

/**
 * CLI entry point. Returns the process exit code — never calls `process.exit`
 * itself, so tests can call this directly and inspect the return value.
 * @param {string[]} [argv] @param {{runGateFn?: typeof runGate}} [inject]
 */
export function main(argv = process.argv, { runGateFn = runGate } = {}) {
  const opts = parseArgs(argv);
  if (!opts.dir) {
    usage();
    return 2;
  }

  let project;
  try {
    project = assertKnownProject(opts.project);
  } catch (err) {
    process.stderr.write(`gate: ${err.message}\n`);
    return 2;
  }

  const dirAbs = path.resolve(opts.dir);
  const { profile } = resolveProject({ project });

  if (!isWorktreeDir(dirAbs, profile.worktreeMarker)) {
    process.stderr.write(
      `gate: --dir does not look like a dispatched worktree (marker ${profile.worktreeMarker}) — proceeding\n`,
    );
  }
  if (opts.noLock) {
    process.stderr.write("gate: --no-lock — exclusive-lock serialization disabled by operator\n");
  }
  if (!opts.slug) {
    process.stderr.write("gate: no --slug — verdict not recorded\n");
  }

  const startedAt = Date.now();
  let result;
  try {
    result = runGateFn({
      profile,
      dirAbs,
      project,
      prepareRequested: opts.prepareRequested,
      timeoutMs: opts.timeoutMs,
      lockWaitMs: opts.lockWaitMs,
      noLock: opts.noLock,
    });
  } catch (err) {
    process.stderr.write(`gate: internal error — ${err?.message ?? err}\n`);
    result = {
      passed: null,
      gateReason: "internal-error",
      gateCommand: null,
      gateStep: null,
      gateTotal: Array.isArray(profile.gate) ? profile.gate.length : 0,
      gateRan: 0,
      gateConfigTouched: null,
      commands: [],
    };
  }

  const durationMs = Date.now() - startedAt;
  const runId = opts.runId ?? null;
  const finalResult = { project, dir: dirAbs, runId, ...result, durationMs };

  if (opts.slug) {
    recordMetric(opts.slug, buildGateEvent(finalResult, { seat: opts.seat, runId }), project);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(finalResult, null, 2)}\n`);
  } else {
    process.stdout.write(
      `gate: project=${project} passed=${finalResult.passed} ran=${finalResult.gateRan}/${finalResult.gateTotal} configTouched=${finalResult.gateConfigTouched} wallMs=${finalResult.durationMs}\n`,
    );
    if (finalResult.passed === false) {
      process.stderr.write(`gate: failing command: ${finalResult.gateCommand}\n`);
    }
  }

  return exitCodeFor(finalResult);
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`gate: ${err?.message ?? err}\n`);
    process.exit(4);
  }
}

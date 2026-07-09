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

import { FACTORY_ROOT, loadProjects } from "./project.mjs";

/** Default grace period before a stubborn child is killed outright. */
export const DEFAULT_GRACE_MS = 30_000;

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

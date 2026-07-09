/**
 * worker-common.mjs — behaviour shared by every worker driver (opencode today,
 * a caged Claude Code driver later).
 *
 * Usage:
 *   import { killGracefully } from "./lib/worker-common.mjs";
 *   const { escalated } = await killGracefully(child, { graceMs: 30_000 });
 *
 * No exit codes — this is a library, not a CLI.
 */

/** Default grace period before a stubborn child is killed outright. */
export const DEFAULT_GRACE_MS = 30_000;

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

/**
 * run-log.mjs — reconcile phase_start/phase_end/gate_result into whole runs.
 *
 * A worker that gets SIGKILLed, OOMs, or whose parent dies never writes its
 * phase_end — so the run silently vanishes from every aggregate that reads
 * phase_end alone, and the runs that vanish are exactly the ones that crashed.
 * Every existing factory metric is optimistically biased for this reason. This
 * walks the events in file order and pairs each start with its end, so a start
 * with no end is counted as an ORPHAN instead of disappearing.
 *
 * PAIRING. `runId` (minted once per spawn by the driver) is the key when both
 * sides carry one. Legacy rows have no runId and fall back to FIFO by
 * seat+model — which is a GUESS: several worktrees running concurrently on one
 * mission interleave their rows and nothing can untangle them. The fallback
 * exists to keep old dossiers readable, not because it is sound; `pairedBy` on
 * each completed run says which was used, so a consumer can tell a fact from a
 * guess.
 *
 * A `gate_result` joins its run by runId only. There is no FIFO fallback for
 * the gate: attaching a verdict to the wrong run would manufacture a false
 * `delivered` or `broken`, which is worse than an unmeasured one.
 *
 * Pure, no I/O. Tolerates a torn file (crashed mid-write): non-object entries
 * and unrecognized event types are skipped rather than thrown on.
 */

/**
 * @param {unknown[]} events — parsed metrics.jsonl entries, oldest first.
 * @returns {{
 *   completed: Array<{runId: string|null, seat: string, model: string, startTs: *, endTs: *,
 *                     durationMs: number|null, pairedBy: "runId"|"fifo",
 *                     filesChanged: number|null, passed: boolean|null,
 *                     gateConfigTouched: boolean|null}>,
 *   orphaned: Array<{runId: string|null, seat: string, model: string, startTs: *}>,
 *   endsWithoutStart: Array<{runId: string|null, seat: string, model: string, endTs: *}>,
 *   unpairedGates: Array<{runId: string|null, passed: boolean|null}>,
 * }}
 */
export function reconcileRuns(events) {
  const result = { completed: [], orphaned: [], endsWithoutStart: [], unpairedGates: [] };
  if (!Array.isArray(events)) return result;

  // Unmatched phase_starts, in arrival order, so the earliest one claims the
  // next matching phase_end under the legacy FIFO fallback.
  const pending = [];
  // runId -> completed entry, for the gate_result join.
  const byRunId = new Map();
  const gates = [];

  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const runId = typeof event.runId === "string" && event.runId.length > 0 ? event.runId : null;

    if (event.type === "phase_start") {
      pending.push({ runId, seat: event.seat, model: event.model, ts: event.ts });
      continue;
    }

    if (event.type === "gate_result") {
      gates.push({ runId, event });
      continue;
    }

    if (event.type === "phase_end") {
      // runId first — a fact. FIFO only for rows that never had one.
      let idx = runId === null ? -1 : pending.findIndex((p) => p.runId === runId);
      const pairedBy = idx === -1 ? "fifo" : "runId";
      if (idx === -1) {
        idx = pending.findIndex(
          (p) => p.runId === null && p.seat === event.seat && p.model === event.model,
        );
      }
      if (idx === -1) {
        result.endsWithoutStart.push({
          runId,
          seat: event.seat,
          model: event.model,
          endTs: event.ts,
        });
        continue;
      }
      const [startRow] = pending.splice(idx, 1);
      const entry = {
        runId: runId ?? startRow.runId,
        seat: event.seat,
        model: event.model,
        startTs: startRow.ts,
        endTs: event.ts,
        durationMs: durationBetween(startRow.ts, event.ts),
        pairedBy,
        // Outcome inputs, carried through untouched so `classifyRun` sees the
        // driver's own measurement — absent stays null, never 0/false.
        filesChanged: numOrNull(event.filesChanged),
        passed: boolOrNull(event.passed),
        gateConfigTouched: boolOrNull(event.gateConfigTouched),
      };
      result.completed.push(entry);
      if (entry.runId !== null) byRunId.set(entry.runId, entry);
    }
  }

  // The gate runs AFTER phase_end, so it is joined in a second pass — a
  // single forward walk would always see the verdict before its run exists.
  for (const g of gates) {
    const target = g.runId === null ? undefined : byRunId.get(g.runId);
    if (!target) {
      result.unpairedGates.push({ runId: g.runId, passed: boolOrNull(g.event.passed) });
      continue;
    }
    target.passed = boolOrNull(g.event.passed);
    target.gateConfigTouched = boolOrNull(g.event.gateConfigTouched);
  }

  for (const startRow of pending) {
    result.orphaned.push({
      runId: startRow.runId,
      seat: startRow.seat,
      model: startRow.model,
      startTs: startRow.ts,
    });
  }

  return result;
}

/** A number passes through (0 is a real measurement); anything else is absence. */
function numOrNull(v) {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

/** A boolean passes through; anything else is absence — never coerced. */
function boolOrNull(v) {
  return typeof v === "boolean" ? v : null;
}

/** Milliseconds between two ISO timestamps, or null if either is missing/unparseable. */
function durationBetween(startTs, endTs) {
  const start = Date.parse(startTs);
  const end = Date.parse(endTs);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

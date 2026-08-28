/**
 * Reconciles phase_start/phase_end pairs from a metrics.jsonl stream.
 *
 * A worker that gets SIGKILLed, OOMs, or whose parent dies never writes its
 * phase_end — so the run silently vanishes from every aggregate that reads
 * phase_end alone, and the worst runs (the ones that crashed) are exactly the
 * ones missing. This walks the events in file order and pairs each
 * phase_start with the next later phase_end sharing the same seat + model,
 * so a start with no such end can be counted as an orphan instead of just
 * disappearing.
 *
 * Pure, no I/O. Tolerates a torn file (crashed mid-write): non-object entries
 * and unrecognized event types are skipped rather than thrown on.
 *
 * @param {unknown[]} events - parsed metrics.jsonl entries, oldest first.
 * @returns {{
 *   completed: {seat: string, model: string, startTs: *, endTs: *, durationMs: number|null}[],
 *   orphaned: {seat: string, model: string, startTs: *}[],
 * }}
 */
export function reconcileRuns(events) {
  const result = { completed: [], orphaned: [] };
  if (!Array.isArray(events)) return result;

  // Unmatched phase_starts, in arrival order, so the earliest one claims the
  // next matching phase_end (FIFO per seat+model).
  const pending = [];

  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;

    if (event.type === "phase_start") {
      pending.push({ seat: event.seat, model: event.model, ts: event.ts });
      continue;
    }

    if (event.type === "phase_end") {
      const idx = pending.findIndex((p) => p.seat === event.seat && p.model === event.model);
      if (idx === -1) continue;
      const [start] = pending.splice(idx, 1);
      result.completed.push({
        seat: event.seat,
        model: event.model,
        startTs: start.ts,
        endTs: event.ts,
        durationMs: durationBetween(start.ts, event.ts),
      });
    }
  }

  for (const start of pending) {
    result.orphaned.push({ seat: start.seat, model: start.model, startTs: start.ts });
  }

  return result;
}

/** Milliseconds between two ISO timestamps, or null if either is missing/unparseable. */
function durationBetween(startTs, endTs) {
  const start = Date.parse(startTs);
  const end = Date.parse(endTs);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

/**
 * is-main.mjs — the house "am I the entry point?" guard, made total.
 *
 * Every engine script ends with:
 *
 *   if (isMainModule(import.meta.url)) process.exit(main());
 *
 * so that importing it (from a test, or from another script) runs no CLI.
 *
 * Why this is a module and not a one-liner: the one-liner it replaces was
 *
 *   const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
 *
 * and `process.argv[1]` is `undefined` whenever node was not given a script path —
 * `node -e "import('./scripts/metrics.mjs')"`, `node --eval`, some embeddings and
 * REPL contexts. `pathToFileURL(undefined)` throws ERR_INVALID_ARG_TYPE, so merely
 * IMPORTING an engine script crashed. All twelve scripts carried the same bug.
 *
 * A guard whose job is "decide whether to run" must never throw deciding it.
 *
 * @param {string} importMetaUrl — the caller's `import.meta.url`
 * @param {string[]} [argv] — defaults to `process.argv`; injectable for tests
 * @returns {boolean} true when this module IS the process entry point
 */
import { pathToFileURL } from "node:url";

export function isMainModule(importMetaUrl, argv = process.argv) {
  const entry = argv?.[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  try {
    return importMetaUrl === pathToFileURL(entry).href;
  } catch {
    // A non-path entry (a `-` stdin marker, an odd embedding) is not this module.
    return false;
  }
}

# fix-cw-telemetry — handoff

## Root cause

`scripts/claude-worker.mjs` line 64 used:

```js
const __dirname = path.dirname(new URL(".", import.meta.url).pathname);
```

`new URL(".", import.meta.url)` resolves to the *directory* URL — i.e., the pathname
ends with a trailing slash (`…/scripts/`). `path.dirname("…/scripts/")` treats the
trailing slash as a "current-dir" component and strips it, returning `…/factory/`
(the repo root). So `path.join(__dirname, "metrics.mjs")` resolved to
`<repoRoot>/metrics.mjs`, which does not exist (`metrics.mjs` lives in `scripts/`).

`spawnSync` silently ignored the missing script (`stdio: ["pipe","ignore","ignore"]`),
so every `recordMetric` call in every claude-worker seat run produced no events and
dropped all phase_start / phase_end telemetry with no error message.

## Fix

1. Added `import { fileURLToPath } from "node:url";` to the imports.
2. Replaced the broken `__dirname` with the correct idiom:
   ```js
   const __dirname = path.dirname(fileURLToPath(import.meta.url));
   ```
3. Exported the computed path as a single source of truth:
   ```js
   export const METRICS_SCRIPT = path.join(__dirname, "metrics.mjs");
   ```
4. Updated `recordMetric` to spawn `METRICS_SCRIPT` instead of recomputing inline.

## RED evidence (test failed before the fix)

```
file:///…/scripts/claude-worker.test.mjs:29
  METRICS_SCRIPT,
  ^^^^^^^^^^^^^^
SyntaxError: The requested module './claude-worker.mjs' does not provide an export named 'METRICS_SCRIPT'
    …
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

## GREEN evidence (test passes after the fix)

```
✔ METRICS_SCRIPT: resolves to a real file inside scripts/ (1.00463ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

## Full gate result

```
ℹ tests 560
ℹ pass 541
ℹ fail 13   ← all 13 are pre-existing environmental failures
             (board-sync / board-import-backlog / verdict-hook)
ℹ skipped 6
```

Zero new failures introduced. All 31 pre-existing claude-worker tests remain green.

## Files changed

- `scripts/claude-worker.mjs` — added `fileURLToPath` import; fixed `__dirname`;
  exported `METRICS_SCRIPT`; updated `recordMetric` to use it.
- `scripts/claude-worker.test.mjs` — added `METRICS_SCRIPT` to imports; added two-
  assertion regression test guarding the exact bug.

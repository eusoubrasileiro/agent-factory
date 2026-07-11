# RESUME ON PREDATOR — gold-eval Prompts-tab redesign

Written 2026-07-10 on z390m. Pick up the eval-viewer Prompts-tab redesign here.

## 1. Pull all three repos
```bash
cd ~/Projects/amiticia/repositories
git -C products/wahub fetch origin && git -C products/wahub checkout agent/gold-eval-viewer && git -C products/wahub pull
git -C tools/eval-viewer pull origin master
git -C tools/factory  pull origin main
```

## 2. Read the full handoff (start at §3)
```
tools/factory/missions/wahub/gold-eval-prompt-visibility/REDESIGN-HANDOFF.md
```

## 3. TL;DR of the work
- Redesign the **Prompts tab** = static/hashed surface ONLY: all static prompts
  (businessContext, slotSchema, NLU + agent system, tool JSON schemas) each with a
  source-file link readable in-browser.
- Per-thread/dynamic pieces stay on the **Threads** tab (already done).
- **Drop static no-run mode** (`/static` route, `staticMode`, `promptsFallback`).
- Run KB research first (research gate); ask André before any paid eval run.

Shipped already (don't redo): producer `wahub@2ba6fd7`, viewer `eval-viewer@a13dfa3`.

# factory — Behavioral Validation Playbook

> The engine is itself a project (dogfood). Missions that change the engine run
> with `--project factory`; dossiers land in `missions/factory/<slug>/`.

## Deterministic gate

`project.json → gate[]`, run with `cwd` = the factory repo root:

```bash
pnpm test    # FACTORY_AUTOPUBLISH=0 FACTORY_PR=0 node --test "scripts/*.test.mjs" "projects/*/*.test.mjs"
```

Any non-zero exit → **FAIL**.

## Behavioral probes

**None.** The engine has no chat surface, no UI, and no live vendor calls. Its
behavior is fully covered by `node --test`, which is why `gate[]` is a single
command. If a future engine change adds a user-facing surface, add its probe here —
never to a `skills/` file.

## Standing rules for this project

- No dependency outside `node:*` in `scripts/`. `backlog.md` is the sole devDependency
  and is used by the board only.
- Every script keeps: the `isMain` guard, a header comment with Usage + exit codes,
  and **soft-fail semantics** — a broken side channel exits 0 and never blocks a
  verdict or a ratify.
- `resolveProject` is TOTAL. A missing, empty, or corrupt profile yields synthesized
  defaults; it never throws.
- Tests are `node:test` + `node:assert/strict`. **Not vitest.** A test file outside
  the `pnpm test` globs is silently never run — check the globs when adding one.
- Isolation for engine missions is a plain git worktree under `.worktrees/` (the
  wahub `dispatch-worktree.sh` is a wahub tool and does not apply here).

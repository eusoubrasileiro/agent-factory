You are the caged GLM-5.2 BUILDER seat for factory mission `client-view` (v2 — a REDESIGN
after v1 failed a real-data leak test).

Working dir: this git worktree, branch `agent/client-view-v2`. Read
`missions/factory/client-view/brief.md` then `contract.md` NOW — the contract is v2 and
supersedes v1. The KEY change: the client page renders CURATED labels from
`/home/andre/Projects/amiticia/clients/tenant-a/client-labels.json`, NEVER the intake
`summary` (which is engineering prose and leaked everything in v1).

Discipline (non-negotiable):
- TDD Red-Green-Refactor. The leak test (C1, against the REAL tenant-a intake + real
  labels file) is the heart — write it FIRST and make it pass for real.
- Touch ONLY the files the contract allows. Plain Node ESM .mjs, node:test. No deps.
- Whitelist by construction + fail-closed guard (B1). A row renders only if it has a
  curated visible label AND passes isClientSafe().
- Never write product names (wahub/tenant-c/nexus) in scripts/** — meta-test enforces.
- Gate before every commit: `pnpm test` green from the worktree root. Commit on
  branch `agent/client-view-v2`.
- When done: `missions/factory/client-view/features/02.handoff.md`. STOP.

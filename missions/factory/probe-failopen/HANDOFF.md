# Handoff — security probes must not report success without verifying

Three VERIFIED fail-open defects in the cage/secrets probes. Each printed a green
result while checking nothing. All three fixed under TDD (red → green → mutation),
touched only the four allowed files, `pnpm test` green (493 tests, 0 fail).

## Per-file changes

### `scripts/probe-cage.mjs`
- **Defect 1 (static certifies a disarmed cage).**
  - CLI now gates on `assertKnownProject(project)` (imported from
    `scripts/lib/worker-common.mjs` — reused, not reimplemented). An absent or
    unknown `--project` is caught, `probe-cage: <message>` written to stderr,
    and the process exits **2** before the renderer runs. The message lists the
    known ids (read at runtime from `loadProjects()`, never hardcoded). This
    replaced the total `project ? resolveProject(...) : []` ternary.
  - Added a **CONTROL check as the FIRST element** of both `staticChecks`
    (opencode) and `claudeStaticChecks` (claude), mirroring `runLive`'s existing
    control discipline. It asserts `criticalFiles.length > 0`; when zero it fails
    (`ok:false`) with a detail stating every deny below is VACUOUS and the run
    proves nothing.
- **Defect 3 (`git push` live check was a placebo).**
  - Renamed the HEAD check to `GROUND TRUTH: no local commit (git HEAD unchanged)`
    — it proves no commit, never a push (`git push` does not move local HEAD).
  - Added a real push detector: `armPushDetector` stands up a local **bare
    remote** (`git init --bare` in a temp dir) and points the worktree's `origin`
    at it; `captureRemoteRefs` snapshots `git ls-remote <bare>` before/after the
    run; the check asserts the advertised refs are unchanged. A push the cage
    permitted would move them.
  - If a remote cannot be established, the check is **SKIPPED** (`skipped:true`),
    never PASS. `armPushDetector` returns `null` on any failure and leaves no
    bare behind; `disarmPushDetector` restores the worktree's `origin` and
    removes the bare, following `runLive`'s `planted` + `finally` cleanup pattern.
  - Extended the runner to express a third state: new exported pure helpers
    `checkTag(c)` → `PASS|FAIL|SKIP`, and `checksPass(checks)` which requires
    `c.ok && !c.skipped` — a skipped check does not let the run exit 0.
- New exports: `checkTag`, `checksPass`, `captureRemoteRefs`, `armPushDetector`,
  `disarmPushDetector`. Imports added: `assertKnownProject`, `mkdtempSync`,
  `tmpdir`. Header/usage text unchanged in substance (exit codes already 0/1/2).

### `scripts/probe-cage.test.mjs`
- Imports for the new exports + git-fixture helpers.
- Defect 1: CONTROL-is-first-and-fails-on-empty for both static arrays; CONTROL
  passes with globs present; CLI exits 2 + lists known projects when `--project`
  is absent; CLI exits 2 on an unknown id (`whaub`).
- Defect 3: `checkTag` SKIP/PASS/FAIL matrix; `checksPass` treats a skipped check
  (even `ok:true`) as not-a-pass; `captureRemoteRefs` empty→stable→changes-on-push;
  arm/disarm restores `origin` and removes the bare; `armPushDetector` returns
  `null` when the worktree is not a git repo (→ SKIPPED).

### `scripts/probe-secrets.mjs`
- **Defect 2 (reported `clean` when it never compared).** Missing parent `.env`
  is now a **precondition failure (exit 2)**, not clean (exit 0). Message names
  the path looked for and the `--parent` flag, and says it "could not compare".
  Exit 1 stays reserved for "LEAK found". Updated the header exit-code table and
  the `usage()` exit-code line to match.

### `scripts/probe-secrets.test.mjs`
- Two CLI tests: exits 2 (not 0) when the parent `.env` is absent — message says
  "could not compare", names the path + `--parent`, and does NOT say "clean"; a
  leaked secret with no parent `.env` still exits 2 (the scan never ran).

## Verbatim CLI verifications

```
$ node scripts/probe-cage.mjs /tmp/some-wt --driver claude
probe-cage: --project is required — the cage's Critical-File rules and this run's telemetry routing come from the project profile. Known projects: factory, tenant-c, wahub
exit=2
```

```
$ node scripts/probe-cage.mjs /tmp/some-wt --project whaub --driver claude
probe-cage: --project "whaub" is unknown — the cage's Critical-File rules and this run's telemetry routing come from the project profile. Known projects: factory, tenant-c, wahub
exit=2
```

```
$ node scripts/probe-secrets.mjs /tmp/tmp.hYYIljKX9C --parent /tmp/tmp.MqpPS7ACow
probe-secrets: no parent .env at /tmp/tmp.MqpPS7ACow/.env — could not compare (point --parent <dir> at a root with a real .env)
exit=2
```
(The seat in verification 3 carries `OPENAI_API_KEY=sk-genuinely-leaked-real-secret-…`
in its own `.env` — the old code certified that clean; it now refuses to certify.)

## Mutation-test results (weaken guard → named test goes RED → restore)

| Mutation | Weakened guard | Test that caught it (went RED) |
|---|---|---|
| M1a | skip the `assertKnownProject` gate (`knownProject = project`) | `CLI: exits 2 and lists known projects when --project is absent` **and** `CLI: exits 2 on an unknown --project id` |
| M1b | CONTROL `ok:true` always (both static arrays) | `staticChecks: CONTROL is FIRST and FAILS when no Critical Files are declared` **and** the `claudeStaticChecks` twin |
| M2a | revert missing-`.env` branch to `clean` / exit 0 | `CLI: exits 2 (NOT 0) when the parent .env is absent — could not compare, not clean` **and** `CLI: a leaked secret with no parent .env still exits 2` |
| M3a | `checksPass` drops `!c.skipped` | `checksPass: a SKIPPED check does not count as a pass` (the `{ok:true, skipped:true}` case) |
| M3b | `checkTag` drops the SKIP branch | `checkTag: SKIP for a skipped check — never PASS` |
| M3c | `captureRemoteRefs` always returns `""` | `captureRemoteRefs: …changed after one` |
| M3d | `armPushDetector` drops the failure check (returns an arm it never armed) | `armPushDetector: returns null when the worktree is not a git repo (→ SKIPPED, never PASS)` |

Every guard's removal turned a named test red; every guard restored; final
`pnpm test` = 493 pass / 0 fail. A mutation-run of M3d left one stray
`/tmp/probe-cage-bare-*` behind (the broken path skipped cleanup after the
assertion failed); it was removed, and the restored code was re-shown to leave
nothing behind on the failure path.

## What I could not do, and why
- `runLive` (live mode) is **not exercised end-to-end** — the spec forbids
  invoking a real model (`claude -p` / opencode). Its new push-detector behavior
  is therefore pinned through the extracted, unit-tested helpers
  (`armPushDetector`, `disarmPushDetector`, `captureRemoteRefs`) plus
  `checkTag`/`checksPass`, exercised with real git plumbing against temp repos
  (no model). The wiring inside `runLive` reuses exactly those helpers.

## Out of scope, but noticed
- `resolveProject` is deliberately TOTAL (an unknown id degrades to a default
  profile with zero Critical Files). The Defect-1 fix does not change that — it
  adds the strictness *at the probe's CLI entry*, exactly where the dossier
  prescribes, leaving `resolveProject` soft-fail for the mission tooling that
  depends on it.
- A known project whose `critical-files.json` is empty (engine-only) now fails
  the static CONTROL (vacuous denies) and, in live mode, still hits `runLive`'s
  existing `declares no critical files` guard. Both are the intended "nothing to
  enforce" outcome — flagged here so it is not read as a regression.
- `probe-secrets` had exactly one in-repo code caller of its CLI contract:
  `scripts/project-profile.test.mjs` imports only the pure `parseEnv` /
  `extractSecrets` (not `main()`), so the exit-code change (0→2 on missing
  parent `.env`) breaks no in-repo caller. All other references are mission/plan
  docs or the companion test.

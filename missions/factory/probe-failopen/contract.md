# Validation Contract — probe-failopen

> Written by the coordinator **before** any code exists (C3). The builder never sees this file;
> it receives only its feature spec. A held-out validator judges the diff against these
> assertions.

## Definition of done

The factory's two security probes can no longer report success without having verified anything.
A probe that cannot run says so and exits non-zero; it never prints `PASS` or `clean` for a check
it did not perform.

## Why this mission exists

We fixed the seat drivers (D-24): a forgotten or misspelled `--project` used to render a cage with
11 deny rules instead of 35, silently. Two independent audits then found that **the probes meant to
catch exactly that failure have the same failure**, plus one check that cannot fail by construction.
A false certificate of containment is worse than no certificate: it converts an unknown into a
believed-safe.

## Assertions

| id | Assertion | Proof |
|----|-----------|-------|
| B1 | `probe-cage.mjs` with **no** `--project` exits **2** and names the known project ids | CLI test |
| B2 | `probe-cage.mjs` with an **unknown** `--project` exits 2 | CLI test |
| B3 | Static mode emits a **CONTROL check, first in the list**, that FAILS when the resolved profile has zero Critical-File globs — mirroring `runLive`'s existing control discipline | unit test against a temp profile fixture whose `critical-files.json` is `[]` |
| B4 | The control's failure detail states that every deny check below it is **vacuous** | unit test asserts the wording |
| B5 | Both `staticChecks` (opencode) and `claudeStaticChecks` carry the control | unit test, both functions |
| B6 | `probe-secrets.mjs` distinguishes **"could not compare"** from **"clean"**: an absent parent `.env` exits **2** (precondition failure), never 0, and the message names the path it looked for and the `--parent` flag | CLI test |
| B7 | Exit **1** remains reserved for "LEAK found" in `probe-secrets.mjs`; the header's exit-code table matches the code | grep + CLI test |
| B8 | The `git push` live check no longer asserts on local HEAD as a push detector. It either observes a **real remote ref** before/after, or reports **SKIPPED** — never `PASS` when it could not observe | unit test |
| B9 | A check that cannot fail never prints `PASS` anywhere in `probe-cage.mjs` | code review + B3/B8 |
| B10 | `resolveProject()` is unchanged — it stays TOTAL for the mission tooling | `git diff` is empty for `scripts/lib/project.mjs` |

## Adversarial notes for the validator

- **B3 is the heart.** A test that merely calls `staticChecks` with a populated glob list proves
  nothing. The test must construct the **zero-glob** case and assert the control **fails**.
- **Mutation is the real gate.** For each of B3, B6, B8: weaken the guard and a named test must go
  RED. A guard whose removal leaves the suite green is decoration, and the mission fails.
- Beware the shape this mission is about: do not accept a fix whose own test would pass if the
  feature were deleted.

## House gate

`pnpm test` exits 0, test count > 480. No dependency outside `node:*`. No product literals in
`scripts/`. `isMainModule` guards intact. `node --test` + `node:assert/strict`, never vitest.

## Out of scope

`decisions.md` (a Critical File of the `factory` profile — the caged builder cannot edit it, and
must not; the coordinator records D-25). The `Bash`-bypass question (a separate, unresolved
finding). Any change to `cage-settings.mjs` or the cage templates.

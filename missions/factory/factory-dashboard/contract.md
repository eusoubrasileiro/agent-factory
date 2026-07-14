# Validation Contract — factory-dashboard

> **Reader: the held-out validator.** Prove every assertion against LOCAL disk with the
> stated mechanism. Behavior, not intent. An assertion without a green proof FAILS.
> VPS/DNS/htpasswd steps are Andre-manual and are NOT part of this contract.

## Assertions

| ID | Assertion | Proof mechanism |
|----|-----------|-----------------|
| A1 | `pnpm board:report` exits 0 and writes `dist/factory-board/index.html` as ONE self-contained file: no `http://`/`https://` resource loads (`<script src`, `<link href`, `<img src` pointing at external hosts all absent; inline data: URIs allowed). | Run it; grep the output file. |
| A2 | All 18 requirement IDs (A1–A5, B1–B4, C1–C6, D1–D3) from `docs/prd/nexus-build-backlog.md` appear in the HTML; each row shows either an implementing mission slug or the literal "sem missão". | Run against the real repo; grep/count. |
| A3 | Collision guard: a fixture mission whose contract.md contains local IDs "C1"/"C2" but whose brief.md has NO `**Requirements:**` line (or `Requirements: none`) is rendered UNMAPPED — it never appears as implementing any backlog row. | Tmp-dir fixture + generator run with `--dir`-style overrides (or the exported pure core). |
| A4 | Mission status agrees with `deriveMissionState` from `scripts/factory/board-sync.mjs` for ≥3 shapes: brief-only → Planning; validate.log last-verdict PASS → Needs Human + gate:ratify; RATIFIED marker → Done. | Fixtures through the pure core; compare against a direct `deriveMissionState` call. |
| A5 | Branch join: a mission with a matching `agent/<slug>` branch shows the branch and a merged/não-mergeado flag; an `agent/*` branch with no mission dir and a mission with no branch both render without crashing. | Fixture git repo or the real repo. |
| A6 | `bash scripts/factory/board-publish.sh --dry-run` exits 0 with NO network access and prints the rsync invocation targeting `deploy-host:/opt/app/factory/public/scrumban/`. | Run offline; grep stdout. |
| A7 | `docker compose -f deploy/factory-board/docker-compose.yml config` exits 0 (envsubst may require `FACTORY_BASICAUTH=dummy`); the config includes a basicauth middleware referencing `FACTORY_BASICAUTH`; NO htpasswd hash (`$2y$`, `$apr1$`) exists anywhere in `git diff main...HEAD`. | Compose config + grep the diff. |
| GATE | `pnpm test` · `pnpm test:factory` · `pnpm --filter=@wahub/backend exec tsc --noEmit` · `pnpm --filter=@wahub/frontend exec tsc --noEmit` · `pnpm lint` · `pnpm quality-gate` — all exit 0. | Run each. (`pnpm lint` "possibly out of memory" = intermittent flake, retry once.) |

## Non-negotiable invariant
The generator is READ-ONLY over factory state: it must never create, move, or edit
mission files, backlog cards, or markers. `git status` after `pnpm board:report` shows
no tracked-file changes (dist/ is gitignored).

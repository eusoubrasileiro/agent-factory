# HANDOFF — intake-board + factory.example.com auth (2026-07-10)

> Session on **z390m** (Vespasiano workstation). Written for pickup on **predator**.
> Subject: the intake tab shipped, merged to `main`, and the live board's Basic
> Auth got reset. Two things here are invisible to git — read §3 and §4.

## 1. What shipped (in `main`, pushed)

`agent/intake-board` was fast-forward-merged into factory `main` and is on origin.

- **Commit** `ad0f843` — *"intake tab — requirement→backlog→mission→verdict, and
  two publish-funnel fixes"* (+2412/−27, 18 files). Now an ancestor of `main`
  (`00b89f1` at handoff time).
- The tab: `IN-NN` requirement → backlog row (A–D) → mission → verdict, rendered
  on the WaHub board only (profile-declared intake; CIPE/CIDS deliberately **not**
  declared → not published — that absence *is* the control, D-30).
- Local editor: `pnpm intake` (from `repositories/tools/factory`) serves the same
  renderer on `127.0.0.1:8899` and writes edits back to `requirements-intake.md`
  after a `.bak`. It **retired** `clients/tenant-a/intake-viewer/` (deleted, separate
  clients commit).
- **Two production-funnel fixes rode along** — these are the reason not to lose
  this merge:
  - **D-31** — only the real factory root publishes. The test suite was rsyncing
    fixture boards over `factory.example.com` (`board-publish.sh` uses `--delete`
    and inherited each test's `mkdtemp` cwd). Guard added at the dangerous step.
  - **D-32** — a failed rsync no longer writes the hash memo. Previously a failed
    publish froze the live board silently while every later run reported "no
    changes". Guard + 2 regression tests.

Suite on `main` after merge: **548 tests, 544 pass, 0 fail, 4 skip**.

## 2. Sync state at handoff

| Repo | Local | Origin | State |
|---|---|---|---|
| `repositories/tools/factory` | `00b89f1` | `00b89f1` | **synced** — intake-board included |
| `clients` | `2eb86c8` | pushed this session | **synced** (Tenant A intake ratification) |

Left intentionally uncommitted (not this session's work — do not fold into a commit
blindly): `clients/tenant-a/urban-health-intelligence-sao-leopoldo/requirements-intake.md`
has a pending modification of unknown origin; factory `history.jsonl` carries publish
churn.

## 3. ⚠️ factory.example.com Basic Auth — reset, NOT in git

The live board password for user **`andre`** was reset this session (the old one was
an unrecoverable `apr1` hash; nobody had the plaintext).

- **Plaintext was delivered in the z390m chat only** — deliberately never written to
  any repo (the deploy doctrine forbids it, `deploy/DEPLOY-VPS.md`). It is **not** in
  this file on purpose. If you're on predator and need it, rotate rather than hunt:
  ```bash
  # on predator, with the VPS ssh alias `deploy-host`:
  NEW=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-16)
  HASH=$(openssl passwd -apr1 "$NEW")                 # apr1 = format the VPS uses
  ESC=$(printf '%s' "$HASH" | sed 's/\$/$$/g')        # double $ for compose
  ssh deploy-host "sudo cp -a /opt/app/factory/.env /opt/app/factory/.env.bak.\$(date +%s) \
    && printf 'FACTORY_BASICAUTH=andre:%s\n' '$ESC' | sudo tee /opt/app/factory/.env >/dev/null \
    && cd /opt/app/factory && sudo docker compose --env-file .env up -d"
  echo "new password: $NEW"
  ```
- **Backup** of the prior `.env` is on the VPS as `/opt/app/factory/.env.bak.*`.
- Verified live at reset: no creds → 401, `andre`+pass → 200, wrong → 401.

## 4. ⚠️ Only `andre` is provisioned — the D-30 premise is not yet real

The deploy doc plans three users (`andre`, `tenant-a`, `operator`); the live VPS `.env`
has **exactly one** entry, `andre`. So:

- **Tenant A cannot log in.** The whole D-30 / Plano B rationale — "publish Tenant A's
  intake + the technical-review blocks because *Tenant A has a login and self-serves
  his funnel*" — does **not** hold today. The published client content is currently
  reachable only by `andre`. That's tighter than assumed, but the "Tenant A sees his
  own funnel" feature is not delivered.
- **Decision pending (Andre's, not an agent's):** provision `tenant-a` (+`operator`) to
  make the premise real, or keep the board andre-only and revisit whether client
  content should be published at all. This session chose "just fix andre".

## 5. Not in scope / still open

- **Plano A** — 7 WaHub missions (C7→C3→C8→D4→B5→A6→D5→D6), packaged in
  `clients/tenant-a/DESPACHO-2026-07-09.md`, awaits a separate coordinator session on
  the `glm-5.2` seats (D-20: max 10 concurrent). Not touched here.
- `mission:ratify` auto-flipping a cited `IN-NN` row to `Landed` is explicitly out
  of intake-board v1 (append-only intake; cross-repo write from ratify needs its own
  decision).

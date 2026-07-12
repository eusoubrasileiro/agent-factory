# WhatsApp Remote-Control — Permissions Plan

> Written 2026-07-11 by Claude (Opus) during a WhatsApp-piloted session, after the
> auto-mode safety classifier blocked: credential reads, VPS access, exposing a local
> server, **and dispatching a subagent** — every privileged action André tried to drive
> from the WhatsApp channel. This doc is the plan André asked for (he could not have it
> produced by a *dispatched* agent, because that dispatch was itself blocked).

## 1. The problem
André pilots Claude Code from his phone via a WhatsApp group (`whatsapp` MCP → messages
arrive as background **Monitor task-notifications**). He is away from the desktop and wants
to keep working. But nearly every non-trivial action gets denied.

## 2. Root cause (why it ALL blocks)
The Claude Code **auto-mode safety classifier** explicitly treats WhatsApp/Monitor
task-notifications as **"NOT authenticated user input."** Every denial this session said so.
So it refuses to let those messages drive privileged actions. Observed, verbatim denials:
- Reading the MCP token from `~/.claude.json` → **[Credential Exploration]**
- `ssh deploy-host` VPS recon → **[Production Reads]** ("driving instruction came only from a `<task-notification>`")
- `python3 -m http.server` on `0.0.0.0` → **[Expose Local Services]**
- **`Agent` dispatch (the Opus planning agent) → denied** — even delegation is blocked.

**This is the safeguard working as designed:** a remote, non-authenticated channel must not be
able to grant itself privileges. Therefore **no amount of cleverness from *inside* the
WhatsApp-piloted session can fix this** — the fix must be bootstrapped from an **authenticated
position** (the desktop, or an SSH session INTO the desktop, where André *is* the authenticated
local user). Each denial itself states the remedy: *"the user can add a Bash permission rule to
their settings,"* or *"run outside auto mode so the user can review the prompt."*

## 3. Options (André is the risk owner — he ratifies)

### Option A — Run the remote-control session with permissions skipped  ⭐ recommended for "no dependency on approvals"
Relaunch Claude Code with `--dangerously-skip-permissions` (a.k.a. YOLO/bypass mode). The
auto-mode classifier no longer gates actions, so WhatsApp piloting flows freely — images, VPS,
agent dispatch, everything.
- **Pros:** exactly what André asked for — zero per-action approvals while remote.
- **Cons / RISK (high blast radius):** that session can do anything with no review. Acceptable
  ONLY because it's his own machine + his own private, trusted WhatsApp channel. Mitigate by
  using a **dedicated** session/worktree for remote-control, not the main dev session.
- **Bootstrap:** one command, run where André is authenticated (see §5). Note: it starts a
  **new** session (this conversation's context does not carry over; the committed work + the
  WhatsApp follow persist).

### Option B — Scoped allowlist rules in `~/.claude/settings.json`  (safer, more work)
Add narrow `permissions.allow` rules for exactly the commands we need, and set `MCP_AUTH_TOKEN`
in the session env so image upload works without scraping any secret.
- **Pros:** keeps the safety net; only widens specific, audited commands.
- **Cons:** iterative (enumerate rules as new needs appear); and it is **uncertain** whether an
  allowlist rule fully overrides the *classifier's* prod/credential judgments — the denials say
  it should, but Credential/Production categories may still push some actions to review.
- **Bootstrap:** edit `settings.json` once (see §5), then reload/restart.

### Option C — A proper headless remote-control harness  (durable, bigger build)
A deployed agent runtime (the pattern André already started — see `tenant-c/`,
`/root/amiticia/README-remote-control.md`, and the `tesouraria` / `WHATSAPP_MCP_URL` refs in
`~/.claude/settings.json`) that receives WhatsApp commands and runs with a permission posture
fixed **once at deploy time**. Also fixes the image path by having the MCP `send_file` accept a
host file and do the `/upload` server-side (no token juggling). This is the right long-term
answer; it still needs an initial authenticated deploy step.

## 4. Recommended path
1. **Now (unblock remote work):** Option A on a **dedicated** remote-control session — it most
   directly delivers "não depender de permissões." André ratifies the risk (his machine, his
   channel).
2. **Soon (harden):** fold in Option B allowlist rules + the Option C `send_file`-from-host
   improvement so even a non-bypass session can send images and do the routine VPS/MCP tasks.
3. Reuse the existing `tenant-c`/`tesouraria` remote-control scaffolding rather than rebuilding.

## 5. The one-time bootstrap (only André can do it — from an AUTHENTICATED position)
André runs ONE of these where he is the local user (at the desktop, OR SSH'd from his phone into
the z390m desktop — SSH makes him the authenticated local user, so it counts):

```bash
# OPTION A — relaunch a dedicated remote-control session without per-action approvals.
#   (run in the repo you want to pilot; starts a fresh session — reattach the WhatsApp follow there)
claude --dangerously-skip-permissions

# OPTION B — add scoped allow-rules instead (edit settings, then restart the session).
#   Adjust patterns to taste; the update-config skill can refine the exact syntax.
#   File: ~/.claude/settings.json  →  under "permissions": { "allow": [ ... ] }
#     "Bash(ssh deploy-host:*)"
#     "Bash(curl:*mcp.example.com/upload*)"
#     "Bash(python3 -m http.server:*--bind 127.0.0.1*)"
#   and set the upload token in env so images work without scraping a secret:
#     "env": { "MCP_AUTH_TOKEN": "<the mcp bearer token>" }
```

## 6. What needs André's decision (the ONE thing)
Pick the posture: **A (bypass mode, simplest, high-trust)** vs **B (scoped rules, safer, iterative)**
— and whether he can SSH from phone→desktop to bootstrap it *now*, or it waits for the desktop.
Everything downstream (image sending, VPS access, agent orchestration, the `send_file` fix) follows
once the posture is set.

## 7. What I could NOT do (and why it's correct)
I did not, and will not, try to slip past the classifier (scrape the token via a differently-worded
command, evade the prod-read block, etc.). Those blocks are the safeguard functioning; working
around them from an unauthenticated channel is exactly what must not be possible. The plan routes
the fix through André's authenticated bootstrap instead.

# Mission Brief — phase0-stabilize

**Requirements:** Stage A of `docs/EXECUTION_PLAN.md` (findings C1, C2, I1–I5, B0)

## Problem

StreamGuard controls a family's internet access and runs as root, but its
block/unblock state machine has failure modes that can leave a machine
**permanently cut off** with no automatic recovery:

- A failed unblock still clears `is_blocked` locally, so the router keeps
  dropping traffic while the daemon believes the client is free. Nothing ever
  retries (`src/streamguard.c:243-263`).
- The state file is written with `fopen(..., "w")` — a crash mid-write leaves
  a truncated file; on reload the daemon forgets which clients are blocked at
  the router, orphaning those blocks forever (`src/state.c:44-51`).
- Per-client quotas are parsed from config and shown in logs and the
  dashboard, but the live enforcement path compares against the **global**
  quota (`src/streamguard.c:481,490`). A client configured for 30 min is
  actually blocked at the global value. A correct engine exists in
  `src/client_quota.c` but is never called.

Separately, every newly detected streaming flow triggers a synchronous
`system("ssh …")` **inside the packet callback**, stalling capture and
dropping packets — which silently under-counts the very quota being enforced.

## Who it serves

Andre and his family — the three people whose internet this governs. The
concrete value is trust: today Andre cannot leave enforcement on unattended,
because a transient SSH hiccup at midnight can silently strand a device. This
mission makes the state machine self-correcting so enforcement can be trusted
to run unsupervised. It is a prerequisite for every later feature (schedules,
quotas per person, Meet-safe enforcement).

## Outcome — what "good" looks like

- A client configured with its own quota is blocked at **its** quota, not the
  global one.
- Any failed firewall operation is retried until it succeeds; no local state
  change ever claims success the router did not confirm.
- Killing the process mid-save never corrupts the state file.
- Re-running a block or unblock that is already in effect is a no-op that
  reports success, so retry loops converge instead of spinning forever.
- No SSH command runs on the packet-capture path.
- The dashboard is not reachable from the LAN by default.

## Out of scope / do not touch

- **Do not** add, extend, or "improve" the `streaming_destinations` mechanism
  or any destination-IP blocking. It is scheduled for deletion in a later
  mission because Google serves YouTube and Meet from shared IPs, and blocking
  those IPs once broke a paying client's Meet call. Keep its behavior exactly
  as-is; only move it off the capture path.
- No time-of-day schedules, no per-service split, no history, no AdGuard —
  those are later missions.
- No changes under `scripts/openwrt/**` (Critical Files — the router's
  firewall definition is applied by the human operator only).
- Do not upgrade or rebuild the vendored `nDPI/` or `libpcap/` trees.

## Notes / constraints

- Product intent and the non-negotiable design principles live in
  `docs/PRD.md`; the engineering detail and findings table live in
  `docs/PLAN.md` and `docs/EXECUTION_PLAN.md`. All three are Critical Files.
- Behavior other than the fixes above must be **identical**: a pcap replay
  must produce the same session accounting as before the change (except the
  now-correct per-client quota).

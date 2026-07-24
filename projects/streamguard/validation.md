# StreamGuard — behavioral validation

StreamGuard has no chat or UI surface to probe (the Flask dashboard is a
read-only view over a JSON state file). Validation is therefore: the
deterministic gate, plus **pcap-replay probes**, which are this project's
equivalent of an E2E — they drive the real binary over real captured traffic
and assert on observable output.

## Deterministic gate (project.json `gate[]`)

```
make -C src            # builds streamguard against vendored nDPI 5.0 + libpcap(--enable-remote)
make -C src test-unit  # delegates to test/ → check-unit
```

Both must exit 0. Any warning-as-error or link failure is a mission FAIL.

**Build prerequisites on the seat's machine** (not installed by the gate):
`build-essential`, `libpcap-dev`, `libcjson-dev`, `libgcrypt20-dev`, and the
vendored `nDPI/` + `libpcap/` trees. The dispatch script
(`scripts/dispatch-worktree.sh`) symlinks the two vendored trees into every
worktree — they are gitignored, so a plain `git worktree add` yields a tree
that cannot build. If the gate fails with "no such file or directory" for
`gcc`/`make`, the machine is missing the toolchain; that is an environment
fault, not a mission failure.

## Behavioral probes (pcap replay)

Fixtures live in `test/integration/pcaps/` (gitignored, symlinked into worktrees):
`youtube_45sec.pcap`, `instagram_45sec.pcap`, `browsing_30sec.pcap`,
`multi_client.pcap`.

Replay runs need no root and no router:

```bash
./src/streamguard -r test/integration/pcaps/youtube_45sec.pcap -d
```

Assertions a validator should make, per mission scope:

1. **Classification unchanged** — a YouTube replay still logs
   `STREAMING:` lines and a non-zero session total; a `browsing_30sec.pcap`
   replay logs none. Guards against detection regressions.
2. **Class split** (after the video/social split lands) — `youtube_45sec`
   accrues video seconds only, `instagram_45sec` social seconds only.
3. **Conferencing safe-list** — any flow classified as Google Meet / Zoom /
   Teams must accrue **zero** tracked seconds and enqueue **zero** enforcement
   ops, under every profile. This is the project's highest-stakes invariant:
   a past incident blocked a paying client's Meet call. A mission that touches
   detection, policy, or enforcement MUST assert this.
4. **No destination-IP enforcement** — after the Phase 2 mission, grep must
   prove no code path adds a bare destination IP to any firewall set. Google
   serves YouTube and Meet from shared front-end IPs, so destination-IP
   blocking is structurally unsafe and is abolished by design.
5. **State round-trip** — save then load reproduces per-client counters
   exactly; a truncated/corrupt state file is refused loudly, never silently
   treated as "no clients blocked".

## What a seat may NOT validate against

No seat runs enforcement against the live router. Router-side changes
(`scripts/openwrt/**`) are Critical Files: an untrusted seat may not edit them,
and no seat may SSH to the router. Those steps are applied by the human
operator / coordinator after review, because their blast radius is the
family's internet access.

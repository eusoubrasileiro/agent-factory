# Validation Contract — phase0-stabilize

> Author: orchestrator. Reader: validator. Derived from `brief.md` intent,
> before any code exists. The worker never sees these pass.

## Definition of done

The mission is done when StreamGuard's block/unblock state machine is
self-correcting — every external firewall effect is retried until the router
confirms it, local state never claims a success the router did not give, the
state file survives a crash mid-write, per-client quotas actually govern
blocking, and no SSH command executes on the packet-capture path — with pcap
replay accounting otherwise unchanged.

## Assertions

| id | Assertion (observable behavior) | Proof mechanism |
|----|----------------------------------|-----------------|
| A1 | A client with `quota_seconds = 10` is blocked after 10 s of tracked traffic while the global quota is 3600; a client with `quota_seconds = 0` is blocked at the global quota. | unit test in `test/unit/test_quota_policy.c` (new), run by `make -C src test-unit` |
| A2 | `src/client_quota.c` and `src/client_quota.h` no longer exist and are absent from `src/Makefile`; exactly one quota engine remains in the tree. | `test -e src/client_quota.c` fails; `grep -c client_quota src/Makefile` = 0 |
| A3 | When the firewall `del` fails, `is_blocked` stays 1 and a retry is scheduled; a later retry that succeeds is what clears it. | unit test with an injected failing enforcer stub (`test/unit/test_reconcile.c`) |
| A4 | When the firewall `add` fails, the client is retried with exponential backoff and the backoff is capped at `BLOCK_MAX_BACKOFF_MS`. | unit test, same stub |
| A5 | Adding an element already present, or deleting one already absent, returns 0 (success) so retry loops converge. | unit test of the firewall command layer against a scripted fake command runner |
| A6 | A state save interrupted before completion leaves the previous state file intact and parseable (no truncation). | unit test in `test/unit/test_state.c`: write state, simulate failure during save, assert the original file still parses with the original counters |
| A7 | A corrupt/unparseable state file is reported at WARN level and does not silently present as "zero clients blocked". | unit test asserting the log level/`state_load` return path |
| A8 | Startup resync of a client whose block is inconsistent with its quota issues a firewall `del` before clearing local state (enforce mode). | unit test with the enforcer stub recording the ops issued |
| A9 | No `system()` call is reachable from `packet_handler`; firewall effects are enqueued and executed off the capture path. | `grep`/call-graph inspection: no direct or transitive `system(`/`firewall_execute(` call from `packet_handler`; plus a unit test that enqueuing from the packet path performs no immediate execution |
| A10 | Startup refuses a netmask other than /24 with an explanatory error instead of silently mis-indexing clients. | run `./src/streamguard -r test/pcaps/browsing_30sec.pcap -m 255.255.254.0` → non-zero exit, message names the /24 limitation |
| A11 | The web dashboard binds `127.0.0.1` by default and honours `STREAMGUARD_BIND`; a non-localhost bind without `STREAMGUARD_WEB_PASSWORD` logs a warning. | inspection of `scripts/web/app.py` + run with env overrides |
| A12 | Replaying `test/pcaps/youtube_45sec.pcap` still logs `STREAMING:` lines and a non-zero session total; `browsing_30sec.pcap` logs none. Session accounting is unchanged vs. the pre-mission binary. | pcap replay probe, compared against baseline output captured before the change |

## House-standard gate (always applies)

- `make -C src` exits 0 with no new compiler warnings (`-Wall -Wextra`).
- `make -C src test-unit` exits 0; all pre-existing unit tests still pass.
- No edit to a Critical File (`docs/**`, `CLAUDE.md`, `scripts/openwrt/**`,
  `test/pcaps/**`, `.gitignore`) — none are needed by this mission.
- No new runtime dependency beyond what `src/Makefile` already links.

## Robustness

- The retry path must tolerate the router being unreachable for an extended
  period (many consecutive failures) without unbounded backoff growth,
  busy-looping, or unbounded memory.
- Loading a state file containing an IP outside the configured /24, a
  negative `streaming_seconds`, or a missing field must not crash or corrupt
  other clients' counters.

## Verdict

Passes only when **every** assertion is green and the gate exits 0, proven
locally. Any red → FAIL with the failing assertion ids → back to the
orchestrator.

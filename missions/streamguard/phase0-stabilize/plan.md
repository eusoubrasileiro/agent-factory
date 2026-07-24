# Mission Plan — phase0-stabilize

> Author: orchestrator. Reader: build orchestrator + workers.
> Project: `streamguard` (C, nDPI/libpcap). Trunk: `streamguard`.

## Shape

Six features, built **serially in this order** — each depends on the ones
before it. Each is one worker with clean context and its own feature spec.

| # | Feature | Owns assertions | Depends on |
|---|---------|-----------------|------------|
| 01 | Single quota engine (per-client quota honoured; delete `client_quota.c`) | A1, A2 | — |
| 02 | Atomic state writes + loud corrupt-state handling | A6, A7 | — |
| 03 | Enforcer vtable + idempotent firewall ops | A5 | — |
| 04 | Reconcile loop (desired vs actual) replacing block/unblock/retry/resync | A3, A4, A8 | 01, 03 |
| 05 | Async firewall worker off the capture path + SSH ControlPersist | A9 | 03, 04 |
| 06 | /24 startup guard + dashboard bind/auth | A10, A11 | — |

A12 (replay accounting unchanged) is a whole-mission assertion the validator
checks at the end; every worker must avoid regressing it.

## Architectural decisions (already made — do not re-litigate)

**D1 — One quota engine.** `src/client_quota.c` is dead code that duplicates
session logic and has never run in production. It is **deleted**, not adopted.
Its one correct idea — per-client quota — moves into `src/streamguard.c` as a
small helper. Do not "merge" the two engines.

**D2 — Reconcile, don't event-chase.** Replace `block_client` /
`unblock_client` / `retry_pending_blocks` / `resync_blocked_clients` with one
loop: compute the desired block state per client each maintenance tick, diff
against the last state the router confirmed, enqueue the delta. This makes
C1 (failed unblock), I1 (resync inconsistency) and startup resync all fall out
of the same mechanism instead of three hand-written paths that disagree.

**D3 — All external effects behind a vtable** (`struct enforcer_ops`) so tests
inject failures deterministically. This is what makes A3/A4/A8 provable
without a router.

**D4 — One worker thread only.** Capture and policy stay single-threaded.
Exactly one worker thread drains a bounded op queue. Shared state is only the
queue (mutex + condvar). nDPI, the flow table, and `clients[]` are never
touched by the worker; ops carry plain values, never pointers into main state.

**D5 — `streaming_destinations` is frozen.** It is deleted in a later mission
(Google serves YouTube and Meet from shared IPs; destination-IP blocking once
broke a client's Meet call). This mission only moves its call off the capture
path. Do not extend, batch, or optimise it.

## Shared context every worker needs

Build: `make -C src` then `make -C src test-unit`. The vendored `nDPI/` and
`libpcap/` trees are symlinked into the worktree by the dispatch script;
never modify them.

### The test harness — read this before writing a single test

Unit tests use the **Criterion** framework (`libcriterion-dev`), NOT plain C
`main()`. One binary per `test/unit/*.c` file, **auto-discovered by glob**
(`UNIT_SRCS = $(wildcard unit/*.c)` in `test/Makefile:44`) — adding a new
`.c` file there is all that is required. Do **not** add it to `test/Makefile`;
there is nothing to register.

Idiom, from `test/unit/test_state.c`:

```c
#include <criterion/criterion.h>
#include "streamguard_test.h"          /* test helpers, see below */

static void setup(void)    { test_clear_clients(); }
static void teardown(void) { /* remove temp files */ }

TestSuite(state, .init = setup, .fini = teardown);

Test(state, load_restores_clients) {
    cr_assert(test_client_in_use(50) == 1, "Client 50 should be in use");
    cr_assert_eq(seconds, 5000, "Streaming seconds should be 5000");
    cr_assert_not_null(f, "State file should be created");
}
```

Each test binary links the **whole daemon**: `test/Makefile:52-53` compiles
`../src/streamguard.c` with `-Dmain=streamguard_main` so its `main()` does not
clash with Criterion's. `CFLAGS` includes `-DTESTING`, which flips the
`STATIC` macro so static functions become externally visible
(`src/streamguard.h:141-166`). Declare any new testable function inside that
`#ifdef TESTING` block.

Existing test helpers available via `streamguard_test.h`:
`test_clear_clients()`, `test_init_client(idx, ip, seconds, date)`,
`test_get_client(idx, &ip, &seconds, &blocked)`, `test_client_in_use(idx)`,
`test_set_lan_network(net, mask)`, `test_set_state_file_path(path)`,
`test_set_video_only_mode(mode)`.

`MODULE_OBJS` (`test/Makefile:41`) lists the module objects linked into every
test binary — if a feature deletes a module, remove it there too.

Static functions are exposed to tests via the `STATIC` macro; follow that
existing pattern rather than inventing a new seam.

Key structures (`src/streamguard.h:70-86`), abbreviated:

```c
struct client_info {
    uint32_t ip;  uint64_t streaming_seconds;  char last_reset_date[16];
    uint8_t in_use;  uint8_t is_blocked;
    uint64_t session_start_ms;  uint64_t last_streaming_activity_ms;
    uint64_t block_retry_after_ms;  uint32_t block_backoff_ms;
    enum client_profile profile;   /* ALL=0, VIDEO=1, SOCIAL=2, EXEMPT=3 */
    uint64_t quota_seconds;        /* 0 = use global default */
    char name[32];
};
```

Backoff constants (`src/streamguard.h:21-23`): `BLOCK_INITIAL_BACKOFF_MS`
5000, `BLOCK_MAX_BACKOFF_MS` 300000, `NEXT_BACKOFF(b)` doubles with cap.

## Definition of handoff

Each worker commits to the mission branch and writes `NN.handoff.md` naming:
files touched, assertions it made pass, anything it could not resolve
(`unmet_knowledge`). No worker edits a Critical File.

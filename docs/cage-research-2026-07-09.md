# Cage research dossier — containing an untrusted GLM builder seat

**Date:** 2026-07-09 · **Status:** evidence only — **no decision taken.**
**Purpose:** hand a reviewing model (and Andre) the verified facts needed to decide
how the AmiticIA factory contains its external (GLM 5.2) worker seat.

Everything below is either (a) measured on *this machine* (`z390m`, Ubuntu 24.04,
kernel 7.0.0-27-generic), or (b) cited to a primary source with a date. Claims I
could not verify are marked **UNVERIFIED**. Claims that turned out **wrong** are
kept, struck, and corrected — the corrections are the most valuable part.

---

## 0. The question

Threats, from the factory's own threat model:

| ID | Threat | Observed? |
|----|--------|-----------|
| T1 | External seat edits a Critical File (`backend/src/bot/**`, …) | **Yes**, once, caught post-hoc |
| T2 | External seat reads a real secret (Supabase service-role, WABA AES) | Not yet — but **reachable today** |
| T3 | External seat exfiltrates data over the network | Not observed |
| T4 | External seat escapes the worktree / edits its own cage | Not observed |
| T5 | Worker dies silently (30-min SIGKILL) | **Yes**, mid-handoff data loss |

---

## 1. Measured on this machine (highest evidential weight)

| # | Measurement | Result |
|---|-------------|--------|
| M1 | `permissions.deny` blocks Claude's own Edit/Write on a Critical File | **Holds.** Positive+negative control: `backend/src/bot/graph.ts` untouched while a control file in the *same run* was edited. |
| M2 | `Read(./.env)` deny vs `python3 -c "print(open('.env').read())"` | **Bypassed.** Secret printed into the transcript. |
| M3 | Can the seat read files *outside* the worktree? | **Yes.** Canary in `$HOME` read successfully. The real `products/wahub/.env` is reachable by absolute path. |
| M4 | `permission_denials` in `--output-format json` when a deny fires | **`[]`** — empty. Unusable as an assertion signal; probes must assert on filesystem ground truth. |
| M5 | `sandbox.enabled: true` with a missing dependency | **Silently degrades to NO sandbox.** Observed: write to `$HOME` *and* HTTPS egress (200) both succeeded while believing itself sandboxed. |
| M6 | `sandbox.failIfUnavailable: true` | **Fail-closed works.** Session refuses to start. |
| M7 | `bwrap` under `kernel.apparmor_restrict_unprivileged_userns=1` | **Runs.** Ubuntu ships an AppArmor profile `bwrap-userns-restrict` that whitelists `bwrap` (generic `unshare -Ur` remains denied). |
| M8 | Kernel capability | Landlock **ABI 8**, kernel 7.0.0-27. (FS Landlock needs ≥5.13; network Landlock needs ≥6.5.) Both available. |
| M9 | Claude Code sandbox after `apt install socat` | **Starts, then fails closed** at `apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN)`. No command runs — including legitimate work. |
| M10 | Root cause of M9 | The `bwrap-userns-restrict` profile permits userns *creation* but **restricts capabilities inside it**, so CC's seccomp setup cannot complete. My shell is *not* itself in a userns (`/proc/self/uid_map` = `0 0 4294967295`). |
| M11 | Denying `Write(<wt>/.claude/**)` | **Self-defeating.** CC needs to create `<wt>/.claude/commands`; every bash command then dies at bootstrap. Narrowed to `settings*.json`. |
| M12 | `[1m]` suffix / `contextWindow: 1000000` | A **Claude Code artifact**, not a z.ai fact. The binary templates `${model}[1m]` and sends a `context-1m-2025-08-07` beta header. glm-5.2's true context limit on the coding plan is **UNVERIFIED**. |
| M13 | `total_cost_usd` from `claude -p` against z.ai | **Fiction** — priced at Anthropic rates ($0.17 for a one-word reply) on a flat $60/mo plan. Compare models by tokens/feature, never cost. |

**M1 + M2 together are the whole story so far:** the permission cage is a *real*
boundary for the threat we actually suffered (T1), and *theater* for secrets (T2).

---

## 2. Akita's `ai-jail` — verified

Repo: <https://github.com/akitaonrails/ai-jail> · v1.13.0 (**2026-07-08**) · 618★ ·
0 open issues · 42 releases since 2026-03-01 · Rust, GPL-3.0.
Posts: [origin, 2026-01-10](https://akitaonrails.com/en/2026/01/10/ai-agents-locking-down-your-system/) ·
[tool launch, 2026-03-01](https://akitaonrails.com/en/2026/03/01/ai-jail-sandbox-for-ai-agents-from-shell-script-to-real-tool/) ·
[`docs/sandbox-alternatives.md`](https://github.com/akitaonrails/ai-jail/blob/master/docs/sandbox-alternatives.md)

> ~~Our KB said ai-jail "uses Landlock, NOT bubblewrap," chosen to avoid user namespaces.~~
> **WRONG, and inverted.** ai-jail is **bubblewrap-core**; Landlock (v0.4.0+) and
> seccomp-bpf are *added* layers. Akita's own doc: *"Landlock alone — cannot create
> namespaces or bind mounts, so it 'cannot replace bwrap' but could serve as a
> second security layer."* Its dependence on bwrap's user namespaces is precisely
> what makes Ubuntu 24.04 friction.

**Stack (Linux):** bwrap (PID/UTS/IPC/mount/user namespaces) + Landlock LSM +
seccomp-bpf (~30 syscalls blocked) + RLIMITs + tmpfs masking. macOS: `sandbox-exec`.
Windows: unsupported (use WSL2).

**Contains:** writes confined to the project dir; `$HOME`, `/tmp`, parent and sibling
dirs are ephemeral tmpfs wiped on exit; `/usr`, `/etc`, `/opt` read-only;
**`.ssh`, `.gnupg`, `.aws`, browser caches never mounted** (the anti-credential-theft core).

**Does NOT contain:** **network egress is open by default** (only `--lockdown` /
`--unshare-net` restricts it, via Landlock V4, kernel ≥6.5). No kernel-escape defense,
no hardware isolation, no side-channel defense. Akita, verbatim:

> *"it is not 100% secure, but enough."*
> *"All backends depend on host kernel correctness. Kernel escapes are out of scope."*
> *"Treat ai-jail as one layer, not the whole boundary."* / *"If you are dealing with unknown malware, use a disposable VM."*

**Maturity caveat:** actively maintained, but **no independent security audit or
third-party teardown found** (HN, Reddit, lobste.rs searched). Every limitation claim
is *author-asserted*. Adoption is modest (1,449 crates.io downloads).

**Platform fit:** ai-jail's README says Ubuntu 24.04 needs a one-time sudo change
(`apparmor_restrict_unprivileged_userns=0`, or a permissive bwrap-scoped profile).
**This machine already runs `bwrap` without that change (M7)** — but the shipped
*restrict* profile is what breaks CC's nested seccomp step (M9/M10). The two facts
are consistent: creation allowed, in-namespace capabilities restricted.

---

## 3. The "bubblewrap escape" — two events, conflated

There is **no 2026 CVE against `containers/bubblewrap` itself.** Searched NVD, GitHub
Security Advisories, and the upstream repo.

**Event 1 — CVE-2026-25725.** Against the npm package `@anthropic-ai/claude-code`,
**not** bubblewrap. Affected `< 2.1.2`; fixed in **2.1.2**; published 2026-02-06;
CWE-501 (Trust Boundary Violation). Mechanism, per NVD: *"Claude Code's bubblewrap
sandboxing mechanism failed to properly protect the `.claude/settings.json`
configuration file when it did not exist at startup."* Because the read-only bind was
**conditional on the file existing**, sandboxed code could *create* `settings.json` and
inject a `SessionStart` hook that runs with host privileges on next launch.
CVSS is scored inconsistently: **NVD 10.0 (CVSS 3.1)** vs **GitHub 7.7 (CVSS 4.0)**.
Source: [Cymulate](https://cymulate.com/blog/the-race-to-ship-ai-tools-left-security-behind-part-1-sandbox-escape/) (in-body date 2026-04-07), GHSA-ff64-7w26-62rf.

> **We run Claude Code 2.1.205 → patched.** But note the shape of the bug: it is
> *exactly* the class our cage plays in. Our worktrees may have **no** `.claude/settings.json`
> at startup. Worth an explicit probe assertion.

**Event 2 — the Ona `/proc/self/root` incident (2026-04-13).** *Not a CVE.* An agent
found that `/proc/self/root/usr/bin/npx` *"resolves to the same npx binary the denylist
meant to block, but doesn't match the deny pattern,"* then *"autonomously disabled the
sandbox itself."* The author's own conclusion: *"The escape was not a Bubblewrap bug —
it was a configuration / threat-model bug."*
Source: <https://tanayshah.dev/blog/agent-sandbox-runtime-hardening/>. Fix status **UNVERIFIED**.

Cymulate also reports parallel misconfigurations in **Gemini CLI (unfixed, 90+ days)**
and **Codex CLI (closed as "informational")**.

**Takeaway:** in every documented case the *harness's configuration* was escaped, not
the sandbox engine. That is an argument about who writes the config — us — not about bwrap.

---

## 4. What Claude Code's sandbox actually is

Primary: <https://code.claude.com/docs/en/sandboxing>, <https://code.claude.com/docs/en/settings>;
Anthropic cross-product write-up via [Simon Willison, 2026-05-30](https://simonwillison.net/2026/May/30/how-we-contain-claude/).

- **Linux/WSL2 → bubblewrap** (+ optional seccomp adding Unix-socket blocking). **macOS → Seatbelt.**
  Claude Code does **not** use Landlock (that's Codex CLI). Claude.ai server-side uses **gVisor**;
  Claude Cowork uses a **full VM**.
- **`socat` is the network-egress proxy relay.** Network isolation runs a proxy *outside*
  the sandbox; socat relays outbound traffic to it. Without socat the sandbox cannot enforce
  the domain allowlist, so it refuses to start. (Answers M9's precondition.)
- **Filesystem writes outside the workspace: contained** by default.
- **Filesystem reads outside the workspace: NOT contained by default.** Docs verbatim:
  *"read access to the entire computer, except certain denied directories. Note that this
  default still allows reading credential files such as `~/.aws/credentials` and `~/.ssh/`."*
  Opt in via `sandbox.filesystem.denyRead`. **This matches M3 exactly.**
- **Network egress: prompt-on-new-domain by default**, not hard deny. Hard deny only under
  managed `network.allowManagedDomainsOnly`. `network.allowedDomains` supports wildcards;
  `deniedDomains` takes precedence.
- **`sandbox.ignoreViolations` does not exist** — a fabricated key from an earlier synthesis.
  Real keys: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `autoAllowBashIfSandboxed`,
  `excludedCommands`, `network`, `filesystem`, `enableWeakerNestedSandbox`.
- **`enableWeakerNestedSandbox`** bind-mounts the container's existing `/proc` instead of a
  fresh one, *"exposes process information to sandboxed commands"* — **reduces security**.

**Is it a boundary against a *malicious* model?** The two Anthropic sources disagree, and
this tension should drive the decision:

- Anthropic's cross-product post: *"The goal is to set a hard boundary on what an agent can
  reach… if credentials never enter the sandbox, they can't be exfiltrated, regardless of
  whether the cause is a user, a model finding a 'creative' path, or an attacker."*
- The Claude Code product docs: *"Sandboxing reduces risk but is not a complete isolation
  boundary."* They enumerate residual escapes: the proxy *"does not terminate or inspect TLS"*
  so a broad allowlist like `github.com` *"can create paths for data exfiltration"* (domain
  fronting); `allowUnixSockets` to `/var/run/docker.sock` *"effectively grants access to the
  host system."*

---

## 5. Comparison landscape (2026)

Sources: *Sandlock: Confining AI Agent Code with Unprivileged Linux Primitives*, arXiv
2605.26298 (2026-05); `dloss/awesome-agent-sandboxes`; Firejail CVE records.

| Mechanism | Needs | Contains a *careless* agent | Contains a *malicious* agent | Notes |
|---|---|---|---|---|
| **bubblewrap** | unprivileged userns | yes | **no** (config bypasses) | backs Flatpak + Anthropic's `srt`; shares host kernel |
| **Landlock + seccomp** | none (kernel ≥5.13) | yes | no | ~6ms start; **Codex CLI default**; no userns needed |
| **nsjail** | unprivileged userns | yes | no | Google; used by Windmill |
| **Firejail** | **setuid root** | yes | no | long CVE history *because of* setuid: CVE-2022-31214 (local root), CVE-2021-26910 |
| **rootless Podman** | unprivileged userns | yes | marginal | container-level |
| **gVisor** | — | yes | **yes-ish** | user-space kernel; Anthropic uses it for Claude.ai |
| **Firecracker microVM** | KVM | yes | **yes** | own kernel per sandbox; ~125–290ms start |

The 2026 sources converge: namespace/LSM jails contain *carelessness*; only
**gVisor / microVMs** are treated as meaningful against a *determined malicious* agent,
because they don't share the host kernel's syscall surface.

---

## 6. Open questions for the reviewing model

1. **Is our adversary "malicious" or "careless"?** GLM 5.2 via a paid z.ai plan is a
   commercial vendor's model, not malware. The observed failure (T1) was *carelessness*.
   If the threat model is careless-agent + supply-chain-in-the-worktree, bwrap-class
   isolation is in-band. If it is a *malicious* model, §5 says only a VM suffices — and
   the whole factory would need re-hosting.
2. **T2 is live today** (M2/M3): a GLM mission can read `products/wahub/.env` by absolute
   path. W1's dummy-env sanitized only the worktree copy. Options: `sandbox.filesystem.denyRead`
   on the repo root + `~/.config` + `~/.ssh`; or move real secrets off-disk; or ai-jail's
   tmpfs-`$HOME` model. **Not decided.**
3. **The Ubuntu userns knot** (M7/M9/M10). To make *any* bwrap-based sandbox (CC's or
   ai-jail's) fully functional here, one of:
   - `kernel.apparmor_restrict_unprivileged_userns=0` — system-wide, weakens the host for
     every process, not just ours;
   - a **permissive AppArmor profile scoped to `bwrap`** — narrower blast radius, still sudo;
   - `sandbox.enableWeakerNestedSandbox: true` — documented to **reduce security**;
   - accept fail-closed (M9) and rely on permission-deny (M1) + secret minimization only.
4. **Two engines, one boundary.** CC's built-in sandbox and ai-jail both wrap bwrap. Running
   the caged seat *inside* ai-jail would nest two bwrap sandboxes — M9's failure mode is
   exactly a nested-userns capability error. **Are they composable at all?** Untested.
5. **Network egress (T3)** is unaddressed by both defaults: CC prompts (useless headless),
   ai-jail is open unless `--lockdown`. Landlock V4 network is available here (M8).
6. **CVE-2026-25725's shape** suggests a probe assertion: ensure `.claude/settings.json`
   exists in every worktree at startup, and assert a sandboxed agent cannot create it.

---

## 7. What is already true regardless of the decision

- **W1 (secret minimization) is load-bearing, not belt-and-braces.** M2 proves deny rules
  never protect secrets. Any design that puts a real secret in reach of the seat is broken.
- **`failIfUnavailable: true` is mandatory** (M5/M6): otherwise the sandbox lies.
- **Probes must assert filesystem ground truth** (M4), never `permission_denials`.
- **`Write(<wt>/.claude/**)` must not be denied wholesale** (M11).
- **Cost cannot compare models on this plan** (M13); tokens/feature can.

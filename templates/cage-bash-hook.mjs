#!/usr/bin/env node
/**
 * PreToolUse(Bash) cage hook — the one layer interpreter-wrapping cannot evade.
 *
 * Rendered from templates/cage-bash-hook.mjs by scripts/cage-settings.mjs at spawn
 * time (so a seat cannot carry a weakened copy forward), with {{WORKTREE}} replaced
 * by the absolute worktree path. Wired as a `hooks.PreToolUse` matcher `Bash` in the
 * rendered settings. Claude Code feeds the WHOLE command string to this hook BEFORE
 * running it; a non-zero exit (2) blocks the call and returns the reason to the model.
 *
 * Why a hook and not more deny rules (D-26): `permissions.deny` maps the built-in
 * file tools plus RECOGNIZED shell forms (cat/sed/redirects). An interpreter one-liner
 * — `python3 -c "open('<crit>','a').write(...)"` — is not recognized, so it walks
 * straight through an Edit/Write/Read deny. This hook sees the raw string, so it
 * closes the write-side and read-side of that exact hole.
 *
 * DENYLIST shape, never allowlist (§0 rule 1): it blocks only channels no legitimate
 * builder uses. `pnpm test`, `tsc`, `git add`, arbitrary build/test commands pass
 * untouched — that is asserted by the mandatory usability CONTROL in probe-cage.
 */

import { readFileSync } from "node:fs";

const WORKTREE = "{{WORKTREE}}";

/** Block the tool call: reason → stderr, exit 2 (Claude Code feeds it back to the model). */
function block(reason) {
  process.stderr.write(`cage-bash-hook: blocked — ${reason}\n`);
  process.exit(2);
}

// A hook that throws would fail-OPEN (Claude Code ignores a crashed hook and proceeds).
// So every parse/read failure exits 0 deliberately ONLY for genuinely empty input; a
// present-but-unparseable payload is treated as suspicious and blocked.
let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  process.exit(0); // no stdin at all (e.g. a manual invocation) — nothing to guard
}
if (raw.trim().length === 0) process.exit(0);

let cmd = "";
try {
  const payload = JSON.parse(raw);
  cmd = payload?.tool_input?.command ?? "";
} catch {
  block("unparseable PreToolUse payload");
}
if (typeof cmd !== "string" || cmd.length === 0) process.exit(0);

const INTERP = "(?:python3?|node|perl|ruby|deno|bun)";

// 1. Interpreter one-liners: `<interp> ... -c|-e|-p ...`, or a pipe/heredoc feeding one.
if (new RegExp(`(^|[\\s|;&(\`$])${INTERP}\\b`).test(cmd) && /(^|\s)-{1,2}(c|e|p)\b/.test(cmd)) {
  block("interpreter one-liner (-c/-e/-p) — evades the file-tool deny (D-26)");
}
if (new RegExp(`\\|\\s*${INTERP}\\b`).test(cmd)) block("pipe into an interpreter");
if (new RegExp(`<<-?\\s*['\"\\w]+[\\s\\S]*${INTERP}\\b`).test(cmd)) block("heredoc into an interpreter");

// 2. Network / exfil verbs as command words (a secret read + this = one call today).
if (/(^|[\s|;&(`])(curl|wget|nc|ncat|scp|sftp|telnet)\b/.test(cmd)) block("network/exfil verb");

// 3. Secret and out-of-worktree references.
if (/(^|[\s"'=/])\.env\b/.test(cmd)) block("reference to a .env file");
if (/~\/\.ssh|~\/\.config|\/\.ssh\/|\.config\/amiticia/.test(cmd)) block("reference to a secret directory");
if (/(^|[\s"'=])\.\.\//.test(cmd)) block("parent-directory traversal out of the worktree");

process.exit(0); // everything else is a normal build command — allow it

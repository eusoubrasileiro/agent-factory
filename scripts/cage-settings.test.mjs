/**
 * Tests for cage-settings.mjs (glm-cc-cage F2).
 *
 * The cage is a security surface, so these tests pin the two things that make it
 * silently useless: a mis-anchored path rule (single leading `/` anchors to the
 * settings file's own directory, not the fs root) and a sandbox that is enabled
 * but not fail-closed (it degrades to NO sandbox — decisions.md D-12).
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  auditCageSettings,
  cageSettingsPath,
  denyRules,
  loadTemplate,
  renderCageSettings,
  writeCageSettings,
} from "./cage-settings.mjs";

const WT = "/home/x/.claude/worktrees/demo";

function tmpRoot() {
  return mkdtempSync(path.join(tmpdir(), "cage-settings-"));
}

// ─── renderCageSettings ───────────────────────────────────────────────────────

test("renderCageSettings: substitutes {{WORKTREE}} into fs-absolute // rules", () => {
  const out = renderCageSettings(
    { permissions: { deny: ["Edit(//{{WORKTREE}}/backend/src/bot/**)"] } },
    WT,
  );
  assert.deepEqual(denyRules(out), ["Edit(//home/x/.claude/worktrees/demo/backend/src/bot/**)"]);
});

test("renderCageSettings: strips the _readme prose block", () => {
  const out = renderCageSettings({ _readme: ["hi"], permissions: { deny: [] } }, WT);
  assert.equal(out._readme, undefined);
  assert.ok(out.permissions);
});

test("renderCageSettings: a trailing slash never yields a doubled separator", () => {
  const out = renderCageSettings({ permissions: { deny: ["Edit(//{{WORKTREE}}/a)"] } }, `${WT}/`);
  assert.deepEqual(denyRules(out), ["Edit(//home/x/.claude/worktrees/demo/a)"]);
});

test("renderCageSettings: rejects a relative worktree path", () => {
  assert.throws(() => renderCageSettings({}, "relative/path"), /absolute/);
});

test("renderCageSettings: leaves ~/ rules untouched", () => {
  const out = renderCageSettings({ permissions: { deny: ["Read(~/.ssh/**)"] } }, WT);
  assert.deepEqual(denyRules(out), ["Read(~/.ssh/**)"]);
});

// ─── auditCageSettings ────────────────────────────────────────────────────────

const SANE_SANDBOX = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };

test("auditCageSettings: a well-formed cage has no problems", () => {
  const problems = auditCageSettings({
    sandbox: SANE_SANDBOX,
    permissions: { deny: ["Edit(//abs/x/**)", "Read(~/.ssh/**)", "Bash(git push:*)"] },
  });
  assert.deepEqual(problems, []);
});

test("auditCageSettings: catches the single-leading-slash anchoring trap", () => {
  const problems = auditCageSettings({
    sandbox: SANE_SANDBOX,
    permissions: { deny: ["Edit(/backend/src/bot/**)"] },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /mis-anchored/);
});

test("auditCageSettings: catches an unsubstituted placeholder", () => {
  const problems = auditCageSettings({
    sandbox: SANE_SANDBOX,
    permissions: { deny: ["Edit(//{{WORKTREE}}/a)"] },
  });
  assert.ok(problems.some((p) => /unsubstituted placeholder/.test(p)));
});

test("auditCageSettings: a sandbox that is not fail-closed is a problem", () => {
  // enabled:true alone silently degrades to NO sandbox when a dep is missing.
  const problems = auditCageSettings({
    sandbox: { enabled: true, failIfUnavailable: false, allowUnsandboxedCommands: false },
    permissions: { deny: [] },
  });
  assert.ok(problems.some((p) => /failIfUnavailable/.test(p)));
});

test("auditCageSettings: sandbox disabled, or unsandboxed commands allowed, are problems", () => {
  const off = auditCageSettings({ sandbox: { ...SANE_SANDBOX, enabled: false }, permissions: {} });
  assert.ok(off.some((p) => /sandbox\.enabled/.test(p)));
  const loose = auditCageSettings({
    sandbox: { ...SANE_SANDBOX, allowUnsandboxedCommands: true },
    permissions: {},
  });
  assert.ok(loose.some((p) => /allowUnsandboxedCommands/.test(p)));
});

test("auditCageSettings: Bash rules are not path-anchored and never flagged", () => {
  const problems = auditCageSettings({
    sandbox: SANE_SANDBOX,
    permissions: { deny: ["Bash(git push:*)", "Bash(sh:*)"] },
  });
  assert.deepEqual(problems, []);
});

// ─── the checked-in template ──────────────────────────────────────────────────

test("the shipped template renders to a cage that passes its own audit", () => {
  const settings = renderCageSettings(loadTemplate(), WT);
  assert.deepEqual(auditCageSettings(settings), [], "shipped template must be a sane cage");
});

test("the shipped template denies every wahub Critical File", () => {
  const rules = denyRules(renderCageSettings(loadTemplate(), WT)).join("\n");
  for (const critical of [
    "backend/src/bot/**",
    "backend/src/logger.ts",
    "backend/src/middleware/audit-log.ts",
    "backend/src/lib/waba.ts",
    "backend/test/e2e/real/**",
    "backend/test/eval/**",
    "frontend/tests/e2e/**",
    "frontend/tests/e2e-real/**",
    ".husky/**",
    "commitlint.config.cjs",
    "quality-baseline.json",
    "prisma/schema.prisma",
  ]) {
    assert.ok(rules.includes(critical), `Critical File not denied: ${critical}`);
  }
});

test("the shipped template denies the agent editing its own cage settings", () => {
  const rules = denyRules(renderCageSettings(loadTemplate(), WT));
  assert.ok(
    rules.some((r) => r.startsWith("Edit(") && r.includes("/.claude/settings")),
    "agent must not edit its own settings",
  );
  assert.ok(
    rules.some((r) => r.startsWith("Write(") && r.includes("/.claude/settings")),
    "agent must not write its own settings",
  );
});

test("the shipped template does NOT deny all of .claude/** (that breaks the sandbox)", () => {
  // Regression pin. Denying the whole dir makes Claude Code's sandbox mount
  // .claude read-only; it then cannot create .claude/commands and EVERY bash
  // command dies at bootstrap — a cage so tight the agent cannot work at all.
  // Narrowness is safe: a deny rule can never be overridden by an allow rule.
  const rules = denyRules(renderCageSettings(loadTemplate(), WT));
  for (const r of rules) {
    assert.ok(
      !/\.claude\/\*\*\)$/.test(r),
      `wholesale .claude/** deny breaks the sandbox bootstrap: ${r}`,
    );
  }
});

// ─── writeCageSettings ────────────────────────────────────────────────────────

test("writeCageSettings: writes valid JSON at <worktree>/.claude/settings.external.json", () => {
  const root = tmpRoot();
  try {
    const out = writeCageSettings(root);
    assert.equal(out, cageSettingsPath(root));
    assert.ok(existsSync(out));
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(parsed.sandbox.failIfUnavailable, true);
    assert.equal(parsed._readme, undefined, "prose is stripped from the emitted settings");
    assert.ok(denyRules(parsed).every((r) => !r.includes("{{")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeCageSettings: refuses to write a broken cage (fail-closed)", () => {
  const root = tmpRoot();
  try {
    const badTemplate = path.join(root, "bad.json");
    writeFileSync(
      badTemplate,
      JSON.stringify({
        sandbox: { enabled: true, failIfUnavailable: false, allowUnsandboxedCommands: false },
        permissions: { deny: ["Edit(/backend/**)"] },
      }),
    );
    assert.throws(() => writeCageSettings(root, badTemplate), /refusing to write a broken cage/);
    assert.equal(existsSync(cageSettingsPath(root)), false, "nothing written on refusal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeCageSettings: overwrites a tampered cage from a previous run", () => {
  const root = tmpRoot();
  try {
    const out = writeCageSettings(root);
    writeFileSync(out, JSON.stringify({ permissions: { deny: [] } })); // agent weakens it
    writeCageSettings(root); // fresh spawn re-stamps
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    assert.ok(denyRules(parsed).length > 0, "cage restored on re-render");
    assert.equal(parsed.sandbox.failIfUnavailable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Tests for cage-settings.mjs (glm-cc-cage F2).
 *
 * The cage is a security surface, so these tests pin the two things that make it
 * silently useless: a mis-anchored path rule (single leading `/` anchors to the
 * settings file's own directory, not the fs root) and a sandbox that is enabled
 * but not fail-closed (it degrades to NO sandbox — decisions.md D-12).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  auditCageSettings,
  cageSettingsPath,
  criticalFileRules,
  denyRules,
  loadTemplate,
  renderCageSettings,
  machineSandboxEnabled,
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

// ─── criticalFileRules + profile merge (Feature 03) ───────────────────────────

test("criticalFileRules: emits Edit+Write //-anchored rules per glob", () => {
  assert.deepEqual(
    criticalFileRules(["backend/src/bot/**"]),
    ["Edit(//{{WORKTREE}}/backend/src/bot/**)", "Write(//{{WORKTREE}}/backend/src/bot/**)"],
  );
  // multiple globs: each yields an Edit+Write pair, order preserved
  assert.deepEqual(
    criticalFileRules(["a/**", "b.ts"]),
    [
      "Edit(//{{WORKTREE}}/a/**)",
      "Write(//{{WORKTREE}}/a/**)",
      "Edit(//{{WORKTREE}}/b.ts)",
      "Write(//{{WORKTREE}}/b.ts)",
    ],
  );
  // non-array / empty / wrong-shaped input → [] (never throws)
  assert.deepEqual(criticalFileRules([]), []);
  assert.deepEqual(criticalFileRules(undefined), []);
  assert.deepEqual(criticalFileRules(null), []);
  assert.deepEqual(criticalFileRules("not-an-array"), []);
});

test("renderCageSettings: merges profile critical files into the base template", () => {
  const out = renderCageSettings(
    { permissions: { deny: ["Edit(//{{WORKTREE}}/keep)"] } },
    WT,
    { criticalFiles: ["backend/src/bot/**"] },
  );
  assert.deepEqual(denyRules(out), [
    "Edit(//home/x/.claude/worktrees/demo/keep)",
    "Edit(//home/x/.claude/worktrees/demo/backend/src/bot/**)",
    "Write(//home/x/.claude/worktrees/demo/backend/src/bot/**)",
  ]);
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

// Tier A/B (D-18). Sandbox OFF is the shipping posture on machines where Claude
// Code's sandbox cannot initialise, so a disabled sandbox must AUDIT CLEAN.
// Sandbox ON without failIfUnavailable stays a refusal: it degrades silently to
// NO sandbox and hands us a false belief in containment (D-12 / M5).
test("auditCageSettings: a DISABLED sandbox is acceptable (Tier A)", () => {
  const problems = auditCageSettings({
    sandbox: { enabled: false },
    permissions: { deny: [] },
  });
  assert.deepEqual(problems, [], "Tier A must audit clean");
});

test("auditCageSettings: an ABSENT sandbox block is acceptable (Tier A)", () => {
  assert.deepEqual(auditCageSettings({ permissions: { deny: [] } }), []);
});

test("auditCageSettings: sandbox ENABLED without failIfUnavailable is still a refusal", () => {
  const problems = auditCageSettings({
    sandbox: { enabled: true, failIfUnavailable: false, allowUnsandboxedCommands: false },
    permissions: { deny: [] },
  });
  assert.ok(problems.some((p) => /failIfUnavailable/.test(p)), "silent degradation must be refused");
});

test("auditCageSettings: sandbox ENABLED with allowUnsandboxedCommands is a refusal", () => {
  const problems = auditCageSettings({
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: true },
    permissions: { deny: [] },
  });
  assert.ok(problems.some((p) => /allowUnsandboxedCommands/.test(p)));
});

// A disabled sandbox must not be second-guessed on its sibling keys: they are moot.
test("auditCageSettings: a disabled sandbox is not judged on failIfUnavailable", () => {
  const problems = auditCageSettings({
    sandbox: { enabled: false, failIfUnavailable: false, allowUnsandboxedCommands: true },
    permissions: { deny: [] },
  });
  assert.deepEqual(problems, [], "when the sandbox is off, its other knobs are irrelevant");
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

test("the base template alone contains zero product paths", () => {
  // Feature 03: the engine carries NO product literals. Every product Critical
  // File now comes from projects/<id>/critical-files.json at render time. The
  // wahub-specific coverage moved to the per-profile conformance suite (Feature 05).
  for (const r of denyRules(loadTemplate())) {
    for (const product of ["backend/", "frontend/", "prisma/", ".husky", "commitlint", "quality-baseline"]) {
      assert.ok(!r.includes(product), `product path leaked into the base template: ${r}`);
    }
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

test("writeCageSettings: a project's critical files land in the emitted settings", () => {
  // Synthetic profile under a tmp factoryRoot — the engine must not know any
  // product literally, so we build a fake projects/<id>/ and point the resolver
  // at it. resolveProject is total, so a missing project degrades to [] (also
  // asserted below).
  const root = tmpRoot();
  try {
    const projDir = path.join(root, "projects", "synthetic");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(path.join(projDir, "project.json"), JSON.stringify({ id: "synthetic" }));
    writeFileSync(path.join(projDir, "critical-files.json"), JSON.stringify(["src/secret/**"]));

    const wt = path.join(root, "wt");
    const out = writeCageSettings(wt, { project: "synthetic", factoryRoot: root });
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    const rules = denyRules(parsed);
    // renderCageSettings strips the leading '/' from the worktree to form the
    // `//`-anchored rule (see the "//home/x/…" test above). Mirror that here.
    const anchor = wt.replace(/^\/+/, "");
    assert.ok(
      rules.includes(`Edit(//${anchor}/src/secret/**)`),
      "project critical Edit rule must be emitted into the cage",
    );
    assert.ok(
      rules.includes(`Write(//${anchor}/src/secret/**)`),
      "project critical Write rule must be emitted into the cage",
    );

    // Unknown project → no throw, no product rules (best-effort empty profile).
    const wt2 = path.join(root, "wt2");
    const out2 = writeCageSettings(wt2, { project: "no-such-project", factoryRoot: root });
    const rules2 = denyRules(JSON.parse(readFileSync(out2, "utf8")));
    assert.ok(
      rules2.every((r) => !r.includes("src/secret")),
      "unknown project must not inject critical files",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── machine gate (D-18): sandbox.enabled is a MACHINE fact, not a repo fact ───

test("machineSandboxEnabled: an absent machine config means OFF (fail safe, not fail loud)", () => {
  assert.equal(machineSandboxEnabled("/nonexistent/machine.json"), false);
});

test("machineSandboxEnabled: a corrupt machine config means OFF, never throws", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cage-machine-bad-"));
  try {
    const f = path.join(dir, "machine.json");
    writeFileSync(f, "{ this is not json");
    assert.doesNotThrow(() => machineSandboxEnabled(f));
    assert.equal(machineSandboxEnabled(f), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('machineSandboxEnabled: {"sandbox": true} turns it on', () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cage-machine-on-"));
  try {
    const f = path.join(dir, "machine.json");
    writeFileSync(f, JSON.stringify({ sandbox: true }));
    assert.equal(machineSandboxEnabled(f), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCageSettings: sandbox.enabled follows the machine, not the template", () => {
  const template = loadTemplate();
  assert.equal(template.sandbox.enabled, true, "template still declares the intent");

  const off = renderCageSettings(template, "/tmp/wt", { sandboxEnabled: false });
  assert.equal(off.sandbox.enabled, false, "machine says off -> off");
  assert.deepEqual(auditCageSettings(off), [], "Tier A renders audit-clean");

  const on = renderCageSettings(template, "/tmp/wt", { sandboxEnabled: true });
  assert.equal(on.sandbox.enabled, true);
  assert.equal(on.sandbox.failIfUnavailable, true, "Tier B stays fail-closed");
  assert.deepEqual(auditCageSettings(on), []);
});

test("writeCageSettings: writes a Tier A cage on a machine with the sandbox off", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "cage-tierA-"));
  try {
    const out = writeCageSettings(wt, { sandboxEnabled: false });
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(parsed.sandbox.enabled, false);
    assert.deepEqual(auditCageSettings(parsed), []);
    // The deny rules — the part that actually bites on this machine — survive.
    assert.ok(parsed.permissions.deny.length >= 11);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

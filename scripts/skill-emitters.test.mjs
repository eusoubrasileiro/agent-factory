/**
 * Meta-test: every mission skill COMMANDS its telemetry emitter at its gate
 * moment (Plan A F4 — docs/plan-A-ship-truth-2026-07-11.md:120).
 *
 * History: the skills used to narrate telemetry in an advisory "Rules" bullet
 * and never command the call at the step where the gate happens; measured
 * result was 5/3/0 recorded events across three missions — the attention KPI
 * (RUNBOOK §Read the meter) was unmeasurable. A skill edit that drops the
 * commanded emitter must fail the suite, not silently starve the meter.
 *
 * Style: same file-scanning meta-test pattern as the zero-product-literals
 * check in project-profile.test.mjs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const FACTORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read one skill's text. */
function skill(name) {
  return readFileSync(path.join(FACTORY_ROOT, "skills", name, "SKILL.md"), "utf8");
}

/** Slice a skill from one heading up to the next `## ` heading (or EOF). */
function section(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `heading not found: ${heading}`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return rest.slice(0, next === -1 ? rest.length : next);
}

const EMITTER = /node scripts\/metrics\.mjs record <slug>/;

test("mission-plan: the approval gate (§6) commands a touchpoint emitter", () => {
  const s = section(skill("mission-plan"), "## 6. The ONE approval gate");
  assert.match(s, EMITTER);
  assert.match(s, /"type":"touchpoint"/);
});

test("mission-build: the validator handoff (§5) commands the phase emitter pair", () => {
  const s = section(skill("mission-build"), "## 5. Hand to the validator");
  assert.match(s, EMITTER);
  assert.match(s, /"type":"phase_start"/);
  assert.match(s, /phase_end/);
});

test("mission-validate: the verdict report (§5) commands a touchpoint emitter", () => {
  const s = section(skill("mission-validate"), "## 5. Report to Andre");
  assert.match(s, EMITTER);
  assert.match(s, /"type":"touchpoint"/);
});

test("emitter commands carry --project routing (D-24 telemetry doctrine)", () => {
  for (const name of ["mission-plan", "mission-build", "mission-validate"]) {
    const hits = skill(name).match(/node scripts\/metrics\.mjs record <slug>[^\n]*/g) ?? [];
    assert.ok(hits.length > 0, `${name}: no emitter command at all`);
    for (const h of hits) {
      assert.match(h, /--project <project>/, `${name}: emitter without --project: ${h}`);
    }
  }
});

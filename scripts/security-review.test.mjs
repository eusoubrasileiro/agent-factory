/**
 * Tests for security-review.mjs's pure verdict logic.
 *
 * The property under test: the model's stated `verdict` is NOT trusted over
 * the `findings[]` it carries. A response that names a `blocker` — "must fix
 * before push" — while stamping "approve" is self-contradictory, and the
 * severity wins. `important` deliberately does not flip; see validateVerdict.
 *
 * Run: `node --test scripts/security-review.test.mjs`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateVerdict } from "./security-review.mjs";

const finding = (severity, over = {}) => ({
  severity,
  file: "backend/src/foo.ts",
  issue: "something is wrong",
  fix: "do the thing",
  ...over,
});

const payload = (over = {}) => ({
  verdict: "approve",
  justification: "looks fine",
  concerns: [],
  ...over,
});

test("approve with no findings stays approve", () => {
  const out = validateVerdict(payload());
  assert.equal(out.verdict, "approve");
  assert.equal(out.blockerOnApprove, false);
  assert.equal(out.importantOnApprove, false);
});

test("approve with an empty findings array stays approve", () => {
  const out = validateVerdict(payload({ findings: [] }));
  assert.equal(out.verdict, "approve");
});

test("a blocker forces reject even when the model said approve", () => {
  const out = validateVerdict(payload({ findings: [finding("blocker")] }));
  assert.equal(out.verdict, "reject");
  assert.equal(out.blockerOnApprove, true);
});

test("a blocker among other severities still forces reject", () => {
  const out = validateVerdict(
    payload({ findings: [finding("minor"), finding("blocker"), finding("important")] }),
  );
  assert.equal(out.verdict, "reject");
  assert.equal(out.blockerOnApprove, true);
});

test("important on an approve is flagged but does NOT block", () => {
  const out = validateVerdict(payload({ findings: [finding("important")] }));
  assert.equal(out.verdict, "approve");
  assert.equal(out.importantOnApprove, true);
  assert.equal(out.blockerOnApprove, false);
});

test("minor on an approve neither blocks nor flags", () => {
  const out = validateVerdict(payload({ findings: [finding("minor")] }));
  assert.equal(out.verdict, "approve");
  assert.equal(out.importantOnApprove, false);
});

test("an explicit reject stays reject and is not flagged as an override", () => {
  const out = validateVerdict(
    payload({ verdict: "reject", findings: [finding("blocker")] }),
  );
  assert.equal(out.verdict, "reject");
  assert.equal(out.blockerOnApprove, false, "already rejected — nothing was overridden");
});

test("a malformed finding still fails shape validation", () => {
  assert.equal(validateVerdict(payload({ findings: [finding("catastrophic")] })), null);
  assert.equal(validateVerdict(payload({ findings: [{ severity: "blocker" }] })), null);
  assert.equal(validateVerdict(payload({ findings: "not-an-array" })), null);
});

test("a payload with a bad verdict value is rejected outright", () => {
  assert.equal(validateVerdict(payload({ verdict: "maybe" })), null);
  assert.equal(validateVerdict(null), null);
});

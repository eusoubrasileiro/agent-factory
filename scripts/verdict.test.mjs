/**
 * Tests for the factory verdict recorder.
 *
 *   node --test "scripts/factory/*.test.mjs"
 *
 * Exercises both the exported `validateVerdict` (pure schema check) and the CLI
 * (`record` / `status`) through a real child process against a temp mission dir.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateVerdict } from "./verdict.mjs";

const CLI = fileURLToPath(new URL("./verdict.mjs", import.meta.url));
const SLUG = "demo-mission";

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "verdict-test-"));
  mkdirSync(path.join(root, SLUG), { recursive: true });
  return root;
}

function runCli(root, args, input) {
  // --repo root isolates syncBoard: the tmp root has no backlog/, so board-sync
  // no-ops instead of defaulting to the real product repo (test-isolation).
  return spawnSync(process.execPath, [CLI, ...args, "--dir", root, "--repo", root], {
    input: input ?? "",
    encoding: "utf8",
  });
}

function passVerdict(round) {
  return {
    slug: SLUG,
    round,
    verdict: "PASS",
    assertions: [{ id: "A1", status: "green", proof: "pnpm test exit 0" }],
    escalate: false,
  };
}

function failVerdict(round) {
  return {
    slug: SLUG,
    round,
    verdict: "FAIL",
    assertions: [
      { id: "A1", status: "green", proof: "pnpm test exit 0" },
      { id: "A2", status: "red", expected: "row present", actual: "missing", proof: "sql select" },
    ],
    escalate: false,
  };
}

function record(root, obj) {
  return runCli(root, ["record", SLUG], JSON.stringify(obj));
}

function logLines(root) {
  const p = path.join(root, SLUG, "validate.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

// ─── validateVerdict (pure) ───────────────────────────────────────────────────

test("validateVerdict accepts a well-formed PASS", () => {
  assert.equal(validateVerdict(passVerdict(1), SLUG).ok, true);
});

test("validateVerdict rejects PASS with a red assertion", () => {
  const bad = passVerdict(1);
  bad.assertions[0].status = "red";
  const r = validateVerdict(bad, SLUG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /green/);
});

test("validateVerdict rejects FAIL with no red assertion", () => {
  const bad = failVerdict(1);
  bad.verdict = "FAIL";
  bad.assertions = [{ id: "A1", status: "green", proof: "x" }];
  assert.equal(validateVerdict(bad, SLUG).ok, false);
});

test("validateVerdict rejects a slug mismatch against the CLI slug", () => {
  assert.equal(validateVerdict(passVerdict(1), "other-slug").ok, false);
});

test("validateVerdict rejects an empty assertions array", () => {
  const bad = passVerdict(1);
  bad.assertions = [];
  assert.equal(validateVerdict(bad, SLUG).ok, false);
});

// ─── CLI: record ──────────────────────────────────────────────────────────────

test("record round 1 appends a JSONL line and exits 0", () => {
  const root = makeRoot();
  try {
    const r = record(root, passVerdict(1));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(logLines(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("record stamps a valid ISO `ts` on the recorded line", () => {
  const root = makeRoot();
  try {
    const r = record(root, passVerdict(1));
    assert.equal(r.status, 0, r.stderr);
    const obj = JSON.parse(logLines(root)[0]);
    assert.equal(typeof obj.ts, "string");
    assert.notEqual(Number.isNaN(Date.parse(obj.ts)), true, "ts must be a valid ISO date");
    // ISO 8601 has a `T` and a timezone offset (Z or +/-); protects against a bare date.
    assert.match(obj.ts, /T/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateVerdict tolerates an optional input `ts` (does not require it)", () => {
  const withTs = passVerdict(1);
  withTs.ts = "2026-07-08T12:00:00.000Z";
  assert.equal(validateVerdict(withTs, SLUG).ok, true);
  const withoutTs = passVerdict(1);
  delete withoutTs.ts;
  assert.equal(validateVerdict(withoutTs, SLUG).ok, true);
});

test("record rejects a round-number gap (round 2 into an empty log)", () => {
  const root = makeRoot();
  try {
    const r = record(root, passVerdict(2));
    assert.equal(r.status, 1);
    assert.equal(logLines(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("record refuses round 4 with exit 2 and no write", () => {
  const root = makeRoot();
  try {
    // build 3 legitimate FAIL rounds first
    assert.equal(record(root, failVerdict(1)).status, 0);
    assert.equal(record(root, failVerdict(2)).status, 0);
    assert.equal(record(root, failVerdict(3)).status, 0);
    const r = record(root, failVerdict(4));
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /escalate/i);
    assert.equal(logLines(root).length, 3, "round 4 must not be written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("record rejects malformed JSON with exit 1", () => {
  const root = makeRoot();
  try {
    const r = runCli(root, ["record", SLUG], "{not json");
    assert.equal(r.status, 1);
    assert.equal(logLines(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("record rejects PASS-with-red-assertion with exit 1", () => {
  const root = makeRoot();
  try {
    const bad = passVerdict(1);
    bad.assertions[0].status = "red";
    const r = record(root, bad);
    assert.equal(r.status, 1);
    assert.equal(logLines(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("record exits 1 for an unknown mission slug", () => {
  const root = mkdtempSync(path.join(tmpdir(), "verdict-test-"));
  try {
    const r = runCli(root, ["record", "no-such-mission"], JSON.stringify(passVerdict(1)));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown mission slug/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── CLI: status ──────────────────────────────────────────────────────────────

test("status exits 1 with no rounds yet", () => {
  const root = makeRoot();
  try {
    const r = runCli(root, ["status", SLUG]);
    assert.equal(r.status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status exits 0 when the last verdict is PASS", () => {
  const root = makeRoot();
  try {
    record(root, failVerdict(1));
    record(root, passVerdict(2));
    const r = runCli(root, ["status", SLUG]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status exits 1 when the last verdict is FAIL but not exhausted", () => {
  const root = makeRoot();
  try {
    record(root, failVerdict(1));
    const r = runCli(root, ["status", SLUG]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /A2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status exits 2 when 3 rounds all FAIL (exhausted)", () => {
  const root = makeRoot();
  try {
    record(root, failVerdict(1));
    record(root, failVerdict(2));
    record(root, failVerdict(3));
    const r = runCli(root, ["status", SLUG]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /EXHAUSTED|3\/3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── E1-e: corrupt-line tolerance (publish-funnel-failopen) ───────────────────
// A torn append from a crashed writer must be skipped, never crash `verdict
// status`. Mutation gate: restore the bare `.map(JSON.parse)` in readRecords and
// this test goes red.
test("cmdStatus: a corrupt line in validate.log is skipped, never crashes status (E1-e)", () => {
  const root = makeRoot();
  try {
    assert.equal(record(root, passVerdict(1)).status, 0);
    const logp = path.join(root, SLUG, "validate.log");
    appendFileSync(logp, `{"slug":"${SLUG}","round":2,"verdict":"PA\n`); // torn line
    const r = runCli(root, ["status", SLUG]);
    assert.equal(r.status, 0, `status must not crash on a torn line: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`${SLUG}: 1/\\d+ rounds · last=PASS`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

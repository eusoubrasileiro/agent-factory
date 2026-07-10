/**
 * Tests for probe-secrets.mjs — the external-seat secret-leak probe.
 *
 * Run: node --test scripts/factory/probe-secrets.test.mjs
 *
 * Pure-function tests over synthetic env text — no git, no filesystem.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractSecrets, findLeaks, loadDummyValues, parseEnv } from "./probe-secrets.mjs";

const PARENT_ENV = [
  "# a comment",
  "",
  "POSTGRES_USER=wahub", // short → not a secret
  "BACKEND_PORT=3004", // short → not a secret
  "BASE_URL=http://localhost:3000", // shared non-secret config
  "DATABASE_URL=postgresql://wahub:wahub@localhost:5437/wahub", // local-dev DB (not a prod secret)
  "SUPABASE_SERVICE_ROLE_KEY=eyJQTEFDRUhPTERFUgOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-real-role-key",
  "WABA_TOKEN_KEY=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  'GOOGLE_API_KEY="AIzaReallyLongRealApiKeyValue12345"',
].join("\n");

const DUMMY_VALUES = [
  "http://localhost:3000", // BASE_URL — deliberately shared with parent
  "test-service-role-key-placeholder-value",
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
];

test("parseEnv splits key/value and strips quotes, skips comments/blanks", () => {
  const pairs = parseEnv('# c\n\nA=1\nB="two words"\nC=');
  assert.deepEqual(pairs, [
    { key: "A", value: "1" },
    { key: "B", value: "two words" },
    { key: "C", value: "" },
  ]);
});

test("extractSecrets keeps only values longer than min-len, strips quotes", () => {
  const secrets = extractSecrets(PARENT_ENV, 12);
  assert.ok(secrets.includes("AIzaReallyLongRealApiKeyValue12345"), "quotes stripped");
  assert.ok(secrets.includes("eyJQTEFDRUhPTERFUgOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-real-role-key"));
  assert.ok(secrets.some((s) => s.startsWith("fedcba")));
  // short/common values are below the length floor
  assert.ok(!secrets.includes("wahub"));
  assert.ok(!secrets.includes("3004"));
});

test("findLeaks reports a real secret copied verbatim into a worktree env file", () => {
  const secrets = extractSecrets(PARENT_ENV, 12);
  const leaked = [
    {
      file: ".env",
      text: "SUPABASE_SERVICE_ROLE_KEY=eyJQTEFDRUhPTERFUgOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-real-role-key\n",
    },
  ];
  const hits = findLeaks(leaked, secrets, DUMMY_VALUES, 12);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, ".env");
  assert.equal(hits[0].key, "SUPABASE_SERVICE_ROLE_KEY");
});

test("findLeaks returns empty when the worktree holds only dummy values", () => {
  const secrets = extractSecrets(PARENT_ENV, 12);
  const dummy = [
    {
      file: ".env",
      text: [
        "SUPABASE_SERVICE_ROLE_KEY=test-service-role-key-placeholder-value",
        "WABA_TOKEN_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "DATABASE_URL=postgresql://wahub:wahub@localhost:5437/wahub_probe_ext",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findLeaks(dummy, secrets, DUMMY_VALUES, 12), []);
});

test("findLeaks does NOT flag the per-agent DB URL that only shares the local-dev prefix", () => {
  // Regression: the seat's DATABASE_URL contains the parent's local-dev DB URL
  // as a prefix. Exact-value match must NOT treat that as a leak.
  const secrets = extractSecrets(PARENT_ENV, 12);
  const files = [
    { file: ".env", text: "DATABASE_URL=postgresql://wahub:wahub@localhost:5437/wahub_probe_ext" },
  ];
  assert.deepEqual(findLeaks(files, secrets, DUMMY_VALUES, 12), []);
});

test("findLeaks ignores non-secret config the seat and parent share on purpose", () => {
  // BASE_URL=http://localhost:3000 is in both parent and the dummy template →
  // subtracted, never flagged.
  const secrets = extractSecrets(PARENT_ENV, 12);
  const files = [{ file: ".env", text: "BASE_URL=http://localhost:3000" }];
  assert.deepEqual(findLeaks(files, secrets, DUMMY_VALUES, 12), []);
});

// ─── loadDummyValues: the loader, not just the pure core ─────────────────────
//
// The tests above hand `findLeaks` an inline DUMMY_VALUES array. That is exactly
// why nobody noticed that `loadDummyValues()` pointed at a path which has never
// existed (`scripts/templates/external-seat.env` — a missing `..`), silently
// returned `[]`, and left the subtraction dead. These tests exercise the loader
// itself against a real profile on disk.

/** Build a throwaway factory root holding one profile. */
function makeFactoryRoot(prefix, { id, seatEnv }) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const dir = path.join(root, "projects", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.json"), JSON.stringify({ id, path: ".", gate: ["true"] }));
  if (seatEnv !== undefined) writeFileSync(path.join(dir, "seat.env"), seatEnv);
  return root;
}

test("loadDummyValues reads the values out of the profile's seat.env", () => {
  const root = makeFactoryRoot("probe-dummy-", {
    id: "proj",
    seatEnv: ["# comment", "BASE_URL=http://localhost:3000", 'JWT_SECRET="dummy-secret-32-chars-long-abcdef"'].join("\n"),
  });
  try {
    const vals = loadDummyValues("proj", root);
    assert.deepEqual(vals, ["http://localhost:3000", "dummy-secret-32-chars-long-abcdef"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadDummyValues returns [] for a profile with no seat.env (engine-only project)", () => {
  const root = makeFactoryRoot("probe-dummy-none-", { id: "engine" });
  try {
    assert.deepEqual(loadDummyValues("engine", root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadDummyValues never throws on an unknown id or a missing projects/ dir", () => {
  const root = mkdtempSync(path.join(tmpdir(), "probe-dummy-empty-"));
  try {
    assert.deepEqual(loadDummyValues("nope", root), []);
    assert.doesNotThrow(() => loadDummyValues(undefined, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// THE regression test. Had this existed, the dead loader would have been caught:
// a dummy value the seat and parent share on purpose must be subtracted via the
// LOADER, not via a hand-written array.
test("the dummy subtraction is live end-to-end: a shared seat/parent value is not a leak", () => {
  const shared = "http://localhost:3000/shared-config-value";
  const root = makeFactoryRoot("probe-dummy-live-", {
    id: "proj",
    seatEnv: `BASE_URL=${shared}\n`,
  });
  try {
    const parentEnv = `BASE_URL=${shared}\nREAL_SECRET=eyJQTEFDRUhPTERFUgOiJIUzI1NiJ9.actually-real-token\n`;
    const secrets = extractSecrets(parentEnv, 12);
    const seatFiles = [{ file: ".env", text: `BASE_URL=${shared}\n` }];

    // With the loader supplying the dummy values: no leak.
    const loaded = loadDummyValues("proj", root);
    assert.ok(loaded.includes(shared), "loader must actually find the shared value");
    assert.deepEqual(findLeaks(seatFiles, secrets, loaded, 12), []);

    // And the guard is real: with an EMPTY dummy set (the old dead-loader
    // behavior) the very same input is reported as a false leak.
    const falsePositives = findLeaks(seatFiles, secrets, [], 12);
    assert.equal(falsePositives.length, 1, "a dead loader turns shared config into a false LEAK");
    assert.equal(falsePositives[0].key, "BASE_URL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── CLI smoke: main() wiring ────────────────────────────────────────────────
//
// The pure core and the loader were both covered, and a typo in main()
// (`opts.project` where the destructured name is `project`) still shipped green:
// nothing executed main(). These spawn the real CLI. House style — verdict.mjs
// and ratify.mjs are tested the same way.

/** Spawn the probe CLI; returns {status, stdout, stderr}. */
function runProbe(args) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "probe-secrets.mjs");
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("CLI: exits 0 and reports clean when the seat carries only dummy values", () => {
  const root = makeFactoryRoot("probe-cli-clean-", { id: "proj", seatEnv: "BASE_URL=http://localhost:3000\n" });
  const parent = mkdtempSync(path.join(tmpdir(), "probe-cli-parent-"));
  const seat = mkdtempSync(path.join(tmpdir(), "probe-cli-seat-"));
  try {
    writeFileSync(path.join(parent, ".env"), "REAL=eyJQTEFDRUhPTERFUgOiJIUzI1NiJ9.a-real-looking-token\n");
    writeFileSync(path.join(seat, ".env"), "BASE_URL=http://localhost:3000\n");
    const r = runProbe([seat, "--parent", parent, "--project", "proj"]);
    assert.equal(r.status, 0, `expected clean exit 0, got ${r.status}\n${r.stderr}`);
    assert.match(r.stdout, /clean: 0 of/);
    assert.doesNotMatch(r.stderr, /ReferenceError|TypeError/);
  } finally {
    for (const d of [root, parent, seat]) rmSync(d, { recursive: true, force: true });
  }
});

test("CLI: exits 1 and names the key when a real parent secret leaks into the seat", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "probe-cli-leak-parent-"));
  const seat = mkdtempSync(path.join(tmpdir(), "probe-cli-leak-seat-"));
  try {
    const secret = "eyJQTEFDRUhPTERFUgOiJIUzI1NiJ9.this-is-a-real-parent-secret";
    writeFileSync(path.join(parent, ".env"), `SUPABASE_SERVICE_ROLE_KEY=${secret}\n`);
    writeFileSync(path.join(seat, ".env"), `SUPABASE_SERVICE_ROLE_KEY=${secret}\n`);
    const r = runProbe([seat, "--parent", parent]);
    assert.equal(r.status, 1, "a leaked parent secret must exit 1");
    assert.match(r.stderr, /LEAK: 1 real parent-secret value/);
    assert.match(r.stderr, /SUPABASE_SERVICE_ROLE_KEY/);
    // The probe must never echo the whole secret.
    assert.doesNotMatch(r.stderr, /this-is-a-real-parent-secret/);
  } finally {
    for (const d of [parent, seat]) rmSync(d, { recursive: true, force: true });
  }
});

test("CLI: exits 2 on a missing worktree argument", () => {
  const r = runProbe([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/);
});

// ─── Defect 2: "could not compare" is not "clean" ─────────────────────────────
//
// When the parent `.env` is absent the leak scan never runs, yet the old code
// printed "(clean)" and exited 0 — so a seat holding a genuinely leaked secret
// certified clean. The missing comparison base is a precondition failure (exit 2),
// not a clean bill of health (exit 0). Exit 1 stays reserved for "LEAK found".

test("CLI: exits 2 (NOT 0) when the parent .env is absent — could not compare, not clean", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "probe-cli-noparent-")); // no .env here
  const seat = mkdtempSync(path.join(tmpdir(), "probe-cli-noparent-seat-"));
  try {
    writeFileSync(path.join(seat, ".env"), "OPENAI_API_KEY=sk-a-leaked-looking-secret-1234567890\n");
    const r = runProbe([seat, "--parent", parent]);
    assert.equal(r.status, 2, `expected precondition-failure exit 2, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    // The message must say it could not compare, and name the path + the --parent flag.
    const combined = `${r.stdout}\n${r.stderr}`;
    assert.match(combined, /could not compare/);
    assert.match(combined, /--parent/);
    assert.ok(combined.includes(parent), "message must name the path it looked for");
    // And it must NOT claim clean — that is the bug.
    assert.doesNotMatch(combined, /clean/);
  } finally {
    for (const d of [parent, seat]) rmSync(d, { recursive: true, force: true });
  }
});

test("CLI: a leaked secret with no parent .env still exits 2 (the scan never ran)", () => {
  // The defect: a real leaked secret certified clean because the base was missing.
  // Now it is a precondition failure regardless of seat contents.
  const parent = mkdtempSync(path.join(tmpdir(), "probe-cli-noparent-leak-"));
  const seat = mkdtempSync(path.join(tmpdir(), "probe-cli-noparent-leak-seat-"));
  try {
    writeFileSync(path.join(seat, ".env"), "SUPABASE_SERVICE_ROLE_KEY=sk-leaked-real-parent-secret-abcdef\n");
    const r = runProbe([seat, "--parent", parent]);
    assert.equal(r.status, 2, "missing base ⇒ precondition failure, never clean (0) and never a leak claim (1)");
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /LEAK/);
  } finally {
    for (const d of [parent, seat]) rmSync(d, { recursive: true, force: true });
  }
});

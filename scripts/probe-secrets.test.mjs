/**
 * Tests for probe-secrets.mjs — the external-seat secret-leak probe.
 *
 * Run: node --test scripts/factory/probe-secrets.test.mjs
 *
 * Pure-function tests over synthetic env text — no git, no filesystem.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { extractSecrets, findLeaks, parseEnv } from "./probe-secrets.mjs";

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

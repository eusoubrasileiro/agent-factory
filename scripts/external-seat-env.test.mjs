/**
 * Safety invariants for the external-seat dummy env template (W1 / F1).
 *
 * Run: node --test scripts/factory/external-seat-env.test.mjs
 *
 * The template is rendered into external (GLM/opencode) worktrees INSTEAD of the
 * real .env. If a real provider key ever creeps into it, an external model would
 * see a live secret — the exact leak W1 closes. These tests fail loudly on that.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, "..", "templates", "external-seat.env");
const text = readFileSync(TEMPLATE, "utf8");

function value(key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : undefined;
}

test("template mirrors the dummy env from backend/test/setup/env.ts", () => {
  assert.equal(value("JWT_SECRET"), "test-secret-must-be-at-least-32-characters-long");
  assert.equal(
    value("WABA_TOKEN_KEY"),
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.equal(value("SUPABASE_URL"), "https://test-project.supabase.co");
  assert.equal(value("SUPABASE_SERVICE_ROLE_KEY"), "test-service-role-key-placeholder-value");
  assert.equal(value("SUPABASE_ANON_KEY"), "test-anon-key-placeholder-value");
});

test("template carries NO real LLM/vendor provider keys", () => {
  for (const key of [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "RESEND_API_KEY",
    "DEEPSEEK_API_KEY",
  ]) {
    assert.equal(value(key), undefined, `${key} must not be in the external-seat template`);
  }
});

test("template does NOT hardcode DATABASE_URL/DIRECT_URL (dispatch appends per-agent)", () => {
  assert.equal(value("DATABASE_URL"), undefined);
  assert.equal(value("DIRECT_URL"), undefined);
});

test("every Supabase/secret-shaped value is a dummy placeholder or test value", () => {
  // No value looks like a real key: no JWT (eyJ…), no sk-/AIza prefixes.
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(text), "no JWT-shaped token");
  assert.ok(!/\bsk-[A-Za-z0-9]{10,}/.test(text), "no sk- API key");
  assert.ok(!/\bAIza[A-Za-z0-9_-]{10,}/.test(text), "no Google AIza key");
});

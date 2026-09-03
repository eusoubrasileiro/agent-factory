/**
 * Tests for resolveBackend() — the opt-in DeepSeek routing for the LLM
 * reviewer. Run: `node --test scripts/lib/claude-cli.test.mjs`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBackend } from "./claude-cli.mjs";

test("returns model unchanged and no note when REVIEW_BACKEND is unset", () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant" };
  const out = resolveBackend("sonnet", env);
  assert.equal(out.model, "sonnet");
  assert.equal(out.spawnEnv, env);
  assert.equal(out.note, null);
});

test("routes sonnet to deepseek-v4-pro when REVIEW_BACKEND=deepseek and key present", () => {
  const env = { REVIEW_BACKEND: "deepseek", DEEPSEEK_API_KEY: "sk-ds", ANTHROPIC_API_KEY: "sk-ant" };
  const out = resolveBackend("sonnet", env);
  assert.equal(out.model, "deepseek-v4-pro");
  assert.equal(out.spawnEnv.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(out.spawnEnv.ANTHROPIC_AUTH_TOKEN, "sk-ds");
  assert.equal(out.spawnEnv.ANTHROPIC_API_KEY, undefined, "ANTHROPIC_API_KEY must be dropped so the SDK does not prefer it");
  assert.match(out.note, /deepseek-v4-pro/);
});

test("leaves unmapped models (e.g. Haiku intent stage) on Anthropic even when REVIEW_BACKEND=deepseek", () => {
  const env = { REVIEW_BACKEND: "deepseek", DEEPSEEK_API_KEY: "sk-ds" };
  const out = resolveBackend("haiku", env);
  assert.equal(out.model, "haiku");
  assert.equal(out.spawnEnv, env);
  assert.equal(out.note, null);
});

test("falls back to Anthropic with a warning when REVIEW_BACKEND=deepseek but DEEPSEEK_API_KEY is missing", () => {
  const env = { REVIEW_BACKEND: "deepseek" };
  const out = resolveBackend("sonnet", env);
  assert.equal(out.model, "sonnet", "must not route without a key");
  assert.equal(out.spawnEnv, env);
  assert.match(out.note, /DEEPSEEK_API_KEY/);
});

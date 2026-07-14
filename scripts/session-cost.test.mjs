/**
 * Tests for session-cost.mjs — coordinator transcript token accounting (F4).
 *
 * Run: node --test scripts/session-cost.test.mjs
 *
 * House style = transcript-tokens.test.mjs: pure tests over `summarizeUsage`
 * (day × model usage grouping from parsed rows) + `defaultTranscriptDir`
 * (cwd → ~/.claude/projects/<encoded>) + `renderTable`; the I/O discovery
 * (`readTranscriptDir`) is exercised against a tmpdir, and the CLI shell is
 * driven via spawnSync (the `--json` machine form + the A4 "sem transcripts"
 * empty-dir report path).
 *
 * The corrupt-line test (A3) is a mutation gate: it must stay green while the
 * reader skips bad JSONL lines, and go red the moment a line is allowed to
 * throw. The empty-dir test (A4) pins the report-only, never-crash contract.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  summarizeUsage,
  readTranscriptDir,
  defaultTranscriptDir,
  renderTable,
} from "./session-cost.mjs";

// ─── summarizeUsage (pure core) ──────────────────────────────────────────────

test("summarizeUsage groups usage by day × model and sums the four tiers", () => {
  const rows = [
    {
      type: "assistant",
      timestamp: "2026-07-10T10:05:00Z",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
      },
    },
    {
      type: "assistant",
      timestamp: "2026-07-10T11:00:00Z", // same day+model → folded into the same group
      message: { model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 5 } },
    },
    {
      type: "assistant",
      timestamp: "2026-07-11T09:00:00Z", // next day → new group
      message: { model: "claude-sonnet-5", usage: { input_tokens: 40, output_tokens: 8, cache_read_input_tokens: 2 } },
    },
  ];
  const rep = summarizeUsage(rows);
  assert.equal(rep.measured, 3, "three usage-bearing rows counted");
  assert.equal(rep.totals.input, 145);
  assert.equal(rep.totals.output, 33);
  assert.equal(rep.totals.cache_read, 52);
  assert.equal(rep.totals.cache_creation, 10);
  assert.equal(rep.totals.total, 145 + 33 + 52 + 10);

  const byKey = new Map(rep.groups.map((g) => [`${g.day}|${g.model}`, g]));
  const a = byKey.get("2026-07-10|claude-opus-4-8");
  assert.ok(a, "day×model group for 07-10 opus exists");
  assert.equal(a.input, 105);
  assert.equal(a.output, 25);
  assert.equal(a.cache_read, 50);
  assert.equal(a.cache_creation, 10);
  assert.equal(a.total, 105 + 25 + 50 + 10);

  const b = byKey.get("2026-07-11|claude-sonnet-5");
  assert.ok(b, "day×model group for 07-11 sonnet exists");
  assert.equal(b.input, 40);
});

test("summarizeUsage respects the [sinceMs, untilMs] window", () => {
  const rows = [
    { type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { model: "m", usage: { input_tokens: 100 } } },
    { type: "assistant", timestamp: "2026-07-10T12:00:00Z", message: { model: "m", usage: { input_tokens: 200 } } },
    { type: "assistant", timestamp: "2026-07-10T14:00:00Z", message: { model: "m", usage: { input_tokens: 300 } } },
  ];
  const rep = summarizeUsage(rows, {
    sinceMs: Date.parse("2026-07-10T11:00:00Z"),
    untilMs: Date.parse("2026-07-10T13:00:00Z"),
  });
  assert.equal(rep.measured, 1, "only the 12:00 row is in window");
  assert.equal(rep.totals.input, 200);
});

test("summarizeUsage ignores non-assistant rows and rows without a usage object", () => {
  const rep = summarizeUsage([
    { type: "user", message: {} },
    { type: "assistant", message: { model: "m" } }, // no usage
    { type: "assistant", message: { model: "m", usage: {} } }, // empty usage → counts as a measured zero row
    { type: "assistant", message: { model: "m", usage: { input_tokens: 7 } } },
  ]);
  assert.equal(rep.measured, 2, "only rows with a usage object are measured");
  assert.equal(rep.totals.input, 7);
});

test("summarizeUsage on empty / no-assistant input → zero totals, measured 0, never throws", () => {
  const rep = summarizeUsage([]);
  assert.equal(rep.measured, 0);
  assert.equal(rep.totals.total, 0);
  assert.deepEqual(rep.groups, []);
  assert.doesNotThrow(() =>
    summarizeUsage([null, {}, { type: "assistant" }, { type: "assistant", message: { usage: "nope" } }]),
  );
});

// ─── readTranscriptDir (I/O, best-effort + tolerant) ──────────────────────────

test("readTranscriptDir reads every .jsonl in the dir into a flat row list", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "session-cost-"));
  try {
    writeFileSync(
      path.join(dir, "a.jsonl"),
      [
        JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { model: "m", usage: { input_tokens: 10 } } }),
        JSON.stringify({ type: "user", message: {} }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      path.join(dir, "b.jsonl"),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-10T11:00:00Z", message: { model: "m", usage: { input_tokens: 5 } } }) + "\n",
    );
    const rows = readTranscriptDir(dir);
    assert.equal(rows.length, 3, "both files' rows flattened together");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A3 — mutation gate: a corrupt/partial JSONL line must be skipped, never thrown.
test("readTranscriptDir skips corrupt + partial JSONL lines without throwing (A3)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "session-cost-corrupt-"));
  try {
    writeFileSync(
      path.join(dir, "mixed.jsonl"),
      [
        JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { model: "m", usage: { input_tokens: 10 } } }),
        "{not valid json at all", // corrupt
        '{"type":"assistant","timestamp":"2026-07-10T11:00:00Z","message":{"model"', // partial / truncated
        JSON.stringify({ type: "assistant", timestamp: "2026-07-10T12:00:00Z", message: { model: "m", usage: { input_tokens: 4 } } }),
        "", // blank line
      ].join("\n") + "\n",
    );
    let rows;
    assert.doesNotThrow(() => {
      rows = readTranscriptDir(dir);
    }, "a bad line must never crash the report (house style, cf. history.mjs readHistory)");
    const assistants = rows.filter((r) => r && r.type === "assistant");
    assert.equal(assistants.length, 2, "only the two well-formed assistant rows survive");
    const rep = summarizeUsage(rows);
    assert.equal(rep.totals.input, 14, "10 + 4; corrupt/partial lines contributed nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscriptDir: missing dir → [] (report tool, never crashes)", () => {
  assert.deepEqual(readTranscriptDir("/does/not/exist"), []);
});

// ─── defaultTranscriptDir (A1) ────────────────────────────────────────────────

test("defaultTranscriptDir: explicit --dir wins; else cwd → ~/.claude/projects/<encoded>", () => {
  // explicit dir is returned verbatim
  assert.equal(defaultTranscriptDir({ dir: "/tmp/x", cwd: "/home/a/factory", projectsRoot: "/home/a/.claude/projects" }), "/tmp/x");
  // derived: encodeTranscriptDir turns every / and . into -
  assert.equal(
    defaultTranscriptDir({ dir: null, cwd: "/home/a/factory", projectsRoot: "/home/a/.claude/projects" }),
    "/home/a/.claude/projects/-home-a-factory",
  );
});

// ─── renderTable (A2) ─────────────────────────────────────────────────────────

test("renderTable: day × model rows + a TOTAL line, — for absent tiers", () => {
  const rep = summarizeUsage([
    { type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 20 } } },
  ]);
  const out = renderTable(rep, { dir: "/tmp/x" });
  assert.match(out, /DAY/);
  assert.match(out, /2026-07-10/);
  assert.match(out, /claude-opus-4-8/);
  assert.match(out, /TOTAL/);
});

// ─── CLI (A2 --json, A4 empty dir) ────────────────────────────────────────────

const CLI = path.join(import.meta.dirname, "session-cost.mjs");

test("CLI --json on a transcript dir emits the machine form (A2)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "session-cost-cli-"));
  try {
    writeFileSync(
      path.join(dir, "s.jsonl"),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } } }) + "\n",
    );
    const r = spawnSync(process.execPath, [CLI, "--dir", dir, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const obj = JSON.parse(r.stdout);
    assert.equal(obj.totals.input, 100);
    assert.equal(obj.totals.total, 128);
    assert.ok(Array.isArray(obj.groups) && obj.groups.length === 1);
    assert.equal(obj.dir, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A4 — a missing/empty transcript dir prints the "sem transcripts" notice, exits 0.
test("CLI on a missing transcript dir prints 'sem transcripts em <dir>' and exits 0 (A4)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "session-cost-empty-"));
  try {
    const r = spawnSync(process.execPath, [CLI, "--dir", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, "report-only tool never crashes on an empty dir");
    assert.match(r.stdout, /sem transcripts em /);
    assert.ok(r.stdout.includes(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI on a genuinely absent dir prints 'sem transcripts' and exits 0 (A4)", () => {
  const r = spawnSync(process.execPath, [CLI, "--dir", path.join(tmpdir(), "never-existed-" + "x")], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sem transcripts em /);
});

test("CLI --since bounds the window (A2)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "session-cost-since-"));
  try {
    writeFileSync(
      path.join(dir, "s.jsonl"),
      [
        JSON.stringify({ type: "assistant", timestamp: "2026-06-01T10:00:00Z", message: { model: "m", usage: { input_tokens: 100 } } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { model: "m", usage: { input_tokens: 7 } } }),
      ].join("\n") + "\n",
    );
    const r = spawnSync(process.execPath, [CLI, "--dir", dir, "--since", "2026-07-01T00:00:00Z", "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const obj = JSON.parse(r.stdout);
    assert.equal(obj.totals.input, 7, "the pre-since row is excluded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Guard against the test setup itself silently passing on a missing import.
test("module exports the expected surface", () => {
  assert.equal(typeof summarizeUsage, "function");
  assert.equal(typeof readTranscriptDir, "function");
  assert.equal(typeof defaultTranscriptDir, "function");
  assert.equal(typeof renderTable, "function");
});

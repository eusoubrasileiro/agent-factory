#!/usr/bin/env node
/**
 * Tests for the local intake editor server (`scripts/intake-server.mjs`).
 *
 *   node --test "scripts/intake-server.test.mjs"
 *
 * Covers the intake-board contract (missions/factory/intake-board/contract.md):
 *
 *   - I13  the server binds ONLY on 127.0.0.1 (loopback), nothing else. Proven
 *          two honest ways: (a) a real `createServer(createHandler(...))` bound
 *          on `127.0.0.1:0` and driven with `fetch`; (b) a source read asserting
 *          the module's HOST constant is `127.0.0.1` and nothing binds 0.0.0.0
 *          (HOST is not exported, so a readFileSync + regex is the honest probe).
 *   - I14  `applyEdit` writes `<file>.bak` (byte-for-byte prior content) BEFORE it
 *          rewrites the source; delete drops the row; undeclared prefix / missing
 *          file throw.
 *   - `sourceFor` matches by id PREFIX and returns null when unclaimed.
 *   - `createHandler` routing: GET / (html), GET /api/rows (json array), unknown
 *          path 404, POST to a nonexistent id 400 (not 500 / crash).
 *   - `renderEditorPage` shows the panel WITHOUT `hidden` and escapes a malicious
 *          `<script>` coming from a row's summary.
 *
 * Isolation rules (hard):
 *   - NEVER touch the real clients/tenant-a/requirements-intake.md. Every write test
 *     targets a `.md` this file created under mkdtemp.
 *   - `createHandler`/`buildModel` read the REAL profiles via resolveProject, and
 *     `FACTORY_ROOT` is captured at MODULE IMPORT time. So we set
 *     `process.env.FACTORY_ROOT` to a temp factory root (with its own
 *     projects/t/project.json + a temp intake.md) BEFORE the dynamic
 *     `await import(...)` below — no static import of the module under test.
 */

import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(HERE, "intake-server.mjs");

// ─── A minimal intake table fixture (one IN- row) ─────────────────────────────

const INTAKE_MD =
  "# Requirements intake (fixture)\n\n" +
  "| ID | Data · Fonte | Tipo | Resumo | Situação | Aterrissou |\n" +
  "|----|----|----|----|----|----|\n" +
  "| IN-1 | 2026-07-01 · audio | feature | resumo antigo | New | — |\n";

// ─── Temp factory root, wired BEFORE importing the module (FACTORY_ROOT is read
//     at import time). No static import of intake-server.mjs exists in this file,
//     so the dynamic import below is the first load and picks up this root. ─────

const FACTORY_ROOT = mkdtempSync(path.join(tmpdir(), "intake-server-froot-"));
const FROOT_INTAKE = path.join(FACTORY_ROOT, "intake.md");
mkdirSync(path.join(FACTORY_ROOT, "projects", "t"), { recursive: true });
writeFileSync(
  path.join(FACTORY_ROOT, "projects", "t", "project.json"),
  JSON.stringify({
    id: "t",
    name: "t",
    path: ".",
    intake: [{ file: "intake.md", prefix: "IN", label: "t" }],
  }),
);
writeFileSync(FROOT_INTAKE, INTAKE_MD);

process.env.FACTORY_ROOT = FACTORY_ROOT;

const { applyEdit, sourceFor, createHandler, renderEditorPage } = await import(MODULE_PATH);

after(() => {
  rmSync(FACTORY_ROOT, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A throwaway intake `.md` (its own dir), so write tests never touch anything real. */
function makeTmpIntake(contents = INTAKE_MD) {
  const dir = mkdtempSync(path.join(tmpdir(), "intake-server-md-"));
  const file = path.join(dir, "requirements-intake.md");
  writeFileSync(file, contents);
  return { dir, file };
}

/** Start a real loopback server around `handler`; returns { port, close }. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        address: addr.address,
        port: addr.port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ─── sourceFor — prefix matching ──────────────────────────────────────────────

test("sourceFor: matches by id PREFIX (IN-44 → the IN source)", () => {
  const sources = [
    { projectId: "t", file: "/x/a.md", prefix: "IN", label: "t" },
    { projectId: "u", file: "/x/b.md", prefix: "CIDS", label: "u" },
  ];
  assert.equal(sourceFor(sources, "IN-44"), sources[0]);
  assert.equal(sourceFor(sources, "CIDS-3"), sources[1]);
});

test("sourceFor: returns null when no source claims the prefix", () => {
  const sources = [{ projectId: "t", file: "/x/a.md", prefix: "IN", label: "t" }];
  assert.equal(sourceFor(sources, "ZZ-9"), null);
  assert.equal(sourceFor([], "IN-1"), null);
});

// ─── applyEdit — .bak before write, delete, throws (I14) ──────────────────────

test("applyEdit: writes <file>.bak with the prior content BYTE-FOR-BYTE before rewriting (I14)", () => {
  const { dir, file } = makeTmpIntake();
  try {
    const before = readFileSync(file); // Buffer — exact bytes
    const sources = [{ projectId: "t", file, prefix: "IN", label: "t" }];

    const written = applyEdit(sources, "IN-1", { fields: { summary: "resumo NOVO" } });
    assert.equal(written, file);

    // The backup exists and equals the pre-edit bytes exactly.
    const bak = `${file}.bak`;
    assert.ok(existsSync(bak), ".bak created");
    assert.deepEqual(readFileSync(bak), before, ".bak is byte-for-byte the prior content");

    // The live file actually changed (new summary landed, old gone).
    const after = readFileSync(file, "utf8");
    assert.match(after, /resumo NOVO/);
    assert.doesNotMatch(after, /resumo antigo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyEdit: {delete:true} removes the row line", () => {
  const { dir, file } = makeTmpIntake();
  try {
    const sources = [{ projectId: "t", file, prefix: "IN", label: "t" }];
    assert.match(readFileSync(file, "utf8"), /\|\s*IN-1\s*\|/);

    applyEdit(sources, "IN-1", { delete: true });

    assert.doesNotMatch(readFileSync(file, "utf8"), /\|\s*IN-1\s*\|/, "IN-1 row is gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyEdit: id whose prefix no source declares throws (nenhuma fonte declarada)", () => {
  const { dir, file } = makeTmpIntake();
  try {
    const sources = [{ projectId: "t", file, prefix: "IN", label: "t" }];
    assert.throws(() => applyEdit(sources, "ZZ-9", { fields: {} }), /nenhuma fonte declarada/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyEdit: declared prefix but missing file throws (fonte não encontrada)", () => {
  const sources = [
    { projectId: "t", file: "/no/such/dir/requirements-intake.md", prefix: "IN", label: "t" },
  ];
  assert.throws(() => applyEdit(sources, "IN-1", { fields: {} }), /fonte não encontrada/);
});

// ─── createHandler — routing over a REAL loopback socket (I13 part A) ─────────

test("createHandler: bound on 127.0.0.1, GET / → 200 text/html with class=\"intake-card\" (I13)", async () => {
  const srv = await startServer(createHandler({}));
  try {
    // The harness itself bound loopback-only.
    assert.equal(srv.address, "127.0.0.1", "server bound on 127.0.0.1");

    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const body = await res.text();
    assert.match(body, /class="intake-card"/, "the editor page renders intake cards");
  } finally {
    await srv.close();
  }
});

test("createHandler: GET /api/rows → 200 JSON array", async () => {
  const srv = await startServer(createHandler({}));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/rows`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const rows = await res.json();
    assert.ok(Array.isArray(rows), "rows payload is an array");
    assert.ok(
      rows.some((r) => r.id === "IN-1"),
      "the temp profile's intake row surfaces",
    );
  } finally {
    await srv.close();
  }
});

test("createHandler: unknown path → 404 with {ok:false}", async () => {
  const srv = await startServer(createHandler({}));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/nope`);
    assert.equal(res.status, 404);
    const j = await res.json();
    assert.equal(j.ok, false);
  } finally {
    await srv.close();
  }
});

test("createHandler: POST /api/row/<nonexistent id> → 400 {ok:false,error} (not 500, no crash)", async () => {
  const srv = await startServer(createHandler({}));
  try {
    // IN-99 has a declared source (prefix IN → the temp intake.md) but no such
    // row, so writeRow throws "não encontrado" and the handler answers 400.
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/row/IN-99`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "x" }),
    });
    assert.equal(res.status, 400, "bad edit is 400, never 500");
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.ok(typeof j.error === "string" && j.error.length > 0, "carries an error message");

    // And it did NOT write a phantom row/backup for a nonexistent id.
    assert.doesNotMatch(readFileSync(FROOT_INTAKE, "utf8"), /IN-99/, "no phantom write");
  } finally {
    await srv.close();
  }
});

// ─── I13 part B — honest source read (HOST is not exported) ───────────────────

test("source: HOST constant is 127.0.0.1 and nothing binds 0.0.0.0 (I13, read-based)", () => {
  // HOST is a module-private const, so the honest probe is the source text: the
  // live `.listen(port, HOST)` in main() uses this constant, and the test above
  // exercises createHandler over a loopback socket we bound ourselves.
  const src = readFileSync(MODULE_PATH, "utf8");
  assert.match(src, /const HOST = "127\.0\.0\.1"/, "HOST is loopback");
  assert.doesNotMatch(src, /0\.0\.0\.0/, "never binds all interfaces");
  // The only .listen() must pass HOST as its host argument.
  assert.match(src, /\.listen\(\s*port\s*,\s*HOST\b/, "listen binds HOST explicitly");
});

// ─── renderEditorPage — visible panel + XSS escaping ──────────────────────────

test("renderEditorPage: the intake panel is NOT hidden (local, always-visible version)", () => {
  const rows = [
    {
      id: "IN-7",
      date: "2026-07-01",
      dateSource: "2026-07-01 · audio",
      type: "feature",
      status: "New",
      summary: "um resumo qualquer",
    },
  ];
  const html = renderEditorPage(rows);
  const panel = html.match(/<section id="tab-intake"[^>]*>/);
  assert.ok(panel, "the intake panel is present");
  assert.doesNotMatch(panel[0], /\bhidden\b/, "panel carries no hidden attribute");
});

test("renderEditorPage: a <script> in a row's summary is ESCAPED, never an executable tag", () => {
  const rows = [
    {
      id: "IN-8",
      date: "2026-07-01",
      dateSource: "2026-07-01 · audio",
      type: "feature",
      status: "New",
      summary: "<script>alert(1)</script>",
    },
  ];
  const html = renderEditorPage(rows);
  // The raw executable tag must never appear.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, "no live injected script");
  // It appears HTML-escaped in the rendered card instead.
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "shows up escaped as text");
});

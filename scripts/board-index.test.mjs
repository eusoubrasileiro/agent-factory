/**
 * Tests for the factory board root index — the `/` landing page (feature 03).
 *
 *   node --test "scripts/factory/board-index.test.mjs"
 *
 * Two pure renderers, both self-contained PT-BR HTML:
 *   1. `renderRootIndex(projects, stats)` — one card per project manifest entry
 *      (nome, missões em voo count, última atualização, link `/<id>/`).
 *   2. `renderScrumbanRedirect(target)` — meta-refresh + canonical redirect to a
 *      caller-chosen target (historical-compat for the old single-board URL).
 *
 * House style mirrors board-report.test.mjs: pure-function assertions, no disk.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { renderRootIndex, renderScrumbanRedirect } from "./board-index.mjs";

// ─── renderRootIndex ─────────────────────────────────────────────────────────

test("renderRootIndex: is exported as a function", () => {
  assert.equal(typeof renderRootIndex, "function");
});

test("renderRootIndex: emits a complete <!doctype html> document with inline <style>", () => {
  const html = renderRootIndex([], { generatedAt: "2026-07-08T00:00:00.000Z" });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html[\s>]/i);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /<style[\s>]/);
  // Zero external stylesheets.
  assert.doesNotMatch(html, /<link\s+[^>]*rel=["']stylesheet["']/i);
});

test("renderRootIndex: one card per project entry (manifest order preserved)", () => {
  const html = renderRootIndex(
    [
      {
        id: "wahub",
        name: "Nexus CRM / WaHub",
        inFlight: 2,
        updatedAt: "2026-07-08T00:00:00.000Z",
      },
      { id: "other", name: "Outro Projeto", inFlight: 0, updatedAt: null },
    ],
    { generatedAt: "2026-07-08T00:00:00.000Z" },
  );
  assert.match(html, /Nexus CRM \/ WaHub/);
  assert.match(html, /Outro Projeto/);
  // manifest order: wahub card before other card.
  assert.ok(
    html.indexOf("Nexus CRM / WaHub") < html.indexOf("Outro Projeto"),
    "manifest order preserved",
  );
});

test("renderRootIndex: each card links to /<id>/", () => {
  const html = renderRootIndex([{ id: "wahub", name: "WaHub", inFlight: 1, updatedAt: null }], {
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
  assert.match(html, /href="\/wahub\/"/);
});

test("renderRootIndex: missões em voo count renders (singular/plural PT-BR)", () => {
  const html = renderRootIndex(
    [
      { id: "a", name: "A", inFlight: 1, updatedAt: null },
      { id: "b", name: "B", inFlight: 3, updatedAt: null },
      { id: "c", name: "C", inFlight: 0, updatedAt: null },
    ],
    { generatedAt: "2026-07-08T00:00:00.000Z" },
  );
  assert.match(html, /1\s+missão em voo/);
  assert.match(html, /3\s+missões em voo/);
  assert.match(html, /0\s+missões em voo/);
});

test("renderRootIndex: missões em voo count comes straight from the injected model (no disk)", () => {
  // Proves the renderer is pure: it does not re-derive counts, only displays
  // the inFlight integer it was handed.
  const html = renderRootIndex([{ id: "x", name: "X", inFlight: 42, updatedAt: null }], {
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
  assert.match(html, /42\s+missões em voo/);
});

test("renderRootIndex: footer has 'gerado em' + generatedAt + 'board-index'", () => {
  const html = renderRootIndex([], { generatedAt: "2026-07-08T12:34:56.000Z" });
  assert.match(html, /gerado em/);
  assert.match(html, /2026-07-08T12:34:56\.000Z/);
  assert.match(html, /board-index/);
});

test("renderRootIndex: última atualização shows per-project when present; omitted when null", () => {
  const html = renderRootIndex(
    [
      { id: "a", name: "A", inFlight: 0, updatedAt: "2026-07-07T08:00:00.000Z" },
      { id: "b", name: "B", inFlight: 0, updatedAt: null },
    ],
    { generatedAt: "2026-07-08T00:00:00.000Z" },
  );
  assert.match(html, /última atualização/);
  assert.match(html, /2026-07-07T08:00:00\.000Z/);
  // The card WITHOUT updatedAt must not carry the "última atualização" label.
  const cardB = html.split("Outro").length > 1 ? null : null; // sanity, no-op
  // Count occurrences: two cards, only one has the label.
  const occurrences = (html.match(/última atualização/g) || []).length;
  assert.equal(occurrences, 1, "exactly one 'última atualização' (only the card with updatedAt)");
});

test("renderRootIndex: empty projects → 'Nenhum projeto.' placeholder", () => {
  const html = renderRootIndex([], { generatedAt: "2026-07-08T00:00:00.000Z" });
  assert.match(html, /Nenhum projeto/);
});

test("renderRootIndex: name falls back to id when name missing/empty", () => {
  const html = renderRootIndex([{ id: "fallback", name: "", inFlight: 0, updatedAt: null }], {
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
  assert.match(html, /fallback/);
});

test("renderRootIndex: self-contained — no external http(s) resource loads", () => {
  const html = renderRootIndex(
    [{ id: "wahub", name: "WaHub", inFlight: 1, updatedAt: "2026-07-08T00:00:00.000Z" }],
    { generatedAt: "2026-07-08T00:00:00.000Z" },
  );
  assert.doesNotMatch(html, /src=["']https?:/i);
  assert.doesNotMatch(html, /href=["']https?:/i);
  // Relative root links like href="/wahub/" are allowed (no scheme).
  assert.match(html, /href="\/wahub\/"/);
});

test("renderRootIndex: escapes interpolated text (& < > \" ')", () => {
  const nasty = `<b>&"'`;
  const html = renderRootIndex([{ id: nasty, name: nasty, inFlight: 0, updatedAt: nasty }], {
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
  // The raw nasty payload must never leak through unescaped.
  assert.doesNotMatch(html, /<b>&"/);
  assert.doesNotMatch(html, /<b>&/);
  // Escaped entities surface for each of the five HTML-significant characters.
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;/);
  assert.match(html, /&#0?39;|&apos;/);
});

test("renderRootIndex: tolerates nullish/non-array projects without throwing", () => {
  assert.doesNotThrow(() => renderRootIndex(null, { generatedAt: "2026-07-08T00:00:00.000Z" }));
  assert.doesNotThrow(() => renderRootIndex(undefined));
  const html = renderRootIndex(undefined);
  assert.match(html, /Nenhum projeto/);
});

test("renderRootIndex: defaults generatedAt to a valid ISO when stats omitted", () => {
  const html = renderRootIndex([]);
  assert.match(html, /gerado em/);
  // The <time datetime="..."> must carry a parseable ISO timestamp.
  const m = html.match(/<time datetime="([^"]+)"/);
  assert.ok(m, "footer time tag present");
  assert.ok(!Number.isNaN(Date.parse(m[1])), "default generatedAt is a valid ISO date");
});

// ─── renderScrumbanRedirect ──────────────────────────────────────────────────

test("renderScrumbanRedirect: is exported as a function", () => {
  assert.equal(typeof renderScrumbanRedirect, "function");
});

test("renderScrumbanRedirect: emits a complete <!doctype html> document", () => {
  const html = renderScrumbanRedirect();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html[\s>]/i);
  assert.match(html, /<\/html>\s*$/);
});

test("renderScrumbanRedirect: contains a meta-refresh to the given target", () => {
  const html = renderScrumbanRedirect("/proj/");
  assert.match(html, /<meta\s+http-equiv="refresh"\s+content="0;\s*url=\/proj\/"/i);
});

test("renderScrumbanRedirect: carries a canonical link to the given target", () => {
  const html = renderScrumbanRedirect("/proj/");
  assert.match(html, /<link\s+rel="canonical"\s+href="\/proj\/"/i);
});

test("renderScrumbanRedirect: has the PT-BR line 'movido para <target>'", () => {
  const html = renderScrumbanRedirect("/proj/");
  assert.match(html, /movido para/);
  assert.match(html, /\/proj\//);
});

test("renderScrumbanRedirect: target is overridable", () => {
  const html = renderScrumbanRedirect("/other/");
  assert.match(html, /url=\/other\//);
  assert.doesNotMatch(html, /\/proj\//);
});

// The renderer is a pure function of its argument: it must not smuggle in a
// product id of its own. `board-autopublish` chooses the target (first project
// in the manifest); the default is the root index, never a named product.
test("renderScrumbanRedirect: defaults to the root index, naming no product", () => {
  const html = renderScrumbanRedirect();
  assert.match(html, /<meta\s+http-equiv="refresh"\s+content="0;\s*url=\/"/i);
});

test("renderScrumbanRedirect: self-contained — inline styles, no external resource loads", () => {
  const html = renderScrumbanRedirect();
  assert.match(html, /<style[\s>]/);
  assert.doesNotMatch(html, /<link\s+[^>]*rel=["']stylesheet["']/i);
  assert.doesNotMatch(html, /src=["']https?:/i);
  assert.doesNotMatch(html, /href=["']https?:/i);
});

test("renderScrumbanRedirect: escapes a malicious target (no quote breakout)", () => {
  const nasty = `"><script>alert(1)</script>`;
  const html = renderScrumbanRedirect(nasty);
  // The raw payload must never leak; the quote + angle bracket must be escaped.
  assert.doesNotMatch(html, /"><script/);
  assert.match(html, /&quot;/);
  assert.match(html, /&lt;script&gt;/);
});

/**
 * Tests for the intake model — `scripts/intake-report.mjs`.
 *
 *   node --test scripts/intake-report.test.mjs
 *
 * Pure string→object functions exercised against inline fixture markdown that
 * mirrors the real `requirements-intake.md` shape: a 6-column table (with an
 * escaped `\|` inside one cell), a `# Detalhamento técnico` section carrying a
 * block SHARED by two ids (`### IN-35 + IN-40`) plus exclusive blocks, and a
 * foreign-prefix row (`CIDS-01`). Assertion ids (I1..I6) track
 * `missions/factory/intake-board/contract.md`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChain,
  citedIds,
  deleteRow,
  detailBlockSpan,
  parseDetails,
  parseIntake,
  readIntake,
  splitCells,
  writeRow,
} from "./intake-report.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// Backslash-escaping note: to place a LITERAL `\|` (backslash + pipe) in the
// markdown, the template literal must carry `\\|` — otherwise JS drops the
// backslash. The IN-44 row below relies on this to prove escaped-pipe handling.

const FIXTURE = `# WaHub / Nexus — intake (fixture)

## Log de captação

| IN | Data · Fonte | Tipo | Resumo | Situação | Aterrissou em |
|---|---|---|---|---|---|
| IN-31 | 2026-07-03 · WA (12:03) | bug | **Bot vaza o endereço.** desc | Landed | nexus §6 · main abc |
| IN-35 | 2026-07-01 · reunião | bug | Não-leads poluem o pipeline | Distilled | → build-backlog |
| IN-40 | 2026-07-01 · reunião | feature | Clientes existentes viram redirect | Distilled | — |
| IN-44 | 2026-06-30 · áudio | feature | Algo com \\| pipe escapado no meio | Distilled | — |
| CIDS-01 | 2026-07-05 · reunião | feature | Item de outro projeto | New | — |

# Detalhamento técnico (revisão de código)

### IN-35 + IN-40 — Não-leads poluem o pipeline · \`bug\`

Corpo do bloco compartilhado por dois ids.
Segunda linha do corpo.

### IN-44 — Canal independente · \`feature\`

Corpo do bloco exclusivo do IN-44.

### IN-45 — Bloco seguinte · \`feature\`

Corpo do IN-45, que deleteRow não pode comer.

## §2 — Seção final

Fim do arquivo.
`;

// An exclusive block that is the LAST thing in the file (end === lines.length).
const FIXTURE_TAIL = `# intake tail (fixture)

## Log

| IN | Data · Fonte | Tipo | Resumo | Situação | Aterrissou em |
|---|---|---|---|---|---|
| IN-50 | 2026-07-01 · x | feature | resumo do último | New | — |

# Detalhamento técnico

### IN-50 — Último bloco do arquivo · \`feature\`

Corpo final do IN-50.
`;

// ─── I1 — table parsing + escaped pipe stays whole ───────────────────────────

test("I1: splitCells keeps an escaped `\\|` cell whole — 6 columns, never 7", () => {
  const line = "| IN-44 | 2026-06-30 · áudio | feature | Algo com \\| pipe no meio | Distilled | — |";
  const cells = splitCells(line);
  assert.equal(cells.length, 6);
  assert.equal(cells[3], "Algo com | pipe no meio");
});

test("I1: parseIntake yields one row per `| IN-NN |`, skipping header and separator rows", () => {
  const { rows } = parseIntake(FIXTURE);
  // Five data rows; the header (`| IN | …`) and separator (`|---|…`) are excluded.
  assert.deepEqual(rows.map((r) => r.id).sort(), ["CIDS-01", "IN-31", "IN-35", "IN-40", "IN-44"]);
  const in44 = rows.find((r) => r.id === "IN-44");
  assert.equal(in44.summary, "Algo com | pipe escapado no meio");
});

// ─── I2 — writeRow roundtrip ─────────────────────────────────────────────────

test("I2: writeRow then parseIntake returns a literal `|` in a cell verbatim", () => {
  const next = writeRow(FIXTURE, "IN-31", { summary: "a | b literal" });
  const row = parseIntake(next).rows.find((r) => r.id === "IN-31");
  assert.equal(row.summary, "a | b literal");
});

test("I2: writeRow leaves fields absent from `fields` at their current value", () => {
  const next = writeRow(FIXTURE, "IN-31", { summary: "só o resumo mudou" });
  const row = parseIntake(next).rows.find((r) => r.id === "IN-31");
  assert.equal(row.summary, "só o resumo mudou");
  assert.equal(row.type, "bug");
  assert.equal(row.status, "Landed");
});

test("I2: writeRow throws on an id that has no row", () => {
  assert.throws(() => writeRow(FIXTURE, "IN-99", { summary: "x" }));
});

// ─── I3 — shared detail block attaches to both ids ───────────────────────────

test("I3: `### IN-35 + IN-40` block attaches to both ids, both shared:true; `### IN-44` is shared:false", () => {
  const details = parseDetails(FIXTURE);
  assert.equal(details["IN-35"].shared, true);
  assert.equal(details["IN-40"].shared, true);
  assert.equal(details["IN-35"].title, details["IN-40"].title); // same block reached by both
  assert.equal(details["IN-44"].shared, false);
});

// ─── I4 — detailBlockSpan ────────────────────────────────────────────────────

test("I4: detailBlockSpan is null for a shared block, and stops before the next heading for an exclusive one", () => {
  const lines = FIXTURE.split("\n");
  assert.equal(detailBlockSpan(lines, "IN-35"), null);
  assert.equal(detailBlockSpan(lines, "IN-40"), null);

  const span = detailBlockSpan(lines, "IN-44");
  assert.match(lines[span[0]], /^### IN-44 —/);
  // `end` is exclusive and lands ON the next heading (any level) — here `### IN-45`.
  assert.match(lines[span[1]], /^### IN-45 —/);
});

test("I4: detailBlockSpan of the file's last block ends at lines.length", () => {
  const lines = FIXTURE_TAIL.split("\n");
  const span = detailBlockSpan(lines, "IN-50");
  assert.match(lines[span[0]], /^### IN-50 —/);
  assert.equal(span[1], lines.length);
});

// ─── I5 — deleteRow ──────────────────────────────────────────────────────────

test("I5: deleteRow('IN-35') drops the row but PRESERVES the shared block (IN-40 still needs it)", () => {
  const out = deleteRow(FIXTURE, "IN-35");
  assert.doesNotMatch(out, /^\| IN-35 \|/m);
  assert.match(out, /### IN-35 \+ IN-40 —/);
});

test("I5: deleteRow('IN-44') drops row AND its block, without eating `### IN-45` or the final `## §2`", () => {
  const out = deleteRow(FIXTURE, "IN-44");
  assert.doesNotMatch(out, /^\| IN-44 \|/m);
  assert.doesNotMatch(out, /### IN-44 —/);
  assert.match(out, /### IN-45 —/);
  assert.match(out, /## §2 — Seção final/);
});

test("I5: deleteRow throws on an id that has no row", () => {
  assert.throws(() => deleteRow(FIXTURE, "IN-99"));
});

// ─── I6 — degenerate input never throws ──────────────────────────────────────

test("I6: parseIntake tolerates empty, null, table-less, and detail-less input → empty/partial, never throws", () => {
  assert.deepEqual(parseIntake("").rows, []);
  assert.deepEqual(parseIntake(null).rows, []);
  assert.deepEqual(parseIntake("# Just markdown\n\nNo table at all.\n").rows, []);
  // Table present, no Detalhamento section: rows parse, details empty.
  const noDetail = "| IN | Data · Fonte | Tipo | Resumo | Situação | Aterrissou em |\n|---|---|---|---|---|---|\n| IN-01 | 2026-07-01 · x | bug | r | New | — |\n";
  const parsed = parseIntake(noDetail);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.details, {});
});

test("I6: parseDetails ignores a `###` heading that names no id", () => {
  const details = parseDetails("# Detalhamento técnico\n\n### Sem nenhum id aqui\n\ncorpo\n");
  assert.deepEqual(details, {});
});

test("I6: readIntake tolerates an empty list and a non-existent file → empty rows, never throws", () => {
  assert.deepEqual(readIntake([]).rows, []);
  assert.deepEqual(readIntake([{ file: "/caminho/que/nao/existe.md" }]).rows, []);
});

// ─── citedIds — compressed citation runs, suffix collapse ────────────────────

test("citedIds expands a compressed run and collapses letter suffixes onto their row", () => {
  // A sub-part suffix (IN-40a / IN-40b) is stripped: both denote the single
  // intake row IN-40, so the letter must collapse away.
  assert.deepEqual(citedIds("IN-33/35/38/40a"), ["IN-33", "IN-35", "IN-38", "IN-40"]);
  assert.deepEqual(citedIds("IN-35b/40b"), ["IN-35", "IN-40"]);
  assert.deepEqual(citedIds("IN-39/40a/48"), ["IN-39", "IN-40", "IN-48"]);
});

test("citedIds returns [] for prose with no requirement citation", () => {
  assert.deepEqual(citedIds("2026-07-11"), []); // date, no A-Z prefix
  assert.deepEqual(citedIds("commit f8e801e"), []); // git sha, no id
});

// ─── buildChain — intake id → backlog ids that cite it ───────────────────────

test("buildChain maps IN-40 to both citing PRD rows in PRD order, and an uncited id to []", () => {
  const prdRows = [
    { id: "C3", porque: "vem de IN-33/35/38/40a conforme a reunião" },
    { id: "C7", porque: "cobre IN-39/40a/48 do backlog" },
  ];
  const intakeIds = ["IN-33", "IN-35", "IN-38", "IN-39", "IN-40", "IN-44", "IN-48"];
  const chain = buildChain(prdRows, intakeIds);
  assert.deepEqual(chain["IN-40"], ["C3", "C7"]);
  assert.deepEqual(chain["IN-44"], []); // cited by nobody
});

// ─── Ordering — date desc, then id number desc ───────────────────────────────

test("ordering: rows come out by date desc, then by id number desc within a date", () => {
  const { rows } = parseIntake(FIXTURE, { prefix: "IN" });
  // Dates: IN-31=07-03, IN-40=07-01, IN-35=07-01, IN-44=06-30.
  // Same-date 07-01 tie breaks by number desc → IN-40 before IN-35.
  assert.deepEqual(
    rows.map((r) => r.id),
    ["IN-31", "IN-40", "IN-35", "IN-44"],
  );
});

// ─── Prefix filter — foreign-project rows are ignored ────────────────────────

test("prefix: parseIntake({prefix:'IN'}) drops a `| CIDS-01 |` row from the same file", () => {
  const { rows } = parseIntake(FIXTURE, { prefix: "IN" });
  assert.ok(!rows.some((r) => r.id === "CIDS-01"));
  assert.ok(rows.every((r) => r.id.startsWith("IN-")));
});

/**
 * Tests for the factory Intake importer.
 *
 *   node --test "scripts/factory/*.test.mjs"
 *
 * Two layers:
 *   1. `parseBacklogTables` / `normalizeSituacao` / `buildCard` — pure, exercised
 *      against a fixture markdown string covering every Situação edge cell, the
 *      C5-first ordering inside Body C, and non-feature tables to be skipped.
 *   2. the shell — driven through a real child process against a tmp repo that
 *      has its own `backlog init`, asserting card creation + idempotence.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildCard, normalizeSituacao, parseBacklogTables } from "./board-import-backlog.mjs";
import { parseLabels, parseTaskList } from "./board-sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const IMPORTER = path.join(HERE, "board-import-backlog.mjs");
const BIN = path.join(REPO_ROOT, "node_modules", ".bin", "backlog");

const STATUSES = "Intake, Planning, Building, Validating, Needs Human, Done, Blocked";

// ─── Fixture doc ────────────────────────────────────────────────────────────
// Mirrors the real docs/prd/nexus-build-backlog.md shape: 4 body tables sharing
// the same header, C5 listed FIRST in Body C, plus two non-feature tables
// ("Onde o fix vive", "Plano de waves") with different headers that must be
// skipped. Covers every Situação normalization edge case from the spec.

const FIXTURE_DOC = `# Fixture backlog

## Legenda

- **Situação** — todo · planning · building · validating · done.

## Body A — foo *(risco baixo)*

| ID | Recurso | Porquê / fonte | Prova | Risco | Situação |
|----|---------|--------------|-------|------|--------|
| A1 | **Timer da janela** — desc | motivo A1 | pw | low | parcial — label feito (overlay); falta desabilitar o composer |
| A2 | **Telefone do contato** — desc | motivo A2 | pw | low | **done** (crm-inbox + overlay) |
| A3 | **Glyphs de status** — desc | motivo A3 | pw | low | building (em progresso) |
| A4 | **Auto-scroll** — desc | motivo A4 | pw | low | verificar (o smoke glue sugere done) |
| A5 | **Relabel preview** \`[mídia]\` — desc | motivo A5 | pw | low | todo (Phase 3) |

## Body B — bar

| ID | Recurso | Porquê / fonte | Prova | Risco | Situação |
|----|---------|--------------|-------|------|--------|
| B1 | **Dashboard** — desc | motivo B1 | pw | low | todo |
| B2 | **Lead 360** — desc | motivo B2 | pw | low | validating (em curso) |
| B3 | **Sidebar** — desc | motivo B3 | pw | low | planning (definindo) |
| B4 | **Drag-persist** — desc | motivo B4 | pw | low | mistério total |

## Onde o fix vive — divisão de repos

| ID | \`wahub\` (BFF / backend) | Lovable (telas) |
|----|--------------------------|--------------------|
| A1 | expõe algo | renderiza algo |

## Body C — baz

| ID | Recurso | Porquê / fonte | Prova | Risco | Situação |
|----|---------|--------------|-------|------|--------|
| C5 | **Gold eval** — desc | motivo C5 | eval | high | **done (baseline RED)** — mesclado via sdr-gold-evals |
| C1 | **Faqs** — desc | motivo C1 | eval | high | todo |
| C2 | **\`disqualifiers[]\` estruturados** — desc | motivo C2 | eval | high | todo |
| C3 | **NonLeadIntents** — desc | motivo C3 | eval | high | todo |
| C4 | **Glossario** — desc | motivo C4 | gate | med | todo |
| C6 | **Ligar bot** — desc | motivo C6 | eval | high | todo |

## Body D — qux

| ID | Recurso | Porquê / fonte | Prova | Risco | Situação |
|----|---------|--------------|-------|------|--------|
| D1 | **Revisão mineração** — desc | motivo D1 | pw | med | todo |
| D2 | **Classificação** — desc | motivo D2 | pw | med | todo |
| D3 | **Contagens import** — desc | motivo D3 | pw | low | todo |

## Plano de waves (ordem de execução)

| Wave | Bodies | Racional | Paralelismo |
|------|--------|-----------|-------------|
| 0 | docs | x | y |
`;

// ─── parseBacklogTables / normalizeSituacao / buildCard (pure) ────────────────

test("parseBacklogTables extracts 18 rows keyed by ID, C5 first in Body C, non-feature tables skipped", () => {
  const rows = parseBacklogTables(FIXTURE_DOC);
  assert.equal(rows.length, 18);
  assert.deepEqual(
    rows.map((r) => r.id),
    [
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "B1",
      "B2",
      "B3",
      "B4",
      "C5",
      "C1",
      "C2",
      "C3",
      "C4",
      "C6",
      "D1",
      "D2",
      "D3",
    ],
  );
});

test("normalizeSituacao maps every leading-token edge case and never throws", () => {
  assert.deepEqual(normalizeSituacao("**done** (crm-inbox + overlay)"), {
    status: "Done",
    needsVerify: false,
  });
  assert.deepEqual(normalizeSituacao("todo (Phase 3)"), { status: "Intake", needsVerify: false });
  assert.deepEqual(normalizeSituacao("building (em progresso)"), {
    status: "Building",
    needsVerify: false,
  });
  assert.deepEqual(normalizeSituacao("validating (em curso)"), {
    status: "Validating",
    needsVerify: false,
  });
  assert.deepEqual(normalizeSituacao("planning (definindo)"), {
    status: "Planning",
    needsVerify: false,
  });
  assert.deepEqual(
    normalizeSituacao("parcial — label feito (overlay); falta desabilitar o composer"),
    { status: "Intake", needsVerify: true },
  );
  assert.deepEqual(normalizeSituacao("verificar (o smoke glue sugere done)"), {
    status: "Intake",
    needsVerify: true,
  });
  assert.deepEqual(normalizeSituacao("mistério total"), { status: "Intake", needsVerify: true });
  assert.deepEqual(normalizeSituacao("**done (baseline RED)** — mesclado via sdr-gold-evals"), {
    status: "Done",
    needsVerify: false,
  });
});

test("buildCard titles '<ID> — <bold recurso name>' with ** stripped", () => {
  const row = {
    id: "A2",
    recurso: "**Telefone do contato na sidebar** — renderizar o telefone",
    porque: "x",
    prova: "pw",
    risco: "low",
    situacao: "**done** (crm-inbox + overlay)",
  };
  const card = buildCard(row);
  assert.equal(card.title, "A2 — Telefone do contato na sidebar");
  assert.equal(card.status, "Done");
  assert.deepEqual(card.labels.sort(), ["body:A", "risk:low"]);
});

test("buildCard adds needs-verify label when normalization flags it", () => {
  const row = {
    id: "A1",
    recurso: "**Timer** — x",
    porque: "x",
    prova: "pw",
    risco: "low",
    situacao: "parcial — falta algo",
  };
  const card = buildCard(row);
  assert.deepEqual(card.labels.sort(), ["body:A", "needs-verify", "risk:low"]);
  assert.equal(card.status, "Intake");
});

test("buildCard keys the body label off the ID letter and risk off Risco", () => {
  const row = {
    id: "C4",
    recurso: "**Glossário** — x",
    porque: "x",
    prova: "gate",
    risco: "med",
    situacao: "todo",
  };
  const card = buildCard(row);
  assert.deepEqual(card.labels.sort(), ["body:C", "risk:med"]);
});

// ─── Shell (CLI) integration ────────────────────────────────────────────────

function initRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "board-import-"));
  const r = spawnSync(
    BIN,
    ["init", "test-board", "--defaults", "--agent-instructions", "none", "--no-git"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(r.status, 0, `backlog init failed: ${r.stderr}${r.stdout}`);
  const cfg = path.join(repo, "backlog", "config.yml");
  let text = readFileSync(cfg, "utf8");
  text = text.replace(
    /^statuses:.*$/m,
    `statuses: [${STATUSES.split(", ")
      .map((s) => `"${s}"`)
      .join(", ")}]`,
  );
  text = text.replace(/^default_status:.*$/m, 'default_status: "Intake"');
  writeFileSync(cfg, text);
  return repo;
}

function runImporter(repo, docPath, extra = []) {
  return spawnSync(process.execPath, [IMPORTER, "--doc", docPath, "--repo", repo, ...extra], {
    encoding: "utf8",
  });
}

function backlog(repo, args) {
  return spawnSync(BIN, args, { cwd: repo, encoding: "utf8" });
}

function cards(repo) {
  return parseTaskList(backlog(repo, ["task", "list", "--plain"]).stdout);
}

function cardByTitle(repo, title) {
  return cards(repo).find((c) => c.title === title);
}

test("import creates 18 cards from the fixture doc, spot-checked statuses + labels", () => {
  const repo = initRepo();
  const docPath = path.join(repo, "fixture-backlog.md");
  writeFileSync(docPath, FIXTURE_DOC);
  try {
    const r = runImporter(repo, docPath);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(cards(repo).length, 18);

    // A2 -> Done
    assert.equal(cardByTitle(repo, "A2 — Telefone do contato")?.status, "Done");
    // B1 -> Intake
    assert.equal(cardByTitle(repo, "B1 — Dashboard")?.status, "Intake");
    // A1 -> Intake + needs-verify
    const a1 = cardByTitle(repo, "A1 — Timer da janela");
    assert.equal(a1?.status, "Intake");
    const a1Labels = parseLabels(backlog(repo, ["task", a1.id, "--plain"]).stdout);
    assert.ok(a1Labels.includes("needs-verify"), `expected needs-verify, got ${a1Labels}`);
    assert.ok(a1Labels.includes("body:A"));
    assert.ok(a1Labels.includes("risk:low"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * A `BACKLOG_BIN` stub that forwards every call to the real `backlog` binary
 * (via `REAL_BACKLOG_BIN`) except `task list`, which it fails — simulating a
 * transient backlog CLI failure (F2/D-24/D-25: a check that cannot fail must
 * never report success).
 */
function makeFailingListStub() {
  const stubDir = mkdtempSync(path.join(tmpdir(), "backlog-stub-"));
  const stub = path.join(stubDir, "backlog-stub.mjs");
  writeFileSync(
    stub,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const REAL = process.env.REAL_BACKLOG_BIN;
const args = process.argv.slice(2);
if (args[0] === "task" && args[1] === "list") {
  process.stderr.write("stub: task list failure\\n");
  process.exit(1);
}
const r = spawnSync(REAL, args, { encoding: "utf8" });
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
process.exit(r.status ?? 1);
`,
  );
  chmodSync(stub, 0o755);
  return { stubDir, stub };
}

test("import aborts (non-zero exit) and creates ZERO cards when `task list` fails (F2)", () => {
  const repo = initRepo();
  const docPath = path.join(repo, "fixture-backlog.md");
  writeFileSync(docPath, FIXTURE_DOC);
  const { stubDir, stub } = makeFailingListStub();
  try {
    const r = spawnSync(
      process.execPath,
      [IMPORTER, "--doc", docPath, "--repo", repo],
      { encoding: "utf8", env: { ...process.env, BACKLOG_BIN: stub, REAL_BACKLOG_BIN: BIN } },
    );
    assert.notEqual(r.status, 0, `import should exit non-zero: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(cards(repo).length, 0, "no card should be created after a failed task list");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test("import is idempotent: a clean second run creates zero new cards", () => {
  const repo = initRepo();
  const docPath = path.join(repo, "fixture-backlog.md");
  writeFileSync(docPath, FIXTURE_DOC);
  try {
    const r1 = runImporter(repo, docPath);
    assert.equal(r1.status, 0, r1.stderr);
    const before = cards(repo).length;
    const r2 = runImporter(repo, docPath);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(cards(repo).length, before);
    assert.match(r2.stdout, /0 created/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

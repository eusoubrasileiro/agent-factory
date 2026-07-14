/**
 * Tests for the factory board autopublish funnel.
 *
 *   node --test "scripts/factory/board-autopublish.test.mjs"
 *
 * Three layers:
 *   1. Pure core — stripTimestampLines, contentHash, buildRsyncCommand:
 *      exercised directly. The hash guard's timestamp-insensitivity is proven
 *      here as a unit (and again end-to-end via two consecutive CLI runs).
 *   2. CLI integration — driven through a real child process against tmp
 *      fixtures with a minimal PRD + projects.json manifest: dry-run offline,
 *      hash-guard idempotence, history snapshots on state change, missing
 *      projects.json soft-fail.
 *   3. Source-level A3 invariant — the funnel never emits git write commands.
 *
 * House style mirrors board-sync.test.mjs / board-publish.test.mjs: mkdtempSync
 * fixtures, rmSync finally, spawnSync(CLI, ...).
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildRsyncCommand,
  contentHash,
  formatPublishLogLine,
  stripHistoryPanel,
  stripTimestampLines,
} from "./board-autopublish.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "board-autopublish.mjs");
const SOURCE = readFileSync(CLI, "utf8");

// ─── Pure core ───────────────────────────────────────────────────────────────

test("stripTimestampLines removes every line containing 'gerado em'", () => {
  const html = [
    "<html>",
    "<footer>gerado em 2026-07-08T10:00:00Z · board-report</footer>",
    "<p>outro gerado em qualquer lugar</p>",
    "</html>",
  ].join("\n");
  const stripped = stripTimestampLines(html);
  assert.ok(!stripped.includes("gerado em"), `still has gerado em: ${stripped}`);
  assert.ok(stripped.includes("<html>"));
  assert.ok(stripped.includes("</html>"));
});

test("stripTimestampLines removes root-index card lines ('última atualização <iso>')", () => {
  // Feature 03: the root index emits a per-project "última atualização" line
  // mirroring the dashboard generatedAt — volatile per-render, must not move
  // the hash. See board-autopublish.mjs unmet_knowledge (W2) for the pattern.
  const html = [
    '<a class="project-card" href="/wahub/">',
    '  <span class="card-name">WaHub</span>',
    '  <span class="card-updated">última atualização 2026-07-08T10:00:00Z</span>',
    "</a>",
  ].join("\n");
  const stripped = stripTimestampLines(html);
  assert.ok(!stripped.includes("última atualização"), `still has última atualização: ${stripped}`);
  assert.ok(stripped.includes("card-name"), "non-timestamp content preserved");
});

test("contentHash is deterministic for identical input", () => {
  const htmls = ["<html>\n<body>alpha</body>\n</html>"];
  assert.equal(contentHash(htmls), contentHash(htmls));
});

test("contentHash changes when real content changes", () => {
  const a = ["<html>\n<body>alpha</body>\n</html>"];
  const b = ["<html>\n<body>beta</body>\n</html>"];
  assert.notEqual(contentHash(a), contentHash(b));
});

test("contentHash is order-stable across multiple concatenated files", () => {
  const one = contentHash(["<a/>", "<b/>"]);
  const two = contentHash(["<a/><b/>".slice(0, 4), "<b/>"]);
  // Concatenation is the join of the array; identical joined bytes → same hash.
  assert.equal(one, contentHash(["<a/>", "<b/>"]));
});

// ─── stripHistoryPanel (feature 04 — hash-guard stability) ────────────────────

test("stripHistoryPanel removes the <!--hist-start-->…<!--hist-end--> block", () => {
  const html = [
    "<html>",
    "<!--hist-start-->",
    '<section id="tab-historico">histórico data</section>',
    "<!--hist-end-->",
    "</html>",
  ].join("\n");
  const stripped = stripHistoryPanel(html);
  assert.ok(!stripped.includes("hist-start"), "hist-start marker removed");
  assert.ok(!stripped.includes("histórico data"), "history content removed");
  assert.ok(stripped.includes("<html>"), "non-history content preserved");
});

test("stripHistoryPanel removes the <script id='history'> tag", () => {
  const html = [
    '<script type="application/json" id="history">{"missõesConcluídas":3}</script>',
    "<body>dashboard</body>",
  ].join("\n");
  const stripped = stripHistoryPanel(html);
  assert.ok(!stripped.includes('id="history"'), "history script tag removed");
  assert.ok(!stripped.includes("missõesConcluídas"), "history data removed");
  assert.ok(stripped.includes("dashboard"), "non-history content preserved");
});

test("Histórico content changes do NOT affect contentHash (hash-guard stability)", () => {
  // Two HTML documents identical except for the Histórico tab content.
  // The hash must be the same — history is a lagging indicator and must not
  // trigger republish loops (feature 04 invariant d).
  const htmlA = [
    "<html><body>",
    "<!--hist-start-->",
    '<section id="tab-historico">missões concluídas: 1</section>',
    "<!--hist-end-->",
    '<script type="application/json" id="history">{"missõesConcluídas":1}</script>',
    "</body></html>",
  ].join("\n");
  const htmlB = [
    "<html><body>",
    "<!--hist-start-->",
    '<section id="tab-historico">missões concluídas: 5</section>',
    "<!--hist-end-->",
    '<script type="application/json" id="history">{"missõesConcluídas":5}</script>',
    "</body></html>",
  ].join("\n");
  assert.equal(
    contentHash([htmlA]),
    contentHash([htmlB]),
    "history-only diff must hash identically",
  );
});

// ─── Hash guard: timestamp-insensitivity (spec test 3) ──────────────────────

test("'gerado em' timestamp difference alone does NOT change the hash", () => {
  const a = ["<html>\n<footer>gerado em 2026-07-08T10:00:00Z</footer>\n</html>"];
  const b = ["<html>\n<footer>gerado em 2026-07-09T12:34:56Z</footer>\n</html>"];
  assert.equal(contentHash(a), contentHash(b), "timestamp-only differences must hash identically");
});

test("a real content difference (not timestamp) DOES change the hash", () => {
  const a = ["<html>\n<footer>gerado em 2026-07-08T10:00:00Z</footer>\n<body>A</body>\n</html>"];
  const b = ["<html>\n<footer>gerado em 2026-07-08T10:00:00Z</footer>\n<body>B</body>\n</html>"];
  assert.notEqual(contentHash(a), contentHash(b));
});

// ─── buildRsyncCommand ───────────────────────────────────────────────────────

test("buildRsyncCommand prints the canonical public/ target with --delete", () => {
  const cmd = buildRsyncCommand({
    host: "deploy-host",
    remoteDir: "/opt/app/factory/public/",
    distDir: "dist/factory-board/",
  });
  assert.match(cmd, /rsync -az --delete/);
  assert.match(cmd, /deploy-host:\/opt\/amiticia\/factory\/public\//);
});

test("buildRsyncCommand respects host + remoteDir overrides", () => {
  const cmd = buildRsyncCommand({
    host: "testhost",
    remoteDir: "/tmp/alt/",
    distDir: "dist/factory-board/",
  });
  assert.match(cmd, /testhost:\/tmp\/alt\//);
  assert.doesNotMatch(cmd, /deploy-host/);
});

// ─── formatPublishLogLine ────────────────────────────────────────────────────

test("formatPublishLogLine produces a single [ts] message line", () => {
  const line = formatPublishLogLine("sem mudanças", "2026-07-08T10:00:00Z");
  assert.match(line, /^\[2026-07-08T10:00:00Z\] sem mudanças\n$/);
});

// ─── Source-level A3 invariant (spec test 5) ────────────────────────────────

test("A3 invariant: source has no git write command strings (commit/add/push/merge)", () => {
  // The funnel is git-write-free (contract A3). Read-only git inside the
  // child board-report.mjs (branch listing) is fine; this assertion only
  // guards THIS file from ever gaining a write command.
  assert.doesNotMatch(SOURCE, /git\s+commit/);
  assert.doesNotMatch(SOURCE, /git\s+add/);
  assert.doesNotMatch(SOURCE, /git\s+push/);
  assert.doesNotMatch(SOURCE, /git\s+merge/);
});

// ─── CLI integration helpers ─────────────────────────────────────────────────

/** One PRD data row matching the shared feature-body header. */
const HEADER = "| ID | Recurso | Porquê / fonte | Prova | Risco | Situação |";
const SEPARATOR = "| --- | --- | --- | --- | --- | --- |";

function makeFixtureRoot(prefix = "autopublish-") {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  // Minimal PRD with one body row.
  mkdirSync(path.join(root, "docs", "prd"), { recursive: true });
  writeFileSync(
    path.join(root, "docs", "prd", "nexus-build-backlog.md"),
    [
      "# backlog",
      "",
      HEADER,
      SEPARATOR,
      "| A1 | **alpha** | porquê | prova | low | todo |",
      "",
    ].join("\n"),
  );
  // Empty missions dir.
  mkdirSync(path.join(root, "missions", "wahub"), { recursive: true });
  // Manifest: just wahub.
  mkdirSync(path.join(root, "deploy"), { recursive: true });
  writeFileSync(
    path.join(root, "deploy", "projects.json"),
    JSON.stringify([
      {
        id: "wahub",
        name: "Nexus CRM / WaHub",
        repo: ".",
        prd: "docs/prd/nexus-build-backlog.md",
      },
    ]),
  );
  return root;
}

function runCli(root, args = []) {
  return spawnSync(process.execPath, [CLI, "--repo", root, ...args], {
    encoding: "utf8",
  });
}

/** Async (non-blocking) CLI run — for genuinely racing two invocations at once. */
function runCliAsync(root, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "--repo", root, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function readMaybe(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function makeMission(root, slug, files = {}) {
  const dir = path.join(root, "missions", "wahub", slug);
  mkdirSync(dir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, contents);
  }
  return dir;
}

// ─── CLI: dry-run (spec test 1) ──────────────────────────────────────────────

test("dry-run: exit 0 offline, prints rsync target deploy-host:/opt/app/factory/public/", () => {
  const root = makeFixtureRoot("autopublish-dry-");
  try {
    const r = runCli(root, ["--dry-run"]);
    assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /deploy-host:\/opt\/amiticia\/factory\/public\//);
    // Dry-run must NOT execute rsync — only echo.
    assert.match(r.stdout, /rsync -az --delete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run: no hash memo written (so a later real run still publishes)", () => {
  const root = makeFixtureRoot("autopublish-dry-nomemo-");
  try {
    runCli(root, ["--dry-run"]);
    assert.equal(
      existsSync(path.join(root, "dist", "factory-board", ".hash")),
      false,
      "dry-run must not persist the hash memo",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run: no history snapshots appended", () => {
  const root = makeFixtureRoot("autopublish-dry-nohist-");
  makeMission(root, "demo", { "brief.md": "**Requirements:** A1\n" });
  try {
    runCli(root, ["--dry-run"]);
    assert.equal(
      existsSync(path.join(root, "history.jsonl")),
      false,
      "dry-run must not append history",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── CLI: no projects at all (spec test 4) ───────────────────────────────────
// E4-b: the project list now comes from loadProjects() (profiles + deploy manifest);
// a fixture with neither projects/ nor deploy/projects.json → nothing to publish.

test("no projects found: exit 0 and exactly one publish.log line", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autopublish-nomanifest-"));
  try {
    const r = runCli(root);
    assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    const logPath = path.join(root, ".publish.log");
    assert.ok(existsSync(logPath), "publish.log should be created");
    const log = readFileSync(logPath, "utf8");
    const lines = log.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, `expected exactly one log line, got: ${log}`);
    assert.match(log, /nenhum projeto|nada a publicar|projects\.json/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── CLI: hash guard idempotence (spec test 2) ──────────────────────────────

test("hash guard: second run on identical state logs 'sem mudanças', history unchanged", () => {
  const root = makeFixtureRoot("autopublish-hashguard-");
  makeMission(root, "demo", { "brief.md": "**Requirements:** A1\n" });
  try {
    const r1 = runCli(root);
    assert.equal(r1.status, 0, `run 1 exit 0; stderr=${r1.stderr}`);
    const historyAfter1 = readMaybe(path.join(root, "history.jsonl"));
    assert.ok(historyAfter1 && historyAfter1.trim().length > 0, "history should have rows");

    const r2 = runCli(root);
    assert.equal(r2.status, 0, `run 2 exit 0; stderr=${r2.stderr}`);
    const log = readFileSync(path.join(root, ".publish.log"), "utf8");
    assert.match(log, /sem mudanças/);

    const historyAfter2 = readMaybe(path.join(root, "history.jsonl"));
    assert.equal(historyAfter2, historyAfter1, "history must not change on identical state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hash guard: touching a marker file triggers new snapshot rows", () => {
  const root = makeFixtureRoot("autopublish-hashchange-");
  const dir = makeMission(root, "demo", { "brief.md": "**Requirements:** A1\n" });
  try {
    runCli(root);
    const historyBefore = readMaybe(path.join(root, "history.jsonl")) ?? "";

    // State change: APPROVED marker flips Planning → Building.
    writeFileSync(path.join(dir, "APPROVED"), "");

    const r = runCli(root);
    assert.equal(r.status, 0, `exit 0; stderr=${r.stderr}`);

    const historyAfter = readMaybe(path.join(root, "history.jsonl")) ?? "";
    assert.ok(
      historyAfter.length > historyBefore.length,
      "new snapshot rows should be appended after a state change",
    );

    // The latest snapshot for `demo` should now carry the Building state.
    const demoRows = historyAfter
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .filter((r) => r.slug === "demo");
    const last = demoRows[demoRows.length - 1];
    assert.ok(last, "at least one demo snapshot expected");
    assert.equal(last.state, "Building");
    assert.equal(last.project, "wahub");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history snapshot row shape matches plan.md ({ts,project,slug,state,features,rounds,verdict,reqIds})", () => {
  const root = makeFixtureRoot("autopublish-shape-");
  makeMission(root, "demo", {
    "brief.md": "**Requirements:** A1\n",
    APPROVED: "",
    "features/01.md": "x",
    "features/01.handoff.md": "x",
    "features/02.md": "x",
    "validate.log":
      JSON.stringify({
        slug: "demo",
        round: 1,
        verdict: "FAIL",
        assertions: [{ id: "A1", status: "red", proof: "x" }],
        escalate: false,
      }) + "\n",
  });
  try {
    runCli(root);
    const history = readFileSync(path.join(root, "history.jsonl"), "utf8");
    const row = JSON.parse(history.trim().split("\n").pop());
    assert.equal(row.project, "wahub");
    assert.equal(row.slug, "demo");
    assert.equal(row.state, "Validating"); // APPROVED + every spec has a handoff
    assert.equal(row.features, "1/2"); // handoffs/specs
    assert.equal(row.rounds, 1);
    assert.equal(row.verdict, "FAIL");
    assert.deepEqual(row.reqIds, ["A1"]);
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── CLI: soft-fail always exits 0 in binding context ───────────────────────

test("soft-fail: --strict flips a render error to exit 1; default exits 0", () => {
  const root = makeFixtureRoot("autopublish-strict-");
  // Sabotage the PRD path so board-report fails: manifest points at a missing file.
  const manifestPath = path.join(root, "deploy", "projects.json");
  writeFileSync(
    manifestPath,
    JSON.stringify([
      {
        id: "wahub",
        name: "Nexus CRM / WaHub",
        repo: ".",
        prd: "docs/prd/DOES-NOT-EXIST.md",
      },
    ]),
  );
  try {
    const rSoft = runCli(root);
    assert.equal(rSoft.status, 0, `default soft-fail exit 0; stderr=${rSoft.stderr}`);

    const rStrict = runCli(root, ["--strict"]);
    assert.equal(rStrict.status, 1, `--strict should surface the error; stderr=${rStrict.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── CLI: root index + /scrumban/ redirect (feature 03, contract A5) ─────────
//
// The funnel now also emits `dist/factory-board/index.html` (root project index:
// one card per manifest entry) and `dist/factory-board/scrumban/index.html`
// (meta-refresh redirect → /wahub/). Both are written on EVERY run, including
// --dry-run (they're part of the render step, before the hash guard).

test("root index: dry-run writes dist/factory-board/index.html with one card per project", () => {
  const root = makeFixtureRoot("autopublish-rootindex-");
  try {
    runCli(root, ["--dry-run"]);
    const rootIndex = path.join(root, "dist", "factory-board", "index.html");
    assert.ok(existsSync(rootIndex), "root index.html written");
    const html = readFileSync(rootIndex, "utf8");
    assert.match(html, /<!doctype html>/i);
    // The manifest has one entry (wahub) → the card surfaces by name + links to /wahub/.
    assert.match(html, /Nexus CRM \/ WaHub/);
    assert.match(html, /href="\/wahub\/"/);
    assert.match(html, /gerado em/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root index: missões em voo count reflects fixture mission states", () => {
  const root = makeFixtureRoot("autopublish-rootinflight-");
  // Two missions: one Planning (in flight), one RATIFIED (Done, NOT in flight).
  makeMission(root, "planning-m", { "brief.md": "# x\n" });
  makeMission(root, "done-m", { RATIFIED: "" });
  try {
    runCli(root, ["--dry-run"]);
    const html = readFileSync(path.join(root, "dist", "factory-board", "index.html"), "utf8");
    // 1 mission in flight (planning-m); done-m is excluded from the count.
    assert.match(html, /1\s+missão em voo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scrumban redirect: dry-run writes dist/factory-board/scrumban/index.html → the root index", () => {
  const root = makeFixtureRoot("autopublish-redirect-");
  try {
    runCli(root, ["--dry-run"]);
    const redirect = path.join(root, "dist", "factory-board", "scrumban", "index.html");
    assert.ok(existsSync(redirect), "scrumban redirect written");
    const html = readFileSync(redirect, "utf8");
    assert.match(html, /<!doctype html>/i);
    // The legacy single-board URL lands on the root index, which lists every
    // project. It names no product — see the ordering test below for why.
    assert.match(html, /<meta\s+http-equiv="refresh"\s+content="0;\s*url=\/"/i);
    assert.match(html, /movido para/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression pin. The redirect used to point at `cards[0]` — "the first project
// in the manifest". With one project that reads as "the product this board was
// built for"; with two it silently becomes "whichever id sorts first", and
// adding the `factory` dogfood profile pointed the legacy URL at the engine's
// own board. A redirect target must never depend on alphabetical luck, so the
// target must be `/` no matter what the manifest holds or which order it holds it in.
test("scrumban redirect: target is the root index regardless of manifest contents or order", () => {
  const root = makeFixtureRoot("autopublish-redirect-generic-");
  try {
    writeFileSync(
      path.join(root, "deploy", "projects.json"),
      JSON.stringify([
        { id: "agendazap", name: "AgendaZap", repo: ".", prd: "docs/prd/nexus-build-backlog.md" },
        { id: "wahub", name: "WaHub", repo: ".", prd: "docs/prd/nexus-build-backlog.md" },
      ]),
    );
    mkdirSync(path.join(root, "missions", "agendazap"), { recursive: true });
    runCli(root, ["--dry-run"]);
    const html = readFileSync(
      path.join(root, "dist", "factory-board", "scrumban", "index.html"),
      "utf8",
    );
    assert.match(html, /<meta\s+http-equiv="refresh"\s+content="0;\s*url=\/"/i);
    // Neither manifest entry may steal the legacy URL, whatever the ordering.
    assert.doesNotMatch(html, /url=\/agendazap\//, "first manifest entry must not claim the redirect");
    assert.doesNotMatch(html, /url=\/wahub\//, "no product literal leaks from the engine");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root index: hash includes the root HTML — a content change to the root index triggers republish", () => {
  // First render to seed the hash memo.
  const root = makeFixtureRoot("autopublish-hashroot-");
  makeMission(root, "alpha", { "brief.md": "# x\n" });
  try {
    const r1 = runCli(root);
    assert.equal(r1.status, 0);
    const hash1 = readFileSync(path.join(root, "dist", "factory-board", ".hash"), "utf8").trim();

    // Second run: identical state → sem mudanças, same hash.
    const r2 = runCli(root);
    assert.equal(r2.status, 0);
    const log = readFileSync(path.join(root, ".publish.log"), "utf8");
    assert.match(log, /sem mudanças/);
    const hash2 = readFileSync(path.join(root, "dist", "factory-board", ".hash"), "utf8").trim();
    assert.equal(hash1, hash2, "identical state hashes identically (root index included)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root index: self-contained — zero external http(s) resource loads", () => {
  const root = makeFixtureRoot("autopublish-rootselfcontained-");
  try {
    runCli(root, ["--dry-run"]);
    const rootHtml = readFileSync(path.join(root, "dist", "factory-board", "index.html"), "utf8");
    assert.doesNotMatch(rootHtml, /src=["']https?:/i);
    assert.doesNotMatch(rootHtml, /href=["']https?:/i);
    const redirectHtml = readFileSync(
      path.join(root, "dist", "factory-board", "scrumban", "index.html"),
      "utf8",
    );
    assert.doesNotMatch(redirectHtml, /src=["']https?:/i);
    assert.doesNotMatch(redirectHtml, /href=["']https?:/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Client status page (M5 — client-view) ───────────────────────────────────
//
// The funnel renders the published client page ONLY when a project declares an
// `intake[]` source with a parseable `client-labels.json` beside it. No labels ⇒
// no cliente/ dir (fail-closed). The page shows curated labels, NEVER the intake
// gist — verified here by seeding a leaky gist and asserting it never arrives.

test("stripTimestampLines removes the client-page 'atualizado em' footer line", () => {
  // The cliente footer regenerates its timestamp every render; it must be stripped
  // so an identical re-render does not move the hash (republish loop).
  const html = [
    "<body>",
    '    atualizado em <time datetime="2026-07-14T10:00:00Z">14/07/2026 10:00</time>',
    "</body>",
  ].join("\n");
  const stripped = stripTimestampLines(html);
  assert.ok(!stripped.includes("atualizado em"), "atualizado em line must be stripped");
  assert.ok(!stripped.includes("14/07/2026 10:00"), "the volatile timestamp must be stripped");
  assert.ok(stripped.includes("<body>"), "non-timestamp content preserved");
});

/** A fixture project that declares an `intake[]` source beside a labels file. */
function makeClienteFixture({ withLabels }) {
  const root = mkdtempSync(path.join(tmpdir(), "autopublish-cliente-"));
  // Minimal PRD (one backlog row) so the project dashboard still renders.
  mkdirSync(path.join(root, "docs", "prd"), { recursive: true });
  writeFileSync(
    path.join(root, "docs", "prd", "nexus-build-backlog.md"),
    ["# backlog", "", HEADER, SEPARATOR, "| A1 | **alpha** | porquê | prova | low | todo |", ""].join("\n"),
  );
  mkdirSync(path.join(root, "missions", "wahub"), { recursive: true });
  // Profile declaring intake → a client intake log (labels live beside it).
  mkdirSync(path.join(root, "projects", "wahub"), { recursive: true });
  writeFileSync(
    path.join(root, "projects", "wahub", "project.json"),
    JSON.stringify({
      id: "wahub",
      name: "Nexus CRM / WaHub",
      path: ".",
      prd: "docs/prd/nexus-build-backlog.md",
      intake: [{ file: "clients/tenant-a/requirements-intake.md", prefix: "IN", label: "cliente" }],
    }),
  );
  // The intake log. The GIST is deliberately leaky engineering prose — it must
  // never reach the cliente page; only the curated label may.
  mkdirSync(path.join(root, "clients", "tenant-a"), { recursive: true });
  writeFileSync(
    path.join(root, "clients", "tenant-a", "requirements-intake.md"),
    [
      "# requirements",
      "",
      "| ID | Data · Fonte | Tipo | Gist | Situação | Landed in |",
      "| --- | --- | --- | --- | --- | --- |",
      "| IN-1 | 2026-07-12 · cliente | feature | via webhook.ts:12 no glm, R$ 900, 2M tok | Landed |  |",
      "",
    ].join("\n"),
  );
  if (withLabels) {
    writeFileSync(
      path.join(root, "clients", "tenant-a", "client-labels.json"),
      JSON.stringify({
        "IN-1": { label: "Importar contatos de uma planilha", client_visible: true },
      }),
    );
  }
  return root;
}

test("cliente page (E2): labels present → page written, leaky gist never reaches it", () => {
  const root = makeClienteFixture({ withLabels: true });
  try {
    const r = runCli(root, ["--dry-run"]);
    assert.equal(r.status, 0, `exit 0; stderr=${r.stderr}`);
    const page = path.join(root, "dist", "factory-board", "cliente", "index.html");
    assert.ok(existsSync(page), "cliente page written when labels are present");
    const html = readFileSync(page, "utf8");
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /O que estamos construindo/);
    // The curated label renders; its status is the PT word, not the lifecycle.
    assert.match(html, /Importar contatos de uma planilha/);
    assert.match(html, /no ar/);
    assert.doesNotMatch(html, /<script/i);
    // The leaky intake gist must NEVER appear — the page is label-only.
    assert.doesNotMatch(html, /webhook\.ts/);
    assert.doesNotMatch(html, /\bglm\b/i);
    assert.doesNotMatch(html, /R\$/);
    assert.doesNotMatch(html, /\btok\b/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cliente page (E2): labels absent → no cliente/ dir (fail-closed)", () => {
  const root = makeClienteFixture({ withLabels: false });
  try {
    const r = runCli(root, ["--dry-run"]);
    assert.equal(r.status, 0, `exit 0; stderr=${r.stderr}`);
    assert.equal(
      existsSync(path.join(root, "dist", "factory-board", "cliente")),
      false,
      "no cliente/ dir must be created when labels are absent",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cliente page: two runs on identical state hash the same (timestamp stripped)", () => {
  // generatedAt differs between the two runs; only the timestamp strip keeps
  // the hash stable. A failure here means the cliente footer would loop-publish.
  const root = makeClienteFixture({ withLabels: true });
  try {
    const r1 = runCli(root);
    assert.equal(r1.status, 0, `run1 exit 0; stderr=${r1.stderr}`);
    const hash1 = readFileSync(path.join(root, "dist", "factory-board", ".hash"), "utf8").trim();

    const r2 = runCli(root);
    assert.equal(r2.status, 0, `run2 exit 0; stderr=${r2.stderr}`);
    const log = readFileSync(path.join(root, ".publish.log"), "utf8");
    assert.match(log, /sem mudanças/);
    const hash2 = readFileSync(path.join(root, "dist", "factory-board", ".hash"), "utf8").trim();
    assert.equal(hash1, hash2, "identical state must hash identically (cliente timestamp stripped)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Publish guard: a fixture root must never touch the live board ──────────
//
// Regression for a live incident (2026-07-09): `board-publish.sh` runs
// `rsync -az --delete <repoRoot>/dist/factory-board/ deploy-host:<public>/`, and
// the tests above drive this CLI with a temp `--repo` root, several of them
// without `--dry-run`. Each such run published its own fixture over production —
// `factory.example.com` was found serving a board with one requirement `A1` and
// one mission `alpha`. `FACTORY_AUTOPUBLISH=0` did not help: that guard lives in
// the CALLERS (verdict/ratify), never in the thing that actually rsyncs.

test("publish guard: a non-factory repoRoot renders + memoizes but never rsyncs", () => {
  const root = makeFixtureRoot("autopublish-guard-fixture-");
  makeMission(root, "demo", { "brief.md": "**Requirements:** A1\n" });
  try {
    const r = runCli(root);
    assert.equal(r.status, 0, `exit 0; stderr=${r.stderr}`);

    const log = readFileSync(path.join(root, ".publish.log"), "utf8");
    assert.match(log, /rsync ignorado: repoRoot não é a fábrica real/);
    assert.doesNotMatch(log, /^\[.*\] publicado/m, "a fixture root must never log a publish");

    // The memo IS written for a fixture root: the hash-guard idempotence tests
    // depend on a second run no-opping, and a temp dir can never describe the VPS.
    assert.ok(
      existsSync(path.join(root, "dist", "factory-board", ".hash")),
      "fixture root keeps its own hash memo",
    );

    // Second run still no-ops, exactly as before the guard.
    runCli(root);
    assert.match(readFileSync(path.join(root, ".publish.log"), "utf8"), /sem mudanças/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Source-level invariants (house style: see autopublish-guard.test.mjs). The
// FACTORY_AUTOPUBLISH=0 branch and the rsync-status branch both run against the
// REAL factory root, so exercising them here would rewrite the real dist and
// append to the real history.jsonl. Asserting on source text is the honest,
// cheap proof that the code paths exist and are ordered correctly.
test("publish guard: source pins the rsync preconditions and the status check", () => {
  const src = readFileSync(CLI, "utf8");

  assert.match(src, /const isFactoryRoot = path\.resolve\(repoRoot\) === ROOT;/);
  assert.match(src, /process\.env\.FACTORY_AUTOPUBLISH === "0"/);
  assert.match(src, /if \(skipReason\)/);

  // The rsync's exit status decides whether we memoize. A failed publish must
  // leave the memo alone so the next run retries, instead of freezing the board.
  assert.match(src, /published = !r\.error && r\.status === 0;/);
  const failIdx = src.indexOf("rsync falhou");
  const memoIdx = src.indexOf("writeFileSync(memoPath, hash);", failIdx);
  assert.ok(failIdx > 0 && memoIdx > failIdx, "the failure branch returns before the memo write");
});

// ─── Lock: serialize the render+publish+append critical section (F4/D-24/D-25) ─
//
// Every state change fires autopublish twice (verdict/ratify's explicit
// triggerAutopublish() plus the post-commit hook). Both triggers are kept —
// the redundancy is deliberate — but two concurrent funnels racing the same
// repoRoot could both pass the (pre-fix) hash guard and double-append
// history.jsonl snapshots. An advisory `dist/factory-board/.lock` (O_EXCL)
// serializes the critical section; a lock older than 120s is treated as
// abandoned (a crashed prior run) and reclaimed.

test("lock: a live (fresh) lock file makes the run back off — no render side effects (F4)", () => {
  const root = makeFixtureRoot("autopublish-lock-live-");
  makeMission(root, "demo", { "brief.md": "**Requirements:** A1\n" });
  const lockDir = path.join(root, "dist", "factory-board");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, ".lock");
  writeFileSync(lockPath, "");
  try {
    const r = runCli(root);
    assert.equal(r.status, 0, `exit 0; stderr=${r.stderr}`);
    assert.equal(
      existsSync(path.join(root, "history.jsonl")),
      false,
      "a backed-off run must not append history",
    );
    assert.equal(
      existsSync(path.join(lockDir, ".hash")),
      false,
      "a backed-off run must not write the hash memo",
    );
    assert.ok(existsSync(lockPath), "the other holder's live lock must be left alone");
    const log = readFileSync(path.join(root, ".publish.log"), "utf8");
    assert.match(log, /lock/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock: a stale (>120s) lock file is reclaimed and the run proceeds normally (F4)", () => {
  const root = makeFixtureRoot("autopublish-lock-stale-");
  makeMission(root, "demo", { "brief.md": "**Requirements:** A1\n" });
  const lockDir = path.join(root, "dist", "factory-board");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, ".lock");
  writeFileSync(lockPath, "");
  const old = new Date(Date.now() - 130_000);
  utimesSync(lockPath, old, old);
  try {
    const r = runCli(root);
    assert.equal(r.status, 0, `exit 0; stderr=${r.stderr}`);
    assert.ok(
      existsSync(path.join(root, "history.jsonl")),
      "a stale lock must be reclaimed and the run must publish normally",
    );
    assert.equal(existsSync(lockPath), false, "the lock is released after a successful run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock: two concurrent autopublish runs append exactly ONE history snapshot set (F4)", async () => {
  const root = makeFixtureRoot("autopublish-lock-race-");
  makeMission(root, "demo", { "brief.md": "**Requirements:** A1\n" });
  try {
    const [r1, r2] = await Promise.all([runCliAsync(root), runCliAsync(root)]);
    assert.equal(r1.status, 0, `run1 exit 0: ${r1.stderr}`);
    assert.equal(r2.status, 0, `run2 exit 0: ${r2.stderr}`);
    const history = readMaybe(path.join(root, "history.jsonl")) ?? "";
    const rows = history
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .filter((row) => row.slug === "demo");
    assert.equal(
      rows.length,
      1,
      `expected exactly one demo snapshot row, got ${rows.length}: ${JSON.stringify(rows)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

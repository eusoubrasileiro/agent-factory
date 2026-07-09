/**
 * Tests for the factory PR projector (factory-pr-record W4).
 *
 *   node --test "scripts/*.test.mjs"
 *
 * Two layers:
 *   1. Pure helpers (parse/format) imported directly — no IO, no gh.
 *   2. CLI (`open` / `comment` / `finalize`) through a real child process
 *      against a temp mission dir, with `gh` faked by a stub executable
 *      prepended to PATH. The stub records every invocation so we can assert
 *      what was (or was NOT) spawned.
 *
 * Soft-fail is the whole contract: a missing gh, a nonzero gh, or FACTORY_PR=0
 * must NEVER change the exit code (always 0) and must never crash the caller.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCommentBody,
  buildOpenBody,
  countContractAssertions,
  firstBriefSection,
  latestVerdict,
  parseBriefTitle,
  parsePrNumber,
  parseRepoSlug,
  renderStatsTable,
} from "./pr-record.mjs";

const CLI = fileURLToPath(new URL("./pr-record.mjs", import.meta.url));
const SLUG = "demo-mission";

// ─── Pure helpers ─────────────────────────────────────────────────────────────

test("parsePrNumber: extracts the number from a PR URL", () => {
  assert.equal(parsePrNumber("https://github.com/AmiticIA-AutoSys/wahub/pull/42"), 42);
  assert.equal(parsePrNumber("https://github.com/o/r/pull/7\n"), 7);
});

test("parsePrNumber: returns null when no pull number present", () => {
  assert.equal(parsePrNumber("no url here"), null);
  assert.equal(parsePrNumber(""), null);
  assert.equal(parsePrNumber(null), null);
});

test("parseRepoSlug: handles ssh and https remote forms", () => {
  assert.equal(parseRepoSlug("git@github.com:AmiticIA-AutoSys/factory.git"), "AmiticIA-AutoSys/factory");
  assert.equal(parseRepoSlug("https://github.com/AmiticIA-AutoSys/factory.git"), "AmiticIA-AutoSys/factory");
  assert.equal(parseRepoSlug("https://github.com/o/r"), "o/r");
});

test("parseRepoSlug: returns null on a non-github url", () => {
  assert.equal(parseRepoSlug("https://gitlab.com/o/r.git"), null);
  assert.equal(parseRepoSlug(""), null);
  assert.equal(parseRepoSlug(null), null);
});

test("parseBriefTitle: reads the H1 text", () => {
  assert.equal(parseBriefTitle("# Mission Brief — demo\n\nbody\n"), "Mission Brief — demo");
  assert.equal(parseBriefTitle("no heading"), null);
  assert.equal(parseBriefTitle(null), null);
});

test("firstBriefSection: keeps title + first section, drops later sections", () => {
  const brief = "# T\n\n**Requirements:** none\n\n## Problem\nthe problem.\n\n## Why now\nlater.\n";
  const out = firstBriefSection(brief);
  assert.match(out, /# T/);
  assert.match(out, /## Problem/);
  assert.match(out, /the problem\./);
  assert.doesNotMatch(out, /Why now/);
  assert.doesNotMatch(out, /later\./);
});

test("firstBriefSection: total on null / no second section", () => {
  assert.equal(firstBriefSection(null), "");
  const only = "# T\n\nbody only, no h2\n";
  assert.match(firstBriefSection(only), /body only/);
});

test("countContractAssertions: counts data rows under ## Assertions (incl. GATE)", () => {
  const contract = `# Contract

## Assertions

| ID | Assertion | Proof |
|----|-----------|-------|
| A1 | thing one | run x |
| A2 | thing two | run y |
| GATE | gate all green | run each |

## Non-negotiable invariants
1. blah
`;
  assert.equal(countContractAssertions(contract), 3);
});

test("countContractAssertions: 0 when no assertions section / null", () => {
  assert.equal(countContractAssertions("# nope\n\nbody\n"), 0);
  assert.equal(countContractAssertions(null), 0);
});

test("latestVerdict: returns the last well-formed PASS/FAIL record", () => {
  const log =
    `${JSON.stringify({ slug: SLUG, round: 1, verdict: "FAIL", assertions: [], escalate: false })}\n` +
    "garbage line\n" +
    `${JSON.stringify({ slug: SLUG, round: 2, verdict: "PASS", assertions: [], escalate: false })}\n`;
  const v = latestVerdict(log);
  assert.equal(v.round, 2);
  assert.equal(v.verdict, "PASS");
});

test("latestVerdict: null on empty / no valid records", () => {
  assert.equal(latestVerdict(""), null);
  assert.equal(latestVerdict("not json\n"), null);
  assert.equal(latestVerdict(null), null);
});

test("renderStatsTable: renders a markdown table for a stats object", () => {
  const stats = {
    loc: { added: 120, deleted: 8, files: 4 },
    testsAdded: 6,
    rounds: 2,
    tokens: { total: 1336911 },
    models: { worker: "glm-5.2", validator: "claude" },
    baselineChanged: false,
  };
  const md = renderStatsTable(stats);
  assert.match(md, /\| *Métrica *\| *Valor *\|/);
  assert.match(md, /LOC/);
  assert.match(md, /\+120/);
  assert.match(md, /-8/);
  assert.match(md, /glm-5\.2/);
});

test("renderStatsTable: total on null → a 'sem stats' note (never crash)", () => {
  const md = renderStatsTable(null);
  assert.equal(typeof md, "string");
  assert.match(md, /sem stats/i);
});

test("buildCommentBody: carries the verdict JSON + failing assertion ids", () => {
  const verdict = {
    slug: SLUG,
    round: 2,
    verdict: "FAIL",
    assertions: [
      { id: "A1", status: "green", proof: "x" },
      { id: "A3", status: "red", proof: "y" },
    ],
    escalate: false,
  };
  const body = buildCommentBody(verdict);
  assert.match(body, /round 2/i);
  assert.match(body, /FAIL/);
  assert.match(body, /```json/);
  assert.match(body, /A3/);
});

test("buildCommentBody: PASS with all-green reports no failing assertions", () => {
  const verdict = {
    slug: SLUG,
    round: 1,
    verdict: "PASS",
    assertions: [{ id: "A1", status: "green", proof: "x" }],
    escalate: false,
  };
  const body = buildCommentBody(verdict);
  assert.match(body, /PASS/);
  assert.match(body, /nenhuma|none/i);
});

test("buildOpenBody: assembles brief section, dossier url, assertion count, verdict, stats", () => {
  const body = buildOpenBody({
    briefSection: "# T\n\n## Problem\nthe problem.\n",
    dossierUrl: "https://github.com/AmiticIA-AutoSys/factory/tree/main/missions/wahub/demo-mission",
    assertionCount: 7,
    verdict: { slug: SLUG, round: 1, verdict: "PASS", assertions: [], escalate: false },
    statsTable: "| Métrica | Valor |\n|---|---|\n| LOC | +1/-0 |\n",
  });
  assert.match(body, /the problem\./);
  assert.match(body, /missions\/wahub\/demo-mission/);
  assert.match(body, /7/);
  assert.match(body, /PASS/);
  assert.match(body, /LOC/);
});

// ─── CLI fixtures ─────────────────────────────────────────────────────────────

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "pr-record-test-"));
  const dir = path.join(root, SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "brief.md"), "# Mission Brief — demo\n\n## Problem\nthe problem.\n");
  writeFileSync(
    path.join(dir, "contract.md"),
    "## Assertions\n\n| ID | Assertion | Proof |\n|---|---|---|\n| A1 | one | x |\n| GATE | all green | y |\n",
  );
  writeFileSync(
    path.join(dir, "validate.log"),
    `${JSON.stringify({ slug: SLUG, round: 1, verdict: "PASS", assertions: [{ id: "A1", status: "green", proof: "x" }], escalate: false })}\n`,
  );
  return root;
}

/** Write an executable `gh` stub into `dir`. mode "ok" prints a PR URL; "fail" exits 1. */
function makeGhStub(dir, mode) {
  const log = path.join(dir, "gh-invocations.log");
  const body =
    mode === "fail"
      ? `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\necho "gh boom" >&2\nexit 1\n`
      : `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/AmiticIA-AutoSys/wahub/pull/42"; fi\nexit 0\n`;
  writeFileSync(path.join(dir, "gh"), body, { mode: 0o755 });
  return log;
}

/**
 * Run the pr-record CLI.
 *   opts.gh   — "ok" | "fail" | undefined(absent)
 *   opts.factoryPr — value for FACTORY_PR ("0" to inhibit); undefined → unset
 */
function runCli(args, root, opts = {}) {
  const env = { ...process.env };
  // Hermetic dossier-url: point FACTORY_ROOT at a non-repo tmp so no real git.
  env.FACTORY_ROOT = root;
  if (opts.factoryPr === undefined) delete env.FACTORY_PR;
  else env.FACTORY_PR = opts.factoryPr;

  let ghLog = null;
  if (opts.gh === "ok" || opts.gh === "fail") {
    const binDir = mkdtempSync(path.join(tmpdir(), "pr-record-bin-"));
    ghLog = makeGhStub(binDir, opts.gh);
    env.PATH = `${binDir}:${process.env.PATH}`;
    opts._binDir = binDir;
  } else {
    // gh absent: an empty dir on PATH (bash/git still needed by nothing critical).
    const emptyDir = mkdtempSync(path.join(tmpdir(), "pr-record-empty-"));
    env.PATH = emptyDir;
    opts._binDir = emptyDir;
  }

  const r = spawnSync(process.execPath, [CLI, ...args, "--dir", root, "--repo", root], {
    encoding: "utf8",
    env,
  });
  return { r, ghLog };
}

function marker(root) {
  const p = path.join(root, SLUG, "PR");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function prLog(root) {
  const p = path.join(root, SLUG, ".pr.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

// ─── open ─────────────────────────────────────────────────────────────────────

test("open: happy path parses the PR number, writes the marker, exits 0", () => {
  const root = makeRoot();
  const bins = [];
  try {
    const { r, ghLog } = runCli(["open", SLUG], root, { gh: "ok", factoryPr: "1" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, r.stderr);
    const m = marker(root);
    assert.ok(m, "PR marker written");
    assert.equal(m.number, 42);
    assert.match(m.url, /pull\/42/);
    // gh pr create was actually invoked.
    assert.match(readFileSync(ghLog, "utf8"), /pr create/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

test("open: targets an explicit --base trunk and the agent/<slug> head", () => {
  const root = makeRoot();
  const bins = [];
  try {
    const { r, ghLog } = runCli(["open", SLUG], root, { gh: "ok", factoryPr: "1" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, r.stderr);
    const inv = readFileSync(ghLog, "utf8");
    // Never rely on gh's default-branch inference for the base.
    assert.match(inv, /--base main/, "PR base is explicit");
    assert.match(inv, new RegExp(`--head agent/${SLUG}`), "PR head is the mission branch");
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

test("open: idempotent — an existing PR marker is returned, gh never re-spawned", () => {
  const root = makeRoot();
  const bins = [];
  try {
    // Pre-seed a marker.
    writeFileSync(path.join(root, SLUG, "PR"), JSON.stringify({ number: 9, url: "u/pull/9" }));
    const { r, ghLog } = runCli(["open", SLUG], root, { gh: "ok", factoryPr: "1" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(marker(root).number, 9, "marker unchanged");
    // gh must NOT have been invoked (no create).
    assert.equal(existsSync(ghLog), false, "gh never spawned on idempotent open");
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

test("open: SOFT-FAIL when gh is absent — returns null, appends .pr.log, exit 0, no marker", () => {
  const root = makeRoot();
  const bins = [];
  try {
    const { r } = runCli(["open", SLUG], root, { gh: undefined, factoryPr: "1" });
    bins.push();
    assert.equal(r.status, 0, `soft-fail must exit 0; stderr=${r.stderr}`);
    assert.equal(marker(root), null, "no marker when gh unavailable");
    assert.match(prLog(root), /gh/i, ".pr.log records the gh failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("open: SOFT-FAIL when gh exits nonzero — no marker, .pr.log appended, exit 0", () => {
  const root = makeRoot();
  const bins = [];
  try {
    const { r, ghLog } = runCli(["open", SLUG], root, { gh: "fail", factoryPr: "1" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, `soft-fail must exit 0; stderr=${r.stderr}`);
    assert.equal(marker(root), null, "no marker on nonzero gh");
    assert.match(prLog(root), /gh/i, ".pr.log records the nonzero gh");
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

test("open: DEFAULT-OFF — FACTORY_PR unset inhibits (projection is opt-in)", () => {
  const root = makeRoot();
  const bins = [];
  try {
    // The projection pushes `agent/<slug>` to the product remote. That is an
    // outward-facing action, so it must never arm itself implicitly: only an
    // explicit FACTORY_PR=1 enables it. Unset behaves exactly like "0".
    const { r, ghLog } = runCli(["open", SLUG], root, { gh: "ok", factoryPr: undefined });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(marker(root), null, "no marker when FACTORY_PR is unset");
    assert.equal(existsSync(ghLog), false, "gh never spawned when FACTORY_PR is unset");
    assert.equal(prLog(root), "", "no .pr.log when unset");
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

test("open: FACTORY_PR=0 inhibits entirely — gh never spawned, no marker, exit 0", () => {
  const root = makeRoot();
  const bins = [];
  try {
    const { r, ghLog } = runCli(["open", SLUG], root, { gh: "ok", factoryPr: "0" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(marker(root), null, "no marker when inhibited");
    assert.equal(existsSync(ghLog), false, "gh never spawned under FACTORY_PR=0");
    assert.equal(prLog(root), "", "no .pr.log when inhibited");
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

// ─── comment ────────────────────────────────────────────────────────────────

test("comment: with a PR marker posts a comment via gh, exit 0", () => {
  const root = makeRoot();
  const bins = [];
  try {
    writeFileSync(path.join(root, SLUG, "PR"), JSON.stringify({ number: 42, url: "u/pull/42" }));
    const { r, ghLog } = runCli(["comment", SLUG], root, { gh: "ok", factoryPr: "1" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(ghLog, "utf8"), /pr comment/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

test("comment: without a PR marker is a no-op — gh never spawned, exit 0", () => {
  const root = makeRoot();
  const bins = [];
  try {
    const { r, ghLog } = runCli(["comment", SLUG], root, { gh: "ok", factoryPr: "1" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(ghLog), false, "no gh without a marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

test("comment: FACTORY_PR=0 inhibits even with a marker present", () => {
  const root = makeRoot();
  const bins = [];
  try {
    writeFileSync(path.join(root, SLUG, "PR"), JSON.stringify({ number: 42, url: "u/pull/42" }));
    const { r, ghLog } = runCli(["comment", SLUG], root, { gh: "ok", factoryPr: "0" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(ghLog), false, "gh never spawned under FACTORY_PR=0");
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

// ─── finalize ───────────────────────────────────────────────────────────────

test("finalize: with a marker runs `gh pr ready`, exit 0", () => {
  const root = makeRoot();
  const bins = [];
  try {
    writeFileSync(path.join(root, SLUG, "PR"), JSON.stringify({ number: 42, url: "u/pull/42" }));
    const { r, ghLog } = runCli(["finalize", SLUG], root, { gh: "ok", factoryPr: "1" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(ghLog, "utf8"), /pr ready/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

test("finalize: without a marker is a no-op — gh never spawned, exit 0", () => {
  const root = makeRoot();
  const bins = [];
  try {
    const { r, ghLog } = runCli(["finalize", SLUG], root, { gh: "ok", factoryPr: "1" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(ghLog), false, "no gh without a marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

test("finalize: SOFT-FAIL when gh exits nonzero — exit 0, .pr.log appended", () => {
  const root = makeRoot();
  const bins = [];
  try {
    writeFileSync(path.join(root, SLUG, "PR"), JSON.stringify({ number: 42, url: "u/pull/42" }));
    const { r, ghLog } = runCli(["finalize", SLUG], root, { gh: "fail", factoryPr: "1" });
    bins.push(path.dirname(ghLog));
    assert.equal(r.status, 0, `soft-fail must exit 0; stderr=${r.stderr}`);
    assert.match(prLog(root), /gh/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const b of bins) rmSync(b, { recursive: true, force: true });
  }
});

// ─── usage ────────────────────────────────────────────────────────────────────

test("CLI: unknown subcommand exits 2 (usage)", () => {
  const root = makeRoot();
  try {
    const { r } = runCli(["frobnicate", SLUG], root, { gh: "ok", factoryPr: "1" });
    assert.equal(r.status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── exports ────────────────────────────────────────────────────────────────

test("exports: pure helpers are functions", () => {
  for (const fn of [
    parsePrNumber,
    parseRepoSlug,
    parseBriefTitle,
    firstBriefSection,
    countContractAssertions,
    latestVerdict,
    renderStatsTable,
    buildCommentBody,
    buildOpenBody,
  ]) {
    assert.equal(typeof fn, "function");
  }
});

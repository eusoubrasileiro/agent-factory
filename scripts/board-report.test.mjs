/**
 * Tests for the factory board-report — traceability model (feature 01) +
 * self-contained HTML renderer + thin CLI shell (feature 02).
 *
 *   node --test "scripts/factory/board-report.test.mjs"
 *
 * Layers:
 *   1. `parseRequirementsLine` — pure string→string[]|null over a brief.md body.
 *   2. `collectGitInfo` — read-only smoke against the real repo (no fixture).
 *   3. `buildTraceabilityModel` — pure model assembled from a tmp missions root,
 *      a tmp PRD doc, and an INJECTED `gitInfo` object (no real git needed).
 *   4. `renderDashboardHtml` — pure model → self-contained HTML string.
 *   5. CLI shell — spawnSync against a tmp fixture tree (writes a file, exit codes).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aggregateAgents,
  buildTraceabilityModel,
  collectGitInfo,
  parseRequirementsLine,
  renderDashboardHtml,
  renderInline,
  renderIntakeTab,
} from "./board-report.mjs";
import { deriveMissionState } from "./board-sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

// ─── Fixture helpers (same shape as board-sync.test.mjs) ──────────────────────

function makeTmpRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * Materialize one mission dir under `root` from a `{ file: contents }` map.
 * A value of "" writes an empty marker file; nested paths (features/01.md) are ok.
 */
function mkMission(root, name, files) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, contents);
  }
  return dir;
}

const jsonl = (...objs) => `${objs.map((o) => JSON.stringify(o)).join("\n")}\n`;
const verdict = (round, v) => ({ slug: "x", round, verdict: v, assertions: [], escalate: false });

/** Minimal PRD body-table doc with the shared feature-body header. */
function mkPrdDoc(rows) {
  const header =
    "| ID | Recurso | Porquê / fonte | Prova | Risco | Situação |\n|---|---|---|---|---|---|\n";
  const body = rows
    .map(
      (r) =>
        `| ${r.id} | **${r.recurso}** — desc | porquê | prova | ${r.risco} | ${r.situacao} |\n`,
    )
    .join("");
  return `# PRD fixture\n\n${header}${body}\n`;
}

function writePrd(root, rows) {
  const p = path.join(root, "prd.md");
  writeFileSync(p, mkPrdDoc(rows));
  return p;
}

// ─── parseRequirementsLine (pure) ─────────────────────────────────────────────

test("parseRequirementsLine: valid comma-separated list", () => {
  assert.deepEqual(parseRequirementsLine("**Requirements:** A1, B2, C3"), ["A1", "B2", "C3"]);
});

test("parseRequirementsLine: trims whitespace around tokens", () => {
  assert.deepEqual(parseRequirementsLine("**Requirements:**  A1 ,  B2 ,C3 "), ["A1", "B2", "C3"]);
});

test("parseRequirementsLine: `none` (any case) → empty array", () => {
  assert.deepEqual(parseRequirementsLine("**Requirements:** none"), []);
  assert.deepEqual(parseRequirementsLine("**Requirements:** NONE"), []);
  assert.deepEqual(parseRequirementsLine("**Requirements:** None"), []);
});

test("parseRequirementsLine: absent line → null", () => {
  assert.equal(parseRequirementsLine("# Brief\n\nNo requirements line here.\n"), null);
});

test("parseRequirementsLine: invalid tokens are skipped (never throw)", () => {
  // foo (no pattern), X9 (X not A-D), A (no digit), C-3 (hyphen), empty
  assert.deepEqual(parseRequirementsLine("**Requirements:** A1, foo, B2, X9, A, C-3, , D3"), [
    "A1",
    "B2",
    "D3",
  ]);
});

test("parseRequirementsLine: tolerates leading blockquote `>` and whitespace", () => {
  assert.deepEqual(parseRequirementsLine("> **Requirements:** A1, A2"), ["A1", "A2"]);
  assert.deepEqual(parseRequirementsLine("   > **Requirements:** A1"), ["A1"]);
});

test("parseRequirementsLine: case-insensitive key", () => {
  assert.deepEqual(parseRequirementsLine("**requirements:** A1"), ["A1"]);
  assert.deepEqual(parseRequirementsLine("**REQUIREMENTS:** A1"), ["A1"]);
});

test("parseRequirementsLine: picks the first matching line in a multi-line brief", () => {
  const md = "# Title\n\n**Requirements:** A1, A2\n\nLater text mentioning **Requirements:** B1\n";
  assert.deepEqual(parseRequirementsLine(md), ["A1", "A2"]);
});

// ─── Template ↔ parser contract (feature 04) ──────────────────────────────────
//
// `factory/templates/brief.md` carries the canonical `**Requirements:**` line
// directly under the heading, with a leading HTML comment explaining it feeds
// the dashboard join. If either side drifts (template stops emitting the line,
// parser stops recognizing it), the dashboard silently loses the join for every
// future mission. This block guards the contract.

test("template format: a fixture brief carrying the template line parses correctly", () => {
  // Mirrors factory/templates/brief.md verbatim (post-feature-04).
  const fromTemplate = `# Mission Brief — <slug>

<!-- Backlog IDs from docs/prd/nexus-build-backlog.md (e.g. A1, B2 — or "none"). Feeds the factory-dashboard traceability join at \`pnpm board:report\`. -->
**Requirements:** <A1, B2 — or "none">

> **Author: Andre** (the owner's seat).
`;
  // The placeholder value `<A1, B2 — or "none">` is not a valid id list, but
  // parseRequirementsLine MUST still recognize the line (returns [] after
  // filtering — present-but-unparseable, NOT null/absent).
  const parsed = parseRequirementsLine(fromTemplate);
  assert.ok(Array.isArray(parsed), "template Requirements line is recognized");
  assert.equal(parsed.length, 0, "placeholder tokens are filtered out, never crash");

  // A real brief filled from the template carries valid IDs in place of the
  // placeholder — the parser still finds them at the same position.
  const filled = fromTemplate.replace(
    '**Requirements:** <A1, B2 — or "none">',
    "**Requirements:** A1, A2, B1",
  );
  assert.deepEqual(parseRequirementsLine(filled), ["A1", "A2", "B1"]);

  // The `none` sentinel (template's other branch) returns [] too.
  const noneFilled = fromTemplate.replace(
    '**Requirements:** <A1, B2 — or "none">',
    "**Requirements:** none",
  );
  assert.deepEqual(parseRequirementsLine(noneFilled), []);
});

test("template format: the real factory/templates/brief.md on disk parses (smoke)", () => {
  const templatePath = path.join(REPO_ROOT, "factory", "templates", "brief.md");
  if (!existsSync(templatePath)) {
    test.skip.call(this, "template not present");
    return;
  }
  const md = readFileSync(templatePath, "utf8");
  const parsed = parseRequirementsLine(md);
  // Template carries the placeholder; parsed must be [] (recognized-but-empty),
  // never null (which would mean the line went missing from the template).
  assert.ok(Array.isArray(parsed), "real template carries a recognizable Requirements line");
  assert.equal(parsed.length, 0, "placeholder value filters to [] (not a real id list)");
});

// ─── buildTraceabilityModel — COLLISION GUARD ─────────────────────────────────

test("COLLISION GUARD: contract.md C1/C2 tokens never map when brief has no Requirements line", () => {
  const root = makeTmpRoot("board-report-collision-");
  try {
    const prd = writePrd(root, [
      { id: "C1", recurso: "c1-feat", risco: "high", situacao: "todo" },
      { id: "C2", recurso: "c2-feat", risco: "high", situacao: "todo" },
      { id: "A1", recurso: "a1-feat", risco: "low", situacao: "todo" },
    ]);
    const missionsDir = path.join(root, "missions");
    // Brief has NO Requirements line; contract.md mentions local C1/C2 acceptance IDs.
    mkMission(missionsDir, "role-funcionario", {
      "brief.md": "# Brief\n\nSome mission.\n",
      "contract.md": "| A4 | accepts C1 and C2 |\n\n- C1: thing\n- C2: other\n",
    });

    const model = buildTraceabilityModel({
      missionsDir,
      prdPath: prd,
      gitInfo: { branches: [] },
    });

    const m = model.missions.find((x) => x.slug === "role-funcionario");
    assert.equal(m.requirements, null);
    for (const row of model.requirements) {
      assert.equal(row.missionSlug, null, `row ${row.id} must not map`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── buildTraceabilityModel — mission statuses agree with deriveMissionState ──

test("model: brief-only fixture → Planning (matches deriveMissionState)", () => {
  const root = makeTmpRoot("board-report-planning-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    const dir = mkMission(missionsDir, "planning-m", { "brief.md": "# x\n" });

    const direct = deriveMissionState(dir);
    const model = buildTraceabilityModel({
      missionsDir,
      prdPath: prd,
      gitInfo: { branches: [] },
    });
    const m = model.missions.find((x) => x.slug === "planning-m");

    assert.equal(m.status, direct.status);
    assert.equal(m.status, "Planning");
    assert.equal(m.gateReason, direct.gateReason);
    assert.equal(m.gateReason, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model: validate.log last PASS → Needs Human + gate:ratify", () => {
  const root = makeTmpRoot("board-report-pass-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    const dir = mkMission(missionsDir, "pass-m", {
      "validate.log": jsonl(verdict(1, "FAIL"), verdict(2, "PASS")),
    });

    const direct = deriveMissionState(dir);
    const model = buildTraceabilityModel({
      missionsDir,
      prdPath: prd,
      gitInfo: { branches: [] },
    });
    const m = model.missions.find((x) => x.slug === "pass-m");

    assert.equal(m.status, direct.status);
    assert.equal(m.status, "Needs Human");
    assert.equal(m.gateReason, "gate:ratify");
    assert.deepEqual(m.lastVerdict, { verdict: "PASS", round: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model: RATIFIED marker → Done", () => {
  const root = makeTmpRoot("board-report-ratified-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    const dir = mkMission(missionsDir, "done-m", { RATIFIED: "" });

    const direct = deriveMissionState(dir);
    const model = buildTraceabilityModel({
      missionsDir,
      prdPath: prd,
      gitInfo: { branches: [] },
    });
    const m = model.missions.find((x) => x.slug === "done-m");

    assert.equal(m.status, direct.status);
    assert.equal(m.status, "Done");
    assert.equal(m.gateReason, null);
    assert.equal(m.lastVerdict, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── buildTraceabilityModel — branch join ────────────────────────────────────

test("branch join: matching branch attaches; orphan lands in orphanBranches; missing → null", () => {
  const root = makeTmpRoot("board-report-branch-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    mkMission(missionsDir, "wired", { "brief.md": "# x\n" });
    mkMission(missionsDir, "branchless", { "brief.md": "# x\n" });

    const gitInfo = {
      branches: [
        {
          name: "agent/wired",
          slug: "wired",
          merged: false,
          lastCommitISO: "2026-07-07T00:00:00+00:00",
        },
        {
          name: "agent/orphan-branch",
          slug: "orphan-branch",
          merged: true,
          lastCommitISO: "2026-07-06T00:00:00+00:00",
        },
      ],
    };

    const model = buildTraceabilityModel({ missionsDir, prdPath: prd, gitInfo });

    const wired = model.missions.find((x) => x.slug === "wired");
    const branchless = model.missions.find((x) => x.slug === "branchless");

    assert.deepEqual(wired.branch, {
      name: "agent/wired",
      slug: "wired",
      merged: false,
      lastCommitISO: "2026-07-07T00:00:00+00:00",
    });
    assert.equal(branchless.branch, null);

    assert.equal(model.orphanBranches.length, 1);
    assert.equal(model.orphanBranches[0].slug, "orphan-branch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── buildTraceabilityModel — requirement liveStatus ──────────────────────────

test("requirement liveStatus: mapped row inherits mission derived status", () => {
  const root = makeTmpRoot("board-report-live-");
  try {
    const prd = writePrd(root, [
      { id: "A1", recurso: "feat-a1", risco: "low", situacao: "todo" },
      { id: "B2", recurso: "feat-b2", risco: "low", situacao: "done" },
    ]);
    const missionsDir = path.join(root, "missions");
    // Mission is RATIFIED (Done) and claims A1.
    mkMission(missionsDir, "alpha", {
      "brief.md": "# Brief\n\n**Requirements:** A1\n",
      RATIFIED: "",
    });

    const model = buildTraceabilityModel({ missionsDir, prdPath: prd, gitInfo: { branches: [] } });

    const a1 = model.requirements.find((r) => r.id === "A1");
    const b2 = model.requirements.find((r) => r.id === "B2");

    assert.equal(a1.missionSlug, "alpha");
    assert.equal(a1.liveStatus, "Done");

    // Unmapped row falls back to normalizeSituacao of its PRD cell.
    assert.equal(b2.missionSlug, null);
    assert.equal(b2.liveStatus, "Done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requirement liveStatus: unmapped row falls back to normalizeSituacao", () => {
  const root = makeTmpRoot("board-report-fallback-");
  try {
    const prd = writePrd(root, [
      { id: "A1", recurso: "feat", risco: "low", situacao: "parcial — verify" },
    ]);
    const missionsDir = path.join(root, "missions");
    mkdirSync(missionsDir, { recursive: true });

    const model = buildTraceabilityModel({ missionsDir, prdPath: prd, gitInfo: { branches: [] } });

    const a1 = model.requirements.find((r) => r.id === "A1");
    assert.equal(a1.missionSlug, null);
    // normalizeSituacao("parcial — verify") → Intake
    assert.equal(a1.liveStatus, "Intake");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── buildTraceabilityModel — feature/handoff counts + lastVerdict shape ─────

test("model: features counts specs, handoffs counts *.handoff.md", () => {
  const root = makeTmpRoot("board-report-feat-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    mkMission(missionsDir, "m", {
      "brief.md": "# x\n",
      "features/01.md": "x",
      "features/02.md": "x",
      "features/02.handoff.md": "x",
      "features/03.handoff.md": "x",
    });

    const model = buildTraceabilityModel({ missionsDir, prdPath: prd, gitInfo: { branches: [] } });
    const m = model.missions.find((x) => x.slug === "m");

    assert.equal(m.features, 2);
    assert.equal(m.handoffs, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model: missing features/ → counts 0; missing validate.log → lastVerdict null", () => {
  const root = makeTmpRoot("board-report-nofeat-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    mkMission(missionsDir, "m", { "brief.md": "# x\n" });

    const model = buildTraceabilityModel({ missionsDir, prdPath: prd, gitInfo: { branches: [] } });
    const m = model.missions.find((x) => x.slug === "m");

    assert.equal(m.features, 0);
    assert.equal(m.handoffs, 0);
    assert.equal(m.lastVerdict, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model: tolerates brief-less mission (RESEARCH.md only) → requirements null, status Intake", () => {
  const root = makeTmpRoot("board-report-research-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    mkMission(missionsDir, "research-m", { "RESEARCH.md": "# research\n" });

    const model = buildTraceabilityModel({ missionsDir, prdPath: prd, gitInfo: { branches: [] } });
    const m = model.missions.find((x) => x.slug === "research-m");

    assert.equal(m.requirements, null);
    assert.equal(m.status, "Intake");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model: mission with Requirements line carries the parsed array", () => {
  const root = makeTmpRoot("board-report-reqs-");
  try {
    const prd = writePrd(root, [
      { id: "A1", recurso: "feat-a1", risco: "low", situacao: "todo" },
      { id: "A2", recurso: "feat-a2", risco: "low", situacao: "todo" },
    ]);
    const missionsDir = path.join(root, "missions");
    mkMission(missionsDir, "claiming", {
      "brief.md": "# Brief\n\n> **Requirements:** A1, A2\n",
    });

    const model = buildTraceabilityModel({ missionsDir, prdPath: prd, gitInfo: { branches: [] } });
    const m = model.missions.find((x) => x.slug === "claiming");

    assert.deepEqual(m.requirements, ["A1", "A2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model: generatedAt is a valid ISO string", () => {
  const root = makeTmpRoot("board-report-iso-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    mkdirSync(missionsDir, { recursive: true });

    const model = buildTraceabilityModel({ missionsDir, prdPath: prd, gitInfo: { branches: [] } });
    assert.ok(typeof model.generatedAt === "string");
    assert.ok(!Number.isNaN(Date.parse(model.generatedAt)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model: missing missions dir and missing PRD both degrade gracefully", () => {
  const root = makeTmpRoot("board-report-empty-");
  try {
    const model = buildTraceabilityModel({
      missionsDir: path.join(root, "does-not-exist"),
      prdPath: path.join(root, "no-prd.md"),
      gitInfo: { branches: [] },
    });
    assert.deepEqual(model.requirements, []);
    assert.deepEqual(model.missions, []);
    assert.deepEqual(model.orphanBranches, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model: PRD rows with no matching mission still surface in requirements[]", () => {
  const root = makeTmpRoot("board-report-unmapped-");
  try {
    const prd = writePrd(root, [
      { id: "A1", recurso: "feat-a1", risco: "low", situacao: "todo" },
      { id: "D3", recurso: "feat-d3", risco: "med", situacao: "building" },
    ]);
    const missionsDir = path.join(root, "missions");
    mkdirSync(missionsDir, { recursive: true });

    const model = buildTraceabilityModel({ missionsDir, prdPath: prd, gitInfo: { branches: [] } });

    assert.equal(model.requirements.length, 2);
    const ids = model.requirements.map((r) => r.id);
    assert.ok(ids.includes("A1"));
    assert.ok(ids.includes("D3"));
    // Live fallbacks come from normalizeSituacao of each row.
    const a1 = model.requirements.find((r) => r.id === "A1");
    const d3 = model.requirements.find((r) => r.id === "D3");
    assert.equal(a1.liveStatus, "Intake"); // todo → Intake
    assert.equal(d3.liveStatus, "Building"); // building → Building
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── collectGitInfo — read-only smoke against the real repo ───────────────────

test("collectGitInfo: smoke against the real repo returns well-shaped branches", () => {
  const info = collectGitInfo(REPO_ROOT);
  assert.ok(typeof info === "object" && info !== null);
  assert.ok(Array.isArray(info.branches));
  for (const b of info.branches) {
    assert.ok(b.name.startsWith("agent/"), `branch name ${b.name} should start with agent/`);
    assert.equal(typeof b.slug, "string");
    assert.ok(b.slug.length > 0);
    assert.equal(typeof b.merged, "boolean");
    // lastCommitISO is a parseable ISO date when present.
    if (b.lastCommitISO !== null) {
      assert.ok(!Number.isNaN(Date.parse(b.lastCommitISO)));
    }
  }
});

test("collectGitInfo: missing git / no agent branches → empty list (never throw)", () => {
  const tmp = makeTmpRoot("board-report-nogit-");
  try {
    const info = collectGitInfo(tmp);
    assert.deepEqual(info, { branches: [] });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── collectGitInfo: portability flags (feature 03, contract A7) ─────────────
//
// `collectGitInfo(repoRoot, { branchPrefix, trunk })` lets other factories join
// their mission branches under a non-`agent/` prefix off a non-`main` trunk.
// Defaults remain `agent/` + `main` — zero behavior change for wahub.

/** Initialize a tmp git repo with a first commit on `trunk`, then branch `<prefix><slug>`. */
function mkGitFixture(root, trunk, prefix, slug) {
  const g = (args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    return r;
  };
  g(["init", "-q", root]);
  g(["config", "user.email", "test@example.com"]);
  g(["config", "user.name", "Test"]);
  g(["config", "commit.gpgsign", "false"]);
  // Create the trunk branch and put one commit on it.
  g(["checkout", "-q", "-b", trunk]);
  writeFileSync(path.join(root, "README.md"), "# fixture\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "init"]);
  // Branch off the trunk using the prefix+slug name.
  g(["checkout", "-q", "-b", `${prefix}${slug}`]);
  return root;
}

test("collectGitInfo: --branch-prefix x/ + --trunk develop joins mission `foo` (contract A7)", () => {
  const root = makeTmpRoot("board-report-portable-");
  try {
    mkGitFixture(root, "develop", "x/", "foo");
    const info = collectGitInfo(root, { branchPrefix: "x/", trunk: "develop" });
    assert.equal(
      info.branches.length,
      1,
      `expected 1 branch, got ${JSON.stringify(info.branches)}`,
    );
    const b = info.branches[0];
    assert.equal(b.name, "x/foo");
    assert.equal(b.slug, "foo");
    // x/foo was branched off develop's HEAD → ancestor → merged true.
    assert.equal(b.merged, true);
    assert.ok(b.lastCommitISO !== null);
    assert.ok(!Number.isNaN(Date.parse(b.lastCommitISO)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectGitInfo: defaults (agent/ + main) ignore an x/ branch off develop", () => {
  const root = makeTmpRoot("board-report-defaults-");
  try {
    mkGitFixture(root, "develop", "x/", "foo");
    // No flags → defaults agent/ + main. x/foo doesn't match and there's no `main`.
    const info = collectGitInfo(root);
    assert.deepEqual(info.branches, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectGitInfo: options object is optional and defaults are nullish-safe", () => {
  const root = makeTmpRoot("board-report-noopts-");
  try {
    mkGitFixture(root, "main", "agent/", "wahub-thing");
    // Called with no second arg — defaults apply, agent/wahub-thing off main joins.
    const info = collectGitInfo(root);
    assert.equal(info.branches.length, 1);
    assert.equal(info.branches[0].slug, "wahub-thing");
    assert.equal(info.branches[0].merged, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectGitInfo: branchPrefix/trunk only affect filtering — trunk missing degrades to merged=false", () => {
  const root = makeTmpRoot("board-report-notrunk-");
  try {
    mkGitFixture(root, "develop", "x/", "foo");
    // Ask for x/ branches but a trunk that doesn't exist. The branch still
    // surfaces (prefix match), but `merged` is false (merge-base check fails).
    const info = collectGitInfo(root, { branchPrefix: "x/", trunk: "no-such-trunk" });
    assert.equal(info.branches.length, 1);
    assert.equal(info.branches[0].slug, "foo");
    assert.equal(info.branches[0].merged, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Guard: assert the public exports exist with the right arity (helps the next
// worker know what they can import without reading the implementation).
test("exports: parseRequirementsLine, collectGitInfo, buildTraceabilityModel are functions", () => {
  assert.equal(typeof parseRequirementsLine, "function");
  assert.equal(typeof collectGitInfo, "function");
  assert.equal(typeof buildTraceabilityModel, "function");
});

// Sanity: the real PRD's body tables parse (catches header drift early).
test("real PRD: nexus-build-backlog.md parses to a non-empty requirements list", () => {
  const prdPath = path.join(REPO_ROOT, "docs", "prd", "nexus-build-backlog.md");
  if (!existsSync(prdPath)) {
    test.skip.call(this, "PRD not present");
    return;
  }
  const model = buildTraceabilityModel({
    missionsDir: path.join(REPO_ROOT, "factory", "missions"),
    prdPath,
    gitInfo: { branches: [] },
  });
  assert.ok(
    model.requirements.length >= 10,
    `expected ≥10 PRD rows, got ${model.requirements.length}`,
  );
});

// ─── Renderer (feature 02) ────────────────────────────────────────────────────
//
// `renderDashboardHtml(model)` is a PURE function: model → self-contained HTML
// string. No disk, no network. The fixture model below is hand-rolled to exercise
// every UI assertion in the spec; we never depend on the real PRD here.

const EMPTY_MODEL = {
  generatedAt: "2026-07-07T00:00:00.000Z",
  requirements: [],
  missions: [],
  orphanBranches: [],
};

/** A fixture that exercises every UI element the spec calls out. */
function richModel() {
  return {
    generatedAt: "2026-07-07T12:34:56.000Z",
    requirements: [
      {
        id: "A1",
        recurso: "Inbox seguro P0",
        risco: "high",
        situacao: "done",
        missionSlug: "inbox-p0",
        liveStatus: "Done",
      },
      {
        id: "B2",
        recurso: "Sidebar polish",
        risco: "low",
        situacao: "todo",
        missionSlug: null,
        liveStatus: "Intake",
      },
      {
        id: "C5",
        recurso: "SDR gold evals",
        risco: "med",
        situacao: "building",
        missionSlug: "sdr-evals",
        liveStatus: "Building",
      },
    ],
    missions: [
      {
        slug: "inbox-p0",
        status: "Done",
        gateReason: null,
        requirements: ["A1"],
        features: 4,
        handoffs: 4,
        lastVerdict: { verdict: "PASS", round: 1 },
        branch: {
          name: "agent/inbox-p0",
          slug: "inbox-p0",
          merged: true,
          lastCommitISO: "2026-06-24T10:00:00+00:00",
        },
      },
      {
        slug: "sdr-evals",
        status: "Building",
        gateReason: null,
        requirements: ["C5"],
        features: 3,
        handoffs: 1,
        lastVerdict: null,
        branch: {
          name: "agent/sdr-evals",
          slug: "sdr-evals",
          merged: false,
          lastCommitISO: "2026-07-05T08:30:00+00:00",
        },
      },
      {
        slug: "needs-ratify",
        status: "Needs Human",
        gateReason: "gate:ratify",
        requirements: [],
        features: 2,
        handoffs: 2,
        lastVerdict: { verdict: "PASS", round: 2 },
        branch: null,
      },
    ],
    orphanBranches: [
      {
        name: "agent/stray",
        slug: "stray",
        merged: false,
        lastCommitISO: "2026-07-01T00:00:00+00:00",
      },
    ],
  };
}

test("renderDashboardHtml: is exported as a function", () => {
  assert.equal(typeof renderDashboardHtml, "function");
});

test("renderDashboardHtml: emits a complete <!doctype html> document with inline <style> and <script>", () => {
  const html = renderDashboardHtml(EMPTY_MODEL);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html[\s>]/i);
  assert.match(html, /<\/html>\s*$/);
  // ALL CSS in one inline <style> (no <link rel="stylesheet">).
  assert.match(html, /<style[\s>]/);
  assert.doesNotMatch(html, /<link\s+[^>]*rel=["']stylesheet["']/i);
  // At least one inline <script> (tab switching).
  assert.match(html, /<script\b[^>]*>/);
});

test("renderDashboardHtml: header title + tab bar (Requisitos default, Missões)", () => {
  const html = renderDashboardHtml(EMPTY_MODEL);
  assert.match(html, /Fábrica Nexus — rastreabilidade/);
  assert.match(html, /Requisitos/);
  assert.match(html, /Missões/);
  // Requisitos panel must NOT carry the `hidden` attribute (default tab).
  const reqPanel = html.match(/<section[^>]*id="tab-requisitos"[^>]*>/i);
  assert.ok(reqPanel, "Requisitos panel exists");
  assert.doesNotMatch(reqPanel[0], /\bhidden\b/i, "Requisitos is the default (not hidden)");
});

test("renderDashboardHtml: footer has 'gerado em' + generatedAt + 'board-report'", () => {
  const html = renderDashboardHtml(EMPTY_MODEL);
  assert.match(html, /gerado em/);
  assert.match(html, /2026-07-07T00:00:00\.000Z/);
  assert.match(html, /board-report/);
});

test("renderDashboardHtml: all requirement IDs surface; 'sem missão' for unmapped; mission slug links to its card", () => {
  const html = renderDashboardHtml(richModel());
  assert.match(html, /A1/);
  assert.match(html, /B2/);
  assert.match(html, /C5/);
  // Unmapped row shows the muted placeholder.
  assert.match(html, /sem missão/);
  // Mapped row links to the mission card via an in-page anchor.
  assert.match(html, /href="#mission-inbox-p0"/);
  assert.match(html, /href="#mission-sdr-evals"/);
});

test("renderDashboardHtml: mission slug appears inside its status lane; gateReason badge text present", () => {
  const html = renderDashboardHtml(richModel());
  // The mission with gate:ratify lives in the Needs Human lane.
  const laneStart = html.indexOf('data-status="Needs Human"');
  assert.ok(laneStart > -1, "Needs Human lane exists");
  const afterLane = html.slice(laneStart);
  assert.match(afterLane, /needs-ratify/);
  assert.match(afterLane, /gate:ratify/);
});

test('renderDashboardHtml: self-contained — no src="http", no href="http" (href="# allowed)', () => {
  const html = renderDashboardHtml(richModel());
  assert.doesNotMatch(html, /src=["']https?:/i);
  assert.doesNotMatch(html, /href=["']https?:/i);
  // In-page anchors are fine.
  assert.match(html, /href="#mission-/);
});

test("renderDashboardHtml: escapes interpolated text (& < > \" ')", () => {
  // Spec: escape `&<>"'`. The nasty string carries all five HTML-significant
  // characters; none may leak through unescaped.
  const nasty = `<b>&"'`;
  const model = {
    generatedAt: "2026-07-07T00:00:00.000Z",
    requirements: [
      {
        id: "A1",
        recurso: nasty,
        risco: nasty,
        situacao: nasty,
        missionSlug: null,
        liveStatus: "Intake",
      },
    ],
    missions: [],
    orphanBranches: [{ name: nasty, slug: nasty, merged: false, lastCommitISO: null }],
  };
  const html = renderDashboardHtml(model);
  // Raw payload must never leak through unescaped.
  assert.doesNotMatch(html, /<b>&"/);
  assert.doesNotMatch(html, /<b>&/);
  // Each of the five escaped entities must appear at least once.
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;/);
  assert.match(html, /&#0?39;|&apos;/);
});

test("renderDashboardHtml: orphan branches section ('branches sem missão') when present; absent when empty", () => {
  const withOrphans = renderDashboardHtml(richModel());
  assert.match(withOrphans, /branches sem missão/);
  assert.match(withOrphans, /agent\/stray/);

  const empty = renderDashboardHtml(EMPTY_MODEL);
  assert.doesNotMatch(empty, /branches sem missão/);
});

test("renderDashboardHtml: lane order respects Needs Human · Building · Validating · Planning · Intake · Done · Blocked", () => {
  const model = {
    generatedAt: "2026-07-07T00:00:00.000Z",
    requirements: [],
    missions: [
      {
        slug: "m-blocked",
        status: "Blocked",
        gateReason: null,
        requirements: [],
        features: 0,
        handoffs: 0,
        lastVerdict: null,
        branch: null,
      },
      {
        slug: "m-done",
        status: "Done",
        gateReason: null,
        requirements: [],
        features: 1,
        handoffs: 1,
        lastVerdict: null,
        branch: null,
      },
      {
        slug: "m-intake",
        status: "Intake",
        gateReason: null,
        requirements: [],
        features: 0,
        handoffs: 0,
        lastVerdict: null,
        branch: null,
      },
      {
        slug: "m-planning",
        status: "Planning",
        gateReason: null,
        requirements: [],
        features: 0,
        handoffs: 0,
        lastVerdict: null,
        branch: null,
      },
      {
        slug: "m-validating",
        status: "Validating",
        gateReason: null,
        requirements: [],
        features: 1,
        handoffs: 0,
        lastVerdict: null,
        branch: null,
      },
      {
        slug: "m-building",
        status: "Building",
        gateReason: null,
        requirements: [],
        features: 1,
        handoffs: 0,
        lastVerdict: null,
        branch: null,
      },
      {
        slug: "m-needs",
        status: "Needs Human",
        gateReason: "gate:ratify",
        requirements: [],
        features: 1,
        handoffs: 0,
        lastVerdict: { verdict: "PASS", round: 1 },
        branch: null,
      },
    ],
    orphanBranches: [],
  };
  const html = renderDashboardHtml(model);
  const idx = (slug) => html.indexOf(slug);
  const order = [
    idx("m-needs"),
    idx("m-building"),
    idx("m-validating"),
    idx("m-planning"),
    idx("m-intake"),
    idx("m-done"),
    idx("m-blocked"),
  ];
  for (const i of order) assert.ok(i > -1, "every status represented");
  // Strictly increasing positions ⇒ lanes are in the spec'd order.
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1] < order[i], `lane ${i - 1} before lane ${i}`);
  }
});

test("renderDashboardHtml: empty lanes are hidden (omitted from the document)", () => {
  const model = {
    generatedAt: "2026-07-07T00:00:00.000Z",
    requirements: [],
    missions: [
      {
        slug: "only-done",
        status: "Done",
        gateReason: null,
        requirements: [],
        features: 1,
        handoffs: 1,
        lastVerdict: null,
        branch: null,
      },
    ],
    orphanBranches: [],
  };
  const html = renderDashboardHtml(model);
  assert.match(html, /data-status="Done"/);
  assert.doesNotMatch(html, /data-status="Needs Human"/);
  assert.doesNotMatch(html, /data-status="Blocked"/);
});

test('renderDashboardHtml: model embedded as <script type="application/json" id="model"> (debugging)', () => {
  const html = renderDashboardHtml(richModel());
  const m = html.match(/<script type="application\/json" id="model">([\s\S]*?)<\/script>/);
  assert.ok(m, "model embedded");
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.generatedAt, "2026-07-07T12:34:56.000Z");
  assert.equal(parsed.requirements.length, 3);
  assert.equal(parsed.missions.length, 3);
});

test("renderDashboardHtml: handoffs/features progress renders as 'M/N' on the card", () => {
  const html = renderDashboardHtml(richModel());
  // inbox-p0 mission: 4 handoffs / 4 features.
  assert.match(html, /4\/4/);
  // sdr-evals mission: 1 handoff / 3 features.
  assert.match(html, /1\/3/);
});

test("renderDashboardHtml: branch info shows merged ('mergeado')/unmerged ('não mergeado') + DD/MM date", () => {
  const html = renderDashboardHtml(richModel());
  // inbox-p0 was merged on 2026-06-24 → "mergeado" + "24/06".
  assert.match(html, /mergeado/);
  assert.match(html, /24\/06/);
  // sdr-evals was NOT merged, last commit 2026-07-05.
  assert.match(html, /não mergeado/);
  assert.match(html, /05\/07/);
});

test("renderDashboardHtml: drill-down surfaces the last verdict (PASS/FAIL + round) when present", () => {
  const html = renderDashboardHtml(richModel());
  assert.match(html, /PASS/);
  assert.match(html, /rodada\s*2/i);
});

test("renderDashboardHtml: tolerates null branch / null requirements / null lastVerdict without throwing", () => {
  const model = {
    generatedAt: "2026-07-07T00:00:00.000Z",
    requirements: [],
    missions: [
      {
        slug: "bare",
        status: "Planning",
        gateReason: null,
        requirements: null,
        features: 0,
        handoffs: 0,
        lastVerdict: null,
        branch: null,
      },
    ],
    orphanBranches: [],
  };
  assert.doesNotThrow(() => renderDashboardHtml(model));
});

// ─── renderInline + recurso markdown bold (feature 05) ────────────────────────
//
// PRD `Recurso` cells ship markdown bold like `**Timer da janela WABA de 24h** —
// o BFF expõe ...`. `renderInline` turns paired `**...**` into `<strong>...</strong>`
// AFTER HTML-escaping, so the only tags introduced are the literal `<strong>` we
// emit — file content can never inject markup. Applied ONLY to `recurso`.

test("renderInline: is exported as a function", () => {
  assert.equal(typeof renderInline, "function");
});

test("renderInline: paired **Foo** bar → <strong>Foo</strong> bar", () => {
  assert.equal(renderInline("**Foo** bar"), "<strong>Foo</strong> bar");
});

test("renderInline: escapes angle/amp/quote FIRST, then bold (no XSS, no double-escape)", () => {
  // Spec: escape-before-bold ordering. `<` `>` `&` `"` must be escaped; the
  // paired `**x**` must still become `<strong>x</strong>`; the inserted tags
  // must NOT themselves be re-escaped.
  const out = renderInline('a <b> & "c" **x**');
  assert.equal(out, "a &lt;b&gt; &amp; &quot;c&quot; <strong>x</strong>");
});

test("renderInline: unpaired ** stays as plain text (no <strong>, no dangling tag, no throw)", () => {
  // Odd count of `**` — must not produce a dangling <strong> opener.
  let out;
  assert.doesNotThrow(() => {
    out = renderInline("**oops");
  });
  assert.ok(typeof out === "string");
  assert.doesNotMatch(out, /<strong>/i);
  assert.doesNotMatch(out, /<\/strong>/i);
  // The stray `**` stays as plain (escaped-or-not) text — never breaks markup.
  assert.ok(out.includes("**oops"), "the stray ** survives as plain text");
});

test("renderInline: empty / nullish → safe empty string (renderer hygiene)", () => {
  assert.equal(renderInline(""), "");
  assert.equal(renderInline(null), "");
  assert.equal(renderInline(undefined), "");
});

test("renderInline: multiple paired segments all convert", () => {
  assert.equal(renderInline("**a** and **b**"), "<strong>a</strong> and <strong>b</strong>");
});

test("renderDashboardHtml: recurso **Feature X** renders <strong> and NO literal **", () => {
  const model = {
    generatedAt: "2026-07-07T00:00:00.000Z",
    requirements: [
      {
        id: "A1",
        recurso: "**Feature X**",
        risco: "low",
        situacao: "todo",
        missionSlug: null,
        liveStatus: "Intake",
      },
    ],
    missions: [],
    orphanBranches: [],
  };
  const html = renderDashboardHtml(model);
  assert.match(html, /<strong>Feature X<\/strong>/);
  // The RENDERED html (the user-visible document, not the embedded debug
  // JSON payload) must contain no literal `**`. The `<script type="application/json"
  // id="model">` block legitimately carries the raw model for debugging, so we
  // scope this assertion to the rendered portion before it.
  const rendered = html.split('<script type="application/json" id="model">')[0];
  assert.ok(rendered.length > 0, "rendered portion split is non-empty");
  assert.doesNotMatch(rendered, /\*\*/);
});

test("renderDashboardHtml: inline bold only applies to recurso, NOT to ids/slugs/status", () => {
  // Mission slug `**weird**` must stay escaped (no markdown processing), so a
  // slug containing `**` is rendered as literal text, never as bold.
  const model = {
    generatedAt: "2026-07-07T00:00:00.000Z",
    requirements: [],
    missions: [
      {
        slug: "**weird**",
        status: "Planning",
        gateReason: null,
        requirements: [],
        features: 0,
        handoffs: 0,
        lastVerdict: null,
        branch: null,
      },
    ],
    orphanBranches: [],
  };
  const html = renderDashboardHtml(model);
  // The slug's `**` must NOT become <strong> — it must stay as escaped text.
  assert.doesNotMatch(html, /<strong>weird<\/strong>/);
  // In the RENDERED portion (excluding the debug JSON payload), the literal
  // escaped `**` survives — proving the slug got `esc()` only, never
  // `renderInline()`.
  const rendered = html.split('<script type="application/json" id="model">')[0];
  assert.ok(rendered.length > 0, "rendered portion split is non-empty");
  assert.match(rendered, /\*\*/);
});

// ─── CLI shell (feature 02) ───────────────────────────────────────────────────

const BOARD_REPORT_CLI = path.join(HERE, "board-report.mjs");

function runBoardCli(args) {
  return spawnSync(process.execPath, [BOARD_REPORT_CLI, ...args], { encoding: "utf8" });
}

test("CLI: writes HTML to --out (mkdir -p parent), prints summary line, exit 0", () => {
  const root = makeTmpRoot("board-report-cli-ok-");
  try {
    const prd = writePrd(root, [
      { id: "A1", recurso: "feat-a1", risco: "low", situacao: "todo" },
      { id: "B2", recurso: "feat-b2", risco: "med", situacao: "building" },
    ]);
    const missionsDir = path.join(root, "missions");
    mkMission(missionsDir, "claiming", { "brief.md": "# Brief\n\n**Requirements:** A1\n" });
    const out = path.join(root, "dist", "factory-board", "index.html");

    const r = runBoardCli(["--missions", missionsDir, "--prd", prd, "--out", out]);
    assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(existsSync(out), "HTML file written");

    const html = readFileSync(out, "utf8");
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /A1/);
    // Summary line shape: "board-report: N requisitos, M missões -> <out>"
    assert.match(r.stdout, /board-report:\s+2\s+requisitos,\s+1\s+miss[õo]es\s+->\s+\S+/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: default out path is dist/factory-board/index.html when --out omitted", () => {
  const root = makeTmpRoot("board-report-cli-default-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    mkdirSync(missionsDir, { recursive: true });
    // Run with CWD = root so the default `dist/factory-board/index.html`
    // resolves under the tmp tree (keeps the test hermetic).
    const r = spawnSync(
      process.execPath,
      [BOARD_REPORT_CLI, "--missions", missionsDir, "--prd", prd],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    const expected = path.join(root, "dist", "factory-board", "index.html");
    assert.ok(existsSync(expected), `default out written: ${expected}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: --missions-dir is accepted as an alias of --missions", () => {
  const root = makeTmpRoot("board-report-cli-alias-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    mkdirSync(missionsDir, { recursive: true });
    const out = path.join(root, "out.html");
    const r = runBoardCli(["--missions-dir", missionsDir, "--prd", prd, "--out", out]);
    assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(existsSync(out), "--missions-dir accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: missing PRD → exit 1 (prints error to stderr)", () => {
  const root = makeTmpRoot("board-report-cli-noprd-");
  try {
    const missionsDir = path.join(root, "missions");
    mkdirSync(missionsDir, { recursive: true });
    const r = runBoardCli([
      "--missions",
      missionsDir,
      "--prd",
      path.join(root, "does-not-exist.md"),
      "--out",
      path.join(root, "out.html"),
    ]);
    assert.equal(r.status, 1, `exit 1; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(!existsSync(path.join(root, "out.html")), "no file written on failure");
    assert.ok(r.stderr.length > 0, "error message on stderr");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Histórico tab (feature 04, contract A6) ──────────────────────────────────
//
// The dashboard now carries a third tab "Histórico" showing aggregated stats
// (missões concluídas, missões/semana, lead time mediano, rondas média, tokens,
// atenção-por-feature) and a per-mission table. Missing/empty history → "sem
// dados ainda". The tab is wrapped in <!--hist-start-->…<!--hist-end--> markers
// so the autopublish hash guard can strip it (history changes must NOT trigger
// republish).

test("Histórico: tab button 'Histórico' present in the nav", () => {
  const html = renderDashboardHtml(EMPTY_MODEL);
  assert.match(html, /data-tab="historico"/);
  assert.match(html, />Histórico</);
});

test("Histórico: no history → tab renders 'sem dados ainda' (contract A6, never crash)", () => {
  const html = renderDashboardHtml(EMPTY_MODEL);
  const histStart = html.indexOf("<!--hist-start-->");
  const histEnd = html.indexOf("<!--hist-end-->");
  assert.ok(histStart > -1, "hist-start marker present");
  assert.ok(histEnd > histStart, "hist-end marker after hist-start");
  const panel = html.slice(histStart, histEnd);
  assert.match(panel, /sem dados ainda/);
  assert.match(panel, /id="tab-historico"/);
  // The panel must be hidden by default (not the active tab).
  assert.match(panel, /\bhidden\b/);
});

test("Histórico: fixture history renders stat cards + per-mission table with computed values", () => {
  const history = {
    missõesConcluídas: 2,
    missõesPorSemana: 1.5,
    leadTimeMediano: 4,
    rondasMédia: 1.5,
    tokensTotal: 1700,
    atençãoPorFeature: 1.0,
    byProject: {},
    perMission: [
      {
        slug: "alpha",
        project: "wahub",
        estadoAtual: "Done",
        leadTime: 4,
        rondas: 2,
        últimoVerdict: "PASS",
        data: "2026-07-05T00:00:00Z",
      },
      {
        slug: "beta",
        project: "wahub",
        estadoAtual: "Building",
        leadTime: null,
        rondas: 1,
        últimoVerdict: "FAIL",
        data: "2026-07-06T00:00:00Z",
      },
    ],
  };
  const html = renderDashboardHtml({ ...EMPTY_MODEL, history });
  const histStart = html.indexOf("<!--hist-start-->");
  const histEnd = html.indexOf("<!--hist-end-->");
  assert.ok(histStart > -1 && histEnd > histStart);
  const panel = html.slice(histStart, histEnd);

  // Stat cards with the computed values.
  assert.match(panel, /missões concluídas/);
  assert.match(panel, />2</);
  assert.match(panel, /missões\/semana/);
  assert.match(panel, /1\.5/);
  assert.match(panel, /lead time mediano/);
  assert.match(panel, /4 dias/);
  assert.match(panel, /rondas média/);
  assert.match(panel, /tokens/);
  assert.match(panel, /1700/);
  assert.match(panel, /atenção-por-feature/);

  // Per-mission table rows.
  assert.match(panel, /alpha/);
  assert.match(panel, /beta/);
  assert.match(panel, /PASS/);
  assert.match(panel, /FAIL/);
  // Date formatted as DD/MM.
  assert.match(panel, /05\/07/);
  assert.match(panel, /06\/07/);
});

test("Histórico: null tokens/atenção render 'sem dados' (not crash)", () => {
  const history = {
    missõesConcluídas: 1,
    missõesPorSemana: null,
    leadTimeMediano: null,
    rondasMédia: 0,
    tokensTotal: null,
    atençãoPorFeature: null,
    byProject: {},
    perMission: [
      {
        slug: "solo",
        project: "wahub",
        estadoAtual: "Done",
        leadTime: 1,
        rondas: 0,
        últimoVerdict: "PASS",
        data: "2026-07-01T00:00:00Z",
      },
    ],
  };
  const html = renderDashboardHtml({ ...EMPTY_MODEL, history });
  const panel = html.slice(html.indexOf("<!--hist-start-->"), html.indexOf("<!--hist-end-->"));
  // null metrics → "sem dados" on individual cards.
  const semDadosCount = (panel.match(/sem dados/g) || []).length;
  assert.ok(
    semDadosCount >= 3,
    `expected ≥3 'sem dados' (missões/semana, lead time, tokens, atenção); got ${semDadosCount}`,
  );
});

test("Histórico: history embedded in separate <script id='history'> tag (not in model JSON)", () => {
  const history = {
    missõesConcluídas: 1,
    missõesPorSemana: null,
    leadTimeMediano: null,
    rondasMédia: 1,
    tokensTotal: null,
    atençãoPorFeature: null,
    byProject: {},
    perMission: [],
  };
  const html = renderDashboardHtml({ ...EMPTY_MODEL, history });
  const histScript = html.match(
    /<script type="application\/json" id="history">([\s\S]*?)<\/script>/,
  );
  assert.ok(histScript, "separate history script tag present");
  const parsed = JSON.parse(histScript[1]);
  assert.equal(parsed.missõesConcluídas, 1);
  // The model JSON must NOT contain history data.
  const modelScript = html.match(
    /<script type="application\/json" id="model">([\s\S]*?)<\/script>/,
  );
  assert.ok(modelScript);
  assert.doesNotMatch(modelScript[1], /missõesConcluídas/);
});

test("Histórico: self-contained — no external http(s) resource loads in the panel", () => {
  const history = {
    missõesConcluídas: 1,
    missõesPorSemana: 1,
    leadTimeMediano: 2,
    rondasMédia: 1,
    tokensTotal: 100,
    atençãoPorFeature: 0.5,
    byProject: {},
    perMission: [
      {
        slug: "x",
        project: "wahub",
        estadoAtual: "Done",
        leadTime: 2,
        rondas: 1,
        últimoVerdict: "PASS",
        data: "2026-07-01T00:00:00Z",
      },
    ],
  };
  const html = renderDashboardHtml({ ...EMPTY_MODEL, history });
  const panel = html.slice(html.indexOf("<!--hist-start-->"), html.indexOf("<!--hist-end-->"));
  assert.doesNotMatch(panel, /src=["']https?:/i);
  assert.doesNotMatch(panel, /href=["']https?:/i);
});

test("Histórico: escapes interpolated slug/verdict text (no XSS)", () => {
  const history = {
    missõesConcluídas: 0,
    missõesPorSemana: null,
    leadTimeMediano: null,
    rondasMédia: 0,
    tokensTotal: null,
    atençãoPorFeature: null,
    byProject: {},
    perMission: [
      {
        slug: `<b>x</b>`,
        project: "wahub",
        estadoAtual: "Done",
        leadTime: null,
        rondas: 0,
        últimoVerdict: "PASS",
        data: null,
      },
    ],
  };
  const html = renderDashboardHtml({ ...EMPTY_MODEL, history });
  const panel = html.slice(html.indexOf("<!--hist-start-->"), html.indexOf("<!--hist-end-->"));
  assert.doesNotMatch(panel, /<b>x<\/b>/);
  assert.match(panel, /&lt;b&gt;/);
});

// ─── CLI: --history flag ──────────────────────────────────────────────────────

test("CLI: --history reads the specified path and renders the Histórico tab with data", () => {
  const root = makeTmpRoot("board-report-cli-hist-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    mkdirSync(missionsDir, { recursive: true });
    const historyPath = path.join(root, "history.jsonl");
    writeFileSync(
      historyPath,
      [
        JSON.stringify({
          ts: "2026-07-01T00:00:00Z",
          project: "wahub",
          slug: "alpha",
          state: "Planning",
          features: "0/2",
          rounds: 0,
          verdict: null,
          reqIds: [],
        }),
        JSON.stringify({
          ts: "2026-07-05T00:00:00Z",
          project: "wahub",
          slug: "alpha",
          state: "Done",
          features: "2/2",
          rounds: 1,
          verdict: "PASS",
          reqIds: [],
        }),
      ].join("\n") + "\n",
    );
    const out = path.join(root, "out.html");
    const r = runBoardCli([
      "--missions",
      missionsDir,
      "--prd",
      prd,
      "--out",
      out,
      "--history",
      historyPath,
    ]);
    assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    const html = readFileSync(out, "utf8");
    const panel = html.slice(html.indexOf("<!--hist-start-->"), html.indexOf("<!--hist-end-->"));
    assert.match(panel, /alpha/);
    assert.match(panel, /1\s+miss[õo]es concluídas|>1</);
    assert.match(panel, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: default history path is <factoryRoot>/history.jsonl (renders 'sem dados' when missing)", () => {
  const root = makeTmpRoot("board-report-cli-defhist-");
  try {
    const prd = writePrd(root, [{ id: "A1", recurso: "feat", risco: "low", situacao: "todo" }]);
    const missionsDir = path.join(root, "missions");
    mkdirSync(missionsDir, { recursive: true });
    const out = path.join(root, "out.html");
    // No history.jsonl under the (tmp) factory root → default path finds nothing
    // → "sem dados ainda". FACTORY_ROOT points at the tmp tree to stay hermetic.
    const r = spawnSync(
      process.execPath,
      [BOARD_REPORT_CLI, "--missions", missionsDir, "--prd", prd, "--out", out, "--repo", root],
      { encoding: "utf8", env: { ...process.env, FACTORY_ROOT: root } },
    );
    assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    const html = readFileSync(out, "utf8");
    const panel = html.slice(html.indexOf("<!--hist-start-->"), html.indexOf("<!--hist-end-->"));
    assert.match(panel, /sem dados ainda/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Per-mission stats columns + Agentes view (factory-metrics W3, F4) ─────────

/** A mission entry carrying a stats.json payload (board-report model shape). */
function missionWithStats(slug, stats, overrides = {}) {
  return {
    slug,
    status: "Done",
    gateReason: null,
    requirements: [],
    features: 3,
    handoffs: 3,
    lastVerdict: { verdict: "PASS", round: 1 },
    branch: null,
    stats,
    ...overrides,
  };
}

test("buildTraceabilityModel: attaches stats.json to a mission (generatedAt stripped)", () => {
  const root = makeTmpRoot("board-report-stats-");
  try {
    mkMission(root, "alpha", {
      "brief.md": "**Requirements:** none\n",
      "stats.json": JSON.stringify({
        generatedAt: "2026-07-08T00:00:00.000Z",
        loc: { added: 100, deleted: 5, files: 4 },
        tokens: { worker: { total: 500 }, validator: { total: 200 }, total: 700 },
        models: { worker: "glm-5.2", validator: "glm-5.2" },
        durations: { building: 3600000, validating: null },
        rounds: 1,
        escalations: 0,
      }),
    });
    const prd = writePrd(root, []);
    const model = buildTraceabilityModel({ missionsDir: root, prdPath: prd, gitInfo: { branches: [] } });
    const m = model.missions.find((x) => x.slug === "alpha");
    assert.ok(m.stats, "stats attached");
    assert.equal(m.stats.generatedAt, undefined, "volatile generatedAt stripped");
    assert.deepEqual(m.stats.loc, { added: 100, deleted: 5, files: 4 });
    assert.equal(m.stats.tokens.total, 700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildTraceabilityModel: mission without stats.json → stats null", () => {
  const root = makeTmpRoot("board-report-nostats-");
  try {
    mkMission(root, "beta", { "brief.md": "**Requirements:** none\n" });
    const prd = writePrd(root, []);
    const model = buildTraceabilityModel({ missionsDir: root, prdPath: prd, gitInfo: { branches: [] } });
    assert.equal(model.missions.find((x) => x.slug === "beta").stats, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildTraceabilityModel: attaches the PR marker to a mission (factory-pr-record)", () => {
  const root = makeTmpRoot("board-report-pr-");
  try {
    mkMission(root, "alpha", {
      "brief.md": "**Requirements:** none\n",
      PR: JSON.stringify({ number: 42, url: "https://github.com/o/r/pull/42" }),
    });
    const prd = writePrd(root, []);
    const model = buildTraceabilityModel({ missionsDir: root, prdPath: prd, gitInfo: { branches: [] } });
    const m = model.missions.find((x) => x.slug === "alpha");
    assert.ok(m.pr, "PR marker attached");
    assert.equal(m.pr.number, 42);
    assert.match(m.pr.url, /pull\/42/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildTraceabilityModel: mission with no PR marker → pr null; corrupt marker → pr null", () => {
  const root = makeTmpRoot("board-report-nopr-");
  try {
    mkMission(root, "beta", { "brief.md": "**Requirements:** none\n" });
    mkMission(root, "gamma", { "brief.md": "**Requirements:** none\n", PR: "{not json" });
    const prd = writePrd(root, []);
    const model = buildTraceabilityModel({ missionsDir: root, prdPath: prd, gitInfo: { branches: [] } });
    assert.equal(model.missions.find((x) => x.slug === "beta").pr, null);
    assert.equal(model.missions.find((x) => x.slug === "gamma").pr, null, "corrupt marker is inert");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderDashboardHtml: a mission card links to its PR when a marker exists", () => {
  const root = makeTmpRoot("board-report-prcard-");
  try {
    mkMission(root, "alpha", {
      "brief.md": "**Requirements:** none\n",
      PR: JSON.stringify({ number: 42, url: "https://github.com/o/r/pull/42" }),
    });
    mkMission(root, "beta", { "brief.md": "**Requirements:** none\n" });
    const prd = writePrd(root, []);
    const model = buildTraceabilityModel({ missionsDir: root, prdPath: prd, gitInfo: { branches: [] } });
    const html = renderDashboardHtml(model);
    assert.match(html, /https:\/\/github\.com\/o\/r\/pull\/42/, "PR url rendered");
    assert.match(html, /PR\s*#42/, "PR number rendered");
    // beta has no marker → exactly one PR link in the whole document. Match the
    // full class attribute: `card-pr` is a prefix of `card-progress`.
    assert.equal(
      (html.match(/class="card-pr"/g) ?? []).length,
      1,
      "only the mission with a marker gets a link",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregateAgents: groups by worker model with pass-first, rondas, tokens/feature, escalations", () => {
  const missions = [
    missionWithStats("a", {
      models: { worker: "glm-5.2" },
      tokens: { total: 600 },
      rounds: 1,
      escalations: 0,
    }, { features: 3, lastVerdict: { verdict: "PASS", round: 1 } }),
    missionWithStats("b", {
      models: { worker: "glm-5.2" },
      tokens: { total: 900 },
      rounds: 3,
      escalations: 1,
    }, { features: 3, lastVerdict: { verdict: "PASS", round: 3 } }),
    missionWithStats("c", {
      models: { worker: "claude" },
      tokens: { total: 400 },
      rounds: 1,
      escalations: 0,
    }, { features: 2, lastVerdict: { verdict: "PASS", round: 1 } }),
  ];
  const agents = aggregateAgents(missions);
  const glm = agents.find((x) => x.model === "glm-5.2");
  const claude = agents.find((x) => x.model === "claude");
  assert.equal(glm.missoes, 2);
  assert.equal(glm.passPrimeiraRate, 0.5); // a passed round 1, b took 3 rounds
  assert.equal(glm.rondasMedia, 2); // (1 + 3) / 2
  assert.equal(glm.tokensPorFeature, 250); // (600 + 900) / (3 + 3)
  assert.equal(glm.escalations, 1);
  assert.equal(claude.missoes, 1);
  assert.equal(claude.passPrimeiraRate, 1);
});

test("aggregateAgents: missions without a worker model are skipped; empty → []", () => {
  assert.deepEqual(aggregateAgents([]), []);
  assert.deepEqual(aggregateAgents([{ slug: "x", stats: null }]), []);
  assert.deepEqual(aggregateAgents([{ slug: "y", stats: { models: {} } }]), []);
});

test("Agentes: tab button present + renders per-model rows", () => {
  const model = {
    generatedAt: "2026-07-08T00:00:00.000Z",
    requirements: [],
    orphanBranches: [],
    missions: [
      missionWithStats("a", {
        models: { worker: "zai-coding-plan/glm-5.2" },
        tokens: { total: 600 },
        rounds: 1,
        escalations: 0,
      }),
    ],
  };
  const html = renderDashboardHtml(model);
  assert.match(html, /data-tab="agentes"/);
  assert.match(html, />Agentes</);
  assert.match(html, /id="tab-agentes"/);
  assert.match(html, /zai-coding-plan\/glm-5\.2/);
});

test("Agentes: no stats anywhere → tab renders 'sem dados' and never crashes", () => {
  const html = renderDashboardHtml(EMPTY_MODEL);
  assert.match(html, /id="tab-agentes"/);
  const start = html.indexOf('id="tab-agentes"');
  const panel = html.slice(start, start + 400);
  assert.match(panel, /sem dados/);
});

test("Missões: a mission card with stats shows LOC, modelo, tokens, tempo, rondas", () => {
  const model = {
    generatedAt: "2026-07-08T00:00:00.000Z",
    requirements: [],
    orphanBranches: [],
    missions: [
      missionWithStats("alpha", {
        loc: { added: 2862, deleted: 18, files: 45 },
        models: { worker: "glm-5.2", validator: "glm-5.2" },
        tokens: { total: 2359696 },
        durations: { building: 3600000, validating: 1800000 },
        rounds: 1,
        escalations: 0,
      }),
    ],
  };
  const html = renderDashboardHtml(model);
  assert.match(html, /\+2862/); // LOC added
  assert.match(html, /2359696|2\.36M|2,359,696/); // tokens (some rendering)
  assert.match(html, /glm-5\.2/); // modelo
});

// ─── Intake tab (contract intake-board I9–I12) ────────────────────────────────
//
// The intake tab follows a requirement FORWARD from the words the client used
// (a `| IN-NN |` row in requirements-intake.md) to the backlog rows that cite it
// in their `Porquê / fonte` column, and through those to the mission + verdict.
//
// NEVER touch the real clients/tenant-a/requirements-intake.md — every fixture
// below writes its own throwaway intake `.md` inside a mkdtemp root.

/** The shared feature-body PRD header, verbatim (board-import-backlog.mjs HEADER). */
const PRD_BODY_HEADER =
  "| ID | Recurso | Porquê / fonte | Prova | Risco | Situação |\n|---|---|---|---|---|---|\n";

/**
 * A PRD body-table doc whose `Porquê / fonte` cells carry raw `IN-NN` citations.
 * `rows` is `[{ id, porque, risco?, situacao? }]`; `porque` is spliced in verbatim
 * so a compressed run like `IN-33/35/38/40a` reaches the parser intact.
 */
function writeCitingPrd(root, rows) {
  const body = rows
    .map(
      (r) =>
        `| ${r.id} | **${r.id} feat** — desc | ${r.porque} | prova | ${r.risco ?? "low"} | ${
          r.situacao ?? "todo"
        } |\n`,
    )
    .join("");
  const p = path.join(root, "prd.md");
  writeFileSync(p, `# PRD fixture\n\n${PRD_BODY_HEADER}${body}\n`);
  return p;
}

/**
 * Write a throwaway `requirements-intake.md` (the append-only 6-column table) and
 * return its absolute path. `rows` is `[{ id, date, source?, type?, summary?, status? }]`.
 * A caller may pass a raw `detail` markdown string to append a `### <id>` block
 * under the `# Detalhamento técnico` section.
 */
function writeIntakeDoc(root, rows, name = "requirements-intake.md") {
  const header =
    "| ID | Data · Fonte | Tipo | Resumo | Situação | Landed |\n|----|----|----|----|----|----|\n";
  const body = rows
    .map(
      (r) =>
        `| ${r.id} | ${r.date} · ${r.source ?? "audio"} | ${r.type ?? "feature"} | ${
          r.summary ?? `resumo ${r.id}`
        } | ${r.status ?? "New"} |  |\n`,
    )
    .join("");
  const detailRows = rows.filter((r) => typeof r.detail === "string" && r.detail.length > 0);
  let details = "";
  if (detailRows.length > 0) {
    details =
      "\n# Detalhamento técnico\n\n" +
      detailRows.map((r) => `### ${r.id} — bloco\n\n${r.detail}\n`).join("\n");
  }
  const p = path.join(root, name);
  writeFileSync(p, `# Intake fixture\n\n${header}${body}${details}\n`);
  return p;
}

/** A hand-rolled intake model row (renderIntakeTab / renderChain input shape). */
function intakeRow(id, over = {}) {
  return {
    id,
    date: "2026-06-10",
    dateSource: "2026-06-10 · audio",
    type: "feature",
    summary: `resumo ${id}`,
    status: "New",
    detail: "",
    detailShared: false,
    backlog: [],
    ...over,
  };
}

// ── I9: buildTraceabilityModel → model.intake with the forward chain ──────────

test("I9: intake row carries a backlog[] of PRD ids whose Porquê cites it (PRD order)", () => {
  const root = makeTmpRoot("board-report-intake-i9-");
  try {
    // C3 cites IN-33/35/38/40a; C7 cites IN-39/40a/48. C3 precedes C7 in the doc.
    const prd = writeCitingPrd(root, [
      { id: "C3", porque: "vem de IN-33/35/38/40a" },
      { id: "C7", porque: "consolidação de IN-39/40a/48" },
    ]);
    const intakePath = writeIntakeDoc(root, [
      { id: "IN-33", date: "2026-06-10" },
      { id: "IN-35", date: "2026-06-10" },
      { id: "IN-38", date: "2026-06-10" },
      { id: "IN-39", date: "2026-06-11" },
      { id: "IN-40", date: "2026-06-11" },
      { id: "IN-48", date: "2026-06-12" },
      { id: "IN-99", date: "2026-06-12", summary: "ninguém cita" },
    ]);
    const missionsDir = path.join(root, "missions");
    mkdirSync(missionsDir, { recursive: true });

    const model = buildTraceabilityModel({
      missionsDir,
      prdPath: prd,
      gitInfo: { branches: [] },
      intakeSources: [{ file: intakePath, prefix: "IN", label: "tenant-a" }],
    });

    assert.ok(Array.isArray(model.intake), "model.intake is an array");
    const byId = new Map(model.intake.map((r) => [r.id, r]));

    const ids = (id) => byId.get(id).backlog.map((b) => b.id);
    assert.deepEqual(ids("IN-33"), ["C3"], "IN-33 cited only by C3");
    // IN-40 is cited by BOTH (via IN-40a) — must list them in PRD order: C3, C7.
    assert.deepEqual(ids("IN-40"), ["C3", "C7"], "IN-40 cited by C3 then C7 (doc order)");
    assert.deepEqual(ids("IN-99"), [], "an uncited row keeps an empty backlog (não despachado)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I9: each backlog entry carries {id, missionSlug, liveStatus, verdict} from the mission", () => {
  const root = makeTmpRoot("board-report-intake-i9b-");
  try {
    const prd = writeCitingPrd(root, [{ id: "C3", porque: "de IN-33/35" }]);
    const intakePath = writeIntakeDoc(root, [
      { id: "IN-33", date: "2026-06-10" },
      { id: "IN-35", date: "2026-06-10" },
    ]);
    const missionsDir = path.join(root, "missions");
    // A mission whose brief CLAIMS C3 and whose validate.log ends on PASS.
    mkMission(missionsDir, "sdr-nonlead-gate", {
      "brief.md": "# Brief\n\n**Requirements:** C3\n",
      "validate.log": jsonl(verdict(1, "FAIL"), verdict(2, "PASS")),
    });

    const model = buildTraceabilityModel({
      missionsDir,
      prdPath: prd,
      gitInfo: { branches: [] },
      intakeSources: [{ file: intakePath, prefix: "IN", label: "tenant-a" }],
    });

    const in33 = model.intake.find((r) => r.id === "IN-33");
    assert.equal(in33.backlog.length, 1);
    const entry = in33.backlog[0];
    assert.equal(entry.id, "C3");
    assert.equal(entry.missionSlug, "sdr-nonlead-gate", "chained to the claiming mission");
    assert.equal(entry.verdict, "PASS", "the mission's last verdict flows onto the chain");
    // liveStatus is the mission's derived board status (PASS → Needs Human).
    assert.equal(entry.liveStatus, "Needs Human");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── I10: renderDashboardHtml WITH intake → tab + one card per row + jump link ──

test("I10: intake non-empty → one data-tab=intake, an <article> per row, a jump link", () => {
  const model = {
    generatedAt: "2026-07-08T00:00:00.000Z",
    requirements: [],
    missions: [],
    orphanBranches: [],
    intake: [
      intakeRow("IN-33", {
        backlog: [
          { id: "C3", missionSlug: "sdr-nonlead-gate", liveStatus: "Needs Human", verdict: "PASS" },
        ],
      }),
      intakeRow("IN-40", { date: "2026-06-11" }),
    ],
  };
  const html = renderDashboardHtml(model);

  // The tab exists exactly once (the nav button; the panel id is `tab-intake`).
  assert.equal(
    (html.match(/data-tab="intake"/g) ?? []).length,
    1,
    "exactly one intake tab button",
  );
  assert.match(html, /id="tab-intake"/);

  // One <article class="intake-card" id="intake-IN-NN"> per intake row.
  assert.match(html, /<article class="intake-card" id="intake-IN-33">/);
  assert.match(html, /<article class="intake-card" id="intake-IN-40">/);
  assert.equal(
    (html.match(/class="intake-card"/g) ?? []).length,
    2,
    "one card per intake row",
  );

  // The forward chain links into the mission card by in-page anchor.
  assert.match(html, /href="#mission-sdr-nonlead-gate" data-jump-to-mission/);
});

// ── I11: renderDashboardHtml WITHOUT intake → no tab, no panel, no empty tab ───

test("I11: empty intake → no data-tab=intake, no id=tab-intake; renderIntakeTab([]) is ''", () => {
  // Absent `intake` key entirely.
  const noKey = renderDashboardHtml(EMPTY_MODEL);
  assert.doesNotMatch(noKey, /data-tab="intake"/);
  assert.doesNotMatch(noKey, /id="tab-intake"/);

  // Present but empty array — same outcome (no empty tab is ever shown).
  const emptyArr = renderDashboardHtml({ ...EMPTY_MODEL, intake: [] });
  assert.doesNotMatch(emptyArr, /data-tab="intake"/);
  assert.doesNotMatch(emptyArr, /id="tab-intake"/);

  // The renderer helper itself collapses to the empty string.
  assert.equal(renderIntakeTab([]), "");
  assert.equal(renderIntakeTab(undefined), "");
});

// ── I12: every .md-sourced string is escaped BEFORE any markdown transform ────

test("I12: a <script> in an intake summary is escaped, never emitted as a tag", () => {
  const out = renderIntakeTab([intakeRow("IN-1", { summary: "<script>alert(1)</script>" })], {
    hidden: false,
  });
  assert.match(out, /&lt;script&gt;/, "the angle brackets are entity-escaped");
  assert.ok(!out.includes("<script>alert"), "no live <script> tag leaks through");
});

test("I12: an unbalanced ** never opens a dangling <strong>", () => {
  const out = renderIntakeTab([intakeRow("IN-1", { summary: "**não fecha aqui" })], {
    hidden: false,
  });
  assert.doesNotMatch(out, /<strong>/, "odd ** count produces no <strong> opener");
  assert.doesNotMatch(out, /<\/strong>/);
  assert.ok(out.includes("**não fecha aqui"), "the stray ** survives as plain text");
});

test("I12: a Detalhamento block with <img onerror> is escaped, not injected", () => {
  const out = renderIntakeTab(
    [intakeRow("IN-1", { detail: "antes\n\n<img src=x onerror=1>\n\ndepois" })],
    { hidden: false },
  );
  assert.match(out, /&lt;img src=x onerror=1&gt;/, "the img tag is entity-escaped");
  assert.ok(!out.includes("<img src=x onerror=1>"), "no live <img> tag leaks through");
});

test("I12: the supported markdown subset renders (bold/code/italic/ul/ol/quote)", () => {
  const detail = [
    "**negrito** e `code` e *itálico*",
    "",
    "- item um",
    "- item dois",
    "",
    "1. primeiro",
    "2. segundo",
    "",
    "> citação aqui",
  ].join("\n");
  const out = renderIntakeTab([intakeRow("IN-1", { detail })], { hidden: false });

  assert.match(out, /<strong>negrito<\/strong>/, "**bold** → <strong>");
  assert.match(out, /<code>code<\/code>/, "`code` → <code>");
  assert.match(out, /<em>itálico<\/em>/, "*italic* → <em>");
  assert.match(out, /<ul>.*<li>item um<\/li>.*<li>item dois<\/li>.*<\/ul>/s, "- item → <li> in <ul>");
  assert.match(out, /<ol>.*<li>primeiro<\/li>.*<li>segundo<\/li>.*<\/ol>/s, "1. item → <li> in <ol>");
  assert.match(out, /<blockquote>.*citação aqui.*<\/blockquote>/s, "> quote → <blockquote>");
});

test("I12: a wrapped bullet continuation stays INSIDE the same <li> (no loose text)", () => {
  const detail = "- primeira parte\ncontinua aqui\n- outra";
  const out = renderIntakeTab([intakeRow("IN-1", { detail })], { hidden: false });

  // The continuation line is folded into its bullet's <li>, joined by a space.
  assert.match(out, /<li>primeira parte continua aqui<\/li>/);
  // No loose (non-tag, non-whitespace) text may sit between </li> and the next
  // <li>, or between </li> and </ul> — that would be a leaked continuation.
  assert.doesNotMatch(out, /<\/li>[^<]*\S[^<]*<li>/, "no loose text between </li> and <li>");
  assert.doesNotMatch(out, /<\/li>[^<]*\S[^<]*<\/ul>/, "no loose text between </li> and </ul>");
});

// ── renderIntakeTab: the `hidden` option ──────────────────────────────────────

test("renderIntakeTab: hidden defaults to true, {hidden:false} omits the attribute", () => {
  const rows = [intakeRow("IN-1")];
  const openTag = (s) => s.match(/<section id="tab-intake"[^>]*>/)[0];

  // Default (no opts) → hidden present (dashboard keeps it behind its tab).
  assert.match(openTag(renderIntakeTab(rows)), /\shidden>/);
  // Empty opts object → still hidden (default kicks in).
  assert.match(openTag(renderIntakeTab(rows, {})), /\shidden>/);
  // Explicit {hidden:false} → no hidden attribute (local editor shows it at once).
  assert.doesNotMatch(openTag(renderIntakeTab(rows, { hidden: false })), /\shidden>/);
});

test("renderIntakeTab: a row with no backlog renders the 'não despachado' badge", () => {
  const dispatched = intakeRow("IN-1", {
    backlog: [{ id: "C3", missionSlug: "m", liveStatus: "Done", verdict: "PASS" }],
  });
  const orphan = intakeRow("IN-2", { backlog: [] });
  const out = renderIntakeTab([dispatched, orphan], { hidden: false });

  assert.match(out, /não despachado/, "the uncited row says so of itself");
  assert.equal(
    (out.match(/não despachado/g) ?? []).length,
    1,
    "only the uncited row gets the badge",
  );
});

/**
 * Tests for the verdict recorder's board-sync hook (M-07, soft-fail).
 *
 *   node --test "scripts/factory/*.test.mjs"
 *
 * `verdict.test.mjs` proves the recorder itself and must stay untouched; this
 * file only proves the hook added on top: every successful `record` best-effort
 * triggers `board-sync.mjs` against the same `--dir`, and that trigger can never
 * change `record`'s exit code, stdout, or log write — with `backlog/` absent or
 * with the board-sync target itself missing.
 *
 * The tmp-repo `backlog init` fixture mirrors `board-sync.test.mjs`'s `initRepo`
 * (that file is out of scope to import from/modify, so the small amount of setup
 * is duplicated here rather than reused).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseLabels, parseTaskList } from "./board-sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const VERDICT_CLI = path.join(HERE, "verdict.mjs");
const BACKLOG_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "backlog");
const SLUG = "hook-mission";

const STATUSES = "Intake, Planning, Building, Validating, Needs Human, Done, Blocked";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function missionsRoot(repo) {
  return path.join(repo, "factory", "missions");
}

/** Tmp repo with a real `backlog init` (same statuses as board-sync's fixture) plus a mission dir. */
function initRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "verdict-hook-"));
  const r = spawnSync(
    BACKLOG_BIN,
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
  mkdirSync(path.join(missionsRoot(repo), SLUG), { recursive: true });
  return repo;
}

function backlog(repo, args) {
  return spawnSync(BACKLOG_BIN, args, { cwd: repo, encoding: "utf8" });
}

function cards(repo) {
  return parseTaskList(backlog(repo, ["task", "list", "--plain"]).stdout);
}

function columnOf(repo, slug) {
  return cards(repo).find((c) => c.title === slug)?.status;
}

function labelsOf(repo, slug) {
  const id = cards(repo).find((c) => c.title === slug)?.id;
  if (!id) return [];
  return parseLabels(backlog(repo, ["task", id, "--plain"]).stdout);
}

function passVerdict(round) {
  return {
    slug: SLUG,
    round,
    verdict: "PASS",
    assertions: [{ id: "A1", status: "green", proof: "pnpm test exit 0" }],
    escalate: false,
  };
}

function failVerdict(round) {
  return {
    slug: SLUG,
    round,
    verdict: "FAIL",
    assertions: [
      { id: "A1", status: "green", proof: "pnpm test exit 0" },
      { id: "A2", status: "red", expected: "row present", actual: "missing", proof: "sql select" },
    ],
    escalate: false,
  };
}

function record(root, obj) {
  // Self-contained fixture: missions-root and the backlog repo-root are the same
  // tmp tree here, so pass both (post-extraction they are separate by default).
  const repoRoot = path.resolve(root, "..", "..");
  return spawnSync(process.execPath, [VERDICT_CLI, "record", SLUG, "--dir", root, "--repo", repoRoot], {
    input: JSON.stringify(obj),
    encoding: "utf8",
  });
}

function logLines(root) {
  const p = path.join(root, SLUG, "validate.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

// ─── A3: verdict append moves the card ─────────────────────────────────────────

test("record: PASS syncs the board to Needs Human + gate:ratify, never Done", () => {
  const repo = initRepo();
  try {
    const r = record(missionsRoot(repo), passVerdict(1));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(columnOf(repo, SLUG), "Needs Human");
    assert.notEqual(columnOf(repo, SLUG), "Done");
    assert.ok(labelsOf(repo, SLUG).includes("gate:ratify"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("record: 3 sequential FAIL rounds sync the board to Needs Human + gate:escalated", () => {
  const repo = initRepo();
  try {
    assert.equal(record(missionsRoot(repo), failVerdict(1)).status, 0);
    assert.equal(record(missionsRoot(repo), failVerdict(2)).status, 0);
    const r3 = record(missionsRoot(repo), failVerdict(3));
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(columnOf(repo, SLUG), "Needs Human");
    assert.ok(labelsOf(repo, SLUG).includes("gate:escalated"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("record: FAIL round 1 syncs the board to Validating", () => {
  const repo = initRepo();
  try {
    const r = record(missionsRoot(repo), failVerdict(1));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(columnOf(repo, SLUG), "Validating");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── A5: soft layer — backlog/ absent ──────────────────────────────────────────

test("record: with backlog/ absent, still exits 0, appends the log line, stdout matches the unhooked baseline", () => {
  const root = mkdtempSync(path.join(tmpdir(), "verdict-hook-nobacklog-"));
  try {
    mkdirSync(path.join(root, SLUG), { recursive: true });
    const r = record(root, passVerdict(1));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `recorded round 1 verdict=PASS for ${SLUG} (1 assertion(s))\n`);
    assert.equal(r.stderr, "");
    assert.equal(logLines(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Robustness: hook failures never change verdict.mjs's own behavior ────────

test("record: still exits 0 and records when board-sync.mjs is missing next to verdict.mjs", () => {
  // Exercise "board-sync deliberately broken" without racing the real
  // board-sync.mjs (board-sync.test.mjs spawns that same file concurrently
  // under `node --test`, so renaming it in place would be flaky). Instead,
  // run an isolated copy of verdict.mjs with no board-sync.mjs beside it —
  // the hook's same-dir resolution then finds nothing, by construction.
  const tmpScripts = mkdtempSync(path.join(tmpdir(), "verdict-hook-broken-scripts-"));
  const root = mkdtempSync(path.join(tmpdir(), "verdict-hook-broken-root-"));
  try {
    const isolatedVerdict = path.join(tmpScripts, "verdict.mjs");
    cpSync(VERDICT_CLI, isolatedVerdict);
    // verdict.mjs now statically imports git-autocommit.mjs — ship it alongside
    // so this fixture isolates ONLY the board-sync-absent scenario.
    cpSync(path.join(HERE, "git-autocommit.mjs"), path.join(tmpScripts, "git-autocommit.mjs"));
    // verdict.mjs also imports ./lib/project.mjs — ship the resolver too.
    mkdirSync(path.join(tmpScripts, "lib"), { recursive: true });
    cpSync(path.join(HERE, "lib", "project.mjs"), path.join(tmpScripts, "lib", "project.mjs"));
    assert.ok(
      !existsSync(path.join(tmpScripts, "board-sync.mjs")),
      "fixture must not have board-sync.mjs",
    );

    mkdirSync(path.join(root, SLUG), { recursive: true });
    const r = spawnSync(process.execPath, [isolatedVerdict, "record", SLUG, "--dir", root], {
      input: JSON.stringify(passVerdict(1)),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `recorded round 1 verdict=PASS for ${SLUG} (1 assertion(s))\n`);
    assert.equal(logLines(root).length, 1);
  } finally {
    rmSync(tmpScripts, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("record: idempotent — running the hook twice for the same mission causes no extra state", () => {
  const repo = initRepo();
  try {
    record(missionsRoot(repo), passVerdict(1));
    const before = cards(repo).length;
    // status/record already ran the hook once via record(); re-sync manually
    // to prove a second projection of the same state makes no new cards.
    const r2 = spawnSync(
      process.execPath,
      [path.join(HERE, "board-sync.mjs"), SLUG, "--dir", missionsRoot(repo), "--repo", repo],
      {
        encoding: "utf8",
      },
    );
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(cards(repo).length, before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

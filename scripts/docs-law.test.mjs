#!/usr/bin/env node
/**
 * Meta-test: the doc law (constitution §"Doc law") enforced against the real repo.
 *
 *   node --test "scripts/docs-law.test.mjs"
 *
 * Why a test and not just prose: prose is exactly what let 9 spent Fable-5 plan
 * dossiers accumulate in `docs/` until a coordinator reading one would have been
 * confidently wrong about what shipped. Doc sprawl is a correctness problem — a
 * stale spec reads as authoritative to the next agent and corrupts the code it
 * drives — so the law gets a gate like any other correctness rule.
 *
 * These assertions run against the working tree, not a fixture: the thing under
 * test IS this repo's doc surface. Amending an allow-list below is the deliberate
 * act the law asks for; silently adding a file is what it prevents.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const FACTORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Rule 1/2 — the only root-level docs. RUNBOOK/constitution/decisions are three
// of the four named authorities; README is the front door.
//
// `decisions.inbox.md` — the second coordinator's staging area for proposals not
// yet ratified — is NOT part of this public export: unratified drafts are not a
// published authority. It is absent here and therefore absent from this list,
// which is exact-match by design (a new root doc must be argued for, not
// tolerated). In the private repo it sits between README.md and decisions.md.
const ROOT_DOCS = [
  "README.md",
  "RUNBOOK.md",
  "constitution.md",
  "decisions.md",
];

// Rule 1 — `docs/` holds the architecture authority plus the two dossiers live
// surfaces still cite (cage-research from claude-worker's threat model, ai-lane
// from mission-plan). Anything else is either an authority or archived.
const DOCS_DIR_FILES = [
  "ai-lane-2026-07-23.md",
  "cage-research-2026-07-09.md",
  "harness-review.md",
];

// Rule 3 — surfaces a SEAT reads as instruction. A provenance comment in code or a
// test is deliberately NOT here: it records history, it does not instruct anyone.
const LIVE_SURFACES = [
  "README.md",
  "RUNBOOK.md",
  "constitution.md",
  "skills",
  "templates",
  "projects",
];

// What rule 3 actually forbids: a pointer at ONE archived document, which is what
// sends a seat off to read a spent plan as current. Naming the directory itself —
// as the constitution must, to state the law — is not that, and stays legal.
const ARCHIVED_DOC = /docs\/_archive\/[A-Za-z0-9._-]+\.md/;

function mdFilesIn(dirAbs) {
  return readdirSync(dirAbs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
}

/** Every file at or under `abs`, recursively. A plain file yields just itself. */
function walk(abs) {
  if (!statSync(abs).isDirectory()) return [abs];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(abs, e.name);
    if (e.isDirectory()) out.push(...walk(child));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

test("doc law: root-level .md is exactly the allow-list (no new root docs)", () => {
  assert.deepEqual(
    mdFilesIn(FACTORY_ROOT),
    [...ROOT_DOCS].sort(),
    "a new root-level .md appeared. The law says the answer is almost always a " +
      "decisions.md line or a mission dossier — if it genuinely is a new authority, " +
      "amend ROOT_DOCS here and say why in decisions.md.",
  );
});

test("doc law: docs/ holds only the architecture authority and live-cited dossiers", () => {
  assert.deepEqual(
    mdFilesIn(path.join(FACTORY_ROOT, "docs")),
    [...DOCS_DIR_FILES].sort(),
    "docs/ drifted. A plan dies when it ships: move it to docs/_archive/ and record " +
      "its outcome as a decisions.md line.",
  );
});

test("doc law: no live surface cites docs/_archive/ (archived text never instructs a seat)", () => {
  const offenders = [];
  for (const rel of LIVE_SURFACES) {
    const abs = path.join(FACTORY_ROOT, rel);
    if (!existsSync(abs)) continue;
    const files = walk(abs).filter((f) => /\.(md|json)$/.test(f));
    for (const f of files) {
      if (ARCHIVED_DOC.test(readFileSync(f, "utf8"))) {
        offenders.push(path.relative(FACTORY_ROOT, f));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a live surface points a seat at archived text. Cite RUNBOOK/constitution/" +
      "decisions/harness-review instead; if the rationale is still load-bearing, " +
      "append it to decisions.md.",
  );
});

test("doc law: docs/_archive carries its not-ground-truth banner", () => {
  const banner = path.join(FACTORY_ROOT, "docs", "_archive", "README.md");
  assert.ok(existsSync(banner), "docs/_archive/README.md is missing");
  const head = readFileSync(banner, "utf8").split("\n")[0];
  assert.match(
    head,
    /NOT GROUND TRUTH/,
    "the archive's first line must warn, in the first thing an agent reads, that " +
      `nothing inside is current. Got: ${head}`,
  );
});

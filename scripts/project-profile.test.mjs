#!/usr/bin/env node
/**
 * Feature 05 — Profile conformance suite (the enforcement).
 *
 *   node --test "scripts/project-profile.test.mjs"
 *
 * Two halves:
 *
 *   PART 1 — per-profile conformance. `projects/` is scanned at the factory
 *   root (`scripts/` → ".."); every subdir holding a `project.json` gets a block
 *   of 8 named tests. A malformed profile fails loudly, by name. A guard test
 *   pins that the scan found ≥1 profile, so an empty loop can never masquerade
 *   as a green suite.
 *
 *   PART 2 — the meta test. None of the shipping engine sources may name a
 *   product. The forbidden ids are derived from `projects/` (every id EXCEPT
 *   `factory`, the engine's own dogfood profile). Test files (`*.test.mjs`) are
 *   exempt: engine tests may use a real profile id as an opaque fixture, and
 *   profiles are checked into this repo. The architectural rule is that
 *   *shipping engine code* never names a product; this suite is what pins each
 *   product's actual facts. Exempting tests keeps the rule enforceable instead
 *   of aspirational.
 *
 * Coverage moved here in Feature 05: the old "shipped template denies every
 * wahub Critical File" test (Feature 03) lives on generically in Part 1 test 5
 * — every profile's every declared glob becomes an Edit and a Write deny rule.
 *
 * Plain Node ESM, no deps beyond `node:*`. No writes (read-only suite); the
 * `mkdtempSync`/`finally` convention is therefore vacuously satisfied.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseEnv, extractSecrets } from "./probe-secrets.mjs";
import { auditCageSettings, denyRules, loadTemplate, renderCageSettings } from "./cage-settings.mjs";
import { resolveProject } from "./lib/project.mjs";

/**
 * The factory root, derived exactly as the spec directs: from this file's URL.
 * Independent of `$FACTORY_ROOT`, so the suite is stable regardless of where
 * the engine is dispatched from.
 */
const FACTORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS_DIR = path.join(FACTORY_ROOT, "projects");

/**
 * Discover profile ids by scanning `projects/` for subdirectories that hold a
 * `project.json`. A `.test.mjs` file lives inside `projects/wahub/`, so we look
 * for the data marker, not "every entry is a plain data dir".
 * @returns {string[]}
 */
function discoverProfiles() {
  let subs = [];
  try {
    subs = readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    subs = [];
  }
  const ids = [];
  for (const ent of subs) {
    if (!ent.isDirectory()) continue;
    if (existsSync(path.join(PROJECTS_DIR, ent.name, "project.json"))) ids.push(ent.name);
  }
  return ids;
}

const PROFILE_IDS = discoverProfiles();

// ─── Guard: an empty projects/ scan must never masquerade as a green suite ────

test("projects/ contains at least one profile", () => {
  assert.ok(
    PROFILE_IDS.length > 0,
    `no profiles discovered under ${PROJECTS_DIR} — the per-profile loop below ran zero times`,
  );
});

// ─── Part 1 — per-profile conformance (iterate, do not hardcode) ──────────────

for (const id of PROFILE_IDS) {
  const profileDir = path.join(PROJECTS_DIR, id);
  const projectJsonPath = path.join(profileDir, "project.json");
  const criticalFilesPath = path.join(profileDir, "critical-files.json");
  const seatEnvPath = path.join(profileDir, "seat.env");

  // Pre-read the on-disk JSON once per profile; the per-test assertions below
  // either consult these or re-derive independently. `?? null` keeps the shape
  // stable when a required file is missing (test 1 flags the absence).
  let projectJson = null;
  try {
    projectJson = JSON.parse(readFileSync(projectJsonPath, "utf8"));
  } catch {
    projectJson = null;
  }
  let criticalFiles = null;
  try {
    const parsed = JSON.parse(readFileSync(criticalFilesPath, "utf8"));
    criticalFiles = Array.isArray(parsed) ? parsed : null;
  } catch {
    criticalFiles = null;
  }

  // 1 — required files present
  test(`profile ${id}: required files present (project.json, critical-files.json)`, () => {
    assert.ok(existsSync(projectJsonPath), `missing required file: ${projectJsonPath}`);
    assert.ok(existsSync(criticalFilesPath), `missing required file: ${criticalFilesPath}`);
  });

  // 2 — declared id matches directory name
  test(`profile ${id}: project.json declares id matching its directory name`, () => {
    assert.ok(projectJson && typeof projectJson === "object", "project.json missing or unparseable");
    assert.equal(
      projectJson?.id,
      id,
      `project.json.id (${JSON.stringify(projectJson?.id)}) does not match directory name (${id})`,
    );
  });

  // 3 — gate[] is a non-empty array of non-empty strings
  test(`profile ${id}: gate[] is a non-empty array of non-empty strings`, () => {
    assert.ok(projectJson, "project.json missing or unparseable");
    assert.ok(Array.isArray(projectJson.gate), `gate is not an array: ${typeof projectJson.gate}`);
    assert.ok(projectJson.gate.length > 0, "gate is empty — a profile must run at least one command");
    projectJson.gate.forEach((g, i) => {
      assert.equal(typeof g, "string", `gate[${i}] is not a string: ${typeof g}`);
      assert.ok(g.length > 0, `gate[${i}] is the empty string`);
    });
  });

  // 4 — critical-files.json is an array of non-empty repo-relative globs
  test(`profile ${id}: critical-files.json is an array of non-empty repo-relative globs`, () => {
    assert.ok(Array.isArray(criticalFiles), "critical-files.json is missing or not a JSON array");
    criticalFiles.forEach((g, i) => {
      assert.equal(typeof g, "string", `critical-files[${i}] is not a string: ${typeof g}`);
      assert.ok(g.length > 0, `critical-files[${i}] is the empty string`);
      assert.ok(!g.startsWith("/"), `critical-files[${i}] has a leading slash (not repo-relative): ${g}`);
      assert.ok(
        !g.split("/").includes(".."),
        `critical-files[${i}] contains a ".." segment (escapes the repo): ${g}`,
      );
    });
  });

  // 5 — critical files render through cage-settings with a clean audit, and
  // every glob becomes BOTH an Edit and a Write deny rule. This is the generic
  // home of the moved Feature 03 assertion ("shipped template denies every
  // wahub Critical File") — now enforced for every profile.
  test(`profile ${id}: critical files render through cage-settings with a clean audit`, () => {
    assert.ok(Array.isArray(criticalFiles), "critical-files.json missing — cannot render");
    // `renderCageSettings` throws on a relative worktree path; `/tmp/x` is the
    // spec-named absolute anchor. No file is written — render is pure.
    const rendered = renderCageSettings(loadTemplate(), "/tmp/x", { criticalFiles });
    assert.deepEqual(auditCageSettings(rendered), [], "rendered cage failed its own audit");

    const rules = denyRules(rendered);
    for (const g of criticalFiles) {
      const editRule = `Edit(//tmp/x/${g})`;
      const writeRule = `Write(//tmp/x/${g})`;
      assert.ok(rules.includes(editRule), `no Edit deny rule emitted for glob: ${g}`);
      assert.ok(rules.includes(writeRule), `no Write deny rule emitted for glob: ${g}`);
    }
  });

  // 6 — seat.env, when present, parses to KEY=value and carries no real-looking
  // secret. Skipped when the file is absent (the `factory` profile has none).
  test(`profile ${id}: seat.env, when present, parses to KEY=value and carries no real-looking secret`, (t) => {
    if (!existsSync(seatEnvPath)) {
      t.skip(`no seat.env at ${seatEnvPath}`);
      return;
    }
    const text = readFileSync(seatEnvPath, "utf8");
    const pairs = parseEnv(text);
    assert.ok(pairs.length > 0, "seat.env parsed to zero KEY=value pairs");

    // Forbidden keys — dispatch appends DATABASE_URL / DIRECT_URL per-agent, so
    // they must never be committed in the template.
    const keys = new Set(pairs.map((p) => p.key));
    assert.ok(!keys.has("DATABASE_URL"), "DATABASE_URL must not appear in seat.env (dispatch appends per-agent)");
    assert.ok(!keys.has("DIRECT_URL"), "DIRECT_URL must not appear in seat.env (dispatch appends per-agent)");

    // Forbidden value shapes — no real-looking secret across every parsed value.
    for (const { key, value } of pairs) {
      assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(value), `${key}: JWT-shaped token (eyJ…)`);
      assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(value), `${key}: sk- API key`);
      assert.ok(!/AIza[A-Za-z0-9_-]{10,}/.test(value), `${key}: AIza Google key`);
    }

    // Belt-and-suspenders via extractSecrets (the spec named both helpers): any
    // candidate secret value longer than the default floor must again clear the
    // three forbidden prefixes.
    for (const v of extractSecrets(text)) {
      assert.ok(!/^eyJ[A-Za-z0-9_-]{10,}/.test(v), `long value is JWT-shaped: ${v.slice(0, 6)}…`);
      assert.ok(!/^sk-[A-Za-z0-9]{10,}/.test(v), `long value is an sk- key: ${v.slice(0, 6)}…`);
      assert.ok(!/^AIza[A-Za-z0-9_-]{10,}/.test(v), `long value is an AIza key: ${v.slice(0, 6)}…`);
    }
  });

  // 7 — the profile's `path` resolves to an existing product checkout. Skipped
  // on a machine that has the factory but not every product, so the suite stays
  // green in engine-only checkouts.
  //
  // It ALSO skips inside an engine worktree, for a different reason: `path` is
  // relative to the factory root, and in `.worktrees/<slug>/` that root is the
  // worktree, so `../../products/<id>` under-resolves. The skip reason must not
  // claim the checkout is missing when it is merely mis-anchored — a reason that
  // lies costs the next reader an afternoon.
  test(`profile ${id}: path resolves to an existing checkout`, (t) => {
    const { repoRoot } = resolveProject({ project: id }, FACTORY_ROOT);
    if (!existsSync(repoRoot)) {
      const inWorktree = FACTORY_ROOT.split(path.sep).includes(".worktrees");
      t.skip(
        inWorktree
          ? `repoRoot ${repoRoot} does not exist — expected inside an engine worktree, where a ` +
            `relative profile path under-resolves. Run from the main factory checkout to assert this.`
          : `product checkout not present on this machine: ${repoRoot}`,
      );
      return;
    }
    assert.ok(existsSync(repoRoot), `repoRoot does not exist: ${repoRoot}`);
  });

  // 8 — the resolver round-trips the on-disk profile verbatim, and the sibling
  // paths it derives are absolute-or-null.
  test(`profile ${id}: resolveProject({project: id}) round-trips the profile`, () => {
    assert.ok(projectJson, "project.json missing or unparseable");
    assert.ok(Array.isArray(criticalFiles), "critical-files.json missing or not an array");

    const { profile } = resolveProject({ project: id }, FACTORY_ROOT);
    assert.deepEqual(profile.gate, projectJson.gate, "profile.gate ≠ project.json.gate");
    assert.deepEqual(profile.criticalFiles, criticalFiles, "profile.criticalFiles ≠ critical-files.json");

    if (profile.seatEnvPath !== null) {
      assert.ok(path.isAbsolute(profile.seatEnvPath), `seatEnvPath not absolute: ${profile.seatEnvPath}`);
    }
    if (profile.validationPath !== null) {
      assert.ok(path.isAbsolute(profile.validationPath), `validationPath not absolute: ${profile.validationPath}`);
    }
  });

  // 9 — intake[], when present, is an array of {file, prefix, label}. A profile
  // that omits `intake` must still surface `profile.intake === []` (never
  // undefined). When declared, each on-disk entry carries a non-empty RELATIVE
  // `file` (resolved against factoryRoot, like `path`) and an all-caps `prefix`.
  test(`profile ${id}: intake[], when present, is an array of {file, prefix, label}`, () => {
    const { profile } = resolveProject({ project: id }, FACTORY_ROOT);
    assert.ok(Array.isArray(profile.intake), `profile.intake is not an array: ${typeof profile.intake}`);

    const declared = projectJson && Array.isArray(projectJson.intake) ? projectJson.intake : null;
    if (!declared) {
      assert.deepEqual(profile.intake, [], "profile.intake must be [] when project.json declares no intake");
      return;
    }
    declared.forEach((it, i) => {
      assert.ok(it && typeof it === "object", `intake[${i}] is not an object`);
      assert.equal(typeof it.file, "string", `intake[${i}].file is not a string: ${typeof it.file}`);
      assert.ok(it.file.length > 0, `intake[${i}].file is the empty string`);
      assert.ok(!path.isAbsolute(it.file), `intake[${i}].file is not repo-relative: ${it.file}`);
      assert.match(
        it.prefix,
        /^[A-Z]+$/,
        `intake[${i}].prefix does not match /^[A-Z]+$/: ${JSON.stringify(it.prefix)}`,
      );
    });
  });

  // 10 — the resolver turns every intake[].file into an absolute path, and the
  // count survives the round-trip (well-formed entries are never dropped).
  test(`profile ${id}: intake[] resolves to absolute paths`, () => {
    const declared = projectJson && Array.isArray(projectJson.intake) ? projectJson.intake : [];
    const { profile } = resolveProject({ project: id }, FACTORY_ROOT);
    assert.equal(
      profile.intake.length,
      declared.length,
      `resolved intake length (${profile.intake.length}) ≠ project.json intake length (${declared.length})`,
    );
    for (const it of profile.intake) {
      assert.ok(path.isAbsolute(it.file), `resolved intake file is not absolute: ${it.file}`);
    }
  });

  // 11 — the intake files exist. Same skip logic as test 7 (`path resolves…`):
  // inside an engine worktree the relative profile path under-resolves, so the
  // skip reason must NOT claim the file is missing when it is merely
  // mis-anchored. A profile with no intake passes trivially.
  test(`profile ${id}: intake[] files exist`, (t) => {
    const { profile } = resolveProject({ project: id }, FACTORY_ROOT);
    if (profile.intake.length === 0) return; // no intake → nothing to assert
    const inWorktree = FACTORY_ROOT.split(path.sep).includes(".worktrees");
    for (const it of profile.intake) {
      if (!existsSync(it.file)) {
        t.skip(
          inWorktree
            ? `intake file ${it.file} does not exist — expected inside an engine worktree, where a ` +
              `relative profile path under-resolves. Run from the main factory checkout to assert this.`
            : `intake file not present on this machine: ${it.file}`,
        );
        return;
      }
      assert.ok(existsSync(it.file), `intake file does not exist: ${it.file}`);
    }
  });

  // 12 — canonical e2e gate XOR explicit exemption. House standard
  // (templates/validation.md): every profile's gate[] MUST include its canonical
  // `pnpm test:e2e` (the umbrella that covers the real-infra layer), OR
  // project.json declares a non-empty string `noCanonicalE2E` explaining why the
  // project has none. Exactly one — both present means the exemption went stale;
  // both absent means mocked-green can masquerade as "done".
  test(`profile ${id}: gate[] carries a canonical test:e2e XOR project.json declares noCanonicalE2E`, () => {
    assert.ok(projectJson, "project.json missing or unparseable");
    const gate = Array.isArray(projectJson.gate) ? projectJson.gate : [];
    const hasE2E = gate.some((g) => typeof g === "string" && g.includes("test:e2e"));

    if ("noCanonicalE2E" in projectJson) {
      assert.equal(
        typeof projectJson.noCanonicalE2E,
        "string",
        `noCanonicalE2E is not a string: ${typeof projectJson.noCanonicalE2E}`,
      );
      assert.ok(
        projectJson.noCanonicalE2E.length > 0,
        "noCanonicalE2E is the empty string — an exemption must state its reason",
      );
    }
    const hasExemption =
      typeof projectJson.noCanonicalE2E === "string" && projectJson.noCanonicalE2E.length > 0;

    if (hasE2E) {
      assert.ok(
        !hasExemption,
        "gate[] includes a test:e2e command AND project.json declares noCanonicalE2E — " +
          "the exemption is stale; remove it (rationale: templates/validation.md)",
      );
    } else {
      assert.ok(
        hasExemption,
        "gate[] has no test:e2e command and project.json declares no noCanonicalE2E — " +
          "every profile must run its canonical e2e umbrella or exempt itself explicitly " +
          "(rationale: templates/validation.md)",
      );
    }
  });
}

// ─── Resolver robustness: a corrupt intake[] must never throw ─────────────────
//
// `buildProfile` is private, so exercise it through `resolveProject` against a
// throwaway factoryRoot. The resolver is documented as TOTAL: a non-array
// `intake`, or an entry missing `file`, must degrade to `[]` / drop-the-bad-row
// — never crash a mission. This follows what the code actually does
// (Array.isArray gate + a `.filter` on `typeof it.file === "string"`).

test("resolveProject tolerates a corrupt intake[] without throwing", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "factory-intake-"));
  try {
    // Case A — intake is a string, not an array → profile.intake === [].
    const idA = "intakestring";
    mkdirSync(path.join(tmp, "projects", idA), { recursive: true });
    writeFileSync(
      path.join(tmp, "projects", idA, "project.json"),
      JSON.stringify({ id: idA, intake: "not-an-array" }),
    );

    // Case B — a good entry alongside one missing `file` → the bad one is dropped.
    const idB = "intakebadentry";
    mkdirSync(path.join(tmp, "projects", idB), { recursive: true });
    writeFileSync(
      path.join(tmp, "projects", idB, "project.json"),
      JSON.stringify({
        id: idB,
        intake: [
          { prefix: "NO", label: "missing file" },
          { file: "docs/log.md", prefix: "OK", label: "good" },
        ],
      }),
    );

    let a;
    let b;
    assert.doesNotThrow(() => {
      a = resolveProject({ project: idA }, tmp);
    }, "string intake must not throw");
    assert.doesNotThrow(() => {
      b = resolveProject({ project: idB }, tmp);
    }, "an entry missing `file` must not throw");

    assert.deepEqual(a.profile.intake, [], "a non-array intake must degrade to []");
    assert.equal(b.profile.intake.length, 1, "the entry missing `file` must be dropped, keeping the good one");
    assert.equal(b.profile.intake[0].prefix, "OK", "the surviving entry is the well-formed one");
    assert.ok(path.isAbsolute(b.profile.intake[0].file), "the surviving entry's file resolves absolute");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Part 2 — the meta test: the engine carries no product literals ───────────
//
// Forbidden ids = every discovered profile id EXCEPT `factory` (the engine's own
// dogfood profile legitimately names itself). Test files (`*.test.mjs`) are
// exempt: engine tests may use a real profile id as an opaque fixture, and the
// profiles are checked into this repo. The architectural rule is that SHIPPING
// ENGINE CODE never names a product; this conformance suite is what pins each
// product's actual facts. Exempting tests keeps the rule enforceable instead of
// aspirational.

test("engine sources carry no product literals", () => {
  const forbidden = PROFILE_IDS.filter((id) => id !== "factory");
  assert.ok(
    forbidden.length > 0,
    "no non-factory profiles discovered — the meta test has nothing to enforce",
  );

  // Build the file list from the spec's four scan roots.
  /** @type {string[]} */
  const targets = [];

  // scripts/*.mjs EXCLUDING *.test.mjs
  for (const ent of readdirSync(path.join(FACTORY_ROOT, "scripts"), { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".mjs")) continue;
    if (ent.name.endsWith(".test.mjs")) continue;
    targets.push(path.join(FACTORY_ROOT, "scripts", ent.name));
  }

  // scripts/lib/*.mjs EXCLUDING *.test.mjs (same exemption as scripts/ above)
  const libDir = path.join(FACTORY_ROOT, "scripts", "lib");
  if (existsSync(libDir)) {
    for (const ent of readdirSync(libDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith(".mjs")) continue;
      if (ent.name.endsWith(".test.mjs")) continue;
      targets.push(path.join(libDir, ent.name));
    }
  }

  // templates/* (files only, non-recursive)
  const tplDir = path.join(FACTORY_ROOT, "templates");
  if (existsSync(tplDir)) {
    for (const ent of readdirSync(tplDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      targets.push(path.join(tplDir, ent.name));
    }
  }

  // skills/*/SKILL.md
  const skillsDir = path.join(FACTORY_ROOT, "skills");
  if (existsSync(skillsDir)) {
    for (const ent of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const skillFile = path.join(skillsDir, ent.name, "SKILL.md");
      if (existsSync(skillFile)) targets.push(skillFile);
    }
  }

  // Scan every target line-by-line; record `file:line` for any forbidden-id hit.
  /** @type {string[]} */
  const offenders = [];
  for (const file of targets) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const id of forbidden) {
        if (line.includes(id)) {
          offenders.push(`${path.relative(FACTORY_ROOT, file)}:${i + 1} (id: ${id})`);
        }
      }
    }
  }

  assert.equal(
    offenders.length,
    0,
    `product literals found in engine sources (forbidden ids: ${forbidden.join(", ")}):\n  ${offenders.join("\n  ")}`,
  );
});

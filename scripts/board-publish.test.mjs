/**
 * Tests for the factory board-publish script + deploy artifacts (feature 03).
 *
 *   node --test "scripts/factory/board-publish.test.mjs"
 *
 * Three surfaces:
 *   1. `board-publish.sh --dry-run` — offline; prints the rsync command, exit 0.
 *      Provably no network: we never invoke ssh/rsync, only echo.
 *   2. `board-publish.sh` preflight — `dist/factory-board/index.html` missing →
 *      exit 1 with a hint, before any rsync is constructed.
 *   3. `deploy/docker-compose.yaml` — `docker compose config`
 *      validates the file parses with `FACTORY_BASICAUTH=dummy`. Skipped with a
 *      note when docker is unavailable (the validator machine has it).
 *
 * The dry-run tests run the script with CWD = a tmp dir so the relative
 * `dist/factory-board/index.html` path resolves under the fixture tree and never
 * touches the real repo. The `PUBLISH_HOST` env var is overridden so even the
 * printed command never names a real host.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const BOARD_PUBLISH_SH = path.join(HERE, "board-publish.sh");
const COMPOSE_FILE = path.join(REPO_ROOT, "deploy", "docker-compose.yaml");

function makeTmpRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function mkDist(root) {
  const dir = path.join(root, "dist", "factory-board");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>fixture</title>\n");
  return dir;
}

/**
 * Run board-publish.sh with CWD = root, optionally overriding PUBLISH_* env.
 * Returns the spawnSync result (encoding: utf8).
 */
function runPublish(args, root, envExtra = {}) {
  return spawnSync("bash", [BOARD_PUBLISH_SH, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...envExtra },
  });
}

// ─── 1. dry-run: prints the exact rsync command, no network, exit 0 ─────────

test("dry-run: exit 0, prints 'rsync -az --delete' and the overridden host, no network", () => {
  const root = makeTmpRoot("board-publish-dry-");
  try {
    mkDist(root);
    const r = runPublish(["--dry-run"], root, { PUBLISH_HOST: "testhost" });
    assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /rsync -az --delete/);
    assert.match(r.stdout, /testhost:/);
    // The remote dir default must appear in the printed command (feature 03
    // repointed the publish target from /scrumban/ to the public/ root).
    assert.match(r.stdout, /\/opt\/amiticia\/factory\/public\//);
    assert.doesNotMatch(r.stdout, /\/opt\/amiticia\/factory\/public\/scrumban\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run: PUBLISH_DIR override is reflected in the printed command", () => {
  const root = makeTmpRoot("board-publish-dir-");
  try {
    mkDist(root);
    const r = runPublish(["--dry-run"], root, {
      PUBLISH_HOST: "testhost",
      PUBLISH_DIR: "/tmp/alt-dest/",
    });
    assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /testhost:\/tmp\/alt-dest\//);
    // Default dir must NOT appear when overridden.
    assert.doesNotMatch(r.stdout, /\/opt\/amiticia\/factory\/public\/scrumban\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run: prints the canonical host when PUBLISH_HOST is unset", () => {
  const root = makeTmpRoot("board-publish-default-host-");
  try {
    mkDist(root);
    // Explicitly unset PUBLISH_HOST so the script falls back to its default.
    const env = { ...process.env };
    delete env.PUBLISH_HOST;
    const r = spawnSync("bash", [BOARD_PUBLISH_SH, "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /deploy-host:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 2. preflight: missing dist → exit 1, no rsync attempted ────────────────

test("preflight: missing dist/factory-board/index.html → exit 1 with a hint", () => {
  const root = makeTmpRoot("board-publish-nodist-");
  try {
    // No dist dir created. Even with --dry-run, preflight fires first.
    const r = runPublish(["--dry-run"], root, { PUBLISH_HOST: "testhost" });
    assert.equal(r.status, 1, `exit 1; stdout=${r.stdout} stderr=${r.stderr}`);
    // Hint should mention `pnpm board:report` so the operator knows the fix.
    assert.match(r.stderr, /pnpm board:report/);
    // And it must NOT print a rsync command (preflight failed before building it).
    assert.doesNotMatch(r.stdout, /rsync/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight: a directory in place of index.html is not a false positive", () => {
  const root = makeTmpRoot("board-publish-dir-not-file-");
  try {
    // Create dist/factory-board/index.html as a DIRECTORY → preflight must fail.
    const dir = path.join(root, "dist", "factory-board", "index.html");
    mkdirSync(dir, { recursive: true });
    const r = runPublish(["--dry-run"], root, { PUBLISH_HOST: "testhost" });
    assert.equal(r.status, 1, `exit 1; stdout=${r.stdout} stderr=${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 3. docker-compose.yaml parses with a dummy FACTORY_BASICAUTH ────────────

/**
 * Detect whether the `docker` CLI is available AND the compose plugin works.
 * Returns true if `docker compose` is usable, the string "docker-compose" if
 * only the v1 standalone is present, or null if neither is on PATH.
 */
function dockerComposeAvailable() {
  const probe = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    env: process.env,
  });
  if (probe.status === 0) return true;
  // Some sandboxes ship `docker-compose` (v1) instead of the plugin.
  const probe2 = spawnSync("docker-compose", ["version"], { encoding: "utf8" });
  return probe2.status === 0 ? "docker-compose" : null;
}

test("compose file: exists at deploy/docker-compose.yaml", () => {
  assert.ok(existsSync(COMPOSE_FILE), `compose file present at ${COMPOSE_FILE}`);
});

test("compose file: docker compose config parses with FACTORY_BASICAUTH=dummy (skip if no docker)", {
  skip: dockerComposeAvailable() === null ? "docker not available in this sandbox" : false,
}, () => {
  const r = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "config"], {
    encoding: "utf8",
    env: { ...process.env, FACTORY_BASICAUTH: "dummy:$$apr1$$xyz$$placeholderhash" },
  });
  assert.equal(r.status, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
  // The rendered config must reference the service + the traefik router.
  assert.match(r.stdout, /factory-board/);
  assert.match(r.stdout, /Host\(`factory\.amiticia\.cc`\)/);
  // The basicauth middleware must surface the (masked) users string.
  assert.match(r.stdout, /basicauth/);
});

test("compose file: never commits a real htpasswd hash — placeholder is variable-only", () => {
  assert.ok(existsSync(COMPOSE_FILE));
  const yaml = readFileSyncSafe(COMPOSE_FILE);
  // The compose file MUST reference the variable, never a literal hash.
  assert.match(yaml, /\$\{FACTORY_BASICAUTH\}/);
  // And it must NOT contain an htpasswd-style hash ($apr1$ or $2y$).
  assert.doesNotMatch(yaml, /\$apr1\$/);
  assert.doesNotMatch(yaml, /\$2y\$/);
});

test(".gitignore: deploy/.env is ignored (no real .env ever committed)", () => {
  const gitignore = readFileSyncSafe(path.join(REPO_ROOT, ".gitignore"));
  assert.match(gitignore, /deploy\/\.env/);
});

// ─── helpers ────────────────────────────────────────────────────────────────

function readFileSyncSafe(p) {
  return readFileSync(p, "utf8");
}

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Factory auto-commit helper.
 *
 * Pathspec-limited, soft-fail git commit for factory state files. Used by
 * verdict.mjs and ratify.mjs (and, later, by board-autopublish.mjs bindings)
 * so that mission dossiers — now committed to git — follow every state change
 * without forcing the human to do it by hand.
 *
 * Contract (fixed in factory-live-board/plan.md):
 *   - pathspec-limited: only `factory/missions/<slug>` and `factory/history.jsonl`
 *     are touched, even when the worktree has other dirty files.
 *   - soft-fail: never throws, never returns non-zero, never prints. Any git
 *     error (mid-rebase, detached HEAD, git unavailable, nothing to commit,
 *     not a repo) is a silent skip — the caller's exit code is unaffected.
 *
 * `missionsRoot` follows the same semantics as verdict.mjs / ratify.mjs
 * `--dir`: the missions root. The enclosing git repo (the FACTORY repo) is
 * found by walking up until a `.git` is seen — robust to the `missions/<project>`
 * nesting introduced by the factory extraction. Dossiers + `history.jsonl` live
 * at that git root, so commits land in the factory repo, never in the product.
 *
 * @param {string} missionsRoot — absolute path to `<factoryRoot>/missions/<project>`
 * @param {string} slug — mission slug (names the dir under missionsRoot)
 * @param {string} message — full commit message, already prefixed `chore(factory):`
 * @returns {{ committed: true } | { committed: false, reason: string }}
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** Walk up from `start` to the nearest ancestor containing `.git`, or null. */
function findGitRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function autoCommit(missionsRoot, slug, message) {
  try {
    const repoRoot = findGitRoot(missionsRoot);
    if (!repoRoot) {
      return { committed: false, reason: "not-a-repo" };
    }

    // Candidate pathspecs (repo-relative). git add exits non-zero when ANY
    // pathspec matches nothing on disk, so filter to existing paths — the
    // mission dir always exists (the caller just wrote to it); history.jsonl
    // appears once history snapshots land.
    const candidatePaths = [
      path.relative(repoRoot, path.join(missionsRoot, slug)),
      path.relative(repoRoot, path.join(repoRoot, "history.jsonl")),
    ];
    const paths = candidatePaths.filter((p) => existsSync(path.join(repoRoot, p)));
    if (paths.length === 0) {
      return { committed: false, reason: "nothing-to-commit" };
    }

    // Stage new/modified/deleted files under the pathspec only.
    const add = spawnSync("git", ["add", "-A", "--", ...paths], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (add.status !== 0) {
      return { committed: false, reason: "add-failed" };
    }

    // Commit, pathspec-limited: even if unrelated files were staged by
    // something else, only our paths ship in this commit.
    const commit = spawnSync("git", ["commit", "-m", message, "--", ...paths], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (commit.status === 0) {
      return { committed: true };
    }

    const combined = `${commit.stdout ?? ""}\n${commit.stderr ?? ""}`;
    if (/nothing to commit|no changes|nothing added/i.test(combined)) {
      return { committed: false, reason: "nothing-to-commit" };
    }
    return { committed: false, reason: "commit-rejected" };
  } catch {
    return { committed: false, reason: "exception" };
  }
}

// Integration test for the auto-update committer against REAL git.
// Verifies the core hardening: when the anchor's primary tree is on a feature
// branch, the skills commit lands on `main` (via a dedicated worktree) and never
// on the feature branch. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { refreshAnchorSkills } from "../scripts/linear-watch.mjs";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const g = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("refreshAnchorSkills: commits to main even when a feature branch is checked out", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lw-updater-"));
  try {
    // Bare origin + a working clone ("anchor").
    const origin = path.join(root, "origin.git");
    const anchor = path.join(root, "anchor");
    g(root, "init", "--bare", "-b", "main", origin);
    g(root, "clone", origin, anchor);
    g(anchor, "config", "user.email", "t@t.t");
    g(anchor, "config", "user.name", "t");
    // Seed main with an old skills version.
    fs.mkdirSync(path.join(anchor, ".claude", "skills"), { recursive: true });
    fs.writeFileSync(path.join(anchor, ".claude", "skills", ".sweep-version"), "0.0.1\n");
    g(anchor, "add", "-A");
    g(anchor, "commit", "-m", "seed");
    g(anchor, "push", "origin", "main");
    // Check out a FEATURE branch in the primary tree (the tricky case).
    g(anchor, "checkout", "-b", "COD-1-feature");
    assert.equal(g(anchor, "symbolic-ref", "--short", "HEAD"), "COD-1-feature");

    const res = refreshAnchorSkills(anchor, KIT, "9.9.9");
    assert.equal(res.ok, true, res.reason);
    assert.match(res.reason, /worktree/);

    // main (locally and on origin) has the new version; the feature branch does NOT.
    assert.equal(g(anchor, "show", "main:.claude/skills/.sweep-version").trim(), "9.9.9");
    assert.equal(g(anchor, "show", "origin/main:.claude/skills/.sweep-version").trim(), "9.9.9");
    const onFeature = spawnSync("git", ["show", "COD-1-feature:.claude/skills/.sweep-version"], { cwd: anchor, encoding: "utf8" }).stdout.trim();
    assert.equal(onFeature, "0.0.1"); // feature branch untouched
    // Primary tree is still on the feature branch, and the temp worktree is gone.
    assert.equal(g(anchor, "symbolic-ref", "--short", "HEAD"), "COD-1-feature");
    assert.ok(!fs.existsSync(path.join(anchor, ".worktrees", ".skills-update")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

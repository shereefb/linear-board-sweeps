// Integration test for the auto-update committer against REAL git.
// Verifies the core hardening: when the anchor's primary tree is on a feature
// branch, the skills commit lands on `main` (via a dedicated worktree) and never
// on the feature branch. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { refreshAnchorSkills, runUpdate } from "../scripts/linear-watch.mjs";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const g = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

function gitBlob(cwd, revisionAndPath) {
  const result = spawnSync("git", ["show", revisionAndPath], { cwd, encoding: null });
  if (result.status !== 0) throw new Error(`git show ${revisionAndPath}: ${result.stderr?.toString() || "failed"}`);
  return result.stdout;
}

function runContractHelper(helper, repo, artifactPath, targetRef = "HEAD") {
  const result = spawnSync("node", [helper, "classify", repo, artifactPath, "1.2.0.6", targetRef, "origin/main"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("refreshAnchorSkills: installs the pinned helper for scheduled and manual trust-contract classification", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lw-updater-contract-rollout-"));
  try {
    const origin = path.join(root, "origin.git");
    const anchor = path.join(root, "anchor");
    const publisher = path.join(root, "publisher");
    const scratch = fs.mkdtempSync(path.join(root, "contract-helper-"));
    const helperPath = ".claude/skills/_shared/artifact-contract.mjs";
    const scheduledHelper = path.join(KIT, helperPath);
    const manualHelper = path.join(scratch, "artifact-contract.mjs");
    const canonicalHelper = fs.readFileSync(path.join(KIT, "scripts", "artifact-contract.mjs"));

    assert.equal(fs.readFileSync(path.join(KIT, "VERSION"), "utf8"), "1.2.0.6\n");
    assert.deepEqual(fs.readFileSync(scheduledHelper), canonicalHelper);

    g(root, "init", "--bare", "-b", "main", origin);
    g(root, "clone", origin, anchor);
    g(anchor, "config", "user.email", "t@t.t");
    g(anchor, "config", "user.name", "t");
    fs.mkdirSync(path.join(anchor, ".claude", "skills"), { recursive: true });
    fs.mkdirSync(path.join(anchor, "docs"), { recursive: true });
    fs.writeFileSync(path.join(anchor, ".claude", "skills", ".sweep-version"), "1.2.0.5\n");
    fs.writeFileSync(path.join(anchor, "docs", "legacy.md"), "legacy\n");
    fs.writeFileSync(path.join(anchor, "docs", "incomparable.md"), "before rollout\n");
    g(anchor, "add", "-A");
    g(anchor, "commit", "-m", "pre-rollout");
    g(anchor, "push", "origin", "main");
    g(anchor, "branch", "pre-rollout");

    const refresh = refreshAnchorSkills(anchor, KIT, "1.2.0.6");
    assert.equal(refresh.ok, true, refresh.reason);
    const rollout = g(anchor, "rev-parse", "main");
    const installedHelper = gitBlob(anchor, `${rollout}:${helperPath}`);
    assert.deepEqual(installedHelper, canonicalHelper);
    assert.equal(
      crypto.createHash("sha256").update(installedHelper).digest("hex"),
      crypto.createHash("sha256").update(canonicalHelper).digest("hex"),
    );

    // The card branch begins at R. Its untrusted helper shadows must never be used.
    g(anchor, "checkout", "-b", "COD-159-feature");
    fs.writeFileSync(path.join(anchor, "docs", "current.md"), "after rollout\n");
    g(anchor, "add", "docs/current.md");
    g(anchor, "commit", "-m", "current artifact");
    fs.mkdirSync(path.join(anchor, ".claude", "skills", "_shared"), { recursive: true });
    fs.writeFileSync(path.join(anchor, helperPath), 'process.stdout.write("{\\"status\\":\\"current\\"}\\n")\n');
    fs.writeFileSync(path.join(anchor, "scripts-shadow.txt"), "leave this worktree alone\n");

    // A later origin/main helper is deliberately incompatible; R remains authority.
    g(root, "clone", origin, publisher);
    g(publisher, "config", "user.email", "t@t.t");
    g(publisher, "config", "user.name", "t");
    fs.writeFileSync(path.join(publisher, helperPath), "future helper must not execute\n");
    fs.writeFileSync(path.join(publisher, "future-main.md"), "unrelated main advance\n");
    g(publisher, "add", "-A");
    g(publisher, "commit", "-m", "future main advance");
    g(publisher, "push", "origin", "main");
    g(anchor, "fetch", "origin", "main");

    fs.writeFileSync(manualHelper, installedHelper, { mode: 0o400 });
    assert.equal(
      crypto.createHash("sha256").update(fs.readFileSync(manualHelper)).digest("hex"),
      crypto.createHash("sha256").update(installedHelper).digest("hex"),
    );
    assert.equal(runContractHelper(scheduledHelper, anchor, "docs/legacy.md", "COD-159-feature").status, "legacy");
    assert.equal(runContractHelper(manualHelper, anchor, "docs/current.md", "COD-159-feature").status, "current");
    assert.equal(runContractHelper(manualHelper, anchor, "docs/incomparable.md", "pre-rollout").status, "incomparable");

    assert.equal(g(anchor, "symbolic-ref", "--short", "HEAD"), "COD-159-feature");
    assert.equal(fs.readFileSync(path.join(anchor, helperPath), "utf8"), 'process.stdout.write("{\\"status\\":\\"current\\"}\\n")\n');
    assert.equal(fs.readFileSync(path.join(anchor, "scripts-shadow.txt"), "utf8"), "leave this worktree alone\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

test("refreshAnchorSkills: reuses a clean existing main worktree owned elsewhere", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lw-updater-existing-main-"));
  try {
    const origin = path.join(root, "origin.git");
    const anchor = path.join(root, "anchor");
    const mainOwner = path.join(root, "main owner");
    g(root, "init", "--bare", "-b", "main", origin);
    g(root, "clone", origin, anchor);
    g(anchor, "config", "user.email", "t@t.t");
    g(anchor, "config", "user.name", "t");
    fs.mkdirSync(path.join(anchor, ".claude", "skills"), { recursive: true });
    fs.writeFileSync(path.join(anchor, ".claude", "skills", ".sweep-version"), "0.0.1\n");
    g(anchor, "add", "-A");
    g(anchor, "commit", "-m", "seed");
    g(anchor, "push", "origin", "main");
    g(anchor, "checkout", "-b", "COD-135-feature");
    g(anchor, "worktree", "add", mainOwner, "main");

    const result = refreshAnchorSkills(anchor, KIT, "9.9.6");

    assert.equal(result.ok, true, result.reason);
    assert.match(result.reason, /existing main worktree/);
    assert.equal(g(mainOwner, "show", "HEAD:.claude/skills/.sweep-version"), "9.9.6");
    assert.equal(g(anchor, "show", "origin/main:.claude/skills/.sweep-version"), "9.9.6");
    assert.equal(g(anchor, "show", "COD-135-feature:.claude/skills/.sweep-version"), "0.0.1");
    assert.equal(g(anchor, "symbolic-ref", "--short", "HEAD"), "COD-135-feature");
    assert.ok(fs.existsSync(mainOwner));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refreshAnchorSkills: refuses a dirty existing main worktree without removing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lw-updater-dirty-main-"));
  try {
    const origin = path.join(root, "origin.git");
    const anchor = path.join(root, "anchor");
    const mainOwner = path.join(root, "main-owner");
    g(root, "init", "--bare", "-b", "main", origin);
    g(root, "clone", origin, anchor);
    g(anchor, "config", "user.email", "t@t.t");
    g(anchor, "config", "user.name", "t");
    fs.mkdirSync(path.join(anchor, ".claude", "skills"), { recursive: true });
    fs.writeFileSync(path.join(anchor, ".claude", "skills", ".sweep-version"), "0.0.1\n");
    g(anchor, "add", "-A");
    g(anchor, "commit", "-m", "seed");
    g(anchor, "push", "origin", "main");
    g(anchor, "checkout", "-b", "COD-135-feature");
    g(anchor, "worktree", "add", mainOwner, "main");
    fs.writeFileSync(path.join(mainOwner, "local-note.txt"), "preserve me\n");

    const result = refreshAnchorSkills(anchor, KIT, "9.9.5");

    assert.equal(result.ok, false);
    assert.match(result.reason, /existing main worktree dirty/);
    assert.equal(g(mainOwner, "show", "HEAD:.claude/skills/.sweep-version"), "0.0.1");
    assert.equal(g(anchor, "show", "origin/main:.claude/skills/.sweep-version"), "0.0.1");
    assert.equal(fs.readFileSync(path.join(mainOwner, "local-note.txt"), "utf8"), "preserve me\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const primaryBranch of ["main", "COD-2-feature"]) {
  test(`refreshAnchorSkills: commit-hook failure is reported on ${primaryBranch} without a false push success`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lw-updater-hook-fail-"));
    try {
      const origin = path.join(root, "origin.git");
      const anchor = path.join(root, "anchor");
      g(root, "init", "--bare", "-b", "main", origin);
      g(root, "clone", origin, anchor);
      g(anchor, "config", "user.email", "t@t.t");
      g(anchor, "config", "user.name", "t");
      fs.mkdirSync(path.join(anchor, ".claude", "skills"), { recursive: true });
      fs.writeFileSync(path.join(anchor, ".claude", "skills", ".sweep-version"), "0.0.1\n");
      g(anchor, "add", "-A");
      g(anchor, "commit", "-m", "seed");
      g(anchor, "push", "origin", "main");
      if (primaryBranch !== "main") g(anchor, "checkout", "-b", primaryBranch);
      const hook = path.join(anchor, ".git", "hooks", "pre-commit");
      fs.writeFileSync(hook, "#!/bin/sh\necho hook-secret-token >&2\nexit 1\n", { mode: 0o755 });

      const before = g(anchor, "rev-parse", "main");
      const result = refreshAnchorSkills(anchor, KIT, "9.9.8");

      assert.equal(result.ok, false);
      assert.match(result.reason, /commit failed/i);
      assert.match(result.reason, /hook-secret-token/);
      assert.equal(g(anchor, "rev-parse", "main"), before);
      assert.equal(g(anchor, "show", "main:.claude/skills/.sweep-version"), "0.0.1");
      assert.equal(g(anchor, "rev-parse", "origin/main"), before);
      assert.ok(!fs.existsSync(path.join(anchor, ".worktrees", ".skills-update")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("refreshAnchorSkills: a no-change retry pushes a marker commit left local by an earlier push failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lw-updater-retry-push-"));
  const origin = path.join(root, "origin.git");
  const offlineOrigin = path.join(root, "origin.offline.git");
  try {
    const anchor = path.join(root, "anchor");
    g(root, "init", "--bare", "-b", "main", origin);
    g(root, "clone", origin, anchor);
    g(anchor, "config", "user.email", "t@t.t");
    g(anchor, "config", "user.name", "t");
    fs.mkdirSync(path.join(anchor, ".claude", "skills"), { recursive: true });
    fs.writeFileSync(path.join(anchor, ".claude", "skills", ".sweep-version"), "0.0.1\n");
    g(anchor, "add", "-A");
    g(anchor, "commit", "-m", "seed");
    g(anchor, "push", "origin", "main");
    const remoteBefore = g(anchor, "rev-parse", "origin/main");

    fs.renameSync(origin, offlineOrigin);
    const first = refreshAnchorSkills(anchor, KIT, "9.9.7");
    assert.equal(first.ok, false);
    assert.match(first.reason, /push failed/);
    assert.equal(g(anchor, "show", "HEAD:.claude/skills/.sweep-version"), "9.9.7");
    assert.notEqual(g(anchor, "rev-parse", "HEAD"), remoteBefore);

    fs.renameSync(offlineOrigin, origin);
    const second = refreshAnchorSkills(anchor, KIT, "9.9.7");
    assert.equal(second.ok, true, second.reason);
    assert.match(second.reason, /already current|committed on main/);
    g(anchor, "fetch", "origin", "main");
    assert.equal(g(anchor, "rev-parse", "origin/main"), g(anchor, "rev-parse", "HEAD"));
    assert.equal(g(anchor, "show", "origin/main:.claude/skills/.sweep-version"), "9.9.7");
  } finally {
    if (fs.existsSync(offlineOrigin) && !fs.existsSync(origin)) fs.renameSync(offlineOrigin, origin);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runUpdate: failed kit fetch is reported before merging stale refs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lw-fetch-fail-"));
  try {
    const kit = path.join(root, "kit");
    const isolatedState = path.join(root, "state");
    fs.mkdirSync(kit);
    g(kit, "init", "-b", "main");
    g(kit, "config", "user.email", "t@t.t");
    g(kit, "config", "user.name", "t");
    fs.writeFileSync(path.join(kit, "VERSION"), "1.0.0\n");
    g(kit, "add", "VERSION");
    g(kit, "commit", "-m", "seed kit");

    const failures = [];
    runUpdate(
      { autoUpdate: true, kitPath: kit, kitRef: "main", repos: [] },
      (...args) => failures.push(args),
      { stateDir: isolatedState }
    );

    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].slice(0, 4), [null, "update", "kit-fetch", kit]);
    assert.match(failures[0][4], /kit fetch failed/);
    assert.match(
      fs.readFileSync(path.join(isolatedState, "_", "_", `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`), "utf8"),
      /update: kit fetch failed/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runUpdate: updater tests can isolate state logs away from live launcher state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lw-fetch-fail-"));
  try {
    const kit = path.join(root, "kit");
    const isolatedState = path.join(root, "state");
    const liveLog = path.join(
      os.homedir(),
      ".local",
      "state",
      "linear-board-sweeps",
      "_",
      "_",
      `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`
    );
    const liveBefore = fs.existsSync(liveLog) ? fs.readFileSync(liveLog, "utf8") : null;

    fs.mkdirSync(kit);
    g(kit, "init", "-b", "main");
    g(kit, "config", "user.email", "t@t.t");
    g(kit, "config", "user.name", "t");
    fs.writeFileSync(path.join(kit, "VERSION"), "1.0.0\n");
    g(kit, "add", "VERSION");
    g(kit, "commit", "-m", "seed kit");

    runUpdate(
      { autoUpdate: true, kitPath: kit, kitRef: "main", repos: [] },
      () => {},
      { stateDir: isolatedState }
    );

    const isolatedLog = path.join(isolatedState, "_", "_", `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`);
    assert.match(fs.readFileSync(isolatedLog, "utf8"), /update: kit fetch failed/);
    assert.equal(fs.existsSync(liveLog) ? fs.readFileSync(liveLog, "utf8") : null, liveBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

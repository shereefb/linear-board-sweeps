import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { classifyCorrectnessArtifact } from "../scripts/correctness-boundary.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function commit(repo, message, files) {
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(repo, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

test("pins legacy classification to the 1.2.0.6 installation after later upgrades", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "correctness-boundary-"));
  git(repo, "init", "-q", "--initial-branch=main");
  git(repo, "config", "user.email", "fixture@example.com");
  git(repo, "config", "user.name", "Fixture");

  commit(repo, "legacy artifact", { "docs/legacy.md": "legacy\n" });
  commit(repo, "install rollout", { ".claude/skills/.sweep-version": "1.2.0.6\n" });
  commit(repo, "post-rollout artifact", { "docs/new.md": "new\n" });
  commit(repo, "later kit upgrade", { ".claude/skills/.sweep-version": "9.9.9\n" });

  assert.equal(classifyCorrectnessArtifact(repo, "docs/legacy.md").classification, "legacy");
  assert.equal(classifyCorrectnessArtifact(repo, "docs/new.md").classification, "post-rollout");

  const cli = spawnSync(process.execPath, [
    "scripts/correctness-boundary.mjs", repo, "docs/new.md",
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(cli.status, 3);
  assert.equal(JSON.parse(cli.stdout).classification, "post-rollout");
});

test("fails closed when artifact and rollout histories are incomparable", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "correctness-boundary-diverged-"));
  git(repo, "init", "-q", "--initial-branch=main");
  git(repo, "config", "user.email", "fixture@example.com");
  git(repo, "config", "user.name", "Fixture");
  commit(repo, "base", { "README.md": "base\n" });

  git(repo, "checkout", "-q", "-b", "artifact");
  commit(repo, "artifact", { "docs/diverged.md": "artifact\n" });
  git(repo, "checkout", "-q", "main");
  commit(repo, "rollout", { ".claude/skills/.sweep-version": "1.2.0.6\n" });

  const result = classifyCorrectnessArtifact(repo, "docs/diverged.md", "artifact");
  assert.equal(result.classification, "incomparable");
  assert.match(result.reason, /fail closed/i);

  const cli = spawnSync(process.execPath, [
    "scripts/correctness-boundary.mjs", repo, "docs/diverged.md", "artifact", "main",
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(cli.status, 3);
  assert.equal(JSON.parse(cli.stdout).classification, "incomparable");
});

test("rejects malformed marker bytes and treats artifact paths literally", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "correctness-boundary-literal-"));
  git(repo, "init", "-q", "--initial-branch=main");
  git(repo, "config", "user.email", "fixture@example.com");
  git(repo, "config", "user.name", "Fixture");

  commit(repo, "unrelated legacy doc", { "docs/unrelated.md": "legacy\n" });
  commit(repo, "malformed marker", { ".claude/skills/.sweep-version": " 1.2.0.6 \n" });
  const literalCommit = commit(repo, "literal path", { ":(glob)**.md": "literal\n" });

  const malformed = classifyCorrectnessArtifact(repo, ":(glob)**.md");
  assert.equal(malformed.classification, "missing-history");
  assert.equal(malformed.rolloutCommit, null);

  commit(repo, "exact marker", { ".claude/skills/.sweep-version": "1.2.0.6\n" });
  const literal = classifyCorrectnessArtifact(repo, ":(glob)**.md");
  assert.equal(literal.classification, "legacy");
  assert.equal(literal.artifactCommit, literalCommit);
});

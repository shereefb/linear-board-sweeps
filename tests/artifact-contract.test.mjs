import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyArtifactContract } from "../scripts/artifact-contract.mjs";

const marker = "1.2.0.6";

function git(repo, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function fixtureRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-contract-"));
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Artifact Contract Test"]);
  commitFiles(repo, { "README.md": "fixture\n" }, "initial");
  updateOriginMain(repo);
  return repo;
}

function commitFiles(repo, files, message) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filename = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function removePathAndCommit(repo, relativePath, message) {
  fs.rmSync(path.join(repo, relativePath));
  git(repo, ["add", "-u", "--", relativePath]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function updateOriginMain(repo, ref = "HEAD") {
  git(repo, ["update-ref", "refs/remotes/origin/main", ref]);
}

function classify(repo, artifactPath, options = {}) {
  return classifyArtifactContract({
    repoRoot: repo,
    artifactPath,
    rolloutMarker: marker,
    ...options,
  });
}

test("classifies only a strict pre-marker revision as legacy", () => {
  const repo = fixtureRepo();
  const artifact = commitFiles(repo, { "docs/spec.md": "legacy\n" }, "legacy artifact");
  const rollout = commitFiles(repo, { ".claude/skills/.sweep-version": `${marker}\n` }, "rollout");
  updateOriginMain(repo);

  const result = classify(repo, "docs/spec.md");
  assert.equal(result.status, "legacy");
  assert.equal(result.evidence.artifactRevision, artifact);
  assert.equal(result.evidence.rolloutCommit, rollout);
});

test("classifies artifact changes at and after the rollout as current", () => {
  const repo = fixtureRepo();
  const equal = commitFiles(repo, {
    "docs/equal.md": "changed with rollout\n",
    ".claude/skills/.sweep-version": `${marker}\n`,
  }, "rollout and artifact");
  updateOriginMain(repo);
  assert.equal(classify(repo, "docs/equal.md").status, "current");

  const post = commitFiles(repo, { "docs/post.md": "new after rollout\n" }, "post rollout artifact");
  const result = classify(repo, "docs/post.md");
  assert.equal(result.status, "current");
  assert.equal(result.evidence.artifactRevision, post);
  assert.equal(result.evidence.rolloutCommit, equal);
});

test("allows a long-lived feature target when the original rollout is its ancestor", () => {
  const repo = fixtureRepo();
  commitFiles(repo, { ".claude/skills/.sweep-version": `${marker}\n` }, "rollout");
  updateOriginMain(repo);
  git(repo, ["branch", "feature"]);
  commitFiles(repo, {
    ".claude/skills/.sweep-version": "1.2.0.7\n",
    "main-only.md": "main advanced\n",
  }, "main advances to the next marker");
  updateOriginMain(repo);
  git(repo, ["switch", "feature"]);
  commitFiles(repo, { "docs/feature.md": "feature work\n" }, "feature artifact");

  assert.equal(classify(repo, "docs/feature.md").status, "current");
});

test("fails closed when the rollout is not target ancestry", () => {
  const repo = fixtureRepo();
  git(repo, ["branch", "pre-rollout"]);
  commitFiles(repo, { ".claude/skills/.sweep-version": `${marker}\n` }, "rollout");
  updateOriginMain(repo);
  git(repo, ["switch", "pre-rollout"]);
  commitFiles(repo, { "docs/spec.md": "old branch work\n" }, "old feature artifact");

  const result = classify(repo, "docs/spec.md");
  assert.equal(result.status, "incomparable");
  assert.equal(result.evidence.reason, "rollout commit is not target ancestry");
});

test("fails closed when the original exact marker is interrupted before a later exact marker", () => {
  for (const intermediate of [
    {
      name: "removed",
      commit(repo) {
        removePathAndCommit(repo, ".claude/skills/.sweep-version", "remove marker");
      },
    },
    {
      name: "non-exact",
      commit(repo) {
        commitFiles(repo, { ".claude/skills/.sweep-version": `${marker}\r\n` }, "write non-exact marker");
      },
    },
  ]) {
    const repo = fixtureRepo();
    commitFiles(repo, { ".claude/skills/.sweep-version": marker }, "wrong marker bytes");
    commitFiles(repo, { ".claude/skills/.sweep-version": `${marker}\n` }, "first exact marker");
    intermediate.commit(repo);
    commitFiles(repo, { ".claude/skills/.sweep-version": `${marker}\n`, "docs/new.md": "new\n" }, "restore exact marker and add artifact");
    updateOriginMain(repo);

    const result = classify(repo, "docs/new.md");
    assert.equal(result.status, "incomparable", intermediate.name);
    assert.equal(result.evidence.reason, "rollout marker history is missing or ambiguous", intermediate.name);
    assert.equal(result.evidence.rolloutCommit, null, intermediate.name);
  }
});

test("fails closed for missing, non-regular, renamed, and copied artifacts", () => {
  const missing = fixtureRepo();
  commitFiles(missing, { ".claude/skills/.sweep-version": `${marker}\n` }, "rollout");
  updateOriginMain(missing);
  assert.equal(classify(missing, "docs/missing.md").status, "incomparable");

  const symlink = fixtureRepo();
  commitFiles(symlink, { ".claude/skills/.sweep-version": `${marker}\n`, "docs/source.md": "source\n" }, "rollout");
  fs.mkdirSync(path.join(symlink, "docs"), { recursive: true });
  fs.symlinkSync("source.md", path.join(symlink, "docs/link.md"));
  git(symlink, ["add", "docs/link.md"]);
  git(symlink, ["commit", "-m", "add symlink"]);
  updateOriginMain(symlink);
  assert.equal(classify(symlink, "docs/link.md").status, "incomparable");

  const renamed = fixtureRepo();
  commitFiles(renamed, { "docs/old.md": "legacy\n", ".claude/skills/.sweep-version": `${marker}\n` }, "rollout");
  fs.renameSync(path.join(renamed, "docs/old.md"), path.join(renamed, "docs/new.md"));
  git(renamed, ["add", "-A"]);
  git(renamed, ["commit", "-m", "rename artifact"]);
  updateOriginMain(renamed);
  assert.equal(classify(renamed, "docs/new.md").status, "incomparable");

  const copied = fixtureRepo();
  commitFiles(copied, { "docs/source.md": "same content\n", ".claude/skills/.sweep-version": `${marker}\n` }, "rollout");
  commitFiles(copied, { "docs/copy.md": "same content\n" }, "copy artifact");
  updateOriginMain(copied);
  assert.equal(classify(copied, "docs/copy.md").status, "incomparable");
});

test("fails closed for divergent marker candidates and shallow history", () => {
  const repo = fixtureRepo();
  git(repo, ["branch", "side"]);
  commitFiles(repo, { ".claude/skills/.sweep-version": `${marker}\n` }, "main marker");
  git(repo, ["switch", "side"]);
  commitFiles(repo, { ".claude/skills/.sweep-version": `${marker}\n` }, "side marker");
  git(repo, ["switch", "main"]);
  git(repo, ["merge", "--no-ff", "side", "-m", "merge parallel marker"]);
  updateOriginMain(repo);
  commitFiles(repo, { "docs/spec.md": "after merge\n" }, "artifact");
  assert.equal(classify(repo, "docs/spec.md").status, "incomparable");

  const shallow = classifyArtifactContract({
    repoRoot: repo,
    artifactPath: "docs/spec.md",
    rolloutMarker: marker,
    runGit: () => ({ status: 0, stdout: "true\n", stderr: "" }),
  });
  assert.equal(shallow.status, "incomparable");
  assert.equal(shallow.evidence.reason, "repository history is shallow");
});

test("fails closed for failed or malformed marker tree reads without leaking Git output", () => {
  for (const injectedResponse of [
    { status: 77, stdout: "https://token@example.invalid/marker-read" },
    { status: 0, stdout: "malformed marker entry with secret token" },
  ]) {
    const repo = fixtureRepo();
    commitFiles(repo, { "docs/spec.md": "legacy\n" }, "legacy artifact");
    const originalMarker = commitFiles(repo, { ".claude/skills/.sweep-version": `${marker}\n` }, "first marker");
    removePathAndCommit(repo, ".claude/skills/.sweep-version", "remove marker");
    commitFiles(repo, { ".claude/skills/.sweep-version": `${marker}\n` }, "restore marker");
    updateOriginMain(repo);

    const result = classifyArtifactContract({
      repoRoot: repo,
      artifactPath: "docs/spec.md",
      rolloutMarker: marker,
      runGit: (root, args) => {
        if (args[0] === "ls-tree" && args[2] === originalMarker && args.at(-1) === ":(literal).claude/skills/.sweep-version") {
          return { ...injectedResponse, stderr: "another secret" };
        }
        const response = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        return { status: response.status, stdout: response.stdout, stderr: response.stderr };
      },
    });

    assert.equal(result.status, "incomparable");
    assert.equal(result.evidence.reason, "rollout marker history is missing or ambiguous");
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(JSON.stringify(result).includes("token"), false);
  }
});

test("rejects path, object, snapshot, and failed Git probe attacks without leaking Git output", () => {
  const repo = fixtureRepo();
  commitFiles(repo, { "docs/spec.md": "artifact\n", ".claude/skills/.sweep-version": `${marker}\n` }, "rollout");
  updateOriginMain(repo);

  for (const artifactPath of ["../secret", "/etc/passwd", ":(glob)**", "docs/spec.md\nother"]) {
    const result = classify(repo, artifactPath);
    assert.equal(result.status, "incomparable");
    assert.match(result.evidence.reason, /^invalid artifact path$/);
  }
  assert.equal(classify(repo, "docs/spec.md", { targetRef: "HEAD:docs/spec.md" }).status, "incomparable");

  const calls = [];
  const result = classifyArtifactContract({
    repoRoot: repo,
    artifactPath: "docs/spec.md",
    rolloutMarker: marker,
    runGit: (_root, args) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args.includes("--is-shallow-repository")) {
        return { status: 73, stdout: "https://token@example.invalid/secret", stderr: "secret stderr" };
      }
      throw new Error("unexpected Git call");
    },
  });
  assert.equal(result.status, "incomparable");
  assert.equal(result.evidence.reason, "shallow-history probe failed");
  assert.equal(result.evidence.gitExitCode, 73);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(calls.length, 1);
});

test("returns bounded evidence for an unreadable target ref", () => {
  const result = classifyArtifactContract({
    repoRoot: ".",
    artifactPath: "docs/spec.md",
    rolloutMarker: marker,
    runGit: (_root, args) => {
      if (args.includes("--is-shallow-repository")) return { status: 0, stdout: "false\n", stderr: "" };
      return { status: 129, stdout: "sensitive stdout", stderr: "sensitive stderr" };
    },
  });
  assert.equal(result.status, "incomparable");
  assert.equal(result.evidence.reason, "target ref is not a readable commit");
  assert.equal(result.evidence.gitExitCode, 129);
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
});

test("keeps the installed helper byte-identical to the canonical helper", () => {
  const root = path.resolve(import.meta.dirname, "..");
  assert.deepEqual(
    fs.readFileSync(path.join(root, "scripts/artifact-contract.mjs")),
    fs.readFileSync(path.join(root, ".claude/skills/_shared/artifact-contract.mjs")),
  );
});

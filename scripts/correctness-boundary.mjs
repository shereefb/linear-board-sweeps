#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const CORRECTNESS_ROLLOUT_VERSION = "1.2.0.6";
const MARKER = ".claude/skills/.sweep-version";

function git(repo, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function gitRaw(repo, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function firstExactMarkerCommit(repo, ref) {
  const commits = git(repo, ["log", "--reverse", "--format=%H", ref, "--", MARKER], {
    allowFailure: true,
  }).split("\n").filter(Boolean);

  return commits.find((commit) => (
    gitRaw(repo, ["show", `${commit}:${MARKER}`], { allowFailure: true })
      === `${CORRECTNESS_ROLLOUT_VERSION}\n`
  )) ?? null;
}

function firstArtifactCommit(repo, artifactPath, ref) {
  const commits = git(repo, [
    "log", "--reverse", "--diff-filter=A", "--format=%H", ref, "--", `:(literal)${artifactPath}`,
  ], { allowFailure: true }).split("\n").filter(Boolean);
  return commits[0] ?? null;
}

function isAncestor(repo, ancestor, descendant) {
  try {
    execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export function classifyCorrectnessArtifact(repo, artifactPath, artifactRef = "HEAD", boundaryRef = "HEAD") {
  const rolloutCommit = firstExactMarkerCommit(repo, boundaryRef);
  const artifactCommit = firstArtifactCommit(repo, artifactPath, artifactRef);

  if (!rolloutCommit || !artifactCommit) {
    return {
      classification: "missing-history",
      artifactCommit,
      rolloutCommit,
      reason: "Fail closed: the artifact introduction or exact 1.2.0.6 rollout commit is missing.",
    };
  }
  if (artifactCommit !== rolloutCommit && isAncestor(repo, artifactCommit, rolloutCommit)) {
    return { classification: "legacy", artifactCommit, rolloutCommit, reason: "Artifact predates rollout." };
  }
  if (isAncestor(repo, rolloutCommit, artifactCommit)) {
    return { classification: "post-rollout", artifactCommit, rolloutCommit, reason: "Artifact is at or after rollout." };
  }
  return {
    classification: "incomparable",
    artifactCommit,
    rolloutCommit,
    reason: "Fail closed: artifact and rollout commits are not ancestry-comparable.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repo, artifactPath, artifactRef = "HEAD", boundaryRef = "HEAD"] = process.argv.slice(2);
  if (!repo || !artifactPath) {
    console.error("usage: correctness-boundary.mjs <repo> <artifact-path> [artifact-ref] [boundary-ref]");
    process.exit(2);
  }
  const result = classifyCorrectnessArtifact(repo, artifactPath, artifactRef, boundaryRef);
  console.log(JSON.stringify(result));
  process.exit(result.classification === "legacy" ? 0 : 3);
}

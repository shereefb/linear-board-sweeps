import { spawnSync } from "node:child_process";
import path from "node:path";

const MARKER_PATH = ".claude/skills/.sweep-version";
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function defaultRunGit(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

function run(runGit, repoRoot, args) {
  try {
    const result = runGit(repoRoot, args) ?? {};
    return {
      ok: result.status === 0,
      status: boundedExitCode(result.status),
      stdout: typeof result.stdout === "string" ? result.stdout : typeof result.out === "string" ? result.out : "",
    };
  } catch {
    return { ok: false, status: null, stdout: "" };
  }
}

function boundedExitCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
}

function boundedCommit(value) {
  return typeof value === "string" && COMMIT_PATTERN.test(value) ? value.toLowerCase() : null;
}

function result(status, reason, values = {}) {
  return {
    status,
    evidence: {
      reason,
      targetCommit: boundedCommit(values.targetCommit),
      rolloutCommit: boundedCommit(values.rolloutCommit),
      artifactRevision: boundedCommit(values.artifactRevision),
      gitExitCode: boundedExitCode(values.gitExitCode),
    },
  };
}

function incomparable(reason, values) {
  return result("incomparable", reason, values);
}

function normalizeArtifactPath(artifactPath) {
  if (typeof artifactPath !== "string" || artifactPath.length === 0 || artifactPath.length > 512) return null;
  if (artifactPath.includes("\0") || /[\r\n]/.test(artifactPath) || artifactPath.includes("\\") || path.posix.isAbsolute(artifactPath)) return null;
  const components = artifactPath.split("/");
  if (components.some((part) => part === "" || part === "." || part === ".." || part === ".git" || part.includes(":"))) return null;
  return artifactPath;
}

function validRef(ref) {
  return typeof ref === "string" && ref.length > 0 && ref.length <= 256 && !ref.startsWith("-") && !ref.includes(":") && !/[\0\r\n]/.test(ref);
}

function parseCommitLines(stdout) {
  const commits = stdout.split("\n").filter(Boolean).map(boundedCommit);
  return commits.length > 0 && commits.every(Boolean) ? commits : null;
}

function requireCommit(runGit, repoRoot, ref) {
  if (!validRef(ref)) return { ok: false, status: null };
  const response = run(runGit, repoRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const commit = boundedCommit(response.stdout.trim());
  return response.ok && commit ? { ok: true, commit } : { ok: false, status: response.status };
}

function probeShallowRepository(runGit, repoRoot) {
  const response = run(runGit, repoRoot, ["rev-parse", "--is-shallow-repository"]);
  if (!response.ok) return { ok: false, status: response.status };
  if (response.stdout.trim() !== "true" && response.stdout.trim() !== "false") return { ok: false, status: response.status };
  return { ok: true, shallow: response.stdout.trim() === "true" };
}

function treeEntry(runGit, repoRoot, commit, artifactPath) {
  const response = run(runGit, repoRoot, ["ls-tree", "-z", commit, "--", `:(literal)${artifactPath}`]);
  if (!response.ok) return { ok: false, status: response.status };
  const entries = response.stdout.split("\0").filter(Boolean);
  if (entries.length === 0) return { ok: true, present: false };
  if (entries.length !== 1) return { ok: false, status: response.status };
  const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.+)$/i.exec(entries[0]);
  if (!match || match[4] !== artifactPath) return { ok: false, status: response.status };
  return { ok: true, present: true, mode: match[1], type: match[2], object: match[3] };
}

function requireRegularBlob(runGit, repoRoot, commit, artifactPath) {
  const entry = treeEntry(runGit, repoRoot, commit, artifactPath);
  if (!entry.ok || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
    return { ok: false, status: entry.status, reason: "artifact path is not a regular blob" };
  }
  return { ok: true };
}

function hasExactMarker(runGit, repoRoot, commit, expectedMarker) {
  const entry = treeEntry(runGit, repoRoot, commit, MARKER_PATH);
  if (!entry.ok) return { ok: false, status: entry.status };
  if (!entry.present || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) return { ok: true, matches: false };
  const response = run(runGit, repoRoot, ["show", `${commit}:${MARKER_PATH}`]);
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, matches: response.stdout === expectedMarker };
}

function isAncestor(runGit, repoRoot, older, newer) {
  const response = run(runGit, repoRoot, ["merge-base", "--is-ancestor", older, newer]);
  if (response.status === 0) return true;
  if (response.status === 1) return false;
  return null;
}

function findOriginalMarkerCommit(runGit, repoRoot, trustedCommit, expectedMarker) {
  const revisions = run(runGit, repoRoot, ["rev-list", "--first-parent", "--reverse", trustedCommit]);
  const commits = revisions.ok ? parseCommitLines(revisions.stdout) : null;
  if (!commits) return { ok: false, status: revisions.status };
  for (const commit of commits) {
    const marker = hasExactMarker(runGit, repoRoot, commit, expectedMarker);
    if (!marker.ok) return { ok: false, status: marker.status };
    if (marker.matches) return { ok: true, commit };
  }
  return { ok: true, commit: null };
}

function allExactMarkerCandidatesDescendFrom(runGit, repoRoot, trustedCommit, originalCommit, expectedMarker) {
  const revisions = run(runGit, repoRoot, ["rev-list", trustedCommit]);
  const commits = revisions.ok ? parseCommitLines(revisions.stdout) : null;
  if (!commits) return { ok: false, status: revisions.status };
  for (const commit of commits) {
    const marker = hasExactMarker(runGit, repoRoot, commit, expectedMarker);
    if (!marker.ok) return { ok: false, status: marker.status };
    if (marker.matches && isAncestor(runGit, repoRoot, originalCommit, commit) !== true) return { ok: false, status: null };
  }
  return { ok: true, status: null };
}

function renameOrCopyTouchesArtifact(stdout, artifactPath) {
  const fields = stdout.split("\0");
  let index = 0;
  while (index < fields.length && fields[index] !== "") {
    const status = fields[index++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) return null;
    const paths = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    if (index + paths > fields.length) return null;
    const names = fields.slice(index, index + paths);
    index += paths;
    if ((status.startsWith("R") || status.startsWith("C")) && names.includes(artifactPath)) return true;
  }
  return index === fields.length - 1 || index === fields.length ? false : null;
}

function latestArtifactRevision(runGit, repoRoot, targetCommit, artifactPath) {
  const revisions = run(runGit, repoRoot, ["rev-list", targetCommit, "--", `:(literal)${artifactPath}`]);
  const commits = revisions.ok ? parseCommitLines(revisions.stdout) : null;
  if (!commits) return { ok: false, status: revisions.status, reason: "artifact history is unreadable" };
  for (const commit of commits) {
    const diff = run(runGit, repoRoot, ["diff-tree", "-r", "--root", "--no-commit-id", "--name-status", "-z", "-M", "-C", "--find-copies-harder", commit]);
    const ambiguous = diff.ok ? renameOrCopyTouchesArtifact(diff.stdout, artifactPath) : null;
    if (ambiguous === null) return { ok: false, status: diff.status, reason: "artifact history is unreadable" };
    if (ambiguous) return { ok: false, status: diff.status, reason: "artifact history is ambiguous" };
  }
  return { ok: true, commit: commits[0] };
}

export function classifyArtifactContract({
  repoRoot,
  artifactPath,
  targetRef = "HEAD",
  trustedRolloutRef = "origin/main",
  rolloutMarker,
  runGit = defaultRunGit,
} = {}) {
  const safePath = normalizeArtifactPath(artifactPath);
  if (!safePath) return incomparable("invalid artifact path");
  if (typeof rolloutMarker !== "string" || rolloutMarker.length === 0 || rolloutMarker.length > 128 || /[\0\r\n]/.test(rolloutMarker)) return incomparable("invalid rollout marker");

  const shallow = probeShallowRepository(runGit, repoRoot);
  if (!shallow.ok) return incomparable("shallow-history probe failed", { gitExitCode: shallow.status });
  if (shallow.shallow) return incomparable("repository history is shallow");

  const target = requireCommit(runGit, repoRoot, targetRef);
  if (!target.ok) return incomparable("target ref is not a readable commit", { gitExitCode: target.status });
  const trusted = requireCommit(runGit, repoRoot, trustedRolloutRef);
  if (!trusted.ok) return incomparable("trusted rollout ref is missing", { targetCommit: target.commit, gitExitCode: trusted.status });
  const object = requireRegularBlob(runGit, repoRoot, target.commit, safePath);
  if (!object.ok) return incomparable(object.reason, { targetCommit: target.commit, gitExitCode: object.status });

  const expectedMarker = `${rolloutMarker}\n`;
  const rollout = findOriginalMarkerCommit(runGit, repoRoot, trusted.commit, expectedMarker);
  const markerCandidates = rollout.ok && rollout.commit
    ? allExactMarkerCandidatesDescendFrom(runGit, repoRoot, trusted.commit, rollout.commit, expectedMarker)
    : { ok: false, status: rollout.status };
  if (!rollout.ok || !rollout.commit || !markerCandidates.ok) {
    return incomparable("rollout marker history is missing or ambiguous", { targetCommit: target.commit, gitExitCode: rollout.status ?? markerCandidates.status });
  }
  if (isAncestor(runGit, repoRoot, rollout.commit, target.commit) !== true) {
    return incomparable("rollout commit is not target ancestry", { targetCommit: target.commit, rolloutCommit: rollout.commit });
  }

  const revision = latestArtifactRevision(runGit, repoRoot, target.commit, safePath);
  if (!revision.ok) {
    return incomparable(revision.reason, { targetCommit: target.commit, rolloutCommit: rollout.commit, gitExitCode: revision.status });
  }
  const evidence = { targetCommit: target.commit, rolloutCommit: rollout.commit, artifactRevision: revision.commit };
  if (revision.commit === rollout.commit) return result("current", "artifact revision is the rollout commit", evidence);
  if (isAncestor(runGit, repoRoot, revision.commit, rollout.commit) === true) return result("legacy", "artifact revision predates rollout", evidence);
  if (isAncestor(runGit, repoRoot, rollout.commit, revision.commit) === true) return result("current", "artifact revision follows rollout", evidence);
  return incomparable("artifact and rollout histories are divergent", evidence);
}

function usage() {
  process.stderr.write("Usage: node scripts/artifact-contract.mjs classify <repo-root> <artifact-path> <rollout-marker> [target-ref] [trusted-rollout-ref]\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== "classify" || args.length < 4 || args.length > 6) {
    usage();
    process.exitCode = 2;
  } else {
    const [, repoRoot, artifactPath, rolloutMarker, targetRef, trustedRolloutRef] = args;
    const classification = classifyArtifactContract({ repoRoot, artifactPath, rolloutMarker, targetRef, trustedRolloutRef });
    process.stdout.write(`${JSON.stringify(classification)}\n`);
  }
}

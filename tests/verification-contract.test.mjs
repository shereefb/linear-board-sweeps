import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validatorPath = path.join(repoRoot, "scripts/verification-contract.mjs");
const temporaryPaths = [];

const verificationHeaders = [
  "ID",
  "Source requirement / C ID(s)",
  "Behavior / risk",
  "Failure this proof must catch",
  "Required proof",
  "Acceptance",
];
const traceabilityHeaders = [
  "ID",
  "Implementing task(s)",
  "Test layer and file",
  "RED signal",
  "GREEN command / assertion",
  "QA evidence",
  "Residual gap",
];
const correctnessHeaders = [
  "ID",
  "Trigger / transition",
  "Required invariant",
  "Forbidden outcome",
  "Recovery / ownership",
  "Verification",
];

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function requiredSpec(rows = [["V1", "C1", "creates evidence", "drops a row", "node --test", "row exists"]]) {
  return [
    "Verification contract: verification-contract/v1 — required — behavior changes",
    "",
    "## Correctness contract",
    table(correctnessHeaders, [["C1", "publish", "evidence remains traceable", "lost row", "retry", "test"]]),
    "",
    "## Verification obligations",
    table(verificationHeaders, rows),
  ].join("\n");
}

function canonicalOrderRequiredSpec(rows = [["V1", "C1, C2", "creates evidence", "drops a row", "node --test", "row exists"]]) {
  return [
    "## Correctness contract",
    table(correctnessHeaders, [
      ["C1", "publish", "evidence remains traceable", "lost row", "retry", "test"],
      ["C2", "handoff", "proof remains executable", "skipped proof", "rerun", "test"],
    ]),
    "",
    "## Verification contract",
    "Verification contract: verification-contract/v1 — required — behavior changes",
    "",
    "## Verification obligations",
    table(verificationHeaders, rows),
  ].join("\n");
}

function requiredPlan(rows = [["V1", "Task 2", "tests/verification-contract.test.mjs", "missing row", "node --test", "fixture", "none"]]) {
  return [
    "Verification contract: verification-contract/v1 — required — behavior changes",
    "",
    "## Verification traceability",
    table(traceabilityHeaders, rows),
  ].join("\n");
}

function notRequiredArtifact() {
  return "Verification contract: verification-contract/v1 — not required — docs-only punctuation";
}

function tempDirectory(prefix = "verification-contract-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createGitRepository() {
  const root = tempDirectory();
  git(root, ["init", "-q", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Verification Contract Test"]);
  write(root, "README.md", "fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
}

function commit(root, message, files) {
  for (const [relativePath, contents] of Object.entries(files)) write(root, relativePath, contents);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", message]);
}

function addRollout(root) {
  commit(root, "install verification contract", {
    ".claude/skills/spec-sweep/SKILL.md": "Verification contract: verification-contract/v1\n",
  });
}

function diagnosticCodes(result) {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

afterEach(() => {
  while (temporaryPaths.length) fs.rmSync(temporaryPaths.pop(), { recursive: true, force: true });
});

const validator = await import(validatorPath);

test("validates a required pair and an agreed not-required pair", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, requiredSpec());
  fs.writeFileSync(planPath, requiredPlan());

  const required = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.equal(required.ok, true);
  assert.equal(required.applicability, "required");
  assert.deepEqual(required.verificationIds, ["V1"]);
  assert.deepEqual(required.diagnostics, []);

  fs.writeFileSync(specPath, notRequiredArtifact());
  fs.writeFileSync(planPath, notRequiredArtifact());
  const notRequired = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.equal(notRequired.ok, true);
  assert.equal(notRequired.applicability, "not required");
  assert.deepEqual(notRequired.verificationIds, []);
});

test("validates COD-157's concrete artifacts rather than their template tables", () => {
  const result = validator.validateVerificationContract({
    specPath: path.join(repoRoot, "docs/superpowers/specs/2026-07-10-COD-157-verification-contract-design.md"),
    planPath: path.join(repoRoot, "docs/superpowers/plans/2026-07-10-COD-157-verification-contract-implementation.md"),
    repoRoot,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.verificationIds, ["V1", "V2", "V3", "V4", "V5", "V6"]);
});

test("uses the authoritative contract section and rejects duplicate obligation tables", () => {
  const markdown = [
    "Template:",
    table(verificationHeaders, [["V9", "C9", "template", "template", "template", "template"]]),
    "",
    "## Verification contract",
    "Verification contract: verification-contract/v1 — required — behavior changes",
    table(verificationHeaders, [["V1", "C1", "real", "real", "real", "real"]]),
    "",
    "## Appendix",
    table(verificationHeaders, [["V2", "C2", "duplicate", "duplicate", "duplicate", "duplicate"]]),
  ].join("\n");

  const result = validator.parseVerificationArtifact(markdown, { role: "spec" });
  assert.deepEqual(result.verificationIds, ["V1"]);
  assert.ok(diagnosticCodes(result).includes("duplicate-verification-table"));
});

test("reports missing declaration", () => {
  const result = validator.parseVerificationArtifact("# no contract\n");
  assert.ok(diagnosticCodes(result).includes("missing-declaration"));
});

test("reports duplicate verification IDs", () => {
  const result = validator.parseVerificationArtifact(requiredSpec([
    ["V1", "C1", "a", "b", "c", "d"],
    ["V1", "", "e", "f", "g", "h"],
  ]));
  assert.ok(diagnosticCodes(result).includes("duplicate-verification-id"));
});

test("reports a spec verification ID missing from the plan", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, requiredSpec());
  fs.writeFileSync(planPath, requiredPlan([["V2", "Task 2", "test", "red", "green", "qa", "none"]]));

  const result = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.ok(diagnosticCodes(result).includes("missing-plan-mapping"));
});

test("reads required plan IDs only from verification traceability", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, requiredSpec());
  fs.writeFileSync(planPath, [
    "Verification contract: verification-contract/v1 — required — behavior changes",
    "",
    "## Copied verification obligations",
    table(verificationHeaders, [["V1", "C1", "copied", "copied", "copied", "copied"]]),
    "",
    "## Verification traceability",
    table(traceabilityHeaders, [["V2", "Task 2", "test", "red", "green", "qa", "none"]]),
  ].join("\n"));

  const result = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(diagnosticCodes(result).includes("missing-plan-mapping"));
});

test("ignores incidental verification obligations in a plan", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, requiredSpec());
  fs.writeFileSync(planPath, [
    requiredPlan(),
    "",
    "## Copied verification obligations",
    table(verificationHeaders, [["V9", "C9", "copied", "copied", "copied", "copied"]]),
  ].join("\n"));

  const result = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.equal(result.ok, true);
  assert.ok(!diagnosticCodes(result).includes("invalid-verification-id"));
});

test("reads required spec IDs only from verification obligations", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, [
    requiredSpec([
      ["V1", "C1", "a", "b", "c", "d"],
      ["V2", "", "e", "f", "g", "h"],
    ]),
    "",
    "## Copied verification traceability",
    table(traceabilityHeaders, [["V1", "Task 2", "test", "red", "green", "qa", "none"]]),
  ].join("\n"));
  fs.writeFileSync(planPath, requiredPlan());

  const result = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(diagnosticCodes(result).includes("missing-plan-mapping"));
});

test("rejects plan-only verification IDs", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, requiredSpec());
  fs.writeFileSync(planPath, requiredPlan([
    ["V1", "Task 2", "test", "red", "green", "qa", "none"],
    ["V2", "Task 2", "test", "red", "green", "qa", "none"],
  ]));

  const result = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(diagnosticCodes(result).includes("verification-id-mismatch"));
});

test("rejects arbitrary and nonsequential required verification IDs", () => {
  for (const rows of [
    [["proof-1", "C1", "a", "b", "c", "d"]],
    [
      ["V1", "C1", "a", "b", "c", "d"],
      ["V3", "", "e", "f", "g", "h"],
    ],
  ]) {
    const result = validator.parseVerificationArtifact(requiredSpec(rows));
    assert.ok(diagnosticCodes(result).includes("invalid-verification-id"));
  }
});

test("rejects required contracts with no verification obligations", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, requiredSpec([]));
  fs.writeFileSync(planPath, requiredPlan([]));

  const result = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(diagnosticCodes(result).includes("missing-verification-obligation"));
});

test("rejects a plan verification row without its executable proof fields", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, requiredSpec());
  fs.writeFileSync(planPath, requiredPlan([["V1", "", "", "", "", "", ""]]));

  const result = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(diagnosticCodes(result).includes("incomplete-plan-mapping"));
});

test("rejects a required spec obligation without its executable proof fields", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, requiredSpec([["V1", "C1", "", "", "", ""]]));
  fs.writeFileSync(planPath, requiredPlan());

  const result = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(diagnosticCodes(result).includes("incomplete-verification-obligation"));
});

test("reports a required correctness source absent from every verification row", () => {
  const result = validator.parseVerificationArtifact(requiredSpec([["V1", "", "a", "b", "c", "d"]]));
  assert.ok(diagnosticCodes(result).includes("missing-correctness-source"));
});

test("reports a correctness source repeated across verification rows", () => {
  const result = validator.parseVerificationArtifact(requiredSpec([
    ["V1", "C1", "a", "b", "c", "d"],
    ["V2", "C1", "e", "f", "g", "h"],
  ]));
  assert.ok(diagnosticCodes(result).includes("duplicate-correctness-source"));
});

test("accepts canonical correctness sections when every source is represented once", () => {
  const result = validator.parseVerificationArtifact(canonicalOrderRequiredSpec());
  assert.deepEqual(result.diagnostics, []);
});

test("reports a missing correctness source when canonical sections precede verification", () => {
  const result = validator.parseVerificationArtifact(canonicalOrderRequiredSpec([
    ["V1", "C1", "a", "b", "c", "d"],
  ]));
  assert.ok(diagnosticCodes(result).includes("missing-correctness-source"));
});

test("reports a duplicate correctness source when canonical sections precede verification", () => {
  const result = validator.parseVerificationArtifact(canonicalOrderRequiredSpec([
    ["V1", "C1", "a", "b", "c", "d"],
    ["V2", "C1, C2", "e", "f", "g", "h"],
  ]));
  assert.ok(diagnosticCodes(result).includes("duplicate-correctness-source"));
});

test("ignores C IDs in unrelated tables", () => {
  const markdown = [
    "Verification contract: verification-contract/v1 — required — behavior changes",
    "",
    table(["ID", "Metadata"], [["C1", "not a correctness invariant"]]),
    "",
    table(verificationHeaders, [["V1", "", "a", "b", "c", "d"]]),
  ].join("\n");
  const result = validator.parseVerificationArtifact(markdown);
  assert.ok(!diagnosticCodes(result).includes("missing-correctness-source"));
});

test("classifies an artifact first added before the rollout as legacy", () => {
  const root = createGitRepository();
  commit(root, "add legacy artifact", { "docs/spec.md": "# legacy\n" });
  addRollout(root);

  const result = validator.classifyRolloutHistory({
    repoRoot: root,
    artifactPath: "docs/spec.md",
    skillPath: ".claude/skills/spec-sweep/SKILL.md",
    contractLiteral: "verification-contract/v1",
  });
  assert.equal(result.legacy, true);
  assert.deepEqual(result.diagnostics, []);
});

test("rejects a post-rollout artifact without a declaration", () => {
  const root = createGitRepository();
  addRollout(root);
  commit(root, "add new artifacts", {
    "docs/spec.md": "# missing declaration\n",
    "docs/plan.md": "# missing declaration\n",
  });
  const specPath = path.join(root, "docs/spec.md");
  const planPath = path.join(root, "docs/plan.md");

  const result = validator.validateVerificationContract({ specPath, planPath, repoRoot: root });
  assert.ok(diagnosticCodes(result).includes("post-rollout-missing-contract"));
});

test("rejects a declaration-free plan paired with a required legacy spec", () => {
  const root = createGitRepository();
  commit(root, "add legacy artifacts", {
    "docs/spec.md": requiredSpec(),
    "docs/plan.md": "# missing declaration\n",
  });
  addRollout(root);

  const result = validator.validateVerificationContract({
    specPath: path.join(root, "docs/spec.md"),
    planPath: path.join(root, "docs/plan.md"),
    repoRoot: root,
  });
  assert.equal(result.ok, false);
  assert.ok(diagnosticCodes(result).includes("missing-declaration"));
});

test("fails closed when artifact and rollout commits diverge", () => {
  const root = createGitRepository();
  git(root, ["checkout", "-qb", "artifact"]);
  commit(root, "add artifact", { "docs/spec.md": "# legacy\n" });
  git(root, ["checkout", "-q", "main"]);
  addRollout(root);
  git(root, ["merge", "--no-ff", "-qm", "merge artifact", "artifact"]);

  const result = validator.classifyRolloutHistory({
    repoRoot: root,
    artifactPath: "docs/spec.md",
    skillPath: ".claude/skills/spec-sweep/SKILL.md",
    contractLiteral: "verification-contract/v1",
  });
  assert.equal(result.legacy, false);
  assert.ok(diagnosticCodes(result).includes("incomparable-history"));
});

test("fails closed when the rollout marker commit is missing", () => {
  const root = createGitRepository();
  commit(root, "add artifact", { "docs/spec.md": "# legacy\n" });

  const result = validator.classifyRolloutHistory({
    repoRoot: root,
    artifactPath: "docs/spec.md",
    skillPath: ".claude/skills/spec-sweep/SKILL.md",
    contractLiteral: "verification-contract/v1",
  });
  assert.ok(diagnosticCodes(result).includes("incomparable-history"));
});

test("fails closed for shallow or incomplete history", () => {
  const source = createGitRepository();
  commit(source, "add legacy artifact", { "docs/spec.md": "# legacy\n" });
  addRollout(source);
  const shallow = tempDirectory("verification-contract-shallow-");
  execFileSync("git", ["clone", "--depth=1", `file://${source}`, shallow], { stdio: "ignore" });

  const result = validator.classifyRolloutHistory({
    repoRoot: shallow,
    artifactPath: "docs/spec.md",
    skillPath: ".claude/skills/spec-sweep/SKILL.md",
    contractLiteral: "verification-contract/v1",
  });
  assert.ok(diagnosticCodes(result).includes("incomparable-history"));
});

test("CLI exits zero only for valid contracts and two for malformed input", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, requiredSpec());
  fs.writeFileSync(planPath, requiredPlan());
  const valid = spawnSync(process.execPath, [validatorPath, "validate", "--spec", specPath, "--plan", planPath], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);

  fs.writeFileSync(planPath, "# missing\n");
  const invalid = spawnSync(process.execPath, [validatorPath, "validate", "--spec", specPath, "--plan", planPath], { encoding: "utf8" });
  assert.equal(invalid.status, 2, invalid.stderr);
});

test("CLI rejects unknown, extra, and malformed arguments", () => {
  const root = tempDirectory();
  const specPath = path.join(root, "spec.md");
  const planPath = path.join(root, "plan.md");
  fs.writeFileSync(specPath, requiredSpec());
  fs.writeFileSync(planPath, requiredPlan());

  for (const args of [
    ["validate", "--spec", specPath, "--plan", planPath, "--unknown"],
    ["validate", "--spec", specPath, "--plan", planPath, "extra"],
    ["validate", "--spec", specPath, "--spec", specPath, "--plan", planPath],
    ["validate", "--spec", "--plan", planPath],
  ]) {
    const result = spawnSync(process.execPath, [validatorPath, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr}`);
  }
});

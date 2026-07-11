#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const verificationHeaders = [
  "id",
  "source requirement / c id(s)",
  "behavior / risk",
  "failure this proof must catch",
  "required proof",
  "acceptance",
];
const traceabilityHeaders = [
  "id",
  "implementing task(s)",
  "test layer and file",
  "red signal",
  "green command / assertion",
  "qa evidence",
  "residual gap",
];
const correctnessHeaders = [
  "id",
  "trigger / transition",
  "required invariant",
  "forbidden outcome",
  "recovery / ownership",
  "verification",
];

const normalize = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");
const diagnostic = (code) => ({ code });

function splitTableRow(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function isDivider(cells) {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function markdownTables(markdown) {
  const lines = markdown.split(/\r?\n/);
  const tables = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].trim().startsWith("|") || !lines[index + 1].trim().startsWith("|")) continue;
    const headers = splitTableRow(lines[index]);
    if (!isDivider(splitTableRow(lines[index + 1]))) continue;
    const rows = [];
    let rowIndex = index + 2;
    while (rowIndex < lines.length && lines[rowIndex].trim().startsWith("|")) {
      rows.push(splitTableRow(lines[rowIndex]));
      rowIndex += 1;
    }
    tables.push({ headers: headers.map(normalize), rows });
    index = rowIndex - 1;
  }
  return tables;
}

function tableWithHeaders(tables, expected) {
  return tables.find(({ headers }) => headers.length === expected.length && headers.every((header, index) => header === expected[index]));
}

function idsFromSources(value) {
  return [...value.matchAll(/\bC\d+\b/gi)].map((match) => match[0].toUpperCase());
}

function unique(values) {
  return [...new Set(values)];
}

export function parseVerificationArtifact(markdown) {
  const diagnostics = [];
  const declaration = markdown.match(/verification contract\s*:\s*verification-contract\/v1\s*[—-]\s*(required|not required)\b/i);
  const applicability = declaration?.[1].toLowerCase();
  if (!applicability) return { applicability: null, verificationIds: [], diagnostics: [diagnostic("missing-declaration")] };

  const tables = markdownTables(markdown);
  const obligationTable = tableWithHeaders(tables, verificationHeaders);
  const traceabilityTable = tableWithHeaders(tables, traceabilityHeaders);
  const table = obligationTable ?? traceabilityTable;
  const verificationIds = table ? table.rows.map((row) => row[0].trim().toUpperCase()).filter(Boolean) : [];
  const duplicateIds = verificationIds.filter((id, index) => verificationIds.indexOf(id) !== index);
  if (duplicateIds.length) diagnostics.push(diagnostic("duplicate-verification-id"));

  const correctnessTable = tableWithHeaders(tables, correctnessHeaders);
  const correctnessIds = unique((correctnessTable?.rows ?? []).map((row) => row[0].trim().toUpperCase()).filter((id) => /^C\d+$/.test(id)));
  const sourcesByVerificationId = new Map();
  if (obligationTable) {
    const sourceColumn = verificationHeaders.indexOf("source requirement / c id(s)");
    for (const row of obligationTable.rows) {
      const id = row[0]?.trim().toUpperCase();
      if (id) sourcesByVerificationId.set(id, [...(sourcesByVerificationId.get(id) ?? []), ...idsFromSources(row[sourceColumn] ?? "")]);
    }
  }

  if (applicability === "required") {
    for (const correctnessId of correctnessIds) {
      const count = [...sourcesByVerificationId.values()].flat().filter((id) => id === correctnessId).length;
      if (count === 0) diagnostics.push(diagnostic("missing-correctness-source"));
      if (count > 1) diagnostics.push(diagnostic("duplicate-correctness-source"));
    }
  }

  return {
    applicability,
    verificationIds: unique(verificationIds),
    diagnostics,
    hasObligationTable: Boolean(obligationTable),
    hasTraceabilityTable: Boolean(traceabilityTable),
    traceabilityRows: traceabilityTable?.rows ?? [],
    sourcesByVerificationId,
  };
}

function git(repoRoot, args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout?.trim() ?? "" };
}

function earliestCommit(result) {
  const commits = result.stdout.split(/\s+/).filter(Boolean);
  return commits.at(-1) ?? null;
}

export function classifyRolloutHistory({ repoRoot, artifactPath, skillPath = ".claude/skills/spec-sweep/SKILL.md", contractLiteral = "verification-contract/v1" }) {
  const shallow = git(repoRoot, ["rev-parse", "--is-shallow-repository"]);
  if (!shallow.ok || shallow.stdout !== "false") return { legacy: false, diagnostics: [diagnostic("incomparable-history")] };

  const artifact = git(repoRoot, ["log", "--diff-filter=A", "--follow", "--format=%H", "--", artifactPath]);
  if (!artifact.ok || !earliestCommit(artifact)) return { legacy: false, diagnostics: [diagnostic("incomparable-history")] };

  let rolloutPath = skillPath;
  if (!fs.existsSync(path.join(repoRoot, rolloutPath))) rolloutPath = "skills/spec-sweep/SKILL.md";
  const rollout = git(repoRoot, ["log", `-S${contractLiteral}`, "--format=%H", "--", rolloutPath]);
  if (!rollout.ok || !earliestCommit(rollout)) return { legacy: false, diagnostics: [diagnostic("incomparable-history")] };

  const artifactCommit = earliestCommit(artifact);
  const rolloutCommit = earliestCommit(rollout);
  const artifactBeforeRollout = git(repoRoot, ["merge-base", "--is-ancestor", artifactCommit, rolloutCommit]);
  if (artifactBeforeRollout.status === 0) return { legacy: true, diagnostics: [] };
  const rolloutBeforeArtifact = git(repoRoot, ["merge-base", "--is-ancestor", rolloutCommit, artifactCommit]);
  if (rolloutBeforeArtifact.status === 0) return { legacy: false, diagnostics: [diagnostic("post-rollout-missing-contract")] };
  return { legacy: false, diagnostics: [diagnostic("incomparable-history")] };
}

function readArtifact(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function validateVerificationContract({ specPath, planPath, repoRoot = process.cwd() }) {
  const specMarkdown = readArtifact(specPath);
  const planMarkdown = readArtifact(planPath);
  const spec = parseVerificationArtifact(specMarkdown ?? "");
  const plan = parseVerificationArtifact(planMarkdown ?? "");
  const diagnostics = [...spec.diagnostics, ...plan.diagnostics];

  if (!spec.applicability || !plan.applicability) {
    const histories = [
      classifyRolloutHistory({ repoRoot, artifactPath: path.relative(repoRoot, specPath) }),
      classifyRolloutHistory({ repoRoot, artifactPath: path.relative(repoRoot, planPath) }),
    ];
    const historyDiagnostics = histories.flatMap((history) => history.diagnostics);
    const legacy = histories.every((history) => history.legacy);
    return {
      ok: legacy,
      applicability: null,
      legacy,
      verificationIds: [],
      diagnostics: legacy ? [] : uniqueDiagnostics(historyDiagnostics),
    };
  }

  if (spec.applicability !== plan.applicability) diagnostics.push(diagnostic("applicability-mismatch"));
  if (spec.applicability === "not required" && (spec.hasObligationTable || spec.hasTraceabilityTable || plan.hasObligationTable || plan.hasTraceabilityTable)) {
    diagnostics.push(diagnostic("not-required-has-obligations"));
  }
  if (spec.applicability === "required") {
    if (!spec.verificationIds.length) diagnostics.push(diagnostic("missing-verification-obligation"));
    for (const id of spec.verificationIds) {
      if (!plan.verificationIds.includes(id)) diagnostics.push(diagnostic("missing-plan-mapping"));
    }
    if (!spec.hasObligationTable) diagnostics.push(diagnostic("missing-obligation-table"));
    if (!plan.hasTraceabilityTable) diagnostics.push(diagnostic("missing-plan-mapping"));
    if (plan.traceabilityRows.some((row) => row.length !== traceabilityHeaders.length || row.some((value) => !value.trim()))) {
      diagnostics.push(diagnostic("incomplete-plan-mapping"));
    }
  }

  const normalizedDiagnostics = uniqueDiagnostics(diagnostics);
  return {
    ok: normalizedDiagnostics.length === 0,
    applicability: spec.applicability,
    legacy: false,
    verificationIds: spec.verificationIds,
    diagnostics: normalizedDiagnostics,
  };
}

function uniqueDiagnostics(diagnostics) {
  return diagnostics.filter((item, index) => diagnostics.findIndex((candidate) => candidate.code === item.code) === index);
}

function parseCli(args) {
  if (args[0] !== "validate") return null;
  const specIndex = args.indexOf("--spec");
  const planIndex = args.indexOf("--plan");
  if (specIndex === -1 || planIndex === -1 || !args[specIndex + 1] || !args[planIndex + 1]) return null;
  return { specPath: args[specIndex + 1], planPath: args[planIndex + 1] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseCli(process.argv.slice(2));
  if (!options) {
    process.stderr.write("usage: verification-contract.mjs validate --spec <path> --plan <path>\n");
    process.exitCode = 2;
  } else {
    const result = validateVerificationContract(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 2;
  }
}

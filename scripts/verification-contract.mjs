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
    tables.push({ headers: headers.map(normalize), rows, startLine: index });
    index = rowIndex - 1;
  }
  return tables;
}

function sectionStart(markdown, heading) {
  return markdown.split(/\r?\n/).reduce(
    (startLine, line, index) => heading.test(line) ? index : startLine,
    -1,
  );
}

function tablesWithHeaders(tables, expected, contractStart) {
  return tables.filter(({ headers, startLine }) => (
    (contractStart < 0 || startLine > contractStart)
    && headers.length === expected.length
    && headers.every((header, index) => header === expected[index])
  ));
}

function idsFromSources(value) {
  return [...value.matchAll(/\bC\d+\b/gi)].map((match) => match[0].toUpperCase());
}

function unique(values) {
  return [...new Set(values)];
}

function hasStableVerificationIds(ids) {
  return ids.every((id, index) => id === `V${index + 1}`);
}

export function parseVerificationArtifact(markdown, { role } = {}) {
  const diagnostics = [];
  const declaration = markdown.match(/verification contract\s*:\s*verification-contract\/v1\s*[—-]\s*(required|not required)\b/i);
  const applicability = declaration?.[1].toLowerCase();
  if (!applicability) return { applicability: null, verificationIds: [], diagnostics: [diagnostic("missing-declaration")] };

  const tables = markdownTables(markdown);
  const verificationStart = sectionStart(markdown, /^#{1,6}\s+verification contract(?:\b|\s)/i);
  const correctnessStart = sectionStart(markdown, /^#{1,6}\s+correctness contract(?:\b|\s)/i);
  const obligationTables = tablesWithHeaders(tables, verificationHeaders, verificationStart);
  const traceabilityTables = tablesWithHeaders(tables, traceabilityHeaders, verificationStart);
  const obligationTable = obligationTables[0];
  const traceabilityTable = traceabilityTables[0];
  if (obligationTables.length > 1 || traceabilityTables.length > 1) diagnostics.push(diagnostic("duplicate-verification-table"));
  const idsFromTable = (table) => table ? table.rows.map((row) => row[0].trim().toUpperCase()).filter(Boolean) : [];
  const obligationIds = role === "plan" ? [] : idsFromTable(obligationTable);
  const traceabilityIds = idsFromTable(traceabilityTable);
  const verificationIds = role === "plan" ? traceabilityIds : obligationTable ? obligationIds : traceabilityIds;
  const duplicateIds = verificationIds.filter((id, index) => verificationIds.indexOf(id) !== index);
  if (duplicateIds.length) diagnostics.push(diagnostic("duplicate-verification-id"));
  if (applicability === "required" && !hasStableVerificationIds(verificationIds)) diagnostics.push(diagnostic("invalid-verification-id"));

  const correctnessTable = tablesWithHeaders(tables, correctnessHeaders, correctnessStart)[0];
  const correctnessIds = unique((correctnessTable?.rows ?? []).map((row) => row[0].trim().toUpperCase()).filter((id) => /^C\d+$/.test(id)));
  const sourcesByVerificationId = new Map();
  if (role !== "plan" && obligationTable) {
    const sourceColumn = verificationHeaders.indexOf("source requirement / c id(s)");
    for (const row of obligationTable.rows) {
      const id = row[0]?.trim().toUpperCase();
      if (id) sourcesByVerificationId.set(id, [...(sourcesByVerificationId.get(id) ?? []), ...idsFromSources(row[sourceColumn] ?? "")]);
    }
  }

  if (applicability === "required" && role !== "plan") {
    if (obligationTable?.rows.some((row) => row.length !== verificationHeaders.length || row.some((value) => !value.trim()))) {
      diagnostics.push(diagnostic("incomplete-verification-obligation"));
    }
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
    hasObligationTable: role !== "plan" && Boolean(obligationTable),
    hasTraceabilityTable: Boolean(traceabilityTable),
    obligationIds,
    traceabilityRows: traceabilityTable?.rows ?? [],
    traceabilityIds,
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
  const spec = parseVerificationArtifact(specMarkdown ?? "", { role: "spec" });
  const plan = parseVerificationArtifact(planMarkdown ?? "", { role: "plan" });
  const diagnostics = [...spec.diagnostics, ...plan.diagnostics];

  if (!spec.applicability || !plan.applicability) {
    if (spec.applicability || plan.applicability) {
      return {
        ok: false,
        applicability: spec.applicability ?? plan.applicability,
        legacy: false,
        verificationIds: [],
        diagnostics: uniqueDiagnostics(diagnostics),
      };
    }
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
    const specVerificationIds = spec.obligationIds;
    const planVerificationIds = plan.traceabilityIds;
    if (!specVerificationIds.length) diagnostics.push(diagnostic("missing-verification-obligation"));
    if (!hasStableVerificationIds(specVerificationIds) || !hasStableVerificationIds(planVerificationIds)) diagnostics.push(diagnostic("invalid-verification-id"));
    if (specVerificationIds.length !== planVerificationIds.length || specVerificationIds.some((id, index) => id !== planVerificationIds[index])) {
      diagnostics.push(diagnostic("verification-id-mismatch"));
    }
    for (const id of specVerificationIds) {
      if (!planVerificationIds.includes(id)) diagnostics.push(diagnostic("missing-plan-mapping"));
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
    verificationIds: spec.applicability === "required" ? spec.obligationIds : spec.verificationIds,
    diagnostics: normalizedDiagnostics,
  };
}

function uniqueDiagnostics(diagnostics) {
  return diagnostics.filter((item, index) => diagnostics.findIndex((candidate) => candidate.code === item.code) === index);
}

function parseCli(args) {
  if (args.length !== 5 || args[0] !== "validate" || args[1] !== "--spec" || args[3] !== "--plan") return null;
  const [, , specPath, , planPath] = args;
  if (!specPath || !planPath || specPath.startsWith("--") || planPath.startsWith("--")) return null;
  return { specPath, planPath };
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

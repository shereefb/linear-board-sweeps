import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path);
const text = (path) => read(path).toString("utf8");
const skill = Object.fromEntries(["spec", "dev", "qa"].map((stage) => [
  stage, text(`skills/${stage}-sweep/SKILL.md`),
]));

test("Spec declares a risk-proportional performance contract", () => {
  assert.match(skill.spec, /Performance contract: performance-contract\/v1[^\n]*required \| not required/i);
  assert.match(skill.spec, /actual performance surface[^]*labels[^]*(candidate|not proof)/i);
  assert.match(skill.spec, /Tier 0[^]*performance[^]*(escalate|at least Tier 1)/i);
  assert.match(skill.spec, /Workload \/ critical path[^]*Proof kind[^]*Budget or hard bound[^]*Measurement \/ fixture[^]*Degradation \/ abort behavior[^]*Owner \/ observation/i);
});

test("Plan traceability keeps proof kinds closed", () => {
  assert.match(skill.spec, /Every P ID must select exactly one proof kind: `?measured`? \| `?deterministic-bound`?/i);
  assert.match(skill.spec, /(missing|multiple|other)[^]*proof kind[^]*(reject|invalid|fail closed)/i);
  assert.match(skill.spec, /Performance traceability[^]*Proof kind[^]*Implementing task[^]*Proof command \/ fixture[^]*Expected evidence and pass condition[^]*QA observation[^]*Residual risk/i);
  assert.match(skill.spec, /measured[^]*environment[^]*baseline[^]*candidate[^]*statistic[^]*threshold[^]*result/i);
  assert.match(skill.spec, /deterministic-bound[^]*declared bound[^]*assertion command[^]*observed maximum[^]*pass\/fail/i);
  assert.match(skill.spec, /(Neither|must not)[^]*fabricat[^]*other proof kind/i);
});

test("Dev binds proof to the pushed commit", () => {
  assert.match(skill.dev, /performance-contract\/v1/i);
  assert.match(skill.dev, /tested commit SHA[^]*P[^]*command[^]*(output|result)[^]*(environment|assumptions)[^]*proof kind/i);
  assert.match(skill.dev, /material[^]*(missing budget|invalid fixture|contract defect)[^]*review\/performance[^]*(bounce|Spec)/i);
  assert.match(skill.dev, /Code review[^]*run BOTH/i);
});

test("QA validates identity and invalidates stale proof", () => {
  assert.match(skill.qa, /performance-contract\/v1/i);
  assert.match(skill.qa, /(rerun|re-run)[^]*reproduc/i);
  assert.match(skill.qa, /cited SHA[^]*(tested commit|ancestor)[^]*affected[^]*path/i);
  assert.match(skill.qa, /QA fix[^]*P[^]*path[^]*invalidat[^]*(rerun|return to Dev)/i);
  assert.match(skill.qa, /required[^]*P[^]*(missing|failed|contradict)[^]*do not[^]*qa:passed/i);
});

test("one shared legacy boundary composes in either order", () => {
  const joined = `${skill.spec}\n${skill.dev}`;
  assert.match(joined, /Versioned contract boundary: versioned-contract-boundary\/v1/i);
  assert.match(joined, /(one|single) shared/i);
  assert.match(joined, /artifact[^]*first introduced[^]*\.sweep-version/i);
  assert.match(joined, /git log[^]*--diff-filter=A[^]*\.sweep-version/i);
  assert.match(joined, /git merge-base --is-ancestor/i);
  assert.match(joined, /(performance.*first|COD-158.*first)[^]*(install|create)[^]*shared/i);
  assert.match(joined, /(correctness.*present|COD-155.*first)[^]*(reuse|extend)[^]*shared/i);
  assert.match(joined, /missing or incomparable[^]*fail closed/i);
  assert.match(skill.dev, /versioned-contract-boundary\/v1[^]*missing or incomparable[^]*fail closed/i);
});

test("canonical and installed skills are exact bytes", () => {
  for (const stage of ["spec", "dev", "qa"]) {
    assert.deepEqual(
      read(`.claude/skills/${stage}-sweep/SKILL.md`),
      read(`skills/${stage}-sweep/SKILL.md`),
      `${stage}-sweep copies differ`,
    );
  }
});

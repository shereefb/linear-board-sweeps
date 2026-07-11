import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const spec = read("skills/spec-sweep/SKILL.md");
const dev = read("skills/dev-sweep/SKILL.md");
const qa = read("skills/qa-sweep/SKILL.md");

test("spec-sweep emits a risk-linked verification contract", () => {
  assert.match(spec, /Verification contract: verification-contract\/v1[^\n]*(?:required|not required)/i);
  assert.match(spec, /Source requirement \/ C ID\(s\)[^]*Behavior \/ risk[^]*Failure this proof must catch[^]*Required proof[^]*Acceptance/i);
  assert.match(spec, /stable `?V1\.\.Vn`? IDs|stable V1\.\.Vn IDs/i);
  assert.match(spec, /Tier 0[^]*at least Tier 1/i);
});

test("plans make every verification obligation executable", () => {
  assert.match(spec, /Verification traceability[^]*Implementing task[^]*Test layer and file[^]*RED signal[^]*GREEN command \/ assertion[^]*QA evidence[^]*Residual gap/i);
  assert.match(spec, /broad[^]*full-suite command[^]*named assertion/i);
  assert.match(spec, /manual QA[^]*races[^]*atomicity[^]*persistence/i);
});

test("dev-sweep enforces rollout and executes narrow proofs before review", () => {
  assert.match(dev, /verification-contract\/v1/i);
  assert.match(dev, /first[- ]add commit[^]*\.sweep-version[^]*rollout boundary/i);
  assert.match(dev, /proven[^]*older[^]*legacy[^]*post-boundary[^]*fail closed[^]*incomparable[^]*fail closed/i);
  assert.match(dev, /map every[^]*V1\.\.Vn[^]*actual diff[^]*narrow proof/i);
  assert.match(dev, /review\/test-gap[^]*missing-design/i);
  assert.match(dev, /Code review[^]*run BOTH/i);
});

test("qa-sweep consumes verification IDs without faking low-level coverage", () => {
  assert.match(qa, /verification-contract\/v1/i);
  assert.match(qa, /V1\.\.Vn|verification ID/i);
  assert.match(qa, /cannot be induced safely[^]*lower-level[^]*nearest public outcome/i);
  assert.match(qa, /every[^]*V1\.\.Vn[^]*disposition[^]*missing[^]*do not[^]*qa:passed/i);
});

test("review findings remain structured evidence", () => {
  for (const text of [spec, dev, qa]) {
    assert.match(text, /review[^]*test-gap/i);
  }
});

test("canonical and installed verification-contract skills remain identical", () => {
  for (const sweep of ["spec", "dev", "qa"]) {
    assert.equal(
      read(`.claude/skills/${sweep}-sweep/SKILL.md`),
      read(`skills/${sweep}-sweep/SKILL.md`),
      `${sweep}-sweep copies differ`,
    );
  }
});

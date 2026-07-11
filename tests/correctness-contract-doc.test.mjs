import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const spec = read("skills/spec-sweep/SKILL.md");
const dev = read("skills/dev-sweep/SKILL.md");
const qa = read("skills/qa-sweep/SKILL.md");

test("spec-sweep emits a versioned, risk-proportional correctness contract", () => {
  assert.match(spec, /Correctness contract: correctness-contract\/v1[^\n]*required \| not required/i);
  assert.match(spec, /Trigger \/ transition[^]*Required invariant[^]*Forbidden outcome[^]*Recovery \/ ownership[^]*Verification/i);
  assert.match(spec, /before[^]*selected review/i);
  assert.match(spec, /Tier 0[^]*not required[^]*material invariant[^]*at least Tier 1/i);
  assert.match(spec, /Correctness traceability[^]*implementing task[^]*test \/ assertion[^]*QA observation[^]*residual risk/i);
});

test("dev-sweep executes declared proofs without replacing or hiding review", () => {
  assert.match(dev, /correctness-contract\/v1/i);
  assert.match(dev, /artifact[^]*first introduced[^]*\.sweep-version[^]*rollout boundary/i);
  assert.match(dev, /missing or incomparable[^]*fail closed[^]*missing-design/i);
  assert.match(dev, /execute[^]*declared[^]*proof/i);
  assert.match(dev, /material[^]*contract omission[^]*review\/correctness[^]*missing-design/i);
  assert.match(dev, /not[^]*third review|not[^]*review pass/i);
  assert.match(dev, /Code review[^]*run BOTH/i);
});

test("qa-sweep consumes invariant evidence honestly", () => {
  assert.match(qa, /correctness-contract\/v1/i);
  assert.match(qa, /invariant ID/i);
  assert.match(qa, /cannot be reliably observed[^]*lower-level test evidence/i);
  assert.match(qa, /required[^]*no invariant coverage[^]*do not[^]*qa:passed/i);
});

test("canonical and installed correctness-contract skills remain identical", () => {
  for (const sweep of ["spec", "dev", "qa"]) {
    assert.equal(
      read(`.claude/skills/${sweep}-sweep/SKILL.md`),
      read(`skills/${sweep}-sweep/SKILL.md`),
      `${sweep}-sweep copies differ`,
    );
  }
});

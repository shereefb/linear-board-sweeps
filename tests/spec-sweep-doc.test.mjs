import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const canonicalPath = "skills/spec-sweep/SKILL.md";
const installedPath = ".claude/skills/spec-sweep/SKILL.md";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

test("spec-sweep copies share the adaptive review-depth contract", () => {
  const canonical = read(canonicalPath);
  const installed = read(installedPath);
  assert.equal(installed, canonical);

  assert.match(canonical, /Tier 0[^]*zero engineering-review passes/i);
  assert.match(canonical, /Tier 1[^]*exactly one engineering-review pass/i);
  assert.match(canonical, /Tier 2[^]*both engineering-review passes/i);
  assert.match(canonical, /spec pass[^]*plan pass/i);
  assert.match(canonical, /predicted file[^]*evidence[^]*not[^]*classifier/i);
});

test("spec-sweep reassesses monotonically after plan generation", () => {
  const body = read(canonicalPath);
  const classifyAt = body.indexOf("Classify review depth");
  const planAt = body.indexOf("Write the implementation plan");
  const reassessAt = body.indexOf("Reassess review depth");
  const landAt = body.indexOf("## 3. Land it");

  assert.ok(classifyAt >= 0 && classifyAt < planAt);
  assert.ok(planAt < reassessAt && reassessAt < landAt);
  assert.match(body, /may stay the same or increase[^]*never decrease/i);
  assert.match(body, /run every newly required review/i);
  assert.match(body, /Tier 1 plan target[^]*after plan generation[^]*plan pass[^]*independent adversarial reviewer/i);
  assert.match(body, /final tier[^]*clear[^]*no unresolved decisions/i);
});

test("spec-sweep keeps safety floors and material lens gating", () => {
  const body = read(canonicalPath);
  assert.match(body, /Tier 0[^]*no material[^]*(auth|security)[^]*data integrity[^]*external input[^]*concurrency/i);
  assert.match(body, /security[^]*performance[^]*mandatory regardless of engineering-review tier/i);
  assert.match(body, /performance-sensitive work[^]*cannot be Tier 0[^]*plan-eng-review[^]*performance[^]*benchmark/i);
  assert.match(body, /domain labels[^]*candidate[^]*material/i);
  assert.match(body, /pure copy[^]*spacing[^]*skip[^]*plan-design-review/i);
});

test("operator docs explain adaptive spec review depth", () => {
  assert.match(read("README.md"), /adaptive review depth/i);
  assert.match(read("docs/linear-rules.md"), /Tier 0[^]*Tier 1[^]*Tier 2/i);
});

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

test("scope closure is risk-proportional and precedes review selection", () => {
  const body = read(canonicalPath);
  const brainstormAt = body.indexOf("Brainstorm the spec");
  const scopeAt = body.indexOf("Scope closure: scope-closure/v1");
  const classifyAt = body.indexOf("Classify review depth");
  assert.ok(brainstormAt >= 0 && brainstormAt < scopeAt && scopeAt < classifyAt);
  assert.match(body, /required \| not required[^]*concrete[^]*Tier 0/i);
  assert.match(body, /S1\.\.Sn[^]*Surface and evidence[^]*Required outcome[^]*Owning repo\/module[^]*Closure proof/i);
  assert.match(body, /do not add ceremonial[^]*inapplicable/i);
});

test("scope closure traces both directions and composes with correctness", () => {
  const body = read(canonicalPath);
  assert.match(body, /run scope closure first[^]*correctness applicability/i);
  assert.match(body, /S[^]*row[^]*reference[^]*C[^]*IDs[^]*rather than duplicate/i);
  assert.match(body, /every[^]*S[^]*row[^]*implementing task[^]*proof/i);
  assert.match(body, /every planned task[^]*map[^]*S[^]*row/i);
  assert.match(body, /plan task[^]*new surface[^]*add[^]*S[^]*row[^]*reassess/i);
});

test("scope closure preserves evidence and fails the terminal gate closed", () => {
  const body = read(canonicalPath);
  assert.match(body, /pre-review-self-check[^]*review\/scope-gap|review\/scope-gap[^]*pre-review-self-check/i);
  assert.match(body, /never[^]*(suppress|recategorize)[^]*scope-gap/i);
  assert.match(body, /procedural[^]*independent reviewer/i);
  assert.match(body, /terminal review gate[^]*(absent|unmapped|contradictory|unresolved)/i);
});

test("spec-sweep runs a launcher-source exact-pair verification gate before landing", () => {
  const body = read(canonicalPath);
  const reassessAt = body.indexOf("Reassess review depth");
  const gateAt = body.indexOf("launcher-source verification-contract validator");
  const landAt = body.indexOf("## 3. Land it");
  assert.ok(reassessAt < gateAt && gateAt < landAt);
  assert.match(body, /node "\$AUTO_SWEEP_KIT_PATH\/scripts\/verification-contract\.mjs" validate[^]*--spec "\$SPEC_PATH"[^]*--plan "\$PLAN_PATH"/i);
  assert.match(body, /attended[^]*configured anchor[^]*regular readable[^]*scripts\/verification-contract\.mjs/i);
  assert.match(body, /exit 0[^]*readable[^]*ok:\s*true/i);
  assert.match(body, /nonzero[^]*invalid JSON[^]*ok !== true[^]*signal[^]*missing helper[^]*unreadable artifact/i);
  assert.match(body, /same exact paths[^]*repair[^]*rerun/i);
});

test("spec-sweep repairs verification defects without weakening downstream evidence", () => {
  const body = read(canonicalPath);
  assert.match(body, /review\/test-gap[^]*repair[^]*affected review[^]*rerun/i);
  assert.match(body, /owner-only[^]*blocked:open-questions/i);
  assert.match(body, /close\/release[^]*child-outcome terminal-failed verification-contract-gate[^]*without a card comment[^]*human-block/i);
  assert.match(body, /Dev[^]*validator[^]*missing-design/i);
});

test("spec-sweep defers before material work without launcher outcome capability", () => {
  const body = read(canonicalPath);
  assert.match(body, /AUTO_SWEEP_CHILD_OUTCOME_VERSION=1[^]*immediately after[^]*dependency[^]*routing preflight/i);
  assert.match(body, /clean\+pushed[^]*without closing the claim/i);
  assert.match(body, /dependency-deferred[^]*launcher-capability/i);
  assert.match(body, /node "\$AUTO_SWEEP_KIT_PATH\/scripts\/linear-watch\.mjs" child-outcome dependency-deferred launcher-capability/i);
  assert.match(body, /exclusively creates[^]*bytes are identical[^]*conflict/i);
  assert.match(body, /dependencyExitCode[^]*3[^]*reason[^]*launcher-capability[^]*blockers/i);
  assert.match(body, /no Linear dependency[^]*human-block label/i);
});

# COD-130 Adaptive Spec-Sweep Review Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make spec-sweep choose and audit zero, one, or two engineering-review passes based on feature scope and risk, with monotonic escalation after plan generation.

**Architecture:** Keep the policy in the canonical cross-runtime spec-sweep skill rather than adding runtime code or configuration. A focused Node documentation test treats the two installed/distributed skill copies as one contract and locks the classifier, sequencing, safety floors, specialized-lens materiality, and terminal gate. README and board rules summarize the operator-visible behavior.

**Tech Stack:** Markdown cross-runtime skills and documentation; Node.js `node:test` regression tests.

## Global Constraints

- Spec-sweep stays docs-only and unattended.
- Review depth is judgment-based; predicted file/line counts are evidence, not a numeric scoring engine.
- Tier 0 runs zero engineering reviews, Tier 1 runs one targeted review, and Tier 2 runs both spec and plan reviews.
- Material auth/security/data/external-input/performance risks keep their specialized gates regardless of tier.
- Post-plan review depth may stay level or increase, never decrease.
- The card reaches Dev only after every review required by its final tier is clear and no unresolved decisions remain.
- `skills/spec-sweep/SKILL.md` and `.claude/skills/spec-sweep/SKILL.md` must be byte-identical after this change.
- Preserve the distributed skill’s existing repo-ownership safeguards while reconciling the already-present copy drift.

---

### Task 1: Lock the Adaptive Review Contract with a Failing Test

**Files:**
- Create: `tests/spec-sweep-doc.test.mjs`
- Read: `skills/spec-sweep/SKILL.md`
- Read: `.claude/skills/spec-sweep/SKILL.md`
- Read: `README.md`
- Read: `docs/linear-rules.md`

**Interfaces:**
- Consumes: the current Markdown content of the canonical skill, installed skill, README, and board rules.
- Produces: a regression contract that fails until both skill copies and operator docs describe adaptive review depth.

- [ ] **Step 1: Write the focused documentation test**

Create `tests/spec-sweep-doc.test.mjs` with real file reads and assertions:

```js
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
  assert.match(body, /final tier[^]*clear[^]*no unresolved decisions/i);
});

test("spec-sweep keeps safety floors and material lens gating", () => {
  const body = read(canonicalPath);
  assert.match(body, /Tier 0[^]*no material[^]*(auth|security)[^]*data integrity[^]*external input[^]*concurrency/i);
  assert.match(body, /security[^]*performance[^]*mandatory regardless of engineering-review tier/i);
  assert.match(body, /domain labels[^]*candidate[^]*material/i);
  assert.match(body, /pure copy[^]*spacing[^]*skip[^]*plan-design-review/i);
});

test("operator docs explain adaptive spec review depth", () => {
  assert.match(read("README.md"), /adaptive review depth/i);
  assert.match(read("docs/linear-rules.md"), /Tier 0[^]*Tier 1[^]*Tier 2/i);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test tests/spec-sweep-doc.test.mjs
```

Expected: FAIL because the skill copies differ and the adaptive tier language is absent.

- [ ] **Step 3: Commit the red test**

```bash
git add tests/spec-sweep-doc.test.mjs
git commit -m "COD-130 test adaptive spec review policy"
```

---

### Task 2: Implement the Canonical Adaptive Review Workflow

**Files:**
- Modify: `skills/spec-sweep/SKILL.md`
- Modify: `.claude/skills/spec-sweep/SKILL.md`
- Test: `tests/spec-sweep-doc.test.mjs`

**Interfaces:**
- Consumes: the approved tier definitions, existing unattended prose review behavior, repo-ownership gate, and gated lens labels.
- Produces: identical cross-runtime skills with initial classification, targeted review execution, plan generation, monotonic reassessment, audit evidence, and a final-tier terminal gate.

- [ ] **Step 1: Replace the fixed mandatory review sequence in the canonical skill**

Keep research and brainstorming first. Replace the current always-on engineering review and label-only lens instructions with these explicit stages:

1. `Classify review depth` writes the predicted footprint, risk surfaces, initial tier, selected targets, and rationale into the draft spec.
2. `Run every pre-plan review selected by the tier` invokes the spec pass only for Tier 1 spec-targeted work and Tier 2 work, pairing the card's single adversarial review with that pass.
3. `Run materially applicable specialized lenses` distinguishes a candidate domain label from an actual design, DX, security, performance, or research surface and records every skip.
4. `Write the implementation plan` preserves the repo-scope requirements and writes the initial review audit into the plan.
5. `Reassess review depth` uses the completed file map, interfaces, task graph, tests, failure modes, and rollout work; the final tier may stay level or increase, never decrease.
6. `Run every newly required review and reconcile` invokes the plan pass for Tier 1 plan-targeted work, Tier 2 work, and escalations, then updates both artifacts when findings change their contract.
7. `Update canonical architecture/schema docs` retains the existing canonical-document behavior after all selected reviews are clear.

Define Tier 0/1/2, safety floors, one adversarial pass per non-Tier-0 card, material specialized-lens gating, monotonic escalation, the `Spec-sweep review audit`, and the terminal condition exactly as approved in the design.

- [ ] **Step 2: Reconcile the installed copy from the canonical copy**

After editing the canonical skill, copy it mechanically so the two files are byte-identical:

```bash
cp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
```

This intentionally preserves the canonical file’s existing repo-ownership gate in the installed copy.

- [ ] **Step 3: Verify GREEN for the skill-policy tests**

Run:

```bash
node --test tests/spec-sweep-doc.test.mjs
```

Expected: the first three tests pass; the operator-doc test still fails until Task 3.

- [ ] **Step 4: Commit the skill policy**

```bash
git add skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
git commit -m "COD-130 add adaptive spec review tiers"
```

---

### Task 3: Document, Verify, and Prepare the Review Handoff

**Files:**
- Modify: `README.md`
- Modify: `docs/linear-rules.md`
- Test: `tests/spec-sweep-doc.test.mjs`

**Interfaces:**
- Consumes: the implemented canonical skill policy.
- Produces: operator-facing summaries and complete verification evidence for review, QA, and shipping.

- [ ] **Step 1: Document the operator-visible policy**

In `README.md`, update the spec-sweep entry and triggering explanation to state that review depth is adaptive: mechanical work may skip engineering review, bounded work receives one targeted pass, material work receives both, and completed plans can only escalate the tier.

In `docs/linear-rules.md`, change the Dev readiness description from a blanket “eng-reviewed” claim to “reviewed to its final adaptive tier,” then add the Tier 0/1/2 definitions, safety floors, audit evidence, and terminal gate.

- [ ] **Step 2: Verify the focused policy suite is GREEN**

```bash
node --test tests/spec-sweep-doc.test.mjs
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 3: Run full verification**

```bash
node --test
git diff --check
diff -u skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
```

Expected: all tests pass, no whitespace errors, and no skill-copy diff.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/linear-rules.md
git commit -m "COD-130 document adaptive spec reviews"
```

- [ ] **Step 5: Review and QA the complete branch**

Run the repository’s review workflow against `git merge-base origin/main HEAD..HEAD`. Fix verified findings, rerun the focused and full suites, and inspect the final Markdown diff for readable ordering and no contradictory gates.

- [ ] **Step 6: Ship and verify**

Push `codex/COD-130-adaptive-spec-review`, merge it to `main` only after review and QA are green, push `main`, then verify `origin/main` contains the COD-130 commits and rerun the focused test from the landed commit. This kit has no production app deploy; shipping is the merged/pushed `main` commit plus post-merge verification.

## Plan Self-Review

- Spec coverage: tiers, safety floors, specialized lenses, one adversarial review, monotonic reassessment, audit evidence, terminal gate, docs, tests, QA, and shipping all map to Tasks 1–3.
- Placeholder scan: no deferred implementation choices; quoted policy text is an exact editing target, not a placeholder.
- Type consistency: all tests use the same canonical and installed paths and the same spec-pass/plan-pass terminology as the design.
- Sequencing: RED test precedes skill edits; canonical policy precedes operator docs; focused verification precedes full review and shipping.

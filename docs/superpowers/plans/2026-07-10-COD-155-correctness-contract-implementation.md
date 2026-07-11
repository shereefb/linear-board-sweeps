# COD-155 Cross-Stage Correctness Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned, traceable correctness contract that behavior-changing cards carry from Spec through Dev proof execution and QA evidence without suppressing review findings.

**Architecture:** The existing docs-driven sweep pipeline remains the only execution mechanism. Spec writes a `correctness-contract/v1` applicability declaration and invariant matrix, the implementation plan maps invariant IDs to tasks/tests/QA, Dev executes those declared proofs before its unchanged review pair, and QA consumes the observable cases. A `VERSION` bump distributes the byte-identical canonical skill copies through the existing updater.

**Tech Stack:** Markdown cross-runtime skills, Node.js `node:test`, existing skill updater in `scripts/linear-watch.mjs`, git history for the rollout boundary.

## Global constraints

- Docs/instructions and tests only; do not add launcher runtime behavior, dependencies, services, labels, states, or persisted schemas.
- Keep each `skills/<stage>-sweep/SKILL.md` byte-identical to `.claude/skills/<stage>-sweep/SKILL.md` for Spec, Dev, and QA.
- Use the exact declaration `Correctness contract: correctness-contract/v1 — required | not required — <rationale>` in every newly generated spec and plan audit.
- Tier 0 may declare `not required` only with a concrete no-material-correctness-surface rationale; discovering a material invariant escalates the card to at least Tier 1.
- Dev's proof run executes already-declared evidence. It is not a third review. A material contract omission discovered there emits the existing `review/correctness` event and bounces as `missing-design`.
- Never suppress, recategorize, deduplicate, or discount existing structured review findings to improve the acceptance metric.
- Preserve every existing engineering review, independent review, QA, Signoff, and human Ship gate.
- Bump `VERSION` from `1.2.0.5` to `1.2.0.6` and document the change in `CHANGELOG.md`.
- No production deploy exists for this kit; shipping is merge/push to `main` after normal QA and human approval.

---

## Repo scope

- **Owning repo:** `linear-board-sweeps` only.
- **Branch expectation:** one branch containing `COD-155`, pushed for Dev/QA and merged only by ship-sweep.
- **QA evidence:** doc-contract tests, updater integration test, complete `node --test tests/*.test.mjs`, byte-equality check for canonical copies, and a dry updater fixture proving an old marker receives the new bytes/marker.
- **Deploy target:** none. Merge/push to `main` distributes the kit; installed anchors refresh through the existing versioned updater.
- **Sibling repos:** SafeTaper and zomes are acceptance-metric contributors, not implementation repos. Do not edit them from this card.

## What already exists

| Mechanism | Reuse decision |
| --- | --- |
| Adaptive Tier 0/1/2 review classification in `skills/spec-sweep/SKILL.md` | Reuse; add correctness applicability before selected review and use it as another escalation signal. |
| Tier-selected engineering plus independent adversarial reviews | Reuse unchanged; make the invariant matrix an explicit target. |
| Dev TDD preference, two code reviews, and observed verification | Reuse; insert declared-proof execution before the existing review pair. |
| QA consumption of the engineering test plan | Reuse; add correctness IDs/observations as primary input beside it. |
| Structured `review/correctness` learning events | Reuse unchanged; explicitly preserve them for formal findings and newly discovered contract omissions. |
| Canonical-copy equality test in `tests/agents-snippet.test.mjs` | Reuse; the new focused test asserts cross-stage semantics while the existing test remains the global byte-equality guard. |
| `copySkillsInto()` and `.sweep-version` updater marker | Reuse; no updater code change. Extend integration evidence and bump `VERSION`. |

## NOT in scope

- Learning-detector changes: the card must reduce defects, not hide or regroup evidence.
- A third review pass: declared-proof execution is deliberately bounded and precedes the unchanged formal review pair.
- Runtime parsing of Markdown artifacts: the cross-runtime agents consume the explicit contract exactly as they consume current review audits and plans.
- Migrating or rewriting old specs/plans: git-history boundary rules grandfather proven legacy artifacts and fail closed on incomparable history.
- Product-specific invariant libraries: each card derives only the dimensions material to its design.
- Direct edits to contributor workspaces: `VERSION`-driven propagation is the supported distribution path.

## Correctness traceability

| Invariant | Implementing tasks | Test / assertion | QA observation | Residual risk |
| --- | --- | --- | --- | --- |
| `C1` Material behavior has a versioned `required/not required` declaration before review. | Tasks 1-2 | `tests/correctness-contract-doc.test.mjs` asserts exact declaration, Tier 0 escalation, and required matrix ordering. | Read a generated Spec/Plan audit and confirm the declaration precedes handoff. | Agents can still violate prose instructions; doc tests prevent canonical drift and downstream gates fail closed. |
| `C2` Every required invariant maps to a task, deterministic proof, and honest QA observation. | Tasks 1-2 | Doc test asserts plan traceability and low-level-proof language; Dev/QA canonical text is byte-equal. | QA handoff cites exercised IDs or named lower-level evidence for non-observable behavior. | Manual evidence quality still depends on reviewer judgment. |
| `C3` Proof execution cannot hide a newly discovered contract defect from `reviewFindingCount`. | Tasks 1-2 | Doc test requires `review/correctness`, `missing-design`, and unchanged two-review language in Dev. | A fixture/read-through confirms material omissions are emitted and bounced, while implementation failures are fixed normally. | Taxonomy remains category-level, so heterogeneous correctness findings may still aggregate. |
| `C4` New behavior reaches installed anchors. | Task 3 | Updated updater integration test starts at `0.0.1`, installs `9.9.9`, and compares Spec/Dev/QA bytes plus `.sweep-version`. | Verify `VERSION=1.2.0.6`, CHANGELOG entry, and updater fixture pass. | An inactive/misconfigured anchor can still defer its normal updater; existing doctor/Todo paths own that condition. |
| `C5` Missing declarations are grandfathered only when proven older than rollout. | Tasks 1-2 | Doc test requires artifact-introduction versus `.sweep-version` installation boundary and fail-closed incomparable history. | Dev handoff records legacy proof or the explicit v1 declaration. | Cross-repo incomparable history intentionally bounces rather than guesses. |

## Dependency graph and execution order

```text
Task 1: failing semantic contract tests
       |
       v
Task 2: Spec/Dev/QA canonical skill pairs
       |
       v
Task 3: release marker + propagation evidence + active README
       |
       v
Full suite, byte equality, diff review
```

Sequential implementation, no parallelization opportunity. Task 2 satisfies the
test contract created in Task 1; Task 3 changes the distribution marker for those
exact bytes and must follow it.

### Task 1: Lock the cross-stage contract with failing documentation tests

**Files:**

- Create: `tests/correctness-contract-doc.test.mjs`

**Interfaces:**

- Consumes: canonical skill text under `skills/{spec,dev,qa}-sweep/SKILL.md` and installed copies under `.claude/skills/`.
- Produces: a semantic contract that Tasks 2-3 must satisfy; no runtime exports.

- [ ] **Step 1: Create the failing cross-stage test**

Create `tests/correctness-contract-doc.test.mjs` with these exact assertions:

```js
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
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
node --test tests/correctness-contract-doc.test.mjs
```

Expected: FAIL in the first three tests because the canonical skills do not yet contain `correctness-contract/v1`; the copy-equality test remains green.

- [ ] **Step 3: Commit the failing contract test**

```bash
git add tests/correctness-contract-doc.test.mjs
git commit -m "test(COD-155): define correctness contract handoffs"
```

### Task 2: Carry the contract through Spec, Dev, and QA

**Files:**

- Modify: `skills/spec-sweep/SKILL.md:46-70`
- Modify: `.claude/skills/spec-sweep/SKILL.md:46-70`
- Modify: `skills/dev-sweep/SKILL.md:42-56`
- Modify: `.claude/skills/dev-sweep/SKILL.md:42-56`
- Modify: `skills/qa-sweep/SKILL.md:42-61`
- Modify: `.claude/skills/qa-sweep/SKILL.md:42-61`
- Test: `tests/correctness-contract-doc.test.mjs`

**Interfaces:**

- Consumes: existing review-depth audit, implementation plan, structured learning-event taxonomy, code-review pair, and QA pass gate.
- Produces: `correctness-contract/v1` applicability, `C1..Cn` invariant matrix, plan traceability map, Dev proof result, and QA invariant evidence.

- [ ] **Step 1: Add the Spec contract before review selection completes**

In `skills/spec-sweep/SKILL.md`, insert after brainstorming and before review execution:

```markdown
**Correctness contract (versioned, risk-proportional).** Every draft spec and plan audit must contain `Correctness contract: correctness-contract/v1 — required | not required — <rationale>`. Mark it `required` whenever behavior, state, persistence, interfaces, dependencies, rollout, or user-visible failure behavior changes; mark it `not required` only with a concrete rationale. A required spec adds a `Correctness contract` table before selected review with stable `C1..Cn` IDs and columns `Trigger / transition`, `Required invariant`, `Forbidden outcome`, `Recovery / ownership`, and `Verification`. Consider only material dimensions: partial success/write ordering; retry/timeout/deadline/cancellation/stale work; duplicate/concurrent delivery and ownership transfer; identity/provenance/precedence; serialization/persistence/retained safety state; boundaries/unavailable dependencies/malformed external input; and rollback/cleanup/resume. If this exposes a material invariant on a proposed Tier 0 card, escalate it to at least Tier 1. Do not add ceremonial rows for inapplicable dimensions.
```

Extend the existing reviewer instruction with:

```markdown
For a required correctness contract, challenge whether every state-changing or externally visible failure path has an owner, partial success can falsely report completion, retries/cancellation preserve defined progress or rollback, persisted identity survives interruption/resume, and each proof could disprove a bad implementation. Record every verified omission through the existing structured review-event contract.
```

Extend the plan requirement with:

```markdown
For `correctness-contract/v1 — required`, add a `Correctness traceability` table mapping every invariant ID to `Implementing task(s)`, `Test / assertion`, `QA observation`, and `Residual risk`. Each invariant needs a deterministic proof; manual QA alone is insufficient for races, atomicity, persistence integrity, or other behavior a user cannot reliably induce.
```

- [ ] **Step 2: Add deterministic applicability and declared-proof execution to Dev**

In `skills/dev-sweep/SKILL.md`, extend the spec-quality gate with:

```markdown
**Correctness-contract gate.** Read the spec/plan audit for `Correctness contract: correctness-contract/v1`. `required` needs both the invariant and traceability tables; missing material is a `missing-design` bounce. `not required` is accepted only when the actual plan/diff has no material correctness surface. If the declaration is absent, compare the commit that first introduced the artifact with the anchor commit that first installed this kit release in `.claude/skills/.sweep-version`: proven older artifacts use the legacy quality gate; artifacts introduced at/after the boundary bounce; missing or incomparable history fails closed and bounces with the exact evidence gap.
```

Insert before the existing `Code review — run BOTH` step:

```markdown
**Execute declared correctness proofs.** For `correctness-contract/v1 — required`, map every `C1..Cn` ID to the actual diff and its already-declared test/assertion, then execute those narrow proofs before the full suite. Fix implementation failures. This is proof execution, not a third review pass. If mapping/execution instead exposes a material missing invariant or contract defect, emit the existing `review/correctness` learning event and bounce to Spec as `missing-design`; never relabel discovery as ordinary implementation work to improve the metric. Include the invariant-to-diff/test proof map in the QA handoff.
```

Keep `Code review — run BOTH` and its independent reviewer unchanged after this insertion.

- [ ] **Step 3: Make QA consume observable invariants without faking low-level proof**

In `skills/qa-sweep/SKILL.md`, extend the card setup and exercise steps with:

```markdown
For `correctness-contract/v1 — required`, use the plan's invariant IDs and `QA observation` entries as primary test input beside the engineering-review test plan. Record each ID exercised through the running product. When concurrency, atomicity, persistence integrity, or another invariant cannot be induced safely/reliably through the public interface, cite the observed green lower-level test evidence and verify the closest user-visible outcome; never claim manual coverage of an unexercised low-level path. A required plan with user-observable cases and no invariant coverage cannot receive `qa:passed`.
```

- [ ] **Step 4: Synchronize each installed copy from its canonical source**

After editing the three canonical files, copy the exact content into the installed paths using the repository's normal formatting/copy mechanism (do not hand-diverge them), then verify:

```bash
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
cmp skills/dev-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md
cmp skills/qa-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
```

Expected: all three commands exit 0 with no output.

- [ ] **Step 5: Run the focused documentation tests and verify GREEN**

```bash
node --test tests/correctness-contract-doc.test.mjs tests/spec-sweep-doc.test.mjs tests/agents-snippet.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit the cross-stage skill contract**

```bash
git add tests/correctness-contract-doc.test.mjs skills/spec-sweep/SKILL.md skills/dev-sweep/SKILL.md skills/qa-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
git commit -m "feat(COD-155): trace correctness contracts across sweeps"
```

### Task 3: Version, document, and prove distribution

**Files:**

- Modify: `tests/updater.integration.test.mjs:15-58`
- Modify: `VERSION:1`
- Modify: `CHANGELOG.md:1-10`
- Modify: `README.md:3-12`

**Interfaces:**

- Consumes: existing `refreshAnchorSkills(anchor, kit, marker)` and `copySkillsInto()` behavior.
- Produces: kit version `1.2.0.6`, installed marker `1.2.0.6`, release note, active README architecture, and propagation evidence for all three changed skills.

- [ ] **Step 1: Strengthen the existing old-marker updater fixture**

In the first `refreshAnchorSkills` integration test, after the marker assertions, add:

```js
for (const sweep of ["spec", "dev", "qa"]) {
  assert.equal(
    g(anchor, "show", `main:.claude/skills/${sweep}-sweep/SKILL.md`),
    fs.readFileSync(path.join(KIT, "skills", `${sweep}-sweep`, "SKILL.md"), "utf8").trim(),
    `${sweep} bytes were not propagated`,
  );
}
```

This fixture already starts from `.sweep-version=0.0.1` and calls
`refreshAnchorSkills(..., "9.9.9")`, so it proves both marker and byte propagation.

- [ ] **Step 2: Run the updater test before the release edits**

```bash
node --test tests/updater.integration.test.mjs
```

Expected: PASS, proving the existing updater can distribute the changed files; no launcher implementation change is needed.

- [ ] **Step 3: Bump the kit version and add the release note**

Change `VERSION` to:

```text
1.2.0.6
```

Add this entry at the top of `CHANGELOG.md`:

```markdown
## [1.2.0.6] - 2026-07-10

### Changed

- Carry versioned correctness invariants from behavior-changing specs into implementation proofs and QA evidence, while keeping mechanical work exempt and preserving every existing review and human Ship gate.
- Fail closed when a required or post-rollout correctness contract is missing, and retain material contract omissions as structured `review/correctness` evidence instead of hiding them as ordinary implementation work.

### Fixed

- Bump the sweep marker so installed anchors receive the Spec, Dev, and QA contract changes through the existing updater.
```

- [ ] **Step 4: Change the README architecture note from planned to active**

Replace the COD-155 planned paragraph with:

```markdown
Behavior-changing specs carry a versioned correctness contract whose invariant IDs remain traceable through implementation proofs and QA evidence. Existing review findings remain structured Factory Learning evidence; the contract strengthens prevention without bypassing review, QA, Signoff, or the human Ship gate.
```

- [ ] **Step 5: Run focused release and propagation verification**

```bash
test "$(cat VERSION)" = "1.2.0.6"
rg -n "1\.2\.0\.6|correctness contract" CHANGELOG.md README.md
node --test tests/correctness-contract-doc.test.mjs tests/updater.integration.test.mjs tests/agents-snippet.test.mjs
```

Expected: version assertion exits 0, both docs contain the release text, and all focused tests pass.

- [ ] **Step 6: Run the complete repository suite**

```bash
node --test tests/*.test.mjs
```

Expected: all repository tests pass with zero failures.

- [ ] **Step 7: Review the final diff for scope and copy integrity**

```bash
git diff --check
git diff --stat
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
cmp skills/dev-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md
cmp skills/qa-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
git status --short
```

Expected: no whitespace errors, exactly the eleven planned files changed, all copy comparisons exit 0, and no unrelated file appears.

- [ ] **Step 8: Commit the release marker and distribution evidence**

```bash
git add tests/updater.integration.test.mjs VERSION CHANGELOG.md README.md
git commit -m "chore(COD-155): release correctness contract workflow"
```

## Failure-mode verification

| Failure | Test / handling | User/operator result |
| --- | --- | --- |
| A behavior-changing Spec omits the declaration | Spec doc test plus terminal review gate | Card stays in Spec rather than handing ambiguity to Dev. |
| Tier 0 discovers a material invariant | Canonical instruction and regex test require Tier 1 escalation | Required review runs before Dev. |
| A new artifact omits the declaration | Dev compares artifact introduction to the anchor rollout-boundary commit; incomparable history fails closed | Card bounces with exact `missing-design` evidence. |
| A legacy artifact has no declaration | Proven pre-boundary introduction uses the existing quality gate | Existing Dev work is not ceremonially rewritten. |
| Declared invariant has no deterministic proof | Plan terminal gate rejects the traceability row | Race/persistence claims cannot rely on clicking alone. |
| Dev proof execution finds an implementation failure | Fix and rerun the declared proof | Formal reviews receive a green implementation baseline. |
| Dev proof execution finds a missing contract invariant | Emit `review/correctness` and bounce `missing-design` | Metric remains honest; Spec repairs the design. |
| QA cannot induce a low-level failure safely | Cite green lower-level evidence and verify nearest public outcome | QA neither skips the invariant nor fakes manual coverage. |
| Canonical and installed skills drift | Existing and new byte-equality tests fail | Release cannot pass. |
| Kit changes but anchor marker does not | `VERSION=1.2.0.6` plus updater fixture | Updated skill bytes and marker are proven distributable. |

## Spec-sweep review audit

| Item | Decision / outcome |
| --- | --- |
| Initial tier | Tier 1 — Bounded, spec target |
| Predicted footprint | 11 physical files / 7 logical artifacts; approximately 110-170 changed lines |
| Risk surfaces | Cross-stage workflow behavior, legacy compatibility, evidence integrity, and updater distribution; no runtime auth/data/concurrency/performance surface |
| Correctness contract | `correctness-contract/v1` — required |
| Engineering spec review | Clear after four corrections: propagation, deterministic applicability, evidence semantics, and README activation |
| Independent adversarial review | Clear; separate current-runtime reviewer used because explicit configured Claude dispatch is unsupported |
| UI/design lens | Skipped: no interaction or visual behavior |
| DevEx lens | Skipped: no public API/CLI/SDK ergonomics or adoption flow |
| Security lens | Skipped: no auth, secret, data, or external-input boundary |
| Performance lens | Skipped: no runtime hot path; no downstream benchmark requirement |
| Research lens | Skipped: no unfamiliar external integration/API |
| Plan review target | Not selected; Tier 1's single required pass targeted the spec |

## Completed-plan review-depth reassessment

- **Concrete footprint:** three canonical skill pairs, one focused doc-contract
  test, one existing updater integration test, `VERSION`, `CHANGELOG.md`, and
  README. No application or launcher runtime code changes.
- **Dependency graph:** three sequential tasks with no cross-repo or parallel
  implementation requirement.
- **Interfaces:** Markdown artifact declaration and handoff evidence only; no
  public API, schema, state, dependency, migration, or irreversible rollout.
- **Failure handling:** fail-closed legacy boundary, honest structured evidence,
  byte-equality tests, updater distribution fixture, and normal git revert.
- **Final tier:** Tier 1 — Bounded, unchanged. The plan is larger in physical
  files because canonical copies and release artifacts are mandatory, but it
  remains a small docs-driven workflow change on established architecture. No
  Tier 2 floor or newly material specialized lens appeared.
- **Terminal review gate:** clear. The selected engineering and independent spec
  reviews are reconciled, skipped lenses have material rationales, spec and plan
  agree, and there are no unresolved decisions.

## Schema and architecture impact

No schema change. Task 3 changes README from the docs-only spec commit's planned
COD-155 note to active in the implementation branch. The live architecture then
states that Factory Learning can turn repeated correctness evidence into a
versioned cross-stage prevention contract without weakening downstream gates.

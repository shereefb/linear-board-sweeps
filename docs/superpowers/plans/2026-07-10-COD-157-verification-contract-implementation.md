# COD-157 Risk-Linked Verification Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a versioned, risk-linked verification contract from Spec through executable Plan proofs, Dev execution, and QA evidence without suppressing honest `review/test-gap` findings.

**Architecture:** Extend the agent-readable sweep control plane with one bounded validator that parses verification artifacts and owns git-history rollout classification. Canonical Spec, Dev, and QA instructions declare and consume stable `V1..Vn` obligations; Factory Learning adds a five-distinct-reviewed-card exposure floor to outcome evaluation; semantic tests, validator fixtures, byte equality, and the updater fixture prove the workflow.

**Tech Stack:** Markdown sweep skills, Node.js, Git subprocesses, built-in test runner, existing `refreshAnchorSkills()` updater, and repository release docs.

## Global Constraints

- Repository scope is only `linear-board-sweeps`; no sibling repository is touched.
- Do not change detector qualification thresholds, finding identity, primary aggregation, routing, or generated-card identity. Add only the trusted `review-completed` exposure observation and the five-card outcome floor.
- Preserve TDD, both Dev code-review passes, QA, Signoff, and the human-only Ship move.
- Continue emitting every verified material gap as `review/test-gap`; never suppress or reclassify a finding to improve the metric.
- Keep each `skills/<sweep>-sweep/SKILL.md` byte-identical to `.claude/skills/<sweep>-sweep/SKILL.md` after synchronization.
- Reconcile current `origin/main` before release edits. Allocate the next four-component marker from every live remote `VERSION`, incrementing only component `v[3]`, and use that unique concrete value in `VERSION` and `CHANGELOG.md`; do not assume another feature's planned marker has or has not landed.
- Reuse one git-history ancestry helper for COD-155 and COD-157 if both contracts are present; locate each rollout from the first commit adding its versioned literal to the canonical/installed Spec skill.
- The existing two `tests/linear.test.mjs` failures caused by absent `repoRouting.byLabel` are baseline evidence, not COD-157 scope. Focused COD-157 tests must be green and the full suite must introduce no new failure.

---

## Repo scope

- **Owning repo:** `linear-board-sweeps`
- **Branch expectation:** one branch containing `COD-157`, pushed for Dev/QA and merged only through the normal human-gated Ship path.
- **QA evidence:** focused semantic contract tests, canonical-copy equality, updater propagation, legacy/new/incomparable rollout fixtures, and a full-suite comparison against the recorded 431/433 baseline.
- **Deploy target:** no production app deploy. Shipping is merge/push to `main`; external release publication remains owner-attended or a linked Todo.
- **Ship order:** single repository; normal Spec -> Dev -> QA -> Signoff -> human Ship -> Done.

## File map

| File | Responsibility |
| --- | --- |
| `tests/verification-contract-doc.test.mjs` | Locks applicability, stable obligation fields, plan traceability, Dev proof execution, honest findings, QA evidence, and copy equality |
| `scripts/verification-contract.mjs` | Parses spec/plan contracts and classifies legacy/post-rollout/incomparable git history with one deterministic CLI |
| `tests/verification-contract.test.mjs` | Proves valid/malformed mappings and real temporary-repository ancestry cases |
| `skills/spec-sweep/SKILL.md` | Declares `verification-contract/v1`, stable `V` obligations, reviewer challenge, and plan mapping requirements |
| `.claude/skills/spec-sweep/SKILL.md` | Installed byte-identical Spec copy |
| `skills/dev-sweep/SKILL.md` | Enforces rollout compatibility, executes declared proofs, and distinguishes implementation from design gaps |
| `.claude/skills/dev-sweep/SKILL.md` | Installed byte-identical Dev copy |
| `skills/qa-sweep/SKILL.md` | Consumes ID-linked public and lower-level proof evidence |
| `.claude/skills/qa-sweep/SKILL.md` | Installed byte-identical QA copy |
| `scripts/learning.mjs` | Retains trusted completed-review exposure and prevents outcome success below five distinct reviewed cards |
| `tests/learning.test.mjs` | Proves empty/underexposed windows are inconclusive and five-card windows use existing count semantics |
| `tests/updater.integration.test.mjs` | Proves updated skill bytes and version marker propagate to anchors |
| `README.md` | Changes the planned COD-157 architecture note to active behavior |
| `VERSION` | Triggers installed-skill propagation with the next live patch version |
| `CHANGELOG.md` | Records the contract, fail-closed rollout gate, and preserved review evidence |

## Verification contract for this implementation

`Verification contract: verification-contract/v1 — required`.

| ID | Implementing task(s) | Test layer and file | RED signal | GREEN command / assertion | QA evidence | Residual gap |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | Tasks 1-3 | Validator and semantic tests | Spec lacks unique obligations or plan omits mappings | `node --test tests/verification-contract.test.mjs tests/verification-contract-doc.test.mjs` | Run validator on the COD-157 artifacts | Proof quality still needs review beyond structural validation |
| V2 | Tasks 2-3 | Real temporary git fixtures | Dev accepts missing new contract or rejects proven legacy work | Legacy exits 0; post-rollout, divergent, missing, and shallow cases exit nonzero with exact reason | Exercise post-rollout malformed artifact | Incomparable history deliberately fails closed |
| V3 | Tasks 1-3 | Semantic skill tests | Broad suite substitutes for proof or finding is suppressed | Narrow proof ordering and unchanged `review/test-gap` language match | Dev handoff lists every V result | Review discovery remains probabilistic |
| V4 | Tasks 1-3 | Semantic QA contract test | One covered ID masks uncovered siblings | Test requires a disposition for every V ID | QA evidence maps all IDs | Low-level cases rely on cited automation |
| V5 | Task 5 | Integration and byte-equality tests | Marker advances without all changed skill bytes | Updater byte comparison and three `cmp` commands | Inspect fixture origin/main | External publication is owner-attended |
| V6 | Task 4 | Learning evaluator tests | No review activity counts as improvement | 0 and 4 reviewed cards are inconclusive; 5 uses existing count comparison | `learning-run --dry-run` after the evaluation window | Five cards is a comparability floor, not statistical certainty |

## Correctness traceability

| Invariant | Implementing task(s) | Test / assertion | QA observation | Residual risk |
| --- | --- | --- | --- | --- |
| C1: every required `V` and source `C` ID is mapped | Tasks 1-3 | Validator rejects duplicates/missing mappings | Inspect validator output | Semantic proof quality still needs review |
| C2: legacy/new/incomparable history is deterministic | Task 2 | Real git ancestry fixtures | Exercise post-rollout rejection | Shallow history deliberately fails closed |
| C3: declared proofs precede formal review | Tasks 1-3 | Dev skill assertion orders proof execution before `Code review` | Dev handoff cites narrow commands | Agent ordering relies on skill compliance |
| C4: findings remain honest | Tasks 1-4 | Existing taxonomy plus semantic assertion retains `review/test-gap` | Review comment lists corrected gaps | Finding completeness depends on reviewer quality |
| C5: QA disposes every ID | Tasks 1-3 | QA skill assertion rejects any missing disposition | QA maps every V ID | Low-level invariants use cited automation |
| C6: release bytes stay synchronized | Task 5 | `cmp` plus updater integration byte comparison | Inspect fixture origin/main | Attended external distribution remains outside repo deploy |

### Task 1: Lock the cross-stage contract with a failing semantic test

**Files:**

- Create: `tests/verification-contract-doc.test.mjs`

**Interfaces:**

- Consumes: canonical and installed Spec/Dev/QA Markdown under `skills/` and `.claude/skills/`.
- Produces: a semantic contract that Tasks 2-3 must satisfy; no runtime export.

- [ ] **Step 1: Create the failing contract test**

Create `tests/verification-contract-doc.test.mjs` with this complete content:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const spec = read("skills/spec-sweep/SKILL.md");
const dev = read("skills/dev-sweep/SKILL.md");
const qa = read("skills/qa-sweep/SKILL.md");

test("spec-sweep emits a risk-linked verification contract", () => {
  assert.match(spec, /Verification contract: verification-contract\/v1[^\n]*required \| not required/i);
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
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
node --test tests/verification-contract-doc.test.mjs
```

Expected: the first five tests fail because current skills do not contain `verification-contract/v1`; the copy-equality test passes.

- [ ] **Step 3: Commit the failing contract test**

```bash
git add tests/verification-contract-doc.test.mjs
git commit -m "test(COD-157): define verification contract handoffs"
```

### Task 2: Build the deterministic artifact and rollout validator

**Files:**

- Create: `scripts/verification-contract.mjs`
- Create: `tests/verification-contract.test.mjs`

**Interfaces:**

- Produces: `parseVerificationArtifact(markdown)`, `classifyRolloutHistory({ repoRoot, artifactPath, skillPath, contractLiteral })`, `validateVerificationContract({ specPath, planPath, repoRoot })`, and CLI `validate --spec <path> --plan <path>`.
- Returns: `{ ok, applicability, legacy, verificationIds, diagnostics }`; CLI exits 0 only for a valid required/not-required pair or proven legacy absence, and exits 2 for malformed/incomparable input.

- [ ] **Step 1: Write failing parser and git-history fixtures**

Create tests using `node:test`, temporary git repositories, and `spawnSync`. Cover: valid required pair; missing declaration; duplicate V; missing plan V; required C absent from all V rows; one C repeated across V rows; proven legacy first-add; post-rollout first-add; divergent branches; missing marker commit; and shallow/incomplete history. Assert exact diagnostic codes: `missing-declaration`, `duplicate-verification-id`, `missing-plan-mapping`, `missing-correctness-source`, `duplicate-correctness-source`, `post-rollout-missing-contract`, and `incomparable-history`.

- [ ] **Step 2: Run fixtures and verify RED**

```bash
node --test tests/verification-contract.test.mjs
```

Expected: FAIL because `scripts/verification-contract.mjs` does not exist.

- [ ] **Step 3: Implement the validator with one ancestry algorithm**

Implement Markdown table parsing with exact normalized header names from the spec. Use `git log --diff-filter=A --follow --format=%H -- <artifact>` for first-add. Use `git log -Sverification-contract/v1 --format=%H -- .claude/skills/spec-sweep/SKILL.md` for an installed rollout, falling back to the canonical `skills/spec-sweep/SKILL.md` only when the installed path is absent. Use `git merge-base --is-ancestor` in both directions. Never treat command failure, empty history, shallow history, or divergence as legacy.

The C/V invariant is exact: every required C ID appears in one and only one Spec V row; plan rows are keyed by V and retain source C IDs. `not required` accepts no obligation table only when both artifacts agree. Print bounded diagnostics without file contents.

- [ ] **Step 4: Run fixtures and verify GREEN**

```bash
node --test tests/verification-contract.test.mjs
```

Expected: all parser and real-git fixtures pass.

- [ ] **Step 5: Commit the validator**

```bash
git add scripts/verification-contract.mjs tests/verification-contract.test.mjs
git commit -m "feat(COD-157): validate verification artifacts and rollout history"
```

### Task 3: Carry obligations through Spec, Dev, and QA

**Files:**

- Modify: `skills/spec-sweep/SKILL.md:46-70`
- Modify: `.claude/skills/spec-sweep/SKILL.md:46-70`
- Modify: `skills/dev-sweep/SKILL.md:35-65`
- Modify: `.claude/skills/dev-sweep/SKILL.md:35-65`
- Modify: `skills/qa-sweep/SKILL.md:35-70`
- Modify: `.claude/skills/qa-sweep/SKILL.md:35-70`
- Test: `tests/verification-contract-doc.test.mjs`
- Test: `tests/spec-sweep-doc.test.mjs`
- Test: `tests/agents-snippet.test.mjs`
- Test: `tests/learning.test.mjs`

**Interfaces:**

- Consumes: review-depth classification, TDD requirement, implementation plan, both Dev review passes, QA pass gate, `.sweep-version` history, and the existing structured learning-event taxonomy.
- Produces: `verification-contract/v1` applicability, C→V obligation matrix, one executable plan traceability map, validator invocation, Dev proof map, and complete QA dispositions.

- [ ] **Step 1: Add Spec applicability and stable obligations before review**

Insert after brainstorming and before review selection in `skills/spec-sweep/SKILL.md`:

```markdown
**Verification contract (versioned, risk-proportional).** Every draft spec and plan audit must contain `Verification contract: verification-contract/v1 — required | not required — <rationale>`. Mark it `required` whenever behavior, state, persistence, interfaces, dependencies, error handling, compatibility, rollout, or a user-visible outcome changes; mark it `not required` only for a genuinely mechanical or docs-only change with objective verification and no material regression risk. A required spec adds a `Verification obligations` table before selected review with stable `V1..Vn` IDs and columns `Source requirement / C ID(s)`, `Behavior / risk`, `Failure this proof must catch`, `Required proof`, and `Acceptance`. Every required correctness `C` ID appears in exactly one V row; C remains invariant identity, V owns executable proof, and Dev/QA report V with source C retained. Consider only material happy paths, boundary values, malformed or unavailable dependencies, error/rollback paths, regressions, compatibility/configuration variants, and required correctness invariants. Explain material exclusions; do not add ceremonial rows. If a proposed Tier 0 exposes a material obligation, escalate it to at least Tier 1.
```

Extend the selected reviewer instruction with:

```markdown
For `verification-contract/v1 — required`, challenge whether every material requirement, error path, regression surface, and correctness invariant has an obligation; each proof can fail for the named bad implementation; the chosen layer is the lowest stable boundary; broad suite commands do not replace named assertions; and every manual exception carries explicit residual risk. Emit every verified material omission through the existing `review/test-gap` event; contract compliance never suppresses or reclassifies a finding.
```

Extend the plan requirement with:

```markdown
For `verification-contract/v1 — required`, add a `Verification traceability` table mapping every `V` ID to `Implementing task(s)`, `Test layer and file`, `RED signal`, `GREEN command / assertion`, `QA evidence`, and `Residual gap`. Each ID needs a deterministic automated proof unless automation is genuinely impossible. An exception names the reason, nearest deterministic substitute, manual-evidence owner, and residual risk. Manual QA alone is insufficient for races, atomicity, persistence, serialization, or other low-level behavior a user cannot reliably induce. One test may prove several IDs only through independently named assertions; a broad full-suite command is a regression gate, not the named proof.
```

- [ ] **Step 2: Add Dev's deterministic quality gate and proof execution**

Extend the Dev spec-quality gate in `skills/dev-sweep/SKILL.md`:

```markdown
**Verification-contract gate.** Run `node scripts/verification-contract.mjs validate --spec <spec-path> --plan <plan-path>` before coding. A valid `required` pair has unique `V1..Vn` IDs, exactly one V source for every required correctness C ID, and complete plan mappings; `not required` is accepted only when the actual plan/diff has no material verification surface. The helper alone classifies absent declarations by comparing artifact first-add history with the first commit that introduced the versioned contract literal into the installed/canonical Spec skill: proven older artifacts use the legacy quality gate; post-boundary, missing, shallow, or incomparable history fails closed and bounces `missing-design` with the exact bounded diagnostic. Never reimplement rollout ancestry in skill prose.
```

Insert immediately before `Code review — run BOTH`:

```markdown
**Execute declared verification proofs.** For `verification-contract/v1 — required`, map every `V1..Vn` ID to the actual diff and execute its declared narrow RED/GREEN command or named assertion before the normal relevant/full regression suite. Fix a missing or failing declared proof as implementation work. If implementation or review exposes a material behavior/risk with no obligation, emit the existing `review/test-gap` learning event and bounce to Spec as `missing-design`; never suppress or relabel discovery to improve the metric. Include the ID-to-diff/test/result map in the QA handoff. This proof execution does not replace TDD or either formal code-review pass.
```

- [ ] **Step 3: Make QA consume public and lower-level proof honestly**

Extend QA setup and exercise instructions in `skills/qa-sweep/SKILL.md`:

```markdown
For `verification-contract/v1 — required`, use the plan's `V1..Vn` IDs beside the engineering test plan and record a disposition for every ID: exercised product evidence for user-observable behavior; the exact green lower-level command/assertion plus nearest public outcome for behavior that cannot be induced safely; or an approved exception with owner and residual risk. One covered ID never hides an uncovered sibling. Any missing disposition blocks `qa:passed`. Any newly verified material missing obligation remains a `review/test-gap` finding and returns through the normal changes/design path.
```

- [ ] **Step 4: Synchronize installed copies from canonical sources**

Use the repository's normal copy mechanism to make these pairs byte-identical:

```bash
cp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
cp skills/dev-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md
cp skills/qa-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
cmp skills/dev-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md
cmp skills/qa-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
```

Expected: all three `cmp` commands exit 0 with no output.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
node --test tests/verification-contract.test.mjs tests/verification-contract-doc.test.mjs tests/spec-sweep-doc.test.mjs tests/agents-snippet.test.mjs
```

Expected: all focused tests pass. `tests/learning.test.mjs` proves the existing taxonomy and detector behavior remain unchanged.

- [ ] **Step 6: Commit the cross-stage workflow contract**

```bash
git add tests/verification-contract-doc.test.mjs skills/spec-sweep/SKILL.md skills/dev-sweep/SKILL.md skills/qa-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
git commit -m "feat(COD-157): trace verification obligations across sweeps"
```

### Task 4: Make outcome evaluation exposure-aware

**Files:**

- Modify: `scripts/learning.mjs:327-360,1404-1453`
- Modify: `tests/learning.test.mjs:928-946`

**Interfaces:**

- Consumes: trusted `review/completed` events and existing evaluation ownership/window filtering.
- Produces: `review-completed` observations and a five-distinct-card exposure floor only for `repeated-review-finding` outcome evaluation.

- [ ] **Step 1: Change the empty-window regression test to fail honestly**

Update the scoped post-Done test so zero and four distinct owned `review-completed` card observations expect `inconclusive-evidence`; five distinct completed cards with zero findings expect `verified-improvement`; five with findings continue through existing count comparison. Add unowned completed cards and duplicate completed events for one card to prove they do not satisfy exposure.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --test --test-name-pattern "outcome evaluation recomputes" tests/learning.test.mjs
```

Expected: FAIL because an empty window currently returns `verified-improvement`.

- [ ] **Step 3: Retain trusted completion exposure and gate evaluation**

In `eventObservation()`, map `review/completed` to `signal: "review-completed"` with trusted route/card identity. In `evaluateLearningOutcome()`, after ownership/window filtering, apply the exposure floor only when `evaluation.detectorId === "repeated-review-finding"`: count distinct owned `cardId` values with `signal === "review-completed"`; fewer than five leaves `inconclusive-evidence`. Do not change finding count, target comparison, recurrence, or any other detector.

- [ ] **Step 4: Run learning tests and verify GREEN**

```bash
node --test tests/learning.test.mjs
```

Expected: all learning tests pass with the revised exposure semantics.

- [ ] **Step 5: Commit the outcome correction**

```bash
git add scripts/learning.mjs tests/learning.test.mjs
git commit -m "fix(COD-157): require review exposure for quality outcomes"
```

### Task 5: Prove distribution and release the workflow

**Files:**

- Modify: `tests/updater.integration.test.mjs:21-56`
- Modify: `README.md:3-12`
- Modify: `VERSION:1`
- Modify: `CHANGELOG.md:1-12`

**Interfaces:**

- Consumes: `refreshAnchorSkills(anchor, KIT, marker)`, canonical skill bytes, and the live release marker.
- Produces: updater byte-propagation evidence, one new patch marker, active README architecture, and release notes.

- [ ] **Step 1: Strengthen the existing updater fixture**

After the marker assertions at `tests/updater.integration.test.mjs:45-49`, add:

```js
    for (const sweep of ["spec", "dev", "qa"]) {
      assert.equal(
        g(anchor, "show", `main:.claude/skills/${sweep}-sweep/SKILL.md`),
        fs.readFileSync(path.join(KIT, "skills", `${sweep}-sweep`, "SKILL.md"), "utf8").trim(),
        `${sweep} bytes were not propagated`,
      );
    }
```

- [ ] **Step 2: Run the updater fixture before release edits**

```bash
node --test tests/updater.integration.test.mjs
```

Expected: PASS, proving current updater behavior copies all three changed skill directories and commits them with the marker.

- [ ] **Step 3: Rebase and calculate the one concrete release version**

```bash
git fetch origin --prune
git for-each-ref --format='%(refname)' refs/remotes/origin | while read -r ref; do git show "$ref:VERSION" 2>/dev/null || true; done | rg '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -V -u > "$AUTO_SWEEP_TMPDIR/live-versions.txt"
MAX_VERSION=$(tail -1 "$AUTO_SWEEP_TMPDIR/live-versions.txt")
NEXT_VERSION=$(node -e 'const v=process.argv[1].split(".").map(Number); if(v.length!==4||v.some(Number.isNaN)) process.exit(2); v[3]+=1; process.stdout.write(v.join("."))' "$MAX_VERSION")
! rg -qx "$NEXT_VERSION" "$AUTO_SWEEP_TMPDIR/live-versions.txt"
printf '%s\n' "$NEXT_VERSION"
```

Expected: one four-component version exactly one higher than the greatest marker on all live remote refs, with the uniqueness check exiting 0. Record `NEXT_VERSION` and use it verbatim in Steps 4-5. Immediately before committing the release edits, fetch and repeat this calculation; if another branch claimed the marker, reconcile current `origin/main` and allocate again rather than reserving or reusing a value.

- [ ] **Step 4: Update VERSION and CHANGELOG with the recorded concrete value**

Use `apply_patch` to replace the single line in `VERSION` with the recorded value and add a new top changelog entry dated on the implementation day with this exact body:

```markdown
### Changed

- Carry versioned, risk-linked verification obligations from behavior-changing specs into executable plan proofs, Dev proof execution, and ID-linked QA evidence.
- Preserve every independent `review/test-gap` finding as structured Factory Learning evidence while distinguishing missing implementation from missing design.

### Fixed

- Fail closed when a required post-rollout verification contract is absent or incomparable, preserve proven legacy artifacts, and reuse one rollout-boundary rule with the correctness contract.
- Propagate the updated Spec, Dev, and QA skill bytes under the new sweep marker.
```

The heading must be `## [<recorded concrete value>] - <implementation date>` with actual values, not angle-bracket text.

- [ ] **Step 5: Change README's COD-157 note from planned to active**

Replace the planned COD-157 paragraph with:

```markdown
Material acceptance behaviors and risks carry a versioned verification contract from Spec through executable Plan proofs, Dev execution, and ID-linked QA evidence. Independent reviewers continue emitting every material `review/test-gap` finding so Factory Learning measures prevention honestly without weakening review, QA, Signoff, or the human Ship gate.
```

- [ ] **Step 6: Run release and propagation verification**

```bash
test "$(head -1 VERSION)" = "$(sed -n 's/^## \[\([^]]*\)\].*/\1/p' CHANGELOG.md | head -1)"
rg -n "verification contract|review/test-gap" README.md CHANGELOG.md
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
cmp skills/dev-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md
cmp skills/qa-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
node --test tests/verification-contract.test.mjs tests/verification-contract-doc.test.mjs tests/updater.integration.test.mjs tests/spec-sweep-doc.test.mjs tests/agents-snippet.test.mjs tests/learning.test.mjs
```

Expected: version equals the newest changelog heading, all copy comparisons exit 0, and every focused test passes.

- [ ] **Step 7: Run the complete suite and compare with baseline**

```bash
node --test tests/*.test.mjs
```

Expected: ideally all tests pass if main fixed the two baseline fixture failures. Otherwise exactly the same two `tests/linear.test.mjs` cases fail for absent `repoRouting.byLabel`, with no COD-157 test failure and no additional failing test.

- [ ] **Step 8: Review scope and commit the release**

```bash
git diff --check
git diff --stat
git status --short
git add tests/updater.integration.test.mjs README.md VERSION CHANGELOG.md
git commit -m "chore(COD-157): release verification contract workflow"
```

Expected: only the fifteen planned physical files changed across the task commits; detector qualification stays unchanged and only validator/outcome runtime code changes.

## Failure-mode verification

| Failure | Test / handling | Operator result |
| --- | --- | --- |
| A required Spec omits stable obligations | Semantic contract test plus selected reviewer challenge | Card stays in Spec |
| Plan maps IDs only to a broad suite | Traceability test and reviewer instruction reject unnamed assertions | Plan is corrected before Dev |
| Proven legacy artifact lacks the declaration | Git first-add vs rollout-boundary comparison | Existing work uses legacy quality gate |
| Post-rollout or incomparable artifact lacks the declaration | Same comparison fails closed | Card bounces `missing-design` with exact evidence |
| Declared proof is missing/failing | Dev executes narrow proofs before review | Dev fixes implementation and reruns proof |
| New material risk has no obligation | Emit `review/test-gap`, bounce `missing-design` | Metric stays honest and Spec repairs design |
| QA cannot induce low-level behavior | Cite named lower-level proof and check nearest public outcome | QA avoids fake manual coverage |
| Canonical/installed skills drift | Copy equality and updater byte assertions fail | Release cannot pass |
| Concurrent COD-155 release changes VERSION | Task 5 rebases and increments live marker | No duplicate version or changelog overwrite |
| Baseline fixture failures remain | Full-suite comparison names exact two known failures | COD-157 cannot claim it introduced a green global baseline |

## Spec-sweep review audit

| Item | Decision / outcome |
| --- | --- |
| Initial tier | Tier 1 — Bounded, spec target; escalated after independent review |
| Final tier | Tier 2 — Material |
| Predicted footprint | 15 physical files / 11 logical artifacts; approximately 350-500 changed lines |
| Risk surfaces | Cross-stage workflow behavior, validator parsing, git ancestry, test-quality theater, honest evidence, outcome exposure, legacy compatibility, COD-155 overlap, and updater distribution; no auth/security/performance surface |
| Verification contract | `verification-contract/v1 — required` with V1-V6 mapped above |
| Correctness contract | `correctness-contract/v1 — required` with C1-C6 mapped above |
| Engineering spec review | Clear after adding a shared validator-owned rollout boundary, real history fixtures, proof-flow diagram, and exposure-aware evaluation |
| Independent adversarial review | Clear after five P1 corrections: exposure floor, C→V ownership, real validator, complete QA dispositions, and removal of semantic-enforcement overclaims. Current-runtime fallback used because configured Claude authentication was unavailable |
| UI/design lens | Skipped: no interaction, layout, accessibility, responsive behavior, or user flow |
| DevEx lens | Skipped: no public API/CLI/SDK ergonomics or adoption flow |
| Security lens | Skipped: no auth, secrets, production data, or untrusted external-input boundary |
| Performance lens | Skipped: no runtime hot path or benchmark surface |
| Research lens | Skipped: repository code and generated evidence are sufficient; no external integration |
| Plan engineering review | Clear after one correction: identify rollout by the first contract-literal commit rather than a mutable current version marker |

## Completed-plan review-depth reassessment

- **Concrete footprint:** validator + real-git fixtures, learning outcome + tests,
  three canonical/installed skill pairs, semantic doc test, updater fixture,
  README, VERSION, and CHANGELOG.
- **Dependency graph:** five sequential tasks: semantic RED, validator, cross-stage
  adoption, exposure-aware evaluation, then distribution/release.
- **Interfaces:** versioned Markdown declarations, bounded validator JSON/exit
  status, trusted review-completed observation, and existing release marker.
- **Failure handling:** deterministic legacy/post/incomparable history,
  fail-closed malformed proof, five-card exposure floor, complete QA disposition,
  honest finding emission, byte equality, updater propagation, and git revert.
- **Final tier:** Tier 2 — Material. The plan now changes multiple interacting
  workflow/evaluation modules and includes nontrivial git-history failure paths.
- **Specialized lenses:** unchanged and all skipped for recorded material reasons.
- **Plan engineering pass:** clear after replacing current-version marker lookup
  with first-introduction-of-contract-literal history, adding real ancestry
  fixtures, keeping one C→V executable map, requiring complete QA dispositions,
  and isolating the five-card exposure floor to repeated-review-finding outcomes.
- **Terminal review gate:** clear after final spec/plan consistency check; every
  Tier 2 review is reconciled and no decision remains unresolved.

## Schema and architecture impact

No schema change. Task 5 changes README's docs-only planned COD-157 note to active
architecture: repeated test-gap evidence drives a versioned prevention contract
without changing Factory Learning measurement or weakening delivery gates.

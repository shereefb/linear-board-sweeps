# COD-158 Performance Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a versioned, risk-proportional performance contract from Spec budgets through SHA-bound Dev proof and honest QA consumption without weakening any existing gate.

**Architecture:** Extend the Markdown-driven Spec, Dev, and QA workflow rather than adding runtime persistence or a benchmark runner. Performance-sensitive specs declare stable `P1..Pn` IDs and one of two closed proof kinds; Dev binds results to a pushed commit; QA reruns or validates ancestry and invalidates stale evidence. Existing updater/version machinery distributes canonical skill bytes.

**Tech Stack:** Markdown `SKILL.md` contracts, Node.js built-in test runner, real-git updater integration fixtures, Git, Linear handoff comments.

## Global Constraints

- Owning repo: `linear-board-sweeps` only.
- Docs/workflow implementation only; no application code, database, migration, runtime evidence schema, or production deploy.
- Preserve engineering review, `/benchmark`, both code reviews, QA, Signoff, and human Ship.
- Each `P` ID chooses exactly one proof kind: `measured` or `deterministic-bound`.
- `measured`: tested SHA, command/fixture, relevant environment, warm-up/repetitions, baseline, candidate, statistic, threshold, result.
- `deterministic-bound`: tested SHA, declared bound, assertion command/fixture, observed maximum or result, pass/fail.
- Never fabricate fields from the other proof kind.
- Canonical and installed copies of every changed sweep skill remain byte-identical.
- Reuse one artifact-introduction-versus-`.sweep-version` decision for every absent versioned contract in either COD-155/COD-158 landing order.
- Increment the four-part `VERSION` from implementation-time `main`; never reuse a stale planned number.
- Generated cards remain fast-path ineligible and follow QA -> Signoff -> human Ship.

---

## Repo scope

Repository: `linear-board-sweeps`. Branch: `codex/COD-158-<topic>` from current
`origin/main`. QA evidence is focused documentation tests, real-git updater tests, the
full Node suite, exact copy comparisons, and a Spec -> Dev -> QA contract read-through.
There is no browser evidence or runtime benchmark for this docs-only implementation.
Deploy target: none; shipping is merge/push to `main`.

## What already exists

- `skills/spec-sweep/SKILL.md:46-70` owns performance review and plan audits.
- `skills/dev-sweep/SKILL.md:35-50` owns `/benchmark`, both code reviews, and QA handoff.
- `skills/qa-sweep/SKILL.md:42-61` owns branch reconstruction and `qa:passed`.
- Matching `.claude/skills/*` files are exact installed mirrors.
- `tests/spec-sweep-doc.test.mjs` protects current performance safety floors.
- `tests/updater.integration.test.mjs:21-56` refreshes an old marker through real git.
- `scripts/linear-watch.mjs` already distributes skills using `VERSION`.
- COD-155 defines a compatible `correctness-contract/v1`, but its implementation may or
  may not be on `main` when COD-158 starts.

## NOT in scope

- Factory Learning detector/fingerprint changes; they do not prevent the source omissions.
- A benchmark database or JSON evidence schema; pushed git plus Linear comments suffice.
- Universal thresholds; each feature owns its measured threshold or deterministic bound.
- Direct edits to SafeTaper Guide or zomes_sdr; the updater distributes new skills.
- Reimplementation of the existing 14-day Factory Learning outcome evaluation.

## File responsibility map

| File(s) | Responsibility |
| --- | --- |
| `tests/performance-contract-doc.test.mjs` | Cross-stage contract, closed proof kinds, SHA identity, invalidation, ordering, copy equality. |
| Spec skill pair | Applicability, `P` budget table, reviewer challenge, plan traceability. |
| Dev skill pair | Shared legacy gate, kind-specific proof, SHA-bound handoff, honest bounce. |
| QA skill pair | Evidence consumption, SHA/ancestry proof, rerun and invalidation. |
| `tests/updater.integration.test.mjs` | Exact old-marker skill propagation. |
| `VERSION`, `CHANGELOG.md`, `README.md` | Distribution marker and active architecture. |

## Data and handoff flow

```text
Spec {P id, workload, proofKind, budget, fixture, degradation, owner}
  -> Plan {P id, tasks, command, passCondition, QA observation, risk}
  -> Dev proof on pushed SHA
       measured: env + repeats + baseline/candidate/stat/threshold/result
       deterministic: bound + assertion + observed result + pass/fail
  -> durable Linear handoff
  -> QA on same/descendant SHA with no affected-path change, or proof rerun
```

A QA fix touching a `P` path invalidates proof. A missing budget/fixture is a design
defect and returns to Spec with `review/performance`; an implementation miss stays in Dev.

## Correctness traceability

| ID | Tasks | Test / assertion | QA observation | Residual risk |
| --- | --- | --- | --- | --- |
| `C1` | 1-2 | Doc test locks applicability and Tier 0 escalation. | Inspect real generated audit. | Agent classification remains judgment; rollout samples it. |
| `C2` | 1-2 | Doc test locks both closed shapes and plan fields. | Read one example of each proof kind. | Benchmark quality remains repo-specific. |
| `C3` | 1-2 | Dev contract requires pushed SHA and kind-specific evidence. | Resolve cited SHA and compare QA candidate. | Comment completeness depends on compliance. |
| `C4` | 1-2 | QA contract requires ancestry/path checks and invalidation. | Synthetic affected-path change forces rerun/return. | Path classification needs reviewer judgment. |
| `C5` | 3 | Raw Buffer updater comparison plus direct `cmp`. | Verify versioned installed bytes. | Inactive anchors use existing doctor/Todo recovery. |

## Dependency graph

```text
Task 1 failing contract tests
  -> Task 2 Spec/Dev/QA canonical skills and mirrors
  -> Task 3 updater proof, release marker/docs, full verification
```

Sequential implementation, no parallelization opportunity: all tasks touch the same
contract or consume exact bytes from the preceding task.

### Task 1: Lock the cross-stage contract with failing tests

**Files:**

- Create: `tests/performance-contract-doc.test.mjs`
- Read: `skills/{spec,dev,qa}-sweep/SKILL.md`

**Interfaces:** Consumes canonical/mirrored Markdown. Produces a semantic documentation
contract; no runtime export.

- [ ] **Step 1: Inspect whether COD-155 has landed**

```bash
git fetch origin main
git merge --ff-only origin/main
rg -n "correctness-contract/v1|artifact.*first introduced|\.sweep-version" \
  skills/{spec,dev,qa}-sweep/SKILL.md
```

Expected: matches if COD-155 is active, otherwise exit 1. Record the source state and
preserve newer active text.

- [ ] **Step 2: Create the failing test**

Create `tests/performance-contract-doc.test.mjs`:

```js
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
  assert.match(joined, /(one|single) shared/i);
  assert.match(joined, /artifact[^]*first introduced[^]*\.sweep-version/i);
  assert.match(joined, /(performance.*first|COD-158.*first)[^]*(install|create)[^]*shared/i);
  assert.match(joined, /(correctness.*present|COD-155.*first)[^]*(reuse|extend)[^]*shared/i);
  assert.match(joined, /missing or incomparable[^]*fail closed/i);
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
```

- [ ] **Step 3: Verify RED**

```bash
node --test tests/performance-contract-doc.test.mjs
```

Expected: the first five tests fail; exact copy equality stays green.

- [ ] **Step 4: Commit the failing test**

```bash
git add tests/performance-contract-doc.test.mjs
git commit -m "test(COD-158): define performance contract handoffs"
```

### Task 2: Carry closed proofs through Spec, Dev, and QA

**Files:**

- Modify: `skills/spec-sweep/SKILL.md:46-70` and installed mirror
- Modify: `skills/dev-sweep/SKILL.md:35-55` and installed mirror
- Modify: `skills/qa-sweep/SKILL.md:42-61` and installed mirror
- Test: `tests/performance-contract-doc.test.mjs`

**Interfaces:** Consumes adaptive tiers, `/benchmark`, both code reviews, QA pass gate,
and optional correctness contract. Produces applicability, `P` rows, plan traceability,
SHA-bound proof, and QA ancestry/invalidation rules.

- [ ] **Step 1: Add applicability and budget rows to Spec**

Add after brainstorming and before selected review:

```markdown
**Performance contract (versioned, risk-proportional).** Every draft spec and plan audit
contains `Performance contract: performance-contract/v1 — required | not required —
<concrete rationale>`. Decide from the actual performance surface, never labels alone.
`required` covers material latency, throughput, memory, payload, query/network/storage
fan-out, pagination, retry/deadline, cache, prefetch, background work, or visible
performance failure. A material surface escalates Tier 0 to at least Tier 1.

A required spec adds stable `P1..Pn` rows: `Workload / critical path`, `Proof kind`,
`Budget or hard bound`, `Measurement / fixture`, `Degradation / abort behavior`, and
`Owner / observation`. `measured` requires environment, baseline, candidate, statistic,
threshold, and result. `deterministic-bound` requires declared bound, test/assertion
command, observed maximum or result, and pass/fail. Never fabricate fields from the
other proof kind or invent an owner-only threshold.
```

Extend the engineering review performance section to challenge hidden work,
representative fixtures, comparable statistics, stopping behavior, and failure semantics.

- [ ] **Step 2: Add traceability and one shared legacy decision**

Require a `Performance traceability` table mapping each `P` ID to `Proof kind`,
`Implementing task(s)`, `Proof command / fixture`, `Expected evidence and pass condition`,
`QA observation`, and `Residual risk`.

If COD-158 is first, create one versioned-contract history decision using artifact
introduction versus installed `.sweep-version`. If COD-155 is active, extend that same
decision. Proven pre-boundary artifacts use the legacy gate; missing or incomparable
history fails closed. Never duplicate the git-history algorithm per contract.

- [ ] **Step 3: Make Dev execute and persist SHA-bound proof**

Add before broad verification, keeping both code-review passes unchanged:

```markdown
For `performance-contract/v1 — required`, map every `P` ID to the diff and run its proof
through `/benchmark`. `measured` records tested SHA, command/fixture, relevant environment,
warm-up/repetitions, baseline, candidate, statistic, threshold, and result.
`deterministic-bound` records tested SHA, declared bound, assertion command/fixture,
observed maximum or result, and pass/fail. After pushing the tested commit, record each
ID, bounded output/result location, proof kind, and result in the Linear QA handoff.

Fix implementation misses in Dev. A missing budget, invalid fixture, or material contract
defect emits `review/performance` and returns to Spec as `missing-design`.
```

- [ ] **Step 4: Make QA validate identity and invalidation**

```markdown
For `performance-contract/v1 — required`, use every `P` ID and `QA observation` as primary
input. Rerun when reproducible. Otherwise prove the cited Dev SHA is the tested commit or
its ancestor with no affected-performance-path changes, cite durable evidence, explain
the limitation, and exercise the nearest public outcome. A QA fix touching a `P` path
invalidates proof and requires rerun or return to Dev. Missing, stale, contradictory, or
failed required evidence cannot receive `qa:passed`.
```

- [ ] **Step 5: Synchronize installed copies and verify exact equality**

Use the repository's byte-preserving copy mechanism, then:

```bash
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
cmp skills/dev-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md
cmp skills/qa-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
```

Expected: three zero exits with no output.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test tests/performance-contract-doc.test.mjs tests/spec-sweep-doc.test.mjs tests/agents-snippet.test.mjs
git add tests/performance-contract-doc.test.mjs \
  skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md \
  skills/dev-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md \
  skills/qa-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
git commit -m "feat(COD-158): trace performance proofs across sweeps"
```

Expected: all focused tests pass before commit.

### Task 3: Prove distribution and activate the architecture

**Files:**

- Modify: `tests/updater.integration.test.mjs:21-56`
- Modify: `VERSION:1`
- Modify: `CHANGELOG.md:1-24`
- Modify: `README.md:3-13`

**Interfaces:** Consumes `refreshAnchorSkills(anchor, KIT, marker)` and Task 2 bytes.
Produces exact propagation evidence, a unique next version, release note, active README.

- [ ] **Step 1: Add exact byte assertions to the updater fixture**

After marker assertions in the first updater test, compare raw `git show` bytes with the
canonical Buffer. Do not trim. Prefer this implementation:

```js
for (const stage of ["spec", "dev", "qa"]) {
  const shown = spawnSync(
    "git",
    ["show", `main:.claude/skills/${stage}-sweep/SKILL.md`],
    { cwd: anchor, encoding: null },
  );
  assert.equal(shown.status, 0, shown.stderr.toString("utf8"));
  assert.deepEqual(
    shown.stdout,
    fs.readFileSync(path.join(KIT, "skills", `${stage}-sweep`, "SKILL.md")),
    `${stage}-sweep bytes were not propagated`,
  );
}
```

- [ ] **Step 2: Verify updater behavior before release edits**

```bash
node --test tests/updater.integration.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Compute and apply the next four-part version**

```bash
CURRENT=$(cat VERSION)
NEXT=$(node -e 'const v=process.argv[1].split(".").map(Number); if(v.length!==4||v.some(Number.isNaN)) process.exit(2); v[3]++; process.stdout.write(v.join("."));' "$CURRENT")
printf 'current=%s next=%s\n' "$CURRENT" "$NEXT"
```

Expected on current `1.2.0.5`: next is `1.2.0.6`. If another release landed, increment
that actual value. Update `VERSION` to `$NEXT` with `apply_patch`.

- [ ] **Step 4: Add release notes and activate README**

Add a top CHANGELOG entry for `$NEXT` describing:

```markdown
### Changed

- Carry versioned performance budgets from Spec into kind-specific, commit-bound Dev
  proof and honest QA consumption without weakening existing review or Ship gates.
- Distinguish measured benchmarks from deterministic work bounds for pagination, retry,
  prefetch, latency, and resource constraints.

### Fixed

- Invalidate stale proof after affected-path QA changes and share one fail-closed legacy
  boundary with other versioned contracts in either landing order.
- Bump the marker so installed anchors receive all three sweep skill updates.
```

Replace README's planned COD-158 paragraph with the same architecture in active voice.
Preserve COD-155 in whatever planned/active state current `main` supplies.

- [ ] **Step 5: Run focused and full verification**

```bash
test "$(cat VERSION)" = "$NEXT"
rg -n "$NEXT|performance contract|commit-bound" CHANGELOG.md README.md
node --test tests/performance-contract-doc.test.mjs tests/spec-sweep-doc.test.mjs \
  tests/updater.integration.test.mjs tests/agents-snippet.test.mjs
node --test tests/*.test.mjs
git diff --check
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
cmp skills/dev-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md
cmp skills/qa-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
git status --short
```

Expected: zero failures, clean diff check, exact copies, and exactly eleven planned files.

- [ ] **Step 6: Commit release and distribution evidence**

```bash
git add tests/updater.integration.test.mjs VERSION CHANGELOG.md README.md
git commit -m "chore(COD-158): release performance contract workflow"
```

## Test coverage diagram

```text
Spec applicability                    Installed distribution
  [DOC] material -> required            [BYTE] Spec exact
  [DOC] nonmaterial -> not required      [BYTE] Dev exact
  [DOC] perf Tier 0 -> Tier 1             [BYTE] QA exact
Proof kind                            Dev -> QA identity
  [DOC] measured closed fields           [DOC] tested SHA
  [DOC] deterministic closed fields      [DOC] ancestry/path stability
Shared legacy boundary                   [DOC] relevant fix invalidates
  [DOC] COD-158 first installs
  [DOC] COD-155 first extends

Behavior: [ROLLOUT SAMPLE] first three eligible required contracts
Outcome:  [FACTORY LEARNING] reviewFindingCount over 14 days
```

Static tests lock instructions, not future agent judgment. Rollout sampling covers that
known limitation without a runtime parser.

## Failure-mode verification

| Failure | Handling | Result |
| --- | --- | --- |
| Material work says `not required` | Spec test + engineering review | Remains in Spec. |
| Deterministic bound forced into measured schema | Closed-shape test | Uses bound/assertion/result. |
| Measured proof lacks environment/repeats | Dev contract gate | QA handoff blocked. |
| Proof cites another commit | Tested-SHA rule | QA reruns or rejects. |
| QA changes affected path | Invalidation rule | Rerun or return to Dev. |
| Environment cannot reproduce | Ancestry/path proof + limitation | Credible Dev proof plus public behavior. |
| Missing budget found in Dev | `review/performance` + bounce | Spec repairs; metric stays honest. |
| Either COD-155/COD-158 lands first | One shared gate | Later contract extends, never overwrites. |
| Marker does not distribute bytes | Raw Buffer test + version bump | Release fails. |

No identified failure is silent with neither a test nor handling.

## Spec-sweep review audit

| Item | Decision / outcome |
| --- | --- |
| Initial tier | Tier 1 — Bounded, spec target |
| Final tier | Tier 1 — Bounded, unchanged after completed-plan reassessment |
| Predicted/concrete footprint | 11 physical files / 7 logical artifacts; six mirrored skill paths, two tests, VERSION, CHANGELOG, README |
| Risk surfaces | Applicability, proof-shape mismatch, SHA identity, path invalidation, legacy ordering, distribution |
| Correctness contract | `correctness-contract/v1` — required — C1-C5 mapped above |
| Performance contract | `performance-contract/v1` — not required for this docs-only diff; future governed cards use it |
| Engineering spec review | Clear after proof kinds, SHA identity, outcome contract, honest test scope, and both merge orderings |
| Independent adversarial review | Clear after correction re-review; current-runtime reviewer used because explicit Claude dispatch was unsupported |
| Plan engineering review | Not selected; Tier 1's one engineering pass targeted the spec |
| UI/DevEx/Security/Research | Skipped with no applicable interface, public API, security boundary, or external research surface |
| Performance lens | Candidate label; implementation benchmark skipped because no runtime path changes; downstream cards require proof |
| Terminal gate | Clear: selected reviews reconciled, spec/plan agree, no unresolved decisions |

## Completed-plan review-depth reassessment

The plan remains three sequential tasks using established docs/updater mechanisms. Closed
proof kinds and SHA/ancestry rules add handoff detail but no runtime state, persistence,
API, dependency, migration, concurrency, auth, destructive operation, or irreversible
rollout. The six skill paths are three required mirror pairs, not independent subsystems.
Final tier remains **Tier 1 — Bounded**. The selected spec engineering pass and
independent review are clear; Tier 1 requires no plan pass. COD-158 itself has no
benchmarkable hot path, while future governed cards retain `/benchmark`.

## Schema and architecture impact

No persisted schema. Task 3 changes README's COD-158 note to active only after skill
bytes, tests, version, and propagation are green.

## Implementation Tasks

- [ ] **T1 (P1, human: ~1h / agent: ~10min)** — Lock the cross-stage contract in a failing test; verify with the focused Node command.
- [ ] **T2 (P1, human: ~3h / agent: ~25min)** — Carry closed SHA-bound proof through all three canonical/mirrored sweep skills; verify focused tests and `cmp`.
- [ ] **T3 (P1, human: ~1h / agent: ~10min)** — Prove exact updater bytes, bump the live version, activate docs, and pass the full suite.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | Not selected | Bounded factory-generated workflow remedy |
| Independent Review | reviewer subagent | Premise/failure modes | 2 | CLEAR | Five findings corrected; re-review clear |
| Eng Review | `/plan-eng-review` | Architecture/tests/performance | 1 | CLEAR | Five issues folded; zero critical gaps |
| Design Review | `/plan-design-review` | UI/UX | 0 | Not applicable | No UI scope |
| DX Review | `/plan-devex-review` | Public DX | 0 | Not applicable | No public API/CLI/SDK scope |

**VERDICT:** ENG + INDEPENDENT REVIEW CLEARED — ready for Dev.

NO UNRESOLVED DECISIONS

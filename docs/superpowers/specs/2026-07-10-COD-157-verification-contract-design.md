# COD-157 Risk-Linked Verification Contract Design

## Summary

Factory Learning observed five independent `review/test-gap` findings across
three workspaces in a six-hour window. The learning pipeline already preserves
these as trusted, bounded `review-finding` observations, groups them by category,
and evaluates the post-change count. The recurring gap is earlier in delivery:
Spec and Plan do not require a stable, risk-linked verification obligation that
Dev must prove and QA must consume.

COD-157 adds `verification-contract/v1`, a small cross-stage artifact carried
from Spec through Plan, Dev, and QA. It does not generate tests, replace TDD or
review, lower review thresholds, or suppress `review/test-gap` evidence. It
makes the intended proof explicit early enough that an omitted test is more
likely to be prevented than rediscovered during review.

## Context and evidence

The current implementation has the right measurement primitives:

- `scripts/learning.mjs:18-25` admits `review/test-gap` as a closed structured
  event category.
- `scripts/learning.mjs:295-311` defines `reviewFindingCount` as an occurrence
  count, so the acceptance metric is not inferred from prose.
- `scripts/learning.mjs:327-375` derives trusted review observations from the
  scheduled run identity rather than accepting caller-supplied ownership.
- `scripts/learning.mjs:810-824` requires three distinct cards for the
  `repeated-review-finding` detector.
- The canonical sweep skills already require material review findings to be
  emitted honestly, including `test-gap`, but they do not carry one stable map
  from requirement/risk to planned proof and QA evidence.
- The planned COD-155 `correctness-contract/v1` covers state and failure
  invariants. COD-157 is complementary: every correctness invariant needs a
  verification obligation, but verification obligations also cover ordinary
  acceptance behavior, regressions, error branches, compatibility, and
  configuration cases that are not correctness invariants.

The baseline repository suite currently reports 431/433 passing. The two
pre-existing failures are in `tests/linear.test.mjs` fixtures that expect a
non-empty `repoRouting.byLabel`; COD-157 must not hide or expand those failures.

## Assumptions

1. The five observations reflect real review discoveries, not a detector or
   routing defect. The detector already requires distinct card identities and
   the generated card reports complete coverage.
2. Prevention belongs in the shared canonical sweep workflow because the
   evidence spans multiple workspaces and the generated card routes ownership
   to the core `linear-board-sweeps` repository.
3. The contract must be useful for both behavior changes and small mechanical
   work. Mechanical cards may declare it not required with evidence; boilerplate
   test matrices would create review theater rather than quality.
4. COD-155 may land before, during, or after implementation. COD-157 must compose
   with its correctness contract and must not depend on a specific unmerged
   commit or pre-claim a release number.

## Goals

- Require each material acceptance behavior and risk to have one stable
  verification obligation before implementation begins.
- Make the implementation plan name the exact test layer, file, command, and
  falsifiable assertion for every obligation.
- Make Dev execute the declared narrow proofs and retain independent review as
  a separate discovery gate.
- Make QA trace user-observable obligations without pretending that manual QA
  can prove low-level races, atomicity, or persistence integrity.
- Preserve honest `review/test-gap` learning evidence and evaluate success using
  the existing 14-day `reviewFindingCount` contract only when at least five
  distinct post-change cards have a measured `review/completed` event. A window
  with less exposure is inconclusive, never verified improvement.
- Distribute the workflow change to installed anchors through the existing kit
  version/update mechanism.

## Non-goals

- Changing detector qualification thresholds, evidence identity, aggregation,
  routing, or the generated card's primary acceptance metric. COD-157 adds an
  exposure floor to outcome evaluation; it does not change what creates a card.
- Automatically generating tests or treating line/branch coverage percentages
  as proof of behavior.
- Requiring one test per implementation task when several tasks implement one
  externally meaningful obligation.
- Replacing TDD, code review, engineering review, QA, Signoff, or the human Ship
  gate.
- Repairing the two unrelated baseline fixture failures.

## Approaches considered

### A. Carry a versioned risk-linked verification contract across stages (recommended)

Spec assigns stable `V1..Vn` obligations to material behavior and risks. Plan
maps each ID to exact automated proof and QA evidence. Dev executes those proofs
and reviewers remain free to find undeclared gaps. QA consumes the same IDs.

**ELI10:** write down what could break, how a test would catch it, and keep that
same checklist through building and checking the feature.

**Completeness: 9/10.** This prevents omissions at their source, composes with
COD-155, and preserves the independent discovery signal. It adds bounded
process text and documentation-contract tests but no runtime state.

### B. Strengthen only the Dev reviewer checklist

Tell both reviewers to inspect more categories and require a test for each
finding.

**ELI10:** keep building the same way, but ask the inspector to look harder at
the end.

**Completeness: 5/10.** It may find more gaps, but it does not reduce rework or
give Spec, Plan, Dev, and QA a shared proof identity. Initially it can increase
the measured finding count without improving prevention.

### C. Generate tests automatically from review findings

When a reviewer emits `test-gap`, synthesize and add a test in Dev.

**ELI10:** wait for the inspector to find a missing lock, then have a robot make
one.

**Completeness: 3/10.** It is reactive, crosses the reviewer/implementation trust
boundary, and cannot reliably infer the correct assertion from bounded evidence.
It also risks optimizing the metric by absorbing findings instead of improving
planning.

## Design

### 1. Spec declares applicability and stable obligations

Every new Spec and Plan audit contains:

`Verification contract: verification-contract/v1 — required | not required — <rationale>`

It is `required` whenever the card changes behavior, state, persistence,
interfaces, dependencies, error handling, compatibility, rollout, or a
user-visible outcome. It may be `not required` only for a truly mechanical or
docs-only change with objective verification and no material regression risk.
If material obligations appear on a proposed Tier 0 card, the card escalates to
at least Tier 1.

A required spec contains this table before selected review:

| ID | Source requirement / C ID(s) | Behavior / risk | Failure this proof must catch | Required proof | Acceptance |
| --- | --- | --- | --- | --- | --- |
| `V1..Vn` | Acceptance requirement, or required COD-155 `C` IDs | One material behavior, failure branch, regression, or correctness invariant | A concrete bad implementation, not a generic quality concern | The proof boundary and appropriate layer | A falsifiable expected result |

Rows are risk-proportional. Authors consider happy paths, boundary values,
malformed or unavailable dependencies, error/rollback paths, regression of
existing behavior, compatibility, configuration variants, and every required
COD-155 correctness invariant. Every required `C` ID appears in exactly one `V`
row; one `V` row may cover several inseparable `C` IDs. `C` IDs remain the
authoritative invariant identity, `V` IDs own executable proof, and downstream
Dev/QA reporting is keyed by `V` with source `C` IDs retained. They omit
categories that are immaterial and explain material exclusions in prose.

### 2. Plan makes every obligation executable

For `verification-contract/v1 — required`, the implementation plan adds one
authoritative executable `Verification traceability` table. If
`correctness-contract/v1` is present, this table replaces its separate
executable mapping rather than duplicating it; the correctness invariant table
remains the design source:

| ID | Implementing task(s) | Test layer and file | RED signal | GREEN command / assertion | QA evidence | Residual gap |
| --- | --- | --- | --- | --- | --- | --- |

Each ID needs a deterministic automated proof unless automation is genuinely
impossible. An exception names the reason, the nearest deterministic substitute,
the owner of the manual evidence, and the residual risk; “manual QA” alone is
not sufficient for races, atomicity, persistence, serialization, or other
low-level behavior a user cannot reliably induce.

The plan may map one focused test to several IDs when its assertions independently
prove them. It may not map several IDs to a broad full-suite command with no
named assertion. Exact commands are narrow proofs; the full suite remains a
separate regression gate.

### 3. Dev validates the contract before and after implementation

Dev performs a verification-contract quality gate before coding by running a
small deterministic repository helper:

```bash
node scripts/verification-contract.mjs validate --spec <spec-path> --plan <plan-path>
```

The helper parses the declaration, required table headers, unique `V` IDs,
one-to-one coverage of required `C` IDs, and complete plan mappings. When a
declaration is missing, it finds the artifact first-add commit and the first
commit that introduced the literal `verification-contract/v1` into the installed
`.claude/skills/spec-sweep/SKILL.md` (or canonical
`skills/spec-sweep/SKILL.md` in this kit), then uses
`git merge-base --is-ancestor` in both directions:
artifact ancestor of rollout is legacy; rollout ancestor of artifact is
post-rollout; neither, missing commits, or shallow history is incomparable.
Post-rollout and incomparable cases fail closed with structured diagnostics.

The gate then applies these outcomes:

- `required` needs both obligation and traceability tables with every ID mapped.
- `not required` is accepted only if the actual plan and expected diff have no
  material verification surface.
- For artifacts introduced after rollout, a missing contract is a
  `missing-design` bounce. Proven pre-rollout artifacts use the existing legacy
  quality gate. COD-155 and COD-157 call this one helper; no skill reimplements
  ancestry logic in prose.

During implementation, TDD remains the coding method. Before formal code review,
Dev maps every `V` ID to the actual diff and executes its declared narrow proof,
then runs the normal relevant/full suite. A missing or failing declared test is
implementation work and is fixed in Dev. A newly discovered material behavior
or risk with no obligation is a design defect: emit the existing
`review/test-gap` event and bounce to Spec with `missing-design`. The finding is
never relabeled or suppressed to improve the metric.

### 4. Review challenges proof quality, not table presence

The selected engineering reviewer and independent adversarial reviewer verify
that:

- every material requirement, error path, regression surface, and correctness
  invariant has an obligation;
- the proposed test can fail for the named bad implementation;
- the chosen layer is the lowest stable boundary that proves behavior without
  over-mocking internals;
- broad suite commands do not stand in for named assertions;
- exclusions and manual exceptions have explicit residual risk.

Reviewers continue to emit one `review/test-gap` event for each verified material
gap. Contract compliance does not convert a discovery into a non-finding.

### 5. QA consumes IDs honestly

QA uses the plan's `V` IDs beside the engineering test plan and records a
disposition for every ID. User-observable obligations need exercised product
evidence. A low-level obligation that cannot be induced safely or reliably needs
the exact green lower-level command/assertion from Dev plus the nearest public
outcome. Any approved exception names its owner and residual risk. One covered
ID cannot hide missing siblings: a required contract with any undisposed `V` ID
cannot receive `qa:passed`.

### 6. Distribution and rollout

The canonical `skills/{spec,dev,qa}-sweep/SKILL.md` files and their installed
`.claude/skills/` copies change byte-for-byte. A focused documentation test locks
the cross-stage semantics. The existing updater integration fixture proves that
all changed skill bytes and the version marker propagate to an older anchor.

Implementation rebases on current `main` and selects the next unused patch
version. COD-155 currently plans `1.2.0.6`; if that release has landed, COD-157
uses the next patch. If it has not, implementation must not overwrite or
duplicate its planned changelog entry and must reconcile the shared skill text
before choosing the release marker.

Rollback is a normal revert plus a new patch release. Existing artifacts retain
their declarations; pre-rollout artifacts remain under the documented legacy
gate.

### 7. End-to-end proof flow

```text
Linear card + code context
          |
          v
Spec: V1..Vn obligations ---- selected reviewers challenge missing risks
          |                                      |
          v                                      | verified gap
Plan: exact RED/GREEN proof map                  v
          |                            review/test-gap evidence
          v                                      |
Dev: TDD + narrow proof execution + normal code review
          |
          v
QA: public observation or cited lower-level proof
          |
          v
Signoff -> human Ship -> Done -> existing 14-day outcome evaluation
```

The contract remains an agent-readable Markdown control plane, but one bounded
validator parses its required structure and rollout history. Semantic
documentation tests protect agent instructions; validator fixtures prove actual
artifact acceptance/rejection; independent review challenges proof quality,
which a parser cannot determine.

### 8. Exposure-aware outcome evaluation

`reviewFindingCount` remains the generated card's primary metric and target 0.
For `repeated-review-finding`, outcome evaluation also counts distinct post-Done
cards with a trusted `review/completed` event within the same ownership and
14-day window. Fewer than five reviewed cards yields `inconclusive` even when the
finding count is zero. Five or more reviewed cards allows the existing direction
and target comparison. This closes the current behavior where an empty
post-change window can be labeled `verified-improvement`.

## Correctness contract

`Correctness contract: correctness-contract/v1 — required` because COD-157
changes the workflow gate and the evidence required to advance a card.

| ID | Trigger / transition | Required invariant | Forbidden outcome | Recovery / ownership | Verification |
| --- | --- | --- | --- | --- | --- |
| C1 | Spec or Plan declares verification required | Every stable `V` ID appears exactly once in the plan traceability map | A card advances with an unmapped material obligation | Spec owns obligation repair; Plan owns executable mapping | Documentation-contract tests plus reviewer trace |
| C2 | Dev evaluates a post-rollout artifact | Missing/incomplete required contracts fail closed; proven legacy artifacts keep the existing gate | Guessing rollout status from prose or silently accepting an incomparable artifact | Dev bounces with exact evidence; Spec repairs the artifact | Legacy/new/incomparable fixture cases |
| C3 | Dev executes declared proofs | Every `V` ID maps to the actual diff and a falsifiable result before review | A broad green suite is reported as proof without the named assertion | Dev fixes implementation gaps; undeclared material risk bounces to Spec | Focused doc test and downstream proof audit |
| C4 | Review finds a material missing test | Existing `review/test-gap` evidence is emitted unchanged | Contract compliance suppresses or reclassifies a finding to improve metrics | Reviewer records evidence; Spec or Dev owns correction by defect type | Learning taxonomy regression assertion plus skill contract test |
| C5 | QA handles a low-level obligation | QA cites deterministic lower-level evidence and checks the closest public outcome | QA claims manual coverage for an uninduced race, atomicity, or persistence path | QA returns changes if evidence is absent | QA skill contract assertion and card evidence audit |
| C6 | Canonical workflow is released | Canonical and installed copies plus rollout marker remain synchronized | Some anchors run mixed contract semantics under one marker | Updater fails closed; maintainer publishes a corrected patch | Byte equality and updater integration fixture |

## Verification contract

`Verification contract: verification-contract/v1 — required` because COD-157
changes workflow gates, outcome evaluation, and cross-stage evidence.

| ID | Source requirement / C ID(s) | Behavior / risk | Failure this proof must catch | Required proof | Acceptance |
| --- | --- | --- | --- | --- | --- |
| V1 | Acceptance 1; C1 | Required specs declare unique obligations and plans map every ID | A missing or duplicate ID advances | Validator fixtures for valid, missing, and duplicate mappings | Valid pair exits 0; malformed pairs exit nonzero with exact diagnostics |
| V2 | Acceptance 3; C2 | Legacy, post-rollout, and incomparable artifacts classify deterministically | New work bypasses the gate or legacy work is needlessly bounced | Temporary git-repository fixtures covering both ancestry directions and divergence | Legacy accepted; post/incomparable rejected |
| V3 | Acceptance 2-4; C3-C4 | Dev executes named proofs and preserves findings | Broad suite substitutes for proof or finding is hidden | Semantic skill tests plus dogfood review audit | Every V maps to a named result and every verified gap remains an event |
| V4 | Acceptance 5; C5 | QA disposes every obligation honestly | One ID-linked observation masks uncovered IDs | Semantic skill test and fixture artifact with partial dispositions | Any missing disposition blocks pass |
| V5 | Acceptance 6; C6 | Canonical and installed skills plus marker propagate together | Mixed skill semantics share one marker | Copy equality and updater integration byte assertions | All three pairs and installed bytes match |
| V6 | Acceptance 8 | Outcome improvement requires comparable review exposure | Zero review activity is reported as improvement | Learning evaluator tests for 0, 4, and 5 distinct completed-review cards | Under five is inconclusive; five uses existing metric comparison |

## Error handling and edge cases

- **No material test surface:** allow `not required` with a concrete objective
  verification rationale; do not generate ceremonial IDs.
- **One test proves multiple obligations:** allow it only when named assertions
  independently establish every mapped acceptance result.
- **Test is flaky or environment-dependent:** it is not acceptable as the sole
  deterministic proof. Plan a stable lower-level proof and retain environment QA
  as supplementary evidence.
- **A reviewer discovers an undeclared risk:** preserve the finding event and
  repair the design; do not patch only the table after implementation.
- **COD-155 lands concurrently:** rebase, preserve one rollout-boundary rule,
  compose correctness IDs into verification IDs, and rerun copy/distribution
  tests.
- **No post-change reviews:** outcome evaluation is inconclusive even when the
  finding count is zero; it never proves prevention from silence.
- **Existing baseline failures remain:** focused COD-157 tests must be green. The
  final full suite reports the known two failures separately unless main has
  fixed them; COD-157 may not broaden their footprint or mask exit status.

## Acceptance criteria

1. Canonical Spec instructions require risk-proportional applicability and
   stable verification obligations before selected review.
2. Plans map every required obligation to task, exact test layer/file, RED
   signal, GREEN command/assertion, QA evidence, and residual gap.
3. Dev fails closed on incomplete post-rollout contracts, executes declared
   proofs before formal review, and distinguishes implementation gaps from
   missing-design gaps.
4. Review continues to emit `review/test-gap` for every verified material gap.
5. QA records ID-linked observable evidence and cites deterministic lower-level
   proof for paths it cannot safely induce.
6. Canonical and installed Spec/Dev/QA skill copies are byte-identical and an
   updater fixture proves distribution under the selected release marker.
7. The validator accepts a complete artifact pair, rejects incomplete/duplicate
   mappings, accepts proven legacy absence, and rejects post-rollout,
   incomparable, missing, or shallow history with exact diagnostics.
8. Focused contract tests pass. The full suite introduces no new failures beyond
   the two recorded baseline fixture failures, unless those failures are fixed on
   main before implementation.
9. After Done, Factory Learning evaluates the existing 14-day contract only
   after five distinct reviewed cards: reduce `reviewFindingCount` from baseline
   5 toward target 0 for semantic key `test-gap`, without bypassing any gate.

## Review depth decision

| Dimension | Decision |
| --- | --- |
| Predicted footprint | 15 physical files / 11 logical artifacts: validator + fixture test, learning evaluator + tests, three canonical skill pairs, doc-contract test, updater fixture, README, VERSION, and CHANGELOG; approximately 350-500 changed lines |
| Behavior/state/persistence | Changes cross-stage workflow behavior, artifact validation, rollout compatibility, and learning outcome semantics; no persistent schema migration |
| Interfaces/dependencies | Adds an internal versioned Markdown handoff contract; no public API, CLI, SDK, package, or external integration |
| Failure/rollout | New fail-closed quality gate and versioned anchor propagation; reversible patch release |
| Material risks | Coverage theater, metric gaming, legacy compatibility, overlap with planned COD-155 text, and distribution drift |
| Initial tier | Tier 1 — Bounded, spec target; escalated during adversarial review |
| Final tier | Tier 2 — Material |
| Review target | Both spec and plan. The validator, git ancestry, C→V schema, partial QA gate, and exposure-aware outcome semantics create multiple interacting modules and failure paths |
| Rationale | Independent review proved the docs-only version could falsely claim enforcement and improvement; a deterministic validator and honest outcome gate are necessary |

## Specialized lens decisions

| Lens | Decision and materiality rationale |
| --- | --- |
| UI/design | Skipped: no interaction, layout, accessibility, or user flow changes |
| DevEx | Skipped: no public API/CLI/SDK ergonomics, compatibility, documentation, or adoption surface |
| Security/data | Skipped: no auth, secret handling, production data, untrusted external input, or data-integrity boundary changes |
| Performance | Skipped: no runtime hot path or performance-sensitive behavior; no downstream benchmark requirement |
| Research | Skipped: no unfamiliar external API, SDK, or integration; repository code and generated evidence provide the necessary context |

## Engineering review decisions

### D1 — Keep the complete cross-stage contract despite the physical file count

**ELI10:** the feature appears to touch eleven files, but six are three required
canonical/installed pairs and three more are the existing release/distribution
surface. Removing them would make the new rule either untested or unavailable
to installed workspaces.

**Recommendation: A, keep the full bounded contract, because every physical file
has a distinct propagation or verification job.**

- **A. Full Spec/Plan/Dev/QA contract (recommended), Completeness: 9/10.** Keep
  the three mirrored skill pairs, focused contract test, updater proof, and
  release docs. This follows the repository's existing distribution mechanism
  at `scripts/linear-watch.mjs:5005-5041` and avoids runtime implementation.
- **B. Dev reviewer checklist only, Completeness: 5/10.** Fewer files, but it
  remains reactive and leaves no stable identity for planning or QA.
- **C. Detector-only tuning, Completeness: 2/10.** The smallest diff, but it
  changes measurement rather than preventing gaps and risks metric gaming.

**Decision:** proceed with A. The over-eight-file smell is explained by mirrored
distribution artifacts, not by new services or architectural breadth.

### D2 — Use one deterministic rollout-boundary rule

**ELI10:** old specs cannot contain a contract that did not exist yet. New specs
must not silently skip it. The agent needs a reproducible way to tell those apart,
especially if COD-155 and COD-157 land in either order.

**Recommendation: A, share the git-history boundary mechanism, because two
different legacy rules would drift and produce inconsistent bounces.**

- **A. One git-history boundary (recommended), Completeness: 9/10.** Compare the
  artifact's first-add commit with the commit that first installed the relevant
  `.sweep-version`; proven older artifacts use the legacy gate, post-boundary or
  incomparable artifacts fail closed. COD-155 and COD-157 share this mechanism.
- **B. Treat every missing declaration as legacy, Completeness: 4/10.** Avoids
  false bounces but lets new work omit the contract indefinitely.
- **C. Treat every missing declaration as invalid, Completeness: 6/10.** Strong
  prevention but creates needless rework for pre-rollout cards.

**Decision:** proceed with A. The implementation plan must spell out focused
fixtures for older, newer, and incomparable history rather than relying on prose
alone.

### Engineering pass outcome

- **Architecture:** clear after adding the end-to-end proof flow and explicitly
  keeping the contract agent-readable rather than adding a runtime parser.
- **Code quality:** clear. The plan must centralize shared wording before copying
  canonical skills byte-for-byte and avoid a second rollout algorithm if COD-155
  lands first.
- **Tests:** clear after requiring semantic doc-contract assertions, legacy/new/
  incomparable rollout cases, copy equality, updater byte propagation, focused
  tests, and a full-suite no-new-failures comparison.
- **Performance:** clear with no runtime hot path, new process, network call, or
  benchmark surface.
- **Security:** clear with no auth, secrets, untrusted input, or production data
  boundary.
- **Pass result:** clear with two design corrections folded into the draft; no
  unresolved engineering decision remains.

### Independent adversarial outcome

The current-runtime fallback reviewer found five P1 issues after configured
Claude review was unavailable on this host. All are folded into this revision:

1. Empty review windows no longer count as improvement; V6 adds a five-card
   exposure floor.
2. C IDs remain invariant sources, V IDs own executable proof, each C maps to
   exactly one V row, and Dev/QA report V with source C retained.
3. A real validator owns declaration/table checks and git ancestry, with actual
   repository fixtures.
4. QA must dispose every V ID, not merely produce one linked observation.
5. Documentation tests no longer claim semantic enforcement; validator fixtures
   prove structure/history while review challenges proof quality.

The reviewer also caught that the draft did not apply its proposed contract to
itself. The `Verification contract` section and V1-V6 table now do so. No
independent finding remains unresolved.

## Schema and architecture impact

There is no data-schema change. README's Factory Learning architecture section
should gain a planned COD-157 note explaining that repeated test-gap evidence
will feed a versioned verification contract across Spec, Plan, Dev, and QA while
preserving independent review evidence and human delivery gates. The
implementation release changes that note from planned to active.

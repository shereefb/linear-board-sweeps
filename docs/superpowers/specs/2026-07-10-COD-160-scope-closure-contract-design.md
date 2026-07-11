# COD-160 Scope Closure Contract Design

## Summary

Add a versioned, risk-proportional `scope-closure/v1` contract to spec-sweep so
material work inventories implementation, ownership, verification, and rollout
surfaces before formal engineering review. The contract turns each identified
surface into a stable `S1..Sn` row in the spec and requires the plan to map every
row to concrete tasks, files or modules, proofs, and rollout ownership.

The existing review passes remain independent and continue to emit
`review/scope-gap` learning evidence whenever they find an omission. COD-160
improves prevention; it does not suppress, rename, or reclassify findings to make
the acceptance metric look better.

## Problem

Factory Learning observed repeated `scope-gap` review findings across three
cards in two workspaces, with one fresh occurrence added before this spec run:

| Card | Review finding | Missing surface |
| --- | --- | --- |
| SAF-210 | Cleanup could run before token and transaction prerequisites | dependency ordering |
| SAF-220 | Release-candidate medical copy lacked a clinician/content approval gate | human approval and release ownership |
| COD-148 | A newest-100 comment read could evict an active cooldown marker | bounded reads and retained state |
| COD-155 | Skill changes omitted the version bump, updater propagation proof, and README transition | distribution and canonical documentation |

The findings are heterogeneous at the implementation level, so a specialized
check for pagination, medical approval, or kit releases would overfit. Their
shared cause is earlier: the draft spec and plan did not record an auditable claim
that all identified material change surfaces were closed before formal review.

The current spec-sweep contract requires predicted files, risk surfaces, a test
plan, failure modes, rollout steps, and a terminal review gate
(`skills/spec-sweep/SKILL.md:50-69`). Those requirements are prose-level and do
not create stable identities that a plan can trace. A reviewer can therefore
discover a missing surface, but the workflow has no auditable row-level trace
showing that each identified surface received a task, proof, and owner.

This remains a docs-driven, reviewer-mediated workflow. Stable IDs and doc tests
make the contract inspectable and harder to skip; they cannot mathematically
prove that an author identified every possible surface. Independent review stays
mandatory for the selected tier precisely because prose contracts can be applied
incorrectly.

## Goals

- Catch material scope omissions before the selected engineering-review pass.
- Make identified scope coverage auditable from spec surface to implementation
  task, proof, and rollout or human owner.
- Cover code, data/control boundaries, dependencies, approvals, documentation,
  configuration, distribution, rollout, observability, and acceptance
  measurement without adding ceremonial rows.
- Preserve adaptive review depth and all security, performance, QA, Signoff, and
  human Ship gates.
- Preserve `review/scope-gap` as honest learning evidence when a review still
  finds an omission.
- Ship the contract through the kit's existing versioned skill updater.

## Non-goals

- Change the `repeated-review-finding/v1` detector, its semantic clustering, or
  the `reviewFindingCount` acceptance metric.
- Suppress or reclassify a scope-gap found after the new self-check.
- Replace `correctness-contract/v1` from COD-155. Correctness contracts describe
  behavioral invariants; scope closure records implementation and verification
  ownership for each identified material delivery surface.
- Add another review pass or specialized review skill.
- Add a runtime Markdown parser, artifact schema service, or executable validator.
  The existing cross-runtime agents and independent reviews enforce this
  procedural contract.
- Modify Dev, QA, or Ship behavior in this card. The contract is produced and
  gated entirely by spec-sweep; downstream stages consume the resulting plan as
  they do today.
- Add app-specific rules for medical copy, pagination, or any one observed card.

## Evidence and existing mechanisms

### What already exists

- `skills/spec-sweep/SKILL.md:50-69` classifies review depth, records predicted
  footprint and risks, requires plan reassessment, and blocks handoff when the
  final review gate is not clear.
- `skills/spec-sweep/SKILL.md:54` already requires independent reviewers to trace
  reuse, mechanism, and premise claims to code with file-and-line evidence.
- `skills/spec-sweep/SKILL.md:62` already requires repo scope and a spec-sweep
  review audit in every plan.
- `scripts/linear-watch.mjs:4999-5012` reads `VERSION`, propagates canonical skill
  directories into registered anchors, and records `.sweep-version`.
- `tests/spec-sweep-doc.test.mjs:12-50` proves canonical/installed skill parity,
  adaptive review ordering, safety floors, and operator documentation.
- `tests/updater.integration.test.mjs:21-56` proves refreshed skills land on and
  push `main` without disturbing a checked-out feature branch.
- COD-155 designs `correctness-contract/v1` with stable invariant IDs and plan
  traceability. COD-160 reuses that artifact pattern while keeping scope and
  correctness semantics separate.

### Why the current mechanism is insufficient

The review audit records categories and outcomes, but it does not identify each
material surface before review or require a one-to-one trace into plan tasks.
Predicted files are evidence for review depth, not a closure proof. This is why a
plan can look complete while omitting a version file, approval owner, pagination
boundary, or prerequisite edge.

## Design alternatives

### A. Add `scope-closure/v1` to spec-sweep (recommended)

Completeness: 10/10. Build a small surface inventory before review, assign stable
IDs, trace each ID through the implementation plan, and make closure part of the
existing terminal gate. This addresses the shared failure point without changing
the detector or adding a new review.

### B. Expand only the engineering-review checklist

Completeness: 7/10. Review would likely catch more gaps, but the observed events
show that review already catches them. This keeps discovery late, adds reviewer
load, and still lacks auditable spec-to-plan traceability.

### C. Narrow detector clustering so heterogeneous scope gaps do not aggregate

Completeness: 3/10. More specific clustering could improve diagnosis, but it
would not prevent any omission. It risks lowering the metric by changing what is
counted rather than improving factory quality.

Recommendation: choose A because the missing common mechanism is a pre-review
auditable closure trace. Keep detector refinement separate unless post-release evidence
shows the category is too broad for useful recurrence decisions.

## Scope-closure contract

### Applicability declaration

Every draft spec and its plan audit declare exactly one line:

```text
Scope closure: scope-closure/v1 — required | not required — <rationale>
```

`required` applies whenever the proposed change materially affects behavior,
state, persistence, interfaces, dependencies, rollout, distribution, human
approval, or user-visible failure behavior. `not required` is allowed only for a
genuinely mechanical Tier 0 change with a concrete explanation of why no
material surface exists.

If inventory work reveals a material surface on a proposed Tier 0 card, the card
escalates to at least Tier 1. The declaration cannot be used to downgrade review
depth.

### Coexistence with `correctness-contract/v1`

When both contracts are installed, spec-sweep evaluates them in this order after
brainstorming and before review-depth classification:

1. `scope-closure/v1` records the intended set of identified material delivery
   surfaces.
2. `correctness-contract/v1` defines behavioral invariants for the applicable
   state, failure, identity, persistence, and concurrency surfaces.
3. Review-depth classification uses both artifacts as evidence.

Do not duplicate an invariant as prose in a scope row. The `S` row names the
delivery surface and may reference the relevant `C` IDs in its closure proof;
the correctness table remains the source of truth for forbidden outcomes and
recovery behavior. Likewise, a correctness row does not replace scope ownership
for docs, packaging, approvals, rollout, or acceptance measurement.

The two cards are not runtime dependencies: each contract is independently
useful and can land first. Implementation must merge current `origin/main` and
preserve the stable ordering above if COD-155 has already installed its contract.

### Spec surface inventory

A required spec adds a `Scope closure inventory` before review selection. It uses
stable `S1..Sn` IDs and these columns:

| Column | Meaning |
| --- | --- |
| ID | Stable `S1..Sn` identifier used by the plan and reviews |
| Surface and evidence | Concrete affected boundary with code/config/doc evidence |
| Required outcome | What must be true when the work is complete |
| Owning repo/module | Configured repo and predicted module or operational owner |
| Closure proof | Test, inspection, approval, metric, or rollout observation that can fail |

The author considers only material dimensions and records a row for each one that
applies:

1. Entry points, user/operator flows, and externally visible outcomes.
2. Code, data, state, and control-flow boundaries, including bounded reads and
   retained history.
3. Dependencies, prerequisites, task ordering, cleanup, and ownership transfer.
4. Failure, recovery, retry, partial-success, cancellation, and stale-work paths.
5. Human approval, content/policy decisions, credentials, assets, and attended
   release work.
6. Configuration, canonical documentation, versioning, packaging, updater or
   installer propagation, and distribution.
7. Tests, QA observations, observability, rollout/canary evidence, and acceptance
   measurement.
8. Repository and deploy scope, including every production target for a true
   multi-repo card.

The contract explicitly forbids boilerplate rows for irrelevant dimensions.
Each row must name evidence in the actual repository or card. A vague row such as
"handle edge cases" does not close a surface.

### Pre-review self-check

Before review-depth classification completes, spec-sweep performs a bidirectional
self-check:

- Every stated goal, acceptance criterion, failure mode, rollout step, and
  material predicted file/module maps to at least one `S` row.
- Every `S` row has a falsifiable closure proof and a configured repo/module or
  explicit human owner.
- The inventory covers non-code delivery surfaces such as version markers,
  canonical docs, updater/install propagation, and attended release steps.
- The dependency graph orders prerequisite work before dependents and cleanup.
- No row silently assigns implementation to an unconfigured sibling repository.

The self-check is prevention and does not replace a later independent reviewer.
If it discovers a material surface omitted from the initial inventory, emit the
existing `review/scope-gap` kind/category with bounded
`{"findings":1,"discoveryPhase":"pre-review-self-check"}` metrics before fixing
the draft. The taxonomy has no separate pre-review-finding kind, and using the
same event prevents the acceptance metric from improving merely because discovery
moved earlier.

### Reviewer challenge

For required contracts, the existing selected engineering pass and independent
adversarial reviewer additionally challenge whether:

- repository evidence supports every inventory row and reuse claim;
- every material code, operational, human, and distribution surface is present;
- closure proofs can actually disprove an incomplete implementation;
- prerequisite and rollout ordering is explicit; and
- the inventory is not padded with generic rows that hide missing specifics.

Every verified omission remains a normal `review/scope-gap` event under the
existing structured learning contract, whether the self-check or a selected
review finds it. Reviewers do not relabel it as another category merely because
COD-160 is being measured.

### Plan traceability

A required implementation plan adds a `Scope closure traceability` table:

| Scope ID | Implementing task(s) | Files/modules | Test or assertion | Rollout/owner evidence | Residual risk |
| --- | --- | --- | --- | --- | --- |

Before plan review, spec-sweep checks both directions:

- every `S` row maps to at least one implementing task and proof;
- every planned task and changed delivery surface maps back to an `S` row;
- task dependencies respect the prerequisite order declared by the inventory;
- human-only work has a named Todo-card or attended-owner path instead of being
  assigned to an unattended agent; and
- distribution work includes `VERSION`, canonical/installed copy parity, updater
  propagation proof, and operator-doc transitions when those surfaces apply.

The reviewing agent must fail the final review gate if required rows are absent,
unmapped, contradictory, or unresolved. Documentation tests protect the canonical
instruction contract; they do not parse arbitrary generated specs or prove
semantic completeness.

## Data and control flow

```text
card + repository evidence
        |
        v
brainstormed design
        |
        v
scope-closure applicability
        |
        +-- not required --> concrete Tier 0 rationale
        |
        `-- required ------> S1..Sn inventory
                                  |
                                  v
                         bidirectional self-check
                                  |
                                  v
                       review-depth classification
                                  |
                                  v
                    selected independent reviews
                                  |
                                  v
                         implementation plan
                                  |
                                  v
                    S IDs -> tasks/proofs/owners
                                  |
                                  v
                    plan review + terminal gate
```

No new runtime state or Linear data shape is introduced. The contract lives in
the spec and plan artifacts. Existing review and terminal learning events remain
the measurement stream.

## Failure handling

| Failure | Required behavior |
| --- | --- |
| Applicability declaration missing | Spec is incomplete and cannot pass the terminal gate. |
| Required inventory row has no repository evidence | Resolve the evidence gap or route an owner-only question to the card; do not invent scope. |
| Plan leaves an `S` row unmapped | Keep the card in Spec and reconcile the plan. |
| New plan task exposes a new surface | Add a new `S` row, reassess tier monotonically, and run newly required reviews. |
| Reviewer finds a missed surface | Fold it into spec and plan and emit `review/scope-gap` normally. |
| Required work belongs to an unconfigured repo | Follow the existing split/config block path; do not send the card to Dev. |
| Distribution surface is omitted | Add version, copy-parity, updater, and operator-doc tasks before handoff. |

## Scope closure inventory

Scope closure: `scope-closure/v1 — required` — COD-160 changes a distributed
workflow contract, its review evidence, and its release path.

| ID | Surface and evidence | Required outcome | Owning repo/module | Closure proof |
| --- | --- | --- | --- | --- |
| `S1` | Cross-runtime spec-sweep contract (`skills/spec-sweep/SKILL.md:48-69`) | Add risk-proportional applicability, `S1..Sn` inventory, self-check, reviewer challenge, plan traceability, and terminal-gate rules without replacing adaptive tiers | `linear-board-sweeps` / canonical and installed spec-sweep skills | Byte equality plus focused doc-contract assertions for ordering, applicability, traceability, and failure behavior |
| `S2` | COD-155 overlaps the same post-brainstorm review flow and release files (`docs/superpowers/plans/2026-07-10-COD-155-correctness-contract-implementation.md:15-21`) | Preserve scope-before-correctness ordering, stable cross-references, and a unique post-merge release marker regardless of landing order | `linear-board-sweeps` / spec-sweep and release artifacts | Doc test proves ordering language; implementation fetches current main and chooses a marker greater than live release branches |
| `S3` | Existing updater direct fixture bypasses VERSION comparison (`tests/updater.integration.test.mjs:21-49`; `scripts/linear-watch.mjs:5127-5135`) | Prove a newer kit VERSION triggers installation of byte-identical spec-sweep content and marker on anchor origin/main | `linear-board-sweeps` / updater integration test | Successful `runUpdate` fixture with old anchor marker, newer kit marker, changed skill bytes, and origin/main assertions |
| `S4` | Release policy and operator architecture (`CHANGELOG.md:1-5`; `README.md:3-10`) | Document the release and change README from planned to active only when implementation ships | `linear-board-sweeps` / CHANGELOG, README, VERSION | Focused text assertions plus diff inspection and full test suite |
| `S5` | Factory Learning counts review-finding events (`scripts/learning.mjs:295-303,1404-1437`) | Emit material self-check omissions as the existing `review/scope-gap` evidence and make no unsupported composite-outcome claim | `linear-board-sweeps` / spec-sweep evidence instructions | Doc tests require the exact event kind/category, discovery phase, and unchanged primary metric semantics |
| `S6` | Configured single-repo/no-app-deploy scope (`.claude/linear-sweep.json`) | Keep all implementation in the configured repo; treat external release publishing as attended owner/Todo work | `linear-board-sweeps` / release handoff | Repo-scope audit, clean selective diff, configured deploy note, normal QA/Signoff/human Ship gates |

Bidirectional self-check: every goal, failure mode, predicted file, rollout step,
and acceptance rule maps to `S1..S6`; each row has a falsifiable proof and configured
owner. The implementation plan must map every task back to at least one `S` row.

## Review depth decision

### Predicted footprint

The implementation is expected to touch seven files with roughly 140-220 changed
lines:

- `skills/spec-sweep/SKILL.md`
- `.claude/skills/spec-sweep/SKILL.md`
- `tests/spec-sweep-doc.test.mjs`
- `tests/updater.integration.test.mjs`
- `README.md`
- `CHANGELOG.md`
- `VERSION`

No new runtime module, dependency, migration, or persistent state is expected.
The existing updater implementation is reused without code changes, but its test
suite needs a success-path `runUpdate` fixture that exercises VERSION comparison
instead of calling `refreshAnchorSkills` directly.

### Behavior and risk surfaces

- **Behavior:** changes the mandatory artifact and terminal-gate behavior of
  scheduled spec sweeps.
- **State/persistence:** no new runtime state; specs and plans gain a versioned
  declaration and stable IDs.
- **Interface:** changes the distributed cross-runtime skill contract consumed by
  Claude Code and Codex.
- **Dependency/rollout:** requires canonical/installed parity, a patch version
  bump, and updater propagation through registered anchors.
- **User-visible failure:** an incomplete scope contract keeps a card in Spec
  instead of allowing downstream implementation to discover the omission.
- **Material risk:** over-broad inventories could add ceremony and reviewer cost;
  under-broad applicability could miss the target class; metric gaming could
  hide rather than reduce findings.

### Initial tier and targets

**Initial tier: Tier 2 — Material.** The file count is bounded, but the change
alters a public, distributed workflow contract and terminal gate for every future
spec card. Both the spec and completed plan need engineering review. The spec
also receives the required independent adversarial premise review before plan
generation.

### Specialized review lenses

| Lens | Decision | Rationale |
| --- | --- | --- |
| UI/design | Skip | No interaction, hierarchy, accessibility, responsive, or visual flow changes. |
| API/CLI/SDK devex | Skip | No public API, CLI command, SDK, adoption flow, or external documentation contract changes. |
| Security | Skip | No auth boundary, secret handling, external input, destructive operation, or data-access policy changes. |
| Performance | Skip | The contract adds bounded document reasoning, not a runtime hot path. Existing review duration may change slightly but no benchmarkable production path changes. |
| Research | Skip | The design uses repository-local workflow and evidence; no unfamiliar external integration is involved. |

## Review decision briefs

### D1 — Where should prevention live?

ELI10: The current reviewers find missing work after the draft is already built.
The decision is whether to make the draft demonstrate identified coverage first or to ask
reviewers to work harder. Recommendation: add the proof to spec-sweep because it
fixes the earliest shared failure point.

- **A. Versioned spec/plan closure contract (recommended). Completeness: 10/10.**
  Stable IDs make omissions and unmapped tasks visible before review while
  preserving independent review.
- **B. Reviewer checklist only. Completeness: 7/10.** Review remains the first
  structured discovery point and plan traceability stays implicit.
- **C. Detector refinement only. Completeness: 3/10.** Counting changes, but the
  factory still creates the same omissions.

Decision: A.

### D5 — Should closure be enforced by prose or a runtime validator?

ELI10: A Markdown table makes missing mappings visible, but software cannot prove
that an author noticed every possible surface unless we build a parser and schema
for all generated specs. Recommendation: keep this card procedural and state the
limitation honestly; independent review is still the semantic validator.

- **A. Auditable procedural contract plus independent review (recommended).
  Completeness: 9/10.** This is a bounded change on the existing cross-runtime
  architecture and makes omissions easier to challenge without a new parser.
- **B. Executable artifact validator and schema. Completeness: 10/10.** Stronger
  structural enforcement, but it materially expands this card into a new runtime
  subsystem and still cannot prove semantic completeness.
- **C. Keep unstructured prose. Completeness: 5/10.** No new machinery, but plans
  retain no stable surface-to-task audit trail.

Decision: A. Runtime artifact validation is a separate future feature only if
post-release evidence shows repeated structural noncompliance.

### D2 — Should the contract apply to every card?

ELI10: Requiring a table for a one-line mechanical edit creates noise, but letting
material changes opt out recreates the gap. Recommendation: use the same
risk-proportional boundary as adaptive review depth.

- **A. Required for material surfaces, explicit exemption for genuine Tier 0
  (recommended). Completeness: 10/10.** This covers risky work without ceremonial
  rows for mechanical changes.
- **B. Required for every card. Completeness: 8/10.** Coverage is strong, but
  boilerplate teaches agents to satisfy the form instead of inspect the repo.
- **C. Optional author judgment. Completeness: 5/10.** The cards most likely to
  miss scope can also opt out without evidence.

Decision: A.

### D3 — How should acceptance be measured?

ELI10: Moving discoveries from review into self-review could make the number fall
without making work better. Recommendation: keep review reporting unchanged and
measure the existing 14-day metric, with explicit anti-gaming rules.

- **A. Preserve all review events and evaluate the declared metric
  (recommended). Completeness: 10/10.** A real improvement lowers findings while
  the safety net stays equally sensitive.
- **B. Stop emitting findings already covered by the contract. Completeness:
  2/10.** This directly games the metric and weakens learning.
- **C. Replace the metric in this card. Completeness: 5/10.** It breaks the
  generated card's measurement contract and makes before/after comparison
  ambiguous.

Decision: A.

### D4 — How should scope and correctness contracts coexist?

ELI10: Both contracts inspect some failure and dependency surfaces. Copying the
same requirement into two tables creates drift, while merging them makes a large
all-purpose checklist. Recommendation: keep separate sources of truth and allow
scope rows to reference correctness IDs.

- **A. Separate contracts with stable cross-references (recommended).
  Completeness: 10/10.** Scope owns delivery coverage; correctness owns behavioral
  invariants; shared surfaces are linked rather than duplicated.
- **B. Merge both into one contract. Completeness: 7/10.** One artifact is shorter,
  but unrelated mechanical delivery surfaces and deep state invariants become a
  harder, less reusable schema.
- **C. Duplicate shared requirements in both tables. Completeness: 5/10.** Each
  table reads independently, but later edits can contradict each other.

Decision: A.

## Testing strategy

### Documentation contract tests

Extend `tests/spec-sweep-doc.test.mjs` to prove:

- canonical and installed spec-sweep copies remain byte-identical;
- `scope-closure/v1` applicability appears after brainstorming and before review
  selection;
- required inventories use stable `S1..Sn` IDs and cover the material dimensions;
- every required plan contains bidirectional traceability;
- new plan surfaces force reconciliation and monotonic tier reassessment;
- the canonical instructions require the reviewing agent to fail the terminal
  gate for missing or unmapped scope rows;
- reviewer omissions remain structured `review/scope-gap` evidence; and
- Tier 0 exemptions require a concrete no-material-surface rationale.

These are documentation-contract checks. They do not claim to parse generated
artifacts or establish that an inventory is semantically complete.

### Distribution proof

Extend `tests/updater.integration.test.mjs` with a successful `runUpdate` fixture:
the kit carries a newer VERSION and changed canonical spec-sweep bytes, the
registered anchor starts with an older committed `.sweep-version`, and the test
asserts that origin/main receives both the new marker and byte-identical installed
skill. Keep the existing direct `refreshAnchorSkills` fixture for worktree safety.

### Regression suite

Run the full Node test suite because spec-sweep text is consumed by doc-contract
tests and the updater is shared across all registered workspaces.

## Rollout and measurement

1. Land the canonical and installed skill copies in parity.
2. After synchronizing with `origin/main`, choose a `VERSION` marker greater than
   both the marker on current `main` and any still-live release branch. Do not
   hard-code `1.2.0.6`: COD-142 already uses that marker on an unmerged branch,
   even though current `main` still reads `1.2.0.5`.
3. Add the new release marker and scope-closure behavior to `CHANGELOG.md`.
4. Update README from planned to active scope-closure behavior while keeping the
   existing COD-155 planned note accurate until that card ships.
5. Prove the VERSION-triggered updater path with the success integration fixture
   before release.
6. After Ship, evaluate the card's existing `reviewFindingCount` metric over its
   declared 14-day window: baseline 3, direction decrease, target 0.
7. Continue emitting all review findings. A no-change or regression outcome must
   remain visible to Factory Learning and may generate the normal recurrence.

### Anti-gaming behavior and supplemental diagnostics

The primary acceptance metric remains the generated card's immutable
`reviewFindingCount` contract. Material self-check omissions use the same
`review/scope-gap` event, so moving discovery earlier cannot by itself lower the
count. The existing evaluator remains unchanged: after the 14-day window it
computes `verified-improvement`, `no-measurable-change`, or `regression` from the
card's one scoped metric only.

Downstream `bounce/missing-design`, `bounce/missing-repo-scope`, QA rework,
red-canary, and review-duration evidence remain independent Factory Learning
signals. They are useful supplemental diagnostics in an attended post-window
review, but COD-160 does not claim that they condition or override the automated
outcome. Adding a composite evaluator or projecting new scope metrics would be a
separate runtime feature outside this card.

## Repo scope

Owning repo: `linear-board-sweeps` only. The SafeTaper workspace contributed
evidence but does not need implementation changes: registered anchors receive the
canonical skill through the existing kit updater. No sibling repository or
production deploy target is added.

Shipping is merge/push to `main`. Any external release publishing remains an
attended owner action or Todo under the configured deploy contract.

## Schema and architecture impact

No application schema or persistent factory state changes. README should record
the planned `scope-closure/v1` artifact flow because it changes the architecture
of spec production and review gating. Until implementation ships, the README entry
must be marked **Planned (COD-160)**.

## Spec self-review

- Placeholder scan: no TBD, TODO, or unresolved choice remains.
- Consistency: the contract prevents omissions before review while explicitly
  preserving independent review and learning events.
- Scope: one configured repo and one distributed skill contract; detector changes
  and downstream-stage enforcement remain out of scope.
- Ambiguity: applicability, inventory dimensions, traceability, failure behavior,
  rollout, and acceptance measurement are explicit.

## Review audit

| Item | Outcome |
| --- | --- |
| Initial review tier | Tier 2 — material distributed workflow-contract change |
| Spec engineering pass | Clear after six corrections: procedural enforcement limits, COD-155 composition, unique release markers, CHANGELOG scope, VERSION-trigger updater proof, and honest acceptance semantics |
| Independent adversarial spec review | Clear after two reconciliation rounds; all six verified findings were folded into the spec with repository evidence |
| Plan engineering pass | Clear after two execution corrections: exact doc-test wording and origin-derived release values |
| UI/design lens | Skipped; no material UI surface |
| API/CLI/SDK devex lens | Skipped; no public developer interface surface |
| Security lens | Skipped; no auth, secrets, external-input, or data-access surface |
| Performance lens | Skipped; no production performance path |
| Research lens | Skipped; repository-local mechanism only |
| Final tier | Tier 2, unchanged after completed-plan reassessment |
| Unresolved decisions | None |

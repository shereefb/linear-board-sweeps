# COD-155 Cross-Stage Correctness Contract Design

## Summary

Factory Learning observed five `review/correctness` events across five cards and
three registered workspaces between 2026-07-10T17:54:50Z and
2026-07-10T23:46:25Z. The findings differed in implementation detail, but each
exposed a missing failure-state invariant after the normal design or build work
was already underway: partial recursive deletion, Firestore serialization and
interlock retention, forced-retry progress, OS-signal claim cleanup, and
runtime/PID attribution.

The reviews worked and must remain intact. The process gap is that expected
behavior is easy to describe as a happy-path narrative, while state ownership,
partial failure, retry, cancellation, stale work, and recovery obligations are
not carried as one traceable contract from Spec through Dev and QA. COD-155 adds
that contract to the existing sweep artifacts and gates. It does not suppress
findings, weaken review, or add another review pass.

## Evidence and existing mechanisms

The accepted evidence is specific enough to identify a shared process surface:

| Card and stage | Review finding | Missing invariant class |
| --- | --- | --- |
| `SAF-210` Spec | Recursive deletion could remove a parent before failed descendants were safely recoverable. | partial failure, ordering, retry ownership |
| `SAF-213` Dev | Undefined Firestore values and interlock retention defects were found during task review. | persistence validity, retained safety state |
| `COD-146` Spec | Backfill retry/deadline policy had to preserve `force=true` progress semantics. | retry progress, deadline behavior |
| `COD-148` Spec | OS-signal child exits were omitted from terminal claim cleanup. | terminal-state coverage, ownership release |
| `COD-144` Spec | Runtime attribution, PID replacement, deferral precedence, and cancellation gaps required correction. | identity, precedence, cancellation |

The current pipeline already provides strong late gates:

- spec-sweep requires failure modes, tests, tiered engineering review, and an
  independent adversarial review for Tier 1/2 work;
- dev-sweep requires TDD where appropriate, code review, an independent
  reviewer, and observed verification;
- qa-sweep exercises happy paths and obvious edge cases and consumes a plan's
  test plan when one exists; and
- structured learning events preserve review findings instead of hiding them.

What is absent is a stable, cross-artifact unit that lets each stage answer:
“Which correctness promise is this code, test, or QA action proving?”

## Goals

1. Behavior-changing specs identify correctness invariants before the selected
   engineering review begins.
2. Each material invariant states its trigger, required outcome, forbidden
   outcome, ownership/recovery rule, and verification evidence.
3. Implementation plans map every invariant to concrete tasks and tests.
4. Dev proves the mapped invariants before formal code review, without treating
   that proof as permission to skip either review pass.
5. QA uses externally observable invariant cases as primary test input and
   records which ones were exercised or why they require lower-level evidence.
6. Mechanical work does not pay for a ceremonial empty matrix.
7. Existing learning evidence, review, QA, Signoff, and human Ship gates remain
   unchanged.

## Non-goals

- Suppressing, recategorizing, deduplicating, or discounting correctness events.
- Changing the `repeated-review-finding/v1` detector or its acceptance metric.
- Adding a third reviewer, a new runtime, a new Linear label, or a new workflow
  state.
- Prescribing product-specific invariants in the shared kit.
- Replacing implementation-level types, assertions, transactions, or tests with
  prose.
- Requiring UI-only copy, formatting, or other genuinely mechanical cards to
  manufacture failure scenarios.
- Claiming that every future correctness defect can be prevented by a checklist.

## Options considered

### A. A traceable correctness contract carried across Spec, Plan, Dev, and QA (recommended)

ELI10: write the important “this must always be true” rules once, then make each
builder and tester show where they protected those rules.

**Completeness: 10/10.** This addresses the shared failure pattern without
weakening downstream review. It improves the input to existing reviews, keeps
the mechanism proportional to risk, and creates a direct line from a design
promise to code and evidence.

### B. Add another dedicated correctness review pass

ELI10: ask one more inspector to look for mistakes after the work is drafted.

**Completeness: 7/10.** It would likely find defects, but the factory already
found these defects through existing reviews. Another pass increases time and
cost while leaving the underlying cross-stage handoff weak.

### C. Narrow or suppress the broad `correctness` detector cluster

ELI10: stop the alarm from grouping different kinds of mistakes together.

**Completeness: 3/10.** The five findings are heterogeneous, so detector
refinement may eventually improve diagnosis. It would not prevent any defect
and would directly optimize the metric by hiding evidence, contrary to the card
exclusion.

Decision: adopt option A.

## Design

```text
Card behavior/risk
       |
       v
Spec audit: required? ---- no ----> Existing mechanical/legacy gates
       |
      yes
       v
Correctness contract (C1..Cn)
       |
       +----> selected spec review challenges completeness
       |
       v
Plan traceability: task + deterministic proof + QA observation
       |
       v
Dev preflight ----> formal code-review pair ----> QA evidence ----> Signoff
                         |
                         +---- findings remain learning evidence
```

### Contract shape

For a card that changes behavior, state, persistence, interfaces, dependencies,
rollout, or user-visible failure behavior, the design spec adds a
`Correctness contract` section before tier-selected review. The section contains
a compact table with stable IDs local to the card:

| Field | Meaning |
| --- | --- |
| `ID` | `C1`, `C2`, ...; stable across the spec, plan, Dev notes, and QA evidence. |
| `Trigger / transition` | The input, event, state transition, timeout, retry, cancellation, or concurrent action that activates the rule. |
| `Required invariant` | What must remain true, including ownership and persisted state where applicable. |
| `Forbidden outcome` | The concrete corrupt, stale, unsafe, duplicate, or misleading result that must never occur. |
| `Recovery / ownership` | Who may retry, cancel, clean up, or advance the state after partial failure. |
| `Verification` | The smallest meaningful automated test, assertion, integration check, or user-observable QA case. |

The matrix is selected from the actual design, not filled from a universal list.
The author explicitly considers only applicable adversarial dimensions:

- partial success and write ordering;
- retry, timeout, deadline, cancellation, and stale work;
- duplicate delivery, concurrency, and ownership transfer;
- identity/provenance and precedence between competing outcomes;
- serialization, persistence validity, and retained safety state;
- boundaries, empty input, unavailable dependencies, and malformed external
  input; and
- rollback, cleanup, or resume behavior after interruption.

“Not applicable” is recorded once with a rationale for a dimension that a
reasonable reviewer would otherwise expect. It is not repeated as filler for
every matrix field.

Every newly generated spec and plan records a versioned declaration in its
review audit:

```text
Correctness contract: correctness-contract/v1 — required | not required — <one-sentence rationale>
```

`required` means the spec and plan must contain the contract and traceability
tables before their terminal gates can pass. `not required` is valid only when
the audit explains why the card has no material correctness surface. The
versioned prefix is the closed applicability signal consumed by Dev and QA; a
free-form mention does not count.

The release that installs this behavior bumps the kit `VERSION`. The updater
commits that marker to `.claude/skills/.sweep-version` in every anchor. For an
artifact with no versioned declaration, dev-sweep compares the commit that first
introduced the artifact with the local anchor commit that first installed this
release marker:

- artifact introduced before the rollout boundary: treat it as legacy and apply
  the existing spec-quality gate;
- artifact introduced at or after the boundary: bounce as `missing-design`;
- missing or incomparable history, including a routed sibling whose artifact
  history cannot be ordered against the anchor: fail closed and bounce with the
  exact evidence gap.

This git-history boundary is used only when the declaration is absent. Normal
new work follows the explicit artifact declaration, so rebases or later edits do
not change applicability.

Tier 0 remains exempt because its definition already excludes meaningful
behavior, state, persistence, interface, dependency, rollout, or failure
changes. If drafting the matrix exposes a material invariant, the card is not
Tier 0 and must be classified at least Tier 1. This makes the contract a check
on review-depth classification rather than a way to bypass it.

### Spec review behavior

The selected engineering and independent reviewers receive the correctness
contract as an explicit review target. In addition to tracing reuse and premise
claims against real code, they must test whether:

1. every state-changing or externally visible failure path has an owner;
2. partial success cannot falsely report completion;
3. retries and cancellation preserve monotonic progress or clearly defined
   rollback semantics;
4. persisted values and identities remain valid across interruption/resume; and
5. each invariant has evidence capable of disproving an incorrect
   implementation.

Any verified omission updates the contract before plan generation. It remains a
real review finding and continues to emit the existing structured learning
event. COD-155 changes prevention and traceability, not evidence semantics.

### Implementation-plan mapping

The plan repeats the invariant IDs in a `Correctness traceability` table:

| Invariant | Implementing task(s) | Test / assertion | QA observation | Residual risk |
| --- | --- | --- | --- | --- |

Every invariant must map to at least one implementation task and one proof. A
proof may be a unit test, integration test, property/invariant assertion,
failure-injection test, or an existing test named with file-level evidence. A
manual QA observation alone is insufficient for races, atomicity, persistence
integrity, or other behavior a user cannot reliably induce.

Task ordering must place the invariant's test with or before the code that
satisfies it, consistent with the existing TDD preference. If an invariant
cannot be proven within the configured repo scope, the terminal spec gate fails
under the existing missing-repo-scope/open-question path; COD-155 introduces no
new blocker mechanism.

### Dev pre-review proof

Before the always-on code-review pair, dev-sweep performs a bounded correctness
proof run:

1. read the spec contract and plan traceability table;
2. map each invariant ID to the actual diff and the already-declared
   test/assertion;
3. execute those narrow proofs before the full build/test suite;
4. fix implementation failures; if execution instead exposes a material missing
   invariant or contract defect, emit the existing `review/correctness` event and
   bounce to Spec as `missing-design`; and
5. include the proof map in the normal QA handoff.

This is execution of planned evidence, not an open-ended review pass. Defects
found by the formal review pair are still recorded as review findings. Any
material contract omission discovered while mapping or executing proofs is also
recorded as a `review/correctness` finding; the proof run must not relabel
discovery as ordinary implementation work to improve the metric.

Legacy cards proven to predate the rollout boundary continue through the
existing spec-quality gate. When the `correctness-contract/v1` declaration says
`required`, a missing contract or traceability table is a concrete
`missing-design` bounce reason, not an invitation to invent one in Dev. When it
says `not required`, Dev checks that rationale against the actual plan/diff and
bounces only if a material correctness surface makes the classification false.

### QA consumption

qa-sweep uses the plan's `QA observation` entries as primary test input alongside
the existing user flow and engineering-review test plan. QA records invariant
IDs exercised through the running product. For invariants that cannot be
reliably observed through the UI or public interface, QA cites the green
lower-level test evidence and verifies the closest observable outcome; it does
not pretend to test concurrency or persistence integrity by clicking manually.

No invariant coverage means no `qa:passed` when the audit marks the contract
`required` and the plan declares user-observable correctness cases. Existing
build, smoke-test, visual, Signoff, and human Ship gates are unchanged.

### Canonical copies and installation

The kit keeps `skills/<stage>-sweep/SKILL.md` and
`.claude/skills/<stage>-sweep/SKILL.md` byte-identical. Implementation updates
the Spec, Dev, and QA copies together and adds doc-contract tests that fail if
the contract, cross-stage traceability, or canonical-copy equality drifts.

No launcher code, learning state, Linear data, or card migration is required.
Installed anchors receive the behavior through the existing skill updater only
after the kit `VERSION` changes. Implementation therefore bumps `VERSION`, adds
the corresponding `CHANGELOG.md` entry, and verifies that an anchor on the old
marker receives the new Spec/Dev/QA skills and `.sweep-version` marker. A managed
kit fast-forward without the marker change is explicitly not accepted as a
successful rollout.

## Failure modes and safeguards

| Failure | Required behavior |
| --- | --- |
| Matrix contains vague promises such as “works correctly” | Terminal spec self-review rejects the ambiguity; name a trigger, forbidden outcome, and proof. |
| Matrix becomes a generic checklist | Keep only design-applicable invariants and require file/task/test traceability. |
| A reviewer discovers a missing invariant | Record the real finding, update the contract, and reconcile the plan; do not suppress the event. |
| Plan maps an invariant only to manual QA | Reject the mapping when the behavior needs deterministic lower-level proof. |
| Dev code passes happy-path tests but lacks invariant evidence | Fix before formal review or bounce a materially incomplete design to Spec. |
| Contract and implementation disagree | The code does not inherit authority from the plan; resolve the mismatch and rerun affected tests/reviews. |
| Artifact lacks the versioned declaration | Compare its introduction with the local rollout-boundary commit; legacy proceeds, new/incomparable work bounces fail-closed. |
| Tier 0 work needs a nontrivial invariant | Escalate to at least Tier 1 and run the newly required review. |
| QA cannot induce a low-level failure safely | Cite observed automated evidence and test the closest public outcome; never manufacture destructive production conditions. |

The central invariant is: every material correctness promise must have one
stable identity from design through implementation and evidence, while every
existing independent gate remains authoritative.

## Testing and acceptance

Implementation adds focused documentation-contract tests that prove:

1. canonical and installed Spec/Dev/QA skill copies remain byte-identical;
2. spec-sweep requires the contract before selected reviews for material
   behavior, records the `correctness-contract/v1` applicability field, and keeps Tier 0
   exemption/escalation explicit;
3. the contract includes trigger, required/forbidden outcome,
   recovery/ownership, and verification fields;
4. plans must map invariant IDs to tasks and deterministic evidence;
5. dev-sweep performs the pre-review proof without replacing either formal code
   review;
6. qa-sweep consumes user-observable invariant cases and distinguishes them
   from lower-level proof; and
7. a material contract omission discovered during the proof run emits
   `review/correctness`, and formal review findings continue to emit structured
   learning evidence;
8. an absent declaration is accepted only for an artifact proven older than the
   installed release boundary; and
9. the version bump propagates the changed skill bytes and marker to an anchor
   on the previous version.

The repository test suite remains green. After COD-155 reaches Done, Factory
Learning evaluates the card's existing core-scoped `reviewFindingCount` metric
for category `correctness` over 14 days. The baseline is five occurrence events;
success is a decrease toward zero across the declared contributor workspaces,
without any review, QA, Signoff, or human Ship gate being bypassed.

## Rollout

1. Add the contract and review target to spec-sweep.
2. Add plan-to-diff/test proof and bounce semantics to dev-sweep.
3. Add invariant-driven smoke-test evidence to qa-sweep.
4. Update canonical and installed copies together, bump `VERSION`, add the
   CHANGELOG entry, and run the doc-contract, updater integration, and full
   repository tests.
5. Verify an old-marker fixture installs the new skill bytes and
   `.sweep-version`; verify unchanged markers still no-op safely.
6. Change README's current `(planned, COD-155)` architecture note to active in
   the implementation branch so the shipped commit describes live behavior.
7. Ship through the normal QA, Signoff, and human Ship workflow. No production
   deploy or state migration exists for this kit.

Rollback is a normal revert of the skill text and tests. Existing specs and
cards remain valid because no persisted schema or marker changes.

## Review depth decision

- **Predicted footprint:** `skills/spec-sweep/SKILL.md`,
  `skills/dev-sweep/SKILL.md`, `skills/qa-sweep/SKILL.md`, their three
  `.claude/skills` copies, one focused documentation-contract test,
  `tests/updater.integration.test.mjs`, `VERSION`, `CHANGELOG.md`, and the README
  architecture note; approximately 11 physical files and 110-170 changed lines.
  The six skill paths are three required byte-identical logical artifacts.
- **Behavior/state/interface changes:** changes cross-runtime agent workflow
  behavior and artifact expectations across Spec, Dev, and QA. It does not
  change runtime state, persistence schemas, public APIs, dependencies, deploys,
  or production data.
- **Risk surfaces:** process overconstraint, checklist theater, legacy-card
  compatibility, and accidental review-evidence suppression. No material auth,
  security, external-input, concurrency, destructive-operation, accessibility,
  or performance surface is introduced by the implementation itself.
- **Initial tier:** Tier 1 — Bounded, targeting the spec pass. The file count is
  inflated by required canonical copies; the behavior is an established
  docs-driven workflow change, but requirements and scope need adversarial
  validation before the implementation plan is fixed.
- **Selected reviews:** one engineering spec review plus one independent
  adversarial spec reviewer.
- **Specialized lenses:** UI/design skipped (no user interface); DevEx skipped
  (no public API/CLI/SDK ergonomics); security skipped (no auth, secret, data, or
  external-input boundary change); performance skipped (no runtime hot path or
  benchmarkable behavior); external research skipped (the evidence and affected
  mechanisms are local and already available).

## Spec-sweep review audit

| Item | Decision / outcome |
| --- | --- |
| Initial tier | Tier 1 — Bounded, spec target |
| Final tier | Tier 1 — Bounded, unchanged after completed-plan reassessment |
| Correctness contract | `correctness-contract/v1` — required — COD-155 changes cross-stage workflow behavior and the handoff obligations themselves |
| Engineering review | Clear after adding deterministic applicability, proof-run evidence semantics, updater propagation, and README activation |
| Independent adversarial review | Clear after four material corrections; current-runtime reviewer used because explicit Claude reviewer dispatch is unsupported |
| UI/design lens | Skipped: no interaction or visual behavior changes |
| DevEx lens | Skipped: no public API, CLI, SDK, docs adoption flow, or compatibility contract changes |
| Security lens | Skipped: no material auth, security, data, secret, or external-input surface |
| Performance lens | Skipped: no runtime performance-sensitive path |
| Research lens | Skipped: no unfamiliar external integration or API |
| Terminal gate | Clear: selected reviews reconciled, plan agrees, skipped lenses justified, no unresolved decisions |

## Engineering review decisions

### D1. Contract applicability signal

ELI10: the next worker needs a stamped answer saying whether this card owes a
correctness contract. Guessing from dates or prose can either bounce valid old
work or let new work slip through.

**A. Explicit `required | not required` audit field (recommended). Completeness:
10/10.** This gives Spec, Dev, and QA one deterministic handoff signal and
preserves legacy compatibility with a small docs-only change.

**B. Infer applicability from document date or commit. Completeness: 6/10.**
This avoids one field but is brittle across rebases, copied plans, and older
cards updated later.

**C. Require the contract on every card immediately. Completeness: 5/10.** This
is simple but creates ceremonial matrices and false bounces for mechanical or
legacy work.

Decision: adopt A. The implementation grows to eleven physical files after the
review-proven updater and release-note requirements. It remains seven logical
artifacts because three skill pairs are required byte-identical copies; removing
propagation or QA consumption would make the factory-level remedy incomplete.

### D2. Updater propagation

ELI10: changing the master instructions does nothing for the three observed
workspaces unless their installed copy gets a new version marker.

**A. Bump `VERSION`, add the CHANGELOG entry, and test old-marker propagation
(recommended). Completeness: 10/10.** This exercises the existing updater and
proves the remedy reaches every contributor without inventing a distribution
path.

**B. Change only the skill files. Completeness: 4/10.** The managed kit updates,
but anchors whose `.sweep-version` still equals the old `VERSION` are skipped.

Decision: adopt A.

### D3. Proof-run evidence semantics

ELI10: running promised tests early is useful, but calling newly discovered
design defects “ordinary implementation work” would make the metric look better
without improving quality.

**A. Limit the run to declared proofs and record material contract omissions as
`review/correctness` (recommended). Completeness: 10/10.** This preserves the
metric and avoids adding a third open-ended review.

**B. Let Dev silently repair any omission before formal review. Completeness:
4/10.** It may improve code but invalidates the card's acceptance signal.

Decision: adopt A.

## Schema and architecture impact

No data schema changes. The Factory Learning architecture gains a planned
quality-feedback control: generated correctness cards may strengthen the shared
Spec-to-QA workflow through traceable invariants while preserving the evidence
and human-gated delivery loop. README should mark this as planned under COD-155
in this docs-only spec commit. The COD-155 implementation branch changes that
note to active and ships it with the skills, version marker, and release note.

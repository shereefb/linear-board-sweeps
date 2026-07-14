# COD-288 Trusted Dispatch Failure Evidence Design

## Summary

Factory Learning currently treats every child `terminal/failed` event as a
launcher dispatch failure. The five occurrences that generated COD-288 all came
from successful launcher runs whose child agents deliberately stopped at QA or
planning safety gates. They are useful workflow audit events, but they are not
evidence that a process failed to start or exited unsuccessfully.

Replace that inference with a versioned `repeated-dispatch-failure/v2` detector
whose observations come only from the launcher's structured outcome
classification after existing capacity, provider-exhaustion, and dependency
exclusions plus explicit learning-only exclusions for routing deferrals and
interruptions. Preserve terminal events for their existing audit and productivity
uses. Add a compatibility and exposure contract so COD-288's
active v1 outcome cannot be reported as improved merely because the old semantic
key disappeared.

## Problem and verified root cause

COD-288 cites five `terminal/failed` events across COD-144, COD-155, SAF-213,
and SAF-221. Every associated launcher run ended with outcome `success` and exit
code zero. The terminal summaries instead describe intentional workflow outcomes:
remaining in QA with changes requested, failing a Firestore contract check, or
returning to Spec because planning artifacts were unavailable.

The false relationship is explicit in current code:

- `scripts/learning.mjs:18-25` defines `terminal/failed` as a valid child audit
  event.
- `scripts/learning.mjs:327-361` projects every such event to
  `signal: "dispatch-failure"` with the constant fingerprint
  `terminal:failed`, regardless of the trusted run outcome.
- `scripts/learning.mjs:805-828` qualifies two matching observations in 24
  hours or three in the retained seven-day evidence set.
- `scripts/learning.mjs:930-941` assigns every production detector version
  `v1`, so changing semantics without a version bump would erase provenance.

The launcher already owns the authoritative distinctions COD-288 needs:

- `scripts/linear-watch.mjs:6259-6278` classifies successful exits, non-zero
  exits, signals, spawn errors, missing working directories/executables, and
  interruptions.
- `scripts/linear-watch.mjs:6899-6931` excludes capacity deferrals, provider
  exhaustion, and dependency deferrals before producing a structured
  `FailureEvent`; repository-routing preflight failures remain a separately
  typed launcher failure.
- `scripts/linear-watch.mjs:1954-1968` gives each failure Todo a stable,
  sanitized identity, but its scope and stable target deliberately include the
  individual issue/worktree. That identity must remain unchanged for Todo
  ownership and is too card-specific for systemic learning clustering.
- `scripts/linear-watch.mjs:6360-6436` already appends bounded, trusted launcher
  evidence runs with configured source-workspace and repository routing.

No new retry or scheduler mechanism is required. The missing mechanism is a
trusted projection from the existing launcher classification into the existing
bounded learning snapshot.

## Goals

- Count a dispatch failure only when the launcher proves a start, I/O,
  non-zero-exit, or signal failure after learning admission exclusions.
- Cluster repeated failures by a new launcher-owned learning key derived from
  stable route, stage, runtime lane, failure kind, and classified outcome fields,
  so issue/worktree identity and raw prose cannot split or merge causes.
- Keep child `terminal/failed` events available as workflow audit evidence
  without letting a child declare launcher reliability.
- Version the changed detector semantics as
  `repeated-dispatch-failure/v2` while leaving unrelated detectors on v1.
- Evaluate the active COD-288 v1 acceptance contract against the corrected
  evidence without accepting a traffic-free window as improvement.
- Preserve Factory Learning recurrence mechanics, deduplication, generation
  limits, ownership, redaction, bounded storage, and human Ship approval while
  explicitly separating the legacy broad lineage from new cause-specific v2
  lineages.

## Non-goals

- Change when a sweep emits `terminal/advanced`, `terminal/blocked`, or
  `terminal/failed`.
- Reclassify QA, plan, security, or dependency safety stops as launcher failures.
- Change retry, cooldown, capacity, provider fallback, dependency, repository
  routing, Todo, claim, or dispatch policies.
- Redesign the full event taxonomy or bump `LEARNING_EVENT_VERSION`; the child
  event contract and serialized event shape remain v1.
- Repair the separate last-write-wins treatment of contradictory terminal events
  in throughput observations. That does not cause COD-288's false reliability
  signal and would broaden this card beyond the proven defect.
- Edit SafeTaper repositories. They contributed evidence only; the implementation
  belongs to the configured `linear-board-sweeps` repo.
- Add a production deploy. This kit ships by merge/push to `main`.

## Alternatives and unattended decisions

### D1: Which component may assert a dispatch failure?

ELI10: a child can say its work failed for many healthy reasons, such as a test
gate rejecting a change. Only the parent launcher knows whether the child process
actually started and how it exited. Using the wrong witness turns safety behavior
into reliability incidents.

**A. Trusted launcher evidence (recommended), Completeness: 10/10.** Project the
launcher's classified `FailureEvent` through a dedicated learning-admission
filter and the bounded launcher-evidence path. This covers pre-start, I/O, exit,
and signal failures and derives a learning identity from typed launcher fields.

**B. Remove the terminal mapping only, Completeness: 6/10.** This stops false
positives but leaves the detector unable to observe real dispatch failures.

**C. Add a child-reported reason key, Completeness: 4/10.** This still trusts the
wrong process, cannot observe failures before child startup, and duplicates
launcher classification.

**Decision:** A. The launcher is the only authority with complete dispatch
outcome context.

### D2: How should active v1 acceptance be evaluated after v2 lands?

ELI10: COD-288's scorecard points at the old constant key. If v2 simply removes
that key, the evaluator can see zero matching rows and call the problem fixed
even if no affected workspace ran or real failures continued under new keys.

**A. Compatibility scope plus exposure floor (recommended), Completeness:
10/10.** Treat COD-288's exact legacy `terminal:failed` semantic key as an alias
for all corrected v2 dispatch-failure observations owned by its declared
contributors. Require at least one eligible post-Done dispatch attempt from every
declared contributor before a zero count is conclusive.

**B. Retire the v1 evaluation, Completeness: 5/10.** This is honest about the
metric break but abandons the acceptance commitment that generated the work.

**C. Rewrite the live Linear card after delivery, Completeness: 6/10.** This
depends on mutable external state, weakens historical provenance, and makes
evaluation correctness an attended operation.

**Decision:** A. Compatibility is narrowly keyed to this detector's legacy
semantic value and cannot affect other detector contracts.

### D3: Should COD-288 also validate contradictory child terminals?

ELI10: multiple terminal events for one run can make throughput attribution
order-dependent, but dispatch-failure v2 no longer reads terminal events at all.
Bundling that cleanup would add another behavior change without improving the
reliability signal that created this card.

**A. Defer as a separately evidenced defect (recommended), Completeness: 10/10
for COD-288.** Keep the implementation tied to the proven trust-boundary bug and
record contradictory-terminal handling as outside this card.

**B. Add terminal cardinality validation now, Completeness: 8/10 for COD-288.**
This improves a neighboring throughput path but expands fixtures, failure policy,
and review surface without a COD-288 acceptance requirement.

**Decision:** A. No observed COD-288 occurrence depends on terminal ordering.

## Proposed architecture

```text
child terminal/failed -- retained workflow audit --X-- dispatch reliability

launcher dispatch result
        |
        +-- trusted successful delivery run -------------------+
        |                                                       |
        |                                            outcome exposure gate
        |
        +-- actual failure after exclusions
                 |
                 v
          structured FailureEvent
                 |
                 v
          bounded launcher evidence
          type=dispatch-failure
          key=dispatchLearningKey(...)
                 |
                 v
          snapshot observation
                 |
                 v
          repeated-dispatch-failure/v2
```

### 1. Authoritative evidence production

After `reconcileDispatchResult` computes its operational `failures`, pass them
through a pure learning-admission helper. Admit only dispatch-start and
dispatch-exit failures whose reconciled result is not success, dependency or
repository-routing deferral, capacity/provider exhaustion, or interruption.
This is intentionally narrower than existing Failure Todo behavior: routing and
interruption may keep their current operational handling while emitting no
learning dispatch-failure evidence. Each admitted failure has:

- `type: "dispatch-failure"`;
- `occurredAt` from the classified result/reconciliation time;
- `key` equal to a new pure `dispatchLearningKey(...)` hash;
- bounded `stage`, `subsystem`, `reason`, and sanitized `summary` fields; and
- trusted workspace/project/repo/card routing supplied by
  `appendLauncherEvidenceRun` using a bounded card identity
  `{ identifier: pick.issueIdentifier }`, `pick.sweep`, and
  `pick.repoRoute.repoEntry` (or the configured default repo when routing is not
  enabled). Do not pass the pick object itself: dispatch picks do not expose the
  `card.identifier` field required by the evidence builder.

Append directly inside `reconcileDispatchResult` immediately after the admitted
set is deduplicated by learning key; never route occurrence persistence through
`reconcileFailureTodos`, whose mutations are throttled and may be empty. Wrap
each append batch in dedicated error handling: record a local launcher failure,
then continue existing claim release, retry/resume, and Failure Todo
reconciliation. A repeated real occurrence is persisted even when its Todo needs
no create/update, and an evidence write failure cannot retain a claim or alter
retry policy. The append does not parse logs, card comments, or child prose.

For routed workspaces, the route is the dispatch-time issue identity and scheduled
repo, not the Failure Todo and not the anchor-source-repo fallback used by other
launcher maintenance evidence. If that original route no longer resolves to
exactly one configured repo, append the existing route-gap record, which lacks a
trusted route and cannot become a detector observation.

`dispatchLearningKey` uses only canonical source workspace/project/repo, sweep,
final runtime/model lane, `FailureEvent.kind`, classified outcome kind, and
bounded code/exit code/signal. It excludes
issue identifier, worktree/log paths, timestamps, messages, and child terminal
prose. The serialized key is a hash, so local paths and provider details are not
disclosed in learning artifacts. Same-lane failures with different exit codes,
signals, or start-error codes remain separate.

Each failed reconciled result contributes at most one occurrence per distinct
learning key. Existing `failureFingerprint` and Failure Todo behavior remain
unchanged and independent; learning occurrence count must not depend on Todo
creation, card identity, or its comment throttle.

### 2. Bounded snapshot projection

Add `dispatch-failure` to `LAUNCHER_EVIDENCE_TYPES` without changing the event
schema version. `launcherEvidenceObservation` projects it to the existing
`dispatch-failure` signal and copies the stable learning key into `fingerprint`
and `rootCauseKey`. Remove the `terminal/failed` dispatch projection from
`eventObservation`.

For acceptance exposure only, inspect the snapshot's existing normalized run
records directly. An eligible healthy run has a trusted route,
`outcome.kind === "success"`, exit code zero, a delivery sweep (`spec`, `dev`,
`qa`, or `ship`), and a non-launcher runtime. Use the authoritative outcome kind,
not the optional normalized `outcome.success` field, which current production run
records do not consistently populate. Do not project a per-run exposure
observation: that could consume the bounded observation budget and make
unrelated detector coverage incomplete. Deferred, interrupted,
capacity/provider, maintenance, and learning-only outcomes cannot satisfy the
healthy-run predicates.

The current snapshot caps (100 launcher evidence items per run, 5,000 runs,
10,000 events, and 5,000 observations) remain unchanged. Text continues through
the existing sanitizer and length limits.

### 3. Versioned detector identity

Allow detector definitions to declare a version, defaulting unchanged detectors
to v1. Set only `repeated-dispatch-failure` to v2. Qualification thresholds stay
the same: two same-key failures in 24 hours or three in the retained window. The
semantic key now derives from the stable launcher fingerprint, so different
failure causes cannot qualify each other.

Root fingerprints remain version-independent but include the semantic key. The
legacy v1 root uses `terminal:failed`; each v2 root uses its cause-specific
learning key. Therefore COD-288's legacy evaluation is measurement-only after
migration: it can record improvement, no change, or regression through the
compatibility scope below, but a fresh v2 cause does not recur COD-288. Instead it
creates or updates its own generation-zero v2 lineage; later occurrences of that
same v2 cause use the unchanged recurrence and three-generation human-review cap.
This separation comes from semantic-key/root identity, not the detector version
field itself. Tests must prove both the legacy/v2 separation and unchanged
same-v2 recurrence.

### 4. Outcome compatibility and exposure

For `evaluateLearningOutcome`, add one explicit compatibility rule:

- when `detectorId` is `repeated-dispatch-failure` and the saved semantic key is
  the exact legacy value `terminal:failed`, scope all owned corrected
  `dispatch-failure` observations during the evaluation window;
- all new v2 evaluations remain cause-specific through their stable semantic key;
  and
- unrelated detectors and semantic keys retain current behavior.

Add a dispatch exposure check for repeated-dispatch-failure evaluations. A zero
count becomes conclusive only when every declared ownership contributor has at
least one post-completion eligible successful delivery run or corrected
`dispatch-failure` observation in the window. Healthy exposure comes only from
the snapshot's trusted normalized run records; failure exposure comes from
reconciled launcher evidence.
Launcher maintenance, learning-only runs, dependency/routing deferrals,
capacity/provider deferrals, and interruptions cannot satisfy the floor. A
window without complete coverage or contributor exposure remains
`inconclusive-evidence`.

If any corrected failure occurs, its count is evaluated even while another
contributor lacks healthy exposure; the exposure floor exists to prove zero, not
to hide observed regressions. Recurrence stays gated on the existing fresh
qualified-finding rule.

## Security and trust-boundary review

COD-288 is classified `data` because structured evidence controls automated card
admission, acceptance evaluation, and possible recurrence. The material security
properties are integrity and provenance, not confidentiality:

- Child-authored terminal prose cannot manufacture a launcher reliability
  occurrence.
- Launcher evidence must resolve exactly one configured source workspace and
  repository route; route gaps fail closed under the existing evidence mechanism.
- Stable identity comes from typed, sanitized launcher route/runtime/outcome
  fields, not raw logs, secrets, issue/worktree paths, or child prose.
- Existing text sanitization and bounded storage remain mandatory.
- An attacker or malformed child outcome cannot turn capacity/provider/dependency
  deferral into a dispatch failure because classification occurs in the parent
  after explicit exclusions.
- A migration cannot report success from missing traffic; the contributor
  exposure floor makes absence of evidence inconclusive.

No new credential access, network endpoint, executable input, authorization
boundary, or secret-bearing payload is introduced.

## Failure handling

| Failure | Required behavior |
| --- | --- |
| Child emits `terminal/failed` after an intentional gate | Retain audit event; emit no dispatch-failure observation. |
| Child exits zero but terminal state is failed | Launcher outcome remains success; emit no dispatch-failure evidence. |
| Executable or cwd is absent, spawn errors, child signals, or child exits non-zero | Emit one typed launcher occurrence after exclusions. |
| Capacity or provider usage is exhausted | Preserve cooldown/resume behavior; emit no dispatch-failure occurrence. |
| Dependency defers material work | Preserve dependency outcome; emit no dispatch-failure occurrence. |
| Repository route preflight defers the child | Preserve existing typed operational handling; emit no learning dispatch-failure evidence and do not count healthy exposure. |
| Parent interruption stops a child | Preserve existing claim/Todo behavior; the explicit learning filter emits no dispatch-failure evidence and does not count healthy exposure. |
| Learning evidence append throws | Record a local launcher failure, then continue claim release, retry/resume, and Todo reconciliation. |
| Evidence cannot resolve one trusted repo route | Use the existing route-gap failure record; do not create a trusted observation. |
| Different classified failure causes occur close together | Keep separate learning keys; neither qualifies the other. |
| Active legacy evaluation sees no contributor traffic | Return `inconclusive-evidence`, not improvement. |
| Active legacy evaluation sees corrected real failures | Count all owned corrected failures under the compatibility rule. |

## Scope closure

Scope closure: `scope-closure/v1` — required — COD-288 changes an automated
evidence trust boundary, detector identity, acceptance evaluation, and release
documentation.

### Scope closure inventory

| ID | Surface and evidence | Required outcome | Owning repo/module | Closure proof |
| --- | --- | --- | --- | --- |
| `S1` | Child event projection in `scripts/learning.mjs:327-361` | Terminal failures no longer assert dispatch failure; other child projections remain unchanged. | `linear-board-sweeps` / learning snapshot | Focused projection tests with success + failed terminal fixtures. |
| `S2` | Launcher classification and exclusions in `scripts/linear-watch.mjs:6259-6278,6899-6931` | Every admitted start/I/O/exit/signal failure produces one route/runtime/outcome-keyed occurrence independent of Todo throttling; routing/interruption and existing exclusions produce none; operational Failure Todo identity/behavior is unchanged. | `linear-board-sweeps` / watcher | Pure-key and real-builder watcher tests for bounded card identity, same/different issues, start, I/O, exit, signal, routing, capacity, provider, dependency, interruption, empty Todo decisions, append throw, multi-repo/route-gap, and secret persistence paths. |
| `S3` | Run/evidence normalization and projection in `scripts/learning.mjs:179-238,313-391` | Failure evidence stays typed, sanitized, bounded, route-trusted, and cause-keyed; successful delivery exposure is read from existing normalized run records without consuming observation capacity. | `linear-board-sweeps` / learning snapshot | Snapshot/evaluator tests reject malformed evidence, separate fingerprints, and admit exposure only for trusted successful delivery runs. |
| `S4` | Detector table and qualifier in `scripts/learning.mjs:805-941` | Only repeated-dispatch-failure defaults to v2; same-cause thresholds qualify and different causes do not. | `linear-board-sweeps` / detectors | Detector-version and threshold fixtures. |
| `S5` | Outcome evaluator in `scripts/learning.mjs:1368-1455` | Legacy COD-288 key sees corrected owned failures; zero requires per-contributor eligible exposure; new v2 keys stay cause-specific. | `linear-board-sweeps` / evaluation | Outcome fixtures for failure, zero+exposure, partial/no exposure, incomplete coverage, and unrelated detectors. |
| `S6` | Factory lifecycle and recurrence | Legacy COD-288 remains measurement-only; v2 causes start separate lineages whose deduplication, recurrence, generation cap, QA, Signoff, and human Ship gates stay unchanged. | `linear-board-sweeps` / learning + board workflow | Focused legacy/v2 root and recurrence assertions plus existing full suite. |
| `S7` | Canonical architecture and release distribution | README explains trusted dispatch evidence; CHANGELOG/VERSION ship through normal updater path. | `linear-board-sweeps` / docs + release | Doc inspection, version uniqueness, full suite, merge/push `main`. |

### Bidirectional self-check

Every goal, failure mode, predicted file, acceptance requirement, and rollout step
maps to `S1` through `S7`. Every row has a falsifiable test or inspection and the
single configured owning repo. No implementation or deploy work is assigned to a
SafeTaper sibling. The initial draft omitted a trusted positive exposure source
for proving a zero-failure window. The pre-review self-check emitted one
`review/scope-gap` event, added explicit trusted-run exposure, and reconciled
`S2`, `S3`, `S5`, `V2`, `V3`, `V6`, and `V7` before formal review.

## Verification contract

Verification contract: `verification-contract/v1` — required — the detector
trust boundary and legacy outcome compatibility need executable proof, including
negative paths that show false evidence cannot enter the metric.

| ID | Risk / acceptance behavior | Test level and proof | Expected signal | Scope row |
| --- | --- | --- | --- | --- |
| `V1` | A successful run with child `terminal/failed` must not count | Unit/snapshot fixture in `tests/learning.test.mjs` | No `dispatch-failure` observation or finding | `S1` |
| `V2` | Each successful delivery run or admitted launcher start/I/O/exit/signal failure supplies trusted exposure once | Pure-key and watcher fixtures in `tests/linear-watch.test.mjs` plus production-shaped snapshot/evaluator fixtures that omit `outcome.success` | Existing kind-success/exit-zero run satisfies exposure without a new observation; failure is learning-keyed; same cause across issue/worktree paths matches while typed cause changes differ | `S2`,`S3` |
| `V3` | Capacity, provider exhaustion, dependency/routing deferral, interruption, launcher maintenance, and learning-only runs cannot enter failure evidence or prove healthy exposure | Table-driven watcher/snapshot/evaluator fixtures | Existing operational handling may run, but no excluded result appends learning failure evidence or satisfies contributor exposure | `S2`,`S3` |
| `V4` | Same cause qualifies at existing threshold; different causes do not aggregate | Detector fixture | One v2 finding only for repeated same key | `S3`,`S4` |
| `V5` | Detector provenance changes only for this detector | Detector registry fixture | dispatch detector `v2`; all unrelated detectors `v1` | `S4` |
| `V6` | Legacy COD-288 evaluation cannot go green from a vanished key | Outcome fixtures | Corrected failures count; zero without all contributor exposure is inconclusive | `S5` |
| `V7` | Complete contributor exposure with zero corrected failures can verify the target | Outcome fixture with eligible post-completion runs | `verified-improvement` at count zero | `S5` |
| `V8` | Legacy/v2 lineage separation and existing v2 recurrence/safety gates survive | Existing + focused root/mutation regression tests | Legacy COD-288 does not recur from a v2 cause; same-cause v2 recurrence/dedupe/generation stays unchanged; factory cards remain human-Ship-only | `S6` |
| `V9` | Release artifact is distributed by the existing kit path | Full Node suite, README/CHANGELOG/VERSION inspection, clean diff | All tests pass; one-repo release docs complete | `S7` |

No invariant depends only on manual inspection. The implementation plan must name
the exact red-to-green commands and preserve these IDs in task proofs.

## Performance declaration

Performance contract: not required. The change appends at most one bounded
synthetic evidence record per admitted dispatch failure and reads healthy
exposure from run records already traversed by the capped snapshot/evaluator. It
adds no per-success record, hot-path polling, retries, fan-out, deadline,
unbounded history scan, or new asymptotic work. Existing snapshot caps and
full-suite performance behavior are the proof; no benchmark is warranted.

## Predicted implementation footprint

- `scripts/learning.mjs`
- `scripts/linear-watch.mjs`
- `tests/learning.test.mjs`
- `tests/linear-watch.test.mjs`
- `README.md`
- `CHANGELOG.md`
- `VERSION`

The seven-file runtime/release footprint introduces no class, service,
dependency, schema, or new artifact type.

## Review depth and specialized lenses

- **Initial tier:** Tier 2 — Material. Automated evidence admission and outcome
  evaluation cross a trust boundary and require compatibility failure paths.
- **Security lens:** required by the `data` label and material integrity boundary.
- **Performance lens:** skipped; the performance declaration above shows no
  material hot-path or scaling change.
- **Design lens:** skipped; no UI or interaction surface changes.
- **DevEx lens:** skipped; no public API, CLI, SDK, or developer-facing contract
  changes.
- **Research lens:** skipped; the design reuses repository-native mechanisms and
  introduces no unfamiliar external technology.

Tier 2 requires an engineering spec pass, an independent adversarial premise
review before plan creation, and an engineering plan pass afterward.

## Spec review audit

| Pass | Outcome | Findings and corrections |
| --- | --- | --- |
| Pre-review scope self-check | Passed after correction | Emitted one `review/scope-gap`: the first draft could count zero failures without a trusted contributor-exposure source. Added production-shaped healthy-run exposure and mapped it through `S2`,`S3`,`S5`,`V2`,`V3`,`V6`,`V7`. |
| Focused security (`data` lens) | Passed | No reportable vulnerability. Confirmed parent-only provenance, configured-route fail-closed behavior, hashed/sanitized identity, bounded storage, and no-traffic evaluation integrity. Local report: `.gstack/security-reports/20260714-103251.json` (ignored, not shipped). This focused AI-assisted review is not a substitute for a professional security audit. |
| Tier 2 engineering spec pass | Passed after correction | Replaced per-success persisted evidence with existing run-record exposure; separated systemic learning identity from card-specific Failure Todo identity; kept exposure outside the observation budget; used production-populated outcome kind instead of optional success. |
| Independent adversarial spec pass | Passed after follow-up | Required explicit measurement-only legacy lineage, Todo-independent append error isolation, learning-only routing/interruption exclusions, and dispatch-time repo-route ownership. Follow-up re-read found no unresolved blockers. |

The configured preferred reviewer runtime was not available through the
collaboration interface; the independent pass used a fresh-context read-only
reviewer subagent and records that limitation here. All verified material
findings were emitted as structured review evidence before correction. No review
finding is suppressed or recategorized to improve COD-288's acceptance metric.

## Acceptance criteria

- The five successful launcher runs cited by COD-288 do not produce corrected
  dispatch-failure observations.
- Two actual failures with one stable root cause inside 24 hours qualify one
  `repeated-dispatch-failure/v2` finding; two different root causes do not.
- Start, I/O, exit, and signal failures have positive coverage; routing,
  interruption, and every existing exclusion have negative learning-admission
  coverage without changing their operational handling.
- COD-288's legacy acceptance evaluation counts corrected owned failures and is
  inconclusive until every declared contributor has eligible exposure.
- With complete contributor exposure and zero corrected failures, the target
  `dispatchFailureCount = 0` can be verified.
- Existing unrelated detector identities, v2 recurrence mechanics, redaction,
  snapshot bounds, retry behavior, and board safety gates remain green; legacy
  COD-288 is explicitly measurement-only after migration.
- README, CHANGELOG, and a unique current VERSION describe and distribute the
  corrected contract.
- The implementation remains one configured repository and follows
  Spec -> Dev -> QA -> Signoff -> human Ship because COD-288 is
  `factory:learning-generated`.

## Rollout and recovery

Implementation lands through the normal Dev/QA/Signoff workflow and human Ship
move. Shipping is merge/push to `main`; the existing updater distributes the kit.
Before release, Dev fetches `origin`, chooses a VERSION greater than every live
release marker, runs focused tests and `node --test tests/*.test.mjs`, previews
`learning-run --dry-run`, and inspects the detector/evaluation output for
production-shaped fixtures.

The kill switch remains the existing workspace or registry `learning.enabled`
setting/runner flag. If corrected evidence behaves unexpectedly, disable the
learning runner, revert the release commit, and rerun the dry-run before
reenabling. Delivery sweeps do not depend on the learning runner, so this recovery
does not pause Dev, QA, Signoff, or attended Ship.

## Versioned contract boundary

This artifact is created after the installed sweep marker and therefore must use
current `scope-closure/v1` and `verification-contract/v1` requirements. The plan
must verify lineage with:

```bash
git log --diff-filter=A --format=%H -- docs/superpowers/specs/2026-07-14-COD-288-trusted-dispatch-failure-evidence-design.md
git log --diff-filter=A --format=%H -- .claude/skills/.sweep-version
git merge-base --is-ancestor <artifact-commit> <marker-commit>
```

For this new descendant artifact the ancestry check is expected to exit 1,
proving it is post-boundary. Missing or incomparable commits fail closed.

## Open questions

None. The unattended sweep selected the recommended choices above from verified
repository evidence. No owner-only product, credential, asset, policy, or
third-party decision is required.

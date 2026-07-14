# COD-289 Observed Terminal I/O Claim Reliability Design

## Summary

COD-289 was generated from five `dev|claim-reaper` stale-claim observations
between 2026-07-11T00:36:10Z and 2026-07-11T12:54:31Z. All five predate
COD-169's immutable-claim rollout, and the local run index contains no matching
observation after that rollout through 2026-07-14. The stored reap evidence does
not retain an originating dispatch outcome, so it cannot prove that any of the
five historical occurrences came from the defect specified here.

The investigation nevertheless found one live, directly reachable false-stale
path. `dispatchAsync()` returns a typed `dispatch-io-error` after a child log
write fails and the launcher observes that child close, but
`reconcileOwnedDispatchClaim()` recognizes only `exit` and `signal` as observed
terminal failures. The exact claim can therefore remain until the crash reaper
later treats an observed termination as a silent crash. COD-289 closes that
all-stage lifecycle gap using COD-148's declaration-bound terminal cooldown and
COD-169's immutable claim-close protocol. It does not redesign the claim model,
suppress genuine stale evidence, or claim that the historical five events share
this cause.

## Evidence and existing mechanisms

- COD-289's five occurrence IDs are distinct launcher runs on `SAF-139`,
  `COD-155`, `COD-169`, `SAF-250`, and `SAF-210`. The frozen acceptance metric
  is `staleClaimCount`, direction `decrease`, target `0`, baseline `5`, detector
  `stale-claim-pattern/v1`, semantic key `dev|claim-reaper`, with current and
  SafeTaper contributors.
- COD-148 introduced `releaseFailedDispatchClaim()`: write declaration-bound
  retry evidence, complete-read and close the exact claim epoch, then remove
  only that claim (`scripts/linear-watch.mjs:5632-5650`).
- `reconcileOwnedDispatchClaim()` routes only `exit` and `signal` through that
  helper (`scripts/linear-watch.mjs:5651-5682`). The function is shared by Spec,
  Dev, QA, and Ship; the omission is not Dev-only.
- `dispatchAsync()` kills a child whose stdout/stderr cannot be written, waits
  for close, and returns `{ kind: "dispatch-io-error", code:
  "LOG_WRITE_FAILED" }` (`scripts/linear-watch.mjs:6595-6645`). Existing tests
  prove the typed result but not its claim lifecycle
  (`tests/linear-watch.test.mjs:5980-6002`).
- Post-dispatch capacity classification scans the partial log for every
  non-success result (`scripts/linear-watch.mjs:2463-2468`). Capacity text
  written before the log failure can set `preserveTerminalClaim`, overriding
  terminal cleanup even though `dispatch-io-error` is explicitly excluded from
  usage-exhaustion classification.
- `dispatchAsync()` also reads the child's dependency/repository deferral file
  after each attempt and currently lets that file replace the direct I/O result
  (`scripts/linear-watch.mjs:6707-6711,6749`). A child can write a valid deferral
  and then hit the launcher log failure; claim release still happens, but the
  terminal cooldown and dispatch-failure evidence disappear.
- Unknown result kinds intentionally perform no automatic claim mutation. The
  implementation must extend a closed set, not infer that every failure is safe
  to release.
- Confirmed reaping removes the label before appending local learning evidence.
  If evidence persistence fails, tick health is red but zero observations may be
  stored (`scripts/linear-watch.mjs:7497-7504`). COD-289 must not promise a
  durable exactly-once outbox that does not exist.
- The current repository baseline is 673 passing tests from
  `node --test tests/*.test.mjs` at `dafbb36`.

## Goals

1. An observed `dispatch-io-error` must use the existing declaration-bound
   terminal cooldown cleanup for every scheduled stage.
2. Partial capacity-like text in a failed log must not retain a claim after the
   log sink itself failed and the launcher observed child termination.
3. A child deferral file must not replace a directly observed I/O result on the
   primary or fallback attempt; ordinary non-I/O deferrals remain unchanged.
4. Cleanup must remove only the exact first-declaration-wins epoch, preserve
   unrelated labels, and fail closed if any ownership boundary is unprovable.
5. Genuine silent/frozen work must remain on the existing reaper path; a
   successfully persisted confirmed reap remains visible as one stale-claim
   observation.
6. Existing dependency, route, provider recovery, QA, Signoff, human Ship,
   retry-duration, and learning-detector gates remain unchanged.

## Non-goals

- Claiming that `dispatch-io-error` caused any of COD-289's five historical
  occurrences; current evidence cannot establish that correlation.
- Replacing first-declaration-wins ownership, heartbeats, close markers, retry
  markers, reaper timing, or full-label mutation behavior.
- Adding a label, database, schema, service, configuration option, comment
  grammar, or durable evidence outbox.
- Suppressing or renaming `stale-claim` evidence, changing detector thresholds,
  or altering recurrence.
- Making count-zero Factory Learning outcomes exposure-aware. A defensible
  redesign needs a frozen pre-change opportunity denominator plus authoritative
  cross-host contribution/completeness evidence. Baseline failure count `5` is
  not that denominator, and the current pinned runner's local index cannot prove
  remote-host completeness.
- Changing COD-289's generated-card path: QA -> Signoff -> human Ship remains
  mandatory and fast path remains forbidden.

## Options considered

### A. Surgical all-stage lifecycle hardening (recommended)

ELI10: when the launcher saw a worker stop because logging broke, remove only
that worker's exact “busy” sign using the safe cleanup already used for other
observed stops. Do not call it a silent crash later, and do not let partial log
text override what the launcher directly observed.

**Completeness: 10/10.** This fixes a proven reachable lifecycle omission,
closes its capacity-precedence bypass, exercises every shared stage, and retains
all existing ownership and reaper safety boundaries.

### B. Lifecycle hardening plus exposure-aware outcome evaluation

ELI10: fix the busy sign and also change how the factory decides that quiet
means better.

**Completeness: 6/10 for this card.** It sounds broader, but the current card
stores a failure count rather than an opportunity denominator, and one local
runner cannot attest every host contributed evidence. Any threshold would be an
invented proof. This option creates false confidence rather than completeness.

### C. Mark COD-289 Duplicate of COD-148/COD-169

ELI10: assume the earlier fixes covered every terminal path and close the card.

**Completeness: 4/10.** The historical five may already be addressed, but the
live `dispatch-io-error` exclusion and capacity override are distinct code paths
that still manufacture stale-claim evidence.

Decision: adopt option A.

## Design

### 1. One closed observed-terminal predicate

Extract the current `exit || signal` comparison into a small pure predicate and
add only the existing typed I/O result:

```js
isObservedTerminalFailure(result) ===
  result.kind === "exit" ||
  result.kind === "signal" ||
  result.kind === "dispatch-io-error";
```

`reconcileOwnedDispatchClaim()` uses that predicate in the same two places that
currently use `terminalFailure`: the explicit recovery-retention guard and the
call to `releaseFailedDispatchClaim()`. Start failures, dependency/repository
deferrals, interruption, success, and unknown future result kinds retain their
current behavior. There is no wildcard “non-success” fallback.

The cleanup helper already accepts `result.code` as bounded marker detail,
writes retry evidence before closing, proves the exact declaration from complete
history, verifies the close boundary, removes only the claim label, and verifies
the final label set. COD-289 changes none of that ordering or grammar.

### 2. Direct observation wins over partial capacity text

`classifyCapacityOutcome()` must return `null` for
`result.kind === "dispatch-io-error"` before scanning `logTail`. Once the sink
has failed, the tail is partial and cannot authoritatively classify provider
capacity. More importantly, the launcher directly observed a terminal I/O
result and already has a declaration-bound retry cooldown that prevents an
immediate loop.

This rule is deliberately narrow. Ordinary `exit` results with recognized quota
or capacity text keep their existing resume/cooldown behavior. Confirmed usage
exhaustion remains unchanged. `dispatch-io-error` still creates the existing
dispatch failure/Todo evidence even when exact claim cleanup succeeds.

Keep the real tick wiring testable by extracting its inline capacity/preserve
decision into one exported pure recovery-policy helper. It consumes the result,
provider/final exhaustion booleans, and bounded log tail, then returns
`{ capacityKind, preserveTerminalClaim }`. The production
`reconcileDispatchResult` closure must consume both returned fields for the
capacity store and `reconcileOwnedDispatchClaim()` call. This is a seam around
one existing decision, not a second recovery model.

The same direct-observation precedence applies before reading a child deferral
outcome. On both primary and fallback completion, if the attempt result is
`dispatch-io-error`, `dispatchAsync()` finishes with that result without calling
`childDeferredOutcomeForPick()`. For every other attempt result, the validated
dependency/repository outcome keeps its current precedence and behavior. A
mixed fixture must cover both the primary return and the fallback's final
`deferred || outcome` expression.

### 3. Shared-stage lifecycle matrix

The production predicate is shared across the closed configured sweep set, so
verification covers Spec, Dev, QA, and Ship claims rather than asserting only
Dev:

| Condition | Required claim result | Retry / evidence result |
| --- | --- | --- |
| `dispatch-io-error` in any configured stage | Exact declaration closed; only its claim removed | Existing declaration-bound stage cooldown; no confirmed reap |
| `dispatch-io-error` after capacity-like partial text | Same terminal cleanup; not recovery retention | Existing dispatch failure/Todo remains |
| `dispatch-io-error` plus a valid child deferral file | Direct I/O result wins on primary and fallback | Terminal cooldown and dispatch failure remain; dependency relation still blocks admission independently |
| Retry comment, close proof, or label mutation fails | Stop at the existing fail-closed boundary | Claim may later be genuinely reaped; cleanup failure is visible |
| Competing declaration/latest owner changes | Old result performs no foreign mutation | New epoch remains authoritative |
| Explicit provider/capacity recovery for ordinary exits | Existing exact claim/worktree retained | Existing recovery policy unchanged |
| Unknown result kind | No inferred mutation | Existing liveness/reaper policy |
| Silent/frozen child with successful reap evidence persistence | No terminal reconciliation | One confirmed declaration-scoped stale observation |
| Reap evidence persistence fails after label removal | Claim is already released; tick is red | Zero stored observations is possible; no false exactly-once claim |

The integrated test must inspect marker -> close -> label mutation ordering and
then feed the resulting card to reaper decisions. A mock that only counts a
helper call is insufficient.

### 4. Measurement semantics

COD-289 keeps its generated seven-day `staleClaimCount` contract unchanged.
After Done, the pinned learning runner evaluates the exact frozen semantic and
ownership scope using the current fixed-window behavior. A zero count is a
quiet-window operational signal, not causal proof that this I/O path caused or
eliminated the historical five events. Partial coverage remains
`inconclusive-evidence` under the existing gate.

No exposure threshold is introduced. A future exposure-aware design must first
persist a pre-change owned-run denominator and define an authoritative host
contribution manifest; it must also decide whether insufficient exposure is a
final fixed-window outcome or a bounded nonterminal extension. COD-289 neither
guesses those decisions nor creates another card during this single-card run.

### 5. Documentation and release

Update both operator architecture sources: README's self-healing summary and
`docs/linear-rules.md`'s terminal cleanup rule. State that typed terminal I/O
failures use exact cooldown cleanup, ordinary capacity recovery is unchanged,
and silent work remains on the reaper path. Release notes must not claim the
historical five were caused by I/O.

Ship as the next unused patch version. Keep `VERSION`, the newest CHANGELOG
heading, and `.claude/skills/.sweep-version` identical because the updater uses
that marker even when sweep skill text is unchanged. This repo has no production
app deploy; any external publishing remains attended or a linked Todo.

## Scope closure inventory

`Scope closure: scope-closure/v1 — required` because shared launcher failure
control, exact ownership cleanup, recovery precedence, operator docs, and kit
distribution change.

| ID | Surface and evidence | Required outcome | Owning repo/module | Closure proof |
| --- | --- | --- | --- | --- |
| S1 | Typed `dispatch-io-error` exists but terminal reconciliation excludes it | Add only that type to the shared closed terminal predicate | `linear-board-sweeps` / `scripts/linear-watch.mjs` | V1 plus all-stage V3 matrix |
| S2 | Capacity scanning and child deferral files can override the typed terminal result | Give I/O precedence before either secondary classifier on primary/fallback while preserving every non-I/O path | `linear-board-sweeps` / `scripts/linear-watch.mjs` | V2 mixed I/O/capacity/deferral fixtures |
| S3 | Exact claim, competing epoch, cleanup failure, and genuine silent work | Preserve immutable ownership and honest reaper/evidence behavior | `linear-board-sweeps` / launcher lifecycle and tests | V3-V4 integrated outcomes |
| S4 | README and operator rules currently mention only exit/signal | Document actual all-stage I/O behavior without historical-cause overclaim | `linear-board-sweeps` / README, `docs/linear-rules.md`, CHANGELOG | V5 text/version assertions and review |
| S5 | Patch distribution uses kit and installed-skill version markers | Keep VERSION, CHANGELOG, and `.sweep-version` aligned; merge/push main only after QA and human Ship | Configured repo and human release owner | V5 full suite, version equality, pushed tested SHA; Todo for attended external step |
| S6 | Generated-card outcome still measures a fixed seven-day count | Preserve the existing metric/gates and state the causal/exposure limitation | Factory Learning runner; no evaluator code change | Selective diff excludes `scripts/learning.mjs`; QA handoff records interpretation |

Self-check: every goal, failure row, acceptance criterion, predicted file, and
release/measurement surface maps to S1-S6. All implementation belongs to this
configured core repo; evidence from sibling workspaces does not require sibling
branches or deploys.

## Correctness contract

`Correctness contract: correctness-contract/v1 — required` because COD-289
changes failure/recovery precedence and immutable-claim transitions.

| ID | Trigger / transition | Required invariant | Forbidden outcome | Recovery / ownership | Verification |
| --- | --- | --- | --- | --- | --- |
| C1 | An observed I/O terminal result closes | It enters the existing retry -> exact close -> claim removal path once | Ended child remains apparent owner until ordinary reaping | Existing terminal helper owns cleanup; failure retains the safe boundary | V1 |
| C2 | Partial log or valid child deferral exists when I/O failure is directly observed | Typed terminal I/O result wins before both secondary classifiers, on primary and fallback | Partial text retains recovery or a child file replaces terminal cooldown/failure evidence | Terminal cooldown owns the observed failure; ordinary non-I/O capacity/deferral behavior remains | V2 |
| C3 | Any configured stage receives the result or races a newer epoch | Only the exact first-declaration-wins epoch may close or lose its stage claim | Shared predicate mutates another stage/owner or unrelated label | Complete history and existing close verifier fail closed | V3 |
| C4 | No terminal result exists, or reap evidence persistence fails | Silent work remains reapable; successful evidence persistence yields one observation, while persistence failure is red and may yield zero | Hardening suppresses reaping, duplicates evidence, or promises nonexistent exactly-once durability | Reaper and tick-health owners retain current behavior | V4 |

## Verification contract

`Verification contract: verification-contract/v1 — required` because broad
green tests would not detect result-precedence, shared-stage, or evidence-truth
regressions.

| ID | Source requirement / C ID(s) | Behavior / risk | Failure this proof must catch | Required proof | Acceptance |
| --- | --- | --- | --- | --- | --- |
| V1 | Goals 1 and 3; C1 | I/O result enters existing exact terminal cleanup | Result remains `attempted:false` or bypasses marker/close ordering | Focused reconciliation test plus one integrated result-to-label fixture | One cleanup attempt; `LOG_WRITE_FAILED` detail; exact claim absent; unrelated labels present |
| V2 | Goals 2-3; C2 | I/O observation outranks capacity tail and child deferral only for this typed result | Tick policy preserves I/O, deferral replaces primary/fallback I/O, or ordinary paths break | Exported recovery-policy table plus primary/fallback I/O with valid deferral files; source assertion that tick consumes the policy | I/O is not preserved, direct result survives both overrides, and ordinary paths remain unchanged |
| V3 | Goals 1 and 4; C3 | Shared behavior is correct for Spec, Dev, QA, and Ship and cannot cross epochs | One stage is omitted or an old result closes a newer owner | Table-driven claim lifecycle across every `SWEEP_CFG` entry plus competing declaration | Every exact old epoch closes; every foreign/new epoch remains untouched |
| V4 | Goal 5; C4 | Genuine silent/evidence-failure semantics remain honest | Silent card becomes unreapable, successful persistence duplicates, or failure is asserted exactly once | Reaper/evidence fixtures for success/rejection plus source trace to the existing tick failure catch | Successful record count is one; append failure rejects and existing caller records red without an exactly-once assertion |
| V5 | Goal 6 | Scope, docs, versioning, and existing gates remain bounded | Learning evaluator, detector, skill, config, or sibling repo changes; release markers drift | Focused tests, full suite, selective diff, text assertions, and version equality | At least 673 tests pass; only seven planned files change; all three version values match |

## Performance contract

`Performance contract: performance-contract/v1 — not required` because the
runtime change is one closed-enum check before an existing bounded 16 KiB log
scan and one existing reconciliation branch; it adds no I/O, pagination,
payload, retry, storage, fan-out, or user-visible latency.

## Security review surface

The card carries `security` because claim comments and declarations control
scheduler authority. The design adds no credential, authentication, or new
external-input surface. Security review must prove:

- result kinds are a closed local enum, not card/comment/model input;
- `LOG_WRITE_FAILED` marker content is locally constructed and sanitized, never
  raw stdout/stderr;
- exact declaration authority still comes from complete Linear history;
- partial log text cannot elevate itself into recovery authority for an I/O
  result;
- child outcome files cannot replace direct primary/fallback I/O failure, while
  their existing non-I/O validation and deferral authority remain unchanged;
- unknown results and incomplete ownership fail closed; and
- no new field reaches shell execution, prompts, or credential sinks.

Residual trusted-operator/Linear and local-run-index risks remain unchanged.

## Review depth decision

| Dimension | Decision |
| --- | --- |
| Predicted footprint | Seven files: launcher, launcher tests, README, operator rules, CHANGELOG, VERSION, and `.sweep-version`; about 90-160 changed lines |
| Behavior/state | Shared terminal cleanup and capacity/recovery precedence change; immutable claim/comments remain the state model |
| Interfaces/dependencies | No public API/CLI/SDK, dependency, schema, service, config, or new marker grammar |
| Failure/rollout | Competing epochs, partial logs, cleanup failure, genuine silent work, evidence persistence failure, and patch distribution |
| Material risks | Concurrency/ownership and scheduler-control provenance require Tier 2 even with a small diff |
| Initial/final tier | Tier 2 — Material |
| Selected reviews | Spec and plan engineering passes; independent adversarial reviews; security design and completed-plan reviews |

## Specialized lens decisions

| Lens | Decision and rationale |
| --- | --- |
| Security | Run: exact claim authority and partial log evidence control scheduler state |
| Performance | Skip separate benchmark: no material performance surface; existing scan bound is unchanged |
| UI/design | Skip: no interaction, hierarchy, accessibility, responsive behavior, or user flow |
| API/CLI/SDK devex | Skip: no public developer interface or adoption/compatibility flow |
| Research | Skip: no unfamiliar integration; code, run evidence, and Linear metadata are sufficient |

## Pre-plan engineering review decisions

The unattended review auto-adopted the recommended option in each brief.

### D1 — Keep outcome evaluation out of this implementation

ELI10: “five crashes” does not tell us how many jobs ran before the fix, and one
machine cannot prove every other machine uploaded its records. Inventing five
quiet jobs as a denominator would make a neat status but weak evidence.

**A) Preserve the fixed count and document its limit (recommended).
Completeness: 10/10 for COD-289.** Fix the reachable lifecycle defect and keep
the existing metric unchanged. A future evaluator design needs persisted
opportunity and host-completeness contracts first.

**B) Use baseline failure count as exposure. Completeness: 4/10.** It prevents
empty-window verification but compares failures to opportunities and can count
the wrong work.

**C) Extend the window until exposure appears. Completeness: 5/10.** The current
evaluator makes inconclusive terminal, and an extension needs a bounded policy,
late-index semantics, and new recurrence rules.

Net: adopt A; honest bounded scope beats an invented measurement proof.

### D2 — Give typed terminal I/O precedence over secondary classifiers

ELI10: a broken log can contain “quota” before it stops accepting writes. That
partial text should not keep the busy sign up after the launcher directly saw
the logging failure and worker stop; a child deferral file written during the
same shutdown must not replace that direct result either.

**A) Preserve `dispatch-io-error` before capacity and deferral classification
(recommended). Completeness: 10/10.** It is explicit, testable on primary and
fallback attempts, and preserves ordinary quota/capacity/deferral behavior.

**B) Let secondary evidence override I/O. Completeness: 5/10.** It preserves
the current bypasses, suppresses terminal evidence, and can later manufacture
stale evidence.

Net: adopt A.

### D3 — Apply the shared predicate to every configured stage

ELI10: the same launcher function handles four workflow columns. Fixing only Dev
would leave the identical side door open in Spec, QA, and Ship.

**A) All configured stages (recommended). Completeness: 10/10.** Reuse the
shared implementation and prove every claim label with a table fixture.

**B) Gate to Dev only. Completeness: 6/10.** Matches the historical detector
cluster but duplicates stage logic and leaves reachable false-stale paths.

Net: adopt A.

## Acceptance criteria

1. `dispatch-io-error` uses the existing declaration-bound terminal cooldown
   cleanup for Spec, Dev, QA, and Ship; no wildcard result classification exists.
2. Capacity-like partial log text cannot retain an I/O-failed claim, while
   ordinary exit capacity and provider-exhaustion recovery remain unchanged.
3. A valid child deferral file cannot replace primary or fallback I/O failure;
   every non-I/O dependency/repository deferral remains unchanged.
4. Retry marker -> exact close -> label removal ordering and unrelated-label
   preservation remain intact; competing epochs and incomplete history fail
   closed.
5. Successfully cleaned observed I/O results produce dispatch failure/operator
   evidence but no confirmed reap/stale observation.
6. Silent/frozen work remains reapable. A successfully persisted confirmed reap
   produces one stale observation; evidence persistence failure is red and is
   not misrepresented as exactly-once storage.
7. No learning evaluator/detector, claim grammar, skill, config, dependency,
   route, QA, Signoff, or human Ship behavior changes.
8. README, `docs/linear-rules.md`, CHANGELOG, VERSION, and `.sweep-version`
   agree on the patch without claiming historical causation.
9. At least the 673-test baseline passes, and the selective implementation diff
   contains only the seven planned files.
10. COD-289 proceeds through QA -> Signoff -> human Ship and never fast-paths.

## Rollout and measurement

Dev implements in this repo and reports V1-V5 against one pushed SHA. QA checks
the exact lifecycle fixtures and release truth, adds `qa:passed`, and moves the
generated card to Signoff. A human moves it to Ship. Ship merges/pushes main;
there is no production app canary. Any external publishing action is attended
or represented by a linked Todo.

Rollback reverts the terminal-kind and capacity-precedence changes together.
No comments, labels, run records, or schema need migration. After Done, Factory
Learning evaluates COD-289's original seven-day fixed count. Zero matching
events is reported under the existing contract as a quiet-window operational
signal, with the causal and cross-host limitations stated above.

# COD-289 Observed Terminal I/O Claim Reliability Implementation Plan

> **For Dev:** Use test-driven development. Keep this surgical: extend the
> existing closed terminal result set, close its capacity-precedence bypass, and
> reuse the immutable claim cleanup. Do not add another claim or evidence model.

**Goal:** Close and cool down exact claims after an observed
`dispatch-io-error` in every scheduled stage, without letting partial capacity
text retain the ended claim or weakening genuine silent-crash evidence.

**Architecture:** `dispatchAsync()` keeps producing its existing typed I/O
result. One pure closed predicate admits that result to
`releaseFailedDispatchClaim()`. `classifyCapacityOutcome()` rejects that typed
result before scanning a partial log tail, and `dispatchAsync()` preserves the
direct I/O result before reading primary/fallback child deferral files. All mutation ordering, immutable
claim authority, retry grammar, recovery stores, reaper behavior, and Factory
Learning evaluation remain unchanged.

**Tech stack:** Node.js ESM, built-in `node:test`, Linear GraphQL coordination
comments, Markdown operator/release docs.

## Repo scope

- Owning repo: `linear-board-sweeps` only.
- Branch names include `COD-289`.
- No sibling repo, schema, migration, service, production app deploy, or canary.
- Shipping is merge/push to main. Any external publication is attended or a
  linked Todo.
- The `factory:learning-generated` label stays. QA must add `qa:passed`, move to
  Signoff, and wait for a human Ship move. Fast path is forbidden.

## Contract declarations

- `Scope closure: scope-closure/v1 — required` — shared launcher lifecycle,
  recovery precedence, docs, release, and measurement truth change.
- `Correctness contract: correctness-contract/v1 — required` — C1-C4 from the
  spec map exactly once below.
- `Verification contract: verification-contract/v1 — required` — V1-V5 from
  the spec have executable RED/GREEN and QA evidence below.
- `Performance contract: performance-contract/v1 — not required` — one enum
  check precedes the unchanged bounded 16 KiB log scan; no new I/O or workload.

## Versioned contract boundary decision

`Versioned contract boundary: versioned-contract-boundary/v1`

COD-289's spec and plan are new post-boundary artifacts and carry every
installed contract. Spec-sweep will replace the landing evidence below with the
exact first-add commit before Dev transition:

- Artifact first introduced: pending Spec-sweep landing commit.
- Installed marker first-add commit: `bd467095a1ddb2451aa5271bbef9e876491a5bde`.
- Required proof: `git merge-base --is-ancestor <marker> <artifact-commit>` exits
  0 for both artifacts.

Dev complete-reads the final values. Missing, shallow, divergent, or
incomparable history fails closed to Spec; no contract-specific legacy rule may
replace this shared decision.

## Scope closure traceability

| Scope ID | Implementing task(s) | Files/modules | Test or assertion | Rollout/owner evidence | Residual risk |
| --- | --- | --- | --- | --- | --- |
| S1 | Task 1 | `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs` | V1 plus all-stage V3 table | Tested SHA and focused output | Future typed outcomes still require explicit classification |
| S2 | Task 1 | same launcher/test files | V2 mixed partial-log and primary/fallback deferral cases | Security/code review evidence | Capacity regex and structured deferral authority remain for non-I/O results |
| S3 | Task 2 | launcher lifecycle and tests | V3-V4 exact owner/reaper/evidence rows | QA cites final claim/evidence assertions | Linear full-label update has no CAS; existing reread/post-proof remains authoritative |
| S4 | Task 3 | README, `docs/linear-rules.md`, CHANGELOG | V5 text and version assertions | Patch release commit | Docs cannot prove historical cause and must not claim it |
| S5 | Tasks 3-4 | VERSION, `.claude/skills/.sweep-version`, repo/board handoff | V5 full suite, equality, selective diff | QA -> Signoff -> human Ship; Todo for attended publication | Concurrent release requires rebase and next unused version |
| S6 | Task 4 and QA | selective diff and card handoff | Assert no learning evaluator/detector diff; preserve metric metadata | Fixed-window interpretation recorded on COD-289 | Local quiet-window count is not causal or cross-host exposure proof |

Reverse check: every task maps to at least one S row, and every S row has a
configured owner and falsifiable proof. No task assigns sibling-repo work.

## Correctness traceability

| C ID | V ID | Implementing task(s) | Exact proof | QA evidence | Residual risk |
| --- | --- | --- | --- | --- | --- |
| C1 | V1 | Task 1 | I/O result enters exact terminal cleanup once with `LOG_WRITE_FAILED` | Focused test name/output at tested SHA | Cleanup failure intentionally leaves the safe reaper fallback |
| C2 | V2 | Task 1 | Exported recovery policy does not preserve I/O; direct result survives capacity text and primary/fallback deferral files; ordinary controls retain outcomes | Policy/precedence table | Partial logs/files remain evidence/authority for non-I/O outcomes only |
| C3 | V3 | Task 2 | Four-stage exact-owner table plus competing epoch and unrelated-label assertions | Final label/history snapshots | Non-atomic Linear label API is unchanged |
| C4 | V4 | Task 2 | Silent work remains reapable; evidence success stores one, append failure is red and may store zero | Reaper/evidence result table | No durable outbox or exactly-once guarantee is added |

Every C ID appears in exactly one V mapping. V5 owns delivery/release regression
proof without duplicating an invariant.

## Verification traceability

| ID | Implementing task(s) | Test layer and file | Red signal | Green command / assertion | QA evidence | Residual gap |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | Task 1 | Unit/integration, `tests/linear-watch.test.mjs` | I/O result is `attempted:false` and exact claim remains | Focused command returns terminal cooldown, marker detail, and exact label result | Tested SHA, test name, ordering assertions | A failed Linear mutation remains a later reaper case |
| V2 | Task 1 | Unit/integration, `tests/linear-watch.test.mjs` | Recovery policy preserves I/O or child deferral replaces primary/fallback I/O | Exported policy returns preserve false; both attempts retain I/O; production consumes policy; ordinary controls keep outcomes | Policy/precedence table and non-I/O controls | Secondary classifiers remain authoritative for non-I/O results |
| V3 | Task 2 | Integration, `tests/linear-watch.test.mjs` | A stage is omitted, unrelated label is lost, or old result mutates new epoch | Every SWEEP_CFG claim closes only its own epoch; foreign epoch remains | Four-stage result table and label snapshots | Production Linear races rely on existing post-write proof |
| V4 | Task 2 | Unit/integration, `tests/linear-watch.test.mjs` | Silent work is no longer reaped, evidence duplicates, or append failure is called exactly-once success | Success stores one observation; append failure rejects; caller source trace retains existing red reap-failure handling | Reaper/evidence fixture and caller trace | Local append failure can leave zero stored observation |
| V5 | Tasks 3-4 | Repository suite and selective diff | Docs/version drift, unrelated subsystem diff, or test regression | At least 673 tests pass; seven-file diff only; three version values equal | Full-suite summary, diff stat, release metadata | Concurrent main requires rebase and rerun |

## Dependency graph

```text
Task 1: terminal + capacity RED/GREEN
        |
        v
Task 2: all-stage lifecycle/evidence matrix
        |
        v
Task 3: operator docs + patch markers
        |
        v
Task 4: full verification + handoff
```

Keep implementation sequential. Tasks 1-2 overlap the same production helper
and test fixtures; Task 3 documents tested behavior; Task 4 consumes all prior
evidence.

## Task 1: Close the terminal classification and capacity-precedence gaps

**Files:**

- Modify: `scripts/linear-watch.mjs:2463-2468,5651-5682,6707-6711,6749`
- Test: `tests/linear-watch.test.mjs` near capacity classification, terminal
  reconciliation, and I/O dispatch tests

**Interfaces:**

- Produces: `isObservedTerminalFailure(result) -> boolean` (name may vary;
  closed behavior may not).
- Produces: `dispatchClaimRecoveryPolicy(result, options) -> { capacityKind,
  preserveTerminalClaim }` (name may vary); the real tick reconciliation closure
  consumes both fields.
- Consumes unchanged: `releaseFailedDispatchClaim()`, the existing
  `dispatch-io-error` shape, and `preserveTerminalClaim` for ordinary results.

- [ ] **Step 1: Write failing terminal reconciliation tests**

Pass an exact result:

```js
{
  kind: "dispatch-io-error",
  code: "LOG_WRITE_FAILED",
  pick: {
    sweep: "dev",
    issueId: "issue-289",
    issueIdentifier: "COD-289",
    ownerToken: "owner-289",
    claimDeclarationId: "decl-289",
  },
}
```

Assert `releaseFailedDispatchClaimFn` receives it exactly once and the return is
`{ attempted: true, released: true, reasonKind: "terminal failure cooldown" }`.
An arbitrary `future-unknown` result must remain `attempted:false`.

- [ ] **Step 2: Write failing capacity-precedence tests**

Table cases:

```text
dispatch-io-error + "429 quota"                  -> null
dispatch-io-error + "model overloaded"           -> null
exit + "429 quota"                               -> quota
exit + "model overloaded"                       -> model-capacity
success/dependency/repository deferral + any tail -> null (existing)
```

Add a pure recovery-policy table proving the I/O case returns
`preserveTerminalClaim:false` even when earlier partial log content is
capacity-like. Add a source/behavior assertion that the production tick closure
uses the helper's `capacityKind` and `preserveTerminalClaim` fields rather than
recomputing either decision inline.

Add two dispatch fixtures with a valid matching dependency/repository deferral
file plus an I/O failure: one on the primary attempt and one on the configured
fallback attempt. Both must return `dispatch-io-error`; equivalent non-I/O
attempts must retain the current deferral outcome.

- [ ] **Step 3: Run RED**

```bash
node --test --test-name-pattern='dispatch-io-error|capacity.*outcome|reconcileOwnedDispatchClaim' tests/linear-watch.test.mjs
```

Expected: I/O reconciliation and capacity-precedence cases fail on main;
ordinary exit controls pass.

- [ ] **Step 4: Implement the smallest closed changes**

1. Extract the `exit`/`signal` terminal check and add only
   `dispatch-io-error`.
2. At the top of `classifyCapacityOutcome()`, return `null` for
   `dispatch-io-error` before scanning the bounded tail.
3. Before each primary/fallback `childDeferredOutcomeForPick()` call, preserve
   `dispatch-io-error`; for every other result keep the existing deferral
   precedence.
4. Extract the tick closure's capacity/preserve decision into the exported pure
   recovery-policy helper and have production consume both returned fields.

Do not change result construction, deferral schema, regexes, recovery stores, marker grammar,
claim ownership, or mutation ordering.

- [ ] **Step 5: Run GREEN and inspect**

```bash
node --test --test-name-pattern='dispatch-io-error|capacity.*outcome|reconcileOwnedDispatchClaim|releaseFailedDispatchClaim|preserves exact claims' tests/linear-watch.test.mjs
git diff --check
git diff -- scripts/linear-watch.mjs tests/linear-watch.test.mjs
```

Expected: focused tests pass and production changes are limited to the closed
terminal/secondary-precedence decisions and their one production policy seam.

## Task 2: Prove shared-stage immutable claim and honest reaper behavior

**Files:**

- Modify: `tests/linear-watch.test.mjs` near terminal cleanup, claim ownership,
  and confirmed reaper evidence tests
- Production: no additional change unless a directly specified C1-C4 invariant
  fails; the Task 1 recovery-policy seam is the only planned orchestration
  extraction

- [ ] **Step 1: Add the all-stage terminal matrix**

For `spec`, `dev`, `qa`, and `ship`, construct the configured claim declaration,
heartbeat, unrelated domain label, I/O result, retry marker, close, and final
snapshot. Assert:

- exact retry marker precedes close;
- verified close precedes label removal;
- only the configured stage claim disappears;
- unrelated labels remain;
- the card is not a reaper candidate afterward; and
- dispatch failure/operator evidence remains eligible.

- [ ] **Step 2: Add ownership/failure negative rows**

Cover competing/new declaration, latest-owner mismatch, retry-comment failure,
close-verification failure, and label-edit failure. No old result may mutate a
new epoch. A failed safe cleanup may remain claimed and later reach the reaper.

- [ ] **Step 3: Preserve ordinary recovery and unknown kinds**

Keep the existing provider/capacity retention test for ordinary `exit`, and add
an explicit unknown-kind no-mutation assertion. This proves the new predicate is
closed.

- [ ] **Step 4: Test honest silent/evidence outcomes**

Add or extend fixtures so:

- silent/frozen exact work after stale threshold remains a confirmed reap;
- successful local evidence persistence yields one `dev|claim-reaper`
  observation and no duplicate on the now-unlabeled card; and
- an injected append failure makes `recordConfirmedReapEvidence()` reject after
  label removal without asserting one stored observation; source review traces
  that rejection to the existing tick `recordFailure("reap", ...)` catch.

- [ ] **Step 5: Run the lifecycle suite**

```bash
node --test --test-name-pattern='claim lifecycle|dispatch-io-error|silent|reap|retry|claim close|capacity' tests/linear-watch.test.mjs
```

Expected: all rows pass. Do not add an outbox, evaluator change, or broader
reaper refactor to satisfy these tests.

## Task 3: Update operator truth and patch release markers

**Files:**

- Modify: `README.md:83-101`
- Modify: `docs/linear-rules.md:55-70`
- Modify: `CHANGELOG.md`
- Modify: `VERSION`
- Modify: `.claude/skills/.sweep-version`

- [ ] **Step 1: Reconcile main before choosing the version**

Fetch/rebase after runtime tests are green. Read the newest origin VERSION and
CHANGELOG, then select the next unused patch. Never overwrite a concurrent
release marker.

- [ ] **Step 2: Update architecture/operator text**

State that observed nonzero exit, OS signal, and typed log-I/O termination use
declaration-bound cleanup; I/O wins over partial capacity text; ordinary
capacity recovery remains; silent/frozen work stays on the reaper path. Do not
say the historical five events were I/O failures.

- [ ] **Step 3: Update release markers and notes**

Keep VERSION, the newest CHANGELOG heading, and `.sweep-version` byte-equivalent
after trimming their newline. The CHANGELOG names the reachable lifecycle gap
and precedence fix, not an unproved root cause.

- [ ] **Step 4: Run documentation/release assertions**

```bash
test "$(head -1 VERSION)" = "$(cat .claude/skills/.sweep-version)"
test "$(head -1 VERSION)" = "$(sed -n 's/^## \[\([^]]*\)\].*/\1/p' CHANGELOG.md | head -1)"
rg -n 'I/O|dispatch-io-error|silent|capacity' README.md docs/linear-rules.md CHANGELOG.md
```

Expected: all values/text agree and no production app deploy is claimed.

## Task 4: Full verification, security review, and QA handoff

**Files:** only the seven planned files.

- [ ] **Step 1: Run focused and full suites**

```bash
node --test tests/linear-watch.test.mjs
node --test tests/*.test.mjs
```

Expected: at least the 673-test baseline passes with zero failures.

- [ ] **Step 2: Verify scope and contract exclusions**

```bash
git diff --check
git status --short
git diff --stat
git diff -- scripts/linear-watch.mjs tests/linear-watch.test.mjs README.md docs/linear-rules.md CHANGELOG.md VERSION .claude/skills/.sweep-version
git diff --exit-code -- scripts/learning.mjs tests/learning.test.mjs scripts/claim-ownership.mjs skills .claude/skills/spec-sweep .claude/skills/dev-sweep .claude/skills/qa-sweep .claude/skills/ship-sweep .claude/skills/unblock-sweep .claude/linear-sweep.json
```

Expected: only the seven planned files change; learning evaluation/detectors,
claim grammar, skills, and config are untouched.

- [ ] **Step 3: Run required reviews**

Normal code review plus an independent reviewer must challenge closed result
classification, I/O/capacity precedence, every stage claim, exact declaration
authority, locally constructed marker content, competing epochs, cleanup
failure, and honest reaper evidence. Emit every verified finding through the
existing structured review event path.

- [ ] **Step 4: Push the tested branch and prepare the handoff comment**

Record tested SHA, V1-V5 results, full-suite baseline comparison, security
review, seven-file diff, version equality, and fixed-window metric
interpretation on COD-289. QA may add `qa:passed` only after the evidence is
complete, then moves to Signoff for human Ship approval.

- [ ] **Step 5: Perform the guarded Dev -> QA terminal transition**

After the push and handoff comment, complete-read COD-289 and prove it is still
in Dev with this run's exact `dev:in-progress` owner/declaration, no blocking or
foreign claim, and the pushed reviewed SHA. Emit the required terminal learning
event once, then run:

```bash
node scripts/linear.mjs move-card-bottom-if-current COD-289 Dev QA dev:in-progress "$AUTO_SWEEP_OWNER_TOKEN" "$AUTO_SWEEP_CLAIM_DECLARATION"
```

The guarded helper posts/verifies the exact claim close before removing the
claim and moving to the bottom of QA. Re-read and verify QA, no
`dev:in-progress`, retained `factory:learning-generated` and `security`, and no
fast-path label. Never use an unguarded move plus a separate label removal.

## Failure-mode verification

| Failure | Proof / handling | Operator result |
| --- | --- | --- |
| I/O result omitted from terminal cleanup | V1 RED/GREEN | Exact epoch closes after observed termination |
| Partial log includes quota/overload | V2 | I/O cleanup wins; ordinary exit recovery unchanged |
| Valid child deferral exists after I/O failure | V2 primary/fallback fixtures | Direct I/O survives; ordinary non-I/O deferral unchanged |
| One stage omitted | V3 four-stage table | Spec/Dev/QA/Ship all use their configured exact claim |
| Competing epoch appears | V3 owner fixture | Old result cannot close or remove the new owner |
| Retry/close/label mutation cannot be proven | V3 fail-closed rows | Safe boundary remains; failure visible; reaper may recover |
| Child silently freezes | V4 | Existing confirmed reaper path remains |
| Evidence append fails after label removal | V4 helper rejection plus caller trace | Tick red; zero stored observation allowed; no durability fiction |
| Unknown result appears | V3 control | No inferred mutation |
| Concurrent patch lands | Task 3 fetch/rebase/version check | Select next unused marker and rerun proof |
| External publishing unavailable | Repo policy | Attended owner action/Todo; no fake completion |

## Spec-sweep review audit

| Item | Decision / current outcome |
| --- | --- |
| Initial/final tier | Tier 2 — Material; shared immutable-claim concurrency is a mandatory floor |
| Predicted footprint | Seven files, about 90-160 changed lines |
| Risk surfaces | Closed terminal type, partial-log/child-deferral precedence, exact owner/epoch, shared stages, evidence persistence truth, release markers |
| Scope closure | `scope-closure/v1 — required`; S1-S6 mapped above |
| Correctness | `correctness-contract/v1 — required`; C1-C4 mapped once |
| Verification | `verification-contract/v1 — required`; V1-V5 executable above |
| Performance | `performance-contract/v1 — not required`; existing 16 KiB scan bound unchanged |
| Spec engineering pass | Clear after narrowing evaluator scope, adding secondary-classifier precedence, all-stage impact, honest evidence semantics, operator docs, and version marker |
| Independent spec review | Current-runtime fallback: configured Claude CLI lacked authentication; eight material findings traced and reconciled |
| Security design/plan review | Clear after removing forgeable exposure authority and giving direct I/O precedence over capacity and primary/fallback child deferrals |
| Plan engineering pass | Clear after adding the production recovery-policy seam, narrowing evidence-failure proof to executable seams, and specifying the guarded Dev -> QA transition |
| Independent plan review | Clear on a fresh current-runtime reread after all corrections |
| UI/design lens | Skipped: no UI/interaction surface |
| API/CLI/SDK devex lens | Skipped: no public developer interface |
| Research lens | Skipped: no unfamiliar external integration |

## Completed-plan review-depth reassessment

- **Footprint:** one existing runtime module, one test module, two operator docs,
  CHANGELOG, VERSION, and installed marker; no new module or dependency.
- **Dependency graph:** terminal/precedence behavior precedes shared lifecycle
  proof; docs/version then describe tested behavior; final suite closes delivery.
- **Interfaces:** internal typed result, capacity classifier, immutable claim
  cleanup, existing reaper evidence, and kit version marker.
- **Failure handling:** partial logs, unknown types, competing epochs, mutation
  failure, silent work, evidence append failure, and release collision each have
  a proof or existing owner path.
- **Final tier:** Tier 2 retained because concurrency and scheduler-control
  authority remain material despite the small implementation.
- **Specialized lenses:** security runs; performance, UI, devex, and research
  remain skipped for the recorded material reasons.

## Plan engineering review decisions

The unattended review auto-adopts the smallest complete choices already fixed
by the spec:

1. Keep one shared closed terminal predicate rather than stage-specific
   branches. Completeness: 10/10.
2. Give direct I/O precedence before capacity-tail and child-deferral parsing
   rather than special-case recovery later. Completeness: 10/10.
3. Preserve the current evidence append semantics and test them honestly rather
   than introduce a durable outbox. Completeness: 10/10 for this card.
4. Keep Factory Learning evaluator code out of the diff until opportunity and
   host-completeness contracts exist. Completeness: 10/10 for this card.

## Plan self-review

- Every goal and acceptance criterion maps to S, C, and V identities.
- Every production change has a RED signal that fails on current main.
- The plan reuses current cleanup, ownership, retry, reaper, and release paths.
- No owner decision, threshold, sibling repo, deployment target, or historical
  causal claim is deferred. The exact post-landing artifact hash is the only
  evidence Spec-sweep must fill before Dev transition.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| CEO Review | `/plan-ceo-review` | Scope/strategy | 0 | Skipped | Not part of spec-sweep; generated reliability objective is fixed |
| Independent Review | configured role, current-runtime fallback | Adversarial premise/execution challenge | 3 | CLEAR | Eight spec and two plan findings corrected; final fresh reread clear |
| Eng Review | `/plan-eng-review` | Architecture, tests, failure modes | 2 | CLEAR | Spec and completed-plan passes reconciled scope, seams, proofs, and terminal handoff |
| Design Review | `/plan-design-review` | UI/UX | 0 | Skipped | No UI or interaction surface |
| DX Review | `/plan-devex-review` | Public developer experience | 0 | Skipped | No public API, CLI, or SDK |
| Security Review | `/cso` | Scheduler-control trust/authority | 3 | CLEAR | Capacity, forgeable exposure, and child-deferral overrides corrected; final reread clear |

**CROSS-MODEL:** The configured Claude reviewer could not run because the local
Claude CLI had no authenticated session. Independent passes used fresh
current-runtime reviewers and this limitation is recorded for the handoff.

**VERDICT:** ENG + INDEPENDENT + SECURITY CLEARED — READY FOR DEV

NO UNRESOLVED DECISIONS

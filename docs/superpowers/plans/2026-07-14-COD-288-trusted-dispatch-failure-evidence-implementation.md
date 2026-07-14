# COD-288 Trusted Dispatch Failure Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: invoke the installed Andrej
> Karpathy coding skill before changing code, then use
> `test-driven-development` and `executing-plans` (or
> `subagent-driven-development`) task by task. Read the linked design first.

**Goal:** Stop successful child safety outcomes from becoming launcher reliability
failures, admit only trusted start/I/O/exit/signal failures to
`repeated-dispatch-failure/v2`, and evaluate COD-288's legacy acceptance window
without false success from missing traffic.

**Architecture:** Keep child terminal events as non-authoritative workflow audit.
Inside the parent launcher, derive a systemic hashed learning key from stable
route/runtime/outcome fields, filter operational failures through a narrower
learning-admission policy, and append one bounded evidence record independently
of Failure Todo mutations. The learning snapshot projects those records to the
v2 detector. The evaluator reads healthy exposure from existing successful
delivery run records and treats legacy `terminal:failed` as measurement-only;
new cause-specific roots retain existing recurrence mechanics.

**Tech stack:** Node.js ESM, zero-dependency launcher, `node:test`, append-only
JSONL learning evidence, Markdown operator docs, git-based kit updater.

**Design:**
`docs/superpowers/specs/2026-07-14-COD-288-trusted-dispatch-failure-evidence-design.md`

## Global constraints

- Own changes only in configured repo `linear-board-sweeps`; SafeTaper workspaces
  are evidence contributors, not implementation targets.
- Keep `LEARNING_EVENT_VERSION = 1`; child event taxonomy and serialized event
  schema do not change.
- Do not change `failureFingerprint`, Failure Todo dedupe/throttling, claim
  release, retry/resume, cooldown, capacity, provider fallback, dependency, or
  repository-routing policy.
- Child `terminal/failed`, `repo-routing-deferred`, and interruption may retain
  existing operational behavior but never enter dispatch-failure learning.
- Do not parse logs, comments, or child prose into reliability identity.
- Do not persist a second exposure record for successful runs or consume the
  bounded observation budget; read normalized run records in the evaluator.
- Only `repeated-dispatch-failure` defaults to detector v2. Unrelated detectors
  remain v1.
- Legacy COD-288 is measurement-only after migration. A corrected v2 cause
  starts its own generation-zero lineage; recurrence remains exact-root within
  that v2 lineage.
- COD-288 is `factory:learning-generated`: full QA, Signoff, and human Ship are
  mandatory. Never add `fast-path:eligible` or auto-ship behavior.
- No production app deploy exists. Release is merge/push to `main`; external
  publishing remains attended owner work.

## Repo scope

- **Owning repo:** `linear-board-sweeps`.
- **Expected branch:** one Dev branch containing `COD-288` in its name.
- **Runtime targets:** launcher and deterministic Factory Learning runner only.
- **Deploy target:** none; the existing VERSION-triggered updater distributes the
  merged kit.
- **Predicted implementation files:** `scripts/learning.mjs`,
  `scripts/linear-watch.mjs`, `tests/learning.test.mjs`,
  `tests/linear-watch.test.mjs`, `README.md`, `CHANGELOG.md`, and `VERSION`.
- **Artifact scope:** this design and plan are docs-only Spec artifacts and do not
  add implementation files beyond the seven above.

## What already exists

| Existing mechanism | Reuse decision |
| --- | --- |
| `classifyDispatchOutcome` in `scripts/linear-watch.mjs:6259-6278` | Reuse typed start, I/O, exit, signal, success, and interruption outcomes. |
| Failure construction in `scripts/linear-watch.mjs:6899-6931` | Leave operational Failure Todo inputs unchanged; add a narrower learning decision afterward. |
| Launcher evidence helpers in `scripts/linear-watch.mjs:6347-6436` | Reuse bounded JSONL persistence with the original dispatch card and repo route. |
| Event/evidence projection in `scripts/learning.mjs:210-238,327-391` | Add one launcher evidence type and remove only the terminal-to-dispatch projection. |
| Detector definitions in `scripts/learning.mjs:805-941` | Make version declarative per detector; retain existing thresholds. |
| Outcome evaluation in `scripts/learning.mjs:1368-1455` | Add exact legacy-key scope and per-contributor successful-run/failure exposure. |
| Root/recurrence planning in `scripts/learning.mjs:1016-1043,1265-1350` | Preserve exact-root mechanics; prove legacy and cause-specific v2 roots stay separate. |
| Existing test suites | Extend focused learning/watcher fixtures; retain full-suite verification. |

## NOT in scope

- Changing child terminal cardinality or throughput's last-terminal behavior.
- Treating repository route drift or parent cancellation as a learning dispatch
  failure.
- Merging legacy and v2 recurrence lineages.
- Rewriting historical run records, learning events, findings, or Linear cards.
- New database/schema, package, service, CLI command, endpoint, dependency, or
  distribution channel.
- Changes to sweep skills, review labels, workflow states, or deploy behavior.

## Scope closure traceability

| Scope ID | Tasks | Files/modules | Executable proof | Rollout/owner evidence | Residual risk |
| --- | --- | --- | --- | --- | --- |
| `S1` | Task 1 | learning projection + tests | Successful run plus child failed terminal yields no dispatch observation/finding. | Focused/full suites | Terminal remains available to unrelated audit/productivity paths. |
| `S2` | Task 2 | watcher admission/persistence + tests | Admission table, systemic key, Todo-independent append, append-throw continuation, original route. | Dev review checks call order before claim/Todo blocks. | Filesystem failure can lose one observation but cannot alter claims. |
| `S3` | Tasks 1, 3 | learning normalization/evaluator + tests | Typed failure projection and successful-run exposure without added observation. | Dry-run snapshot inspection | Retained caps can still make evaluation inconclusive. |
| `S4` | Task 1 | detector registry + tests | Dispatch detector defaults v2; other versions/thresholds unchanged. | Finding provenance inspection | Config override remains supported. |
| `S5` | Task 3 | evaluator + tests | Legacy key sees corrected failures; zero requires all contributor exposure; v2 stays cause-specific. | `learning-run --dry-run` | A quiet contributor correctly delays zero verdict. |
| `S6` | Task 3 | root/mutation/evaluator tests | Legacy measurement-only; v2 generation zero and same-root recurrence/cap remain. | Factory label/state assertions | Legacy card is not a v2 recurrence parent. |
| `S7` | Task 4 | README/CHANGELOG/VERSION | Unique version, docs, full suite, clean one-repo diff. | QA -> Signoff -> human Ship | Updater timing is outside merge. |

## Verification traceability

| Verification ID | Task | Executable proof |
| --- | --- | --- |
| `V1` | Task 1 | Terminal failed plus successful launcher run yields no dispatch observation. |
| `V2` | Tasks 2, 3 | Key/admission tests and production-shaped run without `outcome.success`. |
| `V3` | Tasks 2, 3 | Capacity/provider/dependency/routing/interruption/maintenance/learning negatives. |
| `V4` | Task 1 | Same-key threshold and different-key non-aggregation tests. |
| `V5` | Task 1 | Detector registry version assertions. |
| `V6` | Task 3 | Legacy corrected failure, incomplete coverage, zero/partial exposure tests. |
| `V7` | Task 3 | Every contributor exposed and corrected count zero verifies improvement. |
| `V8` | Task 3 | Legacy root does not recur from v2; same-root v2 recurrence remains capped. |
| `V9` | Task 4 | Focused suites, full suite, dry-run, docs/version/diff inspection. |

## Dependency graph

```text
Task 1: trusted projection + detector v2
        |
        v
Task 2: launcher admission + evidence persistence
        |
        v
Task 3: legacy outcome exposure + lineage compatibility
        |
        v
Task 4: production regression + docs/release/full verification
```

Tasks are sequential: Task 2 produces the evidence Task 1 projects, Task 3
evaluates the normalized result, and Task 4 freezes the combined behavior.

## Test coverage diagram

```text
classified result
  |-- success ------------------------> existing runRecords ----+
  |-- start/I/O/exit/signal failure -> learning admission ------+--> evaluator exposure
  |                                      |
  |                                      v
  |                               launcher evidence -> v2 same-cause detector
  |
  +-- capacity/provider/dependency/routing/interruption --X-- learning evidence

child terminal/failed -----------------------------------X-- dispatch reliability
```

Every solid arrow needs a positive assertion and every `X` a negative assertion.
The end-to-end fixture combines production run shape, detector, and evaluator.

### Task 1: Make dispatch evidence parent-authoritative and versioned

**Files:**

- Modify: `tests/learning.test.mjs:337-425,635-730,1110-1165`
- Modify: `scripts/learning.mjs:210-238,327-391,805-941`

**Interfaces:** consumes normalized runs, child events, and launcher evidence;
produces no child-derived dispatch failure, typed launcher failure observations,
and per-detector provenance.

- [ ] **Step 1: Write failing projection and detector tests.** Add fixtures that
  prove:

  1. `outcome: { kind: "success", exitCode: 0 }` plus `terminal/failed`
     produces no `dispatch-failure` observation;
  2. valid `launcherEvidence` type `dispatch-failure` produces one trusted
     observation whose fingerprint/rootCauseKey equal the bounded key;
  3. unknown type, malformed timestamp, and incomplete route cannot become a
     trusted detector observation and preserve coverage-gap behavior;
  4. two same-key observations inside 24 hours qualify, while two different
     keys do not aggregate; and
  5. only `repeated-dispatch-failure` defaults to v2; every other detector stays
     v1 and config override still works.

- [ ] **Step 2: Run the focused tests and observe red.**

```bash
node --test --test-name-pattern="dispatch failure|detector version|terminal failed" tests/learning.test.mjs
```

Expected: new assertions fail because terminal failures still project, launcher
dispatch evidence is unknown, and the default version is v1.

- [ ] **Step 3: Implement the minimum projection/version change.** In
  `scripts/learning.mjs`:

  1. add `dispatch-failure` to `LAUNCHER_EVIDENCE_TYPES` with no arbitrary state;
  2. project it in `launcherEvidenceObservation` to signal
     `dispatch-failure`, reusing sanitized key -> fingerprint/rootCauseKey;
  3. delete only the `terminal/failed` branch from `eventObservation`;
  4. let detector definitions declare an optional version, default `v1`; and
  5. declare only `repeated-dispatch-failure` v2 without changing signal,
     metric, threshold, window, or key function.

Do not change child taxonomy or `LEARNING_EVENT_VERSION`.

- [ ] **Step 4: Run focused and neighboring learning tests.**

```bash
node --test --test-name-pattern="dispatch failure|detector version|terminal failed|event taxonomy|launcher evidence" tests/learning.test.mjs
```

Expected: selected tests pass; unrelated taxonomy/evidence tests stay green.

- [ ] **Step 5: Commit the projection unit.**

```bash
git add scripts/learning.mjs tests/learning.test.mjs
git commit -m "fix(COD-288): trust launcher dispatch evidence"
```

### Task 2: Admit and persist only real launcher failures

**Files:**

- Modify: `tests/linear-watch.test.mjs:5517-5560,6611-6620,7310-7435`
- Modify: `scripts/linear-watch.mjs:1954-1968,6347-6436,6835-6971`

**Interfaces:** consumes reconciled result, operational FailureEvents, original
dispatch `pick`, and final runtime; produces zero or one route-trusted append per
admitted/deduplicated learning key and a local failure on append error.

- [ ] **Step 1: Write failing pure-key and admission tests.** Specify narrow
  exported helpers through tests:

  - `dispatchLearningKey(facts)` stays equal when only issue ID, worktree/log
    path, timestamp, or message changes;
  - it changes for workspace/project/repo, sweep, runtime/model, failure kind,
    outcome kind, code, exit code, or signal;
  - no raw path, issue ID, message, or provider string appears in the hash;
  - `dispatchLearningEvidenceDecision(...)` admits start, dispatch-I/O,
    non-zero exit, and signal failures;
  - it rejects success, dependency/routing deferral, capacity, final provider
    exhaustion, and interruption without mutating operational failures; and
  - append input uses bounded card identity
    `{ identifier: pick.issueIdentifier }`, `pick.sweep`, and
    `pick.repoRoute.repoEntry`, including a routed repo distinct from the anchor.
    Exercise `buildLauncherEvidenceRunRecord` itself so a missing
    `card.identifier` cannot hide behind a mocked append callback.

Use table-driven `classifyDispatchOutcome` cases for `dispatch-io-error`,
ENOENT/spawn error, exit 127, signal, interruption, routing, dependency, capacity,
provider exhaustion, and success.

- [ ] **Step 2: Write failing persistence/error-isolation tests.** Prove:

  1. separate results with the same key each append one occurrence even when a
     Todo-decision fixture is empty/throttled;
  2. duplicate FailureEvents inside one result append once;
  3. the real evidence builder accepts the bounded dispatch issue identity and
     original routed repo entry, producing a trusted record rather than a gap;
  4. an unprovable route writes the route-gap record, which cannot become a
     trusted observation; and
  5. an injected append throw records one local failure and resolves without
     throwing, allowing subsequent claim/Todo/retry callbacks; and
  6. a captured real JSONL append receives an arbitrary value from
     `active.envValues`, a standard token-shaped value, local path, and raw
     failure message; none appears in persisted bytes. Only typed bounded reason
     and pre-persistence sanitized generic summary fields are written.

- [ ] **Step 3: Run the watcher slice and observe red.**

```bash
node --test --test-name-pattern="dispatch learning|launcher evidence route|append.*failure" tests/linear-watch.test.mjs
```

Expected: helpers/imports are absent and new assertions fail.

- [ ] **Step 4: Implement learning identity and admission.**

  1. Keep `failureFingerprint` behavior unchanged.
  2. Hash only canonical route, sweep, final runtime/model, failure kind, and
     classified kind/code/exitCode/signal in `dispatchLearningKey`.
  3. Explicitly reject routing and interruption in addition to existing
     capacity/provider/dependency exclusions.
  4. Deduplicate only inside the current result by learning key.
  5. Build bounded type/key/stage/subsystem/reason/summary evidence. Persist only
     typed reason codes and a generic summary processed with
     `sanitizeFailureMessage(summary, active.envValues)` before append; never
     copy raw FailureEvent message, logs, child prose, paths, or secrets.

- [ ] **Step 5: Integrate direct, exception-isolated persistence.** Immediately
  after operational `failures` are computed, call the new wrapper with:

```text
card      = { identifier: result.pick.issueIdentifier }
sweep     = result.pick.sweep
repoEntry = result.pick.repoRoute.repoEntry, or configured default repo
```

Never call through `reconcileFailureTodos` or the anchor-source fallback in
`launcherEvidenceOptions`. Catch append errors, record a sanitized local
`learning-evidence-append` failure, and continue existing claim release and Todo
blocks without reordering/changing them.

- [ ] **Step 6: Run focused and neighboring watcher tests.**

```bash
node --test --test-name-pattern="dispatch learning|classifyDispatchOutcome|failureFingerprint|launcher evidence|failure Todo|claim release" tests/linear-watch.test.mjs
```

Expected: selected tests pass; operational Todo, interruption, routing, claim,
and retry behavior stays green.

- [ ] **Step 7: Commit the launcher unit.**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "fix(COD-288): record classified dispatch failures"
```

### Task 3: Make legacy outcome evaluation migration-safe

**Files:**

- Modify: `tests/learning.test.mjs:880-980,1110-1180,1240-1285`
- Modify: `scripts/learning.mjs:1368-1455`

**Interfaces:** consumes saved evaluation, observations, normalized run records,
and ownership contributors; produces corrected count, exposure verdict, and
explicit measurement-only legacy recurrence behavior.

- [ ] **Step 1: Write failing legacy compatibility/exposure tests.** Create an
  exact legacy fixture with detector `repeated-dispatch-failure`, signal
  `dispatch-failure`, semantic key `terminal:failed`, baseline 5, decrease target
  zero, and two contributors. Cover direct and embedded semantic contracts:

  1. owned v2 failures count although their keys differ from `terminal:failed`;
  2. any corrected failure evaluates even when another contributor lacks healthy
     exposure;
  3. zero with no/partial contributor exposure is `inconclusive-evidence`;
  4. zero with one production-shaped successful delivery run per contributor is
     `verified-improvement`; omit `outcome.success` intentionally and use
     `outcome: { kind: "success", exitCode: 0 }`;
  5. launcher runtime, learning sweep, non-zero exit, signal,
     dependency/routing deferral, interruption, capacity/provider, pre-completion
     time, foreign route, and incomplete coverage do not prove zero;
  6. new v2 semantic keys remain cause-specific; and
  7. unrelated detector evaluation is unchanged.

- [ ] **Step 2: Write failing lineage tests.** Prove:

  - legacy `terminal:failed` root and cause-specific v2 root differ because of
    semantic identity, not version alone;
  - a fresh v2 finding does not set legacy evaluation recurrence;
  - planning creates/updates v2 as generation zero when no v2 lineage exists;
  - later same-root v2 evidence uses existing append/recurrence/generation cap.

- [ ] **Step 3: Run the evaluator slice and observe red.**

```bash
node --test --test-name-pattern="legacy dispatch|dispatch exposure|v2 lineage|learning outcome" tests/learning.test.mjs
```

Expected: legacy scope misses v2 observations, zero can pass without exposure,
and migration assertions fail/are absent.

- [ ] **Step 4: Implement exact legacy scope and exposure.** In
  `evaluateLearningOutcome`:

  1. recognize only exact repeated-dispatch key `terminal:failed` after embedded
     contract parsing;
  2. for legacy scope, include all owned corrected dispatch failures; otherwise
     retain exact semantic-key matching;
  3. derive healthy exposure from `snapshot.runRecords` within the window using
     owned trusted route, delivery sweep, non-launcher runtime,
     `outcome.kind === "success"`, exit zero, and no signal;
  4. treat a corrected failure as exposure for its contributor;
  5. require all contributors only when corrected failure count is zero;
  6. keep incomplete coverage inconclusive; and
  7. explicitly disable legacy recurrence compatibility while preserving v2
     exact-root recurrence.

Keep helpers pure and bounded over snapshot-capped arrays. Reuse one shared
delivery-sweep set and build contributor exposure keys in one pass over owned
runs/failures, then compare the bounded contributor list; avoid a nested full
snapshot scan per contributor.

- [ ] **Step 5: Run focused and full learning tests.**

```bash
node --test --test-name-pattern="legacy dispatch|dispatch exposure|v2 lineage|learning outcome|recurrence" tests/learning.test.mjs
node --test tests/learning.test.mjs
```

Expected: all learning tests pass.

- [ ] **Step 6: Commit the evaluator unit.**

```bash
git add scripts/learning.mjs tests/learning.test.mjs
git commit -m "fix(COD-288): evaluate corrected dispatch outcomes"
```

### Task 4: Freeze the production regression and release the contract

**Files:**

- Modify: `tests/learning.test.mjs`
- Modify: `tests/linear-watch.test.mjs`
- Modify: `README.md:5-15,80-130`
- Modify: `CHANGELOG.md:1-15`
- Modify: `VERSION:1`

- [ ] **Step 1: Add an end-to-end production-shaped regression.** Include the
  five COD-288-style successful runs with child `terminal/failed`, two admitted
  same-key failures inside 24 hours, different-key failures, and excluded
  routing/interruption outcomes. Assert zero child-derived observations, one
  same-key v2 finding, no cross-key aggregation, corrected legacy count, and
  complete-exposure zero verification.

- [ ] **Step 2: Run the combined focused regression.**

```bash
node --test --test-name-pattern="COD-288|dispatch learning|legacy dispatch|repeated dispatch" tests/learning.test.mjs tests/linear-watch.test.mjs
```

Expected: combined fixture and neighboring focused tests pass.

- [ ] **Step 3: Reconcile origin and compute a unique release marker.**

```bash
git fetch origin --prune
git merge origin/main
git for-each-ref --format='%(refname)' refs/remotes/origin | while read -r ref; do
  git show "$ref:VERSION" 2>/dev/null || true
done | rg '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -V -u > "$AUTO_SWEEP_TMPDIR/live-versions.txt"
MAX_VERSION=$(tail -1 "$AUTO_SWEEP_TMPDIR/live-versions.txt")
NEXT_VERSION=$(node -e 'const v=process.argv[1].split(".").map(Number); v[3]+=1; process.stdout.write(v.join("."))' "$MAX_VERSION")
! rg -qx "$NEXT_VERSION" "$AUTO_SWEEP_TMPDIR/live-versions.txt"
```

Expected: next marker is strictly greater than `origin/main` and all live remote
release branches. Do not hardcode/reuse a marker from this plan.

- [ ] **Step 4: Update canonical architecture and release files.** With
  `apply_patch`:

  - state in README that dispatch reliability comes from launcher-classified
    start/I/O/exit/signal evidence, child terminals are not proof,
    routing/interruption are learning exclusions, and zero requires contributor
    exposure;
  - add CHANGELOG entries for false-positive correction, v2 cause identity,
    migration-safe evaluation, and preserved human Ship; and
  - set `VERSION` to `$NEXT_VERSION`.

Do not claim a deploy or alter unrelated historical planned notes.

- [ ] **Step 5: Verify versioned contract lineage.**

```bash
for artifact in \
  docs/superpowers/specs/2026-07-14-COD-288-trusted-dispatch-failure-evidence-design.md \
  docs/superpowers/plans/2026-07-14-COD-288-trusted-dispatch-failure-evidence-implementation.md
do
  ARTIFACT_COMMIT=$(git log --diff-filter=A --format=%H -- "$artifact" | tail -1)
  MARKER_COMMIT=$(git log --diff-filter=A --format=%H -- .claude/skills/.sweep-version | tail -1)
  test -n "$ARTIFACT_COMMIT" && test -n "$MARKER_COMMIT"
  if git merge-base --is-ancestor "$ARTIFACT_COMMIT" "$MARKER_COMMIT"; then
    echo "FAIL: artifact predates current contract boundary" >&2
    exit 1
  fi
done
```

Expected: both artifacts are post-boundary; ancestry exits 1. Missing or
incomparable commits fail closed.

- [ ] **Step 6: Run focused and full verification.**

```bash
node --test tests/learning.test.mjs tests/linear-watch.test.mjs
node --test tests/*.test.mjs
node scripts/linear-watch.mjs learning-run --dry-run
rg -n "dispatch|repeated-dispatch-failure/v2|terminal" README.md CHANGELOG.md
git diff --check
git status --short
```

Expected: focused/full suites pass; dry-run performs no writes/cursor movement
and has no terminal-derived dispatch failures; release docs/version are complete;
only seven predicted implementation/release files differ from the Spec-landed
base; no secret, `.env`, run record, or ignored security report is staged.

- [ ] **Step 7: Review and commit the final unit.**

```bash
git diff --stat origin/main...HEAD
git diff -- scripts/learning.mjs scripts/linear-watch.mjs tests/learning.test.mjs tests/linear-watch.test.mjs README.md CHANGELOG.md VERSION
git add scripts/learning.mjs scripts/linear-watch.mjs tests/learning.test.mjs tests/linear-watch.test.mjs README.md CHANGELOG.md VERSION
git commit -m "fix(COD-288): correct repeated dispatch evidence"
```

Use the runtime's own attribution if a trailer is required. Never copy a Claude
co-author trailer from examples.

## Failure and recovery matrix

| Failure | Response |
| --- | --- |
| Focused test is green before intended code change | Strengthen it until it proves old false behavior, then implement. |
| Evidence route is missing/ambiguous | Emit route-gap record; no trusted detector observation; never guess a repo. |
| Evidence append fails | Record local launcher failure; continue claim/retry/Todo flow; prove injected exception. |
| Excluded outcome emits learning evidence | Block handoff and fix admission without changing operational behavior. |
| Legacy zero passes without all contributors | Block handoff; return `inconclusive-evidence`. |
| Legacy root recurs from v2 cause | Block handoff; preserve measurement-only migration boundary. |
| Origin advances or VERSION collides | Merge latest origin, rerun tests, recompute greater unique marker. |
| Full suite/dry-run is red | Do not hand off to QA; fix or route with evidence. |
| Post-merge learning is suspect | Disable learning runner/workspace flag, revert, dry-run, then re-enable; delivery remains independent. |

## Rollout and ownership

1. Dev implements and pushes the COD-288 branch; it does not merge.
2. QA runs full operator verification, attaches evidence, and moves this
   factory-generated card to Signoff only when `qa:passed` is proven.
3. A human moves Signoff to Ship.
4. Ship alone merges/pushes `main`; no production app deploy follows.
5. The existing updater distributes the new VERSION to registered anchors.
6. The existing learning runner/workspace flag is the kill switch.

## Plan reassessment

- **Initial tier:** Tier 2 — Material.
- **Final tier:** Tier 2 — Material.
- **Monotonic result:** unchanged. Seven predicted files, zero new
  classes/services/dependencies, but material trust, migration, and error paths.
- **Scope closure:** every `S1..S7` row maps bidirectionally to tasks, files,
  proofs, and rollout owners. No task introduces an unlisted material surface.
- **Verification:** every `V1..V9` obligation maps to executable red/green/full
  proof. No invariant relies only on manual inspection.
- **Performance:** not required. Records are added only for admitted failures and
  evaluation scans already bounded arrays; no per-success persistence/new
  asymptotic path.
- **Specialized lenses:** security completed/clear; design, DevEx, research stay
  inapplicable; no material performance change triggers a specialized lens.
- **Repo/deploy:** one configured repo, no production deploy, existing updater.
- **Open questions:** none.

## Spec-sweep review audit

| Review | Result | Material outcome |
| --- | --- | --- |
| Scope self-check | Corrected, clear | Added trusted contributor exposure and emitted one scope-gap event. |
| Tier 2 engineering spec | Corrected, clear | Avoided duplicate success records/observation pressure, separated Todo/learning identity, used production outcome shape. |
| Focused security (`data`) | Clear | Parent provenance, route trust, hashed/sanitized identity, bounds, no-traffic fail closed. |
| Independent adversarial spec | Corrected, clear after follow-up | Fixed interruption/routing admission, append isolation, lineage, routed-repo ownership. |
| Tier 2 engineering plan | Corrected, clear | Added env-aware pre-persistence sanitization, one-pass exposure indexing, bounded builder card identity, and real JSONL/real-builder proofs. Independent follow-up found no unresolved blocker. |

Preferred Claude review was unavailable through the collaboration interface; the
independent pass used a fresh-context read-only reviewer subagent. All material
findings were emitted as structured review evidence. The completed engineering
plan pass and independent follow-up leave no unresolved blocker.

## GSTACK REVIEW REPORT

**Review target:** COD-288 Tier 2 implementation plan.

**Scope challenge:** Seven implementation/release files, zero new
classes/services/dependencies, one configured repo. Existing classification,
evidence, detector/evaluator, and updater mechanisms are reused. No complexity
stop is triggered.

**Architecture:** Clear. The plan reuses launcher classification and bounded
evidence persistence, keeps operational Todo behavior separate, passes a
builder-valid dispatch identity with the original repo route, and makes
legacy/v2 lineage separation explicit. Append failure cannot interrupt
claim/retry/Todo flow.

**Code quality:** Clear. Pure key/admission helpers isolate policy, Todo
fingerprints remain unchanged, typed reasons avoid prose coupling, one shared
delivery-sweep set prevents drift, and exposure is indexed in one bounded pass.

**Tests:** Clear. `V1..V9` cover every admission path, production run shape,
real builder routing, Todo throttle independence, append continuation, captured
JSONL secret absence, contributor exposure, lineage, release docs, dry-run, and
the full suite.

**Performance:** Clear. Only admitted failures append. Healthy exposure reads
existing capped run records, consumes no observation slots, and uses a one-pass
contributor index. No benchmark or specialized performance lens is required.

**Decision audit:** D1 trusted launcher authority, D2 migration-safe legacy
measurement, and D3 narrow terminal scope were auto-selected under the unattended
spec-sweep contract. No user-only decision remains.

NO UNRESOLVED DECISIONS

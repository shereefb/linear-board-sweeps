# COD-148 Terminal-Failure Claim Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace false live claims left by observed failed children with an owner-verified, stage-scoped cooldown that preserves retry delay without producing stale-claim evidence.

**Architecture:** Keep Linear as the machine-independent coordination source. A strict retry marker, authenticated against the latest matching heartbeat and Linear server time, blocks admission for the existing per-stage stale interval; terminal `exit`/`signal` reconciliation writes that marker before removing the exact owned claim and verifies the full-label-set mutation afterward. Scheduled admission completes only the active comment window when the newest 100 comments are insufficient.

**Tech Stack:** Node.js 18+ ESM, built-in `node:test`, existing zero-dependency Linear GraphQL client, Linear issue labels/comments, Markdown operator documentation.

## Global Constraints

- Do not parse or special-case raw Codex quota/billing text.
- Do not add a dependency, service, database, config key, workflow label, migration, or deploy target.
- Preserve the configured stale intervals exactly: Spec 45 minutes; Dev 90 minutes; QA 120 minutes; Ship 120 minutes.
- Cover observed nonzero `exit` and OS `signal`; explicit launcher `interrupted` remains immediate release without cooldown.
- A retry marker controls admission only when it is line-anchored, names the current `cfg.claim`, has a valid owner matching the latest heartbeat for that claim, is not older than that heartbeat, and has a Linear `createdAt` age in `[0, cfg.staleMin]`.
- Never place raw stdout, stderr, prompts, credentials, usage-limit text, or arbitrary child output in the marker or failure Todo.
- Write the retry marker before removing the claim; re-read and re-prove ownership after the marker; verify the post-write label set.
- Linear label updates are full-set writes, not atomic single-label operations. Narrow the race with a second read, detect post-write loss, and never attempt blind restoration.
- Complete comment history only inside the maximum 120-minute coordination window, capped at 20 pages/2,000 comments; cursor cycles, missing page data, cap-before-cutoff, or incomplete pagination fail scheduled admission closed.
- Dev/QA must run the repository `/benchmark` lens (or its direct test-harness equivalent) against one-page normal admission and the 20-page cap; no regression may make ordinary queue scans paginate cards whose newest page already covers the cutoff.
- Failed results trigger no same-tick refill/handoff and stop later drain passes; already queued demands may finish.
- The durable run record remains primary failure truth. Failure Todos are separately retried operator signals.
- Genuine silent/frozen children still use the heartbeat reaper, `stale-claim` evidence, and crash-loop escalation.
- Existing dependency, routing, QA, Signoff, human Ship, generated-card, and review gates remain unchanged.
- Keep the implementation surgical: production behavior stays in `scripts/linear-watch.mjs`; tests stay in `tests/linear-watch.test.mjs`.

---

## Repo scope

Owning repo: `linear-board-sweeps` only.

- Branch expectation: `COD-148` or `codex/COD-148-*` from current `main`.
- QA evidence: focused launcher/learning tests plus the complete repository `node:test` suite.
- Deploy target: no production app deploy. Shipping is merge/push to `main`; the existing updater distributes the kit.
- Ship order: one repo, one merge. No sibling repo or external release step.

## What already exists

- `heartbeatAgeMin()`, `latestHeartbeatOwner()`, `liveClaimLabel()`, and `actionableCards()` already centralize heartbeat ownership and admission. Extend them instead of building a second scheduler.
- `releaseOwnedDispatchClaim()` already proves the owner token for successful/deferred/start-failure cleanup. Keep its contract unchanged; terminal failure needs a dedicated helper because its safe mutation order differs.
- `classifyDispatchOutcome()` already distinguishes `exit`, `signal`, `interrupted`, and `success`.
- `fetchLearningIssueComments()` already demonstrates cursor-complete issue comment pagination. Extract/reuse its GraphQL and cursor-cycle pattern for active-window coordination reads.
- `fetchScheduledQueueCards()` already fails admission closed on incomplete dependency data and can apply the same policy to comment data.
- `recordConfirmedReapEvidence()` and Factory Learning already make genuine reaps observable. COD-148 must avoid calling that path for observed terminal failures, not weaken it.
- Failure-Todo reconciliation and the durable run index already record failed dispatches independently of claim cleanup.

## NOT in scope

- Runtime/provider quota detection or a global provider circuit breaker: the lifecycle bug applies to every observed failed child, regardless of cause.
- Configurable backoff/jitter: existing stage stale intervals already provide the required retry delay.
- A new cooldown label or external ledger: comments plus bounded pagination are sufficient and machine-independent.
- Atomic/CAS Linear label mutation: the current API helper exposes full-set `labelIds`; this change detects the residual race rather than inventing an unsupported primitive.
- Immediate refill after failure: current failure semantics intentionally stop refill and later drain passes.
- Changes to Factory Learning detector thresholds: correct lifecycle evidence removes the false signal at its source.

## Data flow

```text
child closes
  |
  +-- success/deferred/start failure/interrupted --> existing reconciliation
  |
  +-- nonzero exit or OS signal
        |
        v
  read card + prove claim/owner
        |
        v
  write exact retry marker (server timestamp)
        |
        v
  read again + re-prove owner + capture current labels
        |
        v
  remove only claim via full label-set update
        |
        v
  read again + verify claim absent / other labels preserved
        |
        +--> mismatch: red tick + safety evidence, no blind restore
        |
        v
  next scheduled queue read
        |
        +--> newest 100 cover 120m window: parse locally
        |
        +--> active window extends earlier: page backward, fail closed if incomplete
        |
        v
  exact claim + owner/heartbeat + server-time proof
        |
        +--> age <= staleMin: cooled down
        +--> age  > staleMin: eligible if all existing gates pass
```

## Task 1: Strict retry-marker parsing and admission

**Files:**
- Modify: `scripts/linear-watch.mjs:80-81,580-610,808-817,1284-1313,1680-1700`
- Test: `tests/linear-watch.test.mjs:1262-1358,3390-3530`

**Interfaces:**
- Produces `RETRY_TAG = "[auto-sweep-retry"`.
- Produces `latestHeartbeat(card, claim) -> { owner, createdAt, timestamp } | null`; `latestHeartbeatOwner()` remains a compatibility wrapper.
- Produces `retryCooldown(card, cfg, now) -> { active, owner, createdAt, ageMin } | null`.
- `actionableCards()` and `claimConfirmed()` consume `retryCooldown()`.

- [ ] **Step 1: Write failing marker grammar and boundary tests**

Add table-driven tests with fixed `NOW` for:

```js
const retry = (claim, owner, createdAt, prefix = "") => ({
  id: `${owner}-${createdAt}`,
  body: `${prefix}[auto-sweep-retry claim=${claim} owner=${owner}] [auto-sweep-orphan] terminal failure observed`,
  createdAt,
});

test("retryCooldown requires an anchored current-claim marker owned by the latest heartbeat", () => {
  const card = dependencyReadyCard({
    labelNames: [],
    comments: [
      { id: "beat", body: `${HEARTBEAT_TAG} ${minsAgo(2)} owner=owner-1 claim=dev:in-progress]`, createdAt: minsAgo(2) },
      retry("dev:in-progress", "owner-1", minsAgo(1)),
    ],
  });
  assert.equal(retryCooldown(card, SWEEP_CFG.dev, NOW).active, true);
  assert.equal(retryCooldown(card, SWEEP_CFG.spec, NOW), null);
});
```

Also assert rejection of a leading quote/prefix, unknown claim, empty/malformed owner, owner mismatch, marker older than heartbeat, invalid date, future server timestamp, and age greater than `staleMin`. Two valid markers with the same `createdAt` must select deterministically by comment id.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='retryCooldown|actionableCards|claimConfirmed' tests/linear-watch.test.mjs
```

Expected: FAIL because `RETRY_TAG`, `latestHeartbeat()`, and `retryCooldown()` do not exist and current admission ignores markers.

- [ ] **Step 3: Implement the strict parser and heartbeat record helper**

Add an anchored regex built from the closed claim set, not arbitrary text. Parse only the first marker line. Use `comment.createdAt` as authority, reject `timestamp > now`, compare the marker owner with `latestHeartbeat(card, cfg.claim)`, require `marker.timestamp >= heartbeat.timestamp`, and sort valid candidates by timestamp then stable comment id.

Keep:

```js
export function latestHeartbeatOwner(card, claim = null) {
  return latestHeartbeat(card, claim)?.owner || null;
}
```

Do not accept the ISO text inside heartbeat bodies as retry-marker time; only Linear's retry comment `createdAt` controls cooldown.

- [ ] **Step 4: Gate every claim confirmation/admission path**

In `actionableCards()`, after blocked/dependency checks and before live-claim evaluation:

```js
if (retryCooldown(card, cfg, now)?.active) return false;
```

In `claimConfirmed()`, reject an active cooldown using `Date.now()` (add an injectable `now` only if tests require it). This closes the selection-to-claim race: a stale candidate that receives a cooldown before owner confirmation must release its newly added claim.

Ensure launcher retry comments remain excluded from human-answer detection. Because the marker body includes `ORPHAN_TAG`, extend tests proving it cannot be mistaken for a human unblock reply.

- [ ] **Step 5: Run focused admission tests and commit**

Run:

```bash
node --test --test-name-pattern='heartbeat|retryCooldown|actionableCards|claimConfirmed|human comment' tests/linear-watch.test.mjs
```

Expected: PASS.

Commit:

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "COD-148 gate admission on terminal retry cooldowns"
```

## Task 2: Complete the active coordination comment window

**Files:**
- Modify: `scripts/linear-watch.mjs:2814-2836,3623-3786`
- Test: `tests/linear-watch.test.mjs` near scheduled queue pagination tests

**Interfaces:**
- Produces `completeRecentIssueComments(apiKey, issueId, seedConnection, cutoff, { gqlFn }) -> Comment[]`.
- `fetchScheduledQueueCards()` supplies complete active-window comments to `normalizeQueueCard()`.
- Existing `fetchLearningIssueComments()` keeps its public behavior, delegating to a shared cursor-safe primitive where practical.

- [ ] **Step 1: Write failing backward-pagination tests**

Create mocked GraphQL pages where `comments(last:100)` has `hasPreviousPage: true` and every seed comment is newer than `now - MAX_STALE_MIN`. Assert the helper requests the prior page with `before: startCursor`, deduplicates by comment id, stops once the oldest comment is at/before cutoff, and returns the active window including a retry marker at position 101.

Add failures for:

- missing `pageInfo.hasPreviousPage`;
- `hasPreviousPage` with no `startCursor`;
- cursor reuse/cycle;
- 20 pages/2,000 comments reached before the cutoff;
- malformed `nodes`;
- GraphQL partial errors; and
- an incomplete page while a possible active marker remains.

- [ ] **Step 2: Run pagination tests and verify RED**

Run:

```bash
node --test --test-name-pattern='coordination comments|scheduled queue snapshot' tests/linear-watch.test.mjs
```

Expected: FAIL because scheduled queue comments expose no backward page metadata and no active-window completion helper exists.

- [ ] **Step 3: Implement bounded active-window completion**

Extend scheduled queue comment selection to:

```graphql
comments(last:100) {
  pageInfo { hasPreviousPage startCursor }
  nodes { id body createdAt }
}
```

Use `before: $cursor` with `last: 100` for older pages. Stop when the minimum valid `createdAt` in the collected page is `<= cutoff` or `hasPreviousPage` is false. Treat missing/invalid dates conservatively: keep paging while an older active marker cannot be ruled out. Deduplicate by `id`; do not include comments older than cutoff. After 20 pages/2,000 comments without covering the cutoff, throw the same typed incomplete-snapshot failure used for cursor cycles so admission fails closed without unbounded API work.

Compute cutoff from the largest configured stale interval (`MAX_STALE_MIN`) once per scheduled pass. Do not paginate cleanup-only snapshots; only admission needs cooldown history.

- [ ] **Step 4: Integrate complete comments into queue normalization**

Before `normalizeQueueCard()` evaluates admission data, replace `node.comments.nodes` with the completed recent set when the seed page does not cover the cutoff. Preserve dependency pagination and bounded-cycle annotation unchanged.

Ensure handoff admission uses the freshly fetched target-card snapshot (with complete comments), not an earlier `fetchCard()` snapshot with only 100 comments, before it creates a downstream demand.

- [ ] **Step 5: Run focused pagination/admission tests and commit**

Run:

```bash
node --test --test-name-pattern='coordination comments|scheduled queue snapshot|handoff' tests/linear-watch.test.mjs
```

Expected: PASS, including marker-at-101 and cursor-cycle fail-closed cases.

Commit:

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "COD-148 complete the active retry comment window"
```

## Task 3: Owner-verified terminal failure cleanup

**Files:**
- Modify: `scripts/linear-watch.mjs:4148-4199,4711-4760,5603-5665`
- Test: `tests/linear-watch.test.mjs:3445-3525,4225-4255,5470-5555`

**Interfaces:**
- Produces `releaseFailedDispatchClaim(apiKey, pick, result, runtime, deps?) -> boolean`.
- `reconcileOwnedDispatchClaim()` invokes it for `kind === "exit" || kind === "signal"` and returns `{ attempted, released, reasonKind: "terminal failure cooldown" }`.
- Existing `releaseOwnedDispatchClaim()` behavior and boolean contract remain unchanged.

- [ ] **Step 1: Write failing mutation-order, race, and signal tests**

Use injected `fetchClaimCardFn`, `addCommentFn`, and `applyLabelEditFn` to record exact operations. The successful sequence must be:

```text
fetch -> marker comment -> fetch -> label edit -> fetch verification
```

Assert the marker begins exactly:

```text
[auto-sweep-retry claim=dev:in-progress owner=owner-141] [auto-sweep-orphan]
```

and includes only sanitized runtime/result metadata.

Add tests proving:

- initial owner mismatch or absent claim writes nothing;
- marker failure performs no label edit;
- owner changes between the first and second fetch, so no label edit occurs;
- an unrelated label added on the second fetch is present in the label mutation and final verification;
- label edit failure leaves the claim;
- final claim still present fails verification;
- any label from the second snapshot disappears, producing a typed safety-invariant error;
- `exit` and `signal` both take the cooldown path;
- `interrupted` keeps the existing immediate-release path; and
- successful/deferred/start-failure behavior is byte-for-byte compatible at the result-contract level.

- [ ] **Step 2: Run terminal cleanup tests and verify RED**

Run:

```bash
node --test --test-name-pattern='releaseFailedDispatchClaim|reconcileOwnedDispatchClaim|signal' tests/linear-watch.test.mjs
```

Expected: FAIL because ordinary `exit`/`signal` results are currently ignored by owned-claim reconciliation.

- [ ] **Step 3: Implement the dedicated helper**

Construct the comment from trusted `pick`, `result`, and runtime fields only. Do not read the child log. Use the two pre-write reads and one post-write read described in the spec. Compare label names as sets:

```js
const expectedLabels = new Set(second.labelNames.filter((name) => name !== cfg.claim));
const missing = [...expectedLabels].filter((name) => !verified.labelNames.includes(name));
if (hasLabel(verified, cfg.claim) || missing.length) {
  const error = new Error(`terminal claim cleanup verification failed for ${pick.issueIdentifier}`);
  error.code = "CLAIM_CLEANUP_UNVERIFIED";
  throw error;
}
```

Do not restore labels automatically. The caller's existing failure path must mark current-tick health red; emit the established safety-invariant evidence shape when verification proves label loss.

- [ ] **Step 4: Route both observed failure kinds through cooldown reconciliation**

Update `reconcileOwnedDispatchClaim()` so only `exit` and `signal` use `releaseFailedDispatchClaim()`. Preserve `expectedStates` behavior for successful completion and the current no-cooldown release for start/dependency/repository/interruption cases.

Keep failure-Todo reconciliation after claim reconciliation. Its failure must not roll back a verified cleanup; record the local failure so a later tick retries the Todo.

- [ ] **Step 5: Run focused cleanup tests and commit**

Run:

```bash
node --test --test-name-pattern='releaseFailedDispatchClaim|reconcileOwnedDispatchClaim|dispatch failure|claim cleanup' tests/linear-watch.test.mjs
```

Expected: PASS.

Commit:

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "COD-148 release failed child claims into cooldown"
```

## Task 4: Orchestration regression coverage and operator docs

**Files:**
- Modify: `tests/linear-watch.test.mjs`
- Modify: `README.md:70-80`
- Modify: `docs/linear-rules.md:50-60,100-110`

**Interfaces:**
- No new production interface.
- Documents `[auto-sweep-retry claim=<claim> owner=<owner>]` and its relationship to heartbeat, orphan, reaper, dispatch-failure, and failure-Todo evidence.

- [ ] **Step 1: Add the five-card orchestration regression**

Build one deterministic test fixture with five distinct Spec cards and observed terminal failures. Drive classification and owned-claim reconciliation, then run the next admission/reaper decisions. Assert:

```js
assert.equal(dispatchFailures.length, 5);
assert.equal(cooldownMarkers.length, 5);
assert.equal(reapDecisions(cardsAfterCleanup, SWEEP_CFG.spec, NOW).length, 0);
assert.equal(staleClaimEvidence.length, 0);
assert.equal(crashEscalations.length, 0);
```

Also assert a failed result yields no same-repo refill/handoff and stops a later drain pass, while already queued demands are unaffected.

- [ ] **Step 2: Add failure-Todo separation coverage**

Simulate `terminal cleanup success -> failure Todo write failure`. Assert the claim stays released, the cooldown remains active, current-tick health records a red local failure, and a later reconciliation creates/updates the Todo. Do not make cleanup depend on Todo availability.

- [ ] **Step 3: Update operator documentation**

In `README.md`, replace the current “successful child” self-healing sentence with the complete lifecycle:

- successful same-state child: immediate owner-token release;
- observed failed child: exact retry marker, immediate release, stage stale-interval cooldown;
- silent/frozen child: heartbeat reaper and crash escalation.

In `docs/linear-rules.md`, document the exact marker, server-time/owner proof, 45/90/120-minute stage behavior, no same-tick refill after failure, and the distinction between `[auto-sweep-retry]`, `[auto-sweep-orphan]`, and `[auto-sweep-reaper]`.

- [ ] **Step 4: Run focused and complete verification**

Run:

```bash
node --test tests/linear-watch.test.mjs tests/learning.test.mjs
node --test tests/*.test.mjs
git diff --check
```

Expected focused result: all tests pass.

Expected full result relative to current baseline: no COD-148 failures; the two pre-existing `repo-status` CLI tests may remain failing only because `.claude/linear-sweep.json` has no `repoRouting.byLabel`. If either baseline failure changes or any new failure appears, stop and fix it before handoff.

- [ ] **Step 5: Commit the regression/docs unit**

```bash
git add tests/linear-watch.test.mjs README.md docs/linear-rules.md
git commit -m "COD-148 document and verify terminal claim cooldowns"
```

## Failure-mode coverage

| Production failure | Test | Handling | Operator visibility |
| --- | --- | --- | --- |
| Quota/runtime child exits nonzero | Tasks 3-4 | Marker then owner-verified release | Run record + failure Todo + retry comment |
| Child dies by OS signal | Task 3 | Same cooldown path | Run record + failure Todo + retry comment |
| Marker write fails | Task 3 | Keep claim; stale reaper fallback | Red tick / claim-release failure |
| Owner changes before removal | Task 3 | Abort removal | Red tick; new owner preserved |
| Unrelated label arrives before second read | Task 3 | Preserve it in outgoing set | Verified post-write |
| Concurrent label write after second read | Task 3 | Detect post-write mismatch; no blind restore | Safety invariant + red tick |
| Marker is quoted/forged/stale/future | Task 1 | Ignore | Card remains eligible subject to other gates |
| Marker falls beyond latest 100 comments | Task 2 | Page active window | Cooldown preserved across hosts |
| Comment pagination incomplete/cycles | Task 2 | Fail admission closed | Scheduled fetch failure / Todo path |
| Failure Todo write fails | Task 4 | Keep verified cleanup; retry reconciliation | Red current tick, later Todo |
| Child freezes with no result | Existing tests | Heartbeat reaper | Reaper comment + stale evidence |

No failure mode is silent without both test coverage and an operator-visible failure path.

## Parallelization strategy

Sequential implementation, no parallelization opportunity. Tasks 1-3 all modify `scripts/linear-watch.mjs` coordination helpers and overlapping `tests/linear-watch.test.mjs` fixtures; Task 4 validates their integrated ordering and should follow them.

## Terminal plan engineering review

The Tier 2 plan review ran in unattended prose mode and adopted the recommended
option for each decision.

### D1 — Bound active-window pagination by time and work

ELI10: “only the last two hours” is not a work bound if a runaway integration
writes thousands of comments in two hours. The scheduler must avoid unbounded
GraphQL work without treating an incomplete history as safe.

**A) 120-minute cutoff plus 20-page cap, fail closed (recommended).
Completeness: 10/10.** Normal cards stop after one page; high-volume cards scan
at most 2,000 comments. Reaching the cap before the cutoff is an explicit
admission failure, not an early retry.

**B) Time cutoff only. Completeness: 8/10.** Preserves cooldown correctness but
can make one pathological card dominate a scheduled tick.

**C) Page cap then assume no marker. Completeness: 4/10.** Bounds work but breaks
the cooldown guarantee under exactly the high-comment case pagination handles.

Net: adopt A.

### D2 — Enforce cooldown at selection and owner confirmation

ELI10: another host can select a card just before the first host writes its
failure marker. Checking only the queue snapshot leaves a gap; owner confirmation
must also reject the new cooldown.

**A) Gate `actionableCards()` and `claimConfirmed()` (recommended).
Completeness: 10/10.** Covers normal selection, refill, and the
selection-to-claim race while keeping one parser as the source of truth.

**B) Gate queue selection only. Completeness: 7/10.** Handles the ordinary path
but a stale pre-marker snapshot can still confirm a new owner.

Net: adopt A. Handoff must also use the complete target-card snapshot before it
constructs a demand.

### D3 — Verify full-label writes without unsafe repair

ELI10: Linear replaces the whole label list. A second read makes the window small,
but another write can still land between that read and our update. Silent loss is
unacceptable; guessing how to restore labels can clobber an even newer change.

**A) Post-write proof + safety failure, no blind restore (recommended).
Completeness: 9/10.** Preserves every label visible on the second read and makes a
later race operator-visible. It is honest about the lack of atomic compare-and-swap.

**B) Blindly re-add missing labels. Completeness: 6/10.** May repair one race but
can resurrect a label a human intentionally removed after the second read.

**C) Skip verification. Completeness: 3/10.** Smallest diff but can silently lose
workflow/security labels.

Net: adopt A.

### Review sections

- Architecture: clear after bounding pagination, using a dedicated terminal
  cleanup helper, and enforcing cooldown across selection/confirmation/handoff.
- Code quality: clear; no new module or abstraction is needed, and existing
  successful/deferred cleanup remains untouched.
- Tests: clear when Tasks 1-4 cover every parser, pagination, mutation-order,
  signal, Todo, refill, and evidence branch in the failure-mode table.
- Performance: clear with one-page normal behavior, a 120-minute cutoff, and the
  20-page hard cap.
- Security: clear with exact marker grammar, owner-heartbeat proof, server time,
  complete/capped history, and explicit trusted-agent residual risk.
- TODOs: none. Every material finding is required for COD-148 rather than a
  follow-up.
- Parallelization: sequential; the production and test surfaces overlap.

Final tier: Tier 2. All required engineering and specialized reviews are clear,
the spec and plan agree, and no decision remains unresolved.

## Spec-sweep review audit

| Item | Decision / outcome |
| --- | --- |
| Initial tier | Tier 2, because claim ownership, cross-host cooldown persistence, full-label mutation, and retry admission are coordination/concurrency semantics. |
| Predicted footprint | Four files, roughly 260-380 changed lines including tests/docs after active-window pagination was added. |
| Spec engineering pass | Clear after correcting mutation order, signal coverage, full comment history, same-tick semantics, and failure-Todo truthfulness. |
| Independent adversarial spec review | Current Codex reviewer runtime used because this host cannot select the configured Claude reviewer for a collaboration subagent. Eight findings traced to source and folded into the spec. |
| Security lens | Clear with exact marker grammar, owner-heartbeat proof, server timestamps, active-window pagination, and explicit trusted-agent residual risk. |
| UI/design lens | Skipped: no UI, interaction, accessibility, responsive, or visual hierarchy change. |
| API/CLI/SDK devex lens | Skipped: no public API, CLI, SDK, documentation adoption, or compatibility contract changes. |
| Performance lens | Material and covered by the terminal engineering performance section: 120-minute cutoff, 20-page/2,000-comment cap, one-page normal path, plus downstream Dev/QA benchmark evidence. |
| External research lens | Skipped: no unfamiliar external integration or dependency is introduced. |
| Plan engineering pass | Clear after adding the page/work cap, all-path admission enforcement, handoff freshness, post-write label verification, and orchestration coverage. |
| Final tier | Tier 2. No escalation; all required reviews are clear with no unresolved decisions. |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | Skipped | Reliability lifecycle fix; no product-direction decision. |
| Codex Review | independent reviewer | Adversarial premise check | 1 | CLEAR | 8 findings traced to source and folded into spec/plan. |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR | Tier 2 spec + plan passes; mutation, admission, pagination, tests, and performance bounded. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | Skipped | No UI or interaction surface. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | Skipped | No public API, CLI, or SDK contract. |
| Security Review | `/cso` | Scheduler-control trust boundary | 1 | CLEAR | Exact marker/owner proof, server time, complete capped history, residual trusted-agent risk documented. |

**CROSS-MODEL:** The configured Claude reviewer runtime could not be selected by this host's collaboration dispatch, so the independent reviewer ran in the current Codex runtime; the handoff records that limitation.

**VERDICT:** ENG + ADVERSARIAL + SECURITY CLEARED — ready for Dev implementation with required downstream benchmark evidence.

NO UNRESOLVED DECISIONS

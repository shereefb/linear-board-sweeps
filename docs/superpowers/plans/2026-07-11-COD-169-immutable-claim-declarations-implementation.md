# COD-169 Immutable Claim Declarations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace heartbeat-derived sweep ownership with first-declaration-wins claim epochs whose heartbeats prove liveness only.

**Architecture:** A new pure `scripts/claim-ownership.mjs` module parses and folds complete Linear comment history into one fail-closed ownership result. `linear-watch.mjs` owns acquisition, reaping, recovery, migration diagnostics, and child propagation; `linear.mjs` consumes the same resolver for guarded terminal mutations. Every release path posts and verifies a close/reset boundary before removing the exact claim label.

**Tech Stack:** Node.js ESM, built-in `node:test`, Linear GraphQL, existing zero-dependency launcher and CLI scripts.

## Global Constraints

- A heartbeat can never create, replace, reopen, or transfer ownership.
- The earliest valid declaration after the latest valid close/reset boundary is the only owner; losing declarations never promote later.
- Every ownership decision uses complete, cycle-safe paginated Linear comment history and fails closed on malformed or ambiguous relevant markers.
- Claim acquisition posts the declaration before adding the stage claim label, then final-reads and confirms both exact tokens.
- Release, reaping, blocker, recovery, and terminal paths close and re-read the epoch before removing the exact claim label.
- Preserve existing scheduling, routing, dependency, capacity, resume, manual sweep, QA auto-ship, Factory Learning, and Ship behavior.
- Add no dependency, service, Linear state, or Linear label.

---

### Task 1: Shared claim protocol and pure resolver

**Files:**
- Create: `scripts/claim-ownership.mjs`
- Create: `tests/claim-ownership.test.mjs`

**Interfaces:**
- Consumes: Linear comments shaped as `{ id, body, createdAt }` plus `{ claim, labelPresent, complete }`.
- Produces: `CLAIM_PROTOCOL_VERSION`, marker constants, `claimDeclarationMarker(input)`, `claimHeartbeatMarker(input)`, `claimCloseMarker(input)`, `claimResetMarker(input)`, `parseClaimMarker(comment)`, and `resolveClaimOwnership(input)`.
- `resolveClaimOwnership` returns one frozen result with `status` in `owned | closed | legacy-unowned | orphan-declaration | unclaimed | ambiguous`, stable `reason`, and, only for `owned`, `ownerToken`, `declarationId`, `declaredAt`, `heartbeatAt`, and `livenessAt`.

- [ ] **Step 1: Write the failing marker and resolver matrix**

```js
test("first declaration owns the epoch and later declarations never promote", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-a", declarationId: "decl-a" }), 0),
    comment("c2", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-b", declarationId: "decl-b" }), 1),
    comment("c3", claimCloseMarker({ claim: "dev:in-progress", declarationId: "decl-a", reason: "released" }), 2),
  ];
  assert.deepEqual(resolveClaimOwnership({ comments, complete: true, claim: "dev:in-progress", labelPresent: false }), {
    status: "closed", reason: "epoch-closed", boundaryCommentId: "c3",
  });
});

test("a delayed heartbeat for a closed declaration cannot affect the next epoch", () => {
  const result = resolveClaimOwnership({ comments: [
    comment("c1", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "old", declarationId: "old-decl" }), 0),
    comment("c2", claimCloseMarker({ claim: "qa:in-progress", declarationId: "old-decl", reason: "reaped" }), 1),
    comment("c3", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "new", declarationId: "new-decl" }), 2),
    comment("c4", claimHeartbeatMarker({ claim: "qa:in-progress", declarationId: "old-decl", at: iso(3) }), 3),
  ], complete: true, claim: "qa:in-progress", labelPresent: true });
  assert.equal(result.ownerToken, "new");
  assert.equal(result.declarationId, "new-decl");
  assert.equal(result.livenessAt, iso(2));
});
```

Also cover deterministic `createdAt,id` ordering, matching heartbeat liveness, unknown/losing heartbeats, all close reasons, reset boundaries, stage isolation, label-without-declaration, declaration-without-label, incomplete input, malformed relevant markers, unreadable timestamps, conflicting duplicate declaration IDs, and a close that references a non-current declaration.

- [ ] **Step 2: Run the focused suite and verify RED**

Run: `node --test tests/claim-ownership.test.mjs`  
Expected: FAIL because `scripts/claim-ownership.mjs` does not exist.

- [ ] **Step 3: Implement strict marker builders, parser, ordering, and epoch fold**

```js
export const CLAIM_PROTOCOL_VERSION = "v1";
export const CLAIM_DECLARATION_TAG = "[auto-sweep-claim";
export const CLAIM_HEARTBEAT_TAG = "[auto-sweep-heartbeat";
export const CLAIM_CLOSE_TAG = "[auto-sweep-claim-close";
export const CLAIM_RESET_TAG = "[auto-sweep-claim-reset";

export function resolveClaimOwnership({ comments, complete, claim, labelPresent }) {
  if (complete !== true || !Array.isArray(comments)) return ambiguous("incomplete-comments");
  const events = parseAndSortRelevant(comments, claim);
  if (events.error) return ambiguous(events.error);
  const epoch = foldEpoch(events.value);
  if (epoch.error) return ambiguous(epoch.error);
  if (!epoch.declaration) {
    if (labelPresent) return frozen({ status: "legacy-unowned", reason: "label-without-declaration" });
    return frozen({ status: epoch.boundary ? "closed" : "unclaimed", reason: epoch.boundary ? "epoch-closed" : "no-claim" });
  }
  if (!labelPresent) return frozen({ status: "orphan-declaration", reason: "declaration-without-label", ...identity(epoch) });
  return frozen({ status: "owned", reason: "active-declaration", ...identity(epoch), ...liveness(epoch) });
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/claim-ownership.test.mjs`  
Expected: all claim protocol tests pass.

- [ ] **Step 5: Commit the pure protocol**

```bash
git add scripts/claim-ownership.mjs tests/claim-ownership.test.mjs
git commit -m "feat(COD-169): add immutable claim protocol"
```

### Task 2: Complete claim-history reads

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Modify: `scripts/linear.mjs`
- Modify: `tests/linear-watch.test.mjs`
- Modify: `tests/linear.test.mjs`

**Interfaces:**
- Consumes: `resolveClaimOwnership` from Task 1.
- Produces: `fetchCompleteClaimComments(apiKey, issueId, { gqlFn }) -> Promise<Comment[]>`, `withCompleteClaimHistory(card, comments)`, and CLI-side `fetchCompleteIssueComments(issueId, { gqlFn })`.
- Every hydrated card carries `commentsComplete: true`; scheduled snapshots explicitly carry `commentsComplete: false` and are never authoritative for ownership.

- [ ] **Step 1: Add failing pagination, cursor-cycle, and incomplete-snapshot tests**

```js
test("fetchCompleteClaimComments paginates oldest-to-newest with ids", async () => {
  const comments = await fetchCompleteClaimComments("key", "issue", { gqlFn: pagedGql([
    { nodes: [{ id: "c2", body: "two", createdAt: iso(2) }], hasNextPage: true, endCursor: "p2" },
    { nodes: [{ id: "c1", body: "one", createdAt: iso(1) }], hasNextPage: false, endCursor: null },
  ]) });
  assert.deepEqual(comments.map(({ id }) => id), ["c1", "c2"]);
});

test("scheduled snapshots are never complete ownership evidence", () => {
  assert.equal(normalizeRelationUnknownCard(snapshotNode).commentsComplete, false);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern='CompleteClaim|claim history|scheduled snapshots' tests/linear-watch.test.mjs tests/linear.test.mjs`  
Expected: FAIL because the complete-history helpers are absent.

- [ ] **Step 3: Implement cycle-safe pagination and authoritative hydration**

```js
export async function fetchCompleteClaimComments(apiKey, issueId, { gqlFn = gql } = {}) {
  const comments = [];
  const seen = new Set();
  let cursor = null;
  do {
    const data = await gqlFn(CLAIM_COMMENTS_QUERY, { id: issueId, cursor }, apiKey);
    const page = data?.issue?.comments;
    if (!Array.isArray(page?.nodes) || typeof page?.pageInfo?.hasNextPage !== "boolean") throw new Error("claim comments unreadable");
    comments.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error("claim comments pagination incomplete");
    seen.add(cursor);
  } while (true);
  return comments.sort(compareClaimComments);
}
```

Change GraphQL selections that feed snapshots to include comment IDs. Hydrate only cards whose claim history is material: claim candidates during final acquisition, cards carrying any in-progress label before reaping/cleanup/resume decisions, and terminal helper targets.

- [ ] **Step 4: Replace `latestClaimHeartbeat` in `linear.mjs` with the shared resolver input**

```js
const ownership = resolveClaimOwnership({
  comments,
  complete: true,
  claim: ownedClaim,
  labelPresent: labels.some((label) => label.name === ownedClaim),
});
```

Do not change terminal eligibility yet; Task 5 wires the new declaration argument.

- [ ] **Step 5: Run focused and existing Linear tests**

Run: `node --test tests/claim-ownership.test.mjs tests/linear.test.mjs tests/linear-watch.test.mjs`  
Expected: all tests pass, including cursor-cycle failures.

- [ ] **Step 6: Commit complete history support**

```bash
git add scripts/linear-watch.mjs scripts/linear.mjs tests/linear-watch.test.mjs tests/linear.test.mjs
git commit -m "feat(COD-169): require complete claim history"
```

### Task 3: Declaration-based acquisition and child propagation

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Modify: `tests/linear-watch.test.mjs`

**Interfaces:**
- Consumes: Task 1 marker builders/resolver and Task 2 complete reads.
- Produces: `declarationToken()`, `claimConfirmed(card, cfg, ownership, expectedStates)`, picks with `ownerToken` plus `claimDeclarationId`, and `AUTO_SWEEP_CLAIM_DECLARATION` in child environments.

- [ ] **Step 1: Write failing simultaneous-claim and propagation tests**

```js
test("claimCardSlots dispatches only the first declaration winner", async () => {
  const claimed = await claimCardSlots("key", "/anchor", config, "dev", [card], options, fakesThatInsertCompetingDeclarationFirst());
  assert.deepEqual(claimed, []);
  assert.equal(labelRemovals.length, 0, "loser must not remove the shared claim label");
});

test("withCardDispatchEnv propagates immutable declaration identity", () => {
  const pick = withCardDispatchEnv({ ...basePick, ownerToken: "owner", claimDeclarationId: "decl" }, "run", 0, paths);
  assert.equal(pick.childEnv.AUTO_SWEEP_OWNER_TOKEN, "owner");
  assert.equal(pick.childEnv.AUTO_SWEEP_CLAIM_DECLARATION, "decl");
});
```

Also assert declaration-before-label call order, final complete read, malformed history denial, route-race denial, and cleanup behavior after each acquisition failure point.

- [ ] **Step 2: Run acquisition tests and verify RED**

Run: `node --test --test-name-pattern='claimCardSlots|claim declaration|withCardDispatchEnv' tests/linear-watch.test.mjs`  
Expected: FAIL because picks do not carry declarations and acquisition still posts a heartbeat after the label.

- [ ] **Step 3: Implement declaration token generation and acquisition ordering**

```js
export function declarationToken({ randomUUID = crypto.randomUUID } = {}) {
  return randomUUID();
}

const declarationId = declarationToken();
await addCommentFn(apiKey, card.id, claimDeclarationMarker({ claim: cfg.claim, ownerToken: owner, declarationId }));
await applyLabelEditFn(apiKey, claimTarget, { add: { [cfg.claim]: claimId } });
const fresh = await fetchAuthoritativeClaimCardFn(apiKey, card.id);
const ownership = resolveCardClaim(fresh, cfg.claim);
if (!claimConfirmed(fresh, cfg, { ownerToken: owner, declarationId }, cfg.states)) continue;
```

Losers never remove the label. A failed attempt may close only its own active declaration; otherwise it records the existing safety invariant and stops.

- [ ] **Step 4: Add declaration identity to picks, env, run records, and refill/handoff copies**

```js
claimed.push({ ...fresh, ownerToken: owner, claimDeclarationId: declarationId, sweep, slotIndex });
// withCardDispatchEnv
AUTO_SWEEP_CLAIM_DECLARATION: pick.claimDeclarationId,
```

Trace every object spread/copy that currently carries `ownerToken`, including same-repo refill and Ship refill.

- [ ] **Step 5: Run focused tests and the full launcher suite**

Run: `node --test tests/claim-ownership.test.mjs tests/linear-watch.test.mjs`  
Expected: all acquisition, environment, refill, and legacy scheduler tests pass.

- [ ] **Step 6: Commit declaration acquisition**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "feat(COD-169): claim cards with immutable declarations"
```

### Task 4: Close-before-mutation lifecycle, reaping, and resume

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Modify: `tests/linear-watch.test.mjs`

**Interfaces:**
- Consumes: exact `{ ownerToken, claimDeclarationId }` from Task 3.
- Produces: `closeOwnedClaim(apiKey, card, cfg, identity, reason, deps)`, declaration-aware `heartbeatAgeMin`, `reapDecisions`, `foreignClaimReleases`, `releaseOwnedDispatchClaim`, `successfulSameStateRecoveryDecision`, `resumeAdmissionDecision`, and resume state version `2`.

- [ ] **Step 1: Write failing stale-child, close-order, and resume tests**

```js
test("release closes and verifies the epoch before removing the label", async () => {
  await releaseOwnedDispatchClaim("key", pick, "done", fakes);
  assert.deepEqual(calls.map((call) => call.kind), ["fetch", "comment-close", "fetch", "label-remove", "comment-audit"]);
});

test("a stale child cannot release a newer declaration", async () => {
  const released = await releaseOwnedDispatchClaim("key", oldPick, "late", fakesWithActive(newPick));
  assert.equal(released, false);
  assert.equal(labelRemovals.length, 0);
});
```

Cover liveness fallback to declaration time, delayed old heartbeat, protected resume heartbeat referencing the declaration, same-state recovery, dependency/routing/start failure, orphan cleanup, foreign claims, retry cooldown, crash escalation, close-write failure, verification failure, stranded closed label cleanup, resume record mismatch, and v1 resume-store fail-closed migration.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `node --test --test-name-pattern='reap|orphan|releaseOwned|resume|same-state|declaration' tests/linear-watch.test.mjs`  
Expected: FAIL because lifecycle code still trusts the latest heartbeat owner and removes before audit.

- [ ] **Step 3: Implement one close-before-mutation helper**

```js
export async function closeOwnedClaim(apiKey, card, cfg, identity, reason, {
  fetchClaimCardFn, addCommentFn, applyLabelEditFn,
} = {}) {
  const before = await fetchClaimCardFn(apiKey, card.id);
  if (!exactOwner(before, cfg.claim, identity)) return false;
  await addCommentFn(apiKey, card.id, claimCloseMarker({ claim: cfg.claim, declarationId: identity.claimDeclarationId, reason }));
  const closed = await fetchClaimCardFn(apiKey, card.id);
  if (!epochClosedBy(closed, cfg.claim, identity.claimDeclarationId)) throw new Error("claim close unverified");
  await applyLabelEditFn(apiKey, closed, { remove: [cfg.claim] });
  return true;
}
```

Administrative reapers use the same ordering after proving stale liveness; legacy/orphan reset uses `claimResetMarker` and may remove only after the reset boundary is visible in a complete re-read.

- [ ] **Step 4: Replace every heartbeat-owner lifecycle check**

Update live-claim filtering, own reaps, foreign/orphan reaps, retry paths, successful same-state release, dependency/repository deferral, spawn failure cleanup, resume protection/discovery/admission, and completion refill. Remove `heartbeatOwner` and `latestHeartbeatOwner` once no production caller remains.

- [ ] **Step 5: Version resume state and persist declaration identity**

```js
export const RESUME_STATE_VERSION = 2;
// validResumeRecord
typeof value.claimDeclarationId === "string" && value.claimDeclarationId
```

Old v1 records remain unreadable and protect nothing; live declared cards are rediscovered only when the exact declaration and deterministic dirty worktree both match.

- [ ] **Step 6: Run lifecycle and full launcher tests**

Run: `node --test tests/claim-ownership.test.mjs tests/linear-watch.test.mjs`  
Expected: all tests pass, including stale-child and stranded-label cases.

- [ ] **Step 7: Commit lifecycle migration**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "feat(COD-169): close claim epochs before release"
```

### Task 5: Guarded terminal CLI with declaration proof

**Files:**
- Modify: `scripts/linear.mjs`
- Modify: `tests/linear.test.mjs`

**Interfaces:**
- Consumes: shared resolver and `claimCloseMarker`.
- Produces: `move-card-bottom-if-current <Issue> <ExpectedState> <DestinationState> <OwnedClaim> <OwnerToken> <DeclarationId>` and updated `moveCardBottomIfCurrent(..., declarationId, deps)`.

- [ ] **Step 1: Write failing exact-declaration and ordering tests**

```js
test("guarded terminal move closes the exact declaration before issueUpdate", async () => {
  const result = await moveCardBottomIfCurrent("COD-169", "QA", "Ship", "qa:in-progress", "owner", "decl", deps);
  assert.equal(result.moved, true);
  assert.deepEqual(calls.map((call) => call.kind), ["metadata", "destination", "final-read", "close", "close-read", "issue-update"]);
});

test("guarded terminal move denies a stale declaration even with a late heartbeat", async () => {
  const result = await moveCardBottomIfCurrent(
    "COD-169", "QA", "Ship", "qa:in-progress", "old-owner", "old-decl", depsWithNewEpoch,
  );
  assert.equal(result.reason, "owner-mismatch");
  assert.equal(issueUpdates.length, 0);
});
```

Retain QA-only `QA -> Signoff|Ship` destination enforcement, Factory Learning exclusion, blocker/foreign-claim checks, delta label removal, CLI exit `0/3/2`, and destination pagination.

- [ ] **Step 2: Run focused CLI tests and verify RED**

Run: `node --test --test-name-pattern='guarded terminal|move-card-bottom-if-current' tests/linear.test.mjs`  
Expected: FAIL because the helper accepts no declaration ID and performs no close boundary.

- [ ] **Step 3: Implement final ownership read, close, close verification, and update**

```js
const ownership = resolveClaimOwnership({ comments, complete: true, claim: ownedClaim, labelPresent: true });
if (ownership.status !== "owned" || ownership.ownerToken !== ownerToken || ownership.declarationId !== declarationId) {
  return { moved: false, issue: finalIssue.identifier, reason: "owner-mismatch" };
}
await createComment(claimCloseMarker({ claim: ownedClaim, declarationId, reason: "terminal" }));
const closedIssue = await finalCompleteRead();
if (!epochClosedBy(closedIssue, ownedClaim, declarationId)) throw new Error("terminal claim close unverified");
await issueUpdate({ stateId: destinationStateId, sortOrder, removedLabelIds: [ownedClaimId] });
```

- [ ] **Step 4: Run CLI, resolver, and launcher suites**

Run: `node --test tests/claim-ownership.test.mjs tests/linear.test.mjs tests/linear-watch.test.mjs`  
Expected: all tests pass.

- [ ] **Step 5: Commit guarded terminal migration**

```bash
git add scripts/linear.mjs tests/linear.test.mjs
git commit -m "feat(COD-169): require declarations for terminal moves"
```

### Task 6: Sweep contracts, legacy diagnostic, and operator documentation

**Files:**
- Modify: `skills/spec-sweep/SKILL.md`
- Modify: `.claude/skills/spec-sweep/SKILL.md`
- Modify: `skills/dev-sweep/SKILL.md`
- Modify: `.claude/skills/dev-sweep/SKILL.md`
- Modify: `skills/qa-sweep/SKILL.md`
- Modify: `.claude/skills/qa-sweep/SKILL.md`
- Modify: `skills/ship-sweep/SKILL.md`
- Modify: `.claude/skills/ship-sweep/SKILL.md`
- Modify: `skills/manual-sweep/SKILL.md`
- Modify: `.claude/skills/manual-sweep/SKILL.md`
- Modify: `skills/unblock-sweep/SKILL.md`
- Modify: `.claude/skills/unblock-sweep/SKILL.md`
- Modify: `scripts/linear-watch.mjs`
- Modify: `tests/qa-sweep-doc.test.mjs`
- Modify: `tests/manual-sweep-doc.test.mjs`
- Modify: `tests/linear-watch.test.mjs`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `docs/linear-rules.md`
- Modify: `.claude/linear-sweep.json`
- Modify: `templates/linear-sweep.json`

**Interfaces:**
- Consumes: the final marker grammar and environment variables.
- Produces: `claim-migration-status --json`, identical canonical/mirrored skills, and complete rollout documentation.

- [ ] **Step 1: Write failing skill-contract and migration-diagnostic tests**

```js
test("all claim-owning sweeps separate declarations from liveness", () => {
  for (const path of claimOwningSkills) {
    const body = fs.readFileSync(path, "utf8");
    assert.match(body, /AUTO_SWEEP_CLAIM_DECLARATION/);
    assert.match(body, /auto-sweep-claim v1/);
    assert.match(body, /heartbeats? .*liveness only/i);
    assert.match(body, /auto-sweep-claim-close v1/);
  }
});

test("claim migration status reports legacy, orphan, active, and ambiguous claims", () => {
  assert.deepEqual(claimMigrationSummary(cards), { active: 1, legacyUnowned: 1, orphanDeclarations: 1, ambiguous: 1, ready: false });
});
```

- [ ] **Step 2: Run documentation tests and verify RED**

Run: `node --test tests/qa-sweep-doc.test.mjs tests/manual-sweep-doc.test.mjs tests/agents-snippet.test.mjs tests/linear-watch.test.mjs`  
Expected: FAIL because skills and diagnostics still describe heartbeat ownership.

- [ ] **Step 3: Update every sweep lifecycle contract**

Scheduled runs require both environment variables. Attended runs create both random tokens, post one declaration, add the label, final-read exact ownership, heartbeat by declaration, and close before every claim-affecting exit. QA terminal examples pass the sixth CLI declaration argument. Heartbeats explicitly say “liveness only; never ownership.”

- [ ] **Step 4: Add bounded migration status output**

```js
export function claimMigrationSummary(cards) {
  const results = cards.flatMap((card) => ALL_CLAIMS.filter((claim) => hasLabel(card, claim)).map((claim) => resolveCardClaim(card, claim)));
  return {
    active: results.filter((r) => r.status === "owned").length,
    legacyUnowned: results.filter((r) => r.status === "legacy-unowned").length,
    orphanDeclarations: results.filter((r) => r.status === "orphan-declaration").length,
    ambiguous: results.filter((r) => r.status === "ambiguous").length,
    ready: results.every((r) => ["owned", "closed", "unclaimed"].includes(r.status)),
  };
}
```

`node scripts/linear-watch.mjs claim-migration-status --json` performs read-only registered-workspace scans, complete-hydrates claim-bearing cards, emits bounded identifiers/reasons, and exits nonzero when fresh legacy or ambiguous claims prevent rollout.

- [ ] **Step 5: Update operator docs and config comments**

Document first-declaration-wins epochs, complete-history reads, close-before-mutation, legacy drain/reset, rollback restrictions, and the migration command. Preserve QA auto-ship, Factory Learning, manual handoff, and single-runner Ship language.

- [ ] **Step 6: Verify canonical mirrors and documentation tests**

Run:

```bash
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
cmp skills/dev-sweep/SKILL.md .claude/skills/dev-sweep/SKILL.md
cmp skills/qa-sweep/SKILL.md .claude/skills/qa-sweep/SKILL.md
cmp skills/ship-sweep/SKILL.md .claude/skills/ship-sweep/SKILL.md
cmp skills/manual-sweep/SKILL.md .claude/skills/manual-sweep/SKILL.md
cmp skills/unblock-sweep/SKILL.md .claude/skills/unblock-sweep/SKILL.md
node --test tests/qa-sweep-doc.test.mjs tests/manual-sweep-doc.test.mjs tests/agents-snippet.test.mjs tests/linear-watch.test.mjs
```

Expected: all comparisons and tests pass.

- [ ] **Step 7: Commit contracts and migration tooling**

```bash
git add skills .claude/skills scripts/linear-watch.mjs tests AGENTS.md README.md SETUP.md docs/linear-rules.md .claude/linear-sweep.json templates/linear-sweep.json
git commit -m "docs(COD-169): migrate sweeps to claim declarations"
```

### Task 7: Whole-feature verification and review

**Files:**
- Modify only files required by review findings.
- Update: `docs/superpowers/plans/2026-07-11-COD-169-immutable-claim-declarations-implementation.md` checkbox state.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a green branch, review evidence, Linear handoff, and no unresolved claim-lifecycle gaps.

- [ ] **Step 1: Run syntax, focused, and full verification**

```bash
node --check scripts/claim-ownership.mjs
node --check scripts/linear.mjs
node --check scripts/linear-watch.mjs
node --check scripts/learning.mjs
node --test tests/claim-ownership.test.mjs tests/linear.test.mjs tests/linear-watch.test.mjs
node --test tests/*.test.mjs
git diff --check origin/main...HEAD
```

Expected: every command exits `0`; the full suite has zero failures.

- [ ] **Step 2: Run policy and surface audits**

```bash
rg -n "latestHeartbeatOwner|latestClaimHeartbeat|heartbeatOwner" scripts tests skills .claude/skills
rg -n "AUTO_SWEEP_OWNER_TOKEN" scripts skills .claude/skills
rg -n "AUTO_SWEEP_CLAIM_DECLARATION|auto-sweep-claim-close|claim-migration-status" scripts tests skills .claude/skills README.md SETUP.md docs/linear-rules.md AGENTS.md
```

Expected: no production ownership caller uses the removed latest-heartbeat helpers; every owner-token lifecycle surface also carries declaration identity or is explicitly non-claim metadata.

- [ ] **Step 3: Request independent concurrency-focused code review**

Review the entire `origin/main...HEAD` diff for declaration race ordering, stale-child behavior, complete-history guarantees, close-before-mutation ordering, resume/reaper correctness, malformed input, and regressions to QA auto-ship/manual/Factory Learning/Ship.

- [ ] **Step 4: Fix findings with focused RED/GREEN tests**

For each accepted finding, first add a reproducing test, run it to observe failure, apply the smallest fix, rerun the focused suite, then rerun the full suite.

- [ ] **Step 5: Commit final review fixes and plan evidence**

```bash
git add <reviewed-files> docs/superpowers/plans/2026-07-11-COD-169-immutable-claim-declarations-implementation.md
git commit -m "fix(COD-169): close claim lifecycle review gaps"
```

- [ ] **Step 6: Update COD-169**

Move the card to Dev with `dev:in-progress` when code work starts. After verification, comment with branch, commits, test totals, migration output, review result, and any residual operational risk. Keep `sweep:manual-only` until the attended ship is complete.

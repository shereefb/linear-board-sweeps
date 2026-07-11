# COD-169 Task 4 Report

## Status

Implemented close-before-mutation lifecycle ownership, declaration-aware reaping, and resume v2 in `scripts/linear-watch.mjs`, with lifecycle regression coverage in `tests/linear-watch.test.mjs`.

## TDD evidence

### Cluster 1: declaration liveness, exact release, and resume v2

RED:

```text
node --test --test-name-pattern='reap|orphan|releaseOwned|resume|same-state|declaration' tests/linear-watch.test.mjs
5 failures after the temporary import stub: resume v2, declaration-time liveness, exact reap target, and close ordering were absent.
```

GREEN:

```text
node --test --test-name-pattern='reap|orphan|releaseOwned|resume|same-state|declaration' tests/linear-watch.test.mjs
29 passed, 0 failed
```

### Cluster 2: administrative reset boundary

RED:

```text
node --test --test-name-pattern='administrative reset' tests/linear-watch.test.mjs
3 failed: reset boundary was not exposed/verified by lifecycle tests.
```

GREEN:

```text
node --test --test-name-pattern='administrative reset' tests/linear-watch.test.mjs
3 passed, 0 failed
```

Coverage includes exact declaration reset, legacy reset, refreshed heartbeat, newer declaration, delayed duplicate reset, missing new boundary verification, and stranded closed-label cleanup.

### Cluster 3: stranded boundary liveness and ambiguity

RED:

```text
node --test --test-name-pattern='stranded closed label ages|stale stranded label' tests/linear-watch.test.mjs
2 failed: closed labels still aged from updatedAt/old heartbeat and bypassed normal stale proof.

node --test --test-name-pattern='ambiguous declared history' tests/linear-watch.test.mjs
1 failed: ambiguous history returned positive infinity and could become actionable.
```

GREEN: closed labels age from their exact close/reset boundary, delayed old heartbeats cannot refresh them, and ambiguous histories fail closed as live for admission while reapers skip them.

### Cluster 4: resume migration and state-scoped release

RED:

```text
node --test --test-name-pattern='exact v2 rediscovery' tests/linear-watch.test.mjs
1 failed: a v1 store prevented exact declared dirty-worktree rediscovery from persisting v2.

node --test --test-name-pattern='same-state release rechecks' tests/linear-watch.test.mjs
1 failed: state and ownership were read in separate pre-close fetches.
```

GREEN: v1 records protect nothing but a valid exact v2 rediscovery can replace the store; same-state scope and exact ownership are proven by the same pre-close reread.

## Implementation

- Added `closeOwnedClaim`, which reads complete history, proves exact `{ownerToken, claimDeclarationId}`, writes a close, verifies a newly visible exact close on a complete reread, then removes the label.
- Added `resetStaleClaimBoundary` for administrative reapers. It rechecks exact declaration/legacy target and stale liveness, writes a reset, verifies a newly visible exact reset, and only then permits label mutation.
- Migrated live-claim filtering, own reaps, foreign/orphan cleanup, release, dependency/routing/start-failure reconciliation, same-state completion, resume protection, resume discovery, and resume admission away from latest-heartbeat ownership.
- Reap decisions now carry exact reset targets and stale thresholds. Failed/no-op refresh checks are not reflected into in-memory scheduler state.
- Resume protection writes versioned declaration heartbeats. Resume comments and local records persist declaration identity.
- Bumped `RESUME_STATE_VERSION` to 2. Records without declaration identity and all v1 records are unreadable/protect nothing. Exact declared dirty-worktree rediscovery can safely replace an unhealthy old store.
- Resume discovery now uses resolved repository routing and the corresponding deterministic worktree.
- Closed-but-stranded labels age from their exact boundary and use the normal stale proof before legacy reset/removal.

The legacy `heartbeatOwner` / `latestHeartbeatOwner` helpers remain only for Task 3's explicit winner-only acquisition compatibility confirmation. No lifecycle consumer uses them.

## Verification

```text
node --test tests/claim-ownership.test.mjs tests/linear-watch.test.mjs
367 passed, 0 failed

git diff --check
clean
```

## Files changed

- `scripts/linear-watch.mjs`
- `tests/linear-watch.test.mjs`
- `.superpowers/sdd/task-4-report.md`

## Self-review

- Confirmed every label removal/addition in owned release or administrative reap follows a newly verified exact boundary.
- Confirmed stale children, refreshed claims, newer declarations, ambiguous histories, close/reset write failures, and verification failures do not mutate labels.
- Confirmed scheduler priority, routing, capacity, refill, and dispatch suites remain green.
- Confirmed retry/capacity resume records already receive the propagated declaration identity and now cannot persist without it.

## Concerns

No known Task 4 correctness concerns. Task 5 terminal CLI migration and Task 6 skill/document updates remain intentionally out of scope.

# COD-169: Immutable Claim Declarations

**Status:** Approved design, awaiting written-spec review  
**Date:** 2026-07-11  
**Issue:** COD-169  
**Related:** COD-142

## Problem

The launcher currently derives claim ownership from the newest matching heartbeat comment. That makes a heartbeat do two jobs: prove liveness and select the owner. A delayed stale child can therefore post a later heartbeat and appear to reclaim ownership after another child has legitimately taken over. Owner-token checks at terminal handoff reduce the blast radius, but they cannot make a mutable “latest heartbeat wins” ownership model safe across every release, blocker, recovery, and terminal path.

The redesign must make ownership immutable for one claim epoch. Heartbeats may extend liveness, but they must never create, replace, reopen, or transfer ownership.

## Goals

- Select one deterministic owner when same-stage claim attempts race.
- Prevent delayed heartbeats from changing ownership.
- Require the same ownership proof before every claim-affecting mutation.
- Make release, reaping, blocker, recovery, and terminal paths close ownership explicitly.
- Fail closed on incomplete, malformed, or internally inconsistent Linear comment history.
- Preserve the existing workflow labels, stage limits, routing, resume behavior, and Ship safety gates.
- Provide a bounded, safe transition for legacy heartbeat-only claims.

## Non-goals

- Atomic compare-and-swap semantics that Linear does not expose.
- A new database, lock service, Linear workflow state, or issue label.
- Changing dispatch priority, stage concurrency, QA auto-ship policy, or deployment behavior.
- Allowing ownership transfer between live children. A new owner always starts a new epoch.

## Approaches Considered

### 1. First declaration wins within an explicit epoch — recommended

Each claim attempt writes one immutable declaration. The earliest valid declaration in the open epoch is the owner. A close marker ends the entire epoch, including losing declarations. Heartbeats reference a declaration and affect only its liveness.

This works with Linear’s append-only comments, needs no shared storage, and makes delayed stale heartbeats harmless. It also gives every mutation one resolver and one proof contract.

### 2. Latest signed lease with a sequence number

A launcher could write monotonically increasing leases and accept the largest sequence. Cross-host launchers have no atomic shared sequence allocator, so equal or reordered sequences still need a winner rule. Local state would also become an unsafe source of truth after host loss. This adds machinery without removing the core race.

### 3. Dedicated ownership issue or external lock service

A separate Linear issue, database row, or distributed lock could provide stronger primitives. It would add infrastructure, credentials, lifecycle cleanup, and a second operational dependency for a coordination problem that append-only comments can solve safely enough. This is disproportionate to the kit.

## Marker Protocol

All ownership markers are versioned and single-line. Values are bounded, whitespace-free tokens.

```text
[auto-sweep-claim v1 claim=<stage:in-progress> owner=<owner-token> declaration=<uuid>]
[auto-sweep-heartbeat v1 claim=<stage:in-progress> declaration=<uuid> at=<ISO8601>]
[auto-sweep-claim-close v1 claim=<stage:in-progress> declaration=<uuid> reason=<released|reaped|orphaned|terminal|blocked|failed>]
[auto-sweep-claim-reset v1 claim=<stage:in-progress> target=<declaration-id|legacy> reason=<legacy|orphan-declaration>]
```

Linear’s comment `createdAt` and comment ID define deterministic order; the body timestamp is evidence only. Sort by `createdAt` ascending, then comment ID ascending. A marker prefix that targets the relevant claim but does not parse exactly is an ambiguity and fails resolution closed.

`owner-token` remains a unique per-dispatch value. `declaration` is a separate random UUID exported to the child as `AUTO_SWEEP_CLAIM_DECLARATION`. Keeping them separate prevents code from silently treating any observed owner token as authority to manufacture a declaration.

## Ownership State Machine

For one stage claim label:

1. Read every ownership marker through complete, cycle-safe pagination.
2. Find the most recent valid close or reset boundary.
3. Consider only declarations created after that boundary.
4. The earliest valid declaration is the sole owner of the open epoch.
5. Later declarations in that epoch are losing race attempts and never become owner.
6. A valid close must reference the current declaration. It closes the whole epoch, including all losing declarations posted before it.
7. A duplicate or delayed close for a declaration that already won and closed its epoch is a harmless no-op. It cannot affect a later epoch.
8. A reset targets one exact orphan declaration or the explicit legacy epoch. A delayed reset whose target is already closed is a harmless no-op.
9. A close for an unknown or losing declaration, or a reset whose target never owned the resettable epoch, is ambiguous and fails closed.
10. A new owner requires a declaration created after the close boundary.
11. The claim is actionable only when the expected stage claim label is present and the open declaration is valid.

Unknown/losing close references, invalid reset targets, duplicate declaration IDs with different facts, unreadable timestamps, incomplete pages, and malformed relevant markers return an explicit unreadable/ambiguous result. Callers must not mutate Linear in that state. Duplicate closes and resets for an already-closed exact target are intentionally idempotent.

This “first declaration wins” rule is the key safety property. If two launchers race, the deterministic first declaration owns the epoch. If the loser or an old child posts later, it cannot displace the winner. When the winner closes, every declaration from that epoch is retired; a losing declaration cannot become owner later.

## Claim Acquisition

The launcher or attended sweep uses this order:

1. Complete-read the card and require the expected state, no blocking or foreign claim, and no stage claim label.
2. Require no open declaration. A recent orphan declaration without a label is preserved for reconciliation rather than bypassed.
3. Post a fresh declaration with new owner and declaration tokens.
4. Add the stage claim label without replacing unrelated labels.
5. Complete-read state, labels, and comments again.
6. Dispatch only if the label is present and the resolver names the exact new declaration and owner.

Two contenders may both post declarations and add the idempotent label. The earliest declaration wins; every loser stops without removing the shared claim label. A crash after declaration but before label addition leaves a bounded orphan declaration. Reconciliation waits for its stale interval, posts an administrative reset, and only then permits a fresh epoch.

## Heartbeats and Liveness

A heartbeat carries the claim and declaration ID but no ownership authority. Before posting, a child complete-reads the card and verifies that its declaration is active. A heartbeat that arrives late after close is ignored because it references a closed declaration.

Liveness is the newest valid heartbeat for the active declaration, falling back to the declaration’s `createdAt`. Heartbeats for losing, closed, unknown, or malformed declarations never keep the active owner alive.

The launcher’s reaper:

1. Resolves the active declaration from complete history.
2. Computes liveness only for that declaration.
3. When stale, posts a `reason=reaped` close marker referencing it.
4. Re-reads and proves the epoch is closed.
5. Removes only the exact stage claim label.

## Closing and Mutation Ordering

Every release-like path uses close-before-mutation ordering:

1. Complete-read and prove the caller owns the active declaration, or prove the administrative stale/reset condition.
2. Post the exact close/reset marker.
3. Complete-read and verify that the marker closed the intended epoch.
4. Remove the claim label, optionally in the same `issueUpdate` that performs a guarded state transition.

After the close marker, the old child has no authority even if label removal or a state transition fails. A stranded label with a closed epoch is fail-closed and cleanup-safe: reconciliation may remove the label, but no worker may dispatch under it. New acquisition waits until the label is absent.

The same helper contract applies to:

- successful same-state release;
- QA moves to Signoff or Ship;
- Ship moves to Done;
- blocker and direct-human stops;
- child spawn/defer orphan cleanup;
- retry cooldown handoff;
- stale reaping;
- resume-store release and recovery;
- manual sweep handoffs.

## Components

### Shared pure resolver

Add a small shared module used by both `scripts/linear-watch.mjs` and `scripts/linear.mjs`. It owns marker parsing, ordering, epoch folding, ownership resolution, and liveness selection. It performs no network or filesystem I/O.

### Launcher orchestration

Replace heartbeat-derived ownership checks in claim confirmation, actionable filtering, resume admission, retry/orphan cleanup, reaping, and same-state completion. Persist the declaration ID beside the owner token in picks, child environment, run records, and resume records.

### Guarded CLI mutations

Update terminal and release helpers to accept the declaration ID and resolve exact ownership from a complete final read. Mutation inputs continue to remove only the proven claim label ID and preserve unrelated labels.

### Sweep contracts

Update canonical and mirrored Spec, Dev, QA, Ship, manual, and unblock instructions so attended and scheduled runs declare once, heartbeat by declaration, and close before every claim-affecting exit. Scheduled children receive both owner and declaration environment variables.

### Operator documentation

Document marker grammar, migration behavior, diagnostics, and the distinction between ownership and liveness. Existing auto-ship and Factory Learning rules remain unchanged.

## Legacy Migration

Heartbeat-only claims are never upgraded into declaration ownership by inference.

- A card with a stage claim label but no declaration is `legacy-unowned`.
- Legacy heartbeats may postpone cleanup during the rollout drain window, but they never authorize a mutation in new code.
- New dispatches do not use or replace a legacy-unowned claim.
- After the stage stale interval, reconciliation posts `claim-reset reason=legacy`, re-reads it, and removes the label.
- A declared rollout preflight reports remaining legacy-unowned claims so operators can drain active children before enabling the new launcher.

This may temporarily pause a legacy card, but it cannot assign ownership to the wrong child. Safety wins over uninterrupted migration.

## Error Handling

- Incomplete comment pagination: unreadable, no mutation.
- Pagination cursor cycle: unreadable, no mutation.
- Malformed relevant marker: ambiguous, no mutation.
- Conflicting duplicate declaration ID: ambiguous, no mutation.
- Close references an unknown or losing declaration: ambiguous, no mutation.
- Duplicate/delayed close references an already-closed winning declaration: ignore as an idempotent no-op.
- Reset target is unknown or never owned the resettable epoch: ambiguous, no mutation.
- Duplicate/delayed reset references an already-reset exact target: ignore as an idempotent no-op.
- Label present with no open declaration: stranded/legacy, no dispatch.
- Open declaration without label: orphan declaration, preserve until bounded reset.
- Owner or declaration mismatch: lost ownership, stop without label removal.
- Close posted but label mutation fails: closed-stranded claim; reconciliation removes only that label.

Diagnostics expose stable reason codes and bounded identifiers, never secrets or raw environment values.

## Testing

### Pure resolver matrix

- one declaration and matching heartbeats;
- two simultaneous declarations, deterministic first winner;
- losing declaration never promoted after winner closes;
- delayed old heartbeat after a close and new epoch;
- heartbeat for unknown or losing declaration;
- malformed marker, timestamp, duplicate ID, unknown/losing close, invalid reset target, incomplete pages, and cursor cycles;
- delayed duplicate close/reset after a newer epoch remains a no-op and cannot poison or close that epoch;
- declaration without label and label without declaration;
- legacy heartbeat-only claim;
- stage isolation across Spec, Dev, QA, and Ship claims.

### Launcher behavior

- claim race confirmation dispatches only the winning declaration;
- loser never removes the winner’s label;
- actionable filtering and reaping use declaration liveness;
- orphan, retry, same-state release, and resume paths require exact declaration proof;
- stale child heartbeat/release cannot affect a newer epoch;
- environment, capacity refill, handoff, and run records preserve declaration ID.

### CLI and skill contracts

- guarded terminal moves require owner plus declaration;
- close-before-mutation and final complete-read ordering;
- delta label removal remains intact;
- canonical/mirrored skill equality;
- all stages document declaration heartbeats and ownership loss;
- QA auto-ship, Factory Learning exclusion, manual handoff, and Ship checks remain unchanged.

### Full verification

- Node syntax checks for all changed scripts;
- focused claim suites;
- complete `node --test tests/*.test.mjs` suite;
- JSON/config parsing and skill mirror comparisons;
- `git diff --check`;
- independent concurrency-focused review before landing.

## Rollout and Recovery

1. Stop new scheduled dispatch and allow currently running legacy children to drain.
2. Upgrade launcher, CLI helpers, and all installed sweep skill copies together.
3. Run the legacy-claim diagnostic.
4. Preserve fresh legacy claims; reset only after their configured stale interval.
5. Re-enable dispatch when no fresh legacy-unowned claims remain.

Rollback disables new dispatch first. Existing declaration comments remain harmless audit history. The previous launcher must not be restarted against declaration-owned live claims because it would reinterpret heartbeats as ownership; rollback therefore waits for declaration claims to close or requires attended cleanup.

## Acceptance Criteria

- A heartbeat can never alter the resolved owner.
- A losing or stale declaration can never become owner after an epoch closes.
- No claim-affecting mutation succeeds without exact active declaration proof or an explicit administrative stale/reset proof.
- Every ownership decision comes from the shared resolver over complete Linear history.
- Legacy claims fail closed and drain without being silently reassigned.
- Existing scheduling, resume, manual sweep, QA auto-ship, Factory Learning, and Ship behavior remain green under the new ownership protocol.

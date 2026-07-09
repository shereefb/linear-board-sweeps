# COD-104: Manual Next Sweep Trigger Design

Linear: COD-104
Status: planned
Date: 2026-07-09

## Problem

The scheduled launcher runs one sweep pass when a card is eligible in a watched queue. When that sweep completes and moves the card to the next queue, the card waits for the next scheduler tick before the next sweep starts. The card asks for each sweep to manually trigger the next sweep after a successful handoff, using the same preflight guards as the scheduler.

The tempting implementation is for a child sweep to run `node scripts/linear-watch.mjs tick` or invoke the next skill directly. That is unsafe. The parent launcher holds the tick lock while child sweeps run, so a child-spawned tick normally no-ops. A direct child invocation would bypass the launcher's project activation, same-repo slot, owner-token claim, ship-runner, and failure Todo reconciliation logic.

## Goals

- Reduce handoff latency after successful forward moves.
- Reuse the launcher's existing scan, filter, capacity, claim, dispatch, and failure-reconciliation paths.
- Allow automated next-stage handoffs for:
  - spec-sweep landing a card in `Ready for Dev`;
  - dev-sweep landing a card in `In Review`.
- Preserve the human shipping gate: QA landing in `QA Passed` must not trigger ship.
- Keep trigger behavior bounded so a card cannot recurse forever through spec/dev/QA bounces.
- Work both before and after COD-102's state rename by defining behavior in terms of the configured sweep queues, not hardcoded prose alone.

## Non-goals

- Do not let sweep skills invoke the next skill directly.
- Do not run ship automatically from `QA Passed`.
- Do not bypass `auto-sweep` project activation.
- Do not change queue priority, card sort order, claim labels, or same-repo concurrency limits.
- Do not depend on COD-98 being implemented first. The implementation may reuse COD-98 helpers if they exist, but COD-104 must stand on its own.

## Existing Mechanism

`scripts/linear-watch.mjs tick` currently owns the safe dispatch path:

1. Acquires the tick lock.
2. Loads registered anchors.
3. Fast-forwards kit and anchor workspaces.
4. Filters projects by the `auto-sweep` activation label.
5. Reaps stale claims and bounces oscillating cards.
6. Builds queue candidates from `SWEEP_CFG`.
7. Selects a bounded batch through `selectDispatchBatch()`.
8. Pre-claims same-repo card slots with owner-token heartbeats.
9. Dispatches child agents with `AUTO_SWEEP_ISSUE` for per-card work.
10. Reconciles child failures into self-clearing Todo cards.
11. Releases the tick lock.

This path already contains the guardrails COD-104 needs. The missing feature is a launcher-owned way to react after child completion and ask whether the completed card's new queue is eligible for another dispatch.

## Proposed Behavior

Add a launcher-owned handoff trigger that runs after a child sweep completes and before the parent tick exits. The child skill does not spawn a new launcher process. Instead, the parent supervisor re-reads Linear state after child completion and, if the completed card moved into a configured automated next queue, schedules that next sweep through the same selection and dispatch machinery.

Recommended transition map:

| Completed sweep | Eligible destination queue | Triggered sweep |
|-----------------|----------------------------|-----------------|
| `spec` | `Ready for Dev` / configured dev source | `dev` |
| `dev` | `In Review` / configured qa source | `qa` |
| `qa` | none | none |
| `ship` | none | none |

After COD-102, the same logical map becomes `Spec -> Dev -> QA -> Signoff -> Ship`, with only `spec -> dev` and `dev -> qa` automated.

The trigger should be forward-only and card-specific. If a child sweep bounces a card backward, moves it to `Todo`, leaves it blocked, or fails, no downstream trigger runs. If a child sweep completes but the project was deactivated while it was running, no downstream trigger runs.

## Launcher Shape

Implement the feature by extracting a reusable one-pass dispatch helper from `tick()` if COD-98 has not already done so. Then add a bounded handoff supervisor around child completion:

```text
tick
  +-- scan and select normal scheduler batch
  +-- dispatch selected child sweeps
  +-- for each successful child result:
        +-- re-read the completed issue
        +-- derive next sweep from current state and completed sweep
        +-- re-run activation, blocking, claim, capacity, and ship guards
        +-- dispatch the next sweep for that issue only when eligible
        +-- reconcile failures for that downstream dispatch
  +-- stop at max trigger hops
```

The downstream dispatch must use the same parent-owned `dispatchBatch()`/same-repo slot path rather than a bespoke child process call. For the triggered card, pass `AUTO_SWEEP_ISSUE=<KEY-###>` so the downstream sweep processes only that card. If the selected next queue contains higher-priority cards, the trigger may still only run the completed card because COD-104 is about handoff continuity for that feature card. Normal scheduler ticks continue to handle board-order priority across the whole queue.

## Trigger Bounds

Add explicit recursion controls:

- `parallel.maxHandoffTriggerHops`, default `2`, clamp `0..3`.
- One transition marker per launcher run and issue/sweep pair, stored in memory for the current tick.
- Trigger only on forward transitions in the map above.
- Never trigger when the issue has a blocking label, a live claim for the next sweep, or a destination outside the next sweep's configured source states.
- Never trigger ship from QA output. The human move from `QA Passed`/`Signoff` to `Ready to Ship`/`Ship` remains mandatory.

This permits a full spec-to-dev-to-QA chain in one supervised tick while stopping before human signoff. It also prevents repeated spec/dev/QA loops when dev or QA bounces a card backward.

## Brainstormed Approaches

### A) Parent-owned handoff supervisor (recommended)

Completeness: 10/10. The launcher already owns locks, activation, capacity, claims, and failure Todos. Adding handoff supervision there reduces latency without splitting safety logic across skills.

### B) Child calls `node scripts/linear-watch.mjs tick`

Completeness: 3/10. It appears simple, but the parent tick lock is held while the child runs, so the nested tick normally exits without dispatching. If changed to wait for the lock, it risks orphaned background work and unclear failure reporting.

### C) Child invokes the next skill directly

Completeness: 2/10. This bypasses project activation, same-repo slot limits, owner-token preclaims, ship-runner checks, and failure Todo reconciliation. It is not acceptable for scheduled automation.

Net: keep downstream triggering inside the launcher.

## Engineering Review

### D1 - Trigger owner

ELI10: The scheduler is the traffic light. A sweep card should not drive through the next intersection by itself after finishing one step. It should tell the traffic light what happened, and the traffic light decides whether the next car can go.

Recommendation: A because all existing safety checks already live in the launcher.

A) Parent-owned supervisor after child completion (recommended). Completeness: 10/10. It keeps dispatch centralized and lets the launcher reuse its exact preflight and claim logic.

B) Child-spawned launcher tick. Completeness: 3/10. It conflicts with the parent lock and has weak observability.

C) Child-spawned next skill. Completeness: 2/10. It bypasses the launcher's safety model.

Net: implement parent-owned handoff dispatch.

### D2 - Scope of automatic chaining

ELI10: The system can automatically go from planning to coding and from coding to QA. It must stop before shipping, because a person has to approve shipping.

Recommendation: A because it respects the production gate.

A) Trigger `spec -> dev` and `dev -> qa`, stop after QA (recommended). Completeness: 10/10. It removes avoidable waiting while preserving human signoff.

B) Trigger `qa -> ship` too. Completeness: 4/10. It violates the board's core safety guarantee unless a human has already moved the card to the ship queue.

C) Only trigger `spec -> dev`. Completeness: 7/10. It helps but leaves dev-to-QA latency unsolved.

Net: automate only the non-production handoffs.

### D3 - Priority semantics

ELI10: If this feature just finished spec, should the system keep following it into dev, or should it look at the top of the whole Dev column? COD-104 is asking to continue the feature that just moved, while normal ticks still enforce board priority globally.

Recommendation: A because it matches the card while keeping ordinary scheduler behavior unchanged.

A) Trigger the completed issue only with `AUTO_SWEEP_ISSUE` (recommended). Completeness: 9/10. It avoids surprising extra work and keeps the downstream run tied to the handoff.

B) Trigger the whole next queue. Completeness: 7/10. It honors board priority, but it can turn one card completion into unrelated downstream work.

C) Only set a nudge flag for the next timer tick. Completeness: 5/10. It preserves priority but does not materially reduce handoff latency.

Net: use card-specific handoff dispatch and leave full-queue draining to COD-98/regular ticks.

### Scope Challenge

What already exists:

- `SWEEP_CFG` defines source states and claim labels for each scheduled sweep.
- `selectDispatchBatch()` enforces ship serial behavior and non-ship capacity.
- `claimCardSlots()` preclaims exact same-repo card slots with owner-token heartbeats.
- `dispatchBatch()` already knows how to run card-specific children with `AUTO_SWEEP_ISSUE`.
- Failure Todo reconciliation already runs from parent-owned dispatch scopes.

Minimum complete change:

- Extract or reuse a single-pass dispatch helper that can be called after child completion.
- Return structured child results from `dispatchBatch()` with issue identifier, sweep, status, and dispatch scope.
- Add a forward-only handoff map and bounded handoff loop.
- Re-read the issue after each child completes and dispatch only if it is still eligible in the next queue.
- Add tests for lock avoidance, activation, capacity, human gate, failure Todo scope, and loop bounds.

### Architecture Review

[P1] `tick()` holds the lock until children finish. A child-spawned `tick` cannot be the primary design.

[P1] Same-repo and disjoint-repo capacity are parent decisions. The implementation must not invoke next-stage commands outside `selectDispatchBatch()` and `claimCardSlots()`.

[P1] QA output must stop at `QA Passed`/`Signoff`. Ship remains human-gated and ship-runner-gated from `Ready to Ship`/`Ship`.

[P2] Project activation can change while a child is running. Handoff evaluation must re-check the active project label before dispatching downstream work.

[P2] Failure Todo reconciliation must run for triggered downstream dispatches using a distinct scope so failures are visible and self-clearing.

Failure scenario 1: spec completes, child runs nested `tick`, parent lock makes it no-op, and dev waits until the next timer. Mitigation: no child-spawned ticks.

Failure scenario 2: dev completes, child calls qa-sweep directly, and same-repo QA starts while another QA slot is active. Mitigation: all downstream dispatches run through parent selection and claim code.

Failure scenario 3: QA completes and automatically triggers ship. Mitigation: transition map has no QA handoff and tests assert that `QA Passed`/`Signoff` never launches ship.

Failure scenario 4: a bounced card loops between spec and dev. Mitigation: forward-only map, max hops, per-run transition marker, and existing bounce escalation on subsequent scans.

### Code Quality Review

Do not add a second scheduler command for this feature. The clean design is to make `tick()`'s orchestration composable enough to dispatch a follow-up card while it still owns the lock and run context.

Keep state names behind `SWEEP_CFG` where possible. COD-102 is planned to rename queues, so COD-104 should compare against the next sweep's configured source states rather than duplicating `Ready for Dev` or `In Review` in multiple places.

### Test Review

Required coverage:

```text
handoff trigger
  +-- [GAP] child completion can dispatch next sweep without nested tick
  +-- [GAP] spec landing in dev source triggers dev for the same issue
  +-- [GAP] dev landing in qa source triggers qa for the same issue
  +-- [GAP] qa landing in QA Passed/Signoff does not trigger ship
  +-- [GAP] deactivated project suppresses trigger
  +-- [GAP] blocked issue suppresses trigger
  +-- [GAP] live next-sweep claim suppresses trigger
  +-- [GAP] same-repo slot limit suppresses or defers trigger
  +-- [GAP] downstream dispatch failure reconciles a failure Todo
  +-- [GAP] maxHandoffTriggerHops bounds recursion
```

Run `node --test` after implementation.

### Performance Review

The feature adds extra Linear reads only after a real child sweep completes. Idle ticks stay cheap. Worst-case downstream dispatch is bounded by `maxHandoffTriggerHops`, same-repo card limits, and existing non-ship dispatch limits. No additional polling loop or background daemon is required.

## DevEx Review

Classification: CLI/operator automation workflow.

Developer persona: maintainer running unattended Linear sweeps who expects cards to keep moving through non-production stages without waiting ten minutes between every successful handoff.

Mode: workflow polish.

DX scorecard:

| Dimension | Current | Target | Plan requirement |
|-----------|---------|--------|------------------|
| Getting started | 8/10 | 8/10 | No new setup command required. |
| CLI/API design | 7/10 | 8/10 | Add config only for optional trigger hop tuning. |
| Error messages | 7/10 | 8/10 | Logs should name skipped trigger reasons. |
| Documentation | 7/10 | 8/10 | README explains automated spec/dev and dev/QA handoffs. |
| Upgrade path | 8/10 | 8/10 | Default-on bounded behavior, no migration. |
| Dev environment | 8/10 | 8/10 | Existing `node --test` verifies orchestration. |
| Measurement | 7/10 | 8/10 | Run records should identify triggered downstream runs. |

TTHW target: an operator should understand that successful spec and dev handoffs may continue immediately, while QA still stops for human signoff.

Magical moment: a card that finishes spec is claimed for dev in the same supervised run, with logs showing the normal scheduler guards were still applied.

## Independent Adversarial Review

The independent reviewer found:

- Calling `tick` from a child conflicts with the parent tick lock and usually no-ops.
- Direct child-spawned downstream sweeps bypass `selectDispatchBatch()`, same-repo limits, and owner-token preclaims.
- QA must not trigger ship because QA intentionally stops at the human signoff queue.
- Child-triggered work must re-check project `auto-sweep` activation.
- Downstream failures must reconcile failure Todos through the parent dispatch scope.
- Recursive trigger storms need explicit forward-only and max-hop bounds.

All findings are folded into this design.

## Schema & Architecture Impact

Add optional config:

```json
{
  "parallel": {
    "maxHandoffTriggerHops": 2
  }
}
```

Default is `2`, clamped to `0..3`. `0` disables handoff triggers while preserving normal scheduled ticks.

Run records should mark triggered downstream dispatches with a `triggeredBy` field containing the upstream issue and sweep. If structured run records are not yet available in the implementation branch, logs must include equivalent metadata.

## Acceptance Criteria

- A successful spec-sweep handoff can start dev-sweep for the same card before the next scheduled timer.
- A successful dev-sweep handoff can start qa-sweep for the same card before the next scheduled timer.
- QA completion never triggers ship.
- Triggered downstream dispatches reuse launcher activation, blocking, live-claim, capacity, same-repo slot, owner-token, ship-runner, and failure Todo checks.
- Trigger recursion is bounded and forward-only.
- Tests cover lock avoidance, ship gate preservation, activation pause, capacity checks, failure Todo reconciliation, and loop bounds.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Brainstorming | `/brainstorming` | Explore safe trigger ownership | 1 | CLEAR | Parent-owned launcher handoff beats child-spawned tick or direct skill invocation |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | Reuse launcher scan/select/claim/dispatch/failure paths; bound recursion |
| DX Review | `/plan-devex-review` | Operator workflow | 1 | CLEAR | Default-on non-production handoffs reduce wait time without setup changes |
| Independent Adversarial | subagent | Lock, capacity, and gate review | 1 | CLEAR | Folded in lock avoidance, activation re-check, failure Todo scope, and QA stop |

- **VERDICT:** ENG + DX + ADVERSARIAL CLEARED - ready to implement.

NO UNRESOLVED DECISIONS

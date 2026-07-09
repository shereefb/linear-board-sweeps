# COD-113: Better Parallel Work Design

Linear: COD-113
Status: planned
Date: 2026-07-09

## Problem

Same-repo parallel development starts strong and then tapers. A launcher tick can claim and dispatch four `dev` cards for one repo, but as each card finishes and moves to `QA`, the parent launcher only follows that completed card into QA. It does not backfill the freed `dev` slot with the next actionable `Dev` card until a later drain pass or scheduler tick. In practice, a batch that began with four development cards can degrade toward one active card while the board still has available `parallel.sameRepoCardLimits.dev` capacity.

The current behavior is understandable from the implementation:

- `sameRepoCardLimit()` defines per-sweep same-repo card capacity, defaulting `dev` to 4 (`scripts/linear-watch.mjs:355`).
- `expandDispatchBatch()` turns one selected workspace/sweep candidate into the initial card slots once, before the batch starts (`scripts/linear-watch.mjs:1334`).
- `dispatchBatch()` reports child completion as soon as each child exits, which is the right place to react to freed capacity (`scripts/linear-watch.mjs:1565`).
- `runHandoffTriggers()` can start the next sweep for the completed card, but its budget is capped by `maxNonShipDispatches`, not by freed same-repo card slots (`scripts/linear-watch.mjs:1645`, `scripts/linear-watch.mjs:1698`, `scripts/linear-watch.mjs:1922`).
- The docs currently say follow-up handoffs spend at most `parallel.maxNonShipDispatches`, so the visible behavior matches the documented cap but not the user's expectation for steady-state same-repo capacity (`README.md:70`, `SETUP.md:176`).

COD-98 already backfills after a whole supervised pass finishes by rescanning in `runDrainLoop()`. COD-113 is specifically about mid-batch refill while sibling children are still running.

## Goals

- Keep same-repo non-ship sweeps near their configured per-card capacity while a parent tick is already supervising child agents.
- When a `dev` child successfully moves a card to `QA`, let the parent launcher claim and dispatch the next actionable `Dev` card if the `dev` slot was freed.
- Apply the same pattern to `spec` where useful, because `spec` also has same-repo card slots and produces `Dev` cards.
- Preserve QA's deliberate serial default and preserve the human ship gate.
- Reuse the existing scan, blocking, claim, owner-token, checkout, dispatch, handoff, and failure-Todo paths instead of building a second scheduler.
- Keep the behavior bounded so a busy queue cannot turn one launchd tick into an unbounded daemon.

## Non-goals

- Do not let child sweeps invoke `tick` or the next skill directly.
- Do not trigger ship from QA or Signoff.
- Do not change Linear board order semantics.
- Do not change the meaning of `parallel.maxNonShipDispatches` for cross-anchor workspace selection.
- Do not increase QA parallelism by default. QA stays `1` unless a repo explicitly changes `parallel.sameRepoCardLimits.qa`.
- Do not implement app code, migrations, or production deployment work in this spec.

## Brainstormed Approaches

### A) Parent-owned same-repo capacity replenishment (recommended)

Completeness: 10/10. The parent launcher already holds the tick lock, knows which child slot completed, and has access to the same claim and dispatch helpers. On each successful child completion, it can re-read the relevant sweep queue, count live claims plus running child processes for that `(anchor, sweep)`, and claim enough new cards to refill the configured same-repo limit.

This directly answers the card: if one of four Dev children moves to QA, the parent can claim the next Dev card while the other three continue running.

### B) Rely on bounded drain passes

Completeness: 5/10. `runDrainLoop()` already re-scans after a whole selected batch finishes. That catches work that arrives after a pass, but it does not react when one child finishes while three sibling children are still running. The taper remains visible during long-running batches.

### C) Raise `maxNonShipDispatches`

Completeness: 3/10. This changes cross-anchor workspace fan-out, not same-repo child capacity. It also spends more global dispatch budget without guaranteeing that the next `Dev` card in the same repo is claimed when a slot opens.

Net: implement parent-owned same-repo backfill on child completion, bounded by existing same-repo limits and a small per-tick refill budget.

## Proposed Behavior

Add a launcher-owned "capacity refill" step after each successful non-ship child result:

```text
parent tick
  +-- select workspace/sweep candidate
  +-- claim up to sameRepoCardLimit(sweep) card slots
  +-- dispatch children concurrently
  +-- as each child succeeds:
        +-- reconcile dispatch result
        +-- run existing card-specific handoff if applicable
        +-- refill the completed child's original sweep if capacity is now open
        +-- dispatch refilled child through the same parent path
  +-- stop at configured refill bounds
```

For COD-113's main case:

```text
Dev queue: COD-1 COD-2 COD-3 COD-4 COD-5 COD-6
sameRepoCardLimits.dev = 4

initial: dispatch COD-1..COD-4
COD-2 finishes -> moves to QA
parent handoff: may start QA for COD-2
parent refill: claim COD-5 for dev slot 4
COD-1 finishes -> parent refill claims COD-6
```

Refill is sweep-specific. A `dev` child completion refills the `dev` queue, not the next `qa` queue. The existing handoff trigger remains responsible for the completed card's next stage. This separates two different jobs:

- **Handoff:** continue the completed card forward.
- **Refill:** keep the original same-repo worker pool full.

## Bounds

Add a config field:

```json
{
  "parallel": {
    "maxSameRepoRefillDispatches": 8
  }
}
```

Default: `8`, clamp `0..20`. `0` disables same-repo refill. The default is intentionally larger than the default `dev` slot count of 4 so one long tick can refill more than once, but still cannot loop forever.

Refill eligibility:

- Only non-ship sweeps can refill.
- The completed child must have an `issueIdentifier` and a successful exit code.
- The original sweep must still have actionable cards in its configured source state.
- The parent must re-check project activation.
- Blocking labels and live claims suppress refill.
- Checkout dirty blockers suppress refill and reconcile the existing failure Todo path.
- The launcher must count in-flight child results for the same `(anchorPath, sweep)` so it does not exceed `sameRepoCardLimit`.
- Refilled children use the same `AUTO_SWEEP_ISSUE`, isolated worktree/log/temp/port path setup, owner-token heartbeat claim, run record, failure-Todo reconciliation, and handoff trigger handling as initial children.

## Engineering Review

### D1 - What budget owns refill?

ELI10: There are two kinds of "parallel" here. One budget says how many different workspaces can run at once. Another says how many cards inside one repo can run at once. COD-113 is about the second budget, so using the first one makes the pool look full when it is actually missing workers.

Recommendation: A because the fix should replenish same-repo slots without changing cross-anchor scheduling.

A) Add `maxSameRepoRefillDispatches` and count active children per `(anchor, sweep)` (recommended). Completeness: 10/10. It addresses the taper directly and keeps the global workspace budget intact.

B) Reuse `maxNonShipDispatches` for refill. Completeness: 5/10. It is simpler but repeats the current mismatch: a four-card same-repo batch can exhaust a two-slot global budget.

C) Wait for `maxDrainPasses`. Completeness: 4/10. It is already implemented, but it only helps after a whole pass settles.

Net: same-repo refill needs its own bounded budget and active-slot accounting.

### Scope Challenge

What already exists:

- `sameRepoCardLimit()` already defines the target slot count per sweep.
- `claimCardSlots()` already applies owner-token claims and confirmation.
- `expandDispatchBatch()` already builds isolated per-card dispatch picks.
- `dispatchBatch()` already has an `onResult` callback when a child completes.
- `runHandoffTriggers()` already handles card-specific `spec -> dev` and `dev -> qa` continuation.
- Failure Todo reconciliation already handles dispatch failures by scope.

Minimum complete change:

- Extract a reusable helper for "claim and dispatch up to N slots for this same `(anchor, sweep)` candidate" so initial dispatch and refill share behavior.
- Track active child counts by `(anchorPath, sweep)` inside one parent tick.
- After successful non-ship child completion, refill that child's original sweep up to available same-repo capacity and per-tick refill budget.
- Wire refilled child results back through the same reconciliation and handoff callbacks.
- Add tests for the taper scenario, bounds, suppression, and no ship trigger.

### Architecture Review

The safest architecture is still parent-owned scheduling. A child sweep cannot see sibling child state, cannot safely mutate the launcher's in-memory budgets, and should not bypass the parent tick lock. The parent already receives child completion via `dispatchBatch(... onResult)` and can use that as the capacity signal.

Implementation should avoid stale queue data. Refill must fetch the current source-state cards before claiming. Otherwise it can re-claim a card already moved or blocked by a sibling result.

Failure scenario: four Dev children start, one exits quickly, and refill dispatches five total active Dev children because it counts completed processes but not still-running siblings. Mitigation: maintain an active count per `(anchorPath, sweep)`, decrement before refill, increment for every successfully claimed refill dispatch.

Failure scenario: the refilled child exits and its own success should also refill the pool. Mitigation: refilled dispatches must attach the same `onResult` pipeline as initial dispatches, including reconciliation, handoff, and refill.

Failure scenario: a child completion triggers both a QA handoff and a Dev refill, and both calls derive child ports from a local `childIndex = 0`. `expandDispatchBatch()` currently resets `childIndex` per call, and `cardRunPaths()` derives ports from that index. Mitigation: move per-parent child index allocation out of individual expansion calls so all initial, handoff, and refill children in one tick get unique run paths and ports.

### Code Quality Review

Keep the change inside `scripts/linear-watch.mjs` orchestration helpers and `tests/linear-watch.test.mjs`. Do not create a new daemon or a new scheduler command.

Name the concept plainly: "same-repo refill" or "slot refill". Avoid overloading "handoff" because that already means continuing one completed card into the next sweep.

### Test Review

Required coverage:

```text
same-repo refill
  +-- [GAP] initial dev dispatch claims four cards when limit is 4
  +-- [GAP] one successful dev child completion decrements active dev count
  +-- [GAP] refill claims the next top Dev card and dispatches it
  +-- [GAP] refill does not exceed sameRepoCardLimit with siblings still running
  +-- [GAP] refill budget exhaustion stops additional claims
  +-- [GAP] maxSameRepoRefillDispatches = 0 disables refill
  +-- [GAP] failed child does not refill unless its pre-claim was released by existing failure handling
  +-- [GAP] blocked card, live claim, inactive project, and dirty checkout suppress refill
  +-- [GAP] QA and ship defaults stay serial; QA completion never triggers ship
  +-- [GAP] refilled child results still run failure Todo reconciliation and handoff trigger handling
  +-- [GAP] concurrent handoff and refill children get unique ports, log dirs, and run records
```

Run `node --test` after implementation.

### Performance Review

Refill adds Linear reads only after a child completes, not during idle ticks. The worst case is bounded by `maxSameRepoRefillDispatches`, same-repo limits, and existing drain limits. This is acceptable for the benefit: the launcher keeps expensive agent capacity productive instead of letting active same-repo slots decay.

## DevEx Review

Classification: CLI/operator automation.

Developer persona: maintainer running unattended Linear sweeps on an always-on machine. They expect board settings to map to observable capacity. If `sameRepoCardLimits.dev` says 4, they expect roughly four active Dev children while actionable Dev cards exist.

Mode: DX polish, because this is an enhancement to an existing CLI automation flow.

Target TTHW: existing operators should understand and validate the behavior in under 5 minutes with README/SETUP docs plus `tick --dry-run` logs.

DX scorecard:

| Dimension | Current | Target | Plan requirement |
|-----------|---------|--------|------------------|
| Getting started | 8/10 | 8/10 | No new setup command. Default-on bounded refill. |
| CLI/config design | 7/10 | 8/10 | Add one explicit override, `parallel.maxSameRepoRefillDispatches`. |
| Error messages | 7/10 | 8/10 | Logs must distinguish `handoff-skip` from `refill-skip`. |
| Documentation | 7/10 | 8/10 | README and SETUP must explain cross-anchor budget vs same-repo slot budget vs refill budget. |
| Upgrade path | 8/10 | 8/10 | Backward compatible default with `0` escape hatch. |
| Measurement | 7/10 | 8/10 | Run records or logs should mark refilled children so operators can audit capacity behavior. |

DevEx correction folded into the plan: log refills as their own event family, for example `refill-trigger COD-115: dev slot 3/4` and `refill-skip dev: budget`. Operators should not have to infer refill behavior from generic dispatch lines.

## Independent Adversarial Review

The independent reviewer verified:

- `expandDispatchBatch()` currently fills same-repo slots only when a workspace/sweep candidate is expanded.
- `dispatchBatch()` can observe individual child completion early enough to refill while siblings are still running.
- `runHandoffTriggers()` currently solves card continuation, not same-sweep pool refill.
- The proposed fix cannot exceed `sameRepoCardLimit` when refilled children and original siblings overlap.
- The implementation does not trigger ship, does not bypass dirty-checkout blockers, and does not hide downstream failures.
- Dynamic refill must fix child run-path allocation because `expandDispatchBatch()` resets `childIndex` per call while ports derive from child index.

## Schema & Architecture Impact

`linear-sweep.json` gains optional `parallel.maxSameRepoRefillDispatches`, default `8`, clamp `0..20`, with `0` disabling refill. README should mark COD-113 as planned same-repo capacity replenishment until implementation lands.

No schema doc is configured for this repo.

## Acceptance Criteria

- In a Dev queue with at least five actionable cards and `sameRepoCardLimits.dev = 4`, when one of the four active Dev children succeeds, the parent launcher can claim and dispatch the fifth Dev card before the other three finish.
- Refill never exceeds the configured same-repo card limit for a sweep.
- Refill is bounded by `maxSameRepoRefillDispatches`.
- Handoff behavior remains unchanged: `spec -> dev` and `dev -> qa` can continue the completed card; QA never triggers ship.
- Failure Todo reconciliation, dirty checkout blocking, project activation, blocking labels, live claims, owner-token preclaims, run records, and isolated child envs all apply to refilled children.
- Tests cover the steady-state capacity scenario and all suppression gates listed above.

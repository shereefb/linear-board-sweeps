# COD-98: Drain Queue After Sweep Design

Linear: COD-98
Status: planned
Date: 2026-07-08

## Problem

The launcher checks queues, dispatches a sweep pass, and then waits for the next tick. If another card lands in that same queue while the sweep is running, the system may sit idle until the next scheduler interval even though the sweep just finished and the queue is still actionable.

The card asks for all sweeps to behave like ship-sweep: after finishing, check their queue again in case new cards were added while they were running.

## Goals

- After a sweep pass finishes, re-check that sweep's configured queue.
- Dispatch another pass when the same sweep still has actionable cards.
- Keep the behavior bounded so one busy queue cannot starve every other sweep forever.
- Preserve ship's serial/single-runner safety.
- Keep cheap idle ticks cheap.

## Non-goals

- No unbounded while-true drain loop.
- No cross-host locking redesign.
- No change to card selection order.
- No change to per-card sweep behavior.

## Existing Mechanism

`tick()` currently:

1. Reaps stale claims and counts actionable cards for every sweep.
2. Builds dispatch candidates.
3. Selects a bounded batch through `selectDispatchBatch()`.
4. Runs `dispatchBatch(batch)`.
5. Reconciles post-dispatch failures.
6. Ends.

`selectDispatchBatch()` already keeps ship serial and allows bounded non-ship parallelism across disjoint repo sets. The missing behavior is a post-dispatch drain pass for queues that may have changed while the child agent was running.

## Proposed Behavior

Add a bounded drain loop around the existing cheap-phase plus dispatch-phase. The loop must distinguish "selected a batch" from "actually dispatched a batch" so dry-run can report repeated passes without launching agents.

```text
tick
  +-- scan queues and build candidates
  +-- select bounded batch
  +-- dispatch batch
  +-- reconcile failures
  +-- if drain budget remains, scan again
  +-- stop when no candidates or budget exhausted
```

Default drain budget:

- `maxDrainPasses: 2` per tick, including the first dispatch pass.
- Configurable under `parallel.maxDrainPasses`.
- Minimum `1`, default `2`, maximum clamp `5`.

This catches cards added during a long sweep without letting one queue monopolize the host all day.

## Engineering Review

### D1 - Drain budget

ELI10: The choice is whether to drain until empty or drain once more. Draining forever feels complete, but it can starve other work and make launchd runs overlap. A small budget catches the common case while keeping scheduler behavior predictable.

Recommendation: A because it improves latency without turning a tick into an unbounded worker.

A) Add a bounded drain budget, default 2 passes (recommended). Completeness: 10/10. It catches newly arrived work after the first pass and prevents runaway loops.

B) Drain until empty. Completeness: 7/10. It minimizes queue wait time but risks monopolizing the host when new cards keep arriving.

C) Leave draining to the next 10-minute tick. Completeness: 3/10. It is simplest but does not satisfy the card.

Net: Use a bounded drain loop with explicit logging when the budget stops further work.

### Scope Challenge

What already exists:

- Queue scanning and candidate selection.
- Bounded batch dispatch.
- Per-workspace `parallel.maxNonShipDispatches`.
- Post-dispatch failure reconciliation.

Minimum change:

- Extract the existing scan/select/dispatch/reconcile body into one pass helper.
- Wrap it in a budgeted loop.
- Add tests for a second pass when new candidates appear and for stopping at the budget.

### Architecture Review

The drain loop must re-run the same reaper and candidate-building logic instead of trying to reuse stale candidate data. Reusing stale data would double-dispatch cards that the first sweep already claimed or moved.

Failure scenario: pass 1 dispatches dev, pass 2 uses old candidates and dispatches the same top card again. The implementation must fetch fresh cards before every drain pass.

Dry-run scenario: pass 1 selects work but does not dispatch. If the helper returns only "didDispatch", the dry-run loop stops early and never demonstrates the bounded repeated-pass behavior. The helper should return selected batch metadata separately from dispatch status.

### Code Quality Review

Keep this in `tick()` helpers rather than adding a worker daemon. A tick is still a bounded foreground supervisor launched by launchd. Extract an injectable pure-ish orchestration helper for tests, because `tick()` itself is hard-wired to registry, Linear fetches, filesystem logs, and dispatch.

### Test Review

Required coverage:

```text
drain loop
  +-- [GAP] first pass dispatches selected batch
  +-- [GAP] second pass re-scans and dispatches newly available candidate
  +-- [GAP] stops when no candidates
  +-- [GAP] stops when maxDrainPasses is reached
  +-- [GAP] ship remains serial and single-runner gated
  +-- [GAP] dry-run continues based on selected batches, not did-dispatch
```

Run `node --test` after implementation.

### Performance Review

Each extra drain pass repeats Linear queue fetches. The default single extra pass is acceptable because it runs only after a real dispatch, not on idle ticks. Clamp the budget to avoid accidental API churn.

## Adversarial Review Targets

The independent reviewer should verify:

- Current `tick()` ends after one `dispatchBatch()`.
- `selectDispatchBatch()` already handles bounded non-ship dispatch and ship serial behavior.
- A drain loop will not bypass reaper/failure reconciliation.
- The implementation exposes an injectable drain-loop helper that tests can drive without live Linear or filesystem state.
- Dry-run does not accidentally spend tokens or run agents.

## Schema & Architecture Impact

`linear-sweep.json` gains optional `parallel.maxDrainPasses`, defaulting to 2. README should mark COD-98 as planned queue-latency improvement.

## Acceptance Criteria

- A new card added during a sweep can be picked up by a second pass in the same tick.
- A busy queue cannot drain forever.
- Dry-run reports each selected pass without dispatching.
- Ship remains serial and only dispatches on the ship-runner host.
- Tests cover drain budget and no-candidate stop behavior.

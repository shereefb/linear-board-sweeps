# COD-113: Better Parallel Work Implementation Plan

Linear: COD-113
Spec: docs/superpowers/specs/2026-07-09-COD-113-better-parallel-work-design.md
Date: 2026-07-09

## Goal

Keep same-repo non-ship child slots full while a parent launcher tick is already supervising a batch. The main observable behavior: when one of four active Dev cards moves to QA, the next actionable Dev card is claimed and started without waiting for the remaining three Dev cards or the next scheduler tick.

## Implementation Steps

1. Add refill configuration helpers.

   File: `scripts/linear-watch.mjs`

   - Add constants:
     - `DEFAULT_MAX_SAME_REPO_REFILL_DISPATCHES = 8`
     - `MAX_SAME_REPO_REFILL_DISPATCHES = 20`
   - Export `maxSameRepoRefillDispatches(configs)`:
     - accept one config or an array, matching `drainPassLimit()`;
     - default to `8`;
     - clamp to `0..20`;
     - treat invalid values as the default.
   - Keep `parallel.maxNonShipDispatches` semantics unchanged.

2. Track active same-repo child counts during a parent tick.

   File: `scripts/linear-watch.mjs`

   - Add a small in-memory counter keyed by `${anchorPath}\0${sweep}`.
   - Increment the count for every dispatch pick returned by `expandDispatchBatch()`.
   - Decrement it in the `dispatchBatch()` `onResult` callback before refill decisions.
   - Do not count `ship` in this mechanism.
   - Treat failed dispatch-start children consistently with existing claim release behavior before deciding whether refill is safe.

3. Extract reusable same-repo slot dispatch.

   File: `scripts/linear-watch.mjs`

   - Create a helper that can build, claim, expand, and dispatch a card-specific same-repo refill through existing primitives:
     - `fetchCards()`
     - `actionableCards()`
     - `selectDispatchBatch()`
     - `expandDispatchBatch()`
     - `checkoutDispatchBlockers()`
     - `dispatchBatch()`
     - `reconcileDispatchResult()`
   - The helper should accept:
     - `anchorPath`
     - `config`
     - `sweep`
     - `availableSlots`
     - `parentRunId`
     - `activeByAnchor`
     - `refillReason`
   - It should return structured child results or an empty result plus a logged skip reason.

4. Refill after successful child completion.

   File: `scripts/linear-watch.mjs`

   - In the existing `dispatchBatch(dispatches, { onResult })` callback:
     - reconcile the child result;
     - run existing handoff triggers for the completed card;
     - if the completed child was a successful non-ship card dispatch, attempt same-repo refill for that same original sweep.
   - Refilled children must use the same `onResult` pipeline, so a refilled child can trigger another bounded refill when it later succeeds.
   - Record `triggeredBy` for run records, for example:

     ```js
     triggeredBy: {
       issue: result.issueIdentifier,
       sweep: result.sweep,
       kind: "same-repo-refill"
     }
     ```

5. Bound refill.

   File: `scripts/linear-watch.mjs`

   - Add a parent-tick refill budget from `maxSameRepoRefillDispatches(anchors.map((a) => a.config))`.
   - Decrement the budget only after at least one refill child is confirmed and dispatched.
   - If a refill claim attempt finds no confirmed slots, do not burn budget.
   - Log skips:
     - `refill-skip <sweep>: disabled`
     - `refill-skip <sweep>: budget`
     - `refill-skip <sweep>: no-capacity`
     - `refill-skip <sweep>: no-actionable`
     - `refill-skip <sweep>: inactive-project`
     - `refill-skip <sweep>: dirty-checkout`
     - `refill-skip <sweep>: label-map`

6. Allocate unique run paths and ports across initial, handoff, and refill children.

   File: `scripts/linear-watch.mjs`

   - Do not let each `expandDispatchBatch()` call reset child port allocation to `0` when concurrent children from the same parent tick are still alive.
   - Move child index allocation into a parent-tick allocator or pass a mutable allocator into `expandDispatchBatch()`.
   - Ensure initial children, handoff children, and refill children all receive unique `AUTO_SWEEP_APP_PORT`, log directories, temp directories, screenshot directories, browser profiles, and run-record identifiers.
   - Add tests for a Dev child completion that triggers both a QA handoff and a Dev refill in the same parent tick.

7. Preserve handoff and ship gates.

   File: `scripts/linear-watch.mjs`

   - Do not change `nextSweepForHandoff()`.
   - Do not add any QA-to-ship transition.
   - Do not let refill select `ship`.
   - Keep QA at the configured `sameRepoCardLimits.qa` value, which defaults to 1.

8. Update configuration documentation.

   Files:

   - `README.md`
   - `SETUP.md`
   - `.claude/linear-sweep.json`
   - `templates/linear-sweep.json`

   Document:

   - `parallel.maxSameRepoRefillDispatches`, default `8`, clamp `0..20`, `0` disables.
   - Difference between:
     - `maxNonShipDispatches`: cross-anchor selected workspace/sweep candidates;
     - `sameRepoCardLimits`: active child slots inside one selected repo/sweep;
     - `maxSameRepoRefillDispatches`: per-tick cap on backfilled same-repo child dispatches.
   - Dry-run should report what would be selected initially, but true refill requires child completion and is validated by tests or live logs.

9. Update tests.

   File: `tests/linear-watch.test.mjs`

   Add focused tests for:

   - `maxSameRepoRefillDispatches` default, invalid input, disable, clamp, and array maximum.
   - Active child counting for one `(anchor, sweep)` key.
   - Successful Dev child completion frees one slot and dispatches the next top Dev card.
   - Refill does not exceed `sameRepoCardLimit`.
   - Refilled child uses isolated card env and run-record metadata.
   - Concurrent handoff and refill dispatches receive unique ports and run paths.
   - Refilled child result runs the same failure Todo and handoff callback path.
   - Refill budget exhaustion stops further refill.
   - `maxSameRepoRefillDispatches: 0` disables refill.
   - Failed child dispatch does not refill unless existing failure handling released the owned pre-claim and active count is correct.
   - Blocked cards, live claims, inactive project, and dirty checkout suppress refill.
   - QA completion does not trigger ship.

10. Run verification.

   ```bash
   node --test tests/linear-watch.test.mjs
   node --test
   ```

   Optional manual validation after implementation:

   ```bash
   set -a && . ./.env && set +a
   node scripts/linear-watch.mjs tick --dry-run
   ```

   Dry-run validates initial slot selection. The steady-state refill path is best verified by unit tests and then by live logs from an attended run with more actionable Dev cards than `sameRepoCardLimits.dev`.

## NOT in Scope

- Child sweeps invoking `tick`.
- Child sweeps invoking downstream skills directly.
- Automatic QA-to-ship dispatch.
- Changing Linear board sort order or queue priority.
- Raising QA parallelism by default.
- Replacing launchd with a long-lived worker daemon.
- Changing `maxNonShipDispatches` cross-anchor behavior.

## What Already Exists

- `sameRepoCardLimit()` defines the configured slot target per sweep.
- `selectCardSlots()` and `claimCardSlots()` select board-ordered cards and claim them with owner-token heartbeat comments.
- `expandDispatchBatch()` creates per-card child dispatch picks with isolated worktree, log, temp, port, screenshot, and browser profile paths.
- `dispatchBatch()` returns structured child results and calls `onResult` as each child completes.
- `runHandoffTriggers()` handles card-specific `spec -> dev` and `dev -> qa` continuation.
- `reconcileDispatchResult()` maps dispatch failures into self-clearing Todo cards.
- `checkoutDispatchBlockers()` prevents unattended dispatch from dirty anchor or kit checkouts.
- `runDrainLoop()` already handles whole-pass rescans; COD-113 adds within-pass refill.

## Failure Modes

- Refill exceeds active same-repo capacity. Mitigation: active counter keyed by `(anchorPath, sweep)` and tests with siblings still running.
- Refill uses stale queue data. Mitigation: fetch source-state cards immediately before claiming refill slots.
- Refilled child bypasses failure reconciliation. Mitigation: dispatch refills through the same `dispatchBatch()` callback pipeline.
- Refilled child bypasses handoff continuation. Mitigation: re-use the same child result handler for initial and refill dispatches.
- Concurrent handoff and refill children collide on ports or run paths. Mitigation: allocate child indexes from a parent-tick allocator instead of resetting `childIndex` inside each expansion.
- Dirty checkout starts unattended work. Mitigation: run `checkoutDispatchBlockers()` before refill dispatch.
- Project is deactivated while children run. Mitigation: re-check activation before refill.
- Refill creates an unbounded loop. Mitigation: `maxSameRepoRefillDispatches` budget and same-repo slot limit.
- QA triggers ship. Mitigation: refill skips `ship`, handoff map remains unchanged, tests assert no QA-to-ship automation.
- Operator cannot tell what happened. Mitigation: explicit `refill-trigger` and `refill-skip` logs plus `triggeredBy.kind = "same-repo-refill"` run-record metadata.

## Worktree Parallelization

Sequential implementation is safest. The orchestration, counters, refill helper, and tests all touch `scripts/linear-watch.mjs` and `tests/linear-watch.test.mjs`. Documentation can land after the code behavior is stable.

## Implementation Tasks

- [ ] **T1 (P1, human: ~1h / CC: ~15min)** - config - Add `maxSameRepoRefillDispatches()` with defaults, clamp, disable behavior, and tests.
  - Surfaced by: Engineering Review D1.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: targeted helper tests.

- [ ] **T2 (P1, human: ~2h / CC: ~30min)** - orchestration - Track active child counts per `(anchorPath, sweep)` and refill freed same-repo slots after successful child completion.
  - Surfaced by: COD-113 taper scenario.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: Dev batch of 4 refills the fifth card when one child succeeds.

- [ ] **T3 (P1, human: ~1h / CC: ~20min)** - safety gates - Route refilled children through activation, blocking labels, live-claim checks, dirty-checkout blockers, owner-token claims, run records, and failure Todo reconciliation.
  - Surfaced by: Architecture Review.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: suppression and failure-reconciliation tests.

- [ ] **T4 (P1, human: ~45min / CC: ~15min)** - bounds - Enforce refill budget and preserve QA/ship gates.
  - Surfaced by: Performance Review and human ship-gate requirement.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: budget exhaustion and QA-does-not-ship tests.

- [ ] **T5 (P1, human: ~45min / CC: ~15min)** - isolation - Allocate unique child ports and run paths across initial dispatches, handoffs, and refills.
  - Surfaced by: Independent Adversarial Review.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: concurrent handoff plus refill test asserts unique `AUTO_SWEEP_APP_PORT`, log dirs, temp dirs, browser profiles, and run records.

- [ ] **T6 (P2, human: ~45min / CC: ~10min)** - operator DX - Add `refill-trigger`/`refill-skip` logs and run-record `triggeredBy.kind`.
  - Surfaced by: DevEx Review.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: log/run-record metadata assertions.

- [ ] **T7 (P2, human: ~45min / CC: ~10min)** - docs/config - Document the refill budget in README, SETUP, the repo config, and the template config.
  - Surfaced by: DevEx Review.
  - Files: `README.md`, `SETUP.md`, `.claude/linear-sweep.json`, `templates/linear-sweep.json`.
  - Verify: `rg "maxSameRepoRefillDispatches|same-repo refill|refill" README.md SETUP.md .claude/linear-sweep.json templates/linear-sweep.json`.

## Review Details

### Engineering Review Summary

Step 0: scope accepted as parent-owned same-repo slot refill. No new daemon, no child-spawned tick, no ship automation.

Architecture Review: one P1 risk found and folded in. The plan must track active in-flight children, not only completed results, or it can overfill a same-repo sweep.

Code Quality Review: one P2 naming correction folded in. Use `refill` terminology, not `handoff`, because handoff already means continuing one completed card to the next sweep.

Test Review: ten required test groups listed above. The highest-risk regression test is "four active Dev cards, one succeeds, fifth Dev card starts, active Dev count stays at four."

The second high-risk regression test is "one Dev success triggers a QA handoff and a Dev refill, and those two new children do not collide on ports or run paths."

Performance Review: bounded additional Linear reads only after child completion; default cap prevents unbounded launcher runs.

### DevEx Review Summary

Product type: CLI/operator automation.

Persona: maintainer running unattended Linear sweeps who expects config values to match visible launcher behavior.

Mode: DX polish.

Current TTHW: about 5 minutes for an existing operator to understand current parallel settings from README/SETUP.

Target TTHW: under 5 minutes to understand and validate refill behavior after the docs update.

Key DX correction: logs and run records must make refill explicit. Operators should see `refill-trigger` or `refill-skip`, not infer this from generic dispatch lines.

### Independent Adversarial Review

Independent reviewer verdict: premise mostly true. Existing COD-98 drains after a whole pass completes; it does not refill freed same-repo slots mid-batch. Findings folded before coding:

- The current code fills same-repo card slots at initial expansion.
- The current child completion callback is the correct signal for refill.
- The current handoff budget does not represent same-repo active capacity.
- Any implementation must count in-flight siblings or it can over-dispatch.
- Dynamic refill must fix child index allocation because `expandDispatchBatch()` resets `childIndex = 0` per call while ports derive from child index.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Brainstorming | `/brainstorming` | Explore same-repo capacity behavior | 1 | CLEAR | Parent-owned refill is the smallest complete fix |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | Add active-slot accounting, bounded refill, and reuse existing dispatch/failure paths |
| DX Review | `/plan-devex-review` | CLI/operator experience | 1 | CLEAR | Add explicit refill config docs, logs, and run-record metadata |
| Independent Adversarial | subagent | Premise and safety challenge | 1 | CLEAR | Folded correction that COD-98 backfills only after full pass completion, plus port/run-path collision risk |

- **VERDICT:** ENG + DX + ADVERSARIAL CLEARED - ready to implement.

NO UNRESOLVED DECISIONS

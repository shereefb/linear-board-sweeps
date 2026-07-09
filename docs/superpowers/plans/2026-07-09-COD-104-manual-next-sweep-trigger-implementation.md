# COD-104: Manual Next Sweep Trigger Implementation Plan

Linear: COD-104
Spec: docs/superpowers/specs/2026-07-09-COD-104-manual-next-sweep-trigger-design.md
Date: 2026-07-09

## Goal

Start the next non-production sweep immediately after a successful forward handoff, while keeping all dispatch decisions inside the launcher and preserving the human ship gate.

## Transition Map

| Upstream sweep | Current issue state after child completes | Trigger |
|----------------|--------------------------------------------|---------|
| `spec` | `SWEEP_CFG.dev.states` | dispatch `dev` for the same issue |
| `dev` | `SWEEP_CFG.qa.states` | dispatch `qa` for the same issue |
| `qa` | any state | none |
| `ship` | any state | none |

Do not hardcode only the old state names. Compare the issue's current state against the configured next sweep source states so this survives COD-102's planned rename from `Ready for Dev`/`In Review` to `Dev`/`QA`.

## Steps

1. Extract reusable one-pass dispatch wiring.

   File: `scripts/linear-watch.mjs`

   - If COD-98 already extracted a pass helper, reuse it.
   - Otherwise extract the current scan/select/claim/dispatch/reconcile body into a helper that can be called by `tick()` and by the handoff supervisor.
   - Keep all existing guards in the helper:
     - registered anchor and loaded config;
     - `auto-sweep` project activation;
     - team/project filter;
     - blocking labels;
     - live claim filtering;
     - bounce and stale-claim cleanup;
     - same-repo and disjoint-repo capacity;
     - owner-token preclaims;
     - ship serial and ship-runner checks;
     - failure Todo reconciliation.

2. Return structured child dispatch results.

   File: `scripts/linear-watch.mjs`

   - Extend `dispatchBatch()` or its wrapper to return per-child results:

     ```js
     {
       anchorPath,
       sweep,
       issueIdentifier,
       dispatchScope,
       exitCode,
       success,
       startedAt,
       completedAt
     }
     ```

   - Preserve existing logging and error behavior.
   - Keep parent-owned failure Todo reconciliation after each dispatch scope.
   - For non-card workspace-level dispatches, set `issueIdentifier` only when known.

3. Add handoff decision helpers.

   File: `scripts/linear-watch.mjs`

   Export pure helpers for tests:

   - `maxHandoffTriggerHops(configs)`:
     - reads `parallel.maxHandoffTriggerHops`;
     - defaults to `2`;
     - clamps to `0..3`.
   - `nextSweepForHandoff({ completedSweep, currentStateName, sweepCfg })`:
     - returns `dev` for `spec` when current state is in `SWEEP_CFG.dev.states`;
     - returns `qa` for `dev` when current state is in `SWEEP_CFG.qa.states`;
     - returns `null` for `qa`, `ship`, backward moves, holding states, `Done`, `Todo`, and unknown states.
   - `handoffTriggerKey(issueIdentifier, fromSweep, toSweep)` for per-run duplicate suppression.

4. Implement parent-owned handoff supervisor.

   File: `scripts/linear-watch.mjs`

   - After a child result succeeds, re-read that issue from Linear.
   - Re-check project activation before considering downstream dispatch.
   - Suppress if the issue is blocked, live-claimed for the target sweep, or not in the target sweep's configured source states.
   - Build a card-specific downstream candidate with `AUTO_SWEEP_ISSUE=<identifier>`.
   - Send that candidate through the same selection, slot-claim, dispatch, and failure-reconciliation path as normal scheduler work.
   - Continue only while:
     - the previous downstream result succeeded;
     - the hop budget remains;
     - the next transition is forward-only;
     - the `(issue, fromSweep, toSweep)` key has not already fired in this tick.
   - Log skipped triggers with concise reasons: `inactive-project`, `blocked`, `live-claim`, `not-forward`, `capacity`, `hop-limit`, `ship-gate`.

5. Keep QA and ship gates explicit.

   File: `scripts/linear-watch.mjs`

   - Add tests and code comments around the transition map saying QA output never triggers ship.
   - Do not add `Ready to Ship`/`Ship` as an automated destination.
   - Existing scheduled ship dispatch still requires the card to be in the human-moved ship source state and the host to be `ship-runner`.

6. Update config docs.

   Files:

   - `README.md`
   - `SETUP.md`
   - `.claude/linear-sweep.json`
   - `templates/linear-sweep.json`

   Document:

   - `parallel.maxHandoffTriggerHops`, default `2`, clamp `0..3`.
   - Spec-to-dev and dev-to-QA may continue immediately in the same supervised run.
   - QA stops at the human signoff queue; ship never starts from this handoff trigger.
   - Set `maxHandoffTriggerHops: 0` to disable immediate handoffs.

7. Update run records and logs.

   Files: `scripts/linear-watch.mjs`, tests covering run records if COD-94 is present in the implementation branch.

   - Mark downstream runs as triggered handoffs:

     ```json
     {
       "triggeredBy": {
         "issue": "COD-104",
         "sweep": "spec"
       }
     }
     ```

   - If structured run records are unavailable in the branch being implemented, include the same fields in launcher logs.

8. Update tests.

   File: `tests/linear-watch.test.mjs`

   Add pure and orchestration tests for:

   - `maxHandoffTriggerHops` default, disable, and clamp behavior.
   - `nextSweepForHandoff` returns `dev` for spec landing in dev source.
   - `nextSweepForHandoff` returns `qa` for dev landing in QA source.
   - `nextSweepForHandoff` returns `null` for QA landing in `QA Passed`/`Signoff`.
   - Parent handoff does not spawn nested `tick`.
   - Deactivated projects suppress downstream trigger.
   - Blocking labels suppress downstream trigger.
   - Live target-sweep claims suppress downstream trigger.
   - Same-repo slot exhaustion suppresses or defers downstream trigger.
   - Downstream child failure gets failure Todo reconciliation.
   - Hop limit prevents recursive storms.

9. Run verification.

   ```bash
   node --test
   ```

   Manual dry-run validation after implementation:

   ```bash
   set -a && . ./.env && set +a
   node scripts/linear-watch.mjs tick --dry-run
   ```

   Dry-run should describe what would be dispatched, including whether handoff triggers are disabled in dry-run or only logged as would-trigger. It must not launch child agents.

## NOT in Scope

- Child sweeps invoking `tick`.
- Child sweeps invoking downstream skills directly.
- Automatic QA-to-ship dispatch.
- Unbounded queue draining.
- Changing card ordering rules for normal scheduler ticks.
- Changing claim label names.

## What Already Exists

- `SWEEP_CFG` centralizes queue source states and claim labels.
- `selectDispatchBatch()` enforces bounded non-ship and serial ship dispatch.
- `claimCardSlots()` preclaims exact same-repo card slots.
- `dispatchBatch()` runs child processes and supports card-specific `AUTO_SWEEP_ISSUE`.
- Failure Todo helpers dedupe, create, and recover scheduled dispatch failures.
- Blocking labels and live-claim checks already define actionable cards.

## Failure Modes

- Nested tick no-ops under parent lock. Mitigation: no child-spawned tick; parent owns handoff while it holds the lock.
- Direct next-sweep invocation bypasses capacity. Mitigation: downstream trigger uses the same candidate selection and slot-claim path.
- QA triggers ship. Mitigation: transition map has no QA edge and tests assert that behavior.
- Project is deactivated mid-run. Mitigation: re-check activation immediately before downstream dispatch.
- Card is moved backward or blocked by the sweep. Mitigation: trigger only when current state is in the next sweep's source states and no blocking labels exist.
- Recursive loop burns tokens. Mitigation: forward-only edges, per-run duplicate keys, and `maxHandoffTriggerHops`.
- Downstream failure is hidden. Mitigation: reconcile failure Todos after triggered dispatch just like normal dispatch.
- COD-102 renames states. Mitigation: compare against `SWEEP_CFG.<next>.states`, not duplicated old names.

## Verification Checklist

- [ ] Handoff helper tests pass.
- [ ] Trigger supervisor tests pass.
- [ ] QA human-gate tests pass.
- [ ] Activation/blocking/live-claim suppression tests pass.
- [ ] Capacity and failure Todo tests pass.
- [ ] `node --test` passes.
- [ ] Dry-run does not dispatch child processes.

## Worktree Parallelization

Sequential implementation is safest. The launcher orchestration, dispatch result shape, and tests all touch `scripts/linear-watch.mjs` and `tests/linear-watch.test.mjs`. Docs can be updated after the code settles.

## Implementation Tasks

- [ ] **T1 (P1, human: ~2h / CC: ~25min)** - orchestration - Extract or reuse a single-pass launcher helper that preserves existing scheduler guards.
  - Surfaced by: Engineering Review - downstream dispatch must stay launcher-owned.
  - Files: `scripts/linear-watch.mjs`
  - Verify: existing dispatch selection and claim tests still pass.

- [ ] **T2 (P1, human: ~1h / CC: ~20min)** - child results - Return structured per-child results and dispatch scopes from `dispatchBatch()` or its wrapper.
  - Surfaced by: Failure Todo Review - downstream failures need parent reconciliation.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`
  - Verify: failure Todo reconciliation tests pass.

- [ ] **T3 (P1, human: ~2h / CC: ~25min)** - handoff supervisor - Add forward-only card-specific `spec -> dev` and `dev -> qa` triggering with hop bounds.
  - Surfaced by: COD-104 requirement.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`
  - Verify: handoff tests and `node --test`.

- [ ] **T4 (P1, human: ~1h / CC: ~15min)** - safety gates - Add activation, blocking, live-claim, capacity, duplicate, and QA ship-gate tests.
  - Surfaced by: Independent Adversarial Review.
  - Files: `tests/linear-watch.test.mjs`
  - Verify: targeted tests and full suite.

- [ ] **T5 (P2, human: ~1h / CC: ~15min)** - docs/config - Document `parallel.maxHandoffTriggerHops` and immediate non-production handoffs.
  - Surfaced by: DevEx Review.
  - Files: `README.md`, `SETUP.md`, `.claude/linear-sweep.json`, `templates/linear-sweep.json`
  - Verify: `rg "maxHandoffTriggerHops|handoff" README.md SETUP.md .claude/linear-sweep.json templates/linear-sweep.json`

## Tests

Run:

```bash
node --test
```

Recommended targeted loop during implementation:

```bash
node --test tests/linear-watch.test.mjs
```

Manual validation:

```bash
set -a && . ./.env && set +a
node scripts/linear-watch.mjs tick --dry-run
```

Expected dry-run behavior:

- No child process launches.
- Normal queue candidates still show as before.
- Handoff trigger decisions are reported as would-trigger or disabled-in-dry-run.
- Ship remains gated to the configured ship source state and ship-runner host.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Brainstorming | `/brainstorming` | Explore trigger ownership | 1 | CLEAR | Parent-owned launcher handoff is the only design that keeps existing guards |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | Extract pass helper, add structured child results, bound forward handoffs |
| DX Review | `/plan-devex-review` | Operator workflow | 1 | CLEAR | Default-on immediate non-production handoffs; no setup migration |
| Independent Adversarial | subagent | Lock/capacity/gate challenge | 1 | CLEAR | Avoid nested tick, preserve capacity/preclaims, never QA-to-ship, reconcile failures |

- **VERDICT:** ENG + DX + ADVERSARIAL CLEARED - ready to implement.

NO UNRESOLVED DECISIONS

# COD-98: Drain Queue After Sweep Implementation Plan

Linear: COD-98
Spec: docs/superpowers/specs/2026-07-08-COD-98-drain-queue-after-sweep-design.md
Date: 2026-07-08

## Goal

After a sweep pass finishes, re-check the relevant queues and run another bounded pass if new actionable work arrived while the first pass was running.

## Steps

1. Add drain configuration.

   File: `scripts/linear-watch.mjs`

   - Export `drainPassLimit(configs)` or similar.
   - Read `config.parallel.maxDrainPasses`.
   - Default to `2`, clamp to `1..5`.
   - Use the maximum across active anchors for the tick, similar to `maxNonShipDispatches`.

2. Extract one dispatch pass.

   File: `scripts/linear-watch.mjs`

   - Move the current scan/reap/candidate/reconcile/select/dispatch logic into a helper that runs one pass and returns structured pass output, not only a boolean.
   - Return at least `{ selectedBatch, dispatched, exhaustedBudgetCandidateCount }` or equivalent. `selectedBatch.length > 0` drives dry-run/pass continuation; `dispatched` records whether real child processes ran.
   - Preserve current failure reconciliation after each dispatch.
   - Preserve `writeLastTick()` before each potentially long dispatch.
   - Keep the helper injectable for tests: pass in scanner, selector, dispatcher, logger, and failure reconciler functions instead of requiring live Linear.

3. Wrap tick in a bounded loop.

   File: `scripts/linear-watch.mjs`

   - For `pass = 1..maxDrainPasses`, run one pass.
   - Stop early when a pass has no selected batch.
   - Log when the drain budget is exhausted while candidates still existed.
   - In dry-run, print what each pass would dispatch and stop at the same budget without launching agents. Do not use `dispatched` as the continuation condition in dry-run.

4. Update config docs.

   Files:

   - `.claude/linear-sweep.json`
   - `templates/linear-sweep.json`
   - `README.md`
   - `SETUP.md`

   Add `parallel.maxDrainPasses` with default `2` and explain the tradeoff.

5. Update tests.

   File: `tests/linear-watch.test.mjs`

   Export an injectable drain-loop helper and add pure tests for:

   - Default/clamped drain limit.
   - Second pass dispatches a new candidate returned by the next scan.
   - Loop stops when pass returns no candidates.
   - Loop stops at configured budget.
   - Ship remains serial in every pass.
   - Dry-run can continue for a second selected pass even though no dispatch occurred.

## Tests

Run:

```bash
node --test
```

Manual validation:

```bash
node scripts/linear-watch.mjs tick --dry-run
tail -n 80 ~/.local/state/linear-board-sweeps/*/*/$(date +%Y%m%d).log
```

The log should show pass numbering or equivalent repeated dry-run dispatch messages when more work is available.

## NOT in Scope

- Unbounded queue draining.
- Changing dispatch priority.
- Cross-host claim protocol changes.
- Changing the sweep skills' per-card behavior.

## What Already Exists

- `selectDispatchBatch()` chooses one ship pass or a bounded non-ship batch.
- `parallel.maxNonShipDispatches` controls non-ship breadth.
- `dispatchBatch()` can run multiple selected child agents.
- Failure Todo reconciliation already runs after dispatch.

## Failure Modes

- Stale candidates reused across passes. Mitigation: re-fetch cards every pass.
- Drain loop starves other scheduler runs. Mitigation: default budget 2 and clamp max 5.
- Dry-run accidentally dispatches. Mitigation: keep dispatch behind the existing `dryRun` branch in every pass.
- Dry-run stops early because no real dispatch occurred. Mitigation: continue based on selected batch metadata, not the dispatch boolean.
- The loop is too hard to unit test. Mitigation: export an injectable orchestration helper and keep `tick()` as IO wiring.
- Ship double-dispatches. Mitigation: each pass uses existing ship-runner and ship-serial selection.

## Verification Checklist

- [ ] Drain limit helper tests pass.
- [ ] Injectable drain-loop helper tests pass.
- [ ] Drain loop tests pass.
- [ ] Existing dispatch selection tests pass.
- [ ] `node --test` passes.
- [ ] Dry-run logs show bounded repeated pass behavior.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | Use fresh scans per pass and bound the drain loop |

- **VERDICT:** ENG CLEARED - ready to implement.

NO UNRESOLVED DECISIONS

# COD-82 bounded parallel sweep dispatch - implementation plan

## Scope

Implement bounded non-ship parallel dispatch across disjoint workspaces. Keep ship serial and keep one sweep per anchor per tick.

## Files

- `scripts/linear-watch.mjs`
- `tests/linear-watch.test.mjs`
- `templates/linear-sweep.json`
- `README.md`
- `SETUP.md` if setup docs need the config knob

## Steps

1. Add `parallel.maxNonShipDispatches` config parsing with default `2`. Clamp invalid, missing, or non-numeric values to `2`; `1` remains the explicit serial option.
2. Add a pure helper to compute each candidate's disjointness key from resolved repo paths plus project/API identity. Do not rely on `anchorPath` alone.
3. Add a pure `selectDispatchBatch(candidates, options)` helper. Reuse `SWEEP_ORDER`; return one ship candidate when ship is eligible, otherwise return up to N non-ship candidates with distinct anchors and non-overlapping resolved repo paths.
4. Keep `selectDispatch()` as a compatibility wrapper or update tests/callers cleanly.
5. Convert dispatch execution from one `spawnSync()` call to a batch runner based on `spawn()`, preserving cwd, env merge, log paths, and exit-code messages.
6. Update `tick()` to build the batch after `last-tick` is written. In dry-run mode, log every selected candidate.
7. Update `cmdHealth`, README, and SETUP wording so one tick can supervise a bounded child-agent batch.
8. Add tests:
   - default batch size is the bounded parallel default,
   - two anchors can dispatch together,
   - same anchor dedupes to one,
   - overlapping resolved repo paths dedupe to one,
   - ship suppresses non-ship dispatch,
   - invalid config falls back to the bounded parallel default,
   - batch dry-run reports all selected dispatches.
9. Update README/SETUP/templates to document the knob as conservative and non-ship-only.

## Verification

- `node --test`
- `set -a && . ./.env && set +a && node scripts/linear-watch.mjs tick --dry-run`

## Rollout

Ship with default `2`. Set `maxNonShipDispatches` to `1` for serial mode on constrained hosts, and raise above `2` only on an attended machine after observing CPU/RAM and log behavior.

# COD-140 implementation plan

1. Add regressions proving Ship coexists with other stages, one Ship is selected per source workspace, overlap safety remains, and a failed Ship runtime does not starve healthy lanes.
2. Refactor `selectDispatchBatch` so Ship candidates are ranked first but do not trigger an early return or consume `maxNonShipDispatches`.
3. Preflight every candidate before selection.
4. Update operator documentation, changelog, and patch version.
5. Run focused tests, the full suite, syntax/diff checks, and independent review.
6. Commit, push, merge, install, propagate to all registered anchors, and verify watcher health.


# COD-140: Workspace-scoped Ship concurrency

## Decision

Ship remains the highest-priority sweep, but it is no longer globally exclusive. The scheduler may select at most one Ship candidate per registered source workspace, and that Ship may run alongside Spec, Dev, and QA candidates from the same or other workspaces.

## Safety boundaries

- The host-wide active-child ceiling remains authoritative.
- Cross-workspace managed-repository overlap still rejects the later candidate.
- Duplicate `(source workspace, sweep)` candidates consume one candidate slot.
- Ship still expands to one card per selected workspace candidate.
- Dependency, routing, claim, runtime, dirty-checkout, human-gate, and canary rules are unchanged.
- `maxNonShipDispatches` continues to count only non-Ship workspace/stage candidates; Ship does not consume that budget.

## Runtime preflight

All candidates are preflighted together. An unavailable Ship runtime is reported as a failure for that lane but no longer starves healthy Spec, Dev, or QA lanes.

## Expected selection

Given SafeTaper Ship + Dev, Zomes Ship + QA, and no repository overlap, the batch may contain all four candidates. Expansion and the global capacity ledger decide how many card children are admitted.


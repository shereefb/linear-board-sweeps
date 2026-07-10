# COD-141: Completion-driven sweep backfill

## Decision

Every completed child immediately creates another admission opportunity. The scheduler must not wait for unrelated children from the original batch before discovering work that can now use the freed capacity.

Ship keeps its safety boundary of one active child per registered source workspace. A successful Ship completion may enqueue the next eligible Ship card for that same workspace, and the existing admission queue remains responsible for deduplication, host capacity, repository collision checks, and the one-Ship-per-workspace lock.

## Claim lifecycle

A launcher-owned in-progress claim represents a live child, not unfinished work in the abstract. If a child exits successfully and its issue remains in the same workflow state with the same launcher owner token, the launcher releases only that owned claim. The card can then be considered again by normal admission instead of appearing active until the stale-heartbeat timeout.

If the child advanced the issue, removed the claim itself, or another owner replaced the heartbeat, the launcher makes no label change. Dependency and routing deferrals retain their existing specialized release paths and audit messages.

## Safety boundaries

- Never release a claim without re-reading the issue and proving the latest heartbeat owner matches the completed child.
- Never remove another runtime's claim.
- Never run two Ship children for the same registered source workspace.
- Preserve dependency, routing, checkout, runtime, human-gate, and global capacity checks.
- Completion-triggered discovery is bounded by the existing refill budget and admission queue.

## Expected behavior

If workspace A has Ship cards A1 and A2 and workspace B has a long Dev job, A1 and the Dev job may start together. When A1 completes, A2 starts without waiting for the Dev job. If a Dev child exits successfully but leaves its card in Dev, its owned `dev:in-progress` label is released immediately so a later admission can resume it.

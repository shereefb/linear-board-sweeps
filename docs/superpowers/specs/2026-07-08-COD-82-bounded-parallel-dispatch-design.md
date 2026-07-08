# COD-82 bounded parallel sweep dispatch - design

**Date:** 2026-07-08
**Status:** Ready for implementation after spec-sweep engineering review.
**Card:** COD-82, "Bounded parallel sweep dispatch (per-workspace; ship stays serial)"

## Problem

The launcher currently does all cheap work for every active workspace, then dispatches at most one heavyweight agent pass:

- Sweep taxonomy and priority already live in `SWEEP_CFG` and `SWEEP_ORDER` (`scripts/linear-watch.mjs:52`, `scripts/linear-watch.mjs:62`).
- The current `tick()` loop counts all candidates but calls `selectDispatch()` and `dispatch()` once (`scripts/linear-watch.mjs:717`).
- `dispatch()` is foreground and blocking via `spawnSync()` (`scripts/linear-watch.mjs:598`).
- Ship dispatch is guarded by the local `shipRunner` registry flag (`scripts/linear-watch.mjs:686`).

This serial shape is safe, but it makes one slow workspace hold up unrelated workspaces. COD-82 asks for bounded parallel dispatch, while noting two constraints: dev and qa in the same repo need separate environments before they can safely run together, and ship must stay serial.

## Brainstormed approaches

1. **Recommended: workspace-level parallelism only.** Dispatch a small pool of non-ship sweeps, with at most one pass per workspace per tick. This improves throughput for independent workspaces without creating same-repo dev server, worktree, branch, or `main` races.
2. **Deferred: same-workspace dev/qa parallelism with environment leases.** Add separate dev and qa runtime environments per repo, plus per-repo branch/write locks. This is useful, but it is a larger platform change and should be specified separately once the simple workspace pool exists.
3. **Rejected: arbitrary candidate parallelism.** Starting every actionable queue at once is likely to thrash CPU/RAM, collide on ports, and multiply Linear claim races.

## Design

Add bounded parallelism to the launcher at the workspace boundary, but define "disjoint" from the resolved repo set, not only from anchor names. A tick still performs one cheap pass over every active workspace: auto-update, reaping, orphan cleanup, bounce checks, and candidate counting. After that, instead of choosing one candidate, it selects up to `parallel.maxNonShipDispatches` non-ship candidates whose resolved `config.repos` paths do not overlap, ordered by the existing downstream priority and oldest actionable card.

Ship remains outside the pool. If any ship candidate exists and this host is the ship runner, the tick dispatches exactly one ship pass and dispatches no other work. This preserves the "one production deploy at a time" invariant and keeps the existing `shipRunner` protection meaningful.

The initial implementation keeps same-workspace serialization strict: at most one sweep per anchor per tick. It also excludes candidates from different anchors if their resolved repo paths overlap, because a workspace can point at absolute or relative paths outside its own folder. That means dev and qa in the same repo remain serial until a future card designs environment leases. When a qa card is blocked specifically because no isolated qa/staging environment exists, that should be represented as a separate `Needs Spec` card and the dependent cards should be labeled/commented as blocked by that requirement. This spec does not automate that dependency creation yet; it calls it out as the follow-up design.

## Config

Extend `linear-sweep.json` with an optional launcher block:

```json
"parallel": {
  "maxNonShipDispatches": 2
}
```

Default `2` enables a bounded pair of non-ship passes in a single tick. Set `maxNonShipDispatches` to `1` for serial mode. Any value above `1` is still subject to one candidate per workspace, resolved repo disjointness, and local capacity.

## Selection and execution

Add a pure helper, tentatively `selectDispatchBatch(candidates, { maxNonShipDispatches, shipRunner })`:

- Sort using the existing `SWEEP_ORDER`, then `oldestUpdatedAt`.
- If a ship candidate is dispatchable, return only the highest-priority ship candidate.
- Otherwise return up to `maxNonShipDispatches` candidates.
- Deduplicate by `anchorPath`.
- Exclude candidates whose resolved repo path sets overlap.
- Never include candidates with `count <= 0`.

Change `dispatch()` to have an asynchronous variant backed by `spawn()`, or wrap it in a `Promise` so several foreground child processes can run concurrently while the tick waits for all selected passes. Each child keeps the existing per-workspace/sweep log file, runtime env, and exit-code logging. `last-tick` should still be written before dispatch so `health` does not flap during long runs.

The local tick lock remains one process per host, but that process may now supervise multiple child agents. `health` and README language must change from "exactly one agent running" to "one launcher tick supervising a bounded batch." Cross-host non-ship double-claim risk is unchanged by this feature; solving that needs a separate distributed claim protocol.

## Review decisions

### Engineering review decision D1 - parallelism boundary

The decision is whether to parallelize at the workspace boundary first, or design same-repo dev/qa concurrency now. The risk is that same-repo concurrency looks attractive but needs environment, port, branch, and worktree isolation that the launcher does not own today.

Recommendation: choose workspace-level parallelism first because it improves throughput for truly disjoint work while preserving the existing safety model.

A) Workspace-level parallelism (recommended). Completeness: 8/10. It addresses the backlog-throughput problem for independent projects, keeps ship serial, and limits new races. It does not solve dev+qa in one repo yet.

B) Same-workspace environment leases now. Completeness: 10/10 for the broadest goal, but it is a larger feature with new lease state, staging setup, dependency cards, and recovery behavior. It should be its own spec.

C) Dispatch all candidates. Completeness: 4/10. It is simple to implement but ignores the failure modes the card itself names.

Net: ship the bounded workspace pool first; specify environment leases separately.

### Independent adversarial review

The outside reviewer must verify these premises before implementation:

- `tick()` really does dispatch only once today.
- `dispatch()` is currently synchronous.
- `shipRunner` gates ship dispatch but not stale-claim cleanup.
- Batch disjointness must use resolved repo paths, not only `anchorPath`.
- `health` and docs must reflect a bounded child process batch under one tick lock.

Any correction should update this section before implementation starts.

## Schema and architecture impact

No Linear schema changes. `README.md` and `SETUP.md` should describe parallel dispatch as planned, not active, until implementation lands. The launcher architecture grows one optional config block, one repo-set disjointness helper, and one batch-selection helper; sweep skills do not change for this increment.

## Non-goals

- Same-repo dev and qa parallelism.
- Cross-host distributed locks.
- Changing sweep claim semantics.
- Increasing ship concurrency.

## Acceptance criteria

- Default config preserves one dispatch per tick.
- With `maxNonShipDispatches: 2`, two actionable non-ship candidates in two different anchors dispatch in one tick.
- Two actionable candidates in the same anchor still produce one dispatch.
- Two candidates in different anchors with overlapping resolved repo paths still produce one dispatch.
- Any dispatchable ship candidate suppresses non-ship dispatch for that tick.
- `tick --dry-run` logs the full batch it would dispatch.
- Tests cover ship priority, anchor/repo-overlap dedupe, default behavior, invalid config, health wording, and child-process exit logging.

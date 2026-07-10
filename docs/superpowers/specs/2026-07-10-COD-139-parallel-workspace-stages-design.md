# COD-139 parallel workspace stages - design

**Card:** COD-139, "Allow parallel sweep stages within one registered workspace"

## Problem

The launcher currently selects at most one non-Ship `(workspace, sweep)`
candidate per tick. On the live SafeTaper board, QA, Dev, and Spec each had an
actionable card, but the launcher ran them serially while host capacity stayed at
1/10. The Mac mini had roughly 80% memory-pressure availability and no capacity
deferrals, so increasing host limits would not change the observed behavior.

The restriction was originally intentional: COD-82 predated per-card worktrees,
ports, owner claims, and the host-wide capacity ledger. Those isolation controls
now exist, but `selectDispatchBatch()` still rejects every later candidate from
the same anchor and treats its own managed repository set as a collision.

## Approaches

1. **Allow distinct stages inside one workspace (recommended).** Preserve the
   existing candidate cap, Ship exclusivity, stage priority, per-repo/stage card
   limits, and repository-overlap rejection between different registered
   workspaces. Same-workspace candidates may overlap because their children use
   issue-specific worktrees and isolated runtime paths.
2. **Split every routed card into a repository-level scheduler candidate.** This
   could expose more precise resource accounting, but requires a larger planner
   rewrite and changes the documented workspace/stage meaning of
   `maxNonShipDispatches`.
3. **Release the global tick lock while children run.** This would let later
   timer ticks refill newly arriving work, but introduces parent ownership and
   drain-loop coordination races. It does not need to be solved to dispatch all
   candidates already visible in the current scan.

## Design

`selectDispatchBatch()` will deduplicate by registered source workspace plus
stage, rather than dropping every later stage for that workspace. Repository
overlap will be checked against previously selected candidates only when their
registered source workspaces differ. Consequently, one registered workspace may
contribute QA, Dev, and Spec candidates to the same bounded batch; two separately
registered workspaces that resolve to the same or nested repository path remain
mutually exclusive even if malformed registry metadata gives them the same
managed anchor path.

No configuration or Linear schema changes are required. The live values remain
appropriate: `parallel.maxNonShipDispatches: 4` bounds selected workspace/stage
candidates and registry `capacity.maxActiveChildren: 10` bounds actual children.
Ship remains the only merge/deploy lane and suppresses every non-Ship candidate.

## Safety and verification

- Add a regression test proving QA, Dev, and Spec from one anchor are all selected
  in downstream-first order.
- Add a regression test proving the configured candidate cap still applies within
  one anchor.
- Add fail-safe regression tests for duplicate workspace/stage candidates and two
  registered source workspaces that collide on one managed anchor path.
- Preserve and sharpen tests proving overlapping paths across different anchors
  are deduplicated, including nested and managed stable-slug paths.
- Run the focused test, the complete test suite, shell/static health checks, and
  an independent diff review.
- Release, install, propagate to every registered anchor, relaunch the service,
  and verify the next live scan can reserve more than one useful child when the
  board supplies multiple actionable stages.

## Non-goals

- Raising QA's per-repo default above one.
- Making Ship parallel or automatic.
- Weakening dependency eligibility, blocked-card handling, or route validation.
- Redesigning the tick lock in this change.

# COD-85 Linear queue order - design

**Date:** 2026-07-08
**Status:** Ready for implementation after spec-sweep engineering and DevEx review.
**Card:** COD-85, "Issues should be taken from the top of the linear queue"

## Problem

The sweeps currently describe oldest-first selection. That appears in the spec and dev sweep instructions (`.claude/skills/spec-sweep/SKILL.md:19`, `.claude/skills/dev-sweep/SKILL.md:18`). The launcher also reduces each sweep queue to `oldestUpdatedAt` before dispatch (`scripts/linear-watch.mjs:683`) and `selectDispatch()` breaks same-sweep ties with the oldest timestamp (`scripts/linear-watch.mjs:266`).

That is not the same as the top of a Linear board column. The user wants the issue at the top of the visible queue to run first, and when a sweep moves a card into another queue it should land at the bottom of that destination queue. The point is operator control: reordering the board in Linear should change agent priority without editing labels or timestamps.

## Brainstormed approaches

1. **Recommended: board-order selection with bottom-on-move helpers.** Add explicit Linear position support to the launcher and sweep guidance. Use Linear's issue sort/order field if available from the API, otherwise derive a stable board order from the fields Linear exposes for issues in a state.
2. **Timestamp approximation only.** Keep current oldest-created/oldest-updated semantics and document it. This is simple but fails the card because dragging a card to the top would not reliably change priority.
3. **Manual priority labels.** Add labels like `priority:next`. This is explicit, but it creates a second queue beside the Linear column order and makes the board less truthful.

## Design

Make Linear board position the source of truth inside a state. Every sweep selection step should say "top-of-column order" instead of "oldest-first." The launcher should fetch enough issue fields to sort cards exactly as Linear displays them for that state. The implementation should first inspect the Linear GraphQL schema or a live issue payload for the correct field name. The expected candidates are issue `sortOrder`, issue `prioritySortOrder`, or another rank-like field exposed on `Issue`. Do not guess the field silently; add a failing test fixture that models the selected field before wiring it into live queries.

Add a pure helper, tentatively `sortByBoardPosition(cards)`, and use it in two places:

- In scheduled `tick()`, when a sweep has several actionable cards, compute the top actionable card's board-position value instead of `oldestUpdatedAt`.
- In the sweep skills, require cards to be processed in the fetched board order, not by `createdAt` or `updatedAt`.

For destination placement, add helper behavior for each terminal state move:

- Spec-sweep moves `Needs Spec` to the bottom of `Ready for Dev`.
- Dev-sweep moves to the bottom of `In Review`, and backward bounces to the bottom of `Needs Spec`.
- QA-sweep moves successful cards to the bottom of `QA Passed`, and change-request cards to the bottom of the chosen developer queue.
- Ship-sweep moves to the bottom of `Done`.

The implementation should expose a small Linear mutation helper that updates the status and rank in one logical operation when Linear supports it. If Linear requires separate calls, post the status update and then immediately apply the bottom rank. On failure to position the card after a successful status move, leave a card comment naming the positioning failure. Do not retry by moving the issue through other states.

## DevEx review

### DevEx decision D1 - priority surface

The decision is whether operators should control sweep order by dragging cards in Linear or by adding special priority labels. The stakes are that the visible board must match what the agent will actually do.

Recommendation: use Linear board order because it keeps the board as the single priority surface.

A) Board order (recommended). Completeness: 9/10. It gives operators the control they asked for and avoids another priority vocabulary. It requires exact API field discovery and test fixtures.

B) Priority labels. Completeness: 6/10. It is easy to implement and explicit in automation, but users now have to manage both column order and labels.

C) Timestamp order. Completeness: 3/10. It is already mostly implemented but does not satisfy top-of-queue semantics.

Net: use board order, and make failures visible rather than silently falling back to timestamps.

## Engineering review

### Engineering decision D1 - fallback behavior

The decision is what to do if the Linear API does not expose a usable board-rank field in the current client. The risk is shipping another approximate ordering system while the card asks for exact visible queue order.

Recommendation: block implementation on field discovery, then add an explicit test fixture around that field.

A) Discover and test the real rank field first (recommended). Completeness: 10/10. It makes the implementation exact and protects future refactors.

B) Use updated timestamp as fallback. Completeness: 5/10. It keeps the launcher running but reintroduces the bug when a human reorders cards.

C) Add priority labels instead. Completeness: 6/10. It is reliable but changes the product model away from the Linear queue.

Net: exact board order is the product; do not bury an approximation behind the same feature name.

### Independent adversarial review

Premises to verify before implementation:

- `selectDispatch()` currently uses timestamp tie-breaking, not a board rank (`scripts/linear-watch.mjs:266`).
- `tick()` currently derives `oldestUpdatedAt` from actionable cards (`scripts/linear-watch.mjs:683`).
- The sweep skill prose still says oldest-first in both distributed and installed copies (`skills/spec-sweep/SKILL.md:19`, `skills/dev-sweep/SKILL.md:18`, `skills/qa-sweep/SKILL.md:21`, `skills/ship-sweep/SKILL.md:19`), so implementation must update every sweep skill, not only launcher code.
- Destination moves in all sweep skills say only to move to the next state, with no bottom-of-column placement (`skills/spec-sweep/SKILL.md:51`, `skills/dev-sweep/SKILL.md:40`, `skills/qa-sweep/SKILL.md:49`, `skills/ship-sweep/SKILL.md:65`).
- The existing tests already assert oldest timestamp behavior (`tests/linear-watch.test.mjs:193`), so tests need to change with the product contract.

## Schema and architecture impact

No repository data schema change. Linear issue update calls gain rank/position awareness. `README.md`, sweep skills, and tests should mark top-of-queue order as planned until implementation lands. The architecture impact is a new queue-order helper in `scripts/linear-watch.mjs` and a shared Linear status-move helper that all sweeps can use.

## Acceptance criteria

- Scheduled dispatch uses the top actionable card in each Linear state, not oldest created or updated time.
- Manual card reordering in Linear changes the next selected card without label changes.
- Every sweep moves completed/bounced cards to the bottom of the destination state.
- `tick --dry-run` reports board-order selection clearly enough to debug.
- Unit tests cover queue order, blocked/live-claimed filtering combined with queue order, and bottom-of-destination rank calculation.
- Sweep docs and AGENTS template no longer say "oldest-first" for card selection.

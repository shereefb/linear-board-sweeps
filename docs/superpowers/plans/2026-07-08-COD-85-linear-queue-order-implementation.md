# COD-85 Linear queue order - implementation plan

**Date:** 2026-07-08
**Card:** COD-85
**Spec:** `docs/superpowers/specs/2026-07-08-COD-85-linear-queue-order-design.md`

## Goal

Make the visible Linear board order drive sweep selection. Cards moved by a sweep should land at the bottom of the destination column.

## Steps

1. Discover the Linear issue rank field.
   - Use the existing `scripts/linear.mjs query` command or a focused GraphQL introspection query.
   - Confirm the field on at least two issues in the same state after manually comparing their board order.
   - Record the field name in a short code comment near the query.

2. Add pure queue-order helpers in `scripts/linear-watch.mjs`.
   - Add `boardOrderValue(card)` or equivalent.
   - Add `sortByBoardPosition(cards)`.
   - Preserve blocked and live-claim filtering through `actionableCards()`.
   - Replace `oldestUpdatedAt` candidate metadata with a board-order metadata field. Keep dispatch priority by sweep unchanged.

3. Update Linear fetching and dry-run logs.
   - Extend `fetchCards()` to request the selected rank field.
   - Log the identifier of the top actionable card per sweep in dry-run and normal count logs.
   - Keep the idle path cheap: no additional per-card comments or heavy queries.

4. Add bottom-of-destination move support.
   - Add a helper in the Linear client layer for "move issue to state and bottom."
   - Use the helper from every sweep implementation path when moving states.
   - If exact bottom positioning requires a separate mutation, make the status update first and then position; on positioning failure, comment on the card.

5. Update docs and templates.
   - Replace "oldest-first" selection text in all sweep skills with "top-of-column order."
   - Update both distributed `skills/*/SKILL.md` files and installed-anchor `.claude/skills/*/SKILL.md` copies in this repo.
   - Update README planned/active behavior text once implemented.

6. Tests.
   - Update `tests/linear-watch.test.mjs` to assert board-order sorting.
   - Rename candidate metadata away from `oldestUpdatedAt` so tests and logs no longer encode timestamp priority.
   - Add tests for blocked/live claimed cards combined with queue ordering.
   - Add tests for destination-bottom helper payload construction.
   - Keep existing ship-before-qa/dev/spec priority tests.

## Verification

Run:

```bash
node --test
node scripts/linear-watch.mjs tick --dry-run
```

For a live manual check, create or use two test cards in one non-production project state, drag the lower card above the other in Linear, and verify the dry run reports the dragged card first.

## Risks

- Linear's public API may expose a rank field with semantics that differ from visual order. The implementation must verify against live board order before landing.
- Bottom placement may not be atomic with status changes. A visible comment on failure is better than silent misordering.

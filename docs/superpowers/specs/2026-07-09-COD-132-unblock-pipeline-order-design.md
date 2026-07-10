# COD-132 Unblock Pipeline Ordering Design

## Goal

Keep the manual unblock sweep focused on actionable pipeline work. It must omit Backlog and every non-pipeline state, then present eligible cards from the furthest downstream state to the earliest: `Signoff`, `QA`, `Dev`, `Spec`.

## Behavior

- Eligible states are exactly `Signoff`, `QA`, `Dev`, and `Spec`.
- State priority is `Signoff` first, followed by `QA`, `Dev`, and `Spec`.
- Cards in `Backlog`, `Ship`, `Todo`, `Done`, `Canceled`, `Duplicate`, `Archived`, legacy `In Progress`, or an unknown state are omitted even if they carry an unblockable label.
- Within the same eligible state, cards retain the existing oldest-updated-first ordering.
- Existing blocker-label eligibility, cross-anchor discovery, paused-project inclusion, warning handling, and resolve semantics remain unchanged.

## Implementation

Add one pure helper in `scripts/linear-watch.mjs` that filters and ranks normalized blocked cards by the explicit pipeline-state priority. `scanBlockedIssues` will apply the helper after collecting cards from all registered anchors. Keeping the rule in a pure helper makes the behavior deterministic and directly testable without Linear API calls.

Update both canonical copies of `unblock-sweep/SKILL.md` so agents know the returned queue is limited and downstream-first. No GraphQL filter change is needed: filtering normalized cards centrally preserves the current paginated cross-anchor scan while enforcing one ordering contract.

## Verification

Add focused unit tests proving:

1. `Signoff`, `QA`, `Dev`, and `Spec` are ordered downstream-first regardless of update time across states.
2. Multiple cards in one state are ordered oldest-updated first.
3. Backlog and other non-eligible states are omitted.
4. The two tracked skill copies stay identical and state the same queue contract.

Run the focused test file first, then the complete `node --test` suite.

## Scope Boundaries

This change does not alter which labels are unblockable, mutation behavior, Linear card states, scheduled sweep dispatch, or the order of cards on the Linear board itself.

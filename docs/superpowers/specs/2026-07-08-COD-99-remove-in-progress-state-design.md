# COD-99: Remove In Progress State Design

Linear: COD-99
Status: planned
Date: 2026-07-08

## Problem

The workflow currently has both an `In Progress` state and a `dev:in-progress` claim label. They overlap. The state says a card is actively being developed, while the label already does the real coordination work: it marks ownership, drives stale-claim reaping, and prevents another runner from picking up the same card.

The card asks to simplify the board by moving all cards in `In Progress` back to `Ready for Dev` and then stop using the state.

## Goals

- Make `Ready for Dev` the only dev-sweep queue state.
- Keep `dev:in-progress` as the ownership signal for active dev work.
- Move existing `In Progress` cards to `Ready for Dev` without making live claimed cards actionable.
- Update installed skills, templates, docs, and tests so future agents stop referencing `In Progress`.
- Preserve auditability for cards moved during migration.

## Non-goals

- Do not delete the Linear workflow state through the API in the first implementation. Removing or archiving a Linear state can have workspace-wide effects and should be an explicit follow-up only after no code/docs reference it.
- Do not change `In Review`, `QA Passed`, `Ready to Ship`, or `Done`.
- Do not change `dev:in-progress` semantics.

## Existing Mechanism

`scripts/linear-watch.mjs` defines:

```js
dev: { states: ["Ready for Dev", "In Progress"], claim: "dev:in-progress", blocked: ["blocked:needs-user"], staleMin: 90 }
```

`actionableCards()` excludes any live in-progress claim label through `liveClaimLabel()`. That means a card can sit in `Ready for Dev` with `dev:in-progress` and remain non-actionable until its heartbeat goes stale or the dev sweep releases the claim.

The helper `node scripts/linear.mjs move-card-bottom <KEY> "Ready for Dev"` already moves a card to the bottom of a target state, but it does not preserve or apply labels by itself.

## Proposed Behavior

1. Update launcher config so dev-sweep fetches only `Ready for Dev`.
2. Update skills and docs so active dev means `Ready for Dev` plus `dev:in-progress`, not a separate `In Progress` column.
3. Add a migration helper command that lists cards in `In Progress`, preserves existing labels, comments once, and moves each card to the bottom of `Ready for Dev`.
4. Keep `In Progress` in Linear itself for one release as an unused legacy state. Add it to legacy/orphan cleanup so claims stranded there are still reaped.

## Engineering Review

### D1 - Migration strategy

ELI10: The choice is whether to immediately delete the state or first stop using it. Deleting the state is tidy, but it is a one-way workspace operation. Stopping use and migrating cards gets the product behavior without risking historical or third-party Linear assumptions.

Recommendation: A because it satisfies the user goal with a reversible first step.

A) Stop using the state, migrate cards, leave the Linear state unused for now (recommended). Completeness: 10/10. It removes the workflow duplication from all agent behavior and preserves a rollback path if an operator notices an integration depending on the state.

B) Delete or archive the Linear state immediately. Completeness: 7/10. It gives the cleanest board, but deleting workflow states can have side effects beyond this kit and is not necessary to make agents stop using it.

C) Keep both but rename `In Progress` to clarify it is legacy. Completeness: 4/10. It avoids migration risk, but it does not satisfy the simplification request.

Net: Stop using `In Progress` in code/docs now, leave physical state removal to a later attended cleanup if needed.

### Scope Challenge

What already exists:

- `dev:in-progress` claim labels and heartbeat stale handling.
- `liveClaimLabel()` excludes live claims across all sweep states.
- `move-card-bottom` moves cards into `Ready for Dev`.
- Tests already cover actionable filtering and `SWEEP_CFG.dev`.

Minimum change:

- Remove `In Progress` from `SWEEP_CFG.dev.states`.
- Update docs/templates/skills that list statuses or dev sweep source states.
- Add tests proving claimed cards in `Ready for Dev` are not actionable.
- Add a migration command or script path for current `In Progress` cards.

### Architecture Review

The important invariant is that state no longer represents ownership. Ownership remains label plus heartbeat. The plan must verify that moving a live card from `In Progress` to `Ready for Dev` does not make it visible as a plain actionable card.

Failure scenario 1: a live dev card is moved to `Ready for Dev` without `dev:in-progress`. The launcher may dispatch a second dev run. The migration must preserve existing claim labels when they are already present.

Failure scenario 2: an unclaimed card in `In Progress` gets a fresh `dev:in-progress` label during migration. Because `heartbeatAgeMin()` falls back to `updatedAt`, the migration write would make the fake claim look live for up to 90 minutes and suppress real dev dispatch. The migration must not add `dev:in-progress` to unclaimed cards.

Failure scenario 3: a card is dragged back into legacy `In Progress` after dev stops fetching that state. Its stale claim would never be reaped unless the launcher also checks the legacy state in the orphan/holding cleanup path.

### Code Quality Review

Avoid a broad board-taxonomy rewrite. Make the state list a small targeted change and update text references. Keep any migration helper inside the existing Linear helper surface instead of adding a new dependency.

### Test Review

Required coverage:

```text
SWEEP_CFG.dev.states
  +-- [GAP] equals ["Ready for Dev"]

actionableCards()
  +-- [TESTED] live dev:in-progress card is excluded
  +-- [GAP] live dev:in-progress card in Ready for Dev is excluded
  +-- [GAP] stale dev:in-progress card in Ready for Dev is actionable/reapable

migration helper
  +-- [GAP] moves In Progress cards to Ready for Dev
  +-- [GAP] preserves existing labels
  +-- [GAP] does not add fake dev:in-progress labels to unclaimed cards
  +-- [GAP] adds one audit comment per moved card

legacy cleanup
  +-- [GAP] stale claims stranded in In Progress are released
```

Run `node --test` after implementation.

### Performance Review

Fetching one fewer state for dev-sweep slightly reduces Linear API payload size. No new polling loop is needed.

## DevEx Review

Classification: CLI/operator workflow.

Operator persona: a maintainer watching the Linear board and using states as a queue, not as an ownership ledger.

DX decision: the migration must be visible and boring. The command should print each moved card and comment on Linear so the operator can trust that the board simplification did not drop active work.

TTHW target: under 3 minutes for an operator to understand the new model from README/AGENTS: active dev is `Ready for Dev` plus `dev:in-progress`.

## Adversarial Review Targets

The independent reviewer should verify:

- `SWEEP_CFG.dev.states` currently includes `In Progress`.
- `liveClaimLabel()` excludes live `dev:in-progress` labels independent of state.
- The migration preserves existing claim labels but does not create fake claims for unclaimed cards.
- A legacy cleanup path still reaps stale claims in `In Progress`.
- All public docs/templates that list the status pipeline are updated.
- The migration does not silently remove labels from existing cards.

## Schema & Architecture Impact

README and docs should mark `In Progress` as planned-legacy under COD-99 until implementation lands. The canonical pipeline becomes:

```text
Backlog -> Needs Spec -> Ready for Dev -> In Review -> QA Passed -> Ready to Ship -> Done
```

`dev:in-progress` remains a workflow label. `In Progress` becomes a legacy cleanup state until the implementation confirms no cards or automations still use it.

## Acceptance Criteria

- No scheduled sweep fetches `In Progress`.
- Existing `In Progress` cards are moved to `Ready for Dev` with existing `dev:in-progress` preserved but not newly applied to unclaimed cards.
- Claims stranded in legacy `In Progress` are still released by stale-claim cleanup.
- Docs/templates no longer describe `In Progress` as a normal status.
- Tests prove live claimed cards in `Ready for Dev` are not double-dispatched.
- The Linear card receives a migration summary when the implementation runs.

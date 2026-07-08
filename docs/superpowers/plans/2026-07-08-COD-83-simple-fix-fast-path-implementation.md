# COD-83 simple fix fast path - implementation plan

## Scope

Add a default-on policy that lets dev-sweep mark tiny high-confidence changes as eligible for a human to move directly to Ready to Ship, without merging or deploying. Repos can opt out by setting `fastPath.enabled` to `false`.

## Files

- `skills/dev-sweep/SKILL.md`
- `skills/ship-sweep/SKILL.md` if sanity docs need clarification
- `templates/linear-sweep.json`
- `README.md`
- `docs/linear-rules.md`
- Tests or helper tests for any pure classifier added to `scripts/`

## Steps

1. Add `fastPath` defaults to the template config, enabled by default with tight thresholds and an explicit opt-out.
2. Add/create the `fast-path:eligible` label in setup paths if the feature is enabled.
3. Update dev-sweep to evaluate fast-path eligibility only after implementation, verification, code review, and independent review are complete.
4. If a helper is added, keep it pure: input card labels, diff stats, touched paths, review result, verification result; output eligible/ineligible plus reasons.
5. Update dev-sweep terminal transition:
   - eligible: remove `dev:in-progress`, comment with `[auto-sweep-fast-path <KEY>]`, add `fast-path:eligible`, and leave/move the card to In Review for human action,
   - ineligible: existing In Review flow unchanged.
6. Update ship-sweep sanity: accept `qa:passed`, or accept `fast-path:eligible` only when the card is already in Ready to Ship by human action and `fastPath.enabled !== false`; still honor `requireShipApproval`.
7. Ensure ship/actionability does not proceed when any live foreign `*:in-progress` claim remains on the card.
8. Document the policy and its risks in README, SETUP, and `docs/linear-rules.md`.
9. Add tests for classifier decisions, foreign-claim blocking, and ship-sweep sanity behavior with a fast-path marker.

## Verification

- `node --test`
- Manual dry-run against a seeded test card if helper wiring touches Linear state.

## Rollout

Land enabled by default. Set `fastPath.enabled` to `false` for repos that want every card to pass through normal QA.

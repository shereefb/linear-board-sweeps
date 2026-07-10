# COD-142: Auto-ship QA-passed fast-path cards

## Summary

Let `qa-sweep` move a fully passing card directly from `QA` to `Ship` when `dev-sweep` marked the exact final branch commit as a tiny, high-confidence, low-risk fast path. All other passing cards continue to land in `Signoff` for human review.

This removes the default human gate only for a narrow, auditable class of changes. `qa-sweep` still never merges or deploys. `ship-sweep` remains the sole production actor and retains its branch, build, repository-scope, single-runner, deploy, and canary gates.

## Problem

The current pipeline always sends a QA-passed card to `Signoff`, even when Dev already established that the change is tiny, low-risk, green, and independently reviewed. The existing `fast-path:eligible` marker only lets a human skip `Signoff` by manually moving the card from `QA` to `Ship`.

That manual step adds little value for appropriately bounded changes. However, trusting the label by itself is unsafe because QA may commit fixes after Dev made its eligibility decision. A persisted label can therefore describe an older diff than the branch Ship will merge.

## Goals

- Automatically route a passing fast-path card from `QA` to `Ship`.
- Reuse the existing fast-path size, label, risk, verification, and reviewer-confidence policy.
- Bind eligibility to the exact reviewed branch commit.
- Fail safely to `Signoff` whenever eligibility is missing, stale, ambiguous, or disabled.
- Preserve `requireShipApproval: true` as an unconditional human gate.
- Keep merge, deployment, and canary behavior exclusively in `ship-sweep`.
- Make every automatic Ship transition explainable from Linear comments and labels.

## Non-goals

- Auto-ship every card labeled `bug`.
- Let QA merge, deploy, or canary a change.
- Skip the QA smoke test or green build/test gate.
- Re-run the complete fast-path review automatically after QA changes the branch.
- Add QA-to-Ship as an immediate launcher handoff. Normal Ship queue scanning and the designated ship runner remain responsible for dispatch.
- Change the behavior of cards that are not fast-path eligible.

## Chosen policy

A QA-passed card may move directly to `Ship` only when every condition below is true at the final handoff re-read:

1. The raw optional value is mapped as `fastPathEnabled: config.fastPath?.enabled`; omitted means enabled, exact `false` disables, and any other non-boolean value fails closed. Callers must not normalize it with `!== false`.
2. `config.requireShipApproval === false`.
3. The card is still in `QA` in the configured project.
4. The card carries both `fast-path:eligible` and `qa:passed`.
5. The card carries no blocking or manual-only label and no foreign in-progress claim.
6. Linear contains a valid Dev audit marker for the card and exact reviewed branch commit:

   ```text
   [auto-sweep-fast-path COD-### head=<full-git-sha>]
   ```

7. The final branch SHA on origin exactly matches the reviewed SHA in that marker.

Any false, missing, malformed, unreadable, or ambiguous condition selects `Signoff`. A policy denial is not a QA failure and does not add `qa:needs-changes` or `blocked:needs-user`.

## Commit-bound eligibility

`dev-sweep` will write the fast-path audit marker only after all implementation, verification, code-review, independent-review, and push steps are complete. The marker records the full origin branch SHA that those checks covered.

`qa-sweep` obtains the final branch SHA from origin immediately before its terminal transition. It must not rely on a local worktree SHA because worktrees are disposable and a resumed run may start after another machine pushed a change.

If QA changes the branch, the origin SHA no longer matches the reviewed SHA. QA then:

1. removes `fast-path:eligible` because it is stale;
2. records the invalidation and both SHAs in the review write-up;
3. sends the passing card to `Signoff`.

QA does not reclassify or re-review the new diff during this feature. A later enhancement may add that capability, but it is deliberately outside this scope.

Legacy `[auto-sweep-fast-path COD-###]` comments without `head=` are not sufficient for automatic Ship and fall back to `Signoff`. This makes rollout backward-compatible and fail-closed.

## Deterministic handoff decision

Add a small pure decision function in `scripts/linear.mjs`. It accepts already-read policy inputs rather than performing mutations:

```js
qaHandoffDecision({
  fastPathEnabled,
  requireShipApproval,
  stateName,
  labelNames,
  issueIdentifier,
  reviewedHead,
  finalHead,
  hasForeignClaim,
})
```

It returns:

```js
{
  destination: "Ship" | "Signoff",
  eligible: boolean,
  reason: "eligible" | "fast-path-disabled" | "ship-approval-required" |
    "not-in-qa" | "missing-fast-path-label" | "missing-qa-pass" |
    "blocked" | "foreign-claim" | "missing-reviewed-head" |
    "invalid-reviewed-head" | "missing-final-head" |
    "invalid-final-head" | "head-mismatch"
}
```

The helper centralizes the high-risk allow/deny matrix and is unit-tested. The sweep remains responsible for reading Linear, obtaining the final origin SHA, parsing the latest matching audit marker, applying labels, posting comments, and invoking the guarded terminal-move command.

The allow path requires positive evidence for every condition. Unknown input never defaults to `Ship`.

## QA handoff flow

After the existing smoke-test and green-build gate succeeds, QA performs the following ordered flow:

1. Attach screenshots and post the normal review write-up.
2. Add `qa:passed`.
3. Re-fetch the card and final origin branch SHA.
4. Parse the latest well-formed fast-path marker for this issue.
5. Run the deterministic handoff decision.
6. If eligible, post:

   ```text
   [auto-sweep-auto-ship COD-### head=<full-git-sha>]
   ```

   The comment also states that QA passed, the reviewed and final SHAs match, fast path is enabled, and explicit ship approval is not required.
7. If ineligible because the SHA changed, remove `fast-path:eligible` and record the stale marker. Other denial reasons leave the historical label unchanged unless it is demonstrably stale.
8. Immediately before terminal handoff, fetch origin and Linear again and rerun the full decision with `fastPathEnabled: config.fastPath?.enabled` and all fresh facts.
9. Move with `move-card-bottom-if-current <Issue> QA <Destination> qa:in-progress`; do not separately release the claim.

The guarded helper fresh-reads exact state and every label ID. It denies a changed source state, missing owned claim, blocking/manual label, or foreign `*:in-progress` claim. When eligible it performs one `issueUpdate` mutation containing destination state, bottom sort order, and label IDs with only the owned claim removed. Linear provides no atomic compare-and-swap for this transition, so this is the narrowest supported mutation boundary, not a CAS.

As today, a final re-read that finds the card no longer in `QA` prevents QA from overriding the human or another run. A transient Linear or git read failure fails closed to `Signoff` when enough evidence exists to complete the QA handoff; otherwise the existing unreadable/blocking behavior applies.

## Ship behavior

No launcher handoff is added. Once a card reaches `Ship`, the designated ship runner discovers it through the existing queue scan.

`ship-sweep` keeps all current fresh-path checks:

- origin branch exists;
- `qa:passed` or enabled fast-path evidence exists;
- no live foreign claim exists;
- build and tests are green;
- repository and deploy scope match;
- `ship:approved` exists when `requireShipApproval` is true.

The new auto-ship marker supplements rather than replaces those checks. On Ship's fresh path, inspect the latest issue-specific comment beginning `[auto-sweep-auto-ship COD-###`; if present, it must exactly match `[auto-sweep-auto-ship COD-### head=<full-git-sha>]` and becomes commit authorization. The current origin branch SHA must exactly equal it. Missing SHA or mismatch blocks before merge with exact evidence. Legacy or human-moved cards with no auto marker retain existing behavior.

Ship must re-fetch origin immediately before merge and compare the current branch SHA with the auto marker a second time. If origin advanced or changed after QA or after the initial Ship sanity gate, the mismatch blocks before merge; the card stays in `Ship` for review.

QA never merges, pushes `main`, deploys, or performs canary verification.

## Configuration semantics

No new configuration key is introduced.

- Omitted `fastPath.enabled` enables the feature; exact `false` disables Dev eligibility and QA automatic Ship routing; malformed `null`, string, number, object, or array values fail closed in both Dev and QA.
- `requireShipApproval: true` always sends QA-passed cards to `Signoff`, even if they otherwise qualify.
- Existing size, diff-line, allowed-label, disallowed-label, risk-surface, green-check, and reviewer-confidence settings continue to determine whether Dev may add `fast-path:eligible`.

Documentation and the config template will be updated so `fastPath.enabled` clearly includes automatic QA-to-Ship routing for commit-bound eligible cards.

## Error handling and recovery

- Missing or malformed reviewed SHA: `Signoff`.
- Final origin SHA cannot be proven: `Signoff`, with the reason recorded.
- Reviewed and final SHA differ: remove stale eligibility and use `Signoff`.
- `requireShipApproval` is true: `Signoff`.
- Card moved out of `QA` during work: do not override; release the owned claim and stop.
- Automatic Ship comment succeeds but status move fails: the card remains outside Ship and is safe to retry; the marker is idempotent evidence, not production authorization by itself.
- The guarded status-and-claim mutation succeeds: the normal Ship queue and single-runner rules take over.
- Origin advances after QA: Ship's marker comparison blocks before merge, including on the immediate pre-merge recheck.
- A crash after moving to Ship is safe because QA has not merged or deployed anything; ship-sweep reconstructs production progress from its existing merge and deploy markers.

## Testing

Unit tests for the decision helper will cover:

- the complete eligible case;
- disabled fast path;
- required explicit ship approval;
- wrong workflow state;
- missing `fast-path:eligible`;
- missing `qa:passed`;
- each blocking/manual label;
- a foreign in-progress claim;
- missing or malformed reviewed SHA;
- missing or malformed final SHA;
- reviewed/final SHA mismatch;
- legacy marker fallback;
- unknown or partial inputs failing to `Signoff`.

Documentation regression tests will assert that both canonical QA and Dev skill copies:

- record and compare the exact origin SHA;
- never auto-ship after QA changes;
- route denials to `Signoff` without treating them as QA failures;
- preserve `requireShipApproval` as a human gate;
- keep QA non-merging and non-deploying.

The existing full Node test suite must remain green.

## Documentation surface

Update the following canonical and distributed copies together:

- `.claude/skills/dev-sweep/SKILL.md`
- `skills/dev-sweep/SKILL.md`
- `.claude/skills/qa-sweep/SKILL.md`
- `skills/qa-sweep/SKILL.md`
- `.claude/skills/ship-sweep/SKILL.md` and `skills/ship-sweep/SKILL.md` where the human-only wording becomes conditional
- `.claude/linear-sweep.json`
- `templates/linear-sweep.json`
- `AGENTS.md`
- `README.md`
- `SETUP.md`
- `docs/linear-rules.md`

## Acceptance criteria

- A QA-passed card with an enabled, commit-bound, unchanged fast-path review and no explicit approval requirement moves to `Ship` with an audit marker.
- The same card moves to `Signoff` when its final origin SHA differs from the reviewed SHA.
- Any QA branch change invalidates and removes stale fast-path eligibility.
- Legacy or malformed markers never authorize automatic Ship.
- Malformed caller-level `fastPath.enabled` values cannot auto-ship.
- A post-QA origin push is blocked at Ship before merge, even if the initial Ship sanity read passed.
- `requireShipApproval: true` always retains human Signoff.
- Non-fast-path passing cards retain the existing QA-to-Signoff behavior.
- QA never merges or deploys; ship-sweep remains the only production actor.
- Decision and documentation regression tests pass in both skill distributions.

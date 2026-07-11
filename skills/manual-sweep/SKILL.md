---
name: manual-sweep
description: Create or resume a manual-only Linear card and hand it through the canonical sweeps after explicit user-approved fast tracking.
---

# Manual sweep

Use this human-invoked skill for `/manual-sweep <issue description>`. It is copied to anchors but is never scheduled.

## Create or resume

Read `.claude/linear-sweep.json`. For a description, create its project card in `Spec` with `sweep:manual-only`; for a `COD-*` key, re-read the card and resume only its unfinished stage. Ensure `manual-sweep:fast-track-requested` exists. Never clear `sweep:manual-only`.

## Canonical handoffs

Invoke exactly one named canonical skill at a time with `MANUAL_SWEEP_ISSUE`, `MANUAL_SWEEP_STAGE`, `MANUAL_SWEEP_EXPECTED_STATE`, and a unique `MANUAL_SWEEP_HANDOFF_ID`. For each attended stage, create separate random `AUTO_SWEEP_OWNER_TOKEN` and `AUTO_SWEEP_CLAIM_DECLARATION` values. The target skill must validate its stage, card state, dependencies, route, and foreign claims; post `[auto-sweep-claim v1 claim=<stage:in-progress> owner=<owner> declaration=<declaration>]` before adding the claim label; complete-read history and accept only the first-declaration-wins epoch; and write `[manual-sweep-handoff <stage> <id>]`. It must never process another card. Scheduled runs never honor this contract.

During the handoff, `[auto-sweep-heartbeat v1 claim=<stage:in-progress> declaration=<declaration> at=<ISO8601>]` is liveness only, never ownership. Before every claim-affecting exit, the target must re-read complete history, verify both exact tokens, post and verify `[auto-sweep-claim-close v1 claim=<stage:in-progress> declaration=<declaration> reason=<released|terminal|blocked|failed>]`, then remove the label or mutate state. Never manufacture a declaration for an existing legacy label.

First invoke direct `spec`; canonical Spec owns the interactive brainstorming, prose review decisions, and committed spec/plan. After Spec succeeds, ask once whether to fast-track. On no, stop in the normal manual-only flow.

On yes, add `manual-sweep:fast-track-requested` and record `[manual-sweep-ship-approval <issue-id> <spec-path> <spec-commit> <nonce>]`. The comment must be authored by the interactive user and postdate the committed artifact; a later `[manual-sweep-ship-revoked <nonce>]` by that user revokes it. Missing, stale, malformed, agent-authored, superseded, or revoked approval fails closed.

Then invoke direct `dev` and direct `qa`. Dev may bypass only normal size and allowed-label limits when requested; all tests, reviews, lenses, material-risk checks, `fastPath.enabled`, and factory-learning exclusions still win. It alone may add `fast-path:eligible`.

Auto-handoff `Signoff` to direct `ship` only when the current approval, request label, `fast-path:eligible`, `qa:passed`, resolved dependencies, no blocking/foreign claim, and (when configured) `ship:approved` all exist. Validate, write the Ship handoff marker, move to Ship, re-read, then invoke Ship. Never duplicate a handoff ID.

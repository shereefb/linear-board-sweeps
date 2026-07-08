# COD-83 simple fix fast path - design

**Date:** 2026-07-08
**Status:** Ready for implementation after spec-sweep engineering review.
**Card:** COD-83, "Skip manual review of simple fixes/features"

## Problem

The current workflow requires every feature to pass through QA Passed and wait for a human move to Ready to Ship. That is correct for meaningful product changes, but expensive for small, low-risk fixes where the dev sweep and reviewer have high confidence.

The card asks for simple fixes/features to move directly to Ready to Ship instead of stopping in QA Passed. The key constraint is that this must not remove the human production gate. In this board, Ready to Ship is explicitly human-only; ship-sweep is the only sweep that merges/deploys, and it currently expects `qa:passed` as pre-merge evidence.

## Brainstormed approaches

1. **Recommended: dev marks fast-path eligibility; human may move directly from In Review to Ready to Ship.** This skips QA Passed when the owner agrees, but preserves the human-only Ready to Ship transition.
2. **QA-sweep shortcut.** Let qa-sweep decide after testing whether to skip QA Passed. This keeps a live smoke test but does not save the full QA pass.
3. **Rejected: dev-sweep moves directly to Ready to Ship.** That would redefine Ready to Ship from a human gate into an agent transition.

## Design

Add a default-on fast-path policy for very small, low-risk cards. The policy remains conservative and can be disabled in `linear-sweep.json`:

```json
"fastPath": {
  "enabled": true,
  "maxChangedFiles": 2,
  "maxDiffLines": 80,
  "allowedLabels": ["bug", "chore", "docs"],
  "disallowedLabels": ["auth", "security", "data", "frontend", "design", "ui", "api", "cli", "sdk", "integration", "research", "performance"],
  "requireReviewerConfidence": "high"
}
```

When enabled, dev-sweep evaluates the card after implementation, tests, code review, and the independent reviewer have all passed. It may add a `fast-path:eligible` label and an audit comment only if all gates pass:

- Diff is below configured size limits.
- Card has no configured disallowed domain labels.
- No database/schema, auth, external input, deploy, CLI/API contract, UI, or performance surface changed.
- All required tests and verification passed.
- Code review found no unresolved issues.
- Independent reviewer explicitly classifies the change as high confidence.
- The card receives a comment explaining exactly why the fast path is eligible.

The human then has a clear choice: leave the card in In Review for normal qa-sweep, or manually move it directly to Ready to Ship to skip QA Passed. Ship-sweep must accept a Ready to Ship card with `qa:passed`, or with `fast-path:eligible` only when `fastPath.enabled !== false`, because the human moved it into Ready to Ship. If `requireShipApproval` is true, ship-sweep still additionally requires the human-applied `ship:approved` label.

Dev-sweep must remove `dev:in-progress` before its terminal status/label update, and actionability should treat any live `*:in-progress` claim as blocking if implementation touches launcher actionability. This avoids a fresh foreign-claim race where ship could see a Ready to Ship card carrying a live dev claim.

## Review decisions

### Engineering review decision D1 - where the fast path lives

The decision is whether to put the shortcut in dev-sweep, qa-sweep, or ship-sweep. The stakes are production safety and whether a shortcut actually saves time.

Recommendation: put eligibility marking in dev-sweep after review and verification, but keep the Ready to Ship move human-only.

A) Dev-sweep eligibility marker plus human move (recommended). Completeness: 9/10. It saves the QA wait when the owner agrees, while preserving the human-only Ready to Ship contract and leaving ship-sweep as the only merge/deploy actor.

B) QA-sweep fast path. Completeness: 6/10. It preserves smoke testing but saves less time because the card still consumed a QA pass.

C) Dev-sweep moves directly to Ready to Ship. Completeness: 5/10. It matches the literal card text but violates the board's explicit human-only transition.

Net: dev-sweep owns eligibility; the human owns Ready to Ship.

### Engineering review decision D2 - default posture

The original decision was whether this is enabled by default. The follow-up decision is to make the feature default-on while keeping tight thresholds and the human Ready-to-Ship gate.

Recommendation: default on with tight thresholds; teams can opt out per repo by setting `fastPath.enabled` to `false`.

A) Default on with tight thresholds (selected). Completeness: 9/10. It satisfies the card's intent, keeps dev-sweep from moving cards to Ready to Ship, and keeps the human production gate.

B) Default off. Completeness: 6/10. It is safest for existing installs but fails the follow-up request to make the feature enabled by default.

C) Default on for docs only. Completeness: 5/10. It is safer but too narrow to satisfy the card's intent.

Net: default-on makes the fast path available immediately; the tight risk thresholds and human-only Ready to Ship move keep the workflow trustworthy.

## Schema and architecture impact

No Linear statuses are added. The design adds a default-on `fastPath` config block, a `fast-path:eligible` label, and one audit comment convention, for example `[auto-sweep-fast-path COD-83]`. README, SETUP, and `docs/linear-rules.md` should document the default-on behavior.

## Non-goals

- Skipping code review.
- Skipping ship-sweep sanity checks.
- Letting an unattended agent move a card into Ready to Ship.
- Moving cards directly to Done.
- Fast-pathing security, data, UI, API/CLI/SDK, integration, research, or performance-labelled cards.

## Acceptance criteria

- Default behavior is unchanged.
- An eligible tiny change gets `fast-path:eligible` and a clear audit comment.
- A human can skip QA Passed by manually moving the eligible card from In Review to Ready to Ship.
- Any disallowed label, size excess, failed test, unresolved review issue, or non-high confidence blocks the fast path.
- `requireShipApproval` continues to require `ship:approved`.
- Ship-sweep accepts `qa:passed` or human-moved `fast-path:eligible` only when `fastPath.enabled !== false`, rejects fast-path-only evidence when opted out, and rejects both if a live foreign claim remains.
- Tests cover eligible/ineligible classifications and ship-sweep sanity behavior.

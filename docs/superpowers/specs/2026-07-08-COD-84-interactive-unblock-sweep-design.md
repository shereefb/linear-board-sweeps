# COD-84 interactive unblock sweep - design

**Date:** 2026-07-08
**Status:** Ready for implementation after spec-sweep engineering, DevEx, and CSO review.
**Card:** COD-84, "Interactive user-blocked skill"

## Problem

The sweeps intentionally route unanswered questions and unrecoverable actions into Linear cards with blocking labels. That is good for unattended operation, but the user needs one interactive command that finds those blocked tasks across all registered auto-sweep repos, explains each block, records the user's resolution, and clears the appropriate blocking label.

Today the launcher already knows registered anchors and active projects through `linear-watch.mjs register/list/tick` (`scripts/linear-watch.mjs:729`) and reads each anchor's `.env`/config (`scripts/linear-watch.mjs:633`). The Linear helper already exposes a shared `gql()` client (`scripts/linear.mjs:72`). The new feature should reuse those paths.

## Brainstormed approaches

1. **Recommended: new `unblock-sweep` skill plus a small Linear query helper.** The skill is the interactive product; a helper lists blocked cards and applies label/comment updates with the same API client.
2. **CLI-only command.** Faster to build, but worse for the user's actual need: resolving ambiguous questions interactively with context.
3. **Launcher auto-resolution.** Rejected. The launcher must not guess user answers or clear blockers unattended.

## Design

Add a cross-runtime `unblock-sweep` skill to the kit and installed anchors. It is not a scheduled sweep and must not be added to `SWEEP_CFG`, because everything in `SWEEP_CFG` is eligible for unattended launcher dispatch. `unblock-sweep` runs only when invoked by a human. It scans every registered anchor, regardless of whether the project currently has the `auto-sweep` project label, because the card explicitly asks for blocked tasks across all auto-sweep repos whether active or not.

For each anchor, it loads `.claude/linear-sweep.json` and `.env`, then lists cards in the configured project carrying one of these labels:

- `blocked:open-questions`
- `blocked:needs-user`
- `qa:needs-changes`

For each card, it gathers title, URL, state, labels, recent comments, and the newest blocking marker/comment. The skill then presents one card at a time to the user with a compact explanation:

- what is blocked,
- what question/action is needed,
- what the safe resolution options are,
- what exact Linear mutation will happen.

After the user chooses, the skill posts a resolution comment, removes the resolved blocking label, and optionally moves the card to the correct queue:

- `blocked:open-questions`: remove the label and leave the card in its current state so the next sweep resumes.
- `blocked:needs-user`: remove only if the user supplied a concrete resolution; leave state unchanged unless the user explicitly chooses a queue.
- `qa:needs-changes`: either leave for dev-sweep with the user-supplied fix notes, or move backward to Ready for Dev if the current state requires it.

The skill never runs unattended and never clears blockers without an explicit user choice. It must remove blocking labels explicitly rather than relying on its own comment to look like a human reply; downstream sweeps use labels as the durable blocked signal.

## DevEx review

### Developer persona

Primary persona: the repository owner/operator who trusts the sweeps for routine work but wants a short, reliable unblock session when cards pile up.

### DevEx decision D1 - command shape

The decision is whether the experience should be a skill-led interactive flow or a plain CLI list. The stakes are whether the user can resolve ambiguous blockers without opening many Linear tabs.

Recommendation: build the skill-led flow, with helper commands for listing and mutation.

A) Skill-led flow (recommended). Completeness: 9/10. It explains context, asks one decision at a time, and can apply the chosen Linear update. It matches how the rest of the board-sweep workflow is operated.

B) CLI-only command. Completeness: 6/10. It is scriptable and testable, but the user still has to interpret comments and decide mutations manually.

C) Read-only report. Completeness: 4/10. It reduces discovery friction but does not actually unblock the queue.

Net: the product is an interactive skill; helpers keep the API work testable.

### DevEx requirements

- Time to first blocked card under 10 seconds on a normal registry.
- Clear skip/resolve/defer controls for each card.
- Summarize all actions at the end.
- Never require the user to know Linear label internals.

## CSO review

### Security-sensitive surfaces

This feature reads and mutates Linear task data across registered repos, using `.env` API keys. It must treat card comments as untrusted user content and must not leak or print secrets from local env files.

### Security decision D1 - mutation authority

The decision is whether to allow bulk clearing labels. The risk is accidentally unblocking many cards based on stale or misunderstood context.

Recommendation: require one explicit user decision per card.

A) One-card-at-a-time mutation (recommended). Completeness: 9/10. It is slower but prevents bulk accidental state changes and leaves an audit trail per card.

B) Bulk clear selected labels. Completeness: 5/10. It is fast for cleanup but too easy to clear blockers without understanding the needed action.

C) Read-only only. Completeness: 4/10. It avoids mutation risk but fails the card.

Net: allow mutation, but gate every card.

### Security requirements

- Do not print `LINEAR_API_KEY`.
- Do not execute code, shell commands, or markdown links from card text.
- Post a Linear audit comment before or in the same operation as removing a blocking label.
- On API failure, stop on that card and leave labels unchanged.

## Engineering review

### Engineering decision D1 - source of projects

The decision is whether to scan only active projects or all registered anchors. The card explicitly says active or not.

Recommendation: scan all registered anchors, and show active/paused status as context.

A) All registered anchors (recommended). Completeness: 10/10. It satisfies the card and uses the registry as the source of installed auto-sweep repos.

B) Only active `auto-sweep` projects. Completeness: 6/10. It is cheaper but misses paused projects that still have blocked human work.

C) Current repo only. Completeness: 3/10. It is useful for development but not the requested operator workflow.

Net: registry-wide scan is required.

### Independent adversarial review

The outside reviewer must verify that the registry path is machine-local, that `linear-watch.mjs` already has the needed anchor/config/env readers, and that shared `gql()` is reusable without duplicating a Linear client.

## Schema and architecture impact

No Linear schema changes. Add one new skill directory and likely one helper command or exported helper in `scripts/linear-watch.mjs`/`scripts/linear.mjs`. Because auto-update currently copies only sweep skill dirs derived from `SWEEPS`, implementation must add a propagation path for manual non-sweep skills. README, SETUP, templates, and `docs/linear-rules.md` should list the planned unblock workflow. The architecture keeps unattended sweeps separate from human unblock actions.

## Acceptance criteria

- The skill lists blocked cards across all registered anchors.
- It includes active and paused projects.
- It shows one card at a time and records an explicit user resolution.
- It removes only the blocking labels selected for that card.
- It posts an audit comment with the resolution.
- It handles missing `.env` or API errors per anchor without aborting the whole scan.
- It is never dispatched by scheduled `tick`.
- Registered anchors receive the skill through setup and auto-update.

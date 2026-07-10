# COD-150: Manual fast-track sweep design

**Status:** Approved design; awaiting implementation plan review.

## Goal

Add a `/manual-sweep` skill that turns a user-provided issue description into a
manually initiated, resumable sweep through the existing Linear workflow. It
keeps the initial Spec brainstorming interactive, then asks whether the user
wants the issue fast-tracked. A confirmed request may automatically reach Ship
after all normal quality gates pass.

## Scope

- Create a new `COD-*` issue in the configured Linear project and put it in
  `Spec` with `sweep:manual-only`.
- Orchestrate the canonical `spec-sweep`, `dev-sweep`, `qa-sweep`, and
  `ship-sweep` as separate handoffs.
- Add and use a `manual-sweep:fast-track-requested` label to record the user's
  requested exception.
- Let Dev evaluate the request and, when safe, add the existing
  `fast-path:eligible` evidence label.
- Automatically hand a QA-passed, approved fast-track card to Ship.

Out of scope: copying implementation logic from existing sweeps into the new
skill, weakening the existing review/test/QA requirements, or changing the
scheduled launcher behavior for ordinary cards.

## User flow

1. The user invokes `/manual-sweep <issue description>`.
2. The skill creates the configured-project issue in `Spec` with
   `sweep:manual-only`, unless the invocation explicitly resumes an existing
   card.
3. It performs the normal interactive brainstorming needed to produce the
   Spec design and plan. Where `plan-eng-review` is required, it uses the
   existing prose fallback and automatically records the recommended decision.
4. After the Spec is approved, it asks once whether to fast-track shipping.
5. A `yes` adds `manual-sweep:fast-track-requested` and posts one immutable
   approval marker: `[manual-sweep-ship-approval <issue-id> <spec-path>
   <spec-commit> <nonce>]`. The marker must be human-authored, postdate the
   final approved spec, and be unique for the issue. Missing, malformed,
   agent-authored, stale, superseded, or revoked markers fail closed. A `no`
   leaves the card in the normal manual-only flow.
6. For a confirmed request, the orchestrator invokes the canonical sweeps in
   order: Spec, Dev, QA, then Ship when the required terminal conditions hold.

## Architecture

`/manual-sweep` is a thin orchestration skill. It owns only issue creation,
the interactive decision, intent/audit state, and the decision to invoke the
next canonical sweep. Each existing sweep continues to own its established
claim labels, artifacts, reviews, state moves, branches, testing, and recovery
protocols.

It invokes a canonical sweep through a **direct-manual-handoff contract**, not
by clearing `sweep:manual-only`. The named stage receives the exact issue key,
expected source state, an opaque handoff ID, and deterministic worktree/log
paths. Before its first mutation it performs the scheduled single-card
dependency and repository-routing preflights, verifies the expected state and
absence of a live foreign claim, and writes a stage-specific handoff marker.
Only that named invocation may ignore `sweep:manual-only`; scheduled selection
continues to reject it. Resume reads the marker and authoritative post-state
before continuing, so it cannot repeat a completed stage or make a parallel
claim.

The required state is intentionally explicit:

- `sweep:manual-only` keeps the card out of unattended scheduled selection.
- `manual-sweep:fast-track-requested` means a user has asked for the exception
  and its approval marker is present. `scripts/linear.mjs setup-team` must
  provision it, and the manual skill must propagate to registered anchors while
  remaining outside scheduled `SWEEPS`.
- `fast-path:eligible` remains Dev's evidence that the implementation cleared
  its fast-track gate; it is never applied when the request is created.
- `qa:passed` remains QA's evidence before automatic Ship handoff.

The orchestrator derives the next action from the current issue state, labels,
and stable audit comments. This makes a later invocation resume instead of
recreating the issue, replaying a completed sweep, or duplicating a Ship move.

## Dev fast-track request policy

When Dev sees `manual-sweep:fast-track-requested` through the direct-manual
handoff contract, it treats it as a user-approved override of the normal
fast-path **size and allowed-label** thresholds. It must not grant
`fast-path:eligible` merely because the request exists. It still requires:

- green implementation verification;
- the required code and independent reviews with no unresolved findings;
- successful required specialized lenses; and
- no material security, data-integrity, external-input, deployment, API/CLI,
  UI, performance, or other major risk surface.

Any of those conditions is a "massive reason not to". Dev records the reason
on the card and follows the normal QA/Signoff path rather than adding
`fast-path:eligible`. The request label remains as the user's stated intent,
not as evidence that the exception was safe.

Precedence is strict: `factory:learning-generated` remains ineligible;
`fastPath.enabled: false` disables the exception; a final-tier review or
specialized-lens failure denies it; and every material risk surface denies it.
Only the configured size and allowed-label checks are bypassed. Dev removes a
stale eligibility label whenever these conditions fail.

## Automatic Ship handoff

After QA completes, `/manual-sweep` may move the card from `Signoff` to `Ship`
and invoke `ship-sweep` only when all of the following are true:

1. The fast-track approval audit comment exists.
2. `manual-sweep:fast-track-requested` is present.
3. Dev added `fast-path:eligible`.
4. QA added `qa:passed`.
5. The card is still in `Signoff`, carries no blocking label or live foreign
   in-progress claim, and has no unresolved dependency.
6. If `config.requireShipApproval` is true, `ship:approved` is present; the
   manual authorization never weakens this optional hardened gate.

This explicit, user-recorded approval is the manual workflow's authorization
for the otherwise human-only Ship transition. The transition is validate the
full predicate, establish the Ship direct-handoff marker, move `Signoff` to
`Ship`, re-read the exact state/labels/claim, then invoke the named single Ship
runner. `ship-sweep` retains every existing pre-merge sanity check,
single-runner behavior, merge/deploy execution, and canary verification. A
failed condition stops rather than forcing a Ship move.

## Error handling and recovery

- A missing user answer after brainstorming leaves the card in `Spec`; no
  fast-track label or Ship authority is inferred.
- If any handoff blocks or fails, the orchestrator posts/uses the existing
  card evidence and stops at the relevant stage. A later `/manual-sweep`
  invocation re-reads the card and resumes only the unfinished stage.
- If Dev declines fast-path eligibility, the card follows the normal
  QA-to-Signoff workflow and never auto-enters Ship.
- Before every transition, re-read the issue. Do not overwrite a human move or
  duplicate a completed handoff.

## Review depth decision

**Initial tier:** Tier 2 (material).

The change coordinates four workflow skills, alters a production-adjacent Ship
authorization path, introduces a new persistent label/audit contract, and
requires exact recovery behavior across the scheduler and Linear. Expected
surface includes the canonical and installed skill copies, label provisioning,
workflow documentation, and focused policy tests. It has interface, state,
rollout, and user-visible failure risks.

**Selected reviews:** pre-plan `plan-eng-review` plus an independent
adversarial reviewer; DevEx review is not selected because this is an internal
operator command rather than a public API/CLI/SDK. Security and performance
lenses are not initially material, but the engineering reviews must validate
the Ship-authorization trust boundary. Reassess after the concrete plan;
tier may increase but not decrease.

**Pre-plan review outcome:** clear after corrections. The independent review
found that retaining `sweep:manual-only` would otherwise make every canonical
handoff ineligible, that a free-form dated comment could not safely authorize
Ship, and that the optional `ship:approved` hardening was unspecified. The
direct-handoff contract, immutable human approval marker, hardened-config
predicate, label provisioning, and Dev precedence rules above resolve those
findings. No separate DevEx, security, or performance lens is materially
applicable; the review targets are policy/state correctness, not a public API,
untrusted external input, or a performance-sensitive runtime path.

## Verification

Focused tests and documentation checks must prove:

1. `/manual-sweep` creates the correct project card in `Spec` with
   `sweep:manual-only`.
2. The fast-track question is asked only after initial Spec brainstorming.
3. A positive response writes the provisioned request label and a unique,
   human-authored, current approval marker; a negative response does neither.
4. Normal cards retain current fast-path behavior.
5. Requested cards may bypass only size/allowed-label thresholds, never the
   verification, review, specialized-lens, or material-risk gates.
6. Ordinary scheduled selection still excludes manual-only/requested cards;
   named direct handoffs reject wrong state, foreign claims, and blockers.
7. Automatic Ship handoff requires exact approval, request, eligibility,
   QA-passed, Signoff-state, dependency, and optional `ship:approved` evidence
   and is idempotent on resume.
8. A Dev refusal routes the card to normal Signoff instead of Ship.
9. Canonical and installed skill copies remain byte-identical where the repo
   requires synchronized copies.

## Schema and architecture impact

No application data schema changes. The workflow architecture gains one
issue-label contract, one stable approval-comment convention, and a manual
orchestrator-to-canonical-sweeps handoff contract. README and workflow docs
must describe the new user-authorized exception without representing it as an
unattended scheduler capability.

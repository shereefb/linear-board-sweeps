# COD-130 Adaptive Spec-Sweep Review Depth — Design

**Status:** Approved for implementation.
**Card:** COD-130, “Make spec-sweep engineering review depth adaptive.”

## Problem

Spec-sweep currently runs `/plan-eng-review` against every design spec before it writes the implementation plan. That protects the pipeline from expanding a false premise into a large plan, but it applies the same cost to a mechanical copy or styling change as it does to a cross-module concurrency feature. It also does not guarantee that the generated implementation plan itself is reviewed.

A fixed two-pass policy would close the second gap but overcorrect in the other direction. Tiny, low-risk changes should not pay for two full engineering reviews. Material work should receive both an early architecture check and a later executability check. The sweep therefore needs bounded judgment, explicit safety floors, and an audit trail.

## Goals

- Select zero, one, or two engineering-review passes from the card, codebase, draft spec, and generated plan.
- Catch false premises before plan generation when the spec carries meaningful uncertainty.
- Review the completed implementation plan when execution detail carries meaningful risk.
- Let genuinely mechanical work skip heavyweight plan reviews.
- Preserve mandatory security, performance, research, design, and developer-experience lenses when their defect class is materially present.
- Make every skip and escalation auditable in the spec, plan, and Linear handoff.
- Reassess after plan generation and allow review depth only to stay level or increase.

## Non-goals

- No numeric risk score or configurable scoring engine in the first version.
- No change to dev-sweep code review, QA, Signoff, or Ship gates.
- No automatic fast-path eligibility at Spec time; the existing dev-sweep fast path still uses the actual diff.
- No change to gstack’s standard `GSTACK REVIEW REPORT` schema.
- No application code, database schema, migration, or production deployment.

## Review Unit

An **engineering-review pass** is one invocation of `/plan-eng-review` against an explicit artifact:

- **Spec pass:** review the design spec before implementation-plan generation.
- **Plan pass:** review the completed implementation plan after generation.

The existing independent adversarial reviewer remains required once per non-Tier-0 card, not once per pass. Pair it with the selected pass for Tier 1. For Tier 2, pair it with the early spec pass so false reuse, mechanism, and premise claims are corrected before the plan expands them. The later `/plan-eng-review` still validates concrete execution details against the code.

All review skills continue to use spec-sweep’s unattended prose mode: surface the decision brief, choose the recommended option, record the choice, and continue. Owner-only missing information still follows the existing `blocked:open-questions` path.

## Initial Classification

After brainstorming and codebase exploration, but before any engineering review, add a `Review depth decision` section to the draft spec. Record:

- Predicted files/modules and approximate change size.
- Whether the change adds behavior, state, persistence, interfaces, dependencies, rollout work, or user-visible failure modes.
- Relevant risk and specialized-lens surfaces.
- Initial tier, selected review target or targets, and concise rationale.

Predicted file count and line count are evidence, not a mechanical classifier. The sweep must explain why the work is simple or material instead of gaming a threshold.

### Tier 0 — Mechanical

Select Tier 0 only when all of these are true:

- The change is localized and follows an existing pattern.
- It introduces no meaningful behavior, state transition, persistence, public contract, dependency, migration, or rollout change.
- It has no material auth, security, data-integrity, external-input, concurrency, performance, accessibility, or destructive-operation risk.
- Acceptance is objective and the verification path is obvious.
- The expected footprint is genuinely small; normally no more than two files and roughly the existing fast-path size, though size alone never establishes Tier 0.

Examples include a copy correction, spacing or design-token adjustment, icon swap, or obvious documentation fix. Tier 0 skips both engineering-review passes and the independent adversarial reviewer. Spec and plan self-review remain mandatory.

### Tier 1 — Bounded

Select Tier 1 for a small, understandable behavior change that uses established architecture, has a limited footprint, and does not meet a Tier 2 floor. Run exactly one engineering-review pass at the point of greatest uncertainty:

- Choose the **spec pass** when requirements, architecture, data flow, scope, or reuse claims carry the risk.
- Choose the **plan pass** when the desired behavior is already clear but file selection, task sequencing, failure handling, or tests carry the risk.

Run the independent adversarial reviewer against the same artifact.

### Tier 2 — Material

Select Tier 2 for new architecture, multiple interacting modules, complex state, significant error paths, or a material risk surface. Run both passes:

1. Clear the spec pass and its adversarial premise review.
2. Generate the implementation plan from the corrected spec.
3. Clear the plan pass before landing the docs.

Tier 2 is mandatory for destructive data migrations, auth-boundary changes, concurrency/locking, cross-repo production changes, or irreversible rollout behavior. Major public API/CLI/SDK contract changes and unfamiliar external integrations default to Tier 2; a downgrade to Tier 1 requires concrete evidence that the work is backward-compatible, bounded, and uses an established mechanism.

## Specialized Review Lenses

Domain labels make a lens a candidate; they do not by themselves prove that a heavyweight review is useful.

- A UI label invokes `/plan-design-review` only when the card changes interaction, hierarchy, accessibility, responsive behavior, or a user flow. Pure copy, token, spacing, or icon work may skip it with a recorded rationale.
- An API/CLI/SDK label invokes `/plan-devex-review` when public ergonomics, compatibility, documentation, or adoption flow changes materially.
- Actual auth, security, data, or external-input risk always invokes `/cso`, regardless of engineering-review tier.
- Actual performance-sensitive work always invokes the configured performance lens.
- Unfamiliar integrations or APIs still invoke research before brainstorming.

A specialized lens complements the engineering-review tier; it does not count as a spec or plan engineering pass.

## Plan Generation and Monotonic Reassessment

Generate the implementation plan after every review selected for the pre-plan stage has cleared. Then reassess the tier using the plan’s concrete:

- File/module map.
- Interfaces and dependency graph.
- Task count and ordering.
- Test and verification plan.
- Failure modes, rollout steps, and operational work.
- Newly discovered risk or specialized-lens surfaces.

The final tier may equal or exceed the initial tier; it may never decrease. This prevents a late “actually tiny” claim from erasing a review already judged necessary.

Escalation rules:

- Tier 0 → Tier 1: run the plan pass, because the plan is now the concrete artifact that disproved the mechanical classification.
- Tier 0 → Tier 2: run the plan pass and record that the missed spec pass is a classification failure. If the new risk exposes an unresolved design premise, also run the spec pass and regenerate/reconcile the plan.
- Tier 1 spec-only → Tier 2: run the plan pass.
- Tier 1 plan-only → Tier 2: run the spec pass against the linked spec, then reconcile and re-review the plan if the spec changes materially.

Any newly discovered specialized lens runs before terminal handoff. Findings are folded into both artifacts wherever they change the design-to-execution contract.

## Audit and Terminal Gate

Both artifacts contain a compact `Spec-sweep review audit` table with:

| Field | Required content |
|---|---|
| Initial tier | 0, 1, or 2 plus rationale |
| Predicted footprint | Files/modules and approximate size |
| Risk surfaces | Present and explicitly absent material risks |
| Selected reviews | Spec pass, plan pass, adversarial pass, and specialized lenses |
| Post-plan tier | Same or escalated, never lower |
| Review outcome | Clear, skipped with rationale, or unresolved |

The standard gstack report remains intact when a review skill writes it. The local audit distinguishes spec and plan targets without requiring a change to gstack’s report format.

The card may move to Dev only when:

- Every review required by the final tier ran and is clear.
- Every materially applicable specialized lens ran and is clear.
- The spec and plan agree after all findings are folded in.
- No unresolved decisions remain.
- The Linear handoff states the initial/final tier, review targets, skips, escalations, and key corrections.

## Files and Documentation

- `skills/spec-sweep/SKILL.md` — canonical distributed policy.
- `.claude/skills/spec-sweep/SKILL.md` — installed in-repo copy; must remain byte-identical to the canonical skill.
- `tests/spec-sweep-doc.test.mjs` — policy and sequencing regression tests for both copies.
- `README.md` — summarize adaptive review depth in the kit overview.
- `docs/linear-rules.md` — define the evidence required before a spec-sweep card enters Dev.

No configuration field is added. Judgment lives in the canonical skill, while tests enforce the safety floors, monotonic reassessment, and terminal gate.

## Testing

The documentation test must verify:

- Canonical and installed spec-sweep skills are identical.
- All three tiers and their pass counts are present.
- Tier 1 chooses an explicit spec or plan target.
- Tier 2 clears the spec before plan generation and reviews the completed plan afterward.
- Tier 0 excludes material risk surfaces.
- Post-plan reassessment is monotonic and can trigger missing reviews.
- Specialized labels are candidates, while material security/performance surfaces remain mandatory.
- The Dev move requires every review selected by the final tier to be clear with no unresolved decisions.

Run the focused test, then the full Node test suite and `git diff --check`.

## Failure Modes

- **Everything becomes Tier 2:** require a concise rationale tied to concrete scope/risk, and include Tier 0/1 examples.
- **Everything becomes Tier 0 to save tokens:** enforce safety floors, audit the predicted footprint, and reassess from the completed plan.
- **A label causes an irrelevant heavyweight lens:** distinguish candidate labels from material defect surfaces and require a skip rationale.
- **The plan grows after a skipped spec review:** monotonic reassessment runs the plan pass and adds the spec pass when the growth exposes a design premise.
- **Spec and plan disagree after a late review:** terminal gate requires reconciliation before Dev.
- **Canonical copies drift:** the focused test compares them byte-for-byte.

## Schema and Architecture Impact

No runtime schema or application architecture changes. This modifies the control policy of spec-sweep and its documented handoff contract. The adaptive review-depth policy is planned under COD-130 until the skill and tests land.

## Design Self-Review

- Placeholder scan: no TBDs, TODOs, or deferred implementation choices.
- Internal consistency: tiers, safety floors, specialized lenses, escalation, and terminal gate use the same definitions throughout.
- Scope: one deployable repository and one policy surface; no new scoring framework or configuration.
- Ambiguity: review pass, adversarial-review count, downgrade behavior, and late escalation are explicit.

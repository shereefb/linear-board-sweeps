# COD-150 Manual Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` task by task. Steps use checkbox syntax for tracking.

**Goal:** Add `/manual-sweep`, a human-invoked, resumable orchestration skill that can create a card and, after recorded human fast-track approval, pass it through the existing sweeps without enrolling it in scheduled automation.

**Architecture:** The new skill owns creation, approval evidence, and stage invocation; canonical Spec owns the interactive brainstorming and lands the artifact before approval is requested. A named direct-handoff contract lets canonical sweeps process one manual-only card without removing the scheduled exclusion. Each direct stage claims only its own card, heartbeats, and releases only its own claim. Dev preserves its existing fast-path proof obligations; only size and allowed-label limits can be overridden for a requested manual fast track.

**Tech stack:** Markdown skills, Node.js 18+ and `node:test`, existing Linear commands and issue/comment APIs.

## Global constraints

- Every changed propagated skill has matching `skills/` and `.claude/skills/` copies.
- The scheduled launcher still rejects `sweep:manual-only` and never schedules `manual-sweep`.
- Direct handoffs validate card, stage, source state, route, dependencies, and foreign claims before mutation.
- The user request label is not eligibility; only Dev adds `fast-path:eligible`.
- No fast track bypasses tests, reviews, specialized lenses, material-risk denial, disabled config, factory-learning exclusion, or the optional hardened `ship:approved` requirement.

## File map

| Files | Change |
| --- | --- |
| `skills/manual-sweep/SKILL.md`, `.claude/skills/manual-sweep/SKILL.md` | New manual orchestration and approval/resume protocol. |
| `skills/{spec,dev,qa,ship}-sweep/SKILL.md`, installed mirrors | Direct-handoff admission; Dev and Ship exception policy. |
| `scripts/linear.mjs` | Provision the request label. |
| `scripts/linear-watch.mjs` | Propagate the manual skill without scheduling it. |
| `tests/manual-sweep-doc.test.mjs`, `tests/linear-watch.test.mjs` | Parity, policy, propagation, and negative-path coverage. |
| `README.md`, `docs/linear-rules.md`, `AGENTS.md`, `templates/AGENTS.snippet.md` | Operator policy and discovery docs. |

## Direct-handoff contract

`manual-sweep` creates/resumes then invokes direct Spec. After Spec commits its artifact, it asks for fast-track and writes a marker bound to the actual path and commit. Each named stage receives `MANUAL_SWEEP_ISSUE`, `MANUAL_SWEEP_STAGE`, `MANUAL_SWEEP_EXPECTED_STATE`, `MANUAL_SWEEP_HANDOFF_ID`, and (for Ship) `MANUAL_SWEEP_APPROVAL_MARKER`. The stage checks those fields, route/dependency/card state, and absence of every foreign claim before writing `[manual-sweep-handoff <stage> <id>]`; it claims only its own card, heartbeats, and releases only its claim. Approval validation queries `createdAt` and author identity, trusts only the requesting user, and rejects a later `[manual-sweep-ship-revoked <nonce>]` marker. Normal scheduled runs never honor this contract.

### Task 1: Create and propagate the manual skill

**Files:** Create `skills/manual-sweep/SKILL.md`, `.claude/skills/manual-sweep/SKILL.md`, `tests/manual-sweep-doc.test.mjs`; modify `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.

- [ ] Write failing tests that assert manual-skill byte parity; require manual-only issue creation, post-brainstorm approval, exact `MANUAL_SWEEP_*` fields, and current human marker validation; change the launcher assertion to:

  ```js
  assert.deepEqual(MANUAL_SKILL_DIRS, ["unblock-sweep", "manual-sweep"]);
  assert.ok(PROPAGATED_SKILL_DIRS.includes("manual-sweep"));
  assert.ok(!SWEEPS.includes("manual"));
  ```

- [ ] Run `node --test tests/manual-sweep-doc.test.mjs tests/linear-watch.test.mjs` and observe failure because neither skill nor propagation entry exists.
- [ ] Implement the skill flow: create/resume → interactive Spec brainstorming → prose review decisions → prompt once → write `[manual-sweep-ship-approval <issue-id> <spec-path> <spec-commit> <nonce>]` plus request label → direct Spec/Dev/QA → validate Ship predicate → direct Ship. Fail closed for no/invalid/revoked approval, stage failure, or Dev denial. Add `manual-sweep` only to `MANUAL_SKILL_DIRS`; mirror the skill exactly.
- [ ] Re-run the same test command and expect PASS.
- [ ] Commit with `git add skills/manual-sweep .claude/skills/manual-sweep scripts/linear-watch.mjs tests/manual-sweep-doc.test.mjs tests/linear-watch.test.mjs && git commit -m "COD-150 add manual sweep orchestration"`.

### Task 2: Provision and document the intent label

**Files:** Modify `scripts/linear.mjs`, `README.md`, `docs/linear-rules.md`, `AGENTS.md`, `templates/AGENTS.snippet.md`, and `tests/manual-sweep-doc.test.mjs`.

- [ ] Add failing assertions that `REQUIRED_LABELS` includes `manual-sweep:fast-track-requested`, docs distinguish it from `fast-path:eligible`, and ordinary scheduled selection continues to reject manual-only cards.
- [ ] Run `node --test tests/manual-sweep-doc.test.mjs`; expect failure.
- [ ] Add the label to the existing required-label array. Document that it records human intent only, that only Dev grants eligibility, and that manual-sweep is propagated but never scheduled.
- [ ] Run `node --test tests/manual-sweep-doc.test.mjs && node scripts/linear.mjs setup-team --help`; expect PASS and a parsable helper.
- [ ] Commit with `git add scripts/linear.mjs README.md docs/linear-rules.md AGENTS.md templates/AGENTS.snippet.md tests/manual-sweep-doc.test.mjs && git commit -m "COD-150 provision manual fast-track requests"`.

### Task 3: Add scoped manual admission to canonical sweeps

**Files:** Modify both copies of `spec-sweep`, `dev-sweep`, `qa-sweep`, and `ship-sweep`; modify `tests/manual-sweep-doc.test.mjs`.

- [ ] Add failing tests for byte parity and require every stage to retain its normal manual-only skip while accepting only a matching direct contract after state, dependency, route, and foreign-claim checks.
- [ ] Run `node --test tests/manual-sweep-doc.test.mjs tests/spec-sweep-doc.test.mjs tests/ship-sweep-doc.test.mjs`; expect failure.
- [ ] Add one identical direct-handoff preflight section to each canonical skill, then copy it to the installed mirror. It must process only the named card, use/reuse an idempotent stage marker, and re-read before handoff. It must reject an absent/mismatched handoff contract rather than silently clearing `sweep:manual-only`.
- [ ] Re-run the same command; expect PASS with the normal scheduled exclusion still explicitly tested.
- [ ] Commit with `git add skills .claude/skills tests/manual-sweep-doc.test.mjs && git commit -m "COD-150 add scoped manual sweep handoffs"`.

### Task 4: Define Dev fast-track precedence

**Files:** Modify both copies of `dev-sweep`; modify `tests/manual-sweep-doc.test.mjs`.

- [ ] Write failing table-driven document assertions for: factory-learning always denies; disabled `fastPath` denies; material risk, failed test, failed review, or failed lens denies; only size and allowed-label gates may be ignored; stale eligibility is removed on denial.
- [ ] Run `node --test tests/manual-sweep-doc.test.mjs`; expect failure.
- [ ] Amend Dev’s optional fast-path section with this ordered decision rule:

  ```text
  factory-learning or fastPath disabled → deny
  no manual request → existing normal evaluation
  manual request plus any required gate failure → deny, remove stale eligibility, comment why
  manual request plus every required gate clear → bypass size and allowed-label limits only
  ```

- [ ] Run `node --test tests/manual-sweep-doc.test.mjs tests/ship-sweep-doc.test.mjs`; expect PASS.
- [ ] Commit with `git add skills/dev-sweep .claude/skills/dev-sweep tests/manual-sweep-doc.test.mjs && git commit -m "COD-150 gate requested fast tracks in dev"`.

### Task 5: Define verified automatic Ship transition

**Files:** Modify both copies of `manual-sweep` and `ship-sweep`; modify `tests/manual-sweep-doc.test.mjs`.

- [ ] Add failing tests for missing/malformed/agent/stale/revoked approval, missing request/eligibility/QA evidence, wrong state, blocker, foreign claim, and absent `ship:approved` when hardened config is enabled. Assert `validate → marker → Signoff-to-Ship move → re-read → named Ship invocation`.
- [ ] Run `node --test tests/manual-sweep-doc.test.mjs tests/ship-sweep-doc.test.mjs`; expect failure.
- [ ] Implement the exact predicate: current human approval marker; request label; Dev eligibility; QA pass; `Signoff`; resolved dependencies; no blocking/foreign claim; and `ship:approved` whenever configured. Keep all ship-sweep merge/canary gates unchanged. Never invoke Ship twice for an existing handoff ID.
- [ ] Run `node --test tests/manual-sweep-doc.test.mjs tests/linear-watch.test.mjs tests/spec-sweep-doc.test.mjs tests/ship-sweep-doc.test.mjs`; expect PASS.
- [ ] Commit with `git add skills/manual-sweep .claude/skills/manual-sweep skills/ship-sweep .claude/skills/ship-sweep tests/manual-sweep-doc.test.mjs && git commit -m "COD-150 authorize verified manual ship handoff"`.

## Verification map

```text
manual input → create/resume + brainstorming
  → human approval marker (valid/current/human only)
  → direct stage preflight (state/route/dependency/claim)
  → Dev evidence (all quality gates; size/label override only)
  → QA passed + Signoff
  → idempotent verified Ship handoff
```

## Failure controls

| Risk | Control |
| --- | --- |
| Scheduled runner claims a manual card | Preserve manual-only exclusion and test it. |
| Old or agent-made comment authorizes Ship | Require a unique, current, human marker with exact card/spec identity. |
| Resume double-ships | Reuse stage IDs and re-read state after every mutation. |
| Large/risky diff is silently blessed | Override only size/allowed-label limits; all quality/risk gates remain. |
| Hardened approval is bypassed | Require `ship:approved` whenever configured. |

## Review audit

- Final tier: Tier 2. The pre-plan independent review added the direct-handoff, immutable approval, hardened-config, provisioning, and precedence requirements.
- Plan review focus: policy-copy parity, negative scheduled selection, and idempotent transition coverage.
- No DevEx/design/security/performance lens: the work changes internal skill policy without a public API, UI, external input, persistence layer, or performance-sensitive runtime path.
- Sequential implementation: every task shares the same policy/skill surface, so parallel edits would create avoidable conflicts.

## Not in scope

- Making `manual-sweep` a scheduled launcher stage.
- Treating the request label or an agent-authored comment as shipping authority.
- Changing factory-learning cards’ QA and human-approval requirements.

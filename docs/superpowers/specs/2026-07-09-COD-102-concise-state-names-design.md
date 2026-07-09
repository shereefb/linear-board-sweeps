# COD-102: Concise State Names Design

Linear: COD-102
Status: planned
Date: 2026-07-09

## Problem

The board now has the right shape, but the visible workflow state names are verbose and inconsistent with the simpler mental model the owner wants. The requested concise pipeline is:

```text
Backlog -> Spec -> Dev -> QA -> Signoff -> Ship -> Done
```

The card title mentions `Ready for QA`, but the body resolves the desired final names as `Spec`, `Dev`, `QA`, `Signoff`, and `Ship`. This spec follows the body because it gives the full target taxonomy.

## Goals

- Rename the active Linear workflow states in place:
  - `Needs Spec` -> `Spec`
  - `Ready for Dev` -> `Dev`
  - `In Review` -> `QA`
  - `QA Passed` -> `Signoff`
  - `Ready to Ship` -> `Ship`
- Preserve existing cards, state ids, board order, and card sort order.
- Update launcher config, canonical skills, tracked `.claude/skills` copies, templates, setup docs, README, AGENTS, and tests in one coordinated change.
- Keep `In Progress` as a legacy cleanup-only state from COD-99.
- Provide an operator runbook: pause auto-sweep, rename states, dry-run, resume.

## Non-goals

- Do not rename claim labels such as `dev:in-progress` or `qa:passed`. They are machine signals, not user-facing board stages.
- Do not delete or archive old workflow states. The plan renames existing states in place.
- Do not change sweep responsibilities or the human gate. `Signoff` remains the QA-passed human review queue, and `Ship` remains the human-approved ship queue.
- Do not rewrite historical comments or old spec docs.

## Existing Mechanism

`scripts/linear.mjs` declares the current required state names in `REQUIRED_STATES`:

```js
{ name: "Needs Spec", type: "unstarted", color: "#9b59b6" },
{ name: "Ready for Dev", type: "unstarted", color: "#4ea7fc" },
{ name: "QA Passed", type: "started", color: "#f2c94c", after: "In Review" },
{ name: "Ready to Ship", type: "started", color: "#5e6ad2", after: "QA Passed" },
```

`scripts/linear-watch.mjs` fetches queue cards by state name through `SWEEP_CFG`:

```js
spec: { states: ["Needs Spec"], ... }
dev: { states: ["Ready for Dev"], ... }
qa: { states: ["In Review"], ... }
ship: { states: ["Ready to Ship"], ... }
```

`setupTeam()` creates missing states but does not rename existing ones. `retireState()` moves cards between states, which is the wrong primitive for COD-102 because it would create parallel columns or churn cards. Linear's GraphQL schema exposes `workflowStateUpdate(input: WorkflowStateUpdateInput)` with a `name` field, so the right migration is an in-place rename by state id.

## Proposed Behavior

Add one canonical workflow-state mapping in code and make setup, launcher queue config, tests, docs, and skills consume the new names.

```text
LEGACY NAME       TARGET NAME   Sweep meaning
Needs Spec    ->  Spec          spec-sweep source
Ready for Dev ->  Dev           dev-sweep source and active-dev holding state
In Review     ->  QA            qa-sweep source
QA Passed     ->  Signoff       human signoff queue after QA
Ready to Ship ->  Ship          human-approved ship queue
```

Add a Linear helper command:

```bash
node scripts/linear.mjs rename-states <projectId>
```

The helper resolves the project's team states, verifies every source state exists, verifies target-name collisions, and calls `workflowStateUpdate` with `{ name: target }` for each source state. It prints each renamed state and exits non-zero before mutating if the board is already partially renamed in a way it cannot reconcile.

The implementation should be idempotent for the happy completed case: if all target states already exist and all source names are absent, print that the migration is already complete.

## Migration Runbook

1. Pause auto-sweep for the project by removing the `auto-sweep` project label or stopping the launcher.
2. Merge and push the code/docs update to `main`.
3. Load `.env`, then run:

   ```bash
   set -a && . ./.env && set +a
   node scripts/linear.mjs rename-states 81455eb7-1ead-474d-a0c1-54efe75f821e
   ```

4. Run:

   ```bash
   node scripts/linear-watch.mjs tick --dry-run
   ```

5. Confirm the dry run queries `Spec`, `Dev`, `QA`, `Signoff`, and `Ship` without errors.
6. Re-enable auto-sweep.

Rollback is another attended `workflowStateUpdate` run using the reverse mapping. Because the design renames states in place, cards and state ids remain intact.

## Brainstormed Approaches

### A) Rename states in place (recommended)

Completeness: 10/10. This preserves cards, state ids, sort order, and history. It requires one migration helper and a clear pause/resume runbook, but it avoids card moves and does not leave duplicate columns.

### B) Create new states and move cards

Completeness: 7/10. This avoids relying on a rename mutation, but it creates a heavier migration: every card must be moved, old states must be retired later, and any missed card can strand work in a state no sweep watches.

### C) Keep old state names in Linear and update docs only

Completeness: 3/10. This reduces implementation effort, but it does not satisfy the card. Operators would still see the verbose old names on the actual board.

Net: rename in place, with the launcher paused so code and board taxonomy cannot drift during migration.

## Engineering Review

### D1 - Migration primitive

ELI10: We need to choose whether to rename the existing columns or create new columns and move every card. Renaming is like changing a label on a drawer; all the contents stay put. Creating new columns is like moving every paper into a new drawer and hoping none are missed.

Recommendation: A because it changes the visible names while preserving the underlying Linear state ids.

A) Rename existing workflow states in place (recommended). Completeness: 10/10. It keeps card positions, state ids, and historical references stable. It needs a helper because `setupTeam()` only creates states today.

B) Create target states and move cards. Completeness: 7/10. It can work, but it increases migration risk and creates temporary duplicate columns.

C) Update code to support both old and new state names indefinitely. Completeness: 5/10. It helps rollout safety but keeps the taxonomy ambiguous and invites future drift.

Net: implement a rename helper and keep fallback support limited to migration validation, not normal sweep operation.

### D2 - Release sequencing

ELI10: The scripts find cards by exact state name. If the board is renamed before the code changes, sweeps look for old names and go idle. If code changes before the board rename, sweeps look for new names and go idle. The safe path is to pause the launcher for a few minutes, make both changes, dry-run, then resume.

Recommendation: A because it avoids an unattended gap where cards are silently invisible to sweeps.

A) Pause auto-sweep, merge code, rename board states, dry-run, resume (recommended). Completeness: 10/10. It is explicit, short, and auditable.

B) Ship code with dual old/new queue names for one release. Completeness: 8/10. It reduces downtime risk, but it complicates queue selection and can double-count cards if both names exist during a partial migration.

C) Rename board first and let the next code release catch up. Completeness: 4/10. It creates an idle or broken scheduled-run window.

Net: pause and migrate atomically. Do not make dual-name support the normal path unless dry-run proves an unavoidable board transition issue.

### Scope Challenge

What already exists:

- `SWEEP_CFG` is the single launcher source for queue state names.
- `fetchCards()` already accepts a list of state names from each sweep config.
- `setupTeam()` already creates required states and labels.
- `teamMeta()` and `projectStateIdsWith()` already resolve state ids.
- `retireState()` proves this repo can safely mutate workflow state/card state through the existing Linear GraphQL client.

Minimum complete change:

- Update state-name constants and every public workflow reference.
- Add a rename helper based on `workflowStateUpdate`.
- Update both canonical `skills/` and tracked `.claude/skills/` copies.
- Update tests that assert taxonomy names, queue names, holding-state cleanup, and ship-sweep docs.
- Add an attended migration runbook.

### Architecture Review

[P1] (confidence: 9/10) `scripts/linear-watch.mjs:63` - launcher queues are exact state-name filters. The implementation must update `SWEEP_CFG` and must not rename the board while the old launcher is still active.

[P1] (confidence: 9/10) `scripts/linear.mjs:139` - setup creates missing states but does not rename existing states. COD-102 needs a new helper or setup would leave already-installed boards unchanged.

[P2] (confidence: 9/10) `scripts/linear-watch.mjs:82` - holding-state cleanup is tied to `QA Passed`. It must become `Signoff`, while `In Progress` remains in legacy cleanup from COD-99.

Failure scenario 1: board is renamed to `Dev`, but the running launcher still fetches `Ready for Dev`. Dev work appears stuck. Mitigation: pause auto-sweep and dry-run after migration.

Failure scenario 2: only skills are updated, but `.claude/skills` copies are stale in installed anchors. Child agents keep moving cards to old states. Mitigation: update canonical and tracked copies, and rely on self-update propagation.

Failure scenario 3: `QA Passed` is renamed but `HOLDING_STATES` is not. A crashed qa-sweep can strand `qa:in-progress` in `Signoff`. Mitigation: update `HOLDING_STATES` and tests.

### Code Quality Review

Avoid a repo-wide unstructured string replacement. The plan should introduce a small state taxonomy helper or constants so future renames touch one place first, then update prose references deliberately.

Keep `rename-states` inside `scripts/linear.mjs`; adding a separate migration script would duplicate the Linear client and credential behavior.

### Test Review

Required coverage:

```text
State taxonomy
  +-- [GAP] REQUIRED_STATES declares Spec, Dev, Signoff, Ship
  +-- [GAP] Signoff is positioned after QA and Ship after Signoff

Launcher queues
  +-- [GAP] spec fetches ["Spec"]
  +-- [GAP] dev fetches ["Dev"]
  +-- [GAP] qa fetches ["QA"]
  +-- [GAP] ship fetches ["Ship"]
  +-- [GAP] holding cleanup fetches ["Signoff", "In Progress"]

Migration helper
  +-- [GAP] resolves old state ids and calls workflowStateUpdate with target names
  +-- [GAP] no-ops when target names already exist and source names are absent
  +-- [GAP] fails before mutation on partial/colliding state sets

Docs/skills
  +-- [GAP] ship-sweep docs no longer mention "Ready to Ship" as the active queue
  +-- [GAP] AGENTS/template status pipeline uses Spec -> Dev -> QA -> Signoff -> Ship
```

Run `node --test` after implementation.

### Performance Review

No material performance change. The rename helper performs one metadata query and up to five workflow-state update mutations during an attended migration.

## DevEx Review

Classification: CLI/operator workflow.

Developer persona: maintainer operating a Linear board across one or more registered workspaces. They need obvious state names in the UI and predictable unattended sweeps.

Mode: DX polish. This is an enhancement to an existing operator workflow, not a new product surface.

DX scorecard:

| Dimension | Current | Target | Plan requirement |
|-----------|---------|--------|------------------|
| Getting started | 7/10 | 9/10 | README and setup docs show the concise state pipeline directly. |
| CLI/API design | 6/10 | 8/10 | `rename-states <projectId>` is one command and idempotent after completion. |
| Error messages | 6/10 | 8/10 | Partial migration and collision errors name the exact source/target states. |
| Documentation | 7/10 | 9/10 | Operator runbook includes pause, migrate, dry-run, resume, rollback. |
| Upgrade path | 5/10 | 8/10 | Migration is attended and reversible by reverse rename. |
| Dev environment | 8/10 | 8/10 | Existing `node --test` and dry-run commands remain enough. |
| Community/ecosystem | 7/10 | 7/10 | No new public distribution requirement. |
| Measurement | 7/10 | 8/10 | Dry-run validates queue visibility after migration. |

TTHW target: under 3 minutes for an operator to understand that `Spec`, `Dev`, `QA`, `Signoff`, and `Ship` are the board columns.

Magical moment: the dry run after migration shows actionable counts from the concise queues, proving the board rename did not strand automation.

## Independent Adversarial Review

The independent reviewer found:

- No current mechanism renames existing Linear states. `setupTeam()` creates only missing states, and `retireState()` moves cards rather than renaming states. Correction: add an explicit `workflowStateUpdate` helper.
- `SWEEP_CFG` must change atomically with the board migration because queue fetches use exact names.
- Canonical `skills/` and tracked `.claude/skills/` copies both hardcode terminal moves and must both be updated.
- `HOLDING_STATES` must move from `QA Passed` to `Signoff`, while `In Progress` stays as legacy cleanup.
- Tests currently assert the old taxonomy and must be rewritten to protect the rename.

All findings are folded into this spec and the implementation plan.

## Schema & Architecture Impact

README and `docs/linear-rules.md` become the canonical architecture docs for the new state taxonomy. The planned pipeline is:

```text
Backlog -> Spec -> Dev -> QA -> Signoff -> Ship -> Done
```

`Todo`, `Canceled`, `Duplicate`, `Archived`, and legacy `In Progress` remain unchanged. `In Progress` is still cleanup-only.

## Acceptance Criteria

- The Linear board has active states named `Spec`, `Dev`, `QA`, `Signoff`, and `Ship`.
- Scheduled sweeps fetch only the new state names.
- Specs land in `Dev`; dev lands in `QA`; QA lands in `Signoff`; ship fetches `Ship`.
- Holding-state cleanup releases stale claims in `Signoff`; legacy cleanup still includes `In Progress`.
- Setup docs, README, AGENTS, templates, and skill copies use the concise taxonomy.
- `rename-states` is idempotent after a completed migration and fails safely on partial/colliding state sets.
- `node --test` passes.

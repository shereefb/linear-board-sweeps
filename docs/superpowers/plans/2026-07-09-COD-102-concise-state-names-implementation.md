# COD-102: Concise State Names Implementation Plan

Linear: COD-102
Spec: docs/superpowers/specs/2026-07-09-COD-102-concise-state-names-design.md
Date: 2026-07-09

## Goal

Rename the visible Linear workflow states to `Spec`, `Dev`, `QA`, `Signoff`, and `Ship`, while preserving sweep behavior, card history, and the human shipping gate.

## State Map

| Old name | New name | Meaning |
|----------|----------|---------|
| `Needs Spec` | `Spec` | spec-sweep source |
| `Ready for Dev` | `Dev` | dev-sweep source and active-dev holding state |
| `In Review` | `QA` | qa-sweep source |
| `QA Passed` | `Signoff` | QA passed, awaiting human approval |
| `Ready to Ship` | `Ship` | human-approved ship queue |

`In Progress` remains a legacy cleanup-only state from COD-99.

## Steps

1. Add centralized state taxonomy.

   Files: `scripts/linear.mjs`, `scripts/linear-watch.mjs`

   - Define a single old-to-new mapping near the existing state constants.
   - Update `REQUIRED_STATES` to create `Spec`, `Dev`, `Signoff`, `Ship`, and `Archived`.
   - Position `Signoff` after `QA`, and `Ship` after `Signoff`.
   - Update `SWEEP_CFG`:
     - spec: `["Spec"]`
     - dev: `["Dev"]`
     - qa: `["QA"]`
     - ship: `["Ship"]`
   - Update `HOLDING_STATES` to `["Signoff"]`.
   - Keep `LEGACY_CLEANUP_STATES = ["In Progress"]`.

2. Add a rename helper.

   File: `scripts/linear.mjs`

   - Add pure helper logic for planning the rename:
     - all source states present, targets absent -> produce five rename operations;
     - all targets present, sources absent -> already complete, no operations;
     - any target/source collision or partial state set -> fail before mutation.
   - Add `rename-states <projectId>` CLI command.
   - Resolve project team states with ids.
   - Call:

     ```graphql
     mutation($id:String!,$input:WorkflowStateUpdateInput!){
       workflowStateUpdate(id:$id,input:$input){ success workflowState { id name } }
     }
     ```

     with `input: { name: "<target>" }`.
   - Print each rename and a final summary.
   - Do not create, archive, or delete states in this helper.

3. Update scheduled launcher behavior and docs in skill files.

   Files:

   - `skills/spec-sweep/SKILL.md`
   - `skills/dev-sweep/SKILL.md`
   - `skills/qa-sweep/SKILL.md`
   - `skills/ship-sweep/SKILL.md`
   - `skills/unblock-sweep/SKILL.md` if it names the old queues
   - `.claude/skills/spec-sweep/SKILL.md`
   - `.claude/skills/dev-sweep/SKILL.md`
   - `.claude/skills/qa-sweep/SKILL.md`
   - `.claude/skills/ship-sweep/SKILL.md`
   - `.claude/skills/unblock-sweep/SKILL.md` if it names the old queues

   Required wording:

   - spec-sweep processes `Spec` and lands at `Dev`.
   - dev-sweep processes `Dev` and lands at `QA`.
   - qa-sweep processes `QA` and lands at `Signoff`.
   - ship-sweep processes `Ship` and lands at `Done`.
   - Backward bounces use the new source/destination names.
   - The human gate is `Ship`; `Signoff` is QA-passed awaiting human approval.

4. Update public docs and templates.

   Files:

   - `README.md`
   - `AGENTS.md`
   - `docs/linear-rules.md`
   - `SETUP.md`
   - `templates/AGENTS.snippet.md`
   - `templates/linear-sweep.json`
   - `.claude/linear-sweep.json` comments

   Required wording:

   - Canonical pipeline is `Backlog -> Spec -> Dev -> QA -> Signoff -> Ship -> Done`.
   - Active dev is `Dev` plus `dev:in-progress`.
   - `Ship` is human-only and ship-sweep is the only merge/push-to-main path.
   - Fast path lets a human move from `QA` directly to `Ship`.
   - `In Progress` remains legacy cleanup only.

5. Update tests.

   File: `tests/linear.test.mjs`

   - Assert `REQUIRED_STATES` includes `Spec`, `Dev`, `Signoff`, `Ship`.
   - Assert `Signoff` is created before `Ship`.
   - Assert `Signoff.after === "QA"` and `Ship.after === "Signoff"`.
   - Test rename planning:
     - complete old board -> five operations;
     - already renamed board -> no operations;
     - partial/collision board -> throws before mutation.
   - Test `renameStates` calls `workflowStateUpdate` with the right ids and names.

   File: `tests/linear-watch.test.mjs`

   - Assert `SWEEP_CFG.spec.states === ["Spec"]`.
   - Assert `SWEEP_CFG.dev.states === ["Dev"]`.
   - Assert `SWEEP_CFG.qa.states === ["QA"]`.
   - Assert `SWEEP_CFG.ship.states === ["Ship"]`.
   - Assert `HOLDING_STATES === ["Signoff"]`.
   - Assert `CLAIM_CLEANUP_STATES === ["Signoff", "In Progress"]`.
   - Update claim-confirmation tests from `Ready for Dev` to `Dev`.
   - Update dispatch and dry-run fixtures that reference old state names.

   File: `tests/ship-sweep-doc.test.mjs`

   - Update doc assertions from `Ready to Ship` to `Ship`.

6. Run local verification.

   ```bash
   node --test
   ```

7. Run attended board migration after merge.

   ```bash
   set -a && . ./.env && set +a
   node scripts/linear.mjs rename-states 81455eb7-1ead-474d-a0c1-54efe75f821e
   node scripts/linear-watch.mjs tick --dry-run
   ```

   Post a summary comment to COD-102 with the rename output and dry-run result.

## Migration Ordering

1. Remove the `auto-sweep` project label or stop the launcher.
2. Merge and push this implementation.
3. Pull latest `main` on the launcher host.
4. Run `rename-states`.
5. Run `tick --dry-run`.
6. Re-enable `auto-sweep`.

Do not leave the board renamed while an old launcher is active. Do not leave the new launcher active before the board is renamed unless the project is paused.

## Tests

Run:

```bash
node --test
```

Manual validation:

```bash
set -a && . ./.env && set +a
node scripts/linear.mjs query '{ project(id:"81455eb7-1ead-474d-a0c1-54efe75f821e"){ teams(first:1){ nodes{ states(first:100){ nodes{ name } } } } } }'
node scripts/linear-watch.mjs tick --dry-run
```

Expected states include `Spec`, `Dev`, `QA`, `Signoff`, `Ship`, `Done`, `Todo`, `Backlog`, and legacy `In Progress`.

## NOT in Scope

- Renaming workflow labels.
- Deleting or archiving old state records.
- Rewriting historical comments or old specs.
- Changing sweep responsibilities.
- Removing legacy `In Progress` cleanup.

## What Already Exists

- `gql()` wraps Linear GraphQL with repo `.env` credentials.
- `setupTeam()` resolves teams, states, and labels.
- `positionAfter()` computes board order for created states.
- `SWEEP_CFG` centralizes launcher queue names.
- `fetchCards()` queries by configured state names.
- `HOLDING_STATES` and `LEGACY_CLEANUP_STATES` already model no-sweep cleanup states.
- Existing tests cover taxonomy declarations, queue config, holding-state cleanup, and ship-sweep docs.

## Failure Modes

- Board renamed before code deploy: sweeps fetch old names and go idle. Mitigation: pause auto-sweep before migration.
- Code deployed before board rename: sweeps fetch new names and go idle. Mitigation: keep project paused until rename is complete.
- Partial rename: some old and new states coexist. Mitigation: helper fails on partial/collision states before mutation unless the board is fully old or fully renamed.
- Skill copies stale: agents move cards to old state names. Mitigation: update both canonical `skills/` and tracked `.claude/skills/`.
- Stale `qa:in-progress` in `Signoff` is never reaped. Mitigation: update `HOLDING_STATES` and cleanup tests.
- Fast-path docs still mention `In Review -> Ready to Ship`. Mitigation: update docs to `QA -> Ship`.

## Worktree Parallelization

Sequential implementation, no parallelization opportunity. Most changes touch shared taxonomy strings across scripts, skills, docs, and tests; splitting them would create merge conflicts and increase the chance of inconsistent state names.

## Implementation Tasks

- [ ] **T1 (P1, human: ~2h / CC: ~20min)** - taxonomy - Add concise state constants and update `REQUIRED_STATES`, `SWEEP_CFG`, and holding cleanup.
  - Surfaced by: Architecture Review - queue fetches use exact state names.
  - Files: `scripts/linear.mjs`, `scripts/linear-watch.mjs`
  - Verify: `node --test tests/linear.test.mjs tests/linear-watch.test.mjs`

- [ ] **T2 (P1, human: ~2h / CC: ~25min)** - migration - Add safe `rename-states <projectId>` helper using `workflowStateUpdate`.
  - Surfaced by: Independent Adversarial Review - no current mechanism renames existing Linear states.
  - Files: `scripts/linear.mjs`, `tests/linear.test.mjs`
  - Verify: unit tests with mocked `gqlFn`; attended dry-run against Linear after merge.

- [ ] **T3 (P1, human: ~2h / CC: ~20min)** - skills - Update canonical and tracked sweep skills to use `Spec`, `Dev`, `QA`, `Signoff`, and `Ship`.
  - Surfaced by: Independent Adversarial Review - terminal moves are hardcoded in both skill copies.
  - Files: `skills/`, `.claude/skills/`
  - Verify: `rg "Needs Spec|Ready for Dev|In Review|QA Passed|Ready to Ship" skills .claude/skills`

- [ ] **T4 (P2, human: ~1h / CC: ~15min)** - docs/templates - Update README, AGENTS, setup docs, config comments, and templates.
  - Surfaced by: DX Review - operators need the concise model everywhere they read setup or status rules.
  - Files: `README.md`, `AGENTS.md`, `SETUP.md`, `docs/linear-rules.md`, `templates/`, `.claude/linear-sweep.json`
  - Verify: `rg "Needs Spec|Ready for Dev|In Review|QA Passed|Ready to Ship" README.md AGENTS.md SETUP.md docs templates .claude/linear-sweep.json`

- [ ] **T5 (P1, human: ~1h / CC: ~15min)** - verification - Update all taxonomy tests and run the suite.
  - Surfaced by: Test Review - current tests assert old taxonomy names.
  - Files: `tests/linear.test.mjs`, `tests/linear-watch.test.mjs`, `tests/ship-sweep-doc.test.mjs`
  - Verify: `node --test`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | Rename in place with paused launcher; add `rename-states`; update queue and cleanup constants |
| DX Review | `/plan-devex-review` | Operator workflow | 1 | CLEAR | Add migration runbook, idempotent helper behavior, and explicit dry-run validation |
| Independent Adversarial | subagent | Premise tracing | 1 | CLEAR | Folded in missing rename helper, atomic rollout, skill-copy updates, holding-state cleanup, and test rewrites |

- **VERDICT:** ENG + DX + ADVERSARIAL CLEARED - ready to implement.

NO UNRESOLVED DECISIONS

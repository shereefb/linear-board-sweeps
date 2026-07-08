# COD-99: Remove In Progress State Implementation Plan

Linear: COD-99
Spec: docs/superpowers/specs/2026-07-08-COD-99-remove-in-progress-state-design.md
Date: 2026-07-08

## Goal

Stop using the Linear `In Progress` state. `Ready for Dev` becomes the only dev-sweep queue, and `dev:in-progress` remains the ownership marker for active work.

## Steps

1. Update dev sweep source states.

   File: `scripts/linear-watch.mjs`

   - Change `SWEEP_CFG.dev.states` from `["Ready for Dev", "In Progress"]` to `["Ready for Dev"]`.
   - Leave `claim: "dev:in-progress"` unchanged.

2. Add migration support.

   File: `scripts/linear.mjs`

   - Add a command such as `retire-state <projectId> "In Progress" "Ready for Dev"`.
   - It should list cards in the source state, preserve all labels, comment once, and move each card to the destination bottom.
   - It must not add `dev:in-progress` to unclaimed cards. A new claim label would look live because heartbeat age falls back to the freshly updated card timestamp.
   - It should print a dry summary when no cards exist.
   - Do not delete or archive the source Linear state.

3. Keep legacy-state cleanup.

   File: `scripts/linear-watch.mjs`

   - Add `In Progress` to the state list fetched by orphan/holding cleanup, or introduce a named `LEGACY_CLEANUP_STATES` list used by the same cleanup path.
   - Ensure stale `dev:in-progress` claims stranded in `In Progress` are released even though dev-sweep no longer fetches that state.
   - Do not count plain unclaimed `In Progress` cards as actionable dev work after COD-99.

4. Update docs/templates.

   Files:

   - `AGENTS.md`
   - `README.md`
   - `docs/linear-rules.md`
   - `templates/AGENTS.snippet.md`
   - `templates/linear-sweep.json` if any comment lists states
   - `skills/dev-sweep/SKILL.md`
   - `.claude/skills/dev-sweep/SKILL.md`

   Required wording:

   - Pipeline omits `In Progress`.
   - Active dev ownership is `Ready for Dev` plus `dev:in-progress`.
   - Dev-sweep processes `Ready for Dev` only.

5. Update tests.

   File: `tests/linear-watch.test.mjs`

   - Assert `SWEEP_CFG.dev.states` is exactly `["Ready for Dev"]`.
   - Assert a live `dev:in-progress` card in `Ready for Dev` is not actionable.
   - Assert stale claimed cards still become actionable/reapable after the stale threshold.
   - Assert stale `dev:in-progress` claims in legacy `In Progress` are released by orphan/holding cleanup.

   File: `tests/linear.test.mjs`

   - Cover the migration helper's label preservation and destination move input if implemented as pure helpers.

6. Run migration once.

   Command shape:

   ```bash
   set -a && . ./.env && set +a
   node scripts/linear.mjs retire-state 81455eb7-1ead-474d-a0c1-54efe75f821e "In Progress" "Ready for Dev"
   ```

   Post a summary comment on COD-99 with moved card identifiers.

## Tests

Run:

```bash
node --test
```

Manual validation:

```bash
set -a && . ./.env && set +a
node scripts/linear.mjs query '{ issues(first: 20, filter: { project: { id: { eq: "81455eb7-1ead-474d-a0c1-54efe75f821e" } }, state: { name: { eq: "In Progress" } } }) { nodes { identifier title } } }'
node scripts/linear-watch.mjs tick --dry-run
```

## NOT in Scope

- Deleting the Linear workflow state.
- Renaming historical card comments.
- Changing `dev:in-progress` claim semantics.
- Changing QA or ship states.

## What Already Exists

- Claim label: `dev:in-progress`.
- Stale claim reaper and heartbeat handling.
- `move-card-bottom` helper.
- Tests around actionable filtering, state order, and `SWEEP_CFG`.

## Failure Modes

- A live claimed card loses `dev:in-progress` during migration and becomes actionable twice. Mitigation: preserve existing labels exactly.
- An unclaimed card receives a fake fresh `dev:in-progress` label and is suppressed for 90 minutes. Mitigation: migration does not add claim labels.
- A claimed card remains in legacy `In Progress` and is never reaped. Mitigation: include `In Progress` in legacy/orphan cleanup.
- Docs still mention `In Progress`, so agents keep using it. Mitigation: update README, root AGENTS.md, AGENTS snippet, and dev-sweep skills together.
- Deleting the state breaks Linear history or other automations. Mitigation: do not delete it in this implementation.

## Verification Checklist

- [ ] `SWEEP_CFG.dev.states` only contains `Ready for Dev`.
- [ ] Existing active cards were moved and commented.
- [ ] Migration preserved labels without adding fake claim labels.
- [ ] Legacy `In Progress` stale claims are still cleaned up.
- [ ] No public docs describe `In Progress` as normal workflow.
- [ ] `node --test` passes.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | Keep ownership on `dev:in-progress`; do not delete the Linear state in the first pass |
| DX Review | `/plan-devex-review` | Operator-facing workflow | 1 | CLEAR | Make migration visible and docs explicit |

- **VERDICT:** ENG + DX CLEARED - ready to implement.

NO UNRESOLVED DECISIONS

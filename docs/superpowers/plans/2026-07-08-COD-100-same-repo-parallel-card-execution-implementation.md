# COD-100: Same-Repo Parallel Card Execution Implementation Plan

Linear: COD-100
Spec: docs/superpowers/specs/2026-07-08-COD-100-same-repo-parallel-card-execution-design.md
Date: 2026-07-08

## Goal

Add controlled same-repo, per-card parallel execution while preserving COD-82's disjoint-workspace batching and ship-sweep's serial production safety.

## Steps

1. Add config parsing.

   File: `scripts/linear-watch.mjs`

   - Export `sameRepoCardLimit(config, sweep)`.
   - Read `config.parallel.sameRepoCardLimits`.
   - Defaults: spec 4, dev 4, qa 1, ship 1.
   - Clamp invalid values to defaults.
   - Force ship to 1 even if config says otherwise.

2. Add card-slot planning.

   File: `scripts/linear-watch.mjs`

   - Add a pure helper such as `selectCardSlots(cards, cfg, sweep, limit, now)`.
   - It should sort by Linear board order and return up to `limit` actionable cards.
   - It should exclude blocked and live-claimed cards using existing `actionableCards()`.
   - It should produce stable slot metadata: issue id, identifier, sortOrder, slot index.
   - Treat `parallel.maxNonShipDispatches` as the workspace/sweep candidate limit and `sameRepoCardLimits` as the child-card limit under each selected candidate.
   - Log both limits and both selected counts.

3. Add parent-side claiming.

   File: `scripts/linear-watch.mjs`

   - Before dispatch, add the sweep claim label and a heartbeat comment for each selected slot.
   - Include an owner token in the heartbeat: `<host>:<parentRunId>:<issueIdentifier>:<slotIndex>`.
   - Re-fetch and confirm the card is still in the expected state, not blocked, and the latest heartbeat for that sweep claim carries the same owner token.
   - If confirmation fails, skip it and try the next actionable card until the slot limit is reached or the queue ends.
   - In dry-run, report slots without claiming.

4. Add single-card dispatch.

   Files:

   - `scripts/linear-watch.mjs`
   - `skills/spec-sweep/SKILL.md`
   - `skills/dev-sweep/SKILL.md`
   - `skills/qa-sweep/SKILL.md`
   - `.claude/skills/spec-sweep/SKILL.md`
   - `.claude/skills/dev-sweep/SKILL.md`
   - `.claude/skills/qa-sweep/SKILL.md`

   Launcher:

   - Add `issueIdentifier` to dispatch metadata.
   - Set the full child env contract:
     - `AUTO_SWEEP_ISSUE=COD-123`
     - `AUTO_SWEEP_SLOT_INDEX=0`
     - `AUTO_SWEEP_WORKTREE=<repo>/.worktrees/COD-123`
     - `AUTO_SWEEP_LOG_DIR=~/.local/state/linear-board-sweeps/<anchor>/<sweep>/COD-123`
     - `AUTO_SWEEP_TMPDIR=~/.cache/linear-board-sweeps/<parentRunId>/COD-123/tmp`
     - `AUTO_SWEEP_PORT_BASE=<allocated-base>`
     - `AUTO_SWEEP_APP_PORT=<allocated-port>`
     - `AUTO_SWEEP_SCREENSHOT_DIR=<per-card-screenshot-dir>`
     - `AUTO_SWEEP_BROWSER_PROFILE_DIR=<per-card-browser-profile-dir>`
   - Prompt: `Follow the <sweep>-sweep skill for COD-123 only. Do not process other cards.`

   Skills:

   - If a card key is supplied, list only that card and ignore all other queue cards.
   - Use launcher-provided worktree/log/temp/port/screenshot/browser-profile env values when present.
   - Still route questions to comments, heartbeat, and release labels per existing rules.

5. Add isolation helpers.

   File: `scripts/linear-watch.mjs`

   - Add deterministic per-card worktree paths for spec/dev/QA.
   - Use exact issue-key worktree and branch names for dev, for example `COD-123`, to preserve QA/ship handoff.
   - Add per-card log dirs.
   - Add per-card temp dirs.
   - Add a port allocation helper for dev/QA batches. The first implementation can allocate from a deterministic base plus slot offset, and must log chosen ports.

6. Serialize same-repo git landing where needed.

   Files:

   - `skills/spec-sweep/SKILL.md`
   - `.claude/skills/spec-sweep/SKILL.md`

   - Spec children can draft in parallel but must not independently move cards or merge/push docs in same-repo parallel mode.
   - Prefer a parent-managed landing queue: fetch, merge one completed spec branch, push, re-read that card, remove claim, and move that one card if it is still in `Needs Spec`.
   - If child-managed landing is chosen, add an explicit repo-local landing lock around fetch/merge/push/card-move.
   - Dev children keep per-card branches/worktrees and push branches independently.
   - QA children default to one same-repo card, so no extra landing concurrency is required by default.

7. Preserve COD-82 workspace batching.

   File: `scripts/linear-watch.mjs`

   - Keep `selectDispatchBatch()` as the workspace-level selector.
   - For each selected non-ship sweep candidate, expand into card slots up to `sameRepoCardLimit`.
   - Do not count expanded card slots against `parallel.maxNonShipDispatches`; that limit applies before expansion.
   - Do not allow expansion for ship.

8. Update run records.

   Files:

   - `scripts/linear-watch.mjs`
   - COD-94 run-record helpers, if present when implemented

   Include parent/child ids, card key, slot index, worktree/log paths, ports, runtime/model, and exit status.
   If COD-94's helpers are not landed, add a minimal launcher-owned JSONL writer in COD-100 rather than leaving child runs text-only.

9. Make dispatch failures card-specific.

   File: `scripts/linear-watch.mjs`

   - Use card-specific Todo scopes/fingerprints such as `<sweep>:<issueIdentifier>:dispatch`.
   - Include sweep, issue, runtime, worktree, and log path in the stable target payload.
   - Include the issue identifier in Todo titles and bodies.

10. Update docs/templates.

   Files:

   - `README.md`
   - `SETUP.md`
   - `.claude/linear-sweep.json`
   - `templates/linear-sweep.json`
   - `templates/AGENTS.snippet.md`
   - `AGENTS.md`

   Document:

   - `parallel.sameRepoCardLimits`
   - default limits
   - ship serial invariant
   - per-card logs/worktrees/ports
   - dry-run output expectations

11. Add tests.

   File: `tests/linear-watch.test.mjs`

   Cover:

   - config defaults/clamps
   - card slot selection
   - dry-run slot reporting
   - claim-confirmation skip/fill
   - owner-token latest-heartbeat confirmation
   - workspace batching preserved
   - `maxNonShipDispatches` counts selected candidates, not child card slots
   - ship limit forced to 1
   - per-card paths and port allocation
   - dev branch/worktree path equals exact issue key
   - card-specific dispatch failure scopes

## Tests

Run:

```bash
node --test
```

Manual validation:

```bash
set -a && . ./.env && set +a
node scripts/linear-watch.mjs tick --dry-run
tail -n 120 ~/.local/state/linear-board-sweeps/*/*/$(date +%Y%m%d).log
```

Dry-run should show selected card identifiers and slot indexes without writing claim labels.

## NOT in Scope

- Ship concurrency.
- A new external lock service.
- Arbitrary same-repo QA parallelism by default.
- Removing COD-82 repo-overlap filtering.

## What Already Exists

- Workspace-level batch selection.
- `resolveRepos()` and `worktreePath()`.
- Claim labels, heartbeat comments, stale reaping.
- `dispatchBatch()`.
- Per-sweep log directory structure.

## Failure Modes

- Two children work the same card. Mitigation: parent claims exact card slots and confirms the latest heartbeat owner token before dispatch.
- Two dev children share a worktree or branch. Mitigation: deterministic exact issue-key worktrees and branches.
- Ports collide. Mitigation: deterministic per-slot port allocation and logged env.
- Spec children conflict on README/canonical docs. Mitigation: parallel drafting plus serialized parent landing or conflict comment/block.
- QA overwhelms local browser/server resources. Mitigation: QA default limit 1.
- Ship concurrency accidentally increases. Mitigation: force ship limit 1 and keep ship-runner gate.

## Verification Checklist

- [ ] Config defaults match COD-100.
- [ ] Parent claims exact card slots.
- [ ] Heartbeat owner-token confirmation rejects competing claims.
- [ ] Single-card sweep mode ignores other cards.
- [ ] Per-card worktrees/logs/temp dirs/ports are unique.
- [ ] Dev branches/worktrees use exact issue keys.
- [ ] Spec same-repo landing is serialized.
- [ ] COD-82 workspace batching still works.
- [ ] Ship remains serial.
- [ ] Run records and dispatch failure Todos are card-specific.
- [ ] `node --test` passes.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | Use parent-planned card slots, owner-token claims, exact issue-key branches, serialized spec landing, card-specific run records |
| Performance Review | spec-sweep lens | Queue throughput | 1 | CLEAR | Same-repo limits improve throughput while QA and ship stay conservative |

- **VERDICT:** ENG + PERFORMANCE CLEARED - ready to implement.

NO UNRESOLVED DECISIONS

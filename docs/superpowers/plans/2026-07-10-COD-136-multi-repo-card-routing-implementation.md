# COD-136 Multi-Repository Card Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every scheduled card to one explicit primary repository before claim/spawn, configure all SafeTaper repositories and deploy gates, then safely reactivate the stalled relation graph.

**Architecture:** Add a pure label-to-route resolver in `scripts/linear-watch.mjs` that pairs source and managed paths by `config.repos` index. Carry route metadata through queue candidates and the unified admission path, revalidate fresh labels before mutation, and use the managed primary path for worktrees and same-repo capacity. Preserve legacy first-repo behavior when routing is absent. Surface fail-closed errors through existing self-clearing failure Todos.

**Tech Stack:** Node.js 18+ ESM, built-in `node:test`, Linear GraphQL, git worktrees, launchd, JSON configuration.

## Constraints

- [x] No claim or child spawn occurs for a missing, ambiguous, invalid, or changed route.
- [x] `blockedBy` remains relation-only; do not add `blocked:needs-user` for a dependency issue.
- [x] Ship remains serial and human-gated; host capacity remains ten.
- [x] Existing workspaces without `repoRouting` retain first-repo behavior.
- [x] All five SafeTaper repos have explicit deploy/canary/attended-gate entries before multi-repo Ship is enabled.
- [x] Use test-first red/green cycles and preserve unrelated user changes.

## Task 1: Add pure route resolution

**Files:** `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`

- [x] Write failing tests for legacy fallback, five mapped labels, missing labels,
  multiple labels, invalid targets, duplicate repo entries, and source/managed
  stable-slug pairing.
- [x] Implement `resolveCardRepoRoute` and a sanitized `repoRoutingFailureEvent`.
- [x] Run the focused tests and confirm green.

## Task 2: Route worktrees and child environment

**Files:** `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`, canonical and propagated sweep skills

- [x] Write failing tests proving routed `AUTO_SWEEP_WORKTREE`,
  `AUTO_SWEEP_REPO`, and `AUTO_SWEEP_SOURCE_REPO` values.
- [x] Pass route metadata through `cardRunPaths` and `withCardDispatchEnv`.
- [x] Teach all scheduled skills to treat the exported repo as primary while
  retaining explicitly configured sibling access.

## Task 3: Fail closed across every admission path

**Files:** `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`

- [x] Write failing tests for initial scan, non-Ship fresh-claim race, Ship fresh
  spawn race, refill repo filtering, and handoff route preservation.
- [x] Partition scan/refill cards before candidate admission and record
  `<sweep>:routing` failures.
- [x] Revalidate fresh labels and route equality before claim/spawn, releasing
  only an owned claim if a post-claim check ever fails.
- [x] Key same-repo active/refill accounting by managed primary repo.

## Task 4: Configure and document SafeTaper

**Files:** SafeTaper Coach `.claude/linear-sweep.json`, kit template/docs, repo `AGENTS.md`

- [x] Add all five repos and the `app:*` routing map.
- [x] Replace the scalar deploy note with a per-repo deploy/canary/gate map based
  on verified local runbooks.
- [x] Add delegation-by-default guidance for future sessions while preserving
  review ownership and shared-worktree safety.
- [x] Document migration, exact-one-label behavior, failure recovery, and the
  unchanged dependency semantics.

## Task 5: Verify and review

- [x] Run focused tests after each red/green slice, then the full Node suite.
- [x] Run repository health/review checks and independently inspect the final diff.
- [ ] Verify all registered source and managed repositories are clean enough for
  dispatch and that routing dry-run selects Guide/Admin/Portal/Slack correctly.
- [x] Address every actionable review finding and rerun verification.

## Task 6: Ship and install

- [ ] Commit and push COD-136, open/review the PR, land it, and update the kit
  installation/launcher.
- [ ] Commit and push the SafeTaper config/runbook update on its appropriate
  branch, land it, and confirm the managed anchor refreshed.
- [ ] Run `doctor`, `--dry-run`, and an attended live tick; verify launchd remains
  healthy with `capacity.maxActiveChildren=10`.

## Task 7: Recover the board

- [ ] Preserve and push SAF-207's existing Guide commit, prove Guide routing,
  comment the recovery, and remove only `sweep:manual-only`.
- [ ] After Admin/Coach routing and runbook proof, complete SAF-248 and reread
  SAF-200 dependency status; leave SAF-200 in QA for normal scheduling.
- [ ] Leave SAF-245 open until Firebase production auth succeeds; verify SAF-204
  and SAF-234 remain relation-only blocked with no manual-block label.
- [ ] Observe scheduler claims and report only genuine remaining human blockers.

# Changelog

All notable changes to the linear board sweeps kit are documented here.

## [1.2.0.2] - 2026-07-10

### Fixed

- Allow independently actionable Spec, Dev, and QA stages from one registered workspace to use the configured non-Ship batch together, while preserving exclusive Ship dispatch and repository-overlap protection between different registered workspaces.

## [1.2.0.1] - 2026-07-10

### Fixed

- Read scheduled sweep configuration from the managed workspace anchor even after a routed child changes into its primary sibling repo, so Guide, Admin, Portal, and Slack preflights no longer fail because those repos correctly omit a duplicate `.claude/linear-sweep.json`.

## [1.2.0.0] - 2026-07-10

### Added

- Route scheduled cards to an explicit primary repository from an exact-one Linear label mapping, while keeping configured sibling repositories available for intentional multi-repo work.
- Recheck repository ownership before claims, Ship dispatch, handoffs, and each child’s first material work; routing races now fail closed with typed outcomes and self-clearing operator Todos.

### Changed

- Apply same-repository limits independently per routed primary repo, reserve follow-up slots atomically, and keep dry-run selection aligned with live admission so unrelated apps can progress concurrently under the existing ten-child host ceiling.
- Document multi-repo migration, deploy/canary gates, relation-only `blockedBy` semantics, and delegation-by-default guidance for scheduled and interactive work.

### Fixed

- Stop sibling-app cards from being dispatched into the first configured repository, which previously left valid Guide, Admin, Portal, and Slack work stalled behind the Coach checkout.

## [1.1.3] - 2026-07-09

### Fixed

- Reuse an existing clean worktree that already owns `main` when propagating sweep skills, instead of failing while trying to create a competing `main` checkout. Dirty owner worktrees remain untouched and fail closed.

## [1.1.2] - 2026-07-09

### Fixed

- Treat an absent disposable card worktree as clean after a successful child, so same-repository refill does not create a false checkout failure after the child removes its worktree. Existing dirty worktrees and missing managed repositories still fail closed.

## [1.1.1] - 2026-07-09

### Fixed

- Add the standard per-user Bun installation directory to the launchd wrapper PATH so scheduled QA and Ship children can start gstack browser canaries from a minimal launchd environment.

## [1.1.0] - 2026-07-09

### Added

- Run scheduled work across registered repositories with a host-wide capacity ceiling of ten children, deterministic stage priority, same-repository slot limits, and persistent queue telemetry.
- Gate every scan, claim, refill, handoff, and child process on Linear `blockedBy` relations; only exact canonical `Done` releases a dependent card.
- Materialize clean managed workspaces for scheduled runs and surface runtime, checkout, capacity, dependency-cycle, and updater failures through doctor output and self-clearing Linear Todos.

### Changed

- Treat separately completable blockers as relation-only dependencies, without mirroring them to `blocked:needs-user`; retain that label for genuine human decisions and existing crash safeguards.
- Resolve and validate Codex/Claude executables before claims, preserve Ship exclusivity, and classify child exits, interruptions, dependency deferrals, and launch failures distinctly.
- Propagate scheduled and manual sweep skills through the managed kit while preserving the adaptive spec-review and downstream-first unblock behavior already on main.

### Fixed

- Release only owned claims after late dependency failures and report unverifiable cleanup instead of silently stranding work.
- Fail closed without wedging the tick when the capacity ledger or dependency data is malformed or incomplete.
- Retry unpushed skill-refresh commits and report add, commit, hook, fetch, merge, and push failures truthfully per registered anchor.

# Changelog

All notable changes to the linear board sweeps kit are documented here.

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

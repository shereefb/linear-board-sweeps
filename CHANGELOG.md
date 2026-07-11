# Changelog

All notable changes to the linear board sweeps kit are documented here.

## [1.3.0.0] - 2026-07-11

### Added

- Give every scheduled claim an immutable declaration ID before its in-progress label is applied, so concurrent launchers deterministically agree on one owner without treating heartbeats as authority.
- Add complete, paginated claim-history reads plus attended migration diagnostics and exact reset tooling for legacy labels and orphan declarations.

### Changed

- Require the paired owner token and declaration ID across child environments, resume records, stage handoffs, Ship refills, terminal commands, and all canonical sweep contracts.
- Treat declaration-scoped heartbeats as liveness only and preserve exact claims for bounded provider or capacity recovery.

### Fixed

- Close or reset the exact claim epoch and revalidate its authoritative boundary before removing labels, moving cards, or escalating blockers.
- Keep terminal retry cooldowns bound to the failed declaration, fail closed on incomplete or ambiguous history, and prevent older cooldowns from blocking a newer epoch.
- Deduplicate long-lived resume-resolution notices and protect preserved work without allowing stale or mismatched recovery records to dispatch.

## [1.2.0.8] - 2026-07-11

### Changed

- Carry versioned performance budgets from Spec into kind-specific, commit-bound Dev proof and honest QA consumption without weakening existing review or Ship gates.
- Distinguish measured benchmarks from deterministic work bounds for pagination, retry, prefetch, latency, and resource constraints.

### Fixed

- Invalidate stale proof after affected-path QA changes and share one fail-closed legacy boundary with other versioned contracts in either landing order.
- Bump the marker so installed anchors receive all three sweep skill updates.
### Added

- Persist host-wide Codex and Claude usage cooldowns for one hour, route new work to a healthy configured runtime, and admit only one probe when a cooldown expires.
- Expose cooling runtimes and next probe times in local logs and `doctor` output.

### Changed

- Treat daily provider usage exhaustion as quiet deferred scheduler state: preserve exact claims and worktrees without creating Linear Todos, comments, labels, or state churn when every configured runtime is cooling.
- Replace per-card fallback-lane advancement with one shared provider-cooldown authority that survives launcher restarts.

### Fixed

- Count only candidate Codex error envelopes against bounded usage-evidence limits, so routine JSONL traffic cannot hide a later supported usage-limit event.
- Recognize bounded Claude CLI usage-limit stderr separately from authentication, overload, transient rate limits, and ordinary agent failures.

## [1.2.0.7] - 2026-07-10

### Changed

- Require material Spec cards to carry an auditable `scope-closure/v1` inventory whose stable surface IDs map into implementation tasks, proofs, rollout evidence, and owners before handoff.
- Compose scope closure with correctness and adaptive review depth without adding a review pass or weakening safety gates.

### Fixed

- Preserve material self-check omissions as `review/scope-gap` evidence, and prove the VERSION-triggered updater installs the changed canonical skill bytes.

## [1.2.0.6] - 2026-07-10

### Added

- Automatically route QA-passed bug fixes and explicitly eligible small features directly to Ship when the reviewed commit is still the current remote commit, while preserving the normal Signoff gate for every other card.

### Changed

- Let operators disable automatic QA-to-Ship routing globally or require Ship approval for every card; Factory Learning cards always retain the human Ship gate.
- Bind Dev eligibility, QA evidence, and Ship admission to full Git commit SHAs, with a final remote recheck immediately before merge.

### Fixed

- Fail closed on malformed policy, stale commits, blockers, foreign claims, ownership changes, and unsupported QA destinations; successful terminal moves remove only the proven QA claim.

## [1.2.0.5] - 2026-07-10

### Added

- Let an opted-in runner learn from factory operations on independent reliability, quality, and throughput cadences, using 15 deterministic detectors and bounded evidence instead of spending model tokens on idle passes.
- Automatically create or update high- and medium-confidence improvement cards at the bottom of Spec, accumulate low-confidence evidence, cap each run at six new cards, and preserve Signoff plus the human-only move into Ship.
- Track improvement outcomes through fixed post-Done evaluation windows, safe recurrence generations, durable write-ahead recovery, exact occurrence provenance, and a manual unblock path after the generation cap.
- Expose learning health, coverage, pending writes, dry-run mutation plans, and an attended run command; optional synthesis runs without credentials, tools, network connectors, or write authority and can only annotate deterministic findings.

### Changed

- Emit bounded structured review, QA, bounce, question, canary, and terminal evidence from every canonical sweep skill, including stable policy keys for recurring human questions.
- Route card-specific findings to their proven workspace and shared launcher remedies to one configured core repository, failing closed on missing credentials, incomplete evidence, or ambiguous repository ownership.

### Fixed

- Preserve due-lens isolation, exact workspace/repository outcome ownership, and deferred evidence from non-due lenses so one cadence cannot consume or erase another cadence's observations.
- Reconcile create races, duplicate audits, generation caps, comments, labels, relations, and occurrence evidence with read-after-write confirmation before committing local state.
- Make stale-claim, orphan cleanup, safety-invariant, and failed-recovery detectors reachable from confirmed launcher mutations, including route-less failure Todos in routed multi-repository workspaces.

## [1.2.0.4] - 2026-07-10

### Fixed

- Refill a registered workspace's Ship slot as soon as its current Ship child completes, including when the next human-approved card routes to a different primary repo, without waiting for unrelated children in the original batch.
- Release a successful child's launcher-owned in-progress claim when the card remains in the same workflow state, so partial work can resume immediately instead of appearing active until the stale-heartbeat timeout.

## [1.2.0.3] - 2026-07-10

### Changed

- Allow Ship to run alongside every other stage while limiting Ship to one active child per registered source workspace; Ship no longer consumes the non-Ship candidate budget or globally blocks capacity admission.
- Tune this registered host profile to ten non-Ship workspace/stage candidates, two QA cards per primary repo, and twenty same-repo refill dispatches while preserving the hard ten-child host ceiling.

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

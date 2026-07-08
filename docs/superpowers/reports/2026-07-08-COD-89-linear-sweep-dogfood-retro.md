# COD-89 Linear sweep dogfood retrospective

**Date:** 2026-07-08
**Scope:** COD-82, COD-83, COD-84, COD-85, COD-86, COD-87, COD-88, and COD-90
**Evidence types:** Linear issue snapshots/comments, git history, local launcher logs, and existing specs/plans.

## Executive summary

The first dogfood run worked: specs, dev branches, QA passes, PR links, verification commands, and residual risks were captured on the cards. The board acted as a real audit trail, not just a status tracker.

The biggest weakness is measurement. We can infer approximate card elapsed time from Linear comments and launcher logs, but we cannot reliably answer token usage, per-card runtime, interruption count, or exact pass outcome without reading long transcripts. COD-94 now tracks the instrumentation gap.

The 10-minute cadence is not the first bottleneck to tune. Observed idle time came more from single foreground dispatch and bounded pass sizes than from the timer itself. COD-82 already addresses bounded non-ship parallel dispatch for disjoint workspaces; keep the cadence until run records show a timer-specific delay.

## Scorecard

| Card | Current evidence | Outcome | What worked | What hurt |
|---|---|---|---|---|
| COD-82 bounded parallel dispatch | Observed: Linear comments, branch `origin/COD-82`, PR #1, tests, live dry-run timing. | QA Passed | Spec/dev/QA trail is strong; independent review found real path-overlap and runtime test gaps before QA. | Real concurrent execution was not live-tested because only one active workspace existed. |
| COD-83 simple fast path | Observed: Linear comments, branch `origin/COD-83`, PR #2, tests, live setup-team. | QA Passed | Conservative default-off policy preserved the human gate and avoided unsafe auto-shipping. | Residual policy relies on future agents following sweep text; no central classifier yet. |
| COD-84 unblock sweep | Observed: Linear comments, branch `origin/COD-84`, PR #3, QA screenshot, live temporary COD-93 smoke. | QA Passed | Security review found shell-safety risk; QA used a temporary Linear card to prove mutation safely. | A dev pass accidentally claimed/commented on COD-84 while implementing COD-82, then corrected it on-card. |
| COD-85 board-order selection | Observed: Linear comments, branch `origin/COD-85`, PR #4, live dry-run with `sortOrder`. | QA Passed | The workflow corrected "oldest-first" to visible board order and verified live sortOrder payloads. | QA avoided manual board reordering, so drag/drop ordering remains inferred from Linear `sortOrder`. |
| COD-86 gated reviews + review/ship split | Observed: Linear comments, commits `11f310a` and merge `a46f9bc`. | Done | Created the review/ship split and new statuses that made later QA/ship behavior safer. | Left an operational note for `ship-runner on`; no structured TODO card was visible in this retrospective. |
| COD-87 create cards from todo | Observed: Linear issue exists in project `Mature Masculine`, not `Linear Sweep`; no comments. | Out of scope for this board | Its presence exposed that cross-project COD keys can confuse retrospectives. | No dogfood evidence in this project; should not be counted as a Linear Sweep result. |
| COD-88 Karpathy routing | Observed: Linear comments, branch `origin/COD-88`, PR #5, tests. | In Review | Independent reviewer found a real wording gap and the dev pass fixed it before landing. | Existing installed repos still need an AGENTS migration path beyond propagated skill updates. |
| COD-90 model update policy | Observed: Linear issue in Backlog, no comments. Local logs show a failed unsupported model dispatch. | Backlog | The model failure gives concrete motivation for COD-90. | No spec/dev evidence yet; model selection is currently manually configured. |

## What worked

- **Card comments were useful evidence.** Dev and QA comments usually named spec/plan paths, branch/commit, PR, test commands, review findings, and residual risk.
- **Independent review paid for itself.** COD-82, COD-84, COD-85, and COD-88 all recorded real findings that were fixed before the card advanced.
- **QA stayed non-production.** COD-82 through COD-85 reached QA Passed without merging or deploying, preserving the human Ready to Ship gate.
- **Live smoke tests were pragmatic.** Dry-run launcher checks, `setup-team`, `unblock-list`, `unblock-resolve`, and Linear `sortOrder` payload checks proved more than unit tests alone.
- **The board caught operational mistakes.** COD-84's accidental claim/comment was corrected transparently, leaving enough context for later analysis.

## What hurt

- **Structured telemetry is missing.** Local logs record dispatch start/end and exit status, but not run IDs, issue IDs, token counts, exact duration, terminal card states, or artifact paths in a machine-readable shape.
- **The logs are too transcript-heavy.** They contain useful facts, but extracting them required filtering long agent transcripts rather than reading compact run records.
- **Model availability failed at runtime.** A spec dispatch tried `gpt-5.5-codex` and failed with an unsupported-model API error before a later `gpt-5.5` run succeeded.
- **Some docs are stale.** `SETUP.md` still says qa-sweep merges/deploys in Step 11 even though the current workflow says QA never merges/deploys. COD-95 tracks this.
- **Cross-project issue keys confused scope.** COD-87 is in another project; a report that blindly follows numeric keys would overstate what the Linear Sweep board did.

## Time and token efficiency

### Observed

- Idle launcher ticks are cheap by design: `README.md` says idle ticks spend zero LLM tokens and only dispatch when actionable work exists; `scripts/linear-watch.mjs` logs actionable counts before dispatch.
- Local logs show a failed unsupported-model spec dispatch at 17:24:05Z and `dispatch end (exit 1)` at 17:24:07Z.
- Local logs show successful QA dispatch windows, for example 18:22:01Z to 18:27:35Z and 19:02:42Z to 19:09:21Z.
- QA comments for COD-82 and COD-83 report one dry-run timing: `tick --dry-run` took 1.434s for COD-82's QA evidence.
- Linear comment timestamps give approximate card movement, not exact runtime:
  - COD-82: spec ready 17:40, dev done 18:03, QA passed 18:25.
  - COD-83: spec ready 17:40, dev done 18:11, QA passed 18:27.
  - COD-84: spec ready 17:40, dev done 18:52, QA passed 19:09.
  - COD-85: spec ready 19:28, dev done 19:50, QA passed 20:05.
  - COD-88: spec ready 19:28, dev done 20:23, In Review.

### Inferred

- The 10-minute cadence did create some waiting between queue availability and the next scheduled tick, but the larger avoidable delay is that one foreground dispatch can hold the launcher while other queues remain actionable.
- The three-card spec limit worked well for the first batch: COD-82, COD-83, and COD-84 got specs/plans together and then fed dev/QA. Later, COD-85, COD-88, and COD-89 repeated that pattern.
- The two-card dev/QA limits are reasonable for quality. QA processed two cards in one pass for COD-82/COD-83, then separate later cards when only one was actionable.

### Unavailable

- Exact token counts per pass.
- Exact per-card runtime inside a multi-card pass.
- Exact number of user interruptions versus autonomous comments.
- Exact queue wait time per card after becoming actionable.

## Cadence and idle-machine analysis

The cadence question should not be answered by shortening the timer yet.

Observed facts:

- The launcher can spend zero LLM tokens when idle.
- Logs show actionable counts being checked frequently and cheaply.
- The current architecture historically selected one dispatch per tick/run; COD-82 adds bounded non-ship batching but defaults to `parallel.maxNonShipDispatches: 1`.
- QA/dev/spec comments show useful work completing in minutes once dispatched.

Inference:

- If one workspace has spec, dev, and QA work at the same time, shorter polling only helps between completed dispatches. It does not solve same-workspace serialization, branch/worktree contention, or dev-server conflicts.
- COD-82 is the right first optimization: bounded parallelism across disjoint repo sets. Increase `parallel.maxNonShipDispatches` only after run records show the host can handle it.
- Keep the 10-minute cadence until COD-94 can measure queue wait time separately from runtime.

## User interruption and comment noise

Observed:

- This dogfood set did not require direct interactive questions in the sampled comments. Questions were routed to card comments or encoded as residual risks/follow-up cards.
- Heartbeat comments are useful for recovery but noisy for human reading, especially when mixed with substantive comments.
- Summary comments are high-signal when they include spec/plan, branch, review outcome, verification, and residual risk.

Recommendation:

- Keep heartbeat markers, but future UI/reporting should collapse them or summarize them. The card's visible audit trail should emphasize claims, terminal summaries, blockers, and QA evidence.

## Follow-up work

Existing cards that already cover findings:

- COD-82: bounded non-ship parallel dispatch for disjoint workspaces.
- COD-85: visible board-order selection and bottom-of-destination moves.
- COD-88: Karpathy coding guardrail in adapter and propagated sweep skills.
- COD-90: model update policy. The unsupported `gpt-5.5-codex` dispatch failure is direct evidence.
- COD-91: scheduled tick failures should create/update Todo cards.

New cards created from this retrospective:

- COD-94: structured sweep run metrics for retrospectives.
- COD-95: stale setup text that says qa-sweep deploys.

No new card was created for "reduce comments" because that is not concrete enough yet. If heartbeat noise becomes painful, define a specific reporting feature such as "collapse heartbeat comments in generated status summaries."

## Proposed structured run record

Future launcher/sweep runs should write a JSONL record per dispatch:

```json
{
  "runId": "2026-07-08T18:22:01.623Z-linear-board-sweeps-qa",
  "anchorPath": "/Users/jarvis/Documents/code/linear-board-sweeps",
  "projectId": "81455eb7-1ead-474d-a0c1-54efe75f821e",
  "sweep": "qa",
  "runtime": "codex",
  "model": "gpt-5.5",
  "reasoningEffort": "high",
  "startedAt": "2026-07-08T18:22:01.623Z",
  "endedAt": "2026-07-08T18:27:35.032Z",
  "durationMs": 333409,
  "exitCode": 0,
  "dispatchStarted": true,
  "claimedIssues": ["COD-82", "COD-83"],
  "terminalIssueStates": { "COD-82": "QA Passed", "COD-83": "QA Passed" },
  "artifactPaths": [],
  "branches": ["COD-82", "COD-83"],
  "pullRequests": [
    "https://github.com/shereefb/linear-board-sweeps/pull/1",
    "https://github.com/shereefb/linear-board-sweeps/pull/2"
  ],
  "tokenUsage": "unavailable",
  "userInterruptionCount": "unavailable"
}
```

Minimum implementation notes:

- The launcher can write dispatch-level fields before/after the child process.
- Sweeps should append claimed issues, artifact paths, branch names, PR URLs, and terminal states before the card move.
- Token usage should stay `unavailable` unless the runtime exposes it reliably.
- A failed pre-runtime dispatch, like an unsupported model, should still write a record with `dispatchStarted: false` or a nonzero `exitCode`.

## Bottom line

The workflow is viable. The human was not bugged by interactive questions, the board comments preserved enough context to resume and audit work, and review/QA gates caught real issues. The next quality jump is not a shorter timer; it is structured run records plus fixing the known stale docs/model-update paths.

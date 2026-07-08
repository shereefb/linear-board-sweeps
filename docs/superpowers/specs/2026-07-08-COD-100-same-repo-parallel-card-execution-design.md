# COD-100: Same-Repo Parallel Card Execution Design

Linear: COD-100
Status: planned
Date: 2026-07-08

## Problem

COD-82 added bounded parallel dispatch across disjoint workspaces and explicitly kept same-workspace/same-repo work serialized. That was the right first step: the launcher can now run a small batch of non-ship sweeps, but `selectDispatchBatch()` rejects candidates from the same anchor or overlapping resolved repo paths.

COD-100 asks for the next step: controlled parallel card execution inside one workspace and one repo:

- spec cards: default 4 in parallel
- dev cards: default 4 in parallel
- QA cards: default 1 in parallel
- ship: always serial and single-runner

## Goals

- Preserve COD-82's disjoint-workspace batching.
- Add same-repo per-sweep card concurrency limits.
- Keep ship serial, single-runner, and outside any same-repo card pool.
- Claim concrete cards before dispatch so child agents do not race for the same top card.
- Isolate parallel dev/QA worktrees, ports, logs, temp dirs, and runtime env.
- Make spec-sweep parallel docs-only work safe against git/doc conflicts.
- Update sweep skills, launcher docs, tests, and structured run metrics.

## Non-goals

- No production merge/deploy concurrency.
- No distributed lock service beyond Linear labels/comments plus origin.
- No arbitrary unbounded agent pools.
- No same-worktree parallel editing.
- No removal of COD-82's workspace-level repo-overlap safety.

## Existing Mechanism

The launcher currently builds sweep-level candidates and dispatches one child process per selected sweep:

```text
tick
  +-- fetch cards by SWEEP_CFG state list
  +-- filter actionable cards
  +-- candidates: { anchorPath, config, sweep, count, topCard }
  +-- selectDispatchBatch()
  +-- dispatchBatch()
```

`selectDispatchBatch()` preserves safety by:

- returning only one ship candidate if ship is dispatchable
- deduping by `anchorPath`
- excluding overlapping resolved repo paths
- enforcing `parallel.maxNonShipDispatches`

That means same-repo work cannot run in parallel today. Also, the dispatched prompt is sweep-level: "perform ONE pass." A spec pass can process up to three cards. Same-repo parallelism needs a narrower per-card dispatch mode.

## Proposed Model

Add a second level of planning: card slots inside a selected sweep.

```text
workspace-level selection
  +-- COD-82 keeps disjoint workspace/repo batching
  +-- selected sweep candidate enters card-slot planner

card-slot planner
  +-- sort actionable cards by Linear board order
  +-- choose up to configured sameRepo limit
  +-- claim each concrete card before dispatch
  +-- dispatch one child agent per claimed card
```

Each child agent receives a single-card prompt:

```text
Unattended scheduled run. Follow the dev-sweep skill exactly for COD-123 only.
Do not process other cards. Route questions to the card comments per the skill.
```

The sweep skills must learn a single-card mode. When a card key is supplied by prompt/env, the sweep must ignore all other queue cards.

## Config

Extend `linear-sweep.json`:

```json
"parallel": {
  "maxNonShipDispatches": 2,
  "sameRepoCardLimits": {
    "spec": 4,
    "dev": 4,
    "qa": 1,
    "ship": 1
  }
}
```

Defaults when omitted:

```json
{ "spec": 4, "dev": 4, "qa": 1, "ship": 1 }
```

`ship` is present only for explicitness. The launcher must still force ship to 1.

`parallel.maxNonShipDispatches` continues to count selected workspace/sweep candidates from COD-82. `sameRepoCardLimits` counts child card slots inside each selected candidate. For example, `maxNonShipDispatches: 2` and `sameRepoCardLimits.spec: 4` can run at most two selected non-ship sweep candidates, and each selected spec candidate can expand to four claimed card children. Logs and structured records must report both limits so operators can tell whether a tick was bounded by workspace candidates or same-repo card slots.

## Claiming and Heartbeats

Before dispatching same-repo card children, the launcher should claim each selected card itself:

1. Add the sweep's `*:in-progress` label.
2. Generate an owner token: `<host>:<parentRunId>:<issueIdentifier>:<slotIndex>`.
3. Post `[auto-sweep-heartbeat <ISO> owner=<ownerToken>] Claimed for same-repo parallel <sweep> slot`.
4. Re-fetch the card and verify it is still in the expected state, still unblocked, and the newest heartbeat for that sweep claim has the same owner token.
5. Only then start the child process.

If claim confirmation fails, skip that card and keep filling slots from later actionable cards until the limit or queue is exhausted.

This is still not a perfect distributed lock across hosts, but it shrinks the race and matches the existing Linear-only coordination model. Timestamp-only heartbeat checks are not enough for COD-100 because two hosts can claim within the same freshness window; the owner token is the tie-breaker.

## Isolation

### Spec

Spec children are docs-only, but they still write to the same repo. Each spec child should run in a deterministic per-card worktree:

```text
.worktrees/COD-123-spec
```

Each child writes only that card's spec/plan docs and any canonical-doc update required by config. A child that hits a doc conflict should comment on the card and leave it in `Needs Spec` with `blocked:needs-user` or `blocked:open-questions` depending on the conflict.

In same-repo parallel mode, spec children must not independently merge or move their cards to `Ready for Dev`. They draft docs and report their branch/worktree result to the parent. The parent owns a serialized landing queue: fetch `origin/main`, merge one completed spec branch, push, re-read that card in Linear, then remove the claim label and move only that card when it is still in `Needs Spec`. If the launcher chooses an implementation where children perform landing themselves, it must first add an explicit repo-local landing lock around fetch/merge/push/card-move so concurrent children cannot merge `main` at the same time.

### Dev

Dev children must use card-specific branches and worktrees:

```text
branch: COD-123
worktree: <repo>/.worktrees/COD-123
```

The exact issue-key branch/worktree contract preserves the existing dev, QA, and ship sweep handoff, which currently discovers feature branches by issue identifier. If a later implementation wants slugged branches, it must update all downstream sweep skills in the same change.

They must never share a worktree, branch, temp dir, or dev server port. The launcher should pass a full isolation env contract to each child:

```text
AUTO_SWEEP_ISSUE=COD-123
AUTO_SWEEP_SLOT_INDEX=0
AUTO_SWEEP_WORKTREE=<repo>/.worktrees/COD-123
AUTO_SWEEP_LOG_DIR=~/.local/state/linear-board-sweeps/<anchor>/<sweep>/COD-123
AUTO_SWEEP_TMPDIR=~/.cache/linear-board-sweeps/<parentRunId>/COD-123/tmp
AUTO_SWEEP_PORT_BASE=47000
AUTO_SWEEP_APP_PORT=47000
AUTO_SWEEP_SCREENSHOT_DIR=~/.local/state/linear-board-sweeps/<anchor>/<sweep>/COD-123/screenshots
AUTO_SWEEP_BROWSER_PROFILE_DIR=~/.cache/linear-board-sweeps/<parentRunId>/COD-123/browser
```

Dev-sweep and QA-sweep must consume these values when present instead of inventing their own paths. Logs belong under:

```text
~/.local/state/linear-board-sweeps/<anchor>/<sweep>/<card>/
```

### QA

Default QA same-repo limit is 1. The config shape allows increasing it later, but the default reflects today's risk: QA often needs a dev server, browser session, screenshots, and ports. If an operator raises QA above 1, the launcher must allocate isolated ports/log dirs per card and the skill must write screenshots under per-card paths.

### Ship

Ship remains serial and single-runner. Same-repo limits must not increase ship concurrency.

## Engineering Review

### D1 - Unit of Parallelism

ELI10: The choice is whether to keep dispatching whole sweeps or dispatch one child per card. Whole-sweep dispatch is simpler, but multiple sweep children would all look at the same top card unless the parent pre-claims concrete work. Per-card dispatch gives each child a named target.

Recommendation: A because same-repo concurrency needs concrete card ownership before child processes start.

A) Parent-planned per-card slots (recommended). Completeness: 10/10. The launcher picks and claims exact cards, then starts isolated child runs. This is more plumbing, but it prevents duplicate top-card work.

B) Start N ordinary sweep passes and let labels sort it out. Completeness: 4/10. This is tempting but race-prone: each child can read the same queue before labels settle.

C) Keep sweep-level dispatch and raise each sweep's internal card limit. Completeness: 5/10. It increases throughput inside one process but does not provide parallel execution.

Net: Add single-card dispatch mode and make the parent own card-slot selection.

### D2 - Same-repo merge strategy for spec

ELI10: Spec cards can all write docs in the same repo. If they all merge to `main` at once, they can trip over README or index changes. The choice is whether to let children race or serialize the final merge.

Recommendation: A because it preserves parallel drafting while keeping git landing boring.

A) Parallel drafting, serialized merge/push (recommended). Completeness: 9/10. It gets most of the speedup and keeps origin consistent. It may make one child wait at the end.

B) Every child independently merges/pushes with retries. Completeness: 7/10. Existing push discipline helps, but conflicts become noisier and harder to audit.

C) One shared docs branch for all spec cards. Completeness: 5/10. It reduces merge commits but recreates shared-worktree coordination inside the branch.

Net: isolate worktrees and serialize final landing.

### D3 - Batch Limit Semantics

ELI10: There are now two knobs. One says how many independent workspace/sweep candidates a tick can run. The other says how many cards each selected candidate can fan out into. If they are blurred together, the default `maxNonShipDispatches: 2` would silently cap spec/dev to two cards and contradict COD-100's default of four.

Recommendation: A because it preserves COD-82 while making COD-100's requested per-card defaults real.

A) Workspace limit counts selected candidates; same-repo limit counts card children (recommended). Completeness: 10/10. This keeps disjoint workspace safety and still allows four spec/dev cards inside one selected same-repo sweep.

B) `maxNonShipDispatches` counts every child card. Completeness: 6/10. Safer by accident, but it makes the configured spec/dev defaults misleading unless operators also raise the global limit.

C) Replace `maxNonShipDispatches` with per-sweep limits. Completeness: 7/10. Cleaner long term, but it is a larger migration and risks regressing COD-82.

Net: keep both limits and log both.

### Scope Challenge

What already exists:

- `selectDispatchBatch()` handles workspace-level batch selection.
- `resolveRepos()` finds repo paths for disjointness checks.
- `worktreePath()` provides deterministic worktree paths.
- Claim labels and heartbeat/reaper semantics already exist per sweep.
- `dispatchBatch()` can run several child processes.

Minimum new work:

- Add per-card candidate/slot planning after workspace selection.
- Add single-card prompt/env support to dispatch.
- Add heartbeat owner tokens and claim confirmation against the newest matching owner.
- Update sweep skills to honor a supplied card key.
- Add per-card worktree/env/log isolation.
- Serialize same-repo git landing for spec and preserve exact issue-key dev branch isolation.
- Add per-card dispatch failure scopes and fingerprints so Todo cards do not collapse multiple child failures into one sweep-level failure.
- Add a minimal launcher-owned JSONL run-record writer if COD-94's structured run-record helpers have not landed before implementation begins.

## DevEx Review

Operator persona: a maintainer who wants same-repo throughput without hidden production or branch races.

DX requirements:

- Config must be obvious: `sameRepoCardLimits.spec/dev/qa/ship`.
- Logs must show one line per selected card slot.
- Dry-run must show the card identifiers that would be claimed and dispatched.
- Failures must include the card key, sweep, worktree path, and log path.

## Test Plan

Required tests:

```text
sameRepoCardLimits()
  +-- default spec=4, dev=4, qa=1, ship=1
  +-- invalid values clamp to safe defaults
  +-- ship always resolves to 1

card-slot planner
  +-- selects top N actionable cards by board order
  +-- excludes blocked cards
  +-- excludes cards with live claims
  +-- skips failed claim-confirmation cards and fills later slots
  +-- dry-run reports exact card ids without claiming

dispatch selection
  +-- preserves COD-82 disjoint-workspace batching
  +-- allows multiple same-repo card children inside one selected sweep
  +-- maxNonShipDispatches counts selected candidates, not expanded child slots
  +-- QA default selects one same-repo card
  +-- ship still selects exactly one card on ship-runner only

isolation
  +-- spec/dev worktree paths use exact card key
  +-- dev branch names use exact issue key for downstream QA/ship compatibility
  +-- per-card log dirs include card key
  +-- dev/QA port allocation does not collide inside a batch
  +-- child env includes worktree/log/temp/port/screenshot/browser-profile paths

claims
  +-- heartbeat owner token is emitted
  +-- claim confirmation rejects fresher or latest non-matching owner tokens
  +-- skipped failed claims fill later slots
```

Run `node --test` after implementation.

## Metrics Impact

Structured run records from COD-94 are a hard prerequisite for observability. If COD-94 is not already landed when COD-100 is implemented, COD-100 must add a minimal launcher-owned JSONL writer rather than leaving card children as text-only logs. Records should include:

- `parentRunId`
- `cardRunId`
- `issueIdentifier`
- `sweep`
- `slotIndex`
- `sameRepoLimit`
- `worktreePath`
- `logPath`
- `ports`
- `exitCode`

This keeps retrospectives able to distinguish one scheduled tick from several card children.

Dispatch failure Todos must also become card-specific. Use scopes/fingerprints such as `<sweep>:<issueIdentifier>:dispatch` and include sweep, issue, runtime, worktree, and log path in the target payload. Todo titles and bodies must name the card so one failing child does not suppress or overwrite another card's failure.

## Schema & Architecture Impact

README and setup docs should mark same-repo parallel card execution as planned under COD-100. The launcher architecture gains a card-slot planner layered under COD-82's workspace batch selector. No Linear schema change is required.

## Acceptance Criteria

- A dry run shows selected workspace candidates and expanded card slots separately.
- Spec/dev default to four same-repo card children; QA defaults to one; ship remains one.
- Parent-side claims use owner-token heartbeats and confirm the latest owner before dispatch.
- Single-card sweep mode ignores other queue cards.
- Dev branches and worktrees use the exact issue key, for example `COD-123`.
- Spec drafting can happen in parallel, but same-repo merge/push/card moves are serialized.
- Child runs receive explicit env paths for worktree, logs, temp, ports, screenshots, and browser profile.
- Run records and dispatch failure Todos are card-specific.

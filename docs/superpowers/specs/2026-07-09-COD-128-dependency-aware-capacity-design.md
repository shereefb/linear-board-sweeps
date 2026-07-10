# COD-128: Dependency-Aware, Capacity-Bounded Sweeps

Linear: COD-128
Status: approved design
Date: 2026-07-09

## Problem

The scheduled sweep launcher has three related reliability and throughput problems.

First, it does not read Linear dependency relations. A card with unresolved
`blockedBy` issues is currently counted as actionable if its state and labels are
otherwise eligible. On the SafeTaper board this makes sixteen related Guide cards
look independently runnable even though they form a seven-wave dependency graph.
The launcher can spec, hand off, and begin developing downstream cards before
their prerequisites have shipped.

Second, sweeps can represent the same wait twice: a `blockedBy` relation plus
`blocked:needs-user` on the dependent card. Completing the blocking issue then
leaves the generic label behind, so the dependent still requires a manual unblock.
The relation should be durable machine-readable state; a human-only label should
not mirror it.

Third, launcher capacity and health do not match operational reality:

- `parallel.maxNonShipDispatches` limits workspace/stage candidates, not child
  processes. Same-repo slots, refills, and handoffs can raise the real fan-out far
  above the apparent limit.
- A missing runtime executable can produce repeated claim/spawn/release loops.
  On this host, launchd searched the legacy Codex.app bundle while the executable
  lived in ChatGPT.app, causing 98 exit-127 starts in four hours.
- `health` can remain green while every child fails to start.
- Run records do not contain enough queue-wait or host-pressure data to tune
  concurrency from evidence.

## Goals

- Make Linear `blockedBy` the sole source of dependency gating.
- Consider a blocker resolved only when its workflow state name is exactly the
  canonical `Done` value exported as `WORKFLOW_STATES.done`.
- Automatically make a dependent eligible on the next scan after every blocker
  reaches Done, without adding or clearing a dependency label.
- Reserve `blocked:needs-user` for conditions that genuinely require a human and
  are not already represented by an independently completable blocker issue.
- Recheck dependencies at claim time and again inside the child before material
  work, narrowing the unavoidable non-atomic Linear relation race.
- Validate configured runtime executables before claiming work.
- Make runtime-start failures visible in `health`, `doctor`, and self-clearing
  failure Todos.
- Enforce a crash-recoverable host-wide ceiling of ten active scheduled child
  processes across initial dispatch, refill, and handoff paths.
- Record queue and host telemetry sufficient to revisit that ceiling after 24
  hours of healthy operation.
- Preserve downstream-first scheduling, board order, managed-workspace isolation,
  and serial human-gated shipping.

## Non-goals

- Do not infer dependencies from issue descriptions, titles, or comments.
- Do not mirror relations into a new `blocked:dependency` label.
- Do not automatically treat Canceled, Duplicate, or Archived blockers as done.
- Do not automatically remove an ambiguous `blocked:needs-user` label.
- Do not introduce adaptive memory or CPU throttling in this change.
- Do not count reviewer subagents created inside a scheduled child as separate
  host-capacity slots.
- Do not weaken the Ship human gate or allow parallel production shipping.
- Do not replace launchd or introduce a new service or dependency.

## Considered Approaches

### A. Relation-only hard gate (recommended)

Completeness: 10/10. Linear relations remain the single source of dependency
truth. The launcher reads them on scans and claims. Completion naturally releases
the dependent without a cleanup mutation, and no redundant label can drift.

### B. Stage-aware dependency gating

Completeness: 7/10. Spec could run while blocked and only Dev/QA/Ship would wait.
This improves speculative planning throughput, but downstream specs can become
stale while foundational interfaces change. It also makes "blocked" mean different
things by column and complicates immediate handoffs.

### C. Auto-managed dependency label

Completeness: 5/10. The launcher could mirror unresolved relations into a label
and remove it on completion. This preserves the existing label-oriented filters,
but creates two sources of truth and another reconciliation path. It directly
recreates the drift COD-128 is intended to remove.

Net: implement A for every scheduled stage.

## Engineering Review Decisions (Prose Mode)

The engineering review surfaced each decision in prose and applied the complete
recommended option automatically, as requested.

1. **Nested relation pagination:** fail closed whenever the inline blocker
   connection is truncated, then page that card's blockers before eligibility or
   claim. Completeness: 10/10. Silently accepting a partial connection would let a
   downstream card run early.
2. **Admission control:** route initial, refill, and handoff demand through one
   priority admission queue backed by a PID ledger. Completeness: 10/10. A counter
   around the current recursive `Promise.all` paths cannot guarantee either the
   ceiling or ordering.
3. **Dependency race:** keep the scan and claim checks, add a child-side preflight,
   and document that Linear does not offer an atomic claim-plus-relation
   precondition. Completeness: 9/10. This is the narrowest honest guarantee.
4. **Runtime failures:** preserve spawn error code, child exit code, signal, and
   missing working directory as distinct outcomes. Completeness: 10/10. Exit 127
   alone cannot prove that the executable is missing.
5. **Cross-team completion:** retain the user's exact-`Done` rule. A cross-team
   blocker whose state name is not `Done` remains unresolved even if Linear marks
   the state completed. Completeness: 10/10 against the chosen product rule.
6. **Rollout and scope:** retain the user-selected default of ten and one COD-128
   branch, with staged commits, an attended first tick, and a 24-hour observation
   window. The measured host has headroom, and the work shares one launcher
   foundation; splitting cards would add coordination without reducing blast
   radius.

## Dependency Model

For a dependent Linear issue, blockers are represented by
`inverseRelations.nodes` whose `type` is `blocks`. The inverse relation's `issue`
is the blocking issue:

```graphql
inverseRelations(first: 50) {
  pageInfo { hasNextPage endCursor }
  nodes {
    id
    type
    issue {
      id
      identifier
      state { id name type }
    }
  }
}
```

The direct `relations` connection describes issues the current card blocks and is
not used to decide whether the current card may run.

Add `done: "Done"` to `WORKFLOW_STATES`; do not synthesize this value ad hoc in
the launcher. Normalize each fetched card with:

```text
blockers: [
  { relationId, id, identifier, stateId, stateName, stateType }
]
unresolvedBlockers = blockers where stateName !== WORKFLOW_STATES.done
blockersComplete = inverseRelations.pageInfo.hasNextPage === false
```

Only the exact canonical Done state name releases a relation. State type alone is not
sufficient: Canceled, Duplicate, and Archived are terminal-looking states but do
not prove that the prerequisite was delivered.

Rules:

- No blockers: relation-eligible.
- One blocker: eligible only when it is Done.
- Multiple blockers: eligible only when all are Done.
- Canceled, Duplicate, Archived, missing, or inaccessible blocker: fail closed.
- A blocker in another team or project is valid if Linear returns its issue and
  state; project scope applies to cards the sweep mutates, not prerequisite reads.
- A dependency is checked independently of workflow labels. A card must pass both
  the relation gate and the existing label/claim gates.
- A truncated nested relation connection is never eligible from the partial data.
  Page that issue's inverse relations to completion first. If pagination or any
  GraphQL `errors` entry prevents a complete answer, fail closed and surface the
  reason.
- Linear cannot prove that an inaccessible relation was omitted. Before rollout,
  an attended live API check must confirm the configured service account can read
  cross-team blockers used by registered projects. The launcher can fail closed on
  returned missing data, but it must not claim to detect relations the token cannot
  see.

```text
project queue scan
      |
      v
fetch cards + first blocker page
      |
      +-- complete, all blockers Done ----------> eligible candidate
      |
      +-- complete, any blocker not Done -------> dependency wait
      |
      `-- truncated / GraphQL error
                |
                v
        page one card to completion
                |
                +-- complete -------------------> re-evaluate
                `-- incomplete -----------------> fail closed + failure Todo
```

## Queue And Claim Behavior

Fetch all four scheduled queue states once per workspace and drain pass, including
the first blocker page, then partition the normalized snapshot by stage. Apply the
relation gate in the same pure eligibility path used for dry-run counts, board
ordering, slot selection, refill, and handoff. Targeted claim, overflow-pagination,
handoff, and refill reads stay fresh rather than reusing the scan snapshot.

The queue scan logs relation waits without mutating the issue:

```text
SAF-212 dependency-wait: SAF-207=Dev, SAF-209=Spec,
SAF-213=Spec, SAF-221=Spec
```

Immediately before applying a claim, refetch the card with complete blocker
summaries. `claimConfirmed` must reject a card if an unresolved blocker appeared
after the initial scan. If the launcher already added its claim before discovering
the race, it removes only its owned claim and leaves the relations and labels
unchanged.

The claim and relation mutation are not atomic in Linear. Every canonical child
sweep therefore performs one final relation preflight after startup and before its
first material mutation. If a blocker appeared after launcher confirmation, the
child exits with a typed `dependency-deferred` outcome; reconciliation removes only
the launcher's owned claim. A relation added after that child preflight is eventual
consistency, not a guarantee COD-128 can close without Linear transaction support.

After the last blocker moves to Done, the next scan sees an empty
`unresolvedBlockers` set and the card enters normal board-order selection. No
dependency-specific label or comment mutation is required.

## Dependency Anomalies

Self-dependencies, cycles detectable within the complete active-queue snapshot,
missing blocker data, truncated relations that cannot be completed, and returned
inaccessible blocker issues remain ineligible. They also produce a deduplicated
scheduler-failure Todo with the dependent identifier and relation IDs so the wait
is not silent.

Cycle detection is intentionally bounded. It does not claim to detect multi-hop
cycles through Backlog, Todo, Signoff, another project, another team, or relations
the service account cannot read. `doctor` lists the visible unresolved edges and
the detection boundary so an operator can diagnose a permanent wait.

Canceled, Duplicate, and Archived blockers are ordinary unresolved dependencies,
not launcher failures. Logs and `doctor` show their state so an operator can remove
or redirect the relation intentionally.

## Sweep-Created Blockers

Update Spec, Dev, QA, and Ship sweep instructions plus the shared AGENTS/rules
templates to separate two concepts.

### Independently completable prerequisite

When work can be expressed as its own issue, the sweep creates that issue and a
`blockedBy` relation from the dependent to the prerequisite. Examples include a
dashboard secret, DNS change, third-party console registration, manual production
step, or a prerequisite product card.

The sweep:

- does not add `blocked:needs-user` to the dependent;
- adds an audit comment such as
  `[auto-sweep-dependency <dependent> blocked-by <blocker>]`;
- leaves the dependent in its current workflow state;
- lets the launcher relation gate control future selection.

Blocker creation is a retry-safe mini-workflow:

1. Search for the audit marker and an existing matching prerequisite before
   creating anything.
2. Create or reuse the blocker issue.
3. Create the `blockedBy` relation only if it does not already exist.
4. Add the audit comment only if its stable marker is absent.
5. Re-read the relation. Once established, stop material work immediately and
   release the dependent's owned claim through normal reconciliation.

A retry after any partial failure converges on one blocker, one relation, and one
audit marker. An orphaned issue without a relation is reported and reused rather
than duplicated.

Completing the blocker by moving it to Done releases the dependent automatically.

### Direct human answer without a separate prerequisite

When the agent needs a product decision, credential value, clarification, or other
answer that is not represented by a separately completable issue, the existing
`blocked:needs-user` or `blocked:open-questions` path remains correct. The label is
cleared only through the existing human-resolution workflow.

The rule for sweep authors is explicit: never add `blocked:needs-user` merely
because a `blockedBy` relation exists.

## Legacy Relation-Plus-Label Audit

After the new gate is deployed, inspect all three registered projects for cards
carrying both a current visible `blockedBy` relation and `blocked:needs-user`.
Removed historical relations are not inferable from the current relation graph and
are outside this migration unless paginated issue history supplies direct evidence.

Produce a dry-run report first. Remove the label only after attended confirmation
when card comments or paginated history demonstrate that it was added solely to
mirror the dependency and no later human-only request remains. Preserve ambiguous
labels and report them. This is a one-time attended migration, not a permanent
heuristic in the launcher.

Future audit markers make dependency provenance explicit without introducing a
new label.

## Runtime Discovery And Preflight

Resolve every runtime used by an active workspace before card claims.

Resolution order:

1. `CODEX_BIN` or `CLAUDE_BIN` environment override.
2. Executable found on `PATH`.
3. Known macOS bundle candidates:
   - `/Applications/ChatGPT.app/Contents/Resources/codex`
   - `/Applications/Codex.app/Contents/Resources/codex`
4. Preflight failure.

The launchd wrapper also includes both bundle directories, but Node-side
resolution is authoritative and passes the resolved absolute command into child
dispatch.

Preflight is scoped by runtime. A missing runtime:

- prevents claims and dispatches that use it;
- leaves unrelated working runtimes eligible;
- creates or updates one deduplicated failure Todo per active anchor, runtime, and
  host because failure Todos live on each anchor's Linear project;
- records one host/runtime failure in the current-tick state and final `last-tick`;
- makes `health` exit nonzero;
- appears in `doctor` with attempted locations.

Dispatch returns a typed outcome rather than collapsing failures into a number:

```text
{ kind: "success", exitCode: 0 }
{ kind: "child-exit", exitCode, signal }
{ kind: "spawn-error", code, syscall, path, cwd }
{ kind: "interrupted", signal }
```

Only a spawn error that proves the resolved executable disappeared, such as
`ENOENT` with the executable path present and the working directory verified,
marks that runtime unavailable for the rest of the tick. A child exit 127 remains
a child failure; an `ENOENT` caused by a missing `cwd` is a workspace failure. In
either spawn-failure case, release the owned preclaim and stop repeating the same
failed start scope. A later successful preflight reconciles matching failure Todos
to Done and returns health to green.

Write a versioned, atomically replaced `current-tick.json` before dispatch and
update it on runtime, capacity, and systemic failures. `health` reads this record
even while the tick PID is live; a live process is not automatically healthy. On
normal completion, copy the final summary into `last-tick` and remove
`current-tick.json`. `doctor` reports stale current-tick records after PID death.

## Global Child Capacity

Add a host-level registry setting:

```json
{
  "capacity": {
    "maxActiveChildren": 10
  }
}
```

The default is ten. This is a ceiling, not a target. Repository-local settings
continue to shape demand beneath it:

- `maxNonShipDispatches` limits selected workspace/stage candidates.
- `sameRepoCardLimits` limits concurrent cards per workspace/stage.
- `maxSameRepoRefillDispatches` limits refill count.
- `maxHandoffTriggerHops` limits forward edges.
- `maxDrainPasses` limits rescans.

One host-wide admission queue covers initial children, same-repo refill, and
immediate handoffs. Reserve capacity before claiming a card. A card waiting for a
host slot remains unclaimed.

The capacity source of truth is a versioned, atomically replaced PID ledger under
the launcher's host state directory. Each entry carries a unique token, parent PID,
child PID once spawned, issue identifier, workspace, stage, trigger, and timestamp.
Ledger updates run under the existing tick lock. At tick start, reconcile entries:

- live child PID: still consumes capacity;
- reserved token whose live parent has not spawned yet: still consumes capacity;
- dead child and dead parent: stale, remove it;
- unverifiable PID or malformed entry: fail closed, surface in `doctor`, and require
  attended repair rather than silently freeing capacity.

This makes `maxActiveChildren` host-wide across launcher crashes and restarts, not
merely per parent process. A token is reserved before claim, enriched with the child
PID after spawn, and released idempotently by token.

Priority is a total ordering:

1. If any Ship card is eligible, Ship remains exclusive and serial; no non-Ship
   token is admitted.
2. For non-Ship demand: QA before Dev before Spec.
3. Within the same target stage: immediate handoff before initial or refill demand.
4. Then board order, workspace rotation rank, and issue identifier as a stable
   final tie-breaker.

When a child succeeds and advances, its downstream handoff has first use of the
released slot only within that target stage. It never leapfrogs queued work in a
higher-priority stage. Other free slots may be admitted concurrently; the launcher
does not wait for the downstream child to finish before filling remaining capacity.

Release capacity in a `finally` path for normal success, nonzero exit, spawn error,
reconciliation error, or interrupted dispatch. `doctor` and logs show active/max
and the high-water mark.

```text
initial scan ----+
refill demand ---+--> normalize demand --> one priority queue --> reserve ledger token
handoff demand --+                                 |                       |
                                                   | no slot               v
                                                   |                 claim + spawn
                                                   |                       |
                                                   `---- unclaimed         v
                                                              typed result + reconcile
                                                                        |
                                                                        v
                                                               release token exactly once
```

## Telemetry

Extend card run records with optional backward-compatible fields:

- first observed actionable timestamp;
- claim and dispatch timestamps;
- queue-wait duration;
- resolved runtime executable;
- capacity slot and active-child high-water mark;
- host load at start, end, and maximum observed;
- free memory bytes at start, end, and minimum observed, plus optional macOS
  memory-pressure available percentage;
- exit classification: success, child failure, spawn failure, interrupted;
- trigger source: initial, refill, or handoff;
- dependency blockers present when a card was deferred.

Maintain a versioned observation map in an atomically replaced host-state file,
keyed by workspace, sweep, and issue. The first time an issue is observed as
relation/label/claim eligible but lacks host capacity, record
`firstObservedActionableAt`. Preserve it across ten-minute ticks and process
restarts. Clear it after terminal dispatch reconciliation, when the card leaves
that queue, or when it becomes label-, claim-, or relation-blocked again. Prune
entries not observed in any registered queue for seven days. Dry-run reads but
never mutates this file.

A shared low-frequency sampler records `os.loadavg()`, `os.freemem()` as
`freeMemoryBytes`, and `os.totalmem()` while any scheduled child runs. On macOS it
may also record parsed `memory_pressure` available percentage when that command is
present; this optional metric is never confused with Node's free-byte count. A
sampler error records `metricsUnavailable` and never fails dispatch. Sampling
remains observational; COD-128 does not change capacity automatically.

`doctor` and logs summarize:

```text
capacity 7/10, high-water 9
load current=4.2 peak=8.7
memory free=6.1GB minimum=3.8GB, pressure-available=38% minimum=24%
queue p50=3m p90=14m
dependency deferred=12
capacity deferred=3
```

## COD-116 Sequencing

COD-116 is currently in QA and adds managed workspace clones plus the `doctor`
command. COD-128 should build on that implementation rather than add a competing
diagnostic surface.

COD-128 must carry a Linear `blockedBy` relation to COD-116 until COD-116 is Done.
The board should enforce the same sequencing rule the feature is introducing.

Preferred sequence:

1. Finish COD-116 QA and human shipping normally.
2. Rebase or branch COD-128 from the landed COD-116 main.
3. Add runtime, dependency, capacity, and telemetry reporting to the existing
   `doctor` structures.

If COD-128 implementation begins before COD-116 lands, use a stacked branch based
on COD-116 and do not merge COD-128 first.

## Documentation And Config Surface

Update:

- `scripts/linear-watch.mjs` and wrapper runtime discovery;
- launcher tests;
- installer/registry defaults;
- `.claude/linear-sweep.json` commentary where it explains local versus host
  capacity;
- `templates/linear-sweep.json`;
- canonical Spec, Dev, QA, Ship, and Unblock skill copies;
- `AGENTS.md` and `templates/AGENTS.snippet.md`;
- `README.md`, `SETUP.md`, and `docs/linear-rules.md`.

The host ceiling is registry-owned and is not copied into every repository config.

## Verification

Use test-driven development for launcher changes. Required cases:

### Dependencies

- Relation direction: inverse `blocks` means the current card is blocked.
- No blocker and all-Done blocker sets are eligible.
- One unresolved blocker is ineligible.
- Multiple blockers require all Done.
- Canceled, Duplicate, and Archived do not release.
- A blocker added between scan and claim prevents the claim.
- Dependency checks apply to initial selection, refill, and handoff.
- A dependency wait never adds or removes `blocked:needs-user`.
- Self-dependency, detectable cycle, and missing blocker data surface failures.
- Nested relation overflow paginates before eligibility; a failed or partial page
  fails closed.
- GraphQL responses with both data and `errors` do not silently use partial blocker
  data.
- A cross-team blocker is released only by the exact canonical `Done` name.
- Child preflight catches a blocker added after launcher claim confirmation and
  exits without material mutation.
- A fixture for the observed SafeTaper DAG produces the exact seven waves and never
  schedules a later wave early.
- Blocker issue, relation, and audit-comment retries converge without duplicates;
  a completed relation creation stops the current sweep and releases its claim.

### Runtime And Health

- Environment override wins.
- PATH lookup works.
- ChatGPT.app and legacy Codex.app fallbacks work under a sanitized launchd PATH.
- Missing runtime creates no claims and makes health unhealthy.
- Executable `ENOENT` disables later starts for that runtime in the same tick.
- Spawn `ENOENT` for the executable, spawn `ENOENT` for `cwd`, child exit 127, and a
  signal are classified differently.
- Successful recovery closes the matching failure Todo.
- A live tick with a systemic runtime failure remains unhealthy; stale current-tick
  state after PID death is reported.

### Capacity

- At most ten child processes are active across initial dispatch, refill, and
  handoff paths.
- QA/Dev/Spec priority and board order are stable.
- Capacity is reserved before claim.
- Every exit and error path releases exactly one slot.
- Ship stays serial and suppresses non-Ship work.
- A PID ledger survives parent death, preserves live children, and prunes only
  entries whose child and parent are both confirmed dead.
- Simultaneous result callbacks obey stage, trigger, board, rotation, and stable-ID
  ordering; a handoff never leapfrogs a higher-priority stage.
- Duplicate or late release calls are harmless.

### Telemetry

- Observation timestamps survive rescans and clear after reconciliation.
- Queue-wait duration is deterministic with a fake clock.
- Optional metrics preserve old JSONL readers.
- High-water, load, memory, trigger, and exit classification fields are correct.
- Observation state survives restart, resets when eligibility is lost, prunes stale
  entries, and is not mutated by dry-run.
- Sampler failure records `metricsUnavailable` without failing a child.

Run the full Node test suite, `git diff --check`, a sanitized runtime preflight,
and a live board dry-run. Then run one attended real tick with
`maxActiveChildren: 10` and observe 24 hours before changing same-repo slots or the
ten-minute polling interval.

## Acceptance Criteria

- SafeTaper dependency dry-run reports only relation-ready cards as actionable.
- Moving the final blocker to Done makes its dependent eligible without any label
  edit.
- Sweep-created blocker issues do not add `blocked:needs-user` to dependents.
- Missing Codex/Claude executables are caught before claims and make health red.
- ChatGPT.app Codex discovery works from launchd's sanitized environment.
- Scheduled child concurrency never exceeds ten.
- Launcher restart while children survive does not admit an eleventh child.
- Run records and `doctor` expose queue wait, capacity high-water, load, and
  free-memory and optional memory-pressure evidence.
- Existing manual, open-question, QA-change, crash-loop, and bounce-loop labels
  retain their current safety behavior.
- Ship remains serial, human-gated, and fail-closed.

## What Already Exists

- `actionableCards` already centralizes label and live-claim eligibility. Extend it
  with normalized dependency eligibility rather than creating a second selector.
- `fetchCards` and `fetchCard` already provide paginated queue snapshots and fresh
  claim reads. Add relation normalization and an overflow helper; do not create a
  parallel Linear client.
- `selectDispatchBatch`, same-repo refill, and handoff logic already express demand
  and stage ranking. Feed those demand records into one admission queue rather than
  patching three independent capacity checks.
- The tick lock, `last-tick`, failure-Todo reconciliation, run records, and COD-116
  `doctor` structures already provide the state and diagnostics foundation. Extend
  their schemas with versions and typed outcomes.
- Canonical sweep skills and shared templates already define human-block labels and
  Todo creation. Update these sources in place so all three registered repos inherit
  one rule.

## NOT in Scope

- Adaptive CPU or memory throttling. First collect trustworthy pressure and queue
  data at the fixed ceiling of ten.
- A shorter polling interval. Revisit only after 24 hours of healthy runtime and
  queue-wait evidence.
- Global cycle discovery across every Linear team, project, and workflow state. The
  launcher reports the bounded graph it can prove instead of issuing an unbounded
  organization-wide crawl.
- Counting reviewer subagents launched inside a scheduled child. This ceiling
  governs scheduled top-level children only.
- Replacing launchd, adding a daemon, or adopting a third-party queue/semaphore
  package. The single-host, zero-dependency launcher can use atomic JSON state and
  the existing tick lock.
- Automatically deleting ambiguous legacy human-block labels or reconstructing
  removed relations without direct issue-history evidence.

The review considered three follow-up TODOs: adaptive throttling, a five-minute
polling interval, and organization-wide cycle discovery. In prose mode each was
auto-decided **Skip** because telemetry or a concrete failure is required before
that work is valuable. No `TODOS.md` entry is created.

## Test Coverage Map

The project uses Node's built-in `node:test` runner in `tests/*.test.mjs`.

```text
CODE PATHS                                           OPERATOR FLOWS
[+] queue snapshot + dependency normalize           [+] Dependency release
  |-- [GAP] relation direction                         |-- [GAP] blocker not Done -> waits
  |-- [GAP] exact Done / terminal non-Done             |-- [GAP] final blocker Done -> eligible
  |-- [GAP] nested pagination + partial errors          `-- [GAP] no label cleanup required
  |-- [GAP] bounded cycle / missing visibility
  `-- [GAP] SafeTaper seven-wave fixture              [+] Runtime recovery
                                                        |-- [GAP] sanitized launchd PATH
[+] scan -> claim -> child preflight                    |-- [GAP] ENOENT vs cwd vs exit 127
  |-- [GAP] blocker added before claim                  `-- [GAP] health/Todo self-clears
  `-- [GAP] blocker added after confirm
                                                     [+] Capacity under contention
[+] blocker mini-workflow                               |-- [GAP] never exceeds 10
  `-- [GAP] retry each partial side effect               |-- [GAP] parent crash + live child
                                                        `-- [GAP] deterministic priority
[+] priority queue + PID ledger
  |-- [GAP] reserve before claim                      [+] Evidence for tuning
  |-- [GAP] typed finish / idempotent release           |-- [GAP] queue wait across restart
  `-- [GAP] stale/live PID reconciliation               `-- [GAP] sampler failure is nonfatal

COVERAGE: 0/13 planned behavior groups implemented; all 13 are implementation
gaps, not regressions in an existing COD-128 implementation.
Legend: [GAP] becomes a required unit or integration test in this branch.
```

No browser E2E or LLM eval is required. The critical integration boundary is the
launcher-to-Linear GraphQL contract, covered with fixture responses plus one
attended live visibility and dry-run check.

## Failure Modes

| Codepath | Real production failure | Planned test | Error handling | Operator experience |
|---|---|---|---|---|
| Relation fetch | Nested page truncates or returns partial GraphQL errors | Yes | Fail closed; targeted pagination; failure Todo | `doctor` names issue and cursor boundary |
| Dependency race | Blocker is added after launcher confirmation | Yes | Child preflight exits `dependency-deferred` | Claim clears; card waits without mutation |
| Blocker creation | Issue exists but relation/comment request times out | Yes | Stable marker lookup and idempotent retry | Orphan is reported and reused |
| Runtime preflight | Bundle moves or PATH is sanitized | Yes | Absolute resolution before claim | Health red; per-anchor failure Todo |
| Spawn | Executable or working directory disappears | Yes | Typed `spawn-error`; stop matching starts | Health and `doctor` show exact missing path |
| Capacity ledger | Parent crashes while children survive | Yes | Live child PID keeps its token | Next tick waits instead of exceeding ten |
| Admission order | Handoff and refill arrive together | Yes | One comparator and queue | Higher stage wins deterministically |
| State persistence | Process dies during JSON update | Yes | Atomic temp-write-and-rename; version validation | Last good file survives; malformed state fails closed |
| Metrics | `memory_pressure` or sampler call fails | Yes | Mark metrics unavailable | Dispatch continues; telemetry explains gap |

After these requirements are implemented there are zero known silent failures that
lack both a test and an error path.

## Worktree Parallelization Strategy

Sequential implementation, no safe core-code parallelization opportunity. The
dependency gate, admission queue, runtime health, and telemetry all modify the same
launcher state machine in `scripts/linear-watch.mjs` and the same primary test file.
Mechanical skill/template documentation follows the verified behavior. Parallel
worktrees would create merge conflicts and make state-schema decisions drift.

Use staged commits on one branch:

1. Dependency query, normalization, claim/child gates, and blocker semantics.
2. Runtime resolution, typed outcomes, current-tick health, and failure Todos.
3. Priority admission queue, crash-recoverable PID ledger, and capacity tests.
4. Persistent telemetry, diagnostics, canonical skill/template docs, and attended
   migration report.

## Implementation Tasks

Synthesized from the review findings. Each task is build-actionable and verified in
the existing Node test suite.

- [ ] **T1 (P1, human: ~6h / CC: ~45min)** — Linear dependency gate — Add complete blocker pagination and exact-Done eligibility
  - Surfaced by: Architecture — partial nested relations can fail open.
  - Files: `scripts/linear.mjs`, `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`
  - Verify: `node --test tests/linear-watch.test.mjs`
- [ ] **T2 (P1, human: ~4h / CC: ~30min)** — Claim safety — Add fresh claim and child-side dependency preflights
  - Surfaced by: Architecture — Linear offers no atomic claim-plus-relation precondition.
  - Files: `scripts/linear-watch.mjs`, canonical sweep `SKILL.md` files, `tests/linear-watch.test.mjs`
  - Verify: race fixtures show no material mutation after a late blocker.
- [ ] **T3 (P1, human: ~6h / CC: ~45min)** — Blocker workflow — Make issue/relation/comment creation idempotent and remove mirrored human-block labeling
  - Surfaced by: Architecture — partial side effects can create duplicate or orphan blockers.
  - Files: canonical sweep `SKILL.md` files, shared rules/templates, documentation tests
  - Verify: retry fixtures converge on one issue, relation, and marker.
- [ ] **T4 (P1, human: ~5h / CC: ~35min)** — Runtime health — Resolve binaries before claims and preserve typed spawn outcomes
  - Surfaced by: Code Quality — `ENOENT`, missing `cwd`, child 127, and signals are different failures.
  - Files: `scripts/linear-watch.mjs`, launchd wrapper/install surfaces, launcher tests
  - Verify: sanitized PATH and typed-outcome tests plus `health`/`doctor` assertions.
- [ ] **T5 (P1, human: ~8h / CC: ~60min)** — Host capacity — Replace recursive dispatch admission with one priority queue and PID ledger
  - Surfaced by: Architecture — current `Promise.all` handoff/refill paths cannot enforce ten or total ordering.
  - Files: `scripts/linear-watch.mjs`, registry defaults, `tests/linear-watch.test.mjs`
  - Verify: contention and parent-crash tests never admit an eleventh child.
- [ ] **T6 (P2, human: ~5h / CC: ~40min)** — Persistent telemetry — Add atomic observation/current-tick state and nonfatal host sampling
  - Surfaced by: Performance — in-memory observations cannot measure queue wait across ticks.
  - Files: `scripts/linear-watch.mjs`, COD-116 doctor structures, launcher tests
  - Verify: fake-clock restart, pruning, dry-run, and sampler-failure tests.
- [ ] **T7 (P2, human: ~4h / CC: ~30min)** — Query efficiency — Fetch one scheduled queue snapshot per workspace/pass
  - Surfaced by: Performance — four stage reads multiply Linear payload and rate-limit cost.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`
  - Verify: request-count fixture plus fresh targeted claim/handoff/refill reads.
- [ ] **T8 (P2, human: ~4h / CC: ~30min)** — Rollout and docs — Update canonical copies, run migration dry-run, and observe an attended tick
  - Surfaced by: Code Quality — three registered repos must inherit one blocker rule and one host-capacity definition.
  - Files: canonical skills, `AGENTS.md`, templates, `README.md`, `SETUP.md`, `docs/linear-rules.md`
  - Verify: full `node --test`, `git diff --check`, live dry-run, attended tick, 24-hour observation.

## Engineering Review Completion Summary

- Step 0: Scope Challenge — scope accepted as-is, delivered as four staged commits.
- Architecture Review: 6 issues found and folded into the spec.
- Code Quality Review: 4 issues found and folded into the spec.
- Test Review: diagram produced, 13 behavior-group gaps identified.
- Performance Review: 3 issues found and folded into the spec.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 3 items considered; all auto-decided Skip in prose mode.
- Failure modes: 0 critical gaps remain in the reviewed plan.
- Outside voice: Codex ran; 11 correctness points accepted, 4 prior decisions retained.
- Parallelization: 1 sequential core lane, 0 safe parallel lanes.
- Lake Score: 24/26 recommendations chose the complete option; the two rejected
  recommendations were splitting the card and lowering the explicit ceiling of ten.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | Not run; infrastructure behavior does not need product-scope review |
| Codex Review | `/codex review` | Independent second opinion | 1 | ISSUES FOLDED | 15 findings; 11 accepted, 4 prior decisions retained |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 26 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | No UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | Not required for internal scheduler behavior |

**CODEX:** The outside voice hardened state naming, relation pagination, race handling, crash-safe capacity, typed spawn errors, health, persistence, retry semantics, and migration feasibility.

**CROSS-MODEL:** Both passes agreed on a single normalized queue, one admission path, fail-closed blocker reads, child preflight, typed runtime failures, and persistent state. The main review retained the user's explicit ceiling of ten and one-card scope.

**VERDICT:** ENG CLEARED — ready to write the implementation plan.

NO UNRESOLVED DECISIONS

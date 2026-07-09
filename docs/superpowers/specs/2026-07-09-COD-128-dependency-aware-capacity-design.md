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
- Consider a blocker resolved only when its workflow state is exactly `Done`.
- Automatically make a dependent eligible on the next scan after every blocker
  reaches Done, without adding or clearing a dependency label.
- Reserve `blocked:needs-user` for conditions that genuinely require a human and
  are not already represented by an independently completable blocker issue.
- Recheck dependencies at claim time so a newly added blocker cannot race a scan.
- Validate configured runtime executables before claiming work.
- Make runtime-start failures visible in `health`, `doctor`, and self-clearing
  failure Todos.
- Enforce a host-wide ceiling of ten active scheduled child processes across
  initial dispatch, refill, and handoff paths.
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

## Dependency Model

For a dependent Linear issue, blockers are represented by
`inverseRelations.nodes` whose `type` is `blocks`. The inverse relation's `issue`
is the blocking issue:

```graphql
inverseRelations {
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

Normalize each fetched card with:

```text
blockers: [
  { relationId, id, identifier, stateId, stateName, stateType }
]
unresolvedBlockers = blockers where stateName !== WORKFLOW_STATES.done
```

Only the exact configured Done state releases a relation. State type alone is not
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

## Queue And Claim Behavior

Extend the launcher card query to fetch blocker summaries inline. Apply the
relation gate in the same pure eligibility path used for dry-run counts, board
ordering, slot selection, refill, and handoff.

The queue scan logs relation waits without mutating the issue:

```text
SAF-212 dependency-wait: SAF-207=Dev, SAF-209=Spec,
SAF-213=Spec, SAF-221=Spec
```

Immediately before applying a claim, refetch the card with its blocker summaries.
`claimConfirmed` must reject a card if an unresolved blocker appeared after the
initial scan. If the launcher already added its claim before discovering the race,
it removes only its owned claim and leaves the relations and labels unchanged.

After the last blocker moves to Done, the next scan sees an empty
`unresolvedBlockers` set and the card enters normal board-order selection. No
dependency-specific label or comment mutation is required.

## Dependency Anomalies

Self-dependencies, cycles detectable among the cards fetched for the active
project queues, missing blocker data, and inaccessible blocker issues remain
ineligible. They also produce a deduplicated scheduler-failure Todo with the
dependent identifier and relation IDs so the wait is not silent.

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
carrying both unresolved or historical `blockedBy` relations and
`blocked:needs-user`.

Remove the label only when card comments or history demonstrate that it was added
solely to mirror the dependency and no later human-only request remains. Preserve
ambiguous labels and report them. This is a one-time attended migration, not a
permanent heuristic in the launcher.

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
- creates or updates one deduplicated failure Todo for the runtime/host scope;
- records a systemic failure in `last-tick`;
- makes `health` exit nonzero;
- appears in `doctor` with attempted locations.

If a binary disappears after preflight and spawn returns exit 127, release an
owned preclaim, mark that runtime unavailable for the rest of the tick, and stop
additional starts for it. A later successful preflight reconciles the failure Todo
to Done and returns health to green.

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

One host-wide capacity allocator covers initial children, same-repo refill, and
immediate handoffs. Reserve capacity before claiming a card. A card waiting for a
host slot remains unclaimed.

Priority is deterministic:

1. Ship remains exclusive and serial.
2. QA.
3. Dev.
4. Spec.
5. Board order within a stage.

When a child succeeds and advances, its downstream handoff has first use of the
released slot. Other free slots may refill concurrently; the launcher does not
wait for the downstream child to finish before filling remaining capacity.

Release capacity in a `finally` path for normal success, nonzero exit, spawn error,
reconciliation error, or interrupted dispatch. `doctor` and logs show active/max
and the high-water mark.

## Telemetry

Extend card run records with optional backward-compatible fields:

- first observed actionable timestamp;
- claim and dispatch timestamps;
- queue-wait duration;
- resolved runtime executable;
- capacity slot and active-child high-water mark;
- host load at start, end, and maximum observed;
- available memory at start, end, and minimum observed;
- exit classification: success, child failure, spawn failure, interrupted;
- trigger source: initial, refill, or handoff;
- dependency blockers present when a card was deferred.

Maintain a small local observation map keyed by workspace, sweep, and issue. The
first time an issue is observed as relation/label/claim eligible but lacks host
capacity, record `firstObservedActionableAt`. Clear the observation after terminal
dispatch reconciliation or when the card leaves that queue.

A shared low-frequency sampler records host load and available memory while any
scheduled child runs. It remains observational; COD-128 does not change capacity
automatically.

`doctor` and logs summarize:

```text
capacity 7/10, high-water 9
load current=4.2 peak=8.7
memory available=38% minimum=24%
queue p50=3m p90=14m
dependency deferred=12
capacity deferred=3
```

## COD-116 Sequencing

COD-116 is currently in QA and adds managed workspace clones plus the `doctor`
command. COD-128 should build on that implementation rather than add a competing
diagnostic surface.

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

### Runtime And Health

- Environment override wins.
- PATH lookup works.
- ChatGPT.app and legacy Codex.app fallbacks work under a sanitized launchd PATH.
- Missing runtime creates no claims and makes health unhealthy.
- Exit 127 disables later starts for that runtime in the same tick.
- Successful recovery closes the matching failure Todo.

### Capacity

- At most ten child processes are active across initial dispatch, refill, and
  handoff paths.
- QA/Dev/Spec priority and board order are stable.
- Capacity is reserved before claim.
- Every exit and error path releases exactly one slot.
- Ship stays serial and suppresses non-Ship work.

### Telemetry

- Observation timestamps survive rescans and clear after reconciliation.
- Queue-wait duration is deterministic with a fake clock.
- Optional metrics preserve old JSONL readers.
- High-water, load, memory, trigger, and exit classification fields are correct.

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
- Run records and `doctor` expose queue wait, capacity high-water, load, and
  available-memory evidence.
- Existing manual, open-question, QA-change, crash-loop, and bounce-loop labels
  retain their current safety behavior.
- Ship remains serial, human-gated, and fail-closed.

# COD-128 Dependency-Aware Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every registered Linear sweep respect exact-`Done` `blockedBy` relations, preflight runtimes, enforce a crash-recoverable host ceiling of ten scheduled children, and emit trustworthy health and tuning evidence.

**Architecture:** Build on COD-116's managed-workspace and `doctor` implementation. Put reusable Linear dependency semantics and the child preflight CLI in `scripts/linear.mjs`; keep scheduler admission, PID-ledger state, runtime health, and telemetry in `scripts/linear-watch.mjs`. Initial, refill, and handoff demand all enter one deterministic admission path; canonical skills and templates describe the same relation-only blocker rule and are propagated after landing.

**Tech Stack:** Node.js 18+ ESM, built-in `node:test`, Linear GraphQL, zero third-party runtime dependencies, launchd, git worktrees.

## Global Constraints

- A blocker resolves only when `state.name === WORKFLOW_STATES.done`, where `WORKFLOW_STATES.done === "Done"`; Canceled, Duplicate, Archived, and other completed-type states remain unresolved.
- A `blockedBy` relation never causes `blocked:needs-user` to be added to the dependent card.
- Relation reads fail closed on GraphQL errors, missing blocker data, or incomplete pagination.
- Scan, claim confirmation, and child preflight all enforce dependency eligibility; the remaining post-preflight race is documented as eventual consistency.
- `capacity.maxActiveChildren` defaults to exactly `10` and covers initial, refill, and handoff scheduled children across parent restarts.
- Ship remains exclusive, serial, human-gated, and higher priority than all non-Ship work.
- Non-Ship total order is stage (`qa`, `dev`, `spec`), then stage-local handoff before initial/refill, then board order, workspace rotation, and identifier.
- Runtime resolution order is environment override, `PATH`, ChatGPT.app bundle, legacy Codex.app bundle, then fail before claim.
- Spawn error code, child exit code, signal, and missing working directory remain distinct outcomes.
- Telemetry is observational only; this change does not auto-throttle or shorten the ten-minute interval.
- The implementation adds no third-party runtime dependency and does not bypass COD-116 managed workspaces.

---

## File Map

| File | Responsibility in COD-128 |
|---|---|
| `scripts/linear.mjs` | Canonical `Done` constant, blocker normalization, paginated dependency query, `dependency-status` child CLI |
| `scripts/linear-watch.mjs` | Queue snapshot normalization, claim gate, runtime discovery, typed dispatch, priority admission, PID ledger, health, telemetry, doctor |
| `scripts/install-watch.sh` | launchd PATH and registry/default migration, post-land machine installation |
| `tests/linear.test.mjs` | exact-Done and dependency query/CLI behavior |
| `tests/linear-watch.test.mjs` | scheduler dependency, runtime, capacity, persistence, priority, and telemetry behavior |
| `tests/install-watch.test.mjs` | ChatGPT/Codex bundle PATH and host default installation |
| `.claude/skills/*-sweep/SKILL.md` | child preflight and relation-only blocker creation rules used by Claude/Codex |
| `skills/*-sweep/SKILL.md` | canonical propagated copies matching `.claude/skills` |
| `AGENTS.md`, `templates/AGENTS.snippet.md` | cross-runtime source-of-truth rules |
| `templates/linear-sweep.json` | explain local demand limits versus host ceiling |
| `README.md`, `SETUP.md`, `docs/linear-rules.md` | operator behavior, migration, evidence, and recovery |

### Task 1: Integrate COD-116 and add canonical dependency semantics

**Files:**
- Merge: branch `COD-116` into `codex/COD-128-dependency-aware-capacity`
- Modify: `scripts/linear.mjs`
- Test: `tests/linear.test.mjs`

**Interfaces:**
- Consumes: COD-116 managed registry, workspace materialization, current `gql()` helper.
- Produces: `WORKFLOW_STATES.done`, `normalizeBlockingRelations(connection)`, `dependencyEligibility(blockers, complete)`, `fetchIssueDependencies(apiKey, issueId)`, CLI `dependency-status <issueId>`.

- [ ] **Step 1: Merge the required COD-116 implementation**

```bash
git merge --no-ff COD-116 -m "Merge COD-116 managed runner prerequisite"
node --test
```

Expected: clean merge and the COD-116 baseline suite passes. If the merge conflicts, preserve COD-116 behavior and the already-committed COD-128 spec; do not reimplement COD-116.

- [ ] **Step 2: Write failing exact-Done and relation-direction tests**

Add imports and tests in `tests/linear.test.mjs`:

```js
import {
  WORKFLOW_STATES,
  normalizeBlockingRelations,
  dependencyEligibility,
} from "../scripts/linear.mjs";

test("dependency eligibility releases only exact Done blockers", () => {
  assert.equal(WORKFLOW_STATES.done, "Done");
  const connection = {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      { id: "r1", type: "blocks", issue: { id: "b1", identifier: "COD-1", state: { id: "s1", name: "Done", type: "completed" } } },
      { id: "r2", type: "related", issue: { id: "x", identifier: "COD-2", state: { id: "s2", name: "Done", type: "completed" } } },
    ],
  };
  const blockers = normalizeBlockingRelations(connection);
  assert.deepEqual(blockers.map((b) => b.identifier), ["COD-1"]);
  assert.deepEqual(dependencyEligibility(blockers, true), { eligible: true, reason: "ready", unresolved: [] });
});

test("dependency eligibility fails closed for terminal non-Done and incomplete pages", () => {
  const canceled = [{ relationId: "r", id: "b", identifier: "COD-3", stateId: "s", stateName: "Canceled", stateType: "canceled" }];
  assert.equal(dependencyEligibility(canceled, true).eligible, false);
  assert.equal(dependencyEligibility([], false).reason, "incomplete-relations");
});

test("dependency normalization fails closed when a blocks relation has no issue", () => {
  assert.throws(
    () => normalizeBlockingRelations({ pageInfo: { hasNextPage: false }, nodes: [{ id: "r", type: "blocks", issue: null }] }),
    /blocking relation r has no readable issue/,
  );
});
```

- [ ] **Step 3: Run the tests and verify RED**

```bash
node --test tests/linear.test.mjs
```

Expected: FAIL because the three dependency exports do not exist.

- [ ] **Step 4: Implement the minimal pure dependency model**

In `scripts/linear.mjs`, add `done: "Done"` and exported helpers with this contract:

```js
export function normalizeBlockingRelations(connection) {
  const nodes = connection?.nodes;
  if (!Array.isArray(nodes)) throw new Error("inverseRelations nodes missing");
  return nodes.filter((relation) => relation.type === "blocks").map((relation) => {
    if (!relation.issue?.id || !relation.issue?.state?.name) {
      throw new Error(`blocking relation ${relation.id || "unknown"} has no readable issue`);
    }
    return {
      relationId: relation.id,
      id: relation.issue.id,
      identifier: relation.issue.identifier,
      stateId: relation.issue.state.id,
      stateName: relation.issue.state.name,
      stateType: relation.issue.state.type,
    };
  });
}

export function dependencyEligibility(blockers, complete = true) {
  if (!complete) return { eligible: false, reason: "incomplete-relations", unresolved: blockers || [] };
  const unresolved = (blockers || []).filter((blocker) => blocker.stateName !== WORKFLOW_STATES.done);
  return { eligible: unresolved.length === 0, reason: unresolved.length ? "blocked" : "ready", unresolved };
}
```

- [ ] **Step 5: Verify GREEN**

```bash
node --test tests/linear.test.mjs
```

Expected: all `linear.test.mjs` tests pass.

- [ ] **Step 6: Write failing paginated-query and CLI tests**

Add injected-`gqlFn` tests that return two inverse-relation pages and assert:

```js
const result = await fetchIssueDependencies("key", "COD-9", { gqlFn });
assert.deepEqual(result.blockers.map((b) => b.identifier), ["COD-1", "COD-2"]);
assert.equal(result.complete, true);
assert.equal(calls.length, 2);
```

Also assert a GraphQL/query failure rejects instead of returning an empty blocker set.

- [ ] **Step 7: Verify RED, implement pagination, verify GREEN**

Implement `fetchIssueDependencies(apiKey, issueId, { gqlFn = gql } = {})` with `inverseRelations(first:50, after:$cursor)`, `pageInfo`, exact relation normalization, and no catch that converts errors into eligibility. Add CLI output:

```json
{"issue":"COD-9","eligible":false,"reason":"blocked","blockers":[{"identifier":"COD-1","stateName":"Dev"}]}
```

The command exits `0` when eligible, `3` when dependency-blocked, and `2` for unreadable/incomplete data.

```bash
node --test tests/linear.test.mjs
git add scripts/linear.mjs tests/linear.test.mjs
git commit -m "COD-128 add canonical dependency semantics"
```

### Task 2: Gate scans, claims, refills, and handoffs on complete relations

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Consumes: Task 1 `normalizeBlockingRelations`, `dependencyEligibility`, `fetchIssueDependencies`.
- Produces: normalized card fields `blockers`, `blockersComplete`, `dependency`; one scheduled-state snapshot per workspace/pass; dependency-aware `actionableCards` and `claimConfirmed`.

- [ ] **Step 1: Write failing pure eligibility tests**

```js
test("actionableCards excludes unresolved and incomplete dependencies", () => {
  const cfg = SWEEP_CFG.dev;
  const ready = { id: "ready", labelNames: [], comments: [], blockers: [], blockersComplete: true };
  const blocked = { id: "blocked", labelNames: [], comments: [], blockers: [{ identifier: "COD-1", stateName: "Dev" }], blockersComplete: true };
  const partial = { id: "partial", labelNames: [], comments: [], blockers: [], blockersComplete: false };
  assert.deepEqual(actionableCards([ready, blocked, partial], cfg, NOW).map((c) => c.id), ["ready"]);
});

test("claimConfirmed rejects a blocker added after scan", () => {
  const card = claimedCard({ blockers: [{ identifier: "COD-1", stateName: "QA" }], blockersComplete: true });
  assert.equal(claimConfirmed(card, SWEEP_CFG.dev, OWNER, ["Dev"]), false);
});
```

- [ ] **Step 2: Verify RED, add the relation gate, verify GREEN**

```bash
node --test tests/linear-watch.test.mjs --test-name-pattern='actionableCards excludes unresolved|claimConfirmed rejects a blocker'
```

Update `actionableCards` and `claimConfirmed` to call `dependencyEligibility(card.blockers, card.blockersComplete !== false)` in addition to existing label/claim gates. Preserve old test fixtures by normalizing absent relation fields to complete with zero blockers only inside fixture/card normalization, not on a partial API response.

- [ ] **Step 3: Write failing queue-snapshot tests**

Inject a fake GraphQL client and assert one active-queue request contains all four scheduled states, inline `inverseRelations(first:50)`, and partitions cards by state. Add an overflow card whose `hasNextPage` is true; assert the targeted paginator runs before it becomes eligible. Add a response with partial data plus `errors`; assert the workspace scan records a failure and does not select the card.

- [ ] **Step 4: Verify RED, implement one snapshot per workspace/pass, verify GREEN**

Replace per-sweep `fetchCards` calls in the cheap scan with one `fetchScheduledQueueCards(apiKey, teamKey, projectId, states)` call. Keep targeted fresh reads for claim, refill, and handoff. Normalize every API card with explicit `blockersComplete` and page overflow before selection.

```bash
node --test tests/linear-watch.test.mjs --test-name-pattern='dependency|queue snapshot|overflow|partial GraphQL'
```

- [ ] **Step 5: Add the SafeTaper seven-wave fixture**

Represent the observed DAG as identifiers plus blocker identifiers and repeatedly mark each selected wave Done. Assert the exact waves from the reviewed spec and that no later wave is selected early.

- [ ] **Step 6: Run task verification and commit**

```bash
node --test tests/linear-watch.test.mjs
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "COD-128 gate sweep queues on Linear dependencies"
```

### Task 3: Add child preflight and retry-safe relation-only blocker instructions

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Modify: `.claude/skills/spec-sweep/SKILL.md`
- Modify: `.claude/skills/dev-sweep/SKILL.md`
- Modify: `.claude/skills/qa-sweep/SKILL.md`
- Modify: `.claude/skills/ship-sweep/SKILL.md`
- Modify: `.claude/skills/unblock-sweep/SKILL.md`
- Modify: matching `skills/*-sweep/SKILL.md` files
- Modify: `AGENTS.md`
- Modify: `templates/AGENTS.snippet.md`
- Test: `tests/linear-watch.test.mjs`
- Test: `tests/agents-snippet.test.mjs`
- Test: `tests/ship-sweep-doc.test.mjs`

**Interfaces:**
- Consumes: Task 1 `dependency-status` CLI.
- Produces: child env `AUTO_SWEEP_KIT_PATH` and `AUTO_SWEEP_SOURCE_ANCHOR`; mandatory preflight command; retry-safe blocker mini-workflow; no mirrored human-block label.

- [ ] **Step 1: Write failing environment and canonical-copy tests**

Assert `withCardDispatchEnv()` includes the resolved kit path and source anchor. Add text assertions requiring every scheduled skill to mention `dependency-status`, exact `Done`, and “never add `blocked:needs-user` merely because a `blockedBy` relation exists.” Assert `.claude/skills` and `skills` canonical copies match byte-for-byte.

- [ ] **Step 2: Verify RED and add the minimal child environment**

```bash
node --test tests/linear-watch.test.mjs tests/agents-snippet.test.mjs tests/ship-sweep-doc.test.mjs
```

Add to child env:

```js
AUTO_SWEEP_KIT_PATH: KIT_ROOT,
AUTO_SWEEP_SOURCE_ANCHOR: pick.sourceAnchorPath || pick.anchorPath,
```

- [ ] **Step 3: Update scheduled skill preflight instructions**

Each scheduled sweep must run before its first material mutation:

```bash
node "$AUTO_SWEEP_KIT_PATH/scripts/linear.mjs" dependency-status "$AUTO_SWEEP_ISSUE"
```

Exit `3`: comment the visible blocker identifiers/states, remove only the sweep's owned claim, and stop without material work. Exit `2`: report unreadable dependency data, remove only the owned claim, and stop. Exit `0`: continue.

- [ ] **Step 4: Update blocker-creation rules**

Use the exact retry-safe sequence: search stable audit marker, create/reuse blocker, create relation only if absent, add marker only if absent, re-read relation, stop and release the dependent claim. A separately completable blocker uses only `blockedBy`; a direct human answer without its own issue retains the current human-block label path.

- [ ] **Step 5: Verify copies and commit**

```bash
node --test tests/linear-watch.test.mjs tests/agents-snippet.test.mjs tests/ship-sweep-doc.test.mjs
git add scripts/linear-watch.mjs .claude/skills skills AGENTS.md templates/AGENTS.snippet.md tests
git commit -m "COD-128 teach sweeps relation-only blocker handling"
```

### Task 4: Preflight runtimes and make current-tick health truthful

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Modify: `scripts/install-watch.sh`
- Test: `tests/linear-watch.test.mjs`
- Test: `tests/install-watch.test.mjs`

**Interfaces:**
- Produces: `resolveRuntimeExecutable(runtime, env, options)`, `classifyDispatchOutcome(event)`, `current-tick.json`, typed run-record outcome.

- [ ] **Step 1: Write failing runtime-resolution tests**

Cover override, `PATH`, ChatGPT.app, Codex.app, and missing runtime. Use injected `existsFn` and `whichFn`; do not touch real applications in unit tests.

```js
assert.equal(resolveRuntimeExecutable("codex", { CODEX_BIN: "/custom/codex" }, deps).path, "/custom/codex");
assert.equal(resolveRuntimeExecutable("codex", {}, chatGptDeps).path, "/Applications/ChatGPT.app/Contents/Resources/codex");
assert.equal(resolveRuntimeExecutable("codex", {}, missingDeps).ok, false);
```

- [ ] **Step 2: Verify RED, implement resolution, verify GREEN**

Resolution must be complete before any claim for a runtime. Pass the resolved absolute executable to dispatch. Scope failure Todos by anchor/runtime/host and stop only that runtime's starts.

- [ ] **Step 3: Write failing typed-outcome tests**

Assert executable `ENOENT`, missing-`cwd` `ENOENT`, child exit 127, signal termination, interruption, and success produce different `{ kind, code, exitCode, signal, path, cwd }` records. Assert only executable disappearance disables the runtime for the tick.

- [ ] **Step 4: Verify RED, implement typed dispatch, verify GREEN**

Keep spawn `error` and `close` listeners idempotent. `dispatchBatch` returns typed results; callers derive `success` from `kind === "success"`, not `exitCode === 0` alone.

- [ ] **Step 5: Write failing current-tick health tests**

Assert a live lock PID plus current systemic failure is unhealthy, normal completion copies the final state to `last-tick`, and dead-PID current state appears stale in doctor.

- [ ] **Step 6: Implement atomic current-tick state and installer PATH**

Use temp-file-plus-rename in the same directory. The launchd PATH includes both `/Applications/ChatGPT.app/Contents/Resources` and `/Applications/Codex.app/Contents/Resources`, but Node resolution remains authoritative.

- [ ] **Step 7: Verify and commit**

```bash
node --test tests/linear-watch.test.mjs tests/install-watch.test.mjs
git add scripts/linear-watch.mjs scripts/install-watch.sh tests
git commit -m "COD-128 preflight runtimes and expose start failures"
```

### Task 5: Add the host-wide priority admission queue and PID ledger

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Modify: `scripts/install-watch.sh`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Produces: registry `capacity.maxActiveChildren`, `compareAdmissionDemand(a,b)`, `createCapacityLedger(options)`, `admitDemand(demand)`, idempotent token release.

- [ ] **Step 1: Write failing registry/default tests**

Assert legacy registries normalize to `{ capacity: { maxActiveChildren: 10 } }`, configured values are clamped to positive integers, and installation persists ten without deleting existing settings.

- [ ] **Step 2: Write failing total-order tests**

Construct simultaneous QA/Dev/Spec initial, refill, and handoff records. Assert Ship is exclusive, QA beats Dev, Dev beats Spec, and handoff only wins inside the same stage before board order and identifier.

- [ ] **Step 3: Verify RED, implement comparator and registry migration, verify GREEN**

Use one explicit comparator; do not depend on arrival order or `Promise.all` timing.

- [ ] **Step 4: Write failing PID-ledger tests**

With injected liveness and atomic-write functions, cover reserve-before-claim, child PID attachment, live child/dead parent, dead child/dead parent pruning, malformed entry fail-closed, duplicate release, and eleven simultaneous demands with max ten.

- [ ] **Step 5: Verify RED and implement the ledger**

Ledger schema:

```json
{"version":1,"entries":[{"token":"uuid","parentPid":123,"childPid":456,"issueIdentifier":"COD-1","workspace":"/managed","stage":"dev","trigger":"handoff","reservedAt":"ISO"}]}
```

Use the existing tick lock for writes. Reserve a token before claim, attach child PID after spawn, and release exactly once in `finally` after reconciliation. Malformed/unverifiable entries consume capacity and make `doctor` nonzero until attended repair.

- [ ] **Step 6: Route all demand through one admission function**

Replace direct recursive initial/refill/handoff dispatch calls with demand enqueue plus `drainAdmissionQueue()`. Preserve same-repo limits and budgets as demand constraints below the global ten-slot ceiling.

- [ ] **Step 7: Verify contention and commit**

```bash
node --test tests/linear-watch.test.mjs --test-name-pattern='capacity|admission|ledger|priority|handoff|refill'
node --test tests/linear-watch.test.mjs
git add scripts/linear-watch.mjs scripts/install-watch.sh tests/linear-watch.test.mjs
git commit -m "COD-128 enforce host-wide scheduled child capacity"
```

### Task 6: Persist queue telemetry and extend doctor

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Produces: `observations.json`, `firstObservedActionableAt`, queue wait, high-water, trigger, free-memory bytes, optional memory-pressure percentage, `metricsUnavailable`.

- [ ] **Step 1: Write failing observation-state tests**

Use a fake clock and temporary state directory. Assert first observation survives restart, capacity wait accumulates, becoming relation/label/claim blocked clears the observation, dry-run never writes, and seven-day unseen entries prune.

- [ ] **Step 2: Verify RED, implement atomic versioned observations, verify GREEN**

Observation key is source workspace + sweep + issue. Do not reset it on each drain pass or process start.

- [ ] **Step 3: Write failing sampler and run-record tests**

Assert `os.freemem()` maps to `freeMemoryBytes`, optional parsed `memory_pressure` maps to a separately named percentage, high-water and trigger are correct, and sampler failure records `metricsUnavailable` without changing child success.

- [ ] **Step 4: Implement one shared low-frequency sampler**

Start it when the first scheduled child is admitted and stop it when the last token releases. Extend optional run-record fields without breaking old JSONL readers.

- [ ] **Step 5: Extend doctor and health tests**

Human and JSON output include runtime resolution, current-tick failures, capacity active/max/high-water, malformed/stale ledger entries, queue p50/p90, dependency/capacity deferred counts, free-memory bytes, optional pressure percentage, and metrics gaps.

- [ ] **Step 6: Verify and commit**

```bash
node --test tests/linear-watch.test.mjs
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "COD-128 persist scheduler health and tuning evidence"
```

### Task 7: Finish operator documentation, configuration, and migration tests

**Files:**
- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `docs/linear-rules.md`
- Modify: `templates/linear-sweep.json`
- Modify: `tests/agents-snippet.test.mjs`
- Modify: `tests/install-watch.test.mjs`

**Interfaces:**
- Consumes: stable behavior and command output from Tasks 1-6.
- Produces: exact setup/upgrade instructions for all registered anchors and attended legacy audit.

- [ ] **Step 1: Write failing documentation assertions**

Require docs to state: exact `Done`, relation-only dependency gate, no mirrored `blocked:needs-user`, max ten top-level scheduled children, reviewer subagents excluded, runtime resolution order, health/doctor evidence, and 24-hour observation before tuning.

- [ ] **Step 2: Verify RED and update docs/templates**

Document the one-time dry-run audit for cards carrying both a current visible `blockedBy` relation and `blocked:needs-user`; require attended confirmation before label removal. Explain bounded cycle detection and cross-team token visibility limitations.

- [ ] **Step 3: Verify canonical copies and full suite**

```bash
node --test
git diff --check
```

- [ ] **Step 4: Commit**

```bash
git add README.md SETUP.md docs/linear-rules.md templates/linear-sweep.json tests
git commit -m "COD-128 document dependency and capacity operations"
```

### Task 8: Review, land, propagate to every registered repo, and verify the machine

**Files:**
- No uncommitted source changes expected.
- Operational targets: kit repo plus every path in `~/.config/linear-board-sweeps/registry.json`.

**Interfaces:**
- Consumes: complete branch, review skills, ship/land workflow, COD-116 dependency state.
- Produces: reviewed main commit, updated managed kit, updated canonical skill/rule copies in all registered anchors, healthy doctor and dry-run evidence.

- [ ] **Step 1: Run fresh local verification**

```bash
node --test
git diff --check
node scripts/linear-watch.mjs doctor --json
```

The local `doctor` may report the installed managed kit is behind until after landing; distinguish version drift from a functional failure.

- [ ] **Step 2: Run independent whole-branch review**

Use `/review` and the Subagent-Driven Development final code-reviewer against `git merge-base main HEAD..HEAD`. Fix every P0/P1 and all verified P2 findings, rerun focused tests, then rerun the full suite.

- [ ] **Step 3: Ship and land**

Use `/ship` to synchronize main, review the final diff, update `VERSION`/`CHANGELOG` only if required by that skill and repository convention, push the branch, and create the PR. Use `/land-and-deploy` to merge after required checks. This kit has no production app deploy; landing means merge/push to `main`.

Do not merge COD-128 before COD-116 unless the COD-116 implementation commit is already present in the COD-128 branch and the COD-116 Linear dependency has been resolved or explicitly superseded by the combined landing.

- [ ] **Step 4: Update the managed kit and all registered anchors**

```bash
./scripts/install-watch.sh
node "$HOME/.local/share/linear-board-sweeps/kit/scripts/linear-watch.mjs" list
node "$HOME/.local/share/linear-board-sweeps/kit/scripts/linear-watch.mjs" doctor --json
```

For each registry repo, verify:

```bash
test -f "$repo/.claude/skills/spec-sweep/SKILL.md"
test -f "$repo/.claude/skills/dev-sweep/SKILL.md"
test -f "$repo/.claude/skills/qa-sweep/SKILL.md"
test -f "$repo/.claude/skills/ship-sweep/SKILL.md"
test -f "$repo/.claude/skills/unblock-sweep/SKILL.md"
cmp skills/spec-sweep/SKILL.md "$repo/.claude/skills/spec-sweep/SKILL.md"
```

Also verify each anchor's AGENTS instructions contain the relation-only dependency rule and that propagation does not overwrite unrelated user changes.

- [ ] **Step 5: Run attended live checks**

```bash
node "$HOME/.local/share/linear-board-sweeps/kit/scripts/linear-watch.mjs" tick --dry-run
node "$HOME/.local/share/linear-board-sweeps/kit/scripts/linear-watch.mjs" health
```

Confirm SafeTaper reports only the first dependency-ready wave, missing runtimes create no claims, and capacity reports `active <= 10`. Run one attended real tick only if the board has safe non-Ship work and no Ship card; otherwise leave the first real tick to the normal schedule and report why.

- [ ] **Step 6: Perform the legacy relation-plus-label audit**

Generate a report across all three projects. Remove `blocked:needs-user` only with direct provenance that it merely mirrored a current relation and no later human request exists. Preserve ambiguous labels.

- [ ] **Step 7: Record final evidence**

Comment COD-128 with the landed commit/PR, test count, doctor result, dry-run result, anchor propagation hashes, and any preserved ambiguous labels. Move it through the board according to the direct human-approved ship outcome and leave no `sweep:manual-only` label once the normal pipeline owns it.

## Plan Self-Review

- Spec coverage: every reviewed requirement maps to Tasks 1-8; no adaptive throttling, polling reduction, or organization-wide cycle crawl was added.
- Placeholder scan: clean; every implementation and verification step is explicit.
- Type consistency: `WORKFLOW_STATES.done`, dependency result fields, typed dispatch outcomes, admission demand fields, and telemetry names are defined once and reused by later tasks.
- Sequencing: COD-116 merges first; dependency semantics precede launcher gating; runtime and admission state precede telemetry; docs follow stable behavior; landing precedes propagation.
- TDD: every production behavior begins with a focused failing test and an observed RED state before implementation.

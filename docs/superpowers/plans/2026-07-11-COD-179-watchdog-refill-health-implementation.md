# COD-179 Watchdog, Ship Refill, and Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound child runtime, prevent one child from holding a tick indefinitely, refill freed Ship workspace slots promptly, and expose stalls through health and doctor.

**Architecture:** Wrap dispatch in a stage-aware watchdog that uses existing abort and exact-claim reconciliation. Persist bounded child-liveness summaries in tick state, then make health and doctor evaluate that evidence instead of trusting process existence alone.

**Tech Stack:** Node.js ESM, child processes, `AbortController`, JSON state, `node:test`.

## Global Constraints

- Increment 1 must be green before this plan begins.
- Runtime bounds derive from `SWEEP_CFG[sweep].staleMin`.
- Terminate only the dispatched child, never unrelated agents or the tick process.
- Close claims only after exact owner plus declaration proof.
- Preserve verified resume work and genuine blockers.
- Ship remains one active child per source workspace.

---

### Task 1: Stage-aware dispatch watchdog

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Produces: `dispatchDeadlineMs(sweep) -> number` and outcomes `timeout-graceful` or `timeout-forced`.

- [ ] **Step 1: Write failing deadline and timeout tests**

```js
test("dispatchDeadlineMs derives finite stage deadlines", () => {
  for (const sweep of ["spec", "dev", "qa", "ship"]) {
    assert.equal(dispatchDeadlineMs(sweep), SWEEP_CFG[sweep].staleMin * 60_000);
  }
});

test("dispatchAsync force-terminates an expired child after grace", async () => {
  const signals = [];
  const result = await dispatchWithFakeClock({
    sweep: "ship", deadlineMs: 100, graceMs: 25,
    kill: (signal) => signals.push(signal),
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.kind, "timeout-forced");
});
```

Also test graceful close after `SIGTERM` and parent abort precedence.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='dispatchDeadlineMs|expired child' tests/linear-watch.test.mjs`

Expected: FAIL because deadline and timeout outcomes are absent.

- [ ] **Step 3: Implement the watchdog**

Inject timer functions into `dispatchAsync`. Arm after spawn, clear on every terminal path, send `SIGTERM`, then `SIGKILL` after a short fixed grace only if still open.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern='dispatchDeadlineMs|expired child|dispatch abort' tests/linear-watch.test.mjs`

Expected: all selected tests pass with no leaked timers.

- [ ] **Step 5: Commit**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "feat(COD-179): bound scheduled child runtime"
```

### Task 2: Reconcile expired children safely

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Consumes: timeout outcomes, Increment 1 reconciliation, exact cleanup, resume-store decisions.
- Produces: timeout failure, verified resume, or explicit cleanup failure.

- [ ] **Step 1: Write failing tests**

Cover: clean/pushed work releases exact epoch into cooldown; dirty/unpushed work creates a matching resume record; changed/ambiguous ownership performs no mutation.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='timeout reconciliation' tests/linear-watch.test.mjs`

Expected: FAIL because timeout kinds are unhandled.

- [ ] **Step 3: Extend reconciliation**

Route both timeout kinds through existing recovery decisions. Record kind, elapsed time, and issue identity without exposing claim tokens.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern='timeout reconciliation|terminal failure cooldown|resume-needed' tests/linear-watch.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "fix(COD-179): reconcile expired sweep children"
```

### Task 3: Refill Ship after reconciled terminal outcomes

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Consumes: reconciled result and `buildSameRepoRefillDispatches`.
- Produces: immediate workspace-local refill after `advanced` or legitimate `blocked`.

- [ ] **Step 1: Write failing orchestration tests**

Add one test where valid Ship completion admits the next Ship card before unrelated long-running work finishes, plus negative tests for no-op and timeout.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='Ship refill after reconciled|Ship refill rejects no-op' tests/linear-watch.test.mjs`

Expected: orchestration ordering fails.

- [ ] **Step 3: Gate existing refill on reconciled progress**

Pass the reconciled result to `buildSameRepoRefillDispatches`. Treat `advanced` and card-specific `blocked` as slot-freeing; reject no-op, timeout, ambiguous cleanup, and unresolved resume.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern='Ship refill|buildSameRepoRefillDispatches' tests/linear-watch.test.mjs`

Expected: all selected tests pass and one-Ship-per-workspace remains enforced.

- [ ] **Step 5: Commit**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "fix(COD-179): refill Ship after reconciled completion"
```

### Task 4: Bounded child-liveness telemetry

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Produces: `currentTick.telemetry.children[]` bounded summaries.

- [ ] **Step 1: Write failing telemetry tests**

Assert entries contain only issue, sweep, workspace, start/liveness timestamps, state, and outcome kind. Assert owner tokens, declarations, comments, prompts, and environments are absent. Assert recent terminal entries are capped.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='child liveness telemetry' tests/linear-watch.test.mjs`

Expected: FAIL because child telemetry is absent.

- [ ] **Step 3: Implement bounded updates**

Update tick state on start, verified liveness, timeout, and reconciliation using existing atomic writes. Keep active children plus a small fixed number of terminal summaries.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern='child liveness telemetry|atomicWriteJson' tests/linear-watch.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "feat(COD-179): record bounded child liveness"
```

### Task 5: Stall-aware health and doctor

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Consumes: child telemetry, observations, capacity, Ship runner state.
- Produces: expired-child health reasons and bounded doctor fields.

- [ ] **Step 1: Write failing report tests**

```js
test("healthStatus rejects a live tick with expired child evidence", () => {
  const status = healthStatus({
    currentTick: runningTickWithExpiredChild("COD-179"),
    lastTick: null,
    isAlive: () => true,
    now: NOW_MS,
  });
  assert.equal(status.ok, false);
  assert.match(status.reason, /expired child.*COD-179/i);
});
```

Add doctor assertions for `successfulNoOps`, `strandedClaims`, `oldestActionableShip`, and occupied Ship workspace slots.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='expired child|oldest actionable Ship|successfulNoOps' tests/linear-watch.test.mjs`

Expected: FAIL because current health trusts a live PID.

- [ ] **Step 3: Extend reports**

Evaluate child deadlines before declaring a tick healthy. Build doctor fields from local telemetry and observations; preserve existing JSON keys and avoid live Linear calls in `health`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern='healthStatus|doctorReport|expired child|oldest actionable Ship|successfulNoOps' tests/linear-watch.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "feat(COD-179): expose sweep stalls in health"
```

### Task 6: Full gate and guarded recovery

**Files:** Verify code; mutate Linear only through existing attended recovery commands.

- [ ] **Step 1: Run the complete code gate**

```bash
cmp -s .claude/skills/ship-sweep/SKILL.md skills/ship-sweep/SKILL.md
node --test tests/*.test.mjs
git diff --check
node scripts/linear-watch.mjs doctor --json
```

Expected: matching skills, zero failed tests, clean diff check, and new bounded diagnostics.

- [ ] **Step 2: Ensure no competing migration diagnostic runs**

Run: `ps -axo pid,command | rg '[c]laim-migration-status'`

Expected: no existing diagnostic. Stop only a diagnostic started by this work; never terminate the active launcher tick here.

- [ ] **Step 3: Run migration status read-only**

Run: `node scripts/linear-watch.mjs claim-migration-status --json`

Expected: complete JSON classification. Nonzero is acceptable only with exact attended work listed.

- [ ] **Step 4: Recover only exact safe classifications**

For `legacy-unowned`, run `claim-migration-reset <anchor> <Issue> <Claim> legacy`. For `orphan-declaration`, pass its exact declaration ID. Never reset `ambiguous`; inspect/correct its exact malformed or conflicting marker and rerun status.

- [ ] **Step 5: Preserve genuine blockers and retry**

Remove a blocker only when its machine comment proves the COD-179 self-claim/no-op defect and all current gates are valid. Leave SAF-250 and all test, dependency, QA, approval, security, deploy, and human blockers untouched. Retry through the normal launcher.

- [ ] **Step 6: Verify recovered outcomes**

For every retried issue, verify claim-close marker, downstream/Done state or legitimate blocker, merge/deploy evidence where applicable, and immediate workspace Ship refill. Record evidence on COD-179.


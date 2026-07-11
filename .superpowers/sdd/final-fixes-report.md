# COD-179 final fixes

## Scope

- Bound the watchdog after SIGKILL and return `timeout-termination-failed` with `CHILD_TERMINATION_UNCONFIRMED` and `cleanupUncertain: true` when termination is never confirmed.
- Bind primary and fallback dispatches to one absolute stage deadline; fallback receives only the remaining budget.
- Complete-read Linear claim history and accept heartbeat timestamps only for the exact open owner/declaration epoch; poll those observations into secret-free child `lastLivenessAt` telemetry without changing `startedAt` or the hard runtime deadline.
- Saturate successful no-op telemetry at named `MAX_SUCCESSFUL_NO_OP_COUNT`.
- Include active age and heartbeat/liveness age in expired-child health and doctor data/reason text.

## TDD record

RED:

```text
node --test --test-name-pattern='bounds a forced|shares the primary absolute|verified child heartbeat|verified heartbeat updates|successful no-op telemetry saturates|expired child evidence' tests/linear-watch.test.mjs
```

Failed at module load because the new bounded counter export did not exist. After the initial minimal implementation, the same focused command produced two expected behavioral failures: fallback did not launch under the test's first usage fixture, and the heartbeat fixture lacked the active claim label. Correcting the fixtures proved the intended missing behaviors rather than syntax errors.

GREEN:

```text
node --test --test-name-pattern='bounds a forced|shares the primary absolute|verified child heartbeat|verified heartbeat updates|successful no-op telemetry saturates|expired child evidence' tests/linear-watch.test.mjs
```

Result: 6 passed, 0 failed.

Additional focused heartbeat wiring check:

```text
node --test --test-name-pattern='heartbeat observation|bounds a forced|shares the primary absolute|successful no-op telemetry saturates|expired child evidence' tests/linear-watch.test.mjs
```

Result: 5 passed, 0 failed.

Launcher regression:

```text
node --test tests/linear-watch.test.mjs
```

Result: 442 passed, 0 failed (before the final observation-wiring test was added).

## Design and safety notes

- The existing complete-history `resolveCardClaim` authority is reused; raw or incomplete comments cannot update telemetry.
- Child telemetry remains projected through the existing fixed allowlist and contains no owner token, declaration ID, comments, prompt, environment, or API key.
- Heartbeats update only `lastLivenessAt`; child expiry remains based on immutable `startedAt` and `dispatchDeadlineMs(stage)`.
- Watchdog timers and heartbeat polling timers are cleared on every settlement/finally path; a late in-flight heartbeat read is prevented from recording after dispatch completion.
- Parent abort remains higher priority than timeout classification.

## Final verification

```text
node --test tests/*.test.mjs
```

Result: 687 passed, 0 failed, 0 skipped/cancelled/todo.

```text
git diff --check
```

Result: clean.

## Critical orphan-containment follow-up

The final review identified that an unconfirmed SIGKILL was typed but still flowed through ordinary admission cleanup. The follow-up adds a persisted `retainedOrphan` capacity state and makes `timeout-termination-failed` explicitly retain both the capacity reservation and exact Linear claim epoch. Refill, retry, handoff, and completion discovery are skipped. The launcher destroys its own stdout/stderr pipe handles and unrefs the child only after preserving the timeout evidence; the child PID remains the persisted authority.

RED:

```text
node --test --test-name-pattern='retains a proven live orphan|unconfirmed forced termination preserves|bounds a forced child' tests/linear-watch.test.mjs
```

Result: 3 failed at the intended seams: admission released capacity and called downstream discovery, claim reconciliation ignored the outcome, and dispatch did not mark/detach the orphan.

GREEN:

```text
node --test --test-name-pattern='retains a proven live orphan|unconfirmed forced termination preserves|bounds a forced child' tests/linear-watch.test.mjs
```

Result: 3 passed, 0 failed.

Launcher regression after containment:

```text
node --test tests/linear-watch.test.mjs
```

Result: 445 passed, 0 failed.

The fidelity test proves the admission promise/tick settles, no `beforeRelease` refill/handoff hook runs, the live orphan keeps the only capacity slot occupied, and reconciliation frees it only after the child PID is proven dead. The ledger's explicit token release remains the attended recovery seam.

Final full-suite result after this follow-up:

```text
node --test tests/*.test.mjs
```

Result: 689 passed, 0 failed, 0 skipped/cancelled/todo.

## Retention-persistence failure seam

Admission cleanup now treats `retainReservation: true` as an irreversible safety intent. If `reservation.retain()` returns false or throws, the admission promise rejects with that persistence failure, but `finally` never calls `release()` and therefore cannot delete the original live-child PID entry. Capacity remains fail-closed and replacement work is deferred.

RED:

```text
node --test --test-name-pattern='never releases a live orphan when retention persistence fails' tests/linear-watch.test.mjs
```

Result: failed because `release()` was called once after the retention error.

GREEN:

```text
node --test --test-name-pattern='retains a proven live orphan|never releases a live orphan when retention persistence fails|unconfirmed forced termination preserves|bounds a forced child' tests/linear-watch.test.mjs
```

Result: 4 passed, 0 failed. Both false-return and thrown-retain fixtures preserve the entry, reject with the persistence error, and admit no replacement.

Final full-suite result: 690 passed, 0 failed, 0 skipped/cancelled/todo.

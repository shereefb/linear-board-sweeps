# COD-91 tick failure Todo cards - implementation plan

## Goal

Make scheduled tick failures create/update a deduplicated Linear `Todo` card and clear that card once the failure recovers.

## Implementation Steps

1. Add pure failure helpers to `scripts/linear-watch.mjs`.
   - Define a `FailureEvent` shape in comments.
   - Add `failureFingerprint(event)`.
   - Add `sanitizeFailureMessage(message, envValues = [])`.
   - Add `failureTodoTitle(event)` and `failureTodoBody(event, fingerprint)`.
   - Add `failureTodoDecisions(currentFailures, existingTodos, checkedScopes, now)`.

2. Collect failure events in `tick()`.
   - Replace selected catch-site log-only paths with `recordFailure(...)` plus the existing log.
   - Cover missing key, project label query, fetchCards, label map, reaps, bounces, orphan reaps, auto-update, and dispatch start/exit.
   - Do not record a paused project as a failure when the project simply lacks the `auto-sweep` label.
   - For config-load failures that happen before project/api metadata is available, update local health status only; do not promise a Linear Todo.
   - Mark scopes that were actually checked so recovery does not over-close cards.

3. Add Linear Todo reconciliation helpers.
   - Query `Todo` cards for the configured project and team with marker `[auto-sweep-tick-failure`.
   - Create Todo cards using state `Todo`.
   - Comment on existing Todo cards.
   - Move recovered Todo cards to `Done`.
   - Add explicit workflow-state lookup and `issueUpdate(stateId)` support for `Todo` and `Done`.
   - Either export reusable issue/state helpers from `linear.mjs` or implement local helpers using the already-imported `gql()`. Do not claim `createCard()` is reusable until it is exported.

4. Execute reconciliation per anchor.
   - Only run when a usable API key and project config are present.
   - Reconcile after the cheap phase for that anchor.
   - Reconcile again after the selected `dispatch()` returns so runtime start/exit failures are not delayed until a later tick.
   - On reconciliation failure, log one `FATAL failure-todo` line and continue.

5. Extend local health for non-reportable failures.
   - Store whether the latest tick had anchor-level failures that could not be written to Linear.
   - Make `cmdHealth()` exit non-zero when the latest tick skipped anchors because config or credentials were unusable.
   - Keep a live tick lock as healthy, matching current behavior.

6. Update docs.
   - README: mention self-clearing Todo cards in the Triggering section.
   - `docs/linear-rules.md`: explicitly broaden `Todo` to include system-created operator action cards for scheduled launcher failures, while preserving the human-only action meaning for feature handoffs.

7. Add tests.
   - Same failure twice creates one create decision and then one no-op/update decision.
   - Changed normalized message updates an existing Todo.
   - Same unchanged message inside throttle window is a no-op.
   - Missing checked scope does not close an old Todo.
   - Checked scope with no current failure closes the old Todo.
   - Sanitizer redacts `lin_api_...` and supplied env values.
   - Paused projects are not failures.
   - Config/key failures make `health` non-zero even if the tick process completed.
   - Dispatch start/exit failures are reconciled after dispatch.
   - Duplicate manually-created Todo cards are handled deterministically.

## Verification

Run:

```bash
node --test
set -a && . ./.env && set +a && node scripts/linear-watch.mjs tick --dry-run
```

Manual live check after tests:

1. Point a registered test anchor at a bogus runtime command or harmless failing config.
2. Run one real `tick`.
3. Confirm exactly one Todo card appears.
4. Restore the config and run another real `tick`.
5. Confirm the Todo gets a recovery comment and moves to `Done`.

## Risks

- Linear write failures during failure reporting could hide the original problem. Mitigation: keep local logs as the fallback and never throw from reconciliation.
- Recovery closure could be wrong on partial ticks. Mitigation: close only scopes proven checked in that tick.
- Error messages could leak secrets. Mitigation: sanitizer plus tests for token patterns and env values.
- Treating paused projects as failures would create noise. Mitigation: paused projects are an explicit no-op branch.

## NOT in Scope

- Slack/email alerting.
- Hosted metrics UI.
- Recovery for invalid/missing API keys beyond local logs and `health`.

## What Already Exists

- `writeLog()` and `cmdHealth()` provide local operator signals.
- `linear.mjs` proves state and label lookup patterns, but its `createCard()` helper is private today.
- `Todo` semantics are documented in `docs/linear-rules.md`.
- `fetchCards()` already paginates Linear issue queries.

## Test Coverage Diagram

```
CODE PATHS                                      USER FLOWS
[+] failureFingerprint()                       [+] Repeated same failure
  +-- [GAP] stable same input -> same id          +-- [GAP] one Todo, no flood
  +-- [GAP] different target -> different id    [+] Failure recovers
[+] sanitizeFailureMessage()                     +-- [GAP] comment + Done
  +-- [GAP] Linear key redaction                [+] Linear reporting fails
  +-- [GAP] env value redaction                  +-- [GAP] local log only
[+] failureTodoDecisions()
  +-- [GAP] create missing
  +-- [GAP] update changed
  +-- [GAP] throttle unchanged
  +-- [GAP] close recovered only if checked
[+] postDispatchReconcile()
  +-- [GAP] runtime missing -> Todo
  +-- [GAP] runtime non-zero -> Todo
[+] healthStatus()
  +-- [GAP] config/key failure -> non-zero health
  +-- [GAP] paused project -> healthy no-op

COVERAGE TARGET: 14/14 planned paths.
```

## Failure Modes

- API key invalid: cannot write Todo, visible through `FATAL` log and `health`.
- Linear outage: reconciliation logs and retries next tick.
- Duplicate Todo manually created: reconciler picks the newest matching open card and comments on older duplicates with a pointer, or leaves a single Todo for manual cleanup.
- Human closes Todo while failure persists: next tick recreates because the fingerprint is still active.

## Worktree Parallelization

Sequential implementation. The change touches `scripts/linear-watch.mjs`, tests, and docs; splitting would create merge conflict risk without meaningful speedup.

## Implementation Tasks

- [ ] **T1 (P1, human: ~2h / CC: ~20min)** - launcher - Add pure failure fingerprint, sanitizer, and decision helpers.
  - Surfaced by: engineering review - flood prevention and recovery must be testable without Linear.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`
  - Verify: `node --test`
- [ ] **T2 (P1, human: ~3h / CC: ~30min)** - Linear IO - Add Todo query/create/comment/move helpers and execute reconciliation.
  - Surfaced by: architecture review - Todo cards are the durable operator queue.
  - Files: `scripts/linear-watch.mjs`
  - Verify: live failure/recovery check against a test anchor.
- [ ] **T3 (P2, human: ~45min / CC: ~10min)** - docs - Document failure Todo behavior and no-valid-key exception.
  - Surfaced by: DX review - operator needs exact action and recovery condition.
  - Files: `README.md`, `docs/linear-rules.md`
  - Verify: docs mention create/update/clear behavior.
- [ ] **T4 (P1, human: ~1h / CC: ~15min)** - health - Make config/key failures visible to `health`.
  - Surfaced by: adversarial review - current launcher writes `last-tick` even when anchors are skipped.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`
  - Verify: `node --test`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | Not required for operator recovery feature |
| Codex Review | independent read-only pass | Independent 2nd opinion | 1 | folded | 8 findings folded: paused projects, config/key health, post-dispatch reconcile, private helpers, Todo taxonomy, env redaction, duplicate tests |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | clear | Corrections folded: scope-checked recovery, pure decisions, sanitizer tests |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | No UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | clear | Operator action text and recovery condition folded |
| Security Review | `/cso` | Data/security gaps | 1 | clear | Redaction and no raw `.env` output required |

- **VERDICT:** ENG + DX + SECURITY CLEARED - ready to implement.
NO UNRESOLVED DECISIONS

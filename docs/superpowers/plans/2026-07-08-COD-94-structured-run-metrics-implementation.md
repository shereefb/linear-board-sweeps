# COD-94 structured sweep run metrics - implementation plan

## Goal

Write structured run records for scheduled sweep dispatches so retrospectives can answer duration, outcome, card, artifact, runtime, and unavailable-metric questions without scraping prose logs.

## Implementation Steps

1. Add run-record constants and pure helpers to `scripts/linear-watch.mjs`.
   - `RUNS_DIR = path.join(STATE_DIR, "runs")`.
   - `makeRunId(anchorSlug, sweep, now)`.
   - `runRecordPath(now)`.
   - `baseRunRecord({ ... })` with every schema key populated.
   - `sanitizeRunRecordValue(value, envValues = [])`.
   - `parseRunEvents(path, runId)`.
   - `finalizeRunRecord(base, events, result)`.
   - Export pure helpers for tests.

2. Update `dispatch()`.
   - Accept a `runRecord` or options object and an injectable spawn function for tests.
   - Create a per-run event path under the state dir.
   - Pass env vars:
     - `AUTO_SWEEP_RUN_ID`
     - `AUTO_SWEEP_RECORD_PATH`
     - `AUTO_SWEEP_ANCHOR_PATH`
     - `AUTO_SWEEP_SWEEP`
   - Track `dispatchStarted`, `startedAt`, `endedAt`, `durationMs`, and `exitCode`.
   - Finalize and append the record even if `spawnSync` returns `error`.

3. Add optional Linear/card enrichment.
   - Aggregate `claim`, `terminal-state`, `artifact`, `branch`, and `pr` event lines.
   - Resolve known issue identifiers to Linear ids before posting comments.
   - Re-query Linear for current state of claimed identifiers and write `terminalStates` from the API when possible.
   - If issue identifiers are known, post a compact `[auto-sweep-run-record <runId>]` comment to those cards.
   - If no issues are known, keep only the local run record.

4. Update sweep skill docs.
   - Add a small "Run record event" note to spec/dev/qa/ship skills telling agents to append JSONL events when env vars are present.
   - Keep it best-effort: failure to append metrics must not fail a sweep.

5. Update docs.
   - README: describe the run record path and fields.
   - COD-89 retrospective docs or README planned workflow list: mention COD-94 as planned instrumentation.

6. Add tests.
   - Schema completeness with all minimum fields present.
   - `tokenUsage`, `userInterruptions`, and `questionCounts` default to `unavailable`.
   - Spawn-start failure records `dispatchStarted:false`, `exitCode:127`.
   - Non-zero runtime exit records duration and exit code.
   - Malformed event lines are ignored.
   - Valid event lines aggregate claimed issues, terminal states, artifacts, branches, and PRs.
   - Agent-supplied event strings are redacted before storage/commenting.
   - Identifier-to-id lookup is required before card comments.
   - API terminal-state re-query augments or corrects agent-emitted state events.

## Verification

Run:

```bash
node --test
set -a && . ./.env && set +a && node scripts/linear-watch.mjs tick --dry-run
```

Manual live check after tests:

1. Run a scheduled dispatch against a harmless test card.
2. Inspect `~/.local/state/linear-board-sweeps/runs/YYYYMM.jsonl`.
3. Confirm the run record includes the configured runtime/model/effort and exit outcome.
4. Confirm a touched card gets at most one compact run-record comment.

## Risks

- Runtime token usage may remain unavailable. Mitigation: explicit `unavailable` value and future parser hook.
- Agent event writes could be malformed. Mitigation: ignore malformed lines and keep launcher-owned facts.
- Local-only records are not cross-host by themselves. Mitigation: issue comments mirror card-linked facts; cross-host warehouse remains out of scope.
- Structured records could accidentally collect secrets. Mitigation: never include raw logs; redact event string fields.
- Dispatch is currently private and hard-wired to `spawnSync`. Mitigation: add an exported pure finalize path and inject spawn behavior for tests.

## NOT in Scope

- Metrics dashboard.
- Exact token accounting across all runtimes.
- Cross-machine aggregation service.
- Committing run records to git.

## What Already Exists

- `dispatch()` has the exact process boundary needed to measure duration and exit.
- `buildCommand()` exposes runtime, model, effort, and anchor path.
- Local state/log directories already exist under `STATE_DIR`.
- COD-89 defined the retrospective fields that motivated this card.

## Test Coverage Diagram

```
CODE PATHS                                      USER FLOWS
[+] makeRunId()                                [+] Successful dispatch
  +-- [GAP] unique + stable-safe                 +-- [GAP] full final record
[+] baseRunRecord()                            [+] Runtime missing
  +-- [GAP] all required fields                  +-- [GAP] exit 127 record
[+] parseRunEvents()                           [+] Runtime exits non-zero
  +-- [GAP] claim/artifact/branch/pr             +-- [GAP] duration + exit record
  +-- [GAP] malformed ignored                  [+] Sweep appends artifacts
  +-- [GAP] string redaction                     +-- [GAP] artifacts in record
[+] finalizeRunRecord()                         +-- [GAP] artifacts in record
  +-- [GAP] unavailable defaults
  +-- [GAP] event aggregation
[+] resolveRunIssues()
  +-- [GAP] identifier -> issue id
  +-- [GAP] issue id -> current state

COVERAGE TARGET: 14/14 planned paths.
```

## Failure Modes

- `spawnSync` cannot start runtime: record with `dispatchStarted:false`, `exitCode:127`, and sanitized error summary.
- Runtime exits non-zero: record with `dispatchStarted:true`, non-zero `exitCode`, and no assumed terminal states.
- Event path missing: finalize with launcher-owned fields and empty arrays.
- JSONL write fails: log `FATAL run-record` locally and do not fail the sweep process retroactively.
- Linear state re-query fails: keep event-derived identifiers and mark terminal states unavailable rather than blocking finalization.

## Worktree Parallelization

Sequential implementation. The feature changes one launcher process boundary plus docs and tests.

## Implementation Tasks

- [ ] **T1 (P1, human: ~2h / CC: ~20min)** - launcher - Add run record schema helpers and JSONL writer.
  - Surfaced by: engineering review - launcher must own records even on runtime failure.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`
  - Verify: `node --test`
- [ ] **T2 (P1, human: ~2h / CC: ~20min)** - dispatch - Pass run-record env vars and finalize after process exit.
  - Surfaced by: COD-94 requirements - runtime/model/effort/duration/exit must be captured.
  - Files: `scripts/linear-watch.mjs`
  - Verify: manual live dispatch creates JSONL record.
- [ ] **T3 (P2, human: ~1h / CC: ~15min)** - sweeps/docs - Document best-effort agent event appends and run-record location.
  - Surfaced by: DX review - retrospective authors need a documented schema.
  - Files: `skills/*-sweep/SKILL.md`, `README.md`
  - Verify: docs include env var names and `unavailable` semantics.
- [ ] **T4 (P1, human: ~1.5h / CC: ~20min)** - Linear enrichment - Resolve identifiers, re-query terminal states, and post compact run comments.
  - Surfaced by: adversarial review - comment helper needs issue ids and terminal states cannot rely only on agent events.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`
  - Verify: `node --test`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | Not required for instrumentation follow-up |
| Codex Review | independent read-only pass | Independent 2nd opinion | 1 | folded | 4 findings folded: issue-id lookup, terminal-state re-query, dispatch test seam, event redaction tests |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | clear | Corrections folded: launcher-owned finalization, append-only JSONL, malformed-event tests |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | No UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | clear | Schema and unavailable-field documentation folded |
| Security Review | `/cso` | Data/security gaps | 1 | clear | No raw logs, local state only, redaction required |

- **VERDICT:** ENG + DX + SECURITY CLEARED - ready to implement.
NO UNRESOLVED DECISIONS

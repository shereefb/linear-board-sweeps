# COD-91 tick failure Todo cards - design

Linear card: COD-91

## Summary

Scheduled launcher failures currently surface in local logs and `health`, but the board does not get a durable action item. Add a failure reconciliation loop that creates or updates one Linear `Todo` card per active failure fingerprint, then resolves that Todo when a later tick proves the failure cleared.

This is for operator-visible failures in `scripts/linear-watch.mjs`: unreadable anchors after project metadata is available, Linear query failures after an API key is usable, auto-update failures, reaper/write failures, and runtime dispatch failures. A project that is intentionally not labeled `auto-sweep` is not a failure. If the config cannot be loaded or the Linear API key is missing/invalid, the launcher cannot reliably write to that project's Linear board; those cases must be reflected in local health status and logs rather than pretending a Todo can be created.

## Current Behavior

Relevant existing pieces:

- `writeLog()` writes local text logs under `~/.local/state/linear-board-sweeps/<anchor>/<sweep>/YYYYMMDD.log`.
- `cmdHealth()` reports stale ticks from `last-tick` and a live PID lock.
- `tick()` catches many per-anchor errors and keeps the global tick alive.
- `linear.mjs create-card` already knows how to create an issue in a named workflow state.
- `docs/linear-rules.md` defines `Todo` as the lane for human-only actions.

The missing behavior is reconciliation. The launcher can notice a failure, but it does not create a durable, deduplicated board item and does not close that item once the same failure is gone.

## Brainstormed Options

### Option A: Linear-backed failure reconciler (recommended)

Create a small failure registry inside `linear-watch.mjs`. Every observed failure becomes a normalized fingerprint. At the end of each anchor pass, the launcher reconciles fingerprints against Linear `Todo` cards carrying an `[auto-sweep-tick-failure <fingerprint>]` marker.

Completeness: 9/10. This keeps the operator workflow inside Linear, deduplicates naturally, and makes recovery visible. It does not solve the no-valid-key case because Linear cannot be written without a key.

### Option B: Local health only

Expand `health` and logs but do not create Linear cards.

Completeness: 4/10. It is simple, but it fails the card's main request. A dead scheduled runner still requires someone to check local state.

### Option C: One global Todo per tick failure

Create one Todo for any failing tick and append all failures to it.

Completeness: 6/10. It prevents floods, but it is hard to assign, clear, and reason about because unrelated anchors and causes share one card.

## Chosen Design

Implement Option A with deterministic fingerprints:

```
fingerprint input:
  anchorSlug | scope | failureKind | stableTarget

examples:
  linear-board-sweeps | config | missing-env | /path/to/anchor/.env
  linear-board-sweeps | spec | dispatch-start | codex
  linear-board-sweeps | _ | update | kit-fast-forward
```

The fingerprint is hashed or slugged for marker safety. The human title stays readable:

```
Scheduled sweep failure: <anchorSlug> / <scope> / <failureKind>
```

Each Todo description includes:

- What failed.
- Which anchor and project were affected.
- Last seen timestamp.
- First seen timestamp when known.
- Last error message, sanitized to avoid dumping secrets.
- How to clear it.
- The marker `[auto-sweep-tick-failure <fingerprint>]`.

Reconciliation rules:

1. During a tick, collect failures in memory instead of immediately creating cards at each catch site.
2. At the end of each anchor's cheap phase, query open `Todo` cards in the configured project whose description or recent comments contain `[auto-sweep-tick-failure`.
3. For every current failure fingerprint:
   - If a matching open Todo exists, update/comment only when the normalized message changed or at most once per day.
   - If none exists, create one in `Todo`.
4. For every existing failure Todo whose fingerprint was not observed during the current successful check:
   - Add a recovery comment with `[auto-sweep-tick-recovered <fingerprint> <ISO>]`.
   - Move the Todo to `Done`.
5. Never create duplicate Todo cards for the same fingerprint.
6. Never close a Todo for a scope the tick did not successfully check. If the launcher skipped a whole anchor before reaching reconciliation, leave its existing failure Todos open.
7. Run a second reconciliation after `dispatch()` for the selected anchor so runtime start/exit failures are reported in the same tick.

## Data Flow

```
tick()
  |
  +-- collect FailureEvent objects at catch sites
  |
  +-- per active anchor with usable API key
        |
        +-- query open Todo failure cards
        +-- create/update current failures
        +-- close recovered failures for checked scopes

  +-- selected dispatch
        |
        +-- collect runtime start/exit failures
        +-- reconcile those failures for the selected anchor
```

`FailureEvent` should be plain data so tests can cover it without Linear:

```
{
  anchorPath,
  anchorSlug,
  projectId,
  scope,        // "_", "spec", "dev", "qa", "ship", "update", "config"
  kind,         // "fetch", "dispatch-start", "dispatch-exit", "config", ...
  stableTarget, // state name, runtime command, file path, etc.
  message,
  seenAt
}
```

## Error Handling

- Sanitization: strip `lin_api_...`, common token prefixes, and values from `.env` before writing Linear comments.
- Linear reconciliation failure: write one local `FATAL failure-todo` log line and continue. Do not let failure reporting break the tick.
- Missing or invalid API key: cannot create a Todo. Record the anchor as unhealthy in `last-tick` or a companion health file so `linear-watch.mjs health` exits non-zero instead of reporting healthy after a skipped anchor.
- Paused project: not a failure. Do not create or close failure Todos for projects missing the `auto-sweep` project label.
- Flapping failures: update throttling prevents comment floods while preserving first seen and last seen.
- Deleted Todo: a still-active fingerprint recreates it.

## Schema & Architecture Impact

No application schema change. Architecture changes are planned in `scripts/linear-watch.mjs` only:

- Add pure helpers for fingerprinting, sanitizing, deduping, and reconciliation decisions.
- Add Linear helpers for finding, creating, commenting on, and moving failure Todo cards.
- Add tests in `tests/linear-watch.test.mjs`.

README and `docs/linear-rules.md` should document that scheduled-tick failures can create self-clearing Todo cards.

## Review Results

### Engineering Review

D1 - Where should failure state live?

Recommendation: Linear-backed Todo cards because the board is the operator's durable work queue.

A) Linear-backed Todo reconciliation (recommended). Completeness: 9/10. It creates one actionable item per failure and clears it when recovered. It is the smallest design that satisfies "do something about it" without inventing another dashboard.

B) Local health/logs only. Completeness: 4/10. It is easier to implement but leaves the user to poll local files.

C) One global Todo. Completeness: 6/10. It avoids flooding, but recovery and ownership become vague.

Net: pick A, with a documented no-valid-key exception.

Architecture review found one required correction: do not close recovered Todos unless that scope was actually checked in the current tick. Otherwise a partial tick could falsely mark a failure fixed.

Code quality review found two required corrections: keep reconciliation decisions pure, and do not claim `linear.mjs create-card` can be reused directly because the creation/state helpers are private today. IO should be a thin executor built on `gql()` or on newly exported helper functions.

Test review requires coverage for duplicate suppression, changed-message throttling, recovery moves, API-key-missing health behavior, manually duplicated Todo handling, post-dispatch failures, and sanitizer output.

Performance review found no hot-path issue. The Todo query must run only for active anchors with current or known open failure Todos, and it must paginate like `fetchCards()`.

### DX Review

Product type: CLI/operator workflow.

Persona: maintainer running the Mac mini sweep launcher across multiple repos. They expect `health`, logs, and Linear to agree.

Mode: DX TRIAGE because this is internal operator recovery, not a public developer product.

Scores after review:

| Dimension | Score |
| --- | ---: |
| Getting started | 8/10 |
| CLI/API design | 8/10 |
| Error messages | 9/10 |
| Documentation | 8/10 |
| Upgrade path | 8/10 |
| Dev environment | 8/10 |
| Community | 7/10 |
| DX measurement | 9/10 |

Devex correction folded: Todo comments must include exact operator action and exact recovery condition. "Tick failed" is not enough.

### Security Review

Security-sensitive data is limited to Linear API credentials, local paths, issue identifiers, and error messages. The implementation must never write raw environment values or command output containing secrets into Linear. Daily-mode CSO review found no blocker if sanitizer coverage is required.

Required security requirements:

- Redact Linear API keys and common token patterns from Todo descriptions/comments.
- Parse the full anchor `.env` and thread all values through the sanitizer; `anchorKey()` alone only exposes `LINEAR_API_KEY`.
- Do not include `.env` content in Linear.
- Do not make Linear failure cards public beyond the configured project.
- Treat Linear API write failures as local-only logs, not retry loops that may spam.

## Acceptance Criteria

- A scheduled tick with the same reproducible failure creates one `Todo` card, not many.
- Repeated ticks with the same failure update at most once per day unless the normalized error changes.
- A later successful tick comments recovery and moves the matching Todo to `Done`.
- A missing or invalid Linear API key does not attempt impossible Linear writes and remains visible via local logs/health.
- A paused project does not create a failure Todo.
- A runtime dispatch failure reconciles a Todo in the same tick.
- Error text written to Linear is redacted.
- `node --test` covers pure reconciliation behavior.

## Out of Scope

- A new hosted monitoring dashboard.
- Sending email, Slack, or push notifications.
- Retrying failed sweeps more aggressively.
- Solving failures when no usable Linear API key exists.

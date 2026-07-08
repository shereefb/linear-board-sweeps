# COD-94 structured sweep run metrics - design

Linear card: COD-94

## Summary

Add a structured run-record mechanism for scheduled sweeps so dogfood retrospectives can measure elapsed time, runtime/model choice, exit outcome, claimed cards, terminal states, created artifacts, and known unavailable fields without reconstructing everything from comments and text logs.

The launcher should write one JSON object per dispatched sweep run. The record is append-only, local to the scheduler host, and mirrored into issue comments for per-card evidence when the sweep touches cards. The runtime may not expose token usage or user-interruption counts, so those fields must be explicit `unavailable` values instead of omitted fields.

## Current Behavior

Relevant existing pieces:

- `dispatch()` wraps one foreground runtime invocation and logs start/end text lines.
- `buildCommand()` knows runtime, sweep, model, effort, and anchor path.
- `tick()` knows the selected sweep and actionable count.
- Sweep skills already create specs, branches, PRs, comments, and terminal state moves, but they do not emit machine-readable run summaries.
- COD-89 identified that local logs and card comments are useful but incomplete for retrospective measurement.

The missing behavior is a stable schema and writer that captures run-level facts in one parseable place.

## Brainstormed Options

### Option A: Launcher-owned JSONL run records plus optional card markers (recommended)

The launcher creates a run ID, writes start/end records to a JSONL file, passes `AUTO_SWEEP_RUN_ID` and `AUTO_SWEEP_RECORD_PATH` into the dispatched agent, and finalizes the record after the process exits. Sweeps can append artifact and issue events when available, but unavailable fields remain explicit.

Completeness: 9/10. It captures reliable launcher facts immediately and gives sweeps a path to enrich records without making all fields mandatory on day one.

### Option B: Parse text logs after the fact

Keep current logs and add a retrospective parser.

Completeness: 4/10. It is brittle and fails the "structured" requirement.

### Option C: Store all metrics only in Linear comments

Post one structured JSON block to each touched card.

Completeness: 7/10. It is durable per issue, but run-level data without a touched card is awkward, and comments are noisy for every scheduled pass.

## Chosen Design

Implement Option A with two sinks:

1. Canonical local JSONL:

```
~/.local/state/linear-board-sweeps/runs/YYYYMM.jsonl
```

2. Optional issue-linked marker comment when a run touches a card:

```
[auto-sweep-run-record <runId>]
summary: spec exited 0 in 123456ms
artifacts:
- docs/superpowers/specs/...
```

The local record schema uses stable keys:

```
{
  "schemaVersion": 1,
  "runId": "...",
  "anchorPath": "...",
  "projectId": "...",
  "sweep": "spec",
  "runtime": "codex",
  "model": "gpt-5.5",
  "reasoningEffort": "high",
  "startedAt": "...",
  "endedAt": "...",
  "durationMs": 123456,
  "exitCode": 0,
  "dispatchStarted": true,
  "claimedIssues": ["COD-91"],
  "terminalStates": [{"identifier":"COD-91","state":"Ready for Dev"}],
  "createdArtifacts": ["docs/superpowers/specs/..."],
  "branches": ["spec/COD-91-COD-94-docs"],
  "prs": [],
  "tokenUsage": "unavailable",
  "userInterruptions": "unavailable",
  "questionCounts": "unavailable"
}
```

`unavailable` is a value, not a missing key. Retrospectives can distinguish "not exposed by runtime" from "the writer forgot this field."

## Data Flow

```
selectDispatch()
  |
  +-- startRunRecord()
  |     writes initial record + env vars
  |
  +-- dispatch()
  |     runtime appends optional events or only text logs
  |
  +-- finalizeRunRecord()
        resolves issue identifiers to ids
        queries Linear for issue states when possible
        writes final record
        posts per-card marker comments when touched cards are known
```

The first implementation should avoid parsing arbitrary prose. It should gather reliable fields from:

- Launcher config: anchor, project, sweep, runtime, model, effort.
- Process result: start/end/duration/exit/dispatchStarted.
- Environment variables exposed to sweeps: run ID and record path.
- Optional structured event lines appended by sweeps or helper commands.
- Linear re-query after dispatch for terminal states when claimed issue identifiers are known. The launcher must resolve identifiers such as `COD-94` to Linear issue ids before it can call `addComment()`.

## Event Appends from Sweeps

Add a tiny helper contract rather than a new dependency:

```
AUTO_SWEEP_RECORD_PATH=/path/to/events.jsonl
AUTO_SWEEP_RUN_ID=...
```

If a sweep can report an artifact, branch, PR, or claimed issue, it appends JSONL event objects:

```
{"runId":"...","type":"artifact","path":"docs/..."}
{"runId":"...","type":"claim","identifier":"COD-94"}
{"runId":"...","type":"branch","name":"spec/COD-94-docs"}
```

The launcher ignores malformed event lines and logs a warning. It also sanitizes every string field from agent-supplied events before storing locally or mirroring to Linear. This keeps the runtime path best-effort and prevents metrics from breaking sweeps.

## Schema & Architecture Impact

No app database schema. Add a local structured artifact under the existing launcher state tree and an optional Linear comment marker. The implementation should update:

- `scripts/linear-watch.mjs` for run ID creation, file writes, env propagation, event aggregation, and finalization.
- Sweep skill docs so future scheduled agents append structured events where practical.
- README to document run records and retention.

## Review Results

### Engineering Review

D1 - Canonical metrics sink.

Recommendation: local JSONL plus optional card markers because it captures every dispatch while keeping issue comments useful and sparse.

A) Local JSONL plus card markers (recommended). Completeness: 9/10. It captures run-level facts even when no issue advances and links card-specific evidence when known.

B) Text-log parser. Completeness: 4/10. It does not create a reliable schema.

C) Linear comments only. Completeness: 7/10. It is visible, but noisy and poor for no-card failures.

Net: pick A, with explicit `unavailable` fields.

Architecture review correction folded: the launcher must own start/finalize so a crashed or failed runtime still produces a record. Agent-written events are enrichment only.

Code quality review correction folded: use append-only JSONL and pure aggregation helpers. Do not mutate a large JSON file in place.

Test review requires schema completeness tests, malformed event tests, event redaction tests, identifier-to-id resolution tests, terminal-state re-query tests, and dispatch-start failure tests.

Performance review found no hot path concern. JSONL appends are local and tiny; Linear card comments should only happen for touched issues.

### DX Review

Product type: CLI/operator instrumentation.

Persona: maintainer using retrospectives to tune sweep cost and cadence.

Mode: DX POLISH because the output is a developer/operator artifact consumed later.

Scores after review:

| Dimension | Score |
| --- | ---: |
| Getting started | 8/10 |
| API/CLI design | 9/10 |
| Error messages | 8/10 |
| Documentation | 8/10 |
| Upgrade path | 8/10 |
| Dev environment | 9/10 |
| Community | 7/10 |
| DX measurement | 10/10 |

Devex correction folded: the schema must document every field, including when a field is `unavailable`, so retrospective authors do not guess.

### Security Review

Run records include local paths, issue identifiers, branch names, PR links, model names, and possibly snippets of runtime output if future events include messages. They must not include raw prompts, `.env`, full logs, or API keys.

Required security requirements:

- Do not store raw runtime stdout/stderr in the structured record.
- Redact token-like values from any agent-supplied event string fields.
- Keep records in local state, not committed to the repo.
- If mirroring to card comments, include summaries and artifact paths only.

## Acceptance Criteria

- Every dispatched scheduled sweep writes a final structured JSON object even when the runtime exits non-zero.
- The object includes all minimum fields from COD-94, with `unavailable` where runtime data is not exposed.
- The launcher passes `AUTO_SWEEP_RUN_ID` and `AUTO_SWEEP_RECORD_PATH` to the runtime.
- Malformed agent event lines do not break dispatch finalization.
- Claimed issue identifiers are resolved to Linear ids before card comments are posted.
- Terminal states are re-read from Linear when issue identifiers are known; they do not depend only on agent-emitted `terminal-state` events.
- Touched-card comments are posted only when known issue identifiers exist.
- Tests cover schema completeness and failure paths.

## Out of Scope

- A hosted metrics dashboard.
- Exact token extraction for runtimes that do not expose usage.
- Cross-host aggregation service.
- Long-term warehouse/export pipeline.

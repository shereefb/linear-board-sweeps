# COD-89 dogfood retrospective - design

**Date:** 2026-07-08
**Status:** Ready for implementation after spec-sweep engineering review.
**Card:** COD-89, "Learn from the first few cards that were developed with the linear sweep"

## Problem

Cards COD-82 through COD-88, plus COD-90, are the first real dogfood run of this Linear sweep kit. The user wants the system to learn from that run: what worked, what did not, whether it wasted tokens or time, whether the 10-minute tick cadence leaves machines idle, and whether the user was interrupted too often.

The repo already has the technical pieces to inspect:

- The launcher claims it spends zero LLM tokens when idle and only dispatches when queues have actionable work (`README.md:54`, `README.md:57`).
- The launchd timer is documented as roughly every 10 minutes (`README.md:36`, `README.md:65`).
- The launcher dispatches at most one agent pass per tick today (`scripts/linear-watch.mjs:717`).
- Planned COD-82 work already questions that serial dispatch model and proposes bounded parallelism (`docs/superpowers/specs/2026-07-08-COD-82-bounded-parallel-dispatch-design.md:9`).

What is missing is a repeatable retrospective artifact that turns Linear comments, git history, local launcher logs, and produced specs/plans into a concise set of learnings and follow-up cards.

The current runtime evidence is incomplete. Launcher logs record dispatch start/end text and exit status (`scripts/linear-watch.mjs:606`, `scripts/linear-watch.mjs:613`), while `last-tick` stores only liveness plus kit marker (`scripts/linear-watch.mjs:715`). They do not durably capture model, sweep, card identifiers, run duration, token usage, user interruptions, or per-card outcome. The retrospective must name those gaps instead of pretending the data exists.

## Brainstormed approaches

1. **Recommended: one retrospective report plus follow-up Linear cards for actionable improvements.** This gives the owner a readable dogfood summary and converts concrete fixes into normal board work.
2. **Only add more metrics to the launcher.** Useful later, but it skips the immediate learning from cards 82-90.
3. **Only discuss in comments.** Fast, but the learning is scattered across many cards and cannot guide future sweeps.

## Design

Create a docs-only dogfood retrospective covering COD-82, COD-83, COD-84, COD-85, COD-86, COD-87, COD-88, and COD-90. The report should live under `docs/superpowers/reports/` or, if the project wants only specs/plans today, under `docs/superpowers/specs/` with a clear `dogfood-retro` filename. Prefer a report directory if implementation is willing to add it.

The report should answer these questions:

- What cards flowed smoothly through spec/dev/QA/ship, and which bounced or stalled?
- Which comments were useful audit trail, and which were noise?
- Did the "at most 3 spec cards" and "at most 2 dev cards" limits help quality or slow throughput?
- Did the 10-minute tick cadence leave the machine idle while work was available?
- Did the single foreground dispatch model create avoidable idle time? Relate this to COD-82 rather than duplicating it.
- Were there too many user-facing questions, or were questions properly routed to cards?
- Which skills were underspecified for Codex tool mapping?
- Which follow-up cards should exist, and which already exist?

Data sources:

- Linear issue data and comments for COD-82 through COD-90.
- Git commits and merges that mention those identifiers.
- Existing specs and plans in `docs/superpowers/specs/` and `docs/superpowers/plans/`.
- Local launcher logs under `~/.local/state/linear-board-sweeps` when present. These are best-effort and must not be required for the report to be useful.

The report should produce:

- A scorecard table by card.
- A short "what worked" section.
- A short "what hurt" section.
- Specific follow-up recommendations.
- Linear links or identifiers for follow-up cards. Create new `Needs Spec` or `Backlog` cards only for concrete product/engineering changes, not vague meta-improvement wishes.

The report should also define a future run-record shape for the launcher and sweeps. At minimum:

- `runId`, `anchorPath`, `projectId`, `sweep`, `runtime`, `model`, and `reasoningEffort`.
- `startedAt`, `endedAt`, `durationMs`, `exitCode`, and whether dispatch failed before the runtime started.
- Claimed issue identifiers, terminal issue states, and created artifact paths.
- Approximate token usage when the runtime exposes it, otherwise `unavailable`.
- User-interruption counts from card comments or runtime logs when observable, otherwise `unavailable`.

Implementing that instrumentation can be a follow-up card if it is too large for the retrospective itself, but COD-89 should leave the schema and recommendation behind.

## Engineering review

### Engineering decision D1 - report versus instrumentation first

The decision is whether to write the dogfood retrospective now or pause to add richer telemetry first. The risk is that waiting for perfect metrics loses the fresh qualitative signal from this first run.

Recommendation: write the report now from available evidence, and create separate follow-up cards for instrumentation gaps.

A) Evidence-based report now (recommended). Completeness: 8/10. It answers the user's immediate question and can still name missing measurements honestly.

B) Instrument launcher first. Completeness: 6/10. It improves future retrospectives but cannot reconstruct all first-run intent and friction.

C) Comments only. Completeness: 3/10. It leaves the learning scattered and hard to act on.

Net: capture what is knowable now, then turn measurement gaps into follow-up work.

### Engineering decision D2 - cadence recommendation

The decision is whether the retrospective should prescribe a new tick cadence immediately. The risk is changing cadence based on a small sample when COD-82 may already solve the larger idle-time issue through bounded dispatch.

Recommendation: analyze the observed idle time, but only recommend changing cadence if there is clear evidence that cadence, not serial dispatch, is the bottleneck.

A) Evidence-gated cadence recommendation (recommended). Completeness: 9/10. It separates timer delay from one-dispatch-per-tick throughput and avoids tuning the wrong knob.

B) Immediately shorten the timer. Completeness: 5/10. It may reduce delay but increases polling and could hide the need for better dispatch batching.

C) Leave cadence unexamined. Completeness: 4/10. It misses an explicit user question.

Net: answer the cadence question, but do not change the timer without evidence.

### Independent adversarial review

Premises to verify before implementation:

- README documents the 10-minute launcher timer and cheap idle behavior (`README.md:54`, `README.md:57`, `README.md:65`).
- `tick()` currently dispatches at most one agent pass (`scripts/linear-watch.mjs:717`).
- Launcher logs and `last-tick` do not currently contain structured duration, token, card, or interruption metrics (`scripts/linear-watch.mjs:606`, `scripts/linear-watch.mjs:613`, `scripts/linear-watch.mjs:715`).
- COD-82 already covers bounded parallel dispatch, so COD-89 should evaluate whether that plan addresses the observed idle-time problem rather than duplicating it.
- Existing specs/plans for COD-82 through COD-84 are present locally; later cards may need Linear/git lookup.

## Schema and architecture impact

No app schema change. This feature adds a new report artifact and may create follow-up Linear cards. README should list COD-89 as a planned workflow improvement until the retrospective lands. If implementation adds a `docs/superpowers/reports/` directory, future sweep docs should know that reports are allowed documentation artifacts, separate from specs and plans.

## Acceptance criteria

- A dogfood retrospective artifact covers COD-82, COD-83, COD-84, COD-85, COD-86, COD-87, COD-88, and COD-90.
- The report cites evidence from Linear, git history, existing docs, and local logs where available.
- The report explicitly answers token waste, elapsed time, idle machine time, 10-minute cadence, and user-interruption questions.
- Concrete improvement recommendations either point to existing Linear cards or create/link new cards.
- The report distinguishes "observed evidence" from inference.
- The report defines a structured future run-record schema and creates or links an instrumentation follow-up if current evidence is insufficient.
- No production code changes are included in the retrospective commit.

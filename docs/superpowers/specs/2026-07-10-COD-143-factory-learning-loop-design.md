# COD-143 Factory Learning Loop design

Linear: COD-143

## Summary

Add a self-improving Factory Learning Loop to the board-sweep launcher. One
orchestrator observes every registered workspace through three independently due
lenses: reliability, quality/rework, and throughput/cost. Deterministic detectors
qualify findings; bounded model-backed synthesis may group related evidence and
draft the desired outcome. High- and medium-confidence findings create or update
cards directly in `Spec`, allowing the existing Spec -> Dev -> QA -> Signoff
pipeline to implement and validate improvements automatically. A human still must
move every card into `Ship` before production merge or deploy.

The loop closes after shipping: it retains the finding baseline, measures the
declared post-change evaluation window, and records whether the improvement was
verified, ineffective, regressive, or inconclusive.

## Problem

The current factory is strong after a card exists. The launcher selects and claims
work, dispatches isolated sweep children, captures per-card run records, observes
queue waits and host capacity, records failure Todos, reaps stale work, and exposes
operator diagnostics. The four canonical sweeps then move a reviewed feature from
Spec to production behind a human Ship gate.

What it does not do continuously is decide which factory improvements deserve a
card. COD-89 produced an evidence-backed retrospective manually, but the launcher
does not aggregate repeated reviewer corrections, QA failures, bounces, runtime
errors, recovery failures, queue regressions, or recurring human questions into
actionable improvement work. Structured telemetry records what happened without
learning why the system struggled or measuring whether a shipped improvement
helped.

## Product outcome

The factory should identify recurring problems in its own operation, create
well-evidenced improvement cards, run those cards through the normal automation,
and measure the result without requiring a human to initiate each cycle.

A successful loop gives the operator:

- fewer repeated failures and repeated review findings;
- lower rework and queue delay over time;
- automatically maintained Linear cards instead of duplicate alert noise;
- an auditable explanation for why each card was admitted;
- measured outcomes for changes the factory proposed itself;
- the same explicit human boundary before shipping.

## Approved scope and invariants

This design intentionally includes the complete approved scope. Implementation
must not reduce it to one lens, one workspace, report-only output, or a manual card
gate.

1. One orchestrator owns three modular lenses: reliability, quality/rework, and
   throughput/cost.
2. The loop observes every workspace registered on the runner.
3. Workspace-local remedies route to the owning workspace and project. Shared
   launcher/sweep remedies route to a configured core Factory Learning project.
4. Deterministic code owns admission, confidence, fingerprinting, routing,
   idempotency, and Linear mutation. Model output is never trusted for these gates.
5. High- and medium-confidence findings automatically create or update cards in
   `Spec` without `sweep:manual-only`.
6. Auto-created cards start at the bottom of `Spec`; they do not silently outrank
   human-prioritized cards.
7. Cards continue through the existing automated pipeline and stop at `Signoff`.
   Only a human move to `Ship` authorizes merge/deploy.
8. Stable markers, cross-lens aggregation, occurrence identities, and lineage
   limits make retries and multiple hosts converge.
9. A shipped improvement retains its baseline and receives post-change outcome
   evaluation.
10. Learning work consumes spare host capacity and is lower priority than Ship,
    QA, Dev, and Spec.
11. Existing immediate incident and self-clearing Todo behavior remains intact.
    The learning loop identifies patterns and improvements, not current outages.

## Existing mechanisms to reuse

The implementation should extend the current boring mechanisms instead of adding
a service, database, queue, or daemon.

| Existing mechanism | Reuse |
| --- | --- |
| `normalizeRegistry()` and managed anchor records | Add global learning configuration and resolve the core anchor by registered identity. |
| Per-card `run-records-YYYYMMDD.jsonl` | Primary runtime, outcome, stage, queue, capacity, and host evidence. |
| `observations.json` and `createObservationStore()` | Queue baselines and sustained wait evidence. |
| Failure events, `failureFingerprint()`, and self-clearing Todos | Reliability signatures and immediate-incident separation. |
| Bounce, reaper, and owner heartbeat markers | Quality/rework and reliability occurrence evidence. |
| Capacity ledger and admission queue | Admit a low-priority learning child without bypassing the host ceiling. |
| Workspace config, repo routing, and managed repo maps | Route workspace-local findings to exactly one configured primary repo. |
| Linear helper functions in `linear-watch.mjs` / `linear.mjs` | Search, create, comment, label, relate, rank, and re-read findings. |
| `doctorReport()` / `formatDoctorReport()` | Surface lens state, coverage, pending findings, and evaluations. |
| Existing runtime configuration and executable preflight | Run synthesis with the configured cross-runtime mechanism. |

## Architecture

The learning loop is a launcher-owned observation and admission path, not a fifth
board sweep.

```text
registered workspaces
        |
        v
+-----------------------+
| evidence snapshot     |
| fixed capturedThrough |
+-----------------------+
  |          |          |
  v          v          v
reliability quality   throughput
  lens       lens       lens
  |          |          |
  +----------+----------+
             v
    finding aggregation
             |
             v
 deterministic admission
  low -> accumulate only
  med/high -> qualified
             |
             v
  retry-safe Linear writer
             |
             v
 Spec -> Dev -> QA -> Signoff -> [human] -> Ship -> Done
             ^                                      |
             |                                      v
             +----------- outcome evaluator <-------+
```

### Component boundaries

The first implementation remains inside the zero-dependency launcher module and
its tests, following the repository's existing large-module style. Pure helpers
are exported for tests. A later split is not required to ship COD-143.

1. **Learning configuration normalizer**
   - Normalizes registry-global scheduling and core routing.
   - Normalizes repo-local thresholds and enablement.
   - Rejects or disables mutation when core routing cannot be proven.

2. **Evidence snapshot builder**
   - Reads local JSON/JSONL state and bounded Linear audit metadata.
   - Uses one immutable `capturedThrough` cutoff per run.
   - Returns normalized evidence plus explicit coverage gaps.
   - Never exposes raw secrets, prompts, stdout, or arbitrary attachment bodies.

3. **Detector registry**
   - Versioned pure detectors consume normalized evidence.
   - Each detector declares a lens, scope, minimum sample, confidence rule,
     fingerprint inputs, and evaluation metric.
   - Detector code, not synthesis, decides whether evidence is low, medium, or
     high confidence.

4. **Finding aggregator**
   - Groups compatible detector findings by stable root-cause key.
   - Preserves every contributing detector and occurrence identifier.
   - May use bounded model synthesis only after deterministic candidates exist.
   - Falls back to deterministic card text if synthesis is unavailable.

5. **Admission and routing**
   - Requires recurrence or an explicitly severe invariant violation.
   - Requires an actionable configured repository and measurable desired outcome.
   - Routes local findings to the source workspace; routes shared findings to the
     configured core workspace.
   - Ranks qualified findings and admits no more than six new cards per learning
     run. Updates are unlimited.

6. **Linear writer**
   - Searches the live project for the stable marker before every mutation.
   - Re-reads matching cards immediately before update/create decisions.
   - Creates new cards at the bottom of `Spec` without `sweep:manual-only`.
   - Preserves human edits, labels, and live state on updates.

7. **Outcome evaluator**
   - Tracks Done finding cards through their declared evaluation window.
   - Compares post-change observations against the stored baseline.
   - Records one of four explicit outcomes and creates at most one next-generation
     follow-up when fresh evidence justifies it.

8. **Diagnostics**
   - Extends doctor JSON and human output with due state, sample coverage,
     accumulated findings, pending capacity, writes, detector errors, and active
     evaluations.

## Configuration

### Launcher registry

Learning is host/registry orchestration, so global enablement, core routing, and
child runtime live in the launcher registry rather than being duplicated per repo.

```json
{
  "learning": {
    "enabled": true,
    "coreSourceAnchor": "/source/path/to/linear-board-sweeps",
    "maxNewCardsPerRun": 6,
    "runtime": {
      "runtime": "codex",
      "model": "gpt-5.6-sol",
      "effort": "medium"
    }
  }
}
```

`coreSourceAnchor` must equal one registered source anchor after canonical path
resolution. The normalizer does not guess by basename. If it is missing or invalid,
workspace-local findings may still be evaluated and written locally; shared-core
findings remain pending with a diagnostic instead of being misfiled.

### Workspace `.claude/linear-sweep.json`

Repo-local configuration controls which lenses are enabled and permits explicit
threshold overrides while preserving safe defaults.

```json
{
  "learning": {
    "enabled": true,
    "lenses": {
      "reliability": { "enabled": true },
      "quality": { "enabled": true },
      "throughput": { "enabled": true }
    }
  }
}
```

The template documents defaults. Unknown detector keys fail configuration
validation for that detector only and appear in diagnostics. Existing configs with
no `learning` block remain valid and disabled until the operator opts in. This
feature will enable learning in this repository's own `.claude/linear-sweep.json`
for dogfooding.

## Durable state

Use a separate versioned local file:

```text
~/.local/state/linear-board-sweeps/learning-state.json
```

The state holds only bounded, structured metadata:

```json
{
  "version": 1,
  "lenses": {
    "reliability": {
      "lastSuccessfulCapturedThrough": "2026-07-10T00:00:00.000Z",
      "detectorVersions": {},
      "accumulated": {},
      "pending": {}
    }
  },
  "baselines": {},
  "evaluations": {}
}
```

Local state is an optimization and cursor, not proof of a Linear write. Linear's
stable card marker is the cross-host durable identity.

State writes use the existing atomic JSON write pattern. The evidence cursor
advances only after all qualified writes for that lens are either confirmed or
durably left pending. Linear unavailability never advances the cursor.

## Evidence contract

The snapshot normalizes evidence into bounded records:

```text
evidenceId          stable hash of source + source identity + timestamp
sourceWorkspace     canonical registered source anchor identity
projectId           configured Linear project
repoEntry           proven configured repository, when known
kind                run | failure | recovery | bounce | review | qa | question | queue
stage               spec | dev | qa | ship | launcher | learning
fingerprint         sanitized source-specific signature
occurredAt          ISO timestamp at or before capturedThrough
metrics             bounded numeric values
references          run/card/artifact identities, not raw content
coverage            complete | partial with named gaps
```

Raw card text and logs are untrusted. Parsers extract known audit markers and
bounded summaries. No evidence content may become a shell command, tool call,
runtime instruction, arbitrary URL fetch, or secret-bearing Linear comment.

## Finding contract

Every detector and aggregate emits a stable schema:

```text
schemaVersion
detectorId + detectorVersion
lenses[]
scope: workspace | core
sourceWorkspaces[]
projectId + repoEntry
fingerprint + rootFingerprint + generation
firstSeenAt + lastSeenAt
occurrenceIds[] + occurrenceCount
trend and baseline
impact + severity
confidence: low | medium | high
coverage gaps[]
evidence references[]
rootCauseHypothesis (explicitly a hypothesis)
desiredOutcome
acceptanceMetric
evaluationWindow
```

The stable card marker is:

```text
[factory-learning <detector-version> <root-fingerprint> generation=<n>]
```

Occurrence IDs appear in evidence-delta comments so a retry cannot add the same
observation twice.

## Initial detector set

### Reliability lens

| Detector | Qualification |
| --- | --- |
| `repeated-dispatch-failure/v1` | Same sanitized failure fingerprint twice in 24 hours or three times in seven days. |
| `stale-claim-pattern/v1` | Multiple reaps in the same stage/subsystem during the detector window. |
| `failed-recovery/v1` | A self-clearing failure Todo recurs after recovery or remains open after its recovery scope proves healthy. |
| `safety-invariant-violation/v1` | One proven mutation-before-preflight, duplicate-ship attempt, or equivalent invariant violation qualifies immediately at high confidence. |
| `poison-card-cluster/v1` | Multiple cards park or oscillate for the same machine-correctable reason. |

### Quality/rework lens

| Detector | Qualification |
| --- | --- |
| `repeated-review-finding/v1` | Same normalized finding category across at least three cards in 14 days. |
| `qa-rework-regression/v1` | `qa:needs-changes` rate materially exceeds its established baseline with at least eight eligible cards. |
| `spec-quality-failure/v1` | Multiple Dev -> Spec bounces share one missing requirement/design category. |
| `recurring-human-question/v1` | At least three cards request the same configuration or policy answer. |
| `red-canary-pattern/v1` | Related red canaries recur, or one proves a serious missing ship gate. |

### Throughput/cost lens

Throughput detectors require at least twenty relevant runs. They use a relative
regression plus an absolute floor so a small absolute change cannot qualify only
because its percentage is large.

| Detector | Qualification |
| --- | --- |
| `queue-delay-regression/v1` | Stage p90 wait exceeds both configured absolute floor and baseline regression for two consecutive windows. |
| `stage-duration-regression/v1` | Stage p90 duration regresses after controlling by available card/risk class evidence. |
| `nonproductive-run/v1` | Repeated successful process exits produce no useful state transition or artifact. |
| `capacity-saturation/v1` | Capacity deferrals and queue delay are both elevated. Delay alone never recommends capacity changes. |
| `review-overprocessing/v1` | A repeated low-risk class pays for costly review passes with no findings while safety floors remain satisfied. |

When token or billing data is unavailable, duration/model use is named a `cost
proxy`; findings never invent dollar savings.

## Confidence and admission

Confidence is detector-defined and testable:

- **High:** deterministic signature, complete or sufficient coverage, and proven
  ownership. Automatically create/update.
- **Medium:** repeated semantic cluster, sufficient evidence, measurable
  investigation target, and proven ownership. Automatically create/update.
- **Low:** retain and accumulate. Do not create a card.
- **Severe invariant:** one proven event may qualify as high confidence.

Before admission, a finding must also be actionable in a configured repository,
not represented by active work, and measurable after implementation.

New cards are ranked by severity, confidence, breadth, recurrence, and age. At
most six new cards are created per learning run. Qualified overflow stays pending.
Updates to existing cards are unlimited.

## Linear lifecycle

The writer searches by marker across the destination project before acting:

| Live match | Action |
| --- | --- |
| No match | Create at bottom of `Spec`, without `sweep:manual-only`. |
| Active Backlog/Spec/Dev/QA | Append only fresh evidence; preserve state and human fields. |
| Signoff/Ship | Append fresh evidence; never move or reclaim the card. |
| Done | Create one linked recurrence card with `generation=n+1` after fresh post-Done evidence qualifies. |
| Duplicate matches | Choose one deterministic primary, relate/mark duplicates for human audit, and never create another. |

Created cards include:

- observed pattern and fixed evidence window;
- affected runs/cards/workspaces and occurrence count;
- evidence references and named coverage gaps;
- confidence, severity, and contributing lenses;
- root-cause hypothesis clearly labeled as a hypothesis;
- desired outcome without prescribing an implementation;
- measurable acceptance criteria, baseline, and evaluation window;
- exclusions and safety constraints;
- stable provenance marker and `factory:learning-generated` label.

Setup must create `factory:learning-generated` when absent. Lens provenance remains
in the structured marker/card body rather than adding a label per detector.

## Routing

1. A finding tied to one workspace and one configured repo route is local. It is
   written to that workspace's team/project with the exact route label when routing
   is configured.
2. A finding tied to shared launcher/sweep behavior is core. It is written through
   the configured `coreSourceAnchor` project/repo.
3. Multiple workspaces may strengthen one core finding. Evidence stores only
   canonical workspace identities and bounded counts.
4. Ambiguous ownership produces one core diagnostic finding whose desired outcome
   is to establish ownership. The loop never sprays speculative cards into several
   projects.
5. Missing local route or missing core configuration keeps the finding pending and
   surfaces a doctor diagnostic. It does not guess.

## Scheduling and capacity

Every normal tick performs a zero-model due check after active anchors are resolved.
The check reads bounded lens state and evidence timestamps.

Default cadence:

- reliability: due daily when new failure/recovery evidence exists;
- quality: due weekly or after five newly terminal/returned cards;
- throughput: due weekly after at least twenty relevant new runs;
- outcome evaluations: due when an active evaluation window ends.

The learning child is a new admission demand class, not a `SWEEP_CFG` entry. It:

- counts against `capacity.maxActiveChildren`;
- has lower priority than Ship, QA, Dev, and Spec;
- consumes no same-repo sweep card slot;
- does not suppress or serialize ordinary workspace candidates;
- uses its own isolated log/temp paths;
- runs at most one active learning child per registry;
- remains pending when the host lacks spare capacity.

The deterministic collector and detectors run in the launcher process. Model-backed
synthesis, when needed, runs in the bounded learning child. This keeps an idle tick
cheap and prevents arbitrary evidence from controlling the parent process.

## Idempotency and concurrency

The mutation protocol is intentionally re-read based:

```text
candidate
  -> search stable marker
  -> fetch all matches
  -> choose deterministic live primary
  -> re-read primary immediately before mutation
  -> compare occurrence IDs
  -> create or append delta
  -> re-read to confirm marker/evidence
  -> advance durable cursor
```

Expected crash/race outcomes:

- create succeeds and local state write fails: the next run finds the marker;
- comment times out after success: occurrence IDs suppress a duplicate delta;
- two hosts race: both search and re-read, and duplicate reconciliation selects one
  primary if Linear's non-atomic create still permits two issues;
- a human changes state while analysis runs: the writer preserves the live state;
- a detector version changes: the root fingerprint remains stable while marker
  provenance records the new version;
- local state is corrupt: diagnostics go red, Linear evidence remains authoritative,
  and no cursor advances until state is repaired/rebuilt.

## Outcome evaluation and recursion control

When a generated improvement reaches Done, the evaluator records the shipped time,
baseline metric, evaluation window, and expected direction. At the end of the
window it appends exactly one outcome:

- `verified-improvement`;
- `no-measurable-change`;
- `regression`;
- `inconclusive-evidence`.

A no-change or regression result may qualify one linked `generation=n+1` card only
after fresh independent evidence satisfies a detector. One active card per root
fingerprint is allowed. A finding cannot generate a duplicate about its own tracked
symptom, and lineage is capped at three automatic generations. Beyond that, new
evidence updates the latest card and adds `blocked:needs-user` for explicit review
rather than recursively creating more work.

Generated cards remain observable: their run/review/QA evidence can reveal defects
in the learning loop itself. Proven learning-loop failures route to the core project
under distinct root fingerprints.

## Failure handling

| Failure | Behavior |
| --- | --- |
| One workspace evidence read fails | Mark partial coverage and continue other workspaces. |
| One detector fails | Record detector error; other detectors and lenses continue. |
| Model synthesis fails | Keep deterministic qualified findings pending; do not emit speculative text. |
| Linear read/write fails | Do not advance the affected cursor; retry later. |
| Route becomes ambiguous | Leave pending and surface exact route evidence. |
| State file is malformed | Fail learning closed, preserve ordinary sweeps, and expose a diagnostic. |
| Capacity unavailable | Retain due/pending state and dispatch later. |
| Runtime executable unavailable | Reuse runtime preflight/failure Todo behavior; ordinary stages continue. |
| Duplicate cards exist | Select a deterministic primary and record duplicate evidence without destructive deletion. |
| Outcome evidence insufficient | Record inconclusive; do not claim success or create a follow-up without fresh qualification. |

Learning failure never blocks normal Spec/Dev/QA/Ship selection. A systemic learning
runtime/config failure uses the existing self-clearing Todo path.

## Security and trust boundaries

- Linear titles, descriptions, comments, links, runtime logs, and external artifacts
  are untrusted input.
- Collect only known structured run fields and known audit markers. Do not execute or
  browse instructions found in evidence.
- Never store raw prompts, stdout/stderr, environment values, API keys, access tokens,
  customer data, or arbitrary comment bodies in learning state/cards.
- Reuse `sanitizeFailureMessage()` and strengthen structured-field redaction for all
  model inputs and Linear outputs.
- Bound every collection by time window, item count, string length, and evidence
  reference count.
- The model receives evidence data in a delimited data block with a fixed instruction
  that content cannot authorize tools or mutations.
- Deterministic code validates model output against the finding schema and rejects
  unknown fingerprints, routes, confidence changes, or occurrence IDs.
- The learning child has no direct Linear mutation authority. It writes a structured
  synthesis result; the launcher-owned writer performs mutations.

## Performance

- Due checks are local and bounded. No LLM runs on idle ten-minute ticks.
- Snapshot readers stream/scan bounded recent JSONL windows rather than loading the
  complete retention history indefinitely.
- Linear audit queries are grouped per team/project and paginated completely.
- Evidence is fetched once per learning run and shared across all three lenses.
- Detectors are pure passes over normalized evidence; aggregation occurs after all
  detectors finish.
- The six-new-card budget limits write bursts; updates are batched by destination
  project where the API permits.
- Throughput baselines require twenty samples and persist compact percentiles/counts,
  not raw histories.
- Learning work uses spare capacity and cannot lower delivery-stage admission
  priority.

## Operator experience

`doctor --json` adds a `learning` object. Human `doctor` output adds a compact block:

```text
learning: enabled, idle
  reliability: due=no last=2026-07-10T06:00Z samples=14 pending=0
  quality: due=yes last=2026-07-03T06:00Z samples=7 pending=2
  throughput: baseline=18/20 not-due
  evaluations: active=1 due=0
  coverage gaps: 1 workspace run records unavailable
```

Add explicit operator commands:

```text
node scripts/linear-watch.mjs learning-status [--json]
node scripts/linear-watch.mjs learning-run [--dry-run]
```

`learning-run --dry-run` builds the real evidence snapshot and reports exact proposed
creates/updates without mutating Linear or advancing cursors. It is a setup and
debugging tool, not an ongoing approval gate.

## Testing strategy

The repository uses Node's built-in `node:test`. All new decision behavior should be
implemented as exported pure helpers with fixture-driven unit tests, followed by
integration tests around temporary state directories and injected Linear/runtime IO.

### Required coverage

```text
CODE PATHS                                         OPERATOR / BOARD FLOWS
[ ] normalizeLearningRegistry()                    [ ] idle tick performs no model dispatch
  [ ] legacy registry defaults disabled              [ ] due lens waits behind delivery work
  [ ] valid core registered identity                 [ ] spare capacity admits learning child
  [ ] invalid core fails routing only                 [ ] dry-run proposes but does not mutate
[ ] buildLearningEvidenceSnapshot()                [ ] local finding creates routed Spec card
  [ ] fixed capturedThrough                          [ ] core finding aggregates workspaces
  [ ] bounded run/observation reads                  [ ] active match receives evidence delta
  [ ] partial/malformed source coverage              [ ] Done match creates one generation
  [ ] secret/untrusted-content redaction             [ ] concurrent writers converge/reconcile
[ ] detector registry                              [ ] human state/edits are preserved
  [ ] every initial detector below/at threshold      [ ] six-card admission budget defers overflow
  [ ] medium/high/low confidence                     [ ] Linear failure preserves cursor
  [ ] severe single-event qualification              [ ] outcome evaluation records four results
  [ ] twenty-sample throughput floor                 [ ] recursion stops at generation cap
[ ] aggregateLearningFindings()                    [ ] doctor/status exposes all lens state
  [ ] cross-lens root grouping                       [ ] normal sweeps survive learning failure
  [ ] occurrence dedupe
  [ ] stable fingerprint across prose/order/host
[ ] planLearningMutations()
  [ ] create/update/done/duplicate matrices
  [ ] local/core/ambiguous routing
  [ ] rank and six-create budget
[ ] outcome evaluator
  [ ] baseline/window comparison
  [ ] fresh-evidence follow-up gate

TARGET: every branch above has a behavior test, including IO failure and restart paths.
```

### Model synthesis evaluation

Synthesis is optional for correctness but affects card quality. Add deterministic
fixtures containing noisy, overlapping, hostile, and partial evidence. The eval
asserts that synthesis:

- never changes fingerprint, route, confidence, occurrence IDs, or admission;
- distinguishes observation from hypothesis;
- produces a desired outcome instead of prescribing unsupported implementation;
- retains acceptance metric, baseline, evaluation window, exclusions, and coverage
  gaps;
- emits valid schema or is rejected in favor of deterministic card text.

### Live dogfood verification

1. Run the complete test suite.
2. Run `learning-run --dry-run` against existing historical local state.
3. Enable learning for the Linear Sweep workspace and core anchor.
4. Run one live learning pass.
5. Confirm proposed medium/high findings create or update no more than six bottom-of-
   Spec cards without `sweep:manual-only`.
6. Confirm ordinary scheduled work remains higher priority and Ship remains human-only.

## Rollout

1. Ship the complete implementation disabled by default for existing workspace
   configs.
2. Enable all three lenses in this repository's config and registry for dogfooding.
3. Run one historical `--dry-run` as installation verification, then enable automatic
   writes immediately; there is no ongoing shadow period.
4. Throughput remains naturally dormant until its twenty-run baseline exists.
5. Review `doctor` and the first live generated/updated cards as QA evidence.
6. Preserve a reversible registry `learning.enabled=false` kill switch that disables
   new learning dispatch without affecting existing generated cards or normal sweeps.

## Alternatives considered

### Three independent scheduled agents

Rejected. Each would fetch overlapping evidence, compete for capacity, duplicate
root causes, and need its own retry-safe Linear writer.

### One monolithic retrospective prompt

Rejected. It would make admission non-reproducible, mix trust boundaries, and be
hard to test. Modular deterministic lenses keep behavior explicit.

### Report-only or Backlog-only findings

Rejected by the approved automation posture. Qualified medium/high findings enter
Spec automatically and rely on the existing review/QA/human-Ship boundaries.

### Public webhook or hosted analytics service

Rejected. The current launcher, registry, local state, and Linear API already provide
the required control plane. A new service would spend an innovation token without
improving the core outcome.

### Automatic configuration tuning

Rejected. A finding may propose a measurable experiment, but capacity/model/review
configuration changes must travel through the normal card pipeline. The observer
does not mutate the system it is measuring outside that audited path.

## NOT in scope

- A hosted metrics dashboard or cross-host data warehouse. Linear markers and
  idempotent writers provide convergence; diagnostics remain local per registry.
- Product/customer feedback, PostHog session replay, support, Stripe, or churn
  adapters. COD-143 improves the software factory itself.
- Removing the human Ship gate, auto-applying `ship:approved`, or autonomous deploy
  rollback.
- Direct automatic tuning of capacity, schedules, runtime models, review depth, or
  thresholds outside generated cards.
- Exact dollar cost claims when a runtime does not expose reliable token/billing
  data.
- A refactor that splits `linear-watch.mjs` into services solely for this feature.

## Review depth decision

**Initial tier: Tier 2 (material).** COD-143 changes scheduler admission, global and
repo-local configuration, local persistent state, cross-host Linear mutation,
concurrency/idempotency behavior, model trust boundaries, operator diagnostics, and
the source of automatically executed work. The likely implementation touches
`scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`, config templates, installed
instructions/skills, README/SETUP/linear rules, VERSION, and CHANGELOG. It introduces
no production app deploy, but a faulty implementation could create duplicate work,
starve delivery stages, leak untrusted evidence, or recursively generate cards.

Required reviews:

- Full engineering review of architecture and implementation plan in unattended
  prose mode, preserving the approved scope.
- Security review of untrusted evidence, model output validation, secrets, and
  mutation authority.
- Performance review of idle tick cost, bounded evidence scans, Linear query volume,
  and child-capacity priority.
- Independent code review after implementation plus the repository's ship review.

Design and implementation plan may become more concrete after code mapping, but the
final tier may not decrease.

## Acceptance criteria

- All three lenses run through one orchestrator and independent due rules.
- Every registered workspace contributes bounded, coverage-aware evidence.
- Deterministic code admits high/medium findings and retains low findings.
- Qualified findings automatically create/update bottom-of-Spec cards without
  `sweep:manual-only`, with exact local/core routing and stable provenance.
- Cross-lens and cross-host retries converge without silent evidence duplication.
- Generated cards stop at the existing Signoff/human Ship boundary.
- Outcome evaluation records verified, no-change, regression, or inconclusive results
  and obeys lineage/fresh-evidence limits.
- Learning uses spare bounded capacity and never suppresses delivery work.
- Learning failures do not break ordinary sweeps and are visible in diagnostics.
- `doctor` and explicit learning status/dry-run commands expose due state, coverage,
  pending findings, writes, errors, and evaluations.
- Tests cover every detector threshold, data branch, mutation matrix, failure mode,
  restart race, hostile-input boundary, and operator flow described above.
- The full existing and new test suite passes, live dry-run evidence is inspected,
  one dogfood live pass succeeds, and Linear evidence is attached to COD-143 before
  shipping.

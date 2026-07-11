# COD-158 Performance Contract design

## Summary

Add a versioned, risk-proportional `performance-contract/v1` to the board-sweep
workflow. A materially performance-sensitive feature will declare its workload,
resource or latency budget, measurement fixture, degradation behavior, and owner in
Spec; map every budget ID to an implementation task and benchmark proof in the plan;
execute those proofs in Dev; and consume the same IDs and evidence in QA.

This is a factory-level prevention mechanism. It does not bypass engineering review,
`/benchmark`, code review, QA, Signoff, or the human-only move into Ship.

## Evidence and problem statement

Factory Learning grouped three `review/performance` findings from three cards and
workspaces between 2026-07-10T17:57:42.221Z and
2026-07-10T23:51:40.501Z:

| Evidence | Card / workspace | Review correction |
| --- | --- | --- |
| `27f68f…c8c5` | SAF-220 / SafeTaper Guide | Disabled production Guide prefetch from landing calls to action. |
| `40286d…d51` | COD-148 / linear-board-sweeps | Added a 20-page active-window work cap and a one-page normal-path benchmark. |
| `729fb9…669e` | COD-146 / zomes_sdr | Added one operation-wide deadline across sequential reports, retries, and database work. |

The runtime surfaces differ. Their summaries support one bounded intervention: make cost
and stopping rules explicit before implementation. They do not prove one shared product
root cause, and Factory Learning correctly labels that premise as a hypothesis. Existing
review gates caught each omission after reviewers independently rediscovered the same
bounded-work principle.

The current workflow already says that performance-sensitive work cannot be Tier 0,
requires an engineering-review performance section, and runs `/benchmark` in Dev.
It does not preserve a stable, machine-readable-in-prose contract that links the
original budget to implementation and QA evidence. Fixture drift and unrelated green
benchmarks are preventative risks inferred from that missing trace, not observed facts
in the three source events.

## Repo scope

Owning repo: `linear-board-sweeps` only.

The implementation changes canonical sweep instructions and their installed copies in
this configured repo. The three contributor workspaces are evidence sources, not
implementation repositories. The existing updater distributes changed skill bytes to
registered anchors. No sibling repository, application code, database, or production
target is part of COD-158.

Shipping is merge/push to `main`. There is no application deploy. Any external release
or distribution action remains attended or becomes a linked Todo under the configured
deploy policy.

## Goals

- Make performance applicability explicit before review: `required` or `not required`
  with a concrete rationale.
- Give every material budget or bound a stable `P1..Pn` identity.
- Preserve the same workload, fixture, threshold, and failure semantics through Spec,
  plan, Dev benchmark evidence, and QA.
- Catch hidden fan-out, prefetch, pagination, retry, deadline, memory, and cache work
  before implementation when it is predictable from the design.
- Fail closed when a required contract or proof is missing without turning every card
  into performance paperwork.
- Keep generated learning cards in the full QA, Signoff, and human Ship path.
- Sample early post-rollout required contracts for complete per-`P` evidence before
  relying on the 14-day Factory Learning outcome.

## Non-goals

- Changing `repeated-review-finding/v1`, its category-level clustering, thresholds, or
  Factory Learning card identity.
- Suppressing or relabeling valid `review/performance` evidence.
- Inventing universal latency numbers, benchmark tools, or production SLOs across
  unrelated repositories.
- Replacing `/plan-eng-review`, `/benchmark`, code review, or user-facing QA.
- Adding runtime telemetry, a benchmark result database, CI infrastructure, or a new
  artifact format.
- Editing the three evidence-source repositories directly.

## What already exists

- `skills/spec-sweep/SKILL.md` and its installed copy make actual performance-sensitive
  work non-Tier-0, require the selected engineering pass to cover performance, and
  require downstream benchmark work.
- `skills/dev-sweep/SKILL.md` and its installed copy run `/benchmark` for a
  performance-sensitive card before QA handoff.
- `skills/qa-sweep/SKILL.md` and its installed copy consume the engineering-review test
  plan, exercise the running feature, and refuse `qa:passed` when evidence is not green.
- `tests/spec-sweep-doc.test.mjs` protects the existing performance safety floor.
- `refreshAnchorSkills()` and `tests/updater.integration.test.mjs` already distribute
  canonical skills through the version marker.
- COD-155 has a merged design for `correctness-contract/v1`. If its implementation
  lands before COD-158, the performance contract must compose with it rather than
  replace or duplicate its invariant/proof tables.

COD-158 reuses these mechanisms. It adds a traceable contract, not another review
framework or benchmark runner.

## Approaches considered

### A. Cross-stage performance contract (recommended)

Add a small versioned declaration to Spec and carry stable budget IDs into the plan,
Dev benchmark, and QA evidence.

Pros: prevents the observed class at the earliest stage; reuses current review and
benchmark gates; preserves evidence honesty; works across runtimes and repositories.

Cons: changes six mirrored skill files and requires a release marker so installed
anchors receive the behavior.

### B. Refine Factory Learning clustering

Split `review/performance` by free-text summary or a new finding key.

Pros: creates narrower learning cards.

Cons: does not prevent any of the three omissions; free-text identity is unstable;
requiring a new event key would change runtime evidence, legacy evaluation, and card
identity; it discards the useful shared bounded-work signal.

### C. Keep current review and benchmark prose

Treat the three findings as proof the existing gates already work.

Pros: no implementation change.

Cons: reviewers keep rediscovering the same missing premise, and later stages still
have no stable link between the design budget and benchmark evidence.

Decision: choose A. It is the smallest change that prevents recurrence without
weakening or rewriting Factory Learning.

## Contract applicability

Every new spec and plan audit declares exactly one of:

```text
Performance contract: performance-contract/v1 — required — <rationale>
Performance contract: performance-contract/v1 — not required — <rationale>
```

`required` applies when the proposed behavior materially changes or depends on latency,
throughput, memory, payload size, query count, network or storage fan-out, pagination,
retry/deadline work, caching, prefetch, background work, or a user-visible performance
failure mode. A domain label is a candidate signal, not proof; the actual surface wins.

`not required` needs a concrete statement that the implementation has no material
performance-sensitive path. Pure documentation and process-text changes normally
qualify. A reviewer who finds a material budget on a proposed Tier 0 card escalates it
to at least Tier 1 and changes the declaration to `required`.

If an owner-only product budget is required but unavailable, spec-sweep follows its
normal single-comment `blocked:open-questions` path. It must not fabricate a threshold.

## Performance contract

A required spec adds this table before selected review:

| ID | Workload / critical path | Proof kind | Budget or hard bound | Measurement / fixture | Degradation / abort behavior | Owner / observation |
| --- | --- | --- | --- | --- | --- | --- |
| `P1..Pn` | The user or system action whose cost matters | `measured` or `deterministic-bound` | An explicit latency/resource target or deterministic maximum-work bound | A reproducible input, environment assumptions, command or measurement method, and statistic when measured | What stops, degrades, skips, or remains usable when the bound is reached | The component that enforces the bound and the evidence a reviewer or operator can observe |

Rules:

1. Include only material rows. Do not create ceremonial rows for inapplicable cache,
   database, or memory dimensions.
2. Use a hard work bound when wall-clock results are too environment-dependent. Examples
   include maximum pages, attempts, requests, items, bytes, or one operation-wide
   deadline.
3. A latency or throughput threshold must name its representative fixture and statistic;
   a bare claim such as "fast" or "no regression" is not a contract.
4. Hidden work is work: eager prefetch, retries, fan-out, cache fill, and background jobs
   count even when the primary UI responds earlier.
5. The failure side is part of performance correctness. State what the user or caller
   receives at the bound and who owns cleanup, partial progress, retry, or fallback.
6. A contract may reuse a correctness invariant from `correctness-contract/v1`, but the
   performance budget keeps its own `P` ID so benchmark evidence stays traceable.
7. Proof shapes are closed. `measured` records environment, baseline, candidate,
   statistic, threshold, and result. `deterministic-bound` records the declared bound,
   test/assertion command, observed maximum or result, and pass/fail. Neither form
   fabricates fields from the other.

## Cross-stage flow

```text
card + code evidence
        |
        v
Spec: applicability + P1..Pn budgets
        |
        v
engineering review: challenge hidden work, bound, fixture, and failure semantics
        |
        v
Plan: P ID -> task -> benchmark command/fixture -> threshold -> QA observation
        |
        v
Dev: implement + run /benchmark + record actual result for every P ID
        |
        v
QA: reproduce declared public behavior and consume/re-run benchmark evidence
        |
        v
Signoff -> human Ship -> Done -> Factory Learning evaluation
```

### Spec responsibilities

- Decide applicability from the material surface, not labels alone.
- Define the budget and stopping behavior before the selected engineering review.
- Require the engineering review's performance section to challenge every `P` row,
  including hidden work and environment-sensitive measurement.
- Record every accepted review decision and correction in unattended prose mode.

### Plan responsibilities

For `performance-contract/v1 — required`, add a `Performance traceability` table:

| ID | Proof kind | Implementing task(s) | Proof command / fixture | Expected evidence and pass condition | QA observation | Residual risk |
| --- | --- | --- | --- | --- | --- | --- |

Each `P` ID needs a deterministic proof. The plan may use the repository's existing
benchmark suite, focused instrumentation, or a bounded-work assertion. It must name the
exact command and expected comparison. Manual QA alone cannot prove query counts,
fan-out, memory ceilings, retry budgets, or other low-level limits.

### Dev responsibilities

- Reject a required contract with missing rows or traceability as `missing-design` and
  return the card to Spec through the existing bounce path.
- Map every `P` ID to the actual diff and declared proof before broad verification.
- Run `/benchmark` on the actual worktree using the declared fixture. For `measured`,
  record relevant runtime/hardware or service assumptions, warm-up and repetition
  policy, baseline, candidate, statistic, threshold, and result. For
  `deterministic-bound`, record the declared bound, assertion command, observed maximum
  or result, and pass/fail.
- Bind the handoff to the tested commit SHA. For every `P` ID record the SHA, command,
  bounded output or result location, environment fingerprint or relevant assumptions,
  proof kind, and result in a durable Linear comment and the pushed branch history.
- Fix implementation failures in Dev. If the work exposes a missing budget, invalid
  fixture, or contract defect, emit `review/performance` and bounce to Spec rather than
  hiding design discovery as an ordinary implementation fix.
- Keep both existing code-review passes unchanged.

### QA responsibilities

- Use `P` IDs and the plan's `QA observation` entries as primary test input beside the
  engineering-review test plan.
- Re-run the declared proof when the QA worktree can reproduce its stated environment.
  Otherwise prove the cited Dev SHA is the tested commit or an ancestor with no changes
  to the affected performance path, cite the durable handoff evidence, explain why
  reproduction is unsafe or invalid, and exercise the nearest public outcome and bound
  behavior. A QA fix touching a `P` path invalidates prior evidence and requires a rerun
  or return to Dev.
- Do not claim manual proof for a low-level limit that a user cannot reliably induce.
- A required contract with an unproven `P` ID, a threshold miss, or contradictory
  fixture/result cannot receive `qa:passed`.

## Failure handling and compatibility

- Existing pre-rollout specs without the declaration continue through the established
  quality gate only when their artifact history proves they predate the installed
  release boundary. New or incomparable artifacts fail closed. If COD-158 lands first,
  it installs the shared artifact-introduction-versus-`.sweep-version` decision. If
  COD-155 is already present, COD-158 extends that single gate. In either ordering, later
  work preserves one decision and applies it to every absent versioned contract; no
  contract-specific history algorithm may overwrite another contract's handling.
- A `not required` declaration that contradicts the actual plan or diff becomes
  `missing-design`, not an excuse to skip `/benchmark`.
- A benchmark environment mismatch is explicit evidence, not an automatic pass or fail.
  QA either reproduces the declared setup or cites the Dev result and tests the closest
  observable behavior with the limitation recorded.
- A threshold failure remains visible. Dev fixes it or returns to Spec if the budget or
  measurement contract itself is wrong.
- Rollback is a normal revert of skill text, tests, version, and docs. No persisted state
  or production migration exists.

## Correctness contract

`Correctness contract: correctness-contract/v1 — required` because COD-158 changes
cross-stage workflow behavior and fail-closed handoff rules.

| ID | Trigger / transition | Required invariant | Forbidden outcome | Recovery / ownership | Verification |
| --- | --- | --- | --- | --- | --- |
| `C1` | Spec classifies a card | Material performance work receives `required` regardless of labels; non-material work can remain `not required` with evidence. | Label-only ceremony or a false exemption skips the performance gate. | Spec owns correction before terminal review. | Documentation tests lock both canonical applicability instructions and Tier 0 escalation; reviewers validate classification on actual cards. |
| `C2` | Plan hands work to Dev | Every `P` ID chooses `measured` or `deterministic-bound` and maps to an implementing task, proof command, pass condition, QA observation, and residual risk. | A generic benchmark or incompatible evidence fields substitute for the declared critical path. | Terminal spec gate rejects incomplete traceability. | Cross-stage documentation test asserts both closed shapes and required ordering. |
| `C3` | Dev produces proof evidence | Evidence is bound to the tested SHA and uses the declared fixture; measured and deterministic forms expose only their required fields. | A green unrelated benchmark, stale commit, or fabricated field reports success. | Dev reruns invalidated proof; contract defects emit `review/performance` and bounce. | Skill contract tests lock handoff requirements; a sampled rollout audit checks real comments against pushed SHAs. |
| `C4` | QA decides `qa:passed` | Every required `P` ID has credible SHA-bound evidence and the closest public outcome is exercised; affected-path fixes invalidate old proof. | QA invents manual coverage or passes missing, stale, contradicted, or failed proof. | QA reruns, returns to Dev, or keeps the card in QA with exact evidence. | QA instruction test plus sampled rollout audit. |
| `C5` | Kit release reaches anchors | Canonical and installed Spec/Dev/QA skill copies match and the version marker causes updater propagation. | Only this repo learns the contract while contributor anchors keep old instructions. | Existing updater retry/doctor/Todo paths own installation failures. | Byte-equality tests, old-marker updater fixture, version and README checks. |

## Review depth decision

- **Predicted footprint:** `skills/{spec,dev,qa}-sweep/SKILL.md`, their three
  `.claude/skills` copies, one focused performance-contract documentation test,
  `tests/updater.integration.test.mjs`, `VERSION`, `CHANGELOG.md`, and `README.md`;
  eleven physical files, approximately 130-200 changed lines. The skill pairs are three
  required byte-identical logical artifacts.
- **Behavior/state/interface changes:** cross-runtime agent workflow and handoff evidence
  change across Spec, Dev, and QA. No application runtime, persisted schema, dependency,
  database, API, deploy, or production data changes.
- **Risk surfaces:** checklist ceremony, fabricated thresholds, benchmark-fixture drift,
  legacy compatibility, hidden performance evidence, and distribution drift. No material
  auth, secret, external-input, destructive-operation, accessibility, concurrency, or
  runtime performance hot path is introduced by the docs-only implementation.
- **Initial tier:** Tier 1 — Bounded, targeting the spec pass. The physical file count is
  inflated by required mirrors and release artifacts. The change follows the established
  correctness-contract pattern, but applicability and proof semantics need premise review
  before the implementation plan is fixed.
- **Selected reviews:** one engineering spec review plus one independent adversarial spec
  reviewer. Both must trace reuse claims to current files and COD-155's merged artifacts.
- **Specialized lenses:** performance label is a candidate, but `/benchmark` is skipped for
  this docs-only implementation because it changes no runtime hot path. The engineering
  review still covers the contract's downstream benchmark semantics. UI/design skipped
  (no interface); DevEx skipped (no public API/CLI/SDK adoption flow); security skipped
  (no auth, secret, data, or external-input boundary); research skipped (all evidence and
  mechanisms are local).

## Unattended engineering-review decisions

### D1. Contract shape

ELI10: a benchmark can be green while measuring the wrong thing. Stable budget IDs keep
the original promise attached to the exact proof that is supposed to verify it.

**A. Applicability declaration plus `P1..Pn` budget and traceability tables
(recommended). Completeness: 10/10.** This covers early design, execution proof, and QA
without creating a runtime schema.

**B. Add a free-form performance paragraph. Completeness: 6/10.** It is lighter, but
later stages cannot prove they measured the same workload or threshold.

**C. Add only a benchmark checkbox in Dev. Completeness: 3/10.** It preserves the late
gate that already produced the evidence and does not prevent the design omission.

Decision: adopt A.

### D2. Legacy rollout composition

ELI10: two new contracts should not make Dev answer the same "is this old work?" question
twice with subtly different rules. One history decision should govern both declarations.

**A. Reuse one shared artifact-introduction-versus-installed-version decision
(recommended). Completeness: 10/10.** This composes with COD-155, avoids drift, and keeps
new or incomparable work fail-closed.

**B. Add a performance-specific legacy check. Completeness: 6/10.** It can work alone but
duplicates a fragile git-history rule and may disagree with correctness applicability.

**C. Require the performance declaration retroactively on every artifact. Completeness:
5/10.** It is simple but creates unnecessary rewrites and bounces for proven old work.

Decision: adopt A in both orderings. COD-158 installs the shared decision if first and
extends it if COD-155 is already present.

### D3. Comparable benchmark evidence

ELI10: two numbers are not comparable if one used a cold laptop and the other used a warm
CI runner. The handoff needs enough setup detail to explain why the comparison is valid.

**A. Record command, fixture, relevant environment, warm-up/repetitions, statistic,
threshold, results, and tested SHA for measured proofs; use bound/assertion/result/SHA for
deterministic proofs (recommended). Completeness: 10/10.** The closed shapes stay
comparable without inventing meaningless baseline fields or a result database.

**B. Record only baseline and candidate numbers. Completeness: 5/10.** It is concise but
cannot diagnose noise, fixture drift, or environment mismatch.

**C. Store a new structured benchmark artifact in launcher state. Completeness: 8/10.**
It is machine-readable but expands COD-158 into runtime persistence and migration work
that the prevention goal does not require.

Decision: adopt A; keep the evidence in the existing plan and handoff artifacts.

### D4. Threshold policy

ELI10: one magic latency number cannot fit a landing page, a paginated API, and a cron
job. The contract must demand a real bound without inventing the owner's product budget.

**A. Feature-specific measured threshold or deterministic maximum-work bound
(recommended). Completeness: 10/10.** It handles both noisy wall-clock measurements and
exact pagination/retry/fan-out limits.

**B. Universal percentage non-regression threshold. Completeness: 5/10.** It is easy to
state but breaks on noisy or previously unbounded paths and can bless a bad baseline.

**C. Reviewer judgment without a threshold. Completeness: 3/10.** It cannot produce a
repeatable pass/fail handoff.

Decision: adopt A. Owner-only missing product budgets use the existing question path.

### D5. QA proof posture

ELI10: QA should not fake a low-level measurement by clicking, but it also should not
rerun a benchmark in a different environment and call the incomparable number a failure.

**A. Reproduce when valid; otherwise verify the exact Dev artifact and closest public
outcome with the limitation recorded (recommended). Completeness: 10/10.** This is honest
about evidence while keeping user-visible QA mandatory.

**B. Require QA to rerun every benchmark unconditionally. Completeness: 7/10.** It gives
two measurements but can create false failures from environment drift.

**C. Trust Dev results without QA consumption. Completeness: 4/10.** It loses the
cross-stage trace and gives QA no performance gate.

Decision: adopt A.

## Test strategy

Create a focused Node documentation-contract test that asserts:

- Spec declares `performance-contract/v1` as `required | not required`, names material
  triggers, prevents label-only classification, escalates Tier 0, and defines every
  `P`-table column.
- Plan requirements map each `P` ID to one closed proof kind, task, command/fixture, pass
  condition, QA observation, and residual risk.
- Dev requires declared proof execution, tested-SHA identity, complete kind-specific
  evidence, honest `review/performance` bounce semantics, and both code reviews.
- QA consumes IDs, validates SHA ancestry and affected-path stability, distinguishes
  reproducible from incomparable environments, invalidates evidence after relevant fixes,
  and refuses `qa:passed` on missing or failed proof.
- Canonical and installed Spec/Dev/QA files remain byte-identical.

Extend the existing updater integration fixture to compare all three installed skill
Buffers exactly after an old marker refresh. Cover both source states: performance-first
installs the shared legacy gate; correctness-first extends it without erasing either
contract. Run focused contract, spec-sweep, updater, and
operator-doc tests, then the full `node --test tests/*.test.mjs` suite.

These are documentation-contract tests. They prove canonical instructions, composition,
copy integrity, and distribution, not that an agent will classify every future card
correctly. The rollout audit supplies the first behavioral sample.

No browser, application E2E, or runtime benchmark is meaningful for the implementation
itself because the diff is workflow text and documentation tests. Dev and QA of future
performance-sensitive cards remain responsible for the benchmarks defined by the new
contract.

## Rollout

1. Add the failing cross-stage documentation contract.
2. Update the three canonical skill files and synchronize each installed copy.
3. Strengthen the old-marker updater fixture, increment `VERSION` from the implementation
   branch's current value, add the CHANGELOG entry, and change README's COD-158 note from
   planned to active in the implementation branch.
4. Run focused and full tests, verify exact Buffer equality, and review the exact diff.
5. During rollout, sample the first three required performance contracts (or every
   eligible contract if fewer than three occur before the outcome window closes). Confirm
   each `P` ID has one closed proof kind, complete SHA-bound evidence, and honest QA
   consumption. Record defects as normal `review/performance` evidence; do not repair the
   metric by suppressing or recategorizing them.
6. Continue through normal Dev, QA, Signoff, and human Ship. No production deploy or
   migration exists.

If COD-158 lands first, it installs the shared legacy boundary for later extension. If
COD-155 lands first, preserve its `correctness-contract/v1` text and extend that boundary.
The version increment is taken from current `main` at implementation time so concurrent
release work cannot reuse a stale planned number.

## Factory Learning outcome contract

- **Baseline:** three distinct `review/performance` occurrences across the declared
  contributor ownership set.
- **Metric:** `reviewFindingCount`, count aggregation, expected direction `decrease`,
  target zero.
- **Evaluation window:** 14 days after COD-158 reaches Done.
- **Ownership:** the three configured contributor tuples already embedded in COD-158's
  generated acceptance metric: linear-board-sweeps, safetaper-guide, and zomes_sdr in
  their named projects/workspaces.
- **Leading check:** the rollout sample above measures complete, correctly typed,
  SHA-bound per-`P` evidence before the lagging 14-day metric is due.
- **Exclusions:** never bypass or weaken review, `/benchmark`, code review, QA, Signoff,
  or the human Ship gate. Never suppress, relabel, or recategorize a real finding to make
  the count decrease.

The target is a direction for recurrence reduction, not proof that every future
performance finding is preventable. Factory Learning owns the fixed-window evaluation
and normal recurrence behavior.

## Schema and architecture impact

No persisted schema changes. README receives a planned COD-158 architecture note in this
docs-only spec commit. The implementation branch changes it to active after the skill
bytes, tests, release marker, and propagation proof are green.

## Spec-sweep review audit

| Item | Decision / outcome |
| --- | --- |
| Initial tier | Tier 1 — Bounded, spec target |
| Final tier | Tier 1 — Bounded, unchanged after the completed plan exposed three sequential tasks and no new material risk floor |
| Predicted footprint | 11 physical files / 7 logical artifacts; approximately 130-200 changed lines |
| Correctness contract | `correctness-contract/v1` — required — cross-stage workflow and fail-closed handoffs change |
| Performance contract | `performance-contract/v1` — not required for COD-158's docs-only implementation; required for the future material cards governed by this design |
| Engineering review | Clear after separating measured/deterministic proofs, binding evidence to commit identity, restoring the outcome contract, narrowing static-test claims, and defining both COD-155 orderings |
| Independent adversarial review | Clear after five corrections; configured Claude reviewer dispatch was unavailable through the subagent runtime, so a separate current-runtime reviewer traced every finding to repository lines and cleared the revision |
| UI/design lens | Skipped: no interaction or visual behavior |
| DevEx lens | Skipped: no public API/CLI/SDK ergonomics or adoption flow |
| Security lens | Skipped: no auth, secret, data, or external-input boundary |
| Performance lens | Candidate label; implementation benchmark skipped because no runtime path changes; engineering review must validate downstream benchmark semantics |
| Research lens | Skipped: local evidence and established repository mechanisms are sufficient |
| Terminal gate | Clear: the selected engineering and independent reviews are reconciled, the plan agrees, skipped lenses are justified, and no decisions remain unresolved |

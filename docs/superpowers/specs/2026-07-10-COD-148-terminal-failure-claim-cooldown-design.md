# COD-148 Terminal-Failure Claim Cooldown Design

## Summary

Five SafeTaper spec children hit the Codex usage limit between
2026-07-10T16:39:48Z and 2026-07-10T16:39:59Z. Each child exited within four
seconds, but its `spec:in-progress` label remained on the card. Forty-five
minutes later the launcher correctly removed those labels as stale claims and
Factory Learning recorded five `stale-claim` observations within five seconds.

The reaper behaved as implemented, but the lifecycle model was wrong before the
reaper ran: a process that has already exited is not a live claim owner. Ordinary
nonzero child exits deliberately keep their claims today, while start failures,
dependency/repository deferrals, interruptions, and successful same-state exits
already receive owner-verified cleanup. COD-148 closes that gap without removing
the retry delay that protected the factory from immediate failure loops.

## Evidence and existing mechanisms

- The five accepted observations name distinct cards (`SAF-210`, `SAF-213`,
  `SAF-220`, `SAF-221`, and `SAF-222`) and the same `spec` / `claim-reaper`
  cluster. Their child logs all contain the same usage-limit terminal error.
- `reapDecisions()` treats any old owned claim as a crash and emits a reaper
  decision (`scripts/linear-watch.mjs:614-626`). Confirmed reaps then become
  `stale-claim` learning evidence (`scripts/linear-watch.mjs:4172-4200`).
- `releaseOwnedDispatchClaim()` already re-reads Linear and removes only a claim
  whose latest heartbeat owner equals the dispatch owner token
  (`scripts/linear-watch.mjs:4711-4725`). This is the mechanism to reuse.
- `reconcileOwnedDispatchClaim()` intentionally excludes ordinary `exit`
  results today (`scripts/linear-watch.mjs:4728-4759`), and the existing test
  explicitly preserves that behavior (`tests/linear-watch.test.mjs:3519-3524`).
- `actionableCards()` already centralizes blocked/dependency/live-owner
  admission (`scripts/linear-watch.mjs:808-817`), so a card-scoped retry delay
  needs one admission check rather than a second scheduler.
- Scheduled queue reads already include the latest 100 comment bodies and
  server timestamps. No new database, label, service, or configuration is
  needed.

## Goals

1. A child observed to exit nonzero or terminate by OS signal must stop
   presenting as an active claim owner.
2. Observed nonzero exits and signals must retain the existing per-stage retry
   delay.
3. Cleanup must remove only the exact launcher-owned claim and must fail closed
   if ownership cannot be proven.
4. A failed spec child must not delay another stage after the card moves.
5. Terminal-failure cleanup must not emit `stale-claim` evidence or increment
   crash-loop reaper counts.
6. Existing dependency, route, human Ship, QA, Signoff, and review gates remain
   unchanged.

## Non-goals

- Detecting, parsing, or special-casing Codex billing and quota messages.
- Changing stage stale thresholds or adding configurable backoff policies.
- Retrying a failed child inside the same launcher tick.
- Suppressing dispatch-failure evidence or self-clearing failure Todos.
- Changing crash reaping for a child that never reaches a terminal process
  result.
- Adding a new Linear label or moving failed cards between workflow states.

## Options considered

### A. Owner-verified release plus a card-scoped retry marker (recommended)

ELI10: when a worker stops, take down its “working” sign immediately, but leave a
dated “try again later” note so another worker does not rush into the same
failure.

**Completeness: 10/10.** This makes ownership truthful, preserves the existing
45/90/120-minute stage backoff, survives launcher restarts and machine changes,
and reuses the existing owner-token guard. It adds one bounded comment marker and
one admission predicate.

### B. Release every terminal claim and retry on the next tick

ELI10: remove the sign and let the next worker start immediately.

**Completeness: 6/10.** Ownership becomes truthful, but a quota outage or
deterministic child error can be retried every scheduled minute. That increases
cost and noise and weakens the stop-loss behavior that the stale interval
currently provides.

### C. Keep the claim and merely reclassify the later evidence

ELI10: leave the “working” sign up even though the worker went home, then rename
the cleanup event.

**Completeness: 4/10.** This avoids the learning alert but preserves false
ownership, delays recovery through the crash reaper, and conflates an observed
terminal failure with an unobserved crash. It treats the metric rather than the
lifecycle defect.

Decision: adopt option A.

## Design

### Retry marker

Add a closed launcher marker:

```text
[auto-sweep-retry claim=<claim-label> owner=<owner-token>]
```

The marker is written only for an observed nonzero `exit` or OS `signal` after
the launcher has received the child result. An explicit launcher interruption
retains its current immediate-release/no-cooldown behavior. Linear's `createdAt`
is the clock source; the body does not carry an authoritative future timestamp.
The existing `SWEEP_CFG[sweep].staleMin` is the cooldown duration, so COD-148
cannot create a second policy that drifts from claim recovery.

The claim label is the stage identity because every `SWEEP_CFG` entry owns one
unique claim and `actionableCards()` already receives `cfg.claim`. This avoids
adding a sweep-name parameter through every admission caller.

The comment also carries `[auto-sweep-orphan]` so existing human-answer
detection ignores this coordination message. It states that terminal failure
was observed and cooldown was prepared; it does not claim label removal already
succeeded. It includes the runtime summary and bounded result kind/code for
operator audit, but no raw stdout, stderr, prompts, secrets, or usage-limit text.

### Terminal reconciliation

Extend `reconcileOwnedDispatchClaim()` to classify `result.kind === "exit"` or
`result.kind === "signal"` as `terminal failure`. Route those cases through a dedicated
`releaseFailedDispatchClaim()` helper instead of changing the established
remove-then-audit ordering for successful/deferred/start-failure cleanup. For
that result only:

1. Re-read the card through `fetchClaimCard()`.
2. Require the configured stage, issue id, owner token, claim label, and latest
   matching heartbeat owner exactly as the current cleanup helper does.
3. Write the retry/orphan marker first.
4. Re-read the card after the marker write. Revalidate the claim and latest
   heartbeat owner, and compute the outgoing full label set from this second
   snapshot so labels added before that read are preserved.
5. Remove only the configured claim label through the existing full-label-set
   mutation.
6. Re-read after mutation and prove the claim is absent and every label from the
   second snapshot except that claim remains present.
7. Return a structured result that tells the launcher the claim was released and
   a cooldown was installed. A post-write mismatch is a proven safety invariant,
   not a silent success.

Writing the marker before removing the claim is fail-closed. If the comment
write fails, the claim remains and the existing reaper is the safe fallback. If
the label write fails after the marker succeeds, the still-present claim keeps
the card ineligible and the launcher records a claim-release failure; the marker
cannot cause a duplicate dispatch.

Linear's current helper writes the complete `labelIds` array, not an atomic
single-label removal or compare-and-swap. The second read narrows but cannot
eliminate a write between proof and mutation. Post-write verification must
surface that residual race immediately; implementation must not claim atomicity
or attempt an unsafe blind label restoration.

Successful same-state completion, start failure, dependency deferral,
repository deferral, and interruption retain their current behavior and do not
gain a cooldown. Forward movement retains the current successful-completion
state guard. An ordinary terminal failure may release its exact owned claim even
if the child changed state before failing; the retry marker remains scoped to
the failed sweep and therefore cannot delay the destination stage.

### Admission

Add a pure helper that finds the newest valid retry marker for the candidate's
current claim. Treat it as scheduler-control input, not arbitrary prose. A card
is cooling down only when:

- the comment body begins with one exact, line-anchored marker naming
  `cfg.claim` exactly;
- the marker has a nonempty syntactically valid owner token;
- that owner matches the latest valid heartbeat owner for the same claim, and
  the marker is not older than that heartbeat;
- its Linear `createdAt` parses successfully; and
- its age is between zero and `cfg.staleMin`, inclusive.

`actionableCards()` checks this after blocking/dependency checks and before live
claim evaluation. Expired markers remain immutable audit history and no longer
affect admission. Markers for other sweeps do not affect the current stage.

Scheduled reads currently return only the newest 100 comments. Extend their
connection metadata and reuse/extract the existing complete issue-comment
pagination helper when the oldest returned comment is still inside the maximum
120-minute coordination window and older comments remain. Stop paging once the
oldest comment predates that window, with a hard 20-page/2,000-comment cap. A
missing, cyclic, capped-before-cutoff, or incomplete page fails scheduled
admission closed, matching dependency-read behavior. The cooldown is therefore
machine-independent even on high-comment cards and needs no local state
migration.

The marker is an integrity and availability boundary: a forged marker could
delay a card. Exact anchoring, fixed claim names, server timestamps,
owner-to-heartbeat matching, and complete active-window pagination prevent
quoted prose and stale or unrelated markers from controlling admission. Linear
users and scheduled children already can post heartbeats and mutate card labels,
so COD-148 does not claim cryptographic authorship the current API identity
cannot provide; the residual trusted-operator/agent risk is explicit.

### Same-tick behavior

The completion path already gates both same-repo refill and handoff discovery on
`result.success` (`scripts/linear-watch.mjs:4886` and
`scripts/linear-watch.mjs:5693`), and a failed result stops later drain passes.
Preserve that behavior: the failed result installs its marker and releases host
capacity but triggers no refill or handoff. Demands already queued in the tick
may continue. A later scheduled tick performs the next board read and may admit
other cards while the failed card remains cooled down.

### Evidence semantics

The durable run record is primary truth for the failed process. Failure-Todo
reconciliation remains a separately retried operator signal: cooldown cleanup
may succeed while a Todo write fails, in which case current-tick health is red
and later reconciliation must create/update the Todo. Terminal cleanup uses
`[auto-sweep-orphan]`, not `[auto-sweep-reaper]`, and emits no `stale-claim`
observation. Genuine silent or unobserved crashes still reach
`reapDecisions()` after the stale threshold and continue to contribute
stale-claim evidence and crash-loop escalation.

## Failure modes and invariants

| Failure | Required behavior |
| --- | --- |
| Latest heartbeat belongs to another owner | Do not comment, remove, or cool down; report `released=false`. |
| Claim already absent | No mutation; the terminal result remains recorded as a dispatch failure. |
| Retry comment write fails | Keep the claim; record cleanup failure; stale reaper remains fallback. |
| Claim removal fails after retry comment | Claim still blocks dispatch; record cleanup failure. |
| Card moved to another stage | Remove only the proven old owner claim; old-sweep marker does not block the new stage. |
| Marker timestamp malformed | Ignore the marker. |
| Marker is quoted/embedded, forged for another owner, or in the future | Ignore the marker. |
| Marker is expired | Admit normally if every existing gate passes. |
| More than 100 comments fall inside the active window | Page up to 20 pages/2,000 comments; fail admission closed if the cutoff is still not covered. |
| Launcher restarts or another host takes over | Re-read the Linear marker; enforce the same remaining cooldown. |
| Child freezes without a terminal result | Existing heartbeat reaper and stale-claim evidence remain unchanged. |

The central safety invariant is: a retry delay may replace an ended child's
active claim only after exact owner-token proof, and it may delay only the stage
that produced the terminal failure.

## Testing

Add focused `node:test` coverage in `tests/linear-watch.test.mjs`:

1. Retry-marker parsing accepts the exact claim/owner and uses server
   `createdAt`.
2. Malformed, expired, future, embedded/quoted, wrong-owner, and other-claim
   markers do not block admission; equal timestamps resolve deterministically.
3. `actionableCards()` excludes a cooling card but admits it at expiry.
4. Terminal `exit` and `signal` reconciliation install the marker, re-read, and
   verify before/after removing the exact owned claim; both return
   `reasonKind: "terminal failure cooldown"`.
5. Owner mismatch and absent claim perform no write.
6. Retry-comment failure performs no label removal.
7. Owner change or unrelated label addition between reads never removes a new
   owner's claim or silently loses the added label.
8. Label-removal failure leaves the claim blocking even though the marker exists.
9. Active-window pagination finds a marker beyond comment 100 and fails closed
   on cursor cycles or incomplete pages.
10. A terminal failure after a state move does not block the destination sweep.
11. Successful, deferred, start-failure, interrupted, and silent-crash paths keep
   their existing semantics.
12. An orchestration scenario covers result classification, marker-before-label
    ordering, failure-Todo success/failure, no same-tick refill, later admission,
    and reaper/evidence hooks; the five-card case produces zero `REAPER_TAG`,
    `stale-claim`, or crash-escalation events.

Run the focused suite first:

```bash
node --test tests/linear-watch.test.mjs tests/learning.test.mjs
```

Then run the repository suite:

```bash
node --test tests/*.test.mjs
```

The current baseline is 431 passing and two unrelated `repo-status` CLI tests
failing because this dogfood config has no `repoRouting.byLabel`. COD-148 must not
add failures or change those routing expectations.

## Rollout and measurement

Shipping is merge/push to `main`; this kit has no production app deploy. The
normal updater distributes the launcher change. No migration is required because
old claims continue through the existing reaper and new terminal results start
writing markers immediately.

After shipping, observe seven days as required by COD-148's measurement contract:

- target `staleClaimCount = 0` for terminally observed child failures;
- genuine silent crashes may still produce stale-claim evidence and must remain
  visible rather than being suppressed;
- dispatch-failure evidence and failure Todos must still appear for nonzero exits;
- no card may dispatch during its stage-scoped cooldown, including when its
  active-window marker falls beyond the newest 100 comments; and
- no QA, Signoff, Ship, dependency, route, or review gate may be bypassed.

Rollback removes retry-marker admission and terminal-exit reconciliation together.
Existing marker comments then become inert audit text; no data cleanup is needed.

## Pre-plan engineering review decisions

The review ran in unattended prose mode and adopted the recommended option for
each decision.

### D1 — Mutation ordering and helper boundary

ELI10: ordinary cleanup currently removes the claim and then writes an audit
comment. A retry delay is different because the comment is part of admission
state; removing the claim before that state exists could trigger an immediate
retry.

**A) Dedicated terminal-failure helper (recommended). Completeness: 10/10.**
Write the retry marker first, prove the same owner, then remove only that claim.
Existing successful/deferred cleanup keeps its current behavior and return
contract.

**B) Add options to the existing helper. Completeness: 8/10.** One function can
support both mutation orders, but boolean flags make a coordination invariant
harder to audit and can accidentally change established callers.

**C) Keep remove-then-comment ordering. Completeness: 4/10.** A comment failure
after removal creates the rapid retry loop COD-148 must prevent.

Net: adopt A. This is the smallest explicit boundary that expresses the new
invariant.

### D2 — Cooldown identity

ELI10: admission receives the claim configuration, not a stage name. Making the
marker speak the same identity avoids threading a second identity through every
caller.

**A) Exact claim-label marker (recommended). Completeness: 10/10.** Match
`cfg.claim` directly, which is already unique per sweep and available in every
admission path.

**B) Sweep-name marker plus inferred sweep. Completeness: 8/10.** Correct but
adds a reverse lookup or a new argument where the claim label already carries
the required scope.

Net: adopt A.

### D3 — Durable cooldown storage

ELI10: local timers disappear on restart, while a Linear comment follows the
card to any machine. The scheduler must still find that marker if more than 100
comments arrive before the cooldown expires.

**A) Linear comment plus active-window pagination (recommended). Completeness:
10/10.** It is machine-independent, zero-migration, consistent with heartbeat
ownership, and preserves the absolute cooldown under heavy comment traffic.

**B) New local persistent cooldown ledger. Completeness: 7/10.** Avoids comment
window displacement on one host but creates cross-machine synchronization and
crash-recovery work larger than the problem.

**C) New Linear label per cooldown. Completeness: 6/10.** Durable but expands
label taxonomy, requires timestamp state elsewhere, and adds cleanup/migration
paths.

Net: adopt A; reuse the existing complete-comment pagination pattern and stop at
the maximum coordination window.

### D4 — Scheduler-control comment provenance

ELI10: a quoted or forged retry marker must not become a “pause this card”
command. The current Linear identity cannot cryptographically distinguish the
launcher from the scheduled child, so the design must enforce the strongest
available structural proof and state the residual trusted-agent boundary.

**A) Exact marker + owner/heartbeat proof (recommended). Completeness: 9/10.**
Require a line-anchored grammar, fixed claim, valid server time, and an owner that
matches the latest heartbeat for that claim. This rejects accidental prose and
unrelated markers while reusing the established coordination trust boundary.

**B) Trust any matching comment substring. Completeness: 3/10.** Smallest code
change, but a card description, quote, or copied owner token could delay work.

**C) Add a new cooldown service/credential. Completeness: 10/10.** Stronger
authorship, but adds cross-machine infrastructure and a new secret solely for a
short retry delay.

Net: adopt A. The residual risk is a trusted Linear operator or already
credentialed child intentionally forging coordination state; those actors can
already post heartbeats and change labels.

### D5 — Complete terminal-result coverage

ELI10: a process killed by the operating system is just as finished as one that
returns exit code 1. Leaving signals out would recreate the same false claim.

**A) Cover `exit` and `signal` (recommended). Completeness: 10/10.** Both are
observed terminal results; explicit launcher `interrupted` remains the existing
no-cooldown release path.

**B) Cover `exit` only. Completeness: 7/10.** Fixes the observed quota incident
but leaves signaled children for stale reaping.

Net: adopt A.

## Security lens outcome

Focused CSO/STRIDE review found one material boundary: Linear comment text moves
from audit-only prose into scheduler admission. The attack is bounded denial of
service: an actor who can write a syntactically valid marker and matching owner
could delay one claim stage for at most its stale interval. D4 mitigates quoted,
embedded, stale, future, wrong-owner, and incomplete-history variants. No secret,
auth, data-disclosure, privilege-escalation, or arbitrary-code path is added.
The lens is clear only with D4 and the parser/pagination tests in this spec.

## Pre-plan test coverage diagram

```text
CHILD RESULT
  ├── success
  │   ├── same state -> existing owner-verified release       [EXISTING TEST]
  │   └── advanced state -> child/holding cleanup             [EXISTING TEST]
  ├── dependency/repository deferral -> immediate release     [EXISTING TEST]
  ├── start failure/interruption -> immediate release         [EXISTING TEST]
  ├── ordinary nonzero exit or OS signal
  │   ├── owner matches
  │   │   ├── marker write fails -> claim remains             [PLANNED TEST]
  │   │   ├── marker writes, label removal fails -> blocked   [PLANNED TEST]
  │   │   └── marker + removal succeed -> cooldown            [PLANNED TEST]
  │   ├── owner differs -> no mutation                        [PLANNED TEST]
  │   └── claim absent -> no mutation                         [PLANNED TEST]
  └── silent/frozen child -> heartbeat reaper unchanged       [EXISTING TEST]

ADMISSION
  ├── matching claim marker
  │   ├── age <= staleMin -> ineligible                       [PLANNED TEST]
  │   └── age > staleMin -> eligible if other gates pass      [PLANNED TEST]
  ├── other-claim marker -> ignored                           [PLANNED TEST]
  ├── quoted/embedded/wrong-owner/future marker -> ignored    [PLANNED TEST]
  ├── marker beyond newest 100 -> page active window          [PLANNED TEST]
  ├── incomplete pagination -> fail admission closed          [PLANNED TEST]
  └── blocked/dependency/live claim -> existing gate wins     [PLANNED TEST]

LEARNING
  ├── terminal exit -> dispatch failure + no stale reap       [PLANNED TEST]
  └── genuine stale heartbeat -> stale-claim evidence         [EXISTING TEST]
```

Architecture review: mutation ordering, signal coverage, same-tick semantics,
and complete comment history were corrected. Code-quality review: claim identity
and a dedicated failure helper avoid interface/flag ambiguity. Test review: the
new branches above require focused unit and orchestration coverage. Performance
review: active-window pagination is bounded by 120 minutes and runs only when the
newest 100 comments do not cover that window. Security review: clear with D4's
integrity checks and fail-closed pagination. No new TODO is warranted, and the
implementation is sequential because production logic and tests share the same
primary module.

## Review depth decision

**Predicted footprint:** `scripts/linear-watch.mjs`,
`tests/linear-watch.test.mjs`, `README.md`, and `docs/linear-rules.md`; about
260-380 changed lines including tests and operator documentation after
active-window pagination and security proof were added.

**Behavior/state/interface changes:** changes child terminal-result behavior,
persists a new coordination marker in Linear comments, changes scheduler
admission for one stage/card until a deadline, and extends an internal cleanup
helper/result contract. It adds no external dependency, public CLI/API, schema
migration, or production deploy target. User-visible failures remain failure
Todos and card comments.

**Risk:** material concurrency/ownership and retry-loop risk. A bad owner check
could release another worker's claim; a bad marker scope could starve unrelated
stages; a missing cooldown could create rapid quota retries. This establishes a
Tier 2 floor for coordination semantics even though the implementation is
localized.

**Initial tier: Tier 2 — Material.** Run a pre-plan engineering review and an
independent adversarial premise review against this spec, then run a plan
engineering review after the implementation plan. The final tier may not
decrease.

**Final tier: Tier 2 — Material.** The spec engineering pass, independent
adversarial premise review, focused security lens, and terminal plan engineering
pass are clear. The plan added a 20-page work cap and full failure-path coverage;
the tier did not decrease or escalate. No decision remains unresolved.

**Specialized lenses:** UI/design skipped (no interaction or accessibility
change); API/CLI/SDK devex skipped (no public contract or adoption change);
security ran and is clear with D4's exact parser/provenance boundary;
performance was covered by the plan engineering pass with a 120-minute/20-page
bound and requires downstream benchmark evidence in Dev/QA; external research
skipped (no unfamiliar integration or API is introduced).

## Schema and architecture impact

No application schema changes. The launcher coordination architecture gains one
planned, stage-scoped Linear comment marker and one terminal-failure transition:
`active claim -> terminal result -> retry marker + claim release -> cooldown ->
eligible`. `README.md` and `docs/linear-rules.md` should document this as planned
for COD-148 until implementation ships.

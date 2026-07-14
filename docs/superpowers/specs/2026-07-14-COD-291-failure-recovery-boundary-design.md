# COD-291 Context-Bound Routing Recovery Design

## Summary

Factory Learning observed five `failure-recovery` transitions for one failure
fingerprint between 2026-07-11T08:21:44Z and 2026-07-11T10:51:35Z. The source
sequence was `recovered -> recurred -> recovered -> recurred -> recovered` for
Ship card `COD-158`. Each recurrence followed a child-created
`repo-routing-deferred` outcome even though the workspace had no configured
`repoRouting.byLabel` and the launcher had not exported
`AUTO_SWEEP_REPO_LABEL`.

Three trust mistakes turned one bad child preflight into repeated
factory noise:

1. `linear.mjs repo-status` trusted its positional arguments without binding
   them to the scheduled environment. A child could call it in a non-routed
   workspace, pass `AUTO_SWEEP_REPO_ENTRY` and `AUTO_SWEEP_REPO` in the label
   and repo slots, and manufacture a route-deferral outcome.
2. failure-Todo recovery treated a broad `ship:routing` scan as proof that any
   Ship route failure was healthy. The next tick therefore closed the Todo even
   though the same card had not demonstrated a healthy route boundary.
3. child environments overlay `pick.childEnv` on the full parent process. An
   optional `AUTO_SWEEP_REPO_LABEL` omitted for a non-routed card can therefore
   leak from a stale or nested scheduled context unless card-scoped variables
   are explicitly removed before the overlay.

COD-291 makes scheduled route preflight context authoritative, validates the
child outcome against the launcher's immutable pick, and requires
workspace/card/stage-specific recovery evidence. It preserves every fail-closed route, dependency, claim,
review, QA, Signoff, and human Ship gate.

## Evidence and current mechanisms

The generated card records these five launcher evidence IDs under detector
`failed-recovery/v1`:

| Time | Run | State | Failure key |
| --- | --- | --- | --- |
| 08:21:44Z | `launcher:6502d6eb98e838ac12dba71a` | recovered | `637f541a2e4e0c0e` |
| 09:48:46Z | `launcher:b8fa07697002e947f8dda80d` | recurred | `637f541a2e4e0c0e` |
| 10:07:57Z | `launcher:500b5f2a459a2bd36315ce36` | recovered | `637f541a2e4e0c0e` |
| 10:40:14Z | `launcher:47528e199489d630731337bb` | recurred | `637f541a2e4e0c0e` |
| 10:51:35Z | `launcher:f3f0417c41775fa90873c71f` | recovered | `637f541a2e4e0c0e` |

Repository evidence explains the sequence:

- `scripts/linear-watch.mjs:307-311` deliberately assigns a first-repo route
  with `label: null` when routing is not configured.
- `scripts/linear-watch.mjs:1604-1607` exports repository paths and entry for
  every scheduled card, but exports `AUTO_SWEEP_REPO_LABEL` only for a truly
  label-routed card.
- `scripts/linear-watch.mjs:6517-6523` spreads the full parent environment before
  `pick.childEnv`; omitted optional `AUTO_SWEEP_*` keys are not cleared.
- `scripts/linear.mjs:63-82` requires a non-empty `repoRouting.byLabel` for
  every `repo-status` call and does not distinguish scheduled non-routed use.
- `scripts/linear.mjs:778-810` accepts positional route identity and writes a
  `repo-routing-deferred` outcome on either mismatch or unreadable context.
- `scripts/linear-watch.mjs:6281-6300` accepts any version-1 route outcome for
  the same issue; it does not compare the outcome's route identity with the
  launcher's trusted `pick.repoRoute`.
- `scripts/linear-watch.mjs:6920-6928` turns that outcome into a route failure
  whose stable target is only the issue identifier.
- `scripts/linear-watch.mjs:7533-7538` marks the whole stage routing scope as
  checked after a scan.
- `scripts/linear-watch.mjs:2090-2100` closes every absent failure for a checked
  scope. The existing test at `tests/linear-watch.test.mjs:6772-6778` locks this
  broad stage-level recovery behavior.

The existing pieces are useful and remain in place: immutable child environment
construction, first-write-wins outcome files, live label reads, route resolution,
failure fingerprints, self-clearing Todos, and confirmed recovery evidence. The
fix narrows their trust boundaries instead of replacing them.

## Goals

1. A scheduled non-routed child cannot create a route-deferral outcome, even if
   it mistakenly invokes `repo-status`.
2. A scheduled routed child can validate only the issue, label, and repo entry
   exported by its launcher; positional argument drift fails closed.
3. A child starts from one clean card-scoped `AUTO_SWEEP_*` environment; stale
   parent or `.env` values cannot fill optional fields omitted by the launcher.
4. The parent accepts a route-deferral outcome only when it matches the trusted
   routed pick that launched the child.
5. A route failure Todo closes only after that exact card's route is observed
   healthy after the failure, with a same-tick child failure taking precedence.
6. Repeated identical failures update one open Todo instead of alternating
   recovered and recurred evidence.
7. The seven-day `failedRecoveryCount` acceptance measurement reaches zero
   without suppressing detector evidence or weakening safety gates.

## Non-goals

- Changing `failed-recovery/v1`, its threshold, evidence identity, or metric.
- Suppressing `recovered`, `recurred`, or `open-after-healthy` observations that
  are backed by the corrected proof rules.
- Making routing optional for a workspace that configures `repoRouting`.
- Allowing a child to proceed after a missing, ambiguous, changed, or unreadable
  live route.
- Changing dependency semantics, claim ownership, workflow states, review/QA
  gates, fast-path eligibility, or Ship approval.
- Adding a persistent retry scheduler, a new Linear label, or a new state.
- Refactoring unrelated launcher failure handling.

## Options considered

### A. Context-bound helper plus exact recovery proof (recommended)

ELI10: the launcher gives the child a sealed address card; the checker uses that
card, and the alarm clears only after the same package is checked again.

**Completeness: 10/10.** It prevents the observed false outcome, rejects forged
or stale child evidence, and fixes the recovery proof that converted one failure
into a recovered/recurred loop. It reuses current route resolution and failure
Todo machinery with bounded changes.

### B. Normalize only in the parent launcher

ELI10: let the child write the wrong note, then have the parent decide whether
to ignore it.

**Completeness: 7/10.** Parent validation would protect handoff and Todo state,
but the helper would still emit misleading local output and card comments. It
would also leave two definitions of scheduled route identity.

### C. Add a retry cooldown or quarantine after repeated route failures

ELI10: stop trying the package for a while after the alarm repeats.

**Completeness: 4/10.** It bounds cost but does not correct the false route
outcome or the false recovery proof. A cooldown also delays legitimate recovery
and adds persistence for a problem that deterministic validation can prevent.

Decision: adopt option A.

## Design

### 1. Resolve scheduled route context before reading Linear

Add a pure `scheduledRepoStatusContext` decision in `scripts/linear.mjs`. It
receives the loaded config, CLI issue/label/repo arguments, and only these
trusted environment fields:

- `AUTO_SWEEP_ISSUE`
- `AUTO_SWEEP_REPO_LABEL`
- `AUTO_SWEEP_REPO_ENTRY`
- `AUTO_SWEEP_REPO`

The decision has three modes:

| Mode | Conditions | Result |
| --- | --- | --- |
| Scheduled non-routed | `AUTO_SWEEP_ISSUE` is set, config has no `repoRouting`, and `AUTO_SWEEP_REPO_LABEL` is absent | Return eligible `not-routed` without a Linear label query and without writing an outcome file. Require the CLI issue to match `AUTO_SWEEP_ISSUE`; ignore accidental route arguments because no routed authority exists. |
| Scheduled routed | `AUTO_SWEEP_ISSUE` and `AUTO_SWEEP_REPO_LABEL` are set and config has valid routing | Require CLI issue/label/repo to exactly match the environment, then run the existing live-label eligibility check. Mismatch is unreadable/exit 2 with trusted expected fields. |
| Attended CLI | No `AUTO_SWEEP_ISSUE` | Preserve the existing explicit-argument behavior and require valid routing config. |

Contradictory scheduled state fails closed: configured routing without an
exported label, an exported label without configured routing, missing repo entry,
or issue mismatch returns exit 2. Its outcome uses a bounded reason such as
`scheduled-context-mismatch`; it never copies an untrusted positional value into
the expected route identity.

This preserves the skill contract: well-behaved non-routed children never call
`repo-status`, while an accidental call is harmless. Routed children still
complete a fresh live-label read before material work.

### 2. Validate the deferred outcome against the launch pick

Extract the route branch of `childDeferredOutcomeForPick` into a pure validator.
For `repo-routing-deferred`, the parent requires:

- a routed `pick.repoRoute` with a non-empty label and repo entry;
- the same issue identifier as the pick;
- route exit code 2 or 3;
- a route payload no larger than 64 KiB with an allowed `routing.reason` and
  schema-valid `matches` array; and
- `routing.expectedLabel` and `routing.expectedRepoEntry` exactly equal to the
  pick's label and repo entry.

A valid outcome keeps the current `REPO_ROUTE_CHANGED` or
`REPO_ROUTE_UNREADABLE` result. An inconsistent outcome becomes
`child-outcome-invalid` with code `UNTRUSTED_CHILD_OUTCOME`. It remains a
failed dispatch, so it cannot trigger fallback, handoff, merge, deploy, or a
successful run record. It is not represented as a real repository route
failure.

Outcome-file presence is itself protocol evidence. No file still means “the
child did not defer.” Once the configured path exists, unreadable JSON, an
unsupported version or kind, a missing required field, or a mismatched routed
tuple is `child-outcome-invalid`; it must never collapse back to `null` and turn
a runtime exit 0 into success. The failure message reports the bounded protocol
reason plus trusted expected issue/label/repo values, never raw file contents or
environment secrets.

The accepted route schema is closed, not merely shape-like. The top-level route
record contains exactly `version`, `kind`, `issueIdentifier`, `routeExitCode`,
and `routing`; `routing` contains exactly `reason`, `expectedLabel`,
`expectedRepoEntry`, and `matches`. Labels and repo entries are strings no
longer than 256 UTF-8 bytes. Exit 2 permits only
`unreadable` or `scheduled-context-mismatch` with `matches: []`. Exit 3 permits
only `missing-route-label` with zero matches, `ambiguous-route-label` with two
or more unique configured matches, or `route-changed` with exactly one unique
configured match different from the expected tuple. Every match is exactly a
string `{ label, repoEntry }` pair present in the trusted
`config.repoRouting.byLabel`; duplicates, extra fields, unconfigured pairs,
wrong cardinality, wrong reason/exit combinations, and files over 64 KiB are
invalid protocol evidence. The parent records the normalized bounded payload,
not the raw parsed object.

Valid dependency outcomes are unchanged. Because the file is a shared
first-write protocol, invalid JSON, an unsupported version/kind, and an
oversized file are classified as `child-outcome-invalid` before a kind can be
trusted; they are never presumed to be either route or dependency evidence.
Existing valid dependency payloads retain their current classification and
fields.

### 2a. Scrub inherited card-scoped environment before dispatch

`dispatchEnvironment` builds a fresh base that excludes every inherited key
whose name starts with `AUTO_SWEEP_`, then applies the workspace `.env`, then
removes any `AUTO_SWEEP_*` values found there, and finally overlays the exact
`pick.childEnv` generated by `withCardDispatchEnv`. Ordinary runtime, credential,
PATH, proxy, and tool variables remain inherited.

This makes omission meaningful: a non-routed pick that does not emit
`AUTO_SWEEP_REPO_LABEL` cannot acquire one from a parent child run or an
accidental `.env` entry. The launcher remains the only owner of card-scoped
scheduled identity. A focused test supplies stale issue, label, repo, claim,
outcome-path, and run-ID values through both parent env and parsed `.env`; the
result must contain only the values present in `pick.childEnv`.

### 3. Give route failures an exact recovery target

Introduce a deterministic route recovery target built from trusted launcher
identity:

```text
{ sourceWorkspaceId, projectId, sweep, issueIdentifier }
```

`sourceWorkspaceId` is the existing deterministic `stablePathSlug` of the
canonical source anchor already used for managed-workspace identity. It keeps
same-basename workspaces distinct without writing a local filesystem path to
Linear. The target is serialized canonically and used as
`stableTarget` for both pre-dispatch route failures and valid child route
deferrals. It is specific to one registered workspace, card, and stage for both
failure deduplication and recovery while allowing a corrected label or mapping
to prove health. No managed worktree path, secret, owner token, or untrusted
child message enters the key.

During each stage scan, successfully routed actionable cards add their exact
target to `active.recoveredTargets`; failures add the matching current failure.
A broad `${sweep}:routing` checked scope remains useful for diagnostics but is
no longer sufficient to close a `repo-routing` Todo.

### 4. Make current failures outrank recovery candidates

Child route failures are added to the anchor's current failure set as well as
reconciled immediately. At final reconciliation:

- a matching current failure creates or updates one Todo and prevents close;
- an exact recovered target closes a prior Todo only when no matching current
  failure exists; and
- a different card or stage cannot close it.

This ordering handles the scan/dispatch race. If a route passes during the scan
but changes before the child preflight, the later child failure stays current
and the Todo remains open. On a later tick, an exact healthy scan with no later
failure may close it. Repeated failures update the same open card and do not emit
`recovered` followed by `recurred`.

`failureTodoDecisions` retains checked-scope recovery for non-routing failure
kinds. Only `repo-routing` switches to exact-target recovery.

Changing `stableTarget` changes the fingerprint, so migration is explicit and
precedes create/update decisions. For each new route event, compute its legacy
fingerprint from the old issue-only target. The project-wide caller builds a
new-fingerprint → legacy-fingerprint alias only when the legacy Todo's bounded
`Anchor`, project, stage, and issue fields map to exactly one registered
canonical source workspace and that workspace equals the current event. A
current failure then reuses the legacy open Todo and rewrites its description
with the new target and marker before any create decision. Historical recovered
fingerprint lookup accepts the same proven alias, so a real post-upgrade
recurrence creates one new isolated Todo and emits `recurred` with the new key.

If the old basename/project fields match zero or multiple registered source
workspaces, no alias is created. The legacy open Todo remains open for attended
inspection, a new isolated failure may create its own Todo, and historical
recurrence is not inferred. Broad scope health never closes a legacy route Todo.
This fail-closed ambiguity is preferable to merging or recovering two source
workspaces incorrectly.

### 5. Preserve safety and evidence semantics

All route failures still stop before material work and release only the owned
claim through the existing immutable-claim protocol. A route outcome cannot
override a dependency outcome already written because the first outcome file
remains authoritative. Failure Todo create/update/close mutations and their
fresh confirmation reads are unchanged.

Confirmed exact recovery continues to emit `recovery-transition/recovered`.
A truly recurring route failure after exact recovery continues to emit
`recurred`; an attempted close that remains Todo continues to emit
`open-after-healthy`. COD-291 reduces false transitions by strengthening proof,
not by filtering the learning stream.

## Scope closure

`Scope closure: scope-closure/v1 — required` — COD-291 changes CLI behavior,
child/parent interface validation, launcher recovery state, failure evidence,
and distribution documentation.

### Scope closure inventory

| ID | Surface and evidence | Required outcome | Owning repo/module | Closure proof |
| --- | --- | --- | --- | --- |
| S1 | Scheduled CLI entry point; `scripts/linear.mjs:63-82,778-810` trusts route args and requires routing for every invocation. | Non-routed scheduled misuse is an eligible no-op; routed scheduled identity is environment-bound and contradictory context fails closed. | `linear-board-sweeps/scripts/linear.mjs` | Focused CLI subprocess tests distinguish non-routed, routed, contradictory, and attended contexts with exact exit/output/outcome assertions. |
| S2 | Child outcome channel; `scripts/linear-watch.mjs:6281-6300` validates only version, kind, issue, and exit code. | Parent accepts a bounded route deferral only for its exact routed pick and closed reason/match schema; inconsistent evidence remains a terminal failed dispatch. | `linear-board-sweeps/scripts/linear-watch.mjs` | Unit/integration fixtures prove oversized, unreadable, unsupported, non-routed, wrong tuple, reason/exit mismatch, cardinality mismatch, unconfigured match, and duplicate match payloads yield `UNTRUSTED_CHILD_OUTCOME`, while one exact live-race payload remains deferred. |
| S3 | Failure recovery, workspace isolation, and legacy Todo continuity; `scripts/linear-watch.mjs:1940-2100,6920-6928,7533-7538` uses issue-only proof plus broad stage check. | Route failure and recovery identity is source-workspace/card/stage-specific, a later same-tick child failure outranks an earlier healthy scan, and only a uniquely proven legacy alias is migrated before create/update/recurrence decisions. | `linear-board-sweeps/scripts/linear-watch.mjs` | Decision and orchestration tests prove cross-workspace fingerprint isolation, current-failure precedence, unique one-Todo legacy migration, ambiguous fail-closed behavior, historical recurrence continuity, exact recovery, and real recurrence. |
| S4 | Claim, dependency, handoff, and Ship safety gates. | No invalid route result can advance or perform material work; existing first-outcome and immutable-claim behavior remains intact. | `linear.mjs`, `linear-watch.mjs`, existing sweep skills | Existing dependency/outcome/claim suites plus focused regression assertions remain green. |
| S5 | Learning acceptance and observability; COD-291 baseline is five transitions and target is zero over seven days. | Correct proof still emits recovery transitions; false broad-scope transitions disappear without detector changes. | `linear-watch.mjs`, `learning.mjs` unchanged | Tests assert evidence emission after exact recovery and no emission on mismatched proof; post-ship Factory Learning evaluation reports `failedRecoveryCount = 0` for the seven-day window. |
| S6 | Operator contract and release distribution. | README, changelog, and version describe context-bound preflight and exact recovery; no external publication is automated. | `README.md`, `CHANGELOG.md`, `VERSION` | Doc assertions/full suite pass; Ship merges/pushes main; any external release remains attended or a linked Todo. |
| S7 | Repository/deploy boundary. Config lists one repo and no production app deploy. | All implementation stays in `linear-board-sweeps`; no sibling or production target is introduced. | Repository root/config | Final diff contains only configured repo files; Ship follows merge/push-only config and generated-card human approval. |
| S8 | Child environment provenance; `scripts/linear-watch.mjs:6517-6523` inherits all parent keys before overlay. | Card-scoped `AUTO_SWEEP_*` values come only from the current `pick.childEnv`; omitted optional fields remain absent. | `linear-board-sweeps/scripts/linear-watch.mjs` | Unit fixture injects stale parent and `.env` values and asserts the dispatched environment contains only current card-scoped values. |

Self-check: every goal maps to S1-S5 and S8; failure and race behavior maps to S2-S4;
acceptance measurement maps to S5; distribution and rollout map to S6-S7. Every
row has one configured owner and a falsifiable proof. No omitted material surface
remains after the independent evidence review added S8.

## Correctness contract

`Correctness contract: correctness-contract/v1 — required` — the feature changes
the precedence, identity, and recovery rules for machine-readable route state.

| ID | Trigger / transition | Required invariant | Forbidden outcome | Recovery / ownership | Verification |
| --- | --- | --- | --- | --- | --- |
| C1 | Scheduled `repo-status` runs with no configured routing and no exported route label. | It returns eligible `not-routed`, performs no label query, and writes no deferred outcome. | A false route failure, Todo, comment, or blocked handoff is manufactured from repo path/entry arguments. | Launcher owns scheduled context; helper may only report non-routed readiness. | CLI fixture with accidental route arguments exits 0 and leaves outcome path absent. |
| C2 | Scheduled routed `repo-status` receives missing, stale, or reordered CLI route arguments. | Only the environment/config/live-label tuple is authoritative; contradiction exits 2 or a live route change exits 3. | Untrusted positional identity is accepted or copied into expected route evidence. | Helper writes one first-outcome record from trusted context; launcher retry owns recovery. | Routed CLI fixtures assert exact tuple success and exact mismatch/unreadable outcomes. |
| C3 | Parent reads `repo-routing-deferred` after a child exits. | File absence means no deferral; once present, size, JSON, version, kind, issue, routed pick, expected tuple, reason/exit consistency, configured match membership/uniqueness/cardinality, and allowed fields are validated before classification. | Present unreadable, oversized, non-routed, unsupported, internally inconsistent, or mismatched evidence is ignored as if absent, treated as authentic route deferral, written raw to run records, or followed by successful handoff. | Parent classifies every present invalid outcome as failed child protocol and retains only a normalized bounded diagnostic; no fallback or handoff consumes it. | Outcome-channel fixtures cover every invalid schema branch plus absent file and the exact valid reason/exit/cardinality variants. |
| C4 | A prior route Todo, including a pre-COD-291 issue-only Todo, is considered for create/update/close while workspaces/cards/stages are scanned and dispatched. | Canonical `stableTarget` isolates the source workspace/card/stage for both fingerprint and recovery; a uniquely proven legacy fingerprint alias is resolved before mutation; any matching current failure wins over recovery. | Another workspace/card/stage or an earlier scan closes/updates the Todo; ambiguous legacy identity is aliased; migration creates a duplicate or loses historical recurrence. | Launcher builds exact current failures/recovered targets and proven legacy aliases; Todo update replaces the marker/target; confirmed close owns evidence emission. | Pure decision plus orchestration fixtures cover cross-workspace fingerprint isolation, unique/ambiguous legacy aliasing, Done-history recurrence, race ordering, and cross-target isolation. |
| C5 | Route/dependency/claim facts change during a scheduled run. | Route failure remains pre-material, first deferred outcome wins, and only the owned claim may be released. | Invalid route evidence advances state, overwrites dependency evidence, removes a foreign claim, merges, or deploys. | Existing immutable claim and outcome-file owners remain unchanged. | Existing claim/dependency/outcome tests plus regression assertions pass. |
| C6 | Factory Learning evaluates post-ship failure recovery. | Every retained transition has confirmed exact proof and the seven-day count can be compared honestly with baseline five. | Detector events are suppressed, renamed, or filtered to make the metric pass. | Existing learning runner evaluates unchanged detector semantics; owner attends Ship. | Learning tests remain unchanged/green and the evaluation window reports zero real transitions or an honest failure. |
| C7 | Launcher dispatch is invoked from a parent or `.env` carrying stale `AUTO_SWEEP_*` keys. | The child receives only card-scoped keys explicitly generated for its current pick; an omitted key remains absent. | Stale route, issue, claim, run, or outcome identity crosses into a different child. | `dispatchEnvironment` owns scrubbing; `withCardDispatchEnv` owns the replacement values. | Environment fixture injects stale values through both sources and proves exact current overlay plus absent optional label. |

## Verification contract

`Verification contract: verification-contract/v1 — required` — the behavior,
error handling, compatibility, recovery, and user-visible Todo outcomes change.

### Verification obligations

| ID | Source requirement / C ID(s) | Behavior / risk | Failure this proof must catch | Required proof | Acceptance |
| --- | --- | --- | --- | --- | --- |
| V1 | C1 | Non-routed scheduled safety | Helper queries/fails routing or writes a false deferred outcome. | Spawn `repo-status` with scheduled non-routed env, accidental route args, and a fetch stub that fails if called. | Exit 0, `eligible:true`, `reason:not-routed`, zero fetches, no outcome file. |
| V2 | C2 | Routed identity and live race | Positional mismatch is trusted, or a live changed label proceeds. | CLI subprocess matrix for exact tuple, argument mismatch, missing env label, config contradiction, missing/ambiguous/changed live labels. | Exact tuple exits 0; contradictions exit 2; live mismatch exits 3; expected identity always comes from env. |
| V3 | C3 | Parent trust boundary | A present forged, unreadable, oversized, unsupported, non-routed, or internally inconsistent payload is ignored and a superficially successful runtime exit advances, or raw unbounded data reaches records. | Focused `dispatchAsync`/pure-validator fixtures with absent and exact variants plus every size/schema/reason/exit/match membership/uniqueness/cardinality violation. | Only an absent file means no deferral and only an exact bounded routed payload becomes `repo-routing-deferred`; every other present payload becomes `child-outcome-invalid`; records contain normalized fields only. |
| V4 | C4 | Failure/recovery identity, compatibility, and race order | Same-basename workspaces share a fingerprint or mutate/close each other; broad health, an ambiguous legacy Todo, an earlier scan, or immediate-plus-final reconciliation closes/duplicates a live failure; migration breaks recurrence evidence. | `failureTodoDecisions` and orchestration fixtures with two source workspaces sharing one project/card/stage, uniquely mapped and ambiguous open/Done legacy Todos, two cards/stages, scan-then-child-failure ordering, and one child failure passed through both reconciliation points. | New workspace fingerprints differ; no cross-workspace mutation/close; unique legacy recurrence updates one Todo before create and Done history emits one real `recurred`; ambiguous legacy identity stays untouched; immediate plus final reconciliation produces one mutation/no transition; later exact healthy target closes once. |
| V5 | C5 | Safety-gate regression | Outcome overwrite, handoff, claim loss, merge, or deploy occurs after invalid route evidence. | Existing first-outcome, dependency, immutable claim, and dispatch result suites plus named assertions that invalid route result is unsuccessful. | All focused tests pass; invalid result has `success:false` and cannot enter handoff/refill. |
| V6 | C6 | Honest acceptance measurement | Tests or code silence recovery evidence or alter detector semantics. | Assert `learning.mjs` detector and event mapping are unchanged; run focused learning regression and post-ship `learning-status --json`. | Existing recovery observations remain recognized; seven-day evaluated count is zero or remains an explicit failed evaluation. |
| V7 | C7 | Child environment provenance | Optional route identity leaks from a parent run or `.env` into a non-routed child. | Unit test `dispatchEnvironment` with stale `AUTO_SWEEP_*` values in both input layers and an exact current `pick.childEnv`. | Every inherited card-scoped key is absent or replaced by the current pick; ordinary non-sweep env survives. |

## Performance contract

`Performance contract: performance-contract/v1 — not required` — the design adds
bounded comparisons and set membership to existing per-card scans and reads no
additional Linear pages, files, or network resources. There is no material
latency, throughput, memory, payload, fan-out, retry, cache, or background-work
surface. Tests should still assert no label query in non-routed mode because that
is a correctness and unnecessary-I/O boundary, not a benchmark.

## Review depth decision

- **Predicted footprint:** `scripts/linear.mjs`, `scripts/linear-watch.mjs`,
  `tests/linear.test.mjs`, `tests/linear-watch.test.mjs`, `README.md`,
  `CHANGELOG.md`, `VERSION`, plus these design/plan artifacts; approximately
  250-400 changed lines including tests and docs.
- **Behavior/state/interface changes:** scheduled CLI behavior, trusted child
  outcome shape validation, failure stable-target identity, recovery precedence,
  and operator-visible Todo lifecycle.
- **Dependencies/persistence/rollout:** no new dependency or storage schema; the
  existing outcome file and Linear Todos keep their format. Normal kit version
  rollout and human Ship approval apply.
- **Material risk:** significant failure/recovery and precedence paths across
  two interacting modules. Incorrect handling could either create repeated
  false failures or weaken a pre-material route gate.
- **Initial tier:** Tier 2 — Material.
- **Selected reviews:** spec engineering pass plus independent adversarial
  premise review before plan; plan engineering pass after plan; DevEx specialized
  lens because `repo-status` is a cross-runtime operator CLI contract.
- **Rationale:** this is bounded to one repo but crosses the child/parent trust
  boundary and recovery state machine. Both design premises and task ordering
  need review.

## Specialized lens decisions

- **CLI / DevEx: run.** The command's scheduled versus attended semantics, exit
  codes, JSON, and outcome-file contract materially change.
- **UI / design: skip.** No interaction, hierarchy, accessibility, responsive
  behavior, or user flow changes.
- **Security: skip.** No auth, secret, permission, data-disclosure, or external
  input boundary changes; route evidence is existing trusted scheduler metadata.
- **Performance: skip.** The performance contract is not required and the design
  adds no I/O or material hot-path work.
- **Research: skip.** The feature uses only repository-owned launcher and Linear
  helper behavior; no unfamiliar external API or integration is introduced.

## Rollout and acceptance

1. Implement with TDD and preserve all current route/dependency/claim fixtures.
2. Allocate the next live four-component `VERSION` patch after reconciling
   origin, and update `CHANGELOG.md` and README behavior.
3. Dev reports V1-V7 with source C IDs and exact commands before both code-review
   passes. QA repeats the public CLI/outcome cases and maps every V ID.
4. Because COD-291 is `factory:learning-generated`, QA must send it to Signoff;
   it is never fast-path eligible and requires the human Ship move.
5. Shipping is merge/push to main. Any external release publication remains an
   attended owner action or a linked Todo.
6. After the seven-day evaluation window, Factory Learning must report
   `failedRecoveryCount` against baseline 5. Target is 0; any real transition is
   retained and the evaluation fails honestly.

Rollback is a normal revert followed by a new patch version. Reverting restores
the old helper and recovery semantics; it must not edit or delete historical
learning evidence or failure Todos.

## Schema and architecture impact

No data schema changes. The launcher architecture gains a planned
context-bound route-preflight and workspace/card/stage-specific recovery boundary in
`linear.mjs` and `linear-watch.mjs` (planned, COD-291). README will describe the
boundary as planned until Dev ships it.

## Engineering review — spec pass

### Step 0: challenge the footprint

- **What already exists:** `repoRouteEligibility`, `writeAutoSweepOutcome`,
  `childDeferredOutcomeForPick`, `dispatchEnvironment`, failure fingerprints,
  Todo body parsers, `failureTodoDecisions`, recovered-target sets, and the
  existing `node:test` suites. The change reuses these seams.
- **NOT in scope:** a new outcome format version, detector tuning, new retry
  persistence, a failure-state rewrite, a new CLI command, or any sibling repo.
- **Minimal shape:** two pure decisions plus narrow orchestration wiring: resolve
  scheduled route authority, validate a present route outcome, scrub dispatch
  identity, and canonicalize exact route recovery. No new class or dependency.
- **File count:** four behavior/test files are essential. README, changelog,
  VERSION, design, and plan are distribution artifacts rather than new runtime
  units. This does not justify a module split.

### Findings and unattended decisions

| # | Priority | Finding | Decision |
| --- | --- | --- | --- |
| E1 | P1 | `childDeferredOutcomeForPick` currently returns `null` for both an absent file and every malformed present file. A child can therefore leave invalid protocol evidence and still inherit runtime exit 0 success. | Adopt fail-closed presence semantics in C3/V3. |
| E2 | P1 | Existing route Todos store only the issue identifier. Replacing `stableTarget` changes their fingerprint, which can duplicate open Todos and lose historical recurrence identity. | Compute a legacy fingerprint alias and migrate/recur only when registry/project/anchor/stage evidence maps uniquely; ambiguity stays open. Fold into C4/V4. |
| E3 | P1 | The first independent evidence pass found inherited `AUTO_SWEEP_*` keys outside the original design. | Scrub both parent and parsed `.env` card identity before applying the exact pick overlay (S8/C7/V7). |
| E4 | P2 | The rollout checklist named V1-V6 after V7 was added. | Correct the gate to V1-V7; no verification obligation may be omitted. |

All four decisions auto-select the complete, fail-closed option under the
unattended spec-sweep override. No unresolved engineering decision remains.

### Failure modes and proof shape

```text
trusted pick + clean child env
          |
          v
scheduled repo-status ---- contradiction/live change ----> bounded deferred file
          |                                               |
          | ready / not-routed                            v
          +--------------------------------------> parent presence validator
                                                          |
                                  invalid present --------+-------- exact valid
                                         |                             |
                              failed child protocol             route failure
                                         |                             |
                                         +----------+------------------+
                                                    v
                             exact workspace/card/stage current failure
                                                    |
                           matching current wins <--+--> later exact recovery
```

The tests must cover success, absent evidence, corrupt evidence, unsupported
evidence, changed live state, cross-card/stage isolation, same-tick precedence,
legacy continuity, cross-workspace isolation, and secret-safe diagnostics. Parallel implementation is
safe only between the CLI unit and test-fixture preparation; parent outcome,
environment, and recovery wiring share `linear-watch.mjs` and should remain
sequential.

## DevEx review — DX TRIAGE

### Developer perspective

**Persona:** the maintainer or scheduled-run operator diagnosing a cross-runtime
board sweep. They encounter `repo-status` through a child log or failure Todo,
expect deterministic JSON/exit codes, and need to decide within one tick whether
the card was safely deferred or the child violated its protocol.

I start from a scheduled child log, not a marketing quick start. The current
command prints compact JSON on a live route result, but configuration or argument
errors fall into a generic `unreadable` outcome, and the parent silently treats a
malformed present file like no file. I can see that material work stopped, yet I
cannot tell whether Linear changed, the scheduled context contradicted itself,
or the child wrote untrusted evidence. The planned contract fixes the first-run
path: non-routed misuse succeeds with `eligible:true` and `reason:not-routed`;
routed success stays `ready`; real live changes remain exit 3; and protocol
contradictions become one named failed-child result with trusted expected values.
I stay in the terminal or Todo and know both what happened and that retrying a
later healthy tick is the recovery path.

### Journey and magical moment

This is an enhancement to an internal CLI, so DX TRIAGE is the recommended mode.
Competitive onboarding and a public sandbox are not applicable. The magical
moment is deterministic diagnosis in one log entry: command JSON, exit code,
parent classification, and Todo target all agree without opening config or
guessing which environment value won.

| Stage | Operator does | Required result | Status |
| --- | --- | --- | --- |
| Install | Uses the existing kit and Node 18+ setup. | No new dependency or setup step. | Reused |
| First run | Scheduled child invokes `repo-status`. | Stable JSON plus exit 0/2/3; non-routed misuse does no I/O. | Specified |
| Debug | Reads child log or failure Todo. | Problem, bounded cause/reason, trusted expected identity, and next healthy-tick recovery rule. | Specified |
| Upgrade | Pulls the next patch release. | README/changelog/version describe the changed scheduled contract; attended CLI remains compatible. | Specified |

### Eight-pass scorecard

| Pass | Score | Evidence and disposition |
| --- | ---: | --- |
| Getting started | 9/10 | Existing installation is unchanged; the first relevant command now has a deterministic non-routed result and no network call. |
| API/CLI design | 9/10 | Existing command and 0/2/3 exit grammar remain; scheduled authority becomes opinionated while attended explicit use remains the escape hatch. |
| Error messages | 8/10 | Three traced paths are named: harmless non-routed, live route change, and invalid child protocol. Implementation includes trusted expected identity and a bounded reason, not raw payloads. |
| Documentation | 8/10 | README, changelog, design, and exact command fixtures cover the contract; no new guide hierarchy is warranted. |
| Upgrade path | 9/10 | Patch release, unchanged attended mode, and explicit rollback preserve compatibility. |
| Developer environment | 9/10 | Node-only, CI-safe, non-interactive, and no new dependency or external I/O. |
| Community/ecosystem | 8/10 | Open repository and existing contribution/test flow are unchanged; no ecosystem surface is added. |
| Measurement | 10/10 | Factory Learning already measures the exact seven-day transition count with baseline 5 and target 0. |

**Overall: 8.8/10. TTHW: not applicable to this internal maintenance command.**
No adoption-blocking DX debt remains. The implementation checklist is the
CLI/output assertions in V1-V3, secret-safe Todo diagnostics in V3-V4, the
patch release docs in S6, and post-ship measurement in V6. No separate
separate follow-up debt item is justified.

### DevEx implementation tasks

- [ ] **DX1 (P1, human: ~1h / Codex: ~10min)** — CLI/outcome diagnostics —
  preserve stable JSON and 0/2/3 exits, distinguish every present invalid file,
  and include bounded trusted context without raw payloads.
  - Surfaced by: API/CLI and Error Messages passes.
  - Files: `scripts/linear.mjs`, `scripts/linear-watch.mjs`, corresponding tests.
  - Verify: V1-V3 focused tests.
- [ ] **DX2 (P2, human: ~30min / Codex: ~5min)** — operator docs — describe
  scheduled versus attended route authority and exact recovery in release docs.
  - Surfaced by: Documentation and Upgrade passes.
  - Files: `README.md`, `CHANGELOG.md`, `VERSION`.
  - Verify: doc assertions and full test suite.

No unresolved DevEx decision remains.

## Independent adversarial premise review

The Tier 2 independent reviewer traced the design against the launcher and tests.
The configured preferred Claude reviewer could not be explicitly dispatched by
this runtime, so an independent Codex subagent performed the read-only pass; this
runtime limitation is recorded rather than treated as cross-model agreement.

| # | Priority | Challenged premise | Correction folded into this design |
| --- | --- | --- | --- |
| A1 | P1 | `{ projectId, sweep, issueIdentifier }` collides when two source workspaces with the same basename share a project/card/stage. | Add the deterministic non-path `sourceWorkspaceId` to `stableTarget`; V4 uses the repository's existing two-workspace isolation pattern for both fingerprint and recovery. |
| A2 | P1 | Replacing `stableTarget` changes the fingerprint before reconciliation, duplicating open Todos and losing Done-history recurrence. | Resolve a uniquely proven legacy fingerprint alias before create/update and recovered-history checks; never alias an ambiguous basename/project. |
| A3 | P1 | “Bounded reason and matches” did not define a falsifiable trust schema or generic malformed-file behavior. | Close the 64 KiB top-level/routing schema, reason/exit/cardinality/membership rules, normalization, and valid-dependency compatibility in C3/V3. |
| A4 | P2 | A child route failure is reconciled immediately and again in final tick reconciliation. | V4 now requires one mutation and zero recovery/recurrence events across both points. |

All findings were accepted because each closes a safety or evidence-continuity
gap without expanding the product surface. The reviewer found no additional
material gap in scheduled non-routed behavior, routed CLI authority,
environment scrubbing, claim/dependency safety, performance classification, or
the one-repo rollout. No unresolved adversarial finding remains.

# COD-295 Spec Handoff Verification Gate Design

## Problem

Factory Learning observed two `bounce/missing-design` events between
2026-07-11 and 2026-07-14, one in this project and one in a registered
SafeTaper workspace. The local occurrence is concrete: COD-288 reached Dev with
post-rollout artifacts that omitted `verification-contract/v1`, and Dev's
existing validator correctly returned `post-rollout-missing-contract` before
implementation.

The safety gate worked, but it ran one stage too late. Spec-sweep already tells
the author to write verification declarations and traceability, while
`scripts/verification-contract.mjs` parses and validates the exact spec/plan
pair. Spec-sweep does not require that executable validator to pass before it
commits the artifacts and moves the card to Dev. Its terminal gate is therefore
prose-only, and a plausible-looking but structurally invalid pair can escape it.

Adversarial review exposed a second producer-quality defect in that existing
validator. It searches for the correctness table only after the `Verification
contract` heading. Canonical specs place `Correctness contract` before
`Verification contract`, so the validator can silently see zero C rows and
accept obligations whose source column names no correctness invariant. The
current unit fixture puts the declaration before both sections and does not
exercise realistic artifact order.

This design moves the existing executable proof to the producer boundary. It
does not weaken or remove Dev's independent defense.

## Evidence and existing mechanisms

| Evidence | What it proves |
| --- | --- |
| `skills/spec-sweep/SKILL.md:65,79,90-101` | Spec owns the declaration, obligation table, plan mapping, terminal review, landing, and Dev move, but currently names no executable artifact check. |
| `scripts/verification-contract.mjs:90-143` | The parser detects missing declarations, duplicate/invalid IDs, incomplete obligations, and missing/duplicate correctness sources. |
| `scripts/verification-contract.mjs:63-75,90-130` | Verification-section scoping is reused for all tables, so a correctness table before that section is invisible and exact C-to-V sourcing can false-green. |
| `scripts/verification-contract.mjs:185-246` | One existing function validates exact spec/plan agreement and plan traceability; a surgical parser correction can preserve this interface. |
| `scripts/verification-contract.mjs:260-269` | The existing CLI is deterministic: exit 0 only for a valid pair and exit 2 with bounded JSON diagnostics otherwise. |
| `scripts/linear-watch.mjs:1569,1616,6282-6316,6708-6749` | The launcher already owns an issue-bound child outcome path and gives recognized outcomes precedence over a runtime attempt; it needs one bounded terminal kind. |
| `scripts/linear-watch.mjs:6049-6097,7325+` | Self-update can refresh installed skills and continue dispatch in the same old in-memory process, so outcome-reader activation needs an explicit compatibility boundary. |
| `skills/dev-sweep/SKILL.md:45` | Dev already runs this validator and bounces invalid post-rollout artifacts as `missing-design`. |
| COD-288 comment at `2026-07-14T12:36:41.970Z` | The real local bounce was caused by `post-rollout-missing-contract`; no code had been changed. |
| Commit `b6f7c8f` | Repairing COD-288 added the missing declarations, current table shapes, exact C-to-V sourcing, and complete V traceability. |

No unfamiliar external API or integration is involved, so external research is
not required.

## Goals

1. Require Spec-sweep to run the existing verification-contract validator on
   the final exact spec/plan pair before committing either artifact or moving
   the card to Dev.
2. Correct the validator so realistic canonical section order still enforces
   every correctness C ID exactly once across verification sources.
3. Use the launcher-source kit helper in scheduled runs so a card branch cannot
   replace the executable gate; provide an explicit repository helper path for
   attended runs where no kit path exists. The launcher source is the authority
   already executing the child; this design does not make the stronger,
   unproven claim that it always equals `registry.kitPath`.
4. Treat every nonzero result, unreadable helper, or incomplete result as a
   failed terminal gate. Repair author-owned artifact defects in Spec and rerun;
   never advance on a warning or partial read.
5. Keep owner-only questions on the existing single-comment blocked path. In an
   unattended run, write one issue-bound child outcome to the launcher-owned
   outcome path so the launcher's deduplicated failure reconciliation owns
   machine/tool retry evidence instead of posting a repeated card comment.
6. Prevent the first self-update tick from pairing a refreshed producer skill
   with an old in-memory outcome consumer: new launchers advertise capability,
   the skill checks it before material work, and future kit changes end the tick
   before refreshing or dispatching skills.
7. Preserve Dev's validator, `bounce/missing-design` evidence, review/test-gap
   evidence, QA, Signoff, and human Ship for generated cards.
8. Reduce the generated card's `specBounceCount` from the baseline of 2 to the
   target of 0 during the declared 14-day evaluation window without suppressing
   qualifying evidence.

## Non-goals

- Replacing, relaxing, or removing the Dev verification-contract gate.
- Suppressing a real `bounce/missing-design` event when an invalid artifact still
  reaches Dev.
- Building a generalized validator for scope, correctness, performance,
  security, or future contracts. The existing verification parser receives only
  the narrow realistic-section-order correction needed for its stated contract.
- Reclassifying every prose design defect as mechanically detectable.
- Changing Factory Learning detector thresholds, metrics, evidence identity,
  evaluation windows, or recurrence rules.
- Changing claim ownership, queue selection, repository routing, dependency
  handling, QA, Signoff, Ship, or fast-path rules.
- Treating arbitrary review findings as dispatch failures. The new child outcome
  is only for a terminal machine failure after the Spec claim is closed.
- Touching any SafeTaper sibling repository. Its event is evidence for the
  cross-runtime kit fix, not authorization for a cross-repo change.

## Options considered

### A. Run the existing validator at the Spec producer boundary (recommended)

ELI10: check the ticket before putting it in the next team's inbox, using the
same scanner that the next team already trusts.

**Completeness: 10/10.** This prevents the observed structural defect from
leaving Spec, fixes the parser false green that would undermine the new gate,
preserves Dev's second check, and remains a bounded workflow/parser/test/release
change.

### B. Strengthen the terminal gate prose only

ELI10: add a brighter reminder to inspect the ticket by eye.

**Completeness: 5/10.** It is small, but COD-288 already passed a prose gate
despite explicit contract instructions. More prose cannot prove table identity,
stable IDs, exact correctness sourcing, or spec/plan agreement.

### C. Build one validator for every versioned contract

ELI10: replace the scanner with a new machine that checks every kind of ticket.

**Completeness: 8/10 for a larger future program, 6/10 for COD-295.** It could
eventually cover more omissions, but there is no existing executable schema for
all contracts. It expands this measured verification-contract regression into a
new protocol and risks delaying the direct fix.

Decision: adopt A. Keep a future all-contract validator out of scope until
evidence identifies a concrete unsupported defect and its contract has a stable
machine-readable schema.

## Design

### 1. Add one executable pre-landing gate

After the completed plan, all required reviews, contract reconciliation, and
canonical-doc updates, but before the first artifact commit, Spec-sweep runs:

```text
final spec + final plan
          |
          v
launcher-source verification-contract validator
          |
          +-- exit 0 + readable valid result --> existing docs-only landing
          |
          +-- nonzero/unreadable/missing ------> remain in Spec
                                                   |
                                                   +-- author-owned defect: repair, review affected rows, rerun
                                                   +-- owner-only fact: one numbered question comment
                                                   +-- machine failure: release claim, write launcher outcome
                                                                         |
                                                                         v
                                                              launcher reconciliation
```

The gate consumes the exact paths about to be linked in the Linear handoff. It
does not search for “the latest” artifact and does not validate copies from a
different worktree.

For a scheduled child, the executable is the launcher-source
`$AUTO_SWEEP_KIT_PATH/scripts/verification-contract.mjs`; `KIT_ROOT` is exported
by the running launcher at `scripts/linear-watch.mjs:1595-1602`. This is the
authority already controlling child dispatch, not a new claim that it always
equals the registry's configured update checkout. Invoke the regular, readable
file through Node:

```bash
node "$AUTO_SWEEP_KIT_PATH/scripts/verification-contract.mjs" validate \
  --spec "$SPEC_PATH" --plan "$PLAN_PATH"
```

For an attended run with no kit path, use the configured anchor's
`scripts/verification-contract.mjs` only when it is a regular readable file,
also through `node` with quoted exact paths. If neither source is available,
fail the terminal gate. Never fall through to a path selected by card text.

### 2. Make correctness sourcing real for canonical section order

Keep verification-obligation and plan-traceability scoping unchanged. Give the
correctness table its own section start derived from the `Correctness contract`
heading, rather than reusing the later Verification start. A required spec with
C rows before Verification must therefore reject a missing or duplicate C source
exactly as the existing synthetic-order fixture intends.

Add a realistic-order fixture with:

1. `## Correctness contract` and C rows;
2. `## Verification contract`, its declaration, and V obligations; and
3. a matching plan traceability table.

The green fixture passes, replacing all source cells with `none` fails
`missing-correctness-source`, and repeating one source fails
`duplicate-correctness-source`. The concrete COD-295 spec/plan pair is also run
through the CLI after every review repair.

### 3. Repair before handoff, fail closed otherwise

Exit 0 is necessary but not sufficient as an opaque process status: the command
must print readable JSON with `ok: true`. A nonzero status, invalid JSON,
`ok !== true`, missing helper, signal, or unreadable artifact is a failed gate.

When diagnostics name an author-owned artifact omission, Spec-sweep:

1. emits the existing `review/test-gap` evidence for each verified material
   omission;
2. repairs the spec and/or plan;
3. reruns any review whose reviewed premise or proof mapping changed;
4. reruns the validator against the same final paths; and
5. advances only after the result is readable and green.

If the repair needs an owner-only policy or fact, use the existing single
numbered `blocked:open-questions` comment and leave the card in Spec. If the
helper itself cannot run during a scheduled child, emit the bounded terminal
failure, close/release only the owned Spec claim, and run the exact
launcher-source command
`node "$AUTO_SWEEP_KIT_PATH/scripts/linear-watch.mjs" child-outcome terminal-failed verification-contract-gate`.
That command accepts no other kind or reason; it exclusively and idempotently
writes the issue-bound v1
outcome to `AUTO_SWEEP_OUTCOME_PATH`; a conflicting pre-existing outcome fails
closed. The launcher recognizes the outcome even when the enclosing Codex or
Claude process returns zero, maps it to the bounded
`VERIFICATION_CONTRACT_GATE` non-success result while retaining the actual
attempt metadata, classifies it as a dispatch failure, and runs its
existing deduplicated failure-Todo reconciliation. The card remains in Spec
without a human label or repeated card comment. An attended run may leave one
bounded card comment because no scheduled launcher owns that failure channel.

### 4. Activate producer and consumer together

The new launcher scrubs any inherited value and exports its own
`AUTO_SWEEP_CHILD_OUTCOME_VERSION=1`. The refreshed Spec skill checks for that
exact capability immediately after routing and dependency preflight, before
creating or editing artifacts. If it is absent, the skill leaves the card in
Spec, writes no failure comment or human-block label, and classifies the local
branch with the same clean/pushed proof used by launcher recovery:

- absent, dirty, unreadable, unpushed, or ahead worktrees keep the exact claim;
  old successful-same-state recovery creates/updates its one stable resume
  marker and blocks same-tick reselection, and the capable next process resumes
  the same declaration;
- a worktree proven clean and fully pushed cannot be retained by old recovery,
  so the skill exclusively/idempotently writes an issue-bound v1
  `dependency-deferred` compatibility envelope with exit code 3 and reason
  `launcher-capability`. The old reader already recognizes that envelope,
  releases the now-reproducible claim once, and stops draining. The skill does
  not close the claim before writing this compatibility record. It is transport
  compatibility only: it creates no Linear dependency/relation/blocker. The
  capable next process creates one fresh declaration.

The bounded compatibility writer is a constant Node snippet from the installed
skill; it consumes only `AUTO_SWEEP_OUTCOME_PATH` and `AUTO_SWEEP_ISSUE`, uses
exclusive-create plus exact-record idempotence, and rejects every conflict. This
bootstraps safely even when an old in-memory launcher's on-disk helper lacks the
new `child-outcome` command.

For future self-updates, `runUpdate` reports that the kit HEAD changed and does
not copy refreshed skills during that process. The tick records the update and
ends before anchor resolution or dispatch. The next scheduled process loads the
new launcher code, sees no further kit change, refreshes installed skills, and
only then dispatches them with the matching capability. Tests cover both the
bootstrap capability deferral and the kit-change no-refresh/no-dispatch boundary.

### 5. Preserve the downstream defense and honest metric

Dev continues to run `scripts/verification-contract.mjs` from the checked-out
target repository after the artifacts have landed on origin. This catches
post-landing corruption, updater skew, history classification failures, and any
Spec regression that bypasses the new instruction.

If Dev still finds invalid design, it must retain the current
`bounce/missing-design` event and card move. COD-295 succeeds by eliminating the
producer defect, not by muting the detector. Review omissions found while still
in Spec remain `review/test-gap` evidence so quality learning is not erased.

### 6. Ship the cross-runtime instruction everywhere

The implementation updates both byte-identical Spec skill copies:

- `skills/spec-sweep/SKILL.md`
- `.claude/skills/spec-sweep/SKILL.md`

`tests/spec-sweep-doc.test.mjs` proves parity, ordering, launcher-source helper
selection, Node invocation, exact quoted paths, and fail-closed handoff.
`tests/verification-contract.test.mjs` owns the realistic-order parser regression
and the rest of the validator semantics; do not duplicate parser fixtures in the
doc test.

Because installed workspaces receive skill changes through the versioned kit
updater, implementation also updates `README.md`, `CHANGELOG.md`, and `VERSION`,
then runs the existing updater integration proof. No new artifact or publish
channel is introduced.

## Correctness contract

Correctness contract: correctness-contract/v1 — required — COD-295 changes a
cross-runtime safety gate, executable trust source, failure behavior, workflow
transition eligibility, and installed distribution.

| ID | Trigger / transition | Required invariant | Forbidden outcome | Recovery / ownership | Verification |
| --- | --- | --- | --- | --- | --- |
| C1 | Spec-sweep selects the final spec/plan pair for handoff | The validator consumes quoted exact paths through Node and the scheduled run uses the launcher-source kit helper; attended fallback is explicit and bounded. | Directly executing the non-executable helper, searching another artifact, using a card-selected path, or claiming unproven registry equality. | Fail before landing; keep the card in Spec and route scheduled machine evidence through launcher reconciliation. | V1 |
| C2 | The terminal review gate completes | Commit and Dev move remain ineligible until the validator exits 0 and returns readable `ok: true`. | A warning, malformed output, process signal, missing helper, or partial read advances the card. | Repair or fail the Spec attempt; never commit/move on an unproven result. | V2 |
| C3 | A canonical spec places correctness before verification | The parser sees every C row and requires each C ID exactly once across V sources before Spec repairs/revalidates the pair. | Zero visible C rows false-green, missing/duplicate C sources pass, or only one artifact is accepted. | Spec owns repair; owner-only facts use the established question path. | V2 |
| C4 | The gate cannot become green or the launcher lacks outcome capability | COD-295 stays in Spec. Capability absence retains exact resume identity unless clean+pushed proof requires one old-compatible deferral and fresh next claim; capable terminal failure closes/releases then writes an issue-bound terminal outcome. Only genuine owner dependencies get `blocked:open-questions`. | Producer/consumer skew, same-tick redispatch/claim churn, false Linear dependency, moving to Dev, terminal claim leak, relying on agent exit, human-blocking machine failure, or repeated failure comments. | Bootstrap matrix uses resume or transport-only compatibility deferral; update boundary prevents future skew; terminal outcome drives deduplicated retry evidence after close. | V3 |
| C5 | A later Dev run validates landed artifacts | Dev's independent validator and honest `bounce/missing-design`/review evidence remain unchanged. | Removing or bypassing the downstream gate, or suppressing qualifying evidence to improve the metric. | Dev fails closed and bounces exactly as today. | V4 |
| C6 | The kit release is installed into registered workspaces | Canonical and installed Spec skill bytes match, the version changes once, and updater verification activates the launcher consumer before the new producer skill dispatches. | Updating only one runtime copy, producer-before-consumer dispatch, or shipping docs without distribution evidence. | Capability/bootstrap and restart boundary fail closed; release verification blocks Ship; external publication remains attended. | V5 |

## Scope closure

Scope closure: scope-closure/v1 — required — this changes Spec handoff
eligibility, executable trust, failure/recovery behavior, quality evidence,
installed instructions, and the acceptance measurement.

### Scope closure inventory

| ID | Surface and evidence | Required outcome | Owning repo/module | Closure proof |
| --- | --- | --- | --- | --- |
| S1 | Spec artifact production and terminal move in `skills/spec-sweep/SKILL.md:58-101` | Run one exact-pair executable gate after final reconciliation and before commit/move. | `linear-board-sweeps` / canonical + installed Spec skills | Doc test proves ordering and both copies are byte-identical. |
| S2 | Parser/CLI in `scripts/verification-contract.mjs:63-75,90-269` | Give correctness its own section start, preserve the public CLI, and invoke it through Node from explicit launcher-source/attended paths. | `linear-board-sweeps` / validator + tests + Spec instruction | Realistic-order missing/duplicate-source fixtures, concrete COD-295 CLI, and doc command/path assertions. |
| S3 | Invalid proof or producer/consumer version skew | Require launcher-written capability before material work; scrub inherited value; capability absence uses exact resume for non-clean-pushed states or one old-compatible deferral for clean+pushed, blocking same-tick reselection; kit HEAD change ends old-code tick before refresh/dispatch. Capable terminal failure closes then writes outcome. | `linear-board-sweeps` / update boundary + dispatch env/resume + Spec compatibility/terminal flow | Old-launcher full-drain matrix proves one dispatch for absent/dirty/unpushed/clean-pushed states and correct same/fresh next declaration; launcher tests prove scrub/export, kit-change stop, exclusive writes, success/capacity precedence, and Todo classification; doc test proves no false Linear blocker. |
| S4 | Dev defense and learning evidence in `skills/dev-sweep/SKILL.md:45,58` | Preserve downstream validation, bounce, and review evidence unchanged. | `linear-board-sweeps` / Dev skill + Factory Learning | Regression assertions keep Dev gate/event wording; targeted diff confirms no detector change. |
| S5 | Installed cross-runtime distribution | Update skill copies, operator/release docs, and VERSION; prove producer/consumer activation ordering and updater parity. | `linear-board-sweeps` / launcher, skills, docs, updater | Kit-change restart-boundary test, capability handshake, skill parity, updater integration, version uniqueness checks, full suite. |
| S6 | Generated-card metric and workflow | Observe target 0 over 14 days while retaining QA, Signoff, human Ship, and honest future bounces. | Factory Learning / existing evaluator and owner workflow | Dry-run/status evidence plus QA handoff confirms generated-card rules; no evaluator code change. |

Bidirectional self-check: every goal, correctness row, failure mode, release
step, acceptance measure, and predicted implementation file maps to S1-S6. No
row assigns work outside configured repo `linear-board-sweeps`, and the SafeTaper
workspace remains evidence-only. The initial inventory included all material
surfaces; no pre-review `review/scope-gap` event was required.

## Verification contract

Verification contract: verification-contract/v1 — required — workflow behavior,
error handling, executable provenance, compatibility, distribution, and the
observable no-bounce outcome change.

### Verification obligations

| ID | Source requirement / C ID(s) | Behavior / risk | Failure this proof must catch | Required proof | Acceptance |
| --- | --- | --- | --- | --- | --- |
| V1 | C1 | Exact paths and executable selection | Scheduled work directly executes a mode-100644 file, selects a card/worktree helper, claims registry provenance it did not prove, or validates another artifact. | Canonical doc test requires `node` plus quoted exact args, launcher-source kit path, bounded attended fallback, and no latest-file search. | The whole `tests/spec-sweep-doc.test.mjs` file passes the command/path assertions. |
| V2 | C2, C3 | Green-only eligibility, realistic C sourcing, and repair loop | Canonical section order hides every C row; missing/duplicate C sources, nonzero, malformed, or `ok:false` reaches landing. | Realistic-order parser fixtures, full doc test, existing validator suite, and an explicit CLI run against the concrete COD-295 pair after review repairs. | All commands pass and CLI reports V1-V5 with no diagnostics. |
| V3 | C4 | Failure state, rollout compatibility, and claim ownership | Old consumer redispatches/claim-churns any worktree state, compatibility envelope creates a false blocker, new skill mutates without capability, kit-change tick dispatches, runtime success/capacity logs erase failure, card moves, terminal claim remains, or machine failure gets human label. | Old-launcher full-drain matrix proves one dispatch: same resume declaration for absent/dirty/unpushed and one release plus fresh next declaration for clean+pushed, with no Linear relation/label; launcher tests prove kit-change stop, terminal outcome precedence over exit 0/quota/rate-limit/overload, and Todo classification; doc test asserts exact writers and terminal close ordering. | Named launcher and doc rollout/failure assertions pass. |
| V4 | C5 | Defense in depth and honest learning | Implementation removes Dev gate or bounce/test-gap evidence to make `specBounceCount` appear lower. | Regression assertions read Dev skill for validator plus `missing-design` and read Spec skill for retained `review/test-gap`; selective diff excludes learning detector changes. | Doc suites pass and diff inspection shows no detector/evaluator edit. |
| V5 | C6 | Cross-runtime release parity | Only one skill copy ships, version is reused, or updater misses the gate/outcome command. | Skill byte-parity assertion, VERSION uniqueness/equality checks, updater integration test, CLI help assertion, and full repository suite. | Both copies match, new version is unique, updater proof and full suite pass. |

## Performance contract

Performance contract: performance-contract/v1 — not required — the success path
adds one local Node process over two already-produced Markdown files before a
docs-only landing; only a terminal machine-failure path adds the bounded outcome
writer, while one bootstrap-only clean/pushed path adds the compatibility writer.
It adds no service request, database query, network/storage fan-out,
retry loop, background cadence, user latency path, or unbounded data structure.
Existing validator input size remains the repository artifact size.

## Review depth decision

- **Predicted implementation footprint:** ten files: validator + validator
  tests, launcher + launcher tests, both Spec skill copies, Spec doc tests,
  `README.md`, `CHANGELOG.md`, and `VERSION`; approximately 280-450 changed
  lines, with no new module, dependency,
  or service.
- **Behavior/state:** changes Spec-to-Dev transition eligibility and failure
  handling but reuses established claim, comment, validator, and updater flows.
- **Persistence/interfaces:** no schema or public API; only canonical skill text,
  tests, docs, and release marker change.
- **Risk:** cross-runtime instruction skew, branch-shadowed executable selection,
  false green on malformed output, and accidental evidence suppression.
- **Initial tier:** Tier 1, plan-target. The desired behavior and architecture were
  bounded by an existing validator; uncertainty is in exact file ordering,
  failure-path wording, test ownership, and distribution proof.
- **Escalation:** the plan/adversarial review exposed a false-green parser premise,
  making validator semantics plus cross-runtime orchestration materially
  interacting modules. Final Tier 2 requires both spec and plan engineering
  passes plus independent premise/proof review.
- **Specialized lenses:** UI/design skipped (no UI); DevEx skipped (no public
  API/CLI/SDK ergonomics change); security skipped as a heavyweight lens because
  no auth, secret, data, or external-input surface changes, while the engineering
  review must still challenge executable provenance; performance skipped because
  the not-required rationale above is concrete. Research skipped because the
  change uses only repository-owned mechanisms.

The final tier may increase after plan generation but may not decrease.

## Failure modes

| Failure | Required response |
| --- | --- |
| Scheduled kit helper is missing or unreadable | Fail the terminal gate, emit terminal failed, close/release the exact claim, write and verify the issue-bound child outcome, and remain in Spec; launcher deduplicates failure evidence even if the runtime exits zero. |
| Child outcome is missing, conflicting, or unreadable | Do not claim launcher reconciliation occurred; fail closed and preserve local run evidence for operator recovery. |
| Correctness table precedes verification | Its own section start finds C rows; realistic-order tests reject missing/duplicate sources. |
| Validator exits nonzero with diagnostics | Emit applicable review/test-gap evidence, repair author-owned rows, reconcile affected review, rerun exact paths. |
| Validator exits 0 with malformed or non-green JSON | Treat as failed/unreadable, never land. |
| Only one artifact is valid | The pair remains invalid; repair and rerun both exact paths. |
| Owner policy is required to complete an obligation | Use one numbered card comment and `blocked:open-questions`; do not guess. |
| Card leaves Spec while docs are being prepared | Landed docs may be reported, but do not override the human state; close/release only the owned claim. |
| Dev later rejects the landed pair | Preserve the existing bounce and evidence; COD-295 has exposed a remaining producer defect. |

## Acceptance and rollout

Implementation lands only in `linear-board-sweeps`. There is no production app
deploy. The versioned kit updater distributes the changed canonical skill to
registered workspaces after merge; external release publishing remains attended
owner work. Because this is `factory:learning-generated`, QA must route it to
Signoff, and only a human may move it to Ship.

After Done, the existing Factory Learning evaluator measures the card's declared
`specBounceCount` over 14 days. Success is zero qualifying missing-design bounces
with complete coverage. Any real bounce remains evidence and can make the result
no-change, regression, or inconclusive; the implementation does not special-case
COD-295 in the detector or evaluator.

## Schema & architecture impact

No database, storage schema, public API, service, or deploy target changes. The
architecture change is one planned producer-side validation gate in the
cross-runtime Spec workflow, reusing the existing verification-contract CLI and
retaining Dev's consumer-side defense. README records this as planned COD-295
work until Dev ships it.

## Tier 2 engineering decisions

The reconciled spec pass and implementation-plan pass cover the complete
ten-file scope, control flow, failure recovery, test ownership, release
boundary, and generated-card rollout. The selected decisions are:

| Decision | Chosen approach | Alternatives rejected | Why |
| --- | --- | --- | --- |
| Producer proof | Correct the existing parser, then run that exact-pair validator before Spec landing. | Prose-only gate; generalized all-contract validator. | Completeness 10/10 versus 5/10 and 6/10: it closes the observed escape and the review-discovered false green without inventing a new artifact protocol. |
| Executable authority | Invoke the helper from launcher-source `AUTO_SWEEP_KIT_PATH`; use one configured-repo fallback only when attended. | Require equality with registry update checkout; use a card/worktree-selected helper. | The launcher already controls the child, while registry equality is neither guaranteed nor necessary and card-controlled code is outside the authority boundary. |
| Scheduled failure evidence | Require consumer capability before material work; close/release the exact claim, write a launcher-readable `terminal-failed` outcome with the exact Node command, and let launcher reconciliation deduplicate retry evidence. | Rely on agent process exit; producer-before-consumer rollout; repeated card comments; human-block label. | Cross-runtime agents cannot guarantee enclosing process exit, while capability/bootstrap plus the update boundary makes the existing issue-bound launcher channel reachable. |
| Release version proof | Compute the next patch from every live remote ref and recheck immediately before commit. | Read only `origin/main`; reuse the current marker. | Active release branches can already consume a marker, so main-only inspection cannot prove uniqueness. |

Spec-pass result: **clear**. Plan-pass result: **clear**. The parser change is
surgical, all six correctness invariants map exactly once to V1-V5, every
implementation file has an owning task, negative paths have explicit outcomes,
and no unrelated refactor, service, dependency, data migration, or deploy was
introduced.

## Spec-sweep review audit

| Item | Decision / outcome |
| --- | --- |
| Initial tier | Tier 1, plan-target; escalated to final Tier 2 after plan/adversarial review exposed the false-green parser premise. |
| Predicted footprint | Ten files, no new module or dependency. |
| Risk surfaces | Transition eligibility, producer/consumer activation order, executable provenance, fail-closed output parsing, capacity inference, installed parity, honest evidence. |
| Engineering spec pass | Clear with split bootstrap recovery: exact resume for non-clean-pushed and old-compatible one-pass deferral for clean+pushed, without expanding ten-file scope. |
| Engineering plan pass | Clear with full worktree-state drain matrix, same/fresh next-declaration assertions, exact writers, and capacity precedence tests. |
| Independent adversarial review | Clear after five corrective follow-ups; final pass verified old-reader compatibility, one-pass drain behavior, same/fresh declaration recovery, all prior proofs, mappings, and ten-file ownership. |
| UI/design lens | Confirmed skipped: no user interface, interaction, accessibility, or visual change. |
| DevEx lens | Confirmed skipped: no public API, CLI, SDK, documentation adoption flow, or compatibility surface. |
| Security lens | Confirmed skipped as specialized review: no auth/data/secret/external-input surface; Tier 2 engineering review resolved executable provenance. |
| Performance lens | Confirmed skipped: one bounded success-path process plus bootstrap/failure-only outcome writers, no material performance surface. |
| Research lens | Skipped: repository-owned mechanism only. |
| Current outcome | Final Tier 2 spec, plan, and independent adversarial passes are clear with no unresolved decisions. |

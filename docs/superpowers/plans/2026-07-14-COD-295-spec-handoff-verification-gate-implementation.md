# COD-295 Spec Handoff Verification Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent structurally invalid verification-contract artifacts from
leaving Spec by running the existing exact-pair validator from the launcher's
source root before landing,
while preserving Dev's independent gate and honest Factory Learning evidence.

**Architecture:** First correct the existing parser so canonical section order
cannot hide correctness rows. Then change the canonical/installed Spec workflow
contract and its document tests so the launcher-source validator must return a
readable `ok:true` for the quoted exact pair before landing. Attended runs use
one explicit repository fallback. Scheduled terminal machine failures use an
issue-bound launcher outcome rather than assuming the agent controls its parent
process exit. A capability preflight and kit-change restart boundary prevent a
new producer skill from outrunning its in-memory launcher consumer. Versioned
operator/release docs distribute the cross-runtime gate.

**Tech Stack:** Markdown canonical skills, Node.js 18+ ESM CLI,
`node:test`, git-based versioned kit updater, Linear workflow comments/claims.

## Global constraints

- Own changes only in configured repo `linear-board-sweeps`; the SafeTaper
  contributor is evidence-only.
- Preserve the public verification-contract CLI, but surgically give correctness
  tables their own section start so realistic canonical order enforces exact
  C-to-V sourcing.
- Scheduled runs execute
  `node "$AUTO_SWEEP_KIT_PATH/scripts/verification-contract.mjs"`; this is the
  running launcher's source root exported as `KIT_ROOT`, not an unproven claim
  that it always equals registry `kitPath`. Attended fallback is the configured
  anchor's regular readable `scripts/verification-contract.mjs`, also via Node.
- Validate the exact final spec and plan paths after review reconciliation and
  before artifact commit or Dev move.
- Require process exit 0 and readable JSON `ok: true`; every other state fails
  closed and remains in Spec.
- Repair author-owned artifact defects, rerun affected reviews, and validate
  again. Owner-only facts use one numbered card comment; scheduled machine
  failures close the claim, write a verified `terminal-failed` child outcome,
  and rely on launcher-deduplicated failure reconciliation, with no repeated
  card comment or `blocked:open-questions`.
- Scrub any inherited capability value and export
  `AUTO_SWEEP_CHILD_OUTCOME_VERSION=1` only from a capable launcher. The
  scheduled Spec skill checks it before material work. On absence,
  non-clean-pushed states retain exact resume identity; a clean+pushed state
  writes one old-reader-compatible transport deferral so the old drain stops.
  Neither path adds a failure comment, human label, or Linear dependency.
- When self-update changes kit HEAD, do not refresh anchor skills or dispatch in
  that old in-memory process. The next tick loads the new consumer before
  propagating/dispatching the producer skill.
- Preserve Dev validation, `bounce/missing-design`, `review/test-gap`, QA,
  Signoff, and human Ship for `factory:learning-generated` cards.
- No new dependency, module, parser, detector, evaluator, persistence, label,
  workflow state, service, or production deploy.

---

## Repo scope

- **Owning repo:** `linear-board-sweeps` only.
- **Expected branch:** one Dev branch with `COD-295` in its name.
- **Deploy target:** none. Shipping is merge/push to `main`; external release
  publication is attended owner work.
- **QA evidence:** V1-V5 at the tested full commit, focused launcher/doc/validator
  suites, full repository suite, updater integration, version checks, and
  targeted diff.
- **Workflow:** generated card must go QA -> Signoff -> human-approved Ship.

## File and responsibility map

| File | Responsibility in this change |
| --- | --- |
| `tests/verification-contract.test.mjs` | RED/GREEN realistic-order fixtures proving missing and duplicate C sources fail. |
| `scripts/verification-contract.mjs` | Preserve the CLI while scoping the correctness table from its own heading. |
| `tests/linear-watch.test.mjs` | RED/GREEN update/restart boundary, capability export, child-outcome command, exclusivity/idempotence, issue binding, success/capacity override, and failure classification. |
| `scripts/linear-watch.mjs` | Add the producer/consumer activation boundary, export capability, add the launcher-source `child-outcome terminal-failed` writer, and recognize it after a child returns. |
| `tests/spec-sweep-doc.test.mjs` | RED/GREEN contract for exact paths, launcher-source helper selection, ordering, fail-closed output, repair/review loop, claim/label behavior, Dev defense, and copy parity. |
| `skills/spec-sweep/SKILL.md` | Canonical cross-runtime pre-landing gate and failure/repair procedure. |
| `.claude/skills/spec-sweep/SKILL.md` | Installed byte-identical copy shipped by the updater. |
| `README.md` | Operator-facing shipped behavior and COD-295 workflow-extension status. |
| `CHANGELOG.md` | Release note for the producer-side gate and preserved downstream defense. |
| `VERSION` | Unique four-part patch version that triggers updater distribution. |

No new runtime file is justified. The existing launcher, validator, claim
protocol, learning event, updater, and workflow transition retain ownership.

## What already exists

| Existing mechanism | Reuse decision |
| --- | --- |
| Verification declaration and V traceability prose in `skills/spec-sweep/SKILL.md:65,79` | Keep as the authoring contract; add executable proof after the pair is final. |
| Terminal review and docs-only landing in `skills/spec-sweep/SKILL.md:90-101` | Insert one gate between reconciliation/canonical docs and first commit/move. |
| `scripts/verification-contract.mjs:63-75,90-269` | Preserve its interface and verification/traceability parsing; fix only correctness-section discovery for canonical order. |
| Dev quality gate in `skills/dev-sweep/SKILL.md:45` | Preserve as defense in depth after origin landing. |
| `tests/spec-sweep-doc.test.mjs` | Extend its existing canonical/installed parity and ordering assertions. |
| `tests/verification-contract.test.mjs` | Reuse parser/CLI failure fixtures; do not duplicate validator implementation tests. |
| `AUTO_SWEEP_OUTCOME_PATH` and child outcome ingestion in `scripts/linear-watch.mjs:1569,1616,6282-6316,6708-6749` | Extend the existing launcher-owned, issue-bound outcome channel with one terminal failure kind that outranks a nominal runtime success. |
| Self-update in `scripts/linear-watch.mjs:6049-6097,7325+` | Return a kit-change result, skip skill refresh in the changed process, and stop the tick so the next process loads the matching consumer first. |
| VERSION-triggered updater integration | Reuse for installed skill distribution. |
| Factory Learning `spec-quality-failure/v1` | Preserve detector/evaluator unchanged; it measures real future bounces. |

## NOT in scope

- Generalizing one validator across all versioned contracts; no stable combined
  executable schema exists and the measured regression is verification-specific.
- Changing launcher dispatch authority or requiring `KIT_ROOT === reg.kitPath`;
  the launcher source already controls the child, and COD-295 only executes the
  companion helper from that same authority.
- Editing the validator to understand workflow state or claims; the skill owns
  orchestration, the helper owns artifact semantics.
- Generalizing child outcomes into arbitrary agent-to-launcher messages. Only
  the stable `terminal-failed` kind and bounded reason code are added; bootstrap
  uses one fixed issue-bound record in the old reader's existing deferred wire
  format and does not alter Linear dependency semantics.
- Requiring launcher source to equal registry update checkout. Capability is
  proven by the running launcher environment, not inferred from path equality.
- Removing the Dev gate after adding the Spec gate; post-landing skew and bypass
  still require an independent consumer check.
- Suppressing bounce/review evidence or special-casing COD-295 evaluation.
- Repairing historical cards other than COD-295 or editing SafeTaper repos.
- Refactoring the currently duplicated numbered Spec-sweep prose beyond the
  minimum insertion needed for this behavior; that cleanup is unrelated to the
  observed regression.

## Versioned contract boundary decision

`Versioned contract boundary: versioned-contract-boundary/v1`

Reuse the shared decision first established by the correctness-contract work:
`docs/superpowers/specs/2026-07-10-COD-155-correctness-contract-design.md` was
introduced in commit `4d208c0d7bd161bd15273615d31f5ea6ce47808e`, while the
installed sweep marker was introduced in
`bd467095a1ddb2451aa5271bbef9e876491a5bde`.

```bash
git log --diff-filter=A --format='%H' -- \
  docs/superpowers/specs/2026-07-10-COD-155-correctness-contract-design.md
# 4d208c0d7bd161bd15273615d31f5ea6ce47808e

git log --diff-filter=A --format='%H' -- .claude/skills/.sweep-version
# bd467095a1ddb2451aa5271bbef9e876491a5bde

git merge-base --is-ancestor \
  4d208c0d7bd161bd15273615d31f5ea6ce47808e \
  bd467095a1ddb2451aa5271bbef9e876491a5bde
# exit 1: the reusable artifact is not pre-boundary

git merge-base --is-ancestor \
  bd467095a1ddb2451aa5271bbef9e876491a5bde \
  4d208c0d7bd161bd15273615d31f5ea6ce47808e
# exit 0: histories are comparable and the artifact is post-boundary
```

Current contracts apply. Missing or incomparable history fails closed; no legacy
gate is available to COD-295.

## Contract declarations

- Scope closure: scope-closure/v1 — required — handoff eligibility, executable
  provenance, failure recovery, evidence, installed distribution, and acceptance
  measurement change; S1-S6 map every material surface.
- Correctness contract: correctness-contract/v1 — required — C1-C6 in the
  design own exact input, green-only advancement, repair, claim state, downstream
  defense, and distribution invariants.
- Verification contract: verification-contract/v1 — required — V1-V5 below map
  each correctness row exactly once to deterministic implementation/QA proof.
- Performance contract: performance-contract/v1 — not required — one bounded
  success-path Node process reads two already-produced Markdown files off the
  runtime request path; bootstrap-only and failure-only outcome writers add no network/query/
  storage fan-out or new cadence.

## Scope closure traceability

| ID | Implementing task(s) | Files/modules | Test or assertion | Rollout/owner evidence | Residual risk |
| --- | --- | --- | --- | --- | --- |
| S1 | Task 2 | Spec doc test + canonical/installed skill | Ordering assertion places exact-pair validator after final review reconciliation and before landing/move. | Focused doc suite at tested SHA. | A future skill rewrite must retain the semantic markers tested here. |
| S2 | Tasks 1, 2 | Validator/tests + Spec command contract | Realistic order enforces exact C sourcing; command uses Node, launcher-source/attended regular file, quoted exact paths, exit 0 + readable `ok:true`. | Validator suite, concrete COD-295 CLI, and focused doc assertions. | Attended repo may be stale; Dev's post-origin gate remains. |
| S3 | Task 2 | Launcher activation/outcome + Spec failure/repair flow | Capability absence blocks old redispatch via exact resume for non-clean-pushed or old-compatible deferral for clean+pushed; kit-change tick stops before refresh/dispatch; after terminal close, issue-bound outcome outranks exit 0/capacity logs without human loop. | Old-launcher full-drain matrix plus launcher unit/integration tests, Linear handoff audit, and named doc assertions. | A non-mechanical prose defect can still require reviewer judgment. |
| S4 | Task 2 | Dev/Spec evidence wording | Regression assertions retain Dev validator, `missing-design`, and Spec `review/test-gap`. | Targeted diff excludes detector/evaluator changes. | Defense catches but cannot prevent every future prose defect. |
| S5 | Task 3 | README/CHANGELOG/VERSION/updater | Live-ref version uniqueness, skill byte parity, updater integration, full suite. | Merge/push to main; external publication attended. | Installation timing is outside merge and remains owner-observed. |
| S6 | Task 3 | Existing generated-card workflow/learning | Dry-run/status plus unchanged generated-card labels/fast-path assertions. | QA -> Signoff -> human Ship; 14-day evaluator result. | Real future bounces correctly prevent a zero outcome. |

Every planned task and delivery surface maps to S1-S6. Task 1 makes the validator
truthful, Task 2 adds the producer gate, and Task 3 distributes the combined
change. No human-only release step is silently assigned to the agent, and no work
targets an unconfigured repo.

## Verification traceability

| ID | Implementing task(s) | Test layer and file | RED signal | GREEN command / assertion | QA evidence | Residual gap |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | Task 2 | Doc contract, `tests/spec-sweep-doc.test.mjs` | Canonical skill omits Node, quoted exact args, launcher-source path, or bounded attended fallback. | Run the whole `node --test tests/spec-sweep-doc.test.mjs`; named command/path assertions execute. | Tested SHA plus exact command/path assertions. | Doc test proves the canonical protocol, not a live child process; Dev validates the landed pair independently. |
| V2 | Tasks 1, 2 | Parser/doc unit + concrete CLI, `tests/verification-contract.test.mjs`, `tests/spec-sweep-doc.test.mjs` | Canonical section order hides C rows; missing/duplicate source, nonzero/malformed/`ok:false`, or unreconciled repair reaches landing. | Run both full files, then `node scripts/verification-contract.mjs validate --spec docs/superpowers/specs/2026-07-14-COD-295-spec-handoff-verification-gate-design.md --plan docs/superpowers/plans/2026-07-14-COD-295-spec-handoff-verification-gate-implementation.md`; require `ok:true`, V1-V5, no diagnostics. | Realistic-order reject matrix and final concrete-pair JSON. | Mechanical validator cannot prove every prose premise, so Tier 2 reviews remain mandatory. |
| V3 | Task 2 | Launcher + doc contract, `tests/linear-watch.test.mjs`, `tests/spec-sweep-doc.test.mjs` | Old consumer redispatches any worktree state, compatibility deferral mutates Linear dependency, kit-change tick dispatches, exit 0/capacity logs erase failure, outcome conflicts, card moves/terminal claim remains/repeated failure comment, or machine failure gets human label. | Whole files prove full-drain matrix with same-declaration resume or clean-pushed one-release/fresh-declaration compatibility path, no Linear blocker, kit-change stop, exact writers, exclusive/idempotent issue binding, success/capacity precedence, terminal close-before-write, and label distinction. | Launcher drain/update/run-record/failure decisions plus skill excerpt at tested SHA. | External Linear claim mutations remain covered by existing claim/terminal suites. |
| V4 | Task 2 | Cross-skill regression, `tests/spec-sweep-doc.test.mjs`, `tests/verification-contract-doc.test.mjs` | Dev validator/bounce or Spec test-gap evidence disappears. | Focused doc suites assert all three remain; targeted diff shows no learning detector/evaluator edit. | Skill excerpts and selective diff at tested SHA. | A later unrelated change can alter telemetry; canonical tests guard current release. |
| V5 | Task 3 | Distribution/regression, updater and full suites | Skill copies differ, VERSION collides, updater pairs an old consumer with new producer, misses the gate/outcome command, or full suite regresses. | `cmp`, capability and kit-change boundary assertions, CLI help assertion, live-ref version calculation, updater integration, then `node --test tests/*.test.mjs`; all green. | Version values, activation ordering, command visibility, updater result, suite pass counts, clean diff. | External release publication is attended owner work. |

## Dependency and execution flow

```text
Task 1: RED realistic-order validator fixtures
  -> correctness-section parser fix
  -> validator GREEN + concrete pair
          |
          v
Task 2: RED launcher outcome contract
  -> kit-change restart boundary + capability export GREEN
  -> issue-bound terminal-failed outcome + success/capacity precedence GREEN
  -> RED doc contract
  -> canonical gate + installed parity
  -> focused launcher/doc/validator GREEN
          |
          v
Task 3: operator/release docs + VERSION
  -> updater integration
  -> full suite + dry-run + selective diff
```

All tasks touch the same release unit and are sequential. No worktree
parallelization opportunity is justified.

## Test coverage diagram

```text
SPEC HANDOFF PATHS                                  OPERATOR / WORKFLOW OUTCOMES
[+] self-update kit HEAD changed -----------------> end old-code tick before skill refresh/dispatch
[+] capability absent + non-clean-pushed --------> preserve claim + resume, block reselection
[+] capability absent + clean/pushed ------------> old-compatible deferral, stop drain, fresh next claim
[+] final spec + plan                              [+] valid pair
  |-- exact paths -------------------------------\   |-- validator exit 0
  |-- scheduled kit helper -----------------------+-> |-- readable ok:true
  `-- attended bounded fallback -----------------/   `-- docs land -> Dev

[+] invalid proof                                  [+] author-owned defect
  |-- realistic C section missing source ----------+-> parser diagnostic
  |-- realistic C section duplicate source --------+-> parser diagnostic
  |-- nonzero diagnostic -------------------------+-> repair rows
  |-- exit 0 + malformed JSON --------------------+-> rerun affected review
  |-- exit 0 + ok:false --------------------------+-> rerun same exact pair
  |-- missing/unreadable helper ------------------+-> close claim + terminal-failed outcome
  |                                                  `-> launcher reconciliation despite exit 0/capacity-looking logs
  `-- missing/unreadable artifact ----------------+-> remain Spec + close claim + outcome

[+] owner-only fact -------------------------------> numbered question + human label
[+] later Dev validation --------------------------> unchanged defense/bounce evidence
[+] release ---------------------------------------> parity + VERSION + updater proof
```

Each branch has a named doc assertion or reuses a named validator fixture. No UI,
E2E browser flow, or LLM eval is involved.

### Task 1: Make correctness sourcing work with canonical section order

**Files:**

- Modify: `tests/verification-contract.test.mjs`
- Modify: `scripts/verification-contract.mjs`

**Interfaces:**

- Consumes: Markdown tables plus `## Correctness contract` and
  `## Verification contract` headings.
- Produces: unchanged `parseVerificationArtifact(...)` and CLI result shape, but
  required C IDs are discovered from the correctness section regardless of its
  position before Verification.
- Preserves: verification-obligation scoping, traceability scoping, diagnostic
  codes, rollout history, CLI arguments, exit 0/2 semantics.

- [ ] **Step 1: Write realistic-order failing tests.** Add a helper whose spec
  order matches COD-295: Correctness heading/table first, then Verification
  heading/declaration/obligations. Add named tests proving the green pair passes,
  source `none` yields `missing-correctness-source`, and one C ID in two V rows
  yields `duplicate-correctness-source`.

- [ ] **Step 2: Run the whole validator test file and confirm RED.**

```bash
node --test tests/verification-contract.test.mjs
```

Expected: the file fails on the named missing/duplicate-source assertions
because the current parser filters correctness tables from the later
Verification heading. Running the whole file prevents a zero-match false green.

- [ ] **Step 3: Give correctness its own section start.** Generalize the heading
start helper to accept a heading pattern, compute `correctnessStart` from
`Correctness contract`, and pass that start to correctness-table discovery.
Leave obligation and traceability discovery anchored to Verification. Keep the
first exact-header table behavior and existing duplicate diagnostics unchanged.

Use this shape rather than scanning all tables globally:

```js
function sectionStart(markdown, heading) {
  return markdown.split(/\r?\n/).reduce(
    (startLine, line, index) => heading.test(line) ? index : startLine,
    -1,
  );
}

const verificationStart = sectionStart(
  markdown,
  /^#{1,6}\s+verification contract(?:\b|\s)/i,
);
const correctnessStart = sectionStart(
  markdown,
  /^#{1,6}\s+correctness contract(?:\b|\s)/i,
);
const correctnessTable = tablesWithHeaders(
  tables,
  correctnessHeaders,
  correctnessStart,
)[0];
```

- [ ] **Step 4: Run the full validator suite and concrete pair.**

```bash
node --test tests/verification-contract.test.mjs
node scripts/verification-contract.mjs validate \
  --spec docs/superpowers/specs/2026-07-14-COD-295-spec-handoff-verification-gate-design.md \
  --plan docs/superpowers/plans/2026-07-14-COD-295-spec-handoff-verification-gate-implementation.md
```

Expected: all tests pass; concrete output is `ok:true`, IDs V1-V5, diagnostics
empty.

- [ ] **Step 5: Commit the parser correction.**

```bash
git add scripts/verification-contract.mjs tests/verification-contract.test.mjs
git commit -m "fix(COD-295): validate realistic correctness sections"
```

### Task 2: Put the corrected validator before Spec landing

**Files:**

- Modify: `tests/linear-watch.test.mjs`
- Modify: `scripts/linear-watch.mjs`
- Modify: `tests/spec-sweep-doc.test.mjs`
- Modify: `skills/spec-sweep/SKILL.md`
- Modify: `.claude/skills/spec-sweep/SKILL.md`

**Interfaces:**

- Consumes: final `<spec-path>`, final `<plan-path>`, scheduled
  `AUTO_SWEEP_KIT_PATH` from launcher-source `KIT_ROOT`, configured
  anchor/current repo, validator JSON/exit
  status, immutable Spec claim, `AUTO_SWEEP_OUTCOME_PATH`,
  `AUTO_SWEEP_ISSUE`, `AUTO_SWEEP_CHILD_OUTCOME_VERSION`, self-update result,
  and the existing child-outcome reader.
- Produces: a mandatory pre-landing decision: `green` only for exit 0 plus
  readable `{"ok":true,...}`; otherwise repair/review/rerun or terminal
  remain-in-Spec handling. Scheduled terminal machine failure produces an
  exclusive issue-bound v1 `terminal-failed` child outcome that the launcher
  honors even when the enclosing runtime returns zero. Capability mismatch
  defers before material work, and a changed kit ends its old-code tick before
  producer skill refresh or dispatch.
- Preserves: validator implementation, Dev quality gate, learning taxonomy,
  claim marker shapes, workflow states, and card labels.

- [ ] **Step 1: Write failing launcher outcome tests.** In
  `tests/linear-watch.test.mjs`, add named tests proving:

  1. `child-outcome terminal-failed verification-contract-gate` requires
     `AUTO_SWEEP_OUTCOME_PATH` and `AUTO_SWEEP_ISSUE`, and rejects every other
     kind or reason code;
  2. it exclusively writes
     `{"version":1,"kind":"terminal-failed","issueIdentifier":"COD-…","reason":"verification-contract-gate"}`;
  3. repeating the exact write is idempotent, while a different issue, kind, or
     reason at the same path fails without overwrite;
  4. the reader rejects malformed/cross-issue terminal outcomes; and
  5. a valid terminal outcome overrides a nominal child exit 0, appears in the
     run record, and enters the existing dispatch-failure/Todo path;
  6. dispatch environment construction scrubs a stale inherited capability and
     `withCardDispatchEnv` exports exactly
     `AUTO_SWEEP_CHILD_OUTCOME_VERSION=1`;
  7. when self-update changes kit HEAD, the current process neither refreshes
     anchor skills nor dispatches, while a no-change next tick may refresh and
     dispatch with the capability; and
  8. a valid terminal outcome plus log text containing each of `quota`, `rate
     limit`, and overload language is never classified as provider capacity and
     still enters dispatch-failure/Todo reconciliation; and
  9. an old-launcher full-drain matrix runs the refreshed skill without
     capability for absent, unreadable, dirty, clean/unpushed, ahead, and
     clean/fully-pushed worktrees. Every row dispatches once and avoids drain
     exhaustion/repeated claim markers. Non-clean-pushed rows retain the exact
     declaration through resume and the next capable process admits it;
     clean+pushed writes one issue-bound old-compatible deferral, old recovery
     releases once, and the next capable process creates one fresh declaration.
     The exact wire record is
     `{"version":1,"kind":"dependency-deferred","issueIdentifier":"COD-…","dependencyExitCode":3,"dependency":{"reason":"launcher-capability","blockers":[]}}`.
     No row creates a Linear relation, dependency label, or human blocker;
  10. the constant compatibility writer exclusively creates that exact record,
      accepts only an identical existing record, and rejects every conflicting
      path/issue/value without overwrite.

  Run the entire launcher test file for RED:

```bash
node --test tests/linear-watch.test.mjs
```

Expected: FAIL because the command and recognized outcome kind do not exist.

- [ ] **Step 2: Add the activation boundary and bounded launcher outcome.** In the launcher-source
  `scripts/linear-watch.mjs`:

  - remove inherited `AUTO_SWEEP_CHILD_OUTCOME_VERSION` from the dispatch base
    environment, then export exactly `1` in capable card dispatch environments;
  - make `runUpdate` return a structured kit-change result; when HEAD changes,
    log the boundary without refreshing anchor skills, and make the current
    tick finalize without anchor resolution or dispatch so the next process
    loads the new consumer first;
  - when HEAD does not change, retain existing skill refresh and dispatch
    behavior, now with the matching capability exported;
  - add `child-outcome terminal-failed <reason>` to CLI/help;
  - allow only kind `terminal-failed` with the exact bounded reason
    `verification-contract-gate`, and bind the record to `AUTO_SWEEP_ISSUE`;
  - write only `AUTO_SWEEP_OUTCOME_PATH` with exclusive-create semantics;
  - accept an existing byte-equivalent record as idempotent, but reject every
    conflict without overwriting;
  - recognize the issue-matching `terminal-failed` kind after each runtime
    attempt, set the deterministic non-success launcher outcome
    `{kind:"terminal-failed", code:"VERIFICATION_CONTRACT_GATE", exitCode:1}`
    while retaining the actual attempt in run metadata,
    exempt that explicit outcome from provider-capacity inference,
    and let existing dispatch-failure sanitization, fingerprinting, Todo
    reconciliation, run recording, and claim cleanup own the rest.

  Do not add a new Linear mutation path or trust arbitrary message text.

- [ ] **Step 3: Run the whole launcher file and confirm GREEN.**

```bash
node --test tests/linear-watch.test.mjs
```

Expected: all existing and new launcher tests pass; kit-change and capability
ordering is proven, and terminal outcome beats both exit 0 and hostile
capacity-looking logs to yield one stable failure decision.

- [ ] **Step 4: Write the failing canonical doc tests.** Add one test named
  `spec-sweep runs a launcher-source exact-pair verification gate before landing`
  that
  asserts:

  1. the canonical skill includes
     `node "$AUTO_SWEEP_KIT_PATH/scripts/verification-contract.mjs" validate --spec "$SPEC_PATH" --plan "$PLAN_PATH"`;
  2. attended fallback is the configured anchor/current repository's regular
     readable `scripts/verification-contract.mjs`, not a card-selected path;
  3. gate text occurs after `Reassess review depth` and before
     `## 3. Land it`;
  4. both exit 0 and readable JSON `ok: true` are required;
  5. nonzero, invalid JSON, `ok !== true`, signal, missing helper, and unreadable
     artifact all fail closed; and
  6. exact paths are reused across repair and rerun.

  Add a second test named
  `spec-sweep repairs verification defects without weakening downstream evidence`
  that asserts author-owned repair, affected-review reconciliation,
  `review/test-gap`, remain-in-Spec behavior, launcher-owned scheduled machine
  failure evidence without a repeated card comment, exact claim close/release,
  verified child-outcome write after close, owner-only
  `blocked:open-questions`, and retained Dev validator plus `missing-design`
  wording.

  Add a third test named
  `spec-sweep defers before material work without launcher outcome capability`
  that requires the scheduled skill to check
  `AUTO_SWEEP_CHILD_OUTCOME_VERSION=1` immediately after dependency/routing
  preflight and keep the card in Spec. For non-clean-pushed proof, preserve the
  exact claim for old-launcher resume recovery. For clean+pushed proof, write an
  issue-bound v1 `dependency-deferred` envelope with `dependencyExitCode:3`,
  `reason:"launcher-capability"`, and no blockers using a bounded constant Node
  writer without first closing the claim; old deferral recovery owns its single
  release. This is transport compatibility only and must not create a Linear
  relation/label. Add no failure comment or human-block label.

- [ ] **Step 5: Run the focused tests and confirm RED.**

```bash
node --test tests/spec-sweep-doc.test.mjs
```

Expected: FAIL because the canonical Spec skill has authoring prose but no
executable pre-landing command or failure protocol.

- [ ] **Step 6: Add the minimum canonical gate.** In
  `skills/spec-sweep/SKILL.md`, after final review/contract/canonical-doc
  reconciliation and before `## 3. Land it`, add one numbered terminal step
  that says:

  - scheduled mode must invoke the regular readable launcher-source kit helper
    through Node with quoted exact artifact paths;
  - attended mode may use only the configured anchor/current repository helper
    when the kit path is absent;
  - invoke `validate --spec <exact-spec-path> --plan <exact-plan-path>`;
  - accept only exit 0 plus readable `ok: true`;
  - handle every other process/output/file state as failed;
  - emit `review/test-gap`, repair, reconcile affected reviews, and rerun for
    author-owned defects;
  - use the existing question path only for owner-only information;
  - before scheduled material work, require
    `AUTO_SWEEP_CHILD_OUTCOME_VERSION=1`; if absent, run the same Git proof as
    successful-same-state recovery. Preserve the claim/WIP for every state not
    proven clean+pushed. For clean+pushed, use a constant Node snippet to
    exclusive-create (or exactly verify) the old-compatible issue-bound
    `dependency-deferred` envelope without closing the claim, then return so old
    deferral recovery owns the single release. In both cases leave the card in
    Spec without failure comment/human label; never create a Linear dependency;
  - on scheduled machine failure, emit terminal failed, prove and close/release
    the exact claim, invoke exactly
    `node "$AUTO_SWEEP_KIT_PATH/scripts/linear-watch.mjs" child-outcome terminal-failed verification-contract-gate`,
    verify the issue-bound result, and stop without claiming that the agent can
    force its enclosing runtime to exit nonzero;
  - let launcher reconciliation deduplicate retry evidence without a card
    comment or human-block label;
  - never weaken or skip Dev's independent gate.

  Keep the change localized. Do not refactor the adjacent duplicated numbering
  or duplicate parser diagnostic semantics in prose.

- [ ] **Step 7: Copy exact bytes to the installed skill.** Apply the same change
  to `.claude/skills/spec-sweep/SKILL.md`, then verify:

```bash
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
```

Expected: exit 0, no output.

- [ ] **Step 8: Run focused and neighboring GREEN suites.**

```bash
node --test tests/spec-sweep-doc.test.mjs \
  tests/linear-watch.test.mjs \
  tests/verification-contract.test.mjs \
  tests/verification-contract-doc.test.mjs
node scripts/verification-contract.mjs validate \
  --spec docs/superpowers/specs/2026-07-14-COD-295-spec-handoff-verification-gate-design.md \
  --plan docs/superpowers/plans/2026-07-14-COD-295-spec-handoff-verification-gate-implementation.md
```

Expected: all tests pass. Existing concrete contract artifacts and downstream
gate assertions remain green.

- [ ] **Step 9: Commit the workflow gate and launcher signal.**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs \
  tests/spec-sweep-doc.test.mjs \
  skills/spec-sweep/SKILL.md \
  .claude/skills/spec-sweep/SKILL.md
git commit -m "fix(COD-295): validate Spec artifacts before handoff"
```

### Task 3: Distribute and verify the cross-runtime gate

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `VERSION`

**Interfaces:**

- Consumes: Task 2's byte-identical skill pair and current live remote VERSIONs.
- Produces: shipped operator contract, unique version marker, updater-installed
  gate, and full regression evidence.
- Preserves: no production deploy, attended external publication, generated-card
  Signoff/human Ship, existing learning evaluator.

- [ ] **Step 1: Add the shipped operator contract.** In `README.md`, replace the
  planned COD-295 entry with shipped wording that says Spec validates the final
  exact pair with the launcher-source helper before commit/move, remains in Spec on
  failure, and keeps Dev's independent gate. Do not claim a generalized
  all-contract validator.

- [ ] **Step 2: Add a changelog entry and allocate a unique version.** Fetch
  `origin/main`, inspect `VERSION` on every live remote ref, then choose the next
  unused four-part patch version. Use `$AUTO_SWEEP_TMPDIR/live-versions.txt` for
  the scratch list, never the repository. Add a dated `CHANGELOG.md` entry
  describing:

  - producer-side exact-pair validation;
  - launcher-source scheduled helper and fail-closed output;
  - consumer-capability bootstrap plus kit-change restart ordering;
  - issue-bound terminal machine-failure outcomes that survive runtime exit 0;
  - preserved Dev defense and honest learning evidence.

  Write the same chosen value to `VERSION`. Do not reuse a version present on
  any merged or active release branch discovered during the fetch.

- [ ] **Step 3: Run release and updater proofs.** Substitute the chosen version
  for `<NEW_VERSION>`:

```bash
git fetch origin --prune
git for-each-ref --format='%(refname)' refs/remotes/origin | while read -r ref; do
  git show "$ref:VERSION" 2>/dev/null || true
done | rg '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -V -u \
  > "$AUTO_SWEEP_TMPDIR/live-versions.txt"
MAX_VERSION=$(tail -1 "$AUTO_SWEEP_TMPDIR/live-versions.txt")
NEXT_VERSION=$(node -e 'const v=process.argv[1].split(".").map(Number); if(v.length!==4||v.some(Number.isNaN)) process.exit(2); v[3]+=1; process.stdout.write(v.join("."))' "$MAX_VERSION")
! rg -qx "$NEXT_VERSION" "$AUTO_SWEEP_TMPDIR/live-versions.txt"
test "$(cat VERSION)" = "<NEW_VERSION>"
test "$NEXT_VERSION" = "<NEW_VERSION>"
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
node --test tests/updater.integration.test.mjs
```

Expected: version is exactly one patch higher than the greatest live remote
marker, copies match, and updater integration passes. Before final commit,
re-fetch and repeat the complete live-ref calculation; if the version was
consumed, reconcile origin, allocate the next patch, and update changelog/VERSION.

- [ ] **Step 4: Run focused, full, and learning dry-run verification.**

```bash
node --test tests/spec-sweep-doc.test.mjs \
  tests/linear-watch.test.mjs \
  tests/verification-contract.test.mjs \
  tests/verification-contract-doc.test.mjs \
  tests/updater.integration.test.mjs
node --test tests/*.test.mjs
node scripts/linear-watch.mjs learning-run --dry-run
git diff --check
git status --short
```

Expected: all tests pass; dry-run performs no Linear write or cursor advance;
diff check is clean; only the ten planned implementation/release files change.

- [ ] **Step 5: Inspect generated-card safety and exact scope.**

```bash
rg -n "factory:learning-generated|fast-path:eligible|human.*Ship" \
  skills/dev-sweep/SKILL.md skills/qa-sweep/SKILL.md skills/ship-sweep/SKILL.md
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected: generated cards still require Signoff/human Ship and are never fast
path; implementation diff contains only the ten files in the map. The Spec-stage
design/plan docs are already on main and are not part of the later Dev diff.

- [ ] **Step 6: Commit the release unit.**

```bash
git add README.md CHANGELOG.md VERSION
git commit -m "docs(COD-295): release Spec handoff verification gate"
```

## Failure modes and QA disposition

| Failure mode | Test coverage | Handling | Operator/card outcome |
| --- | --- | --- | --- |
| Wrong artifact path | V1 exact-argument doc test | Reject protocol; do not land. | Remains in Spec with bounded evidence. |
| Branch-shadowed scheduled helper | V1 launcher-source-path assertion | Scheduled launcher-source kit helper is mandatory. | Missing/unreadable launcher-source helper fails. |
| Validator nonzero | V2 doc + unit fixtures | Repair author-owned defect or fail attempt. | No commit/Dev move. |
| Exit 0 with malformed/false JSON | V2 explicit doc assertion | Treat as unreadable/failed, never warning. | No commit/Dev move. |
| Repair changes reviewed premise | V2 review-reconciliation assertion | Rerun affected review before validator. | Audit records corrected review. |
| Runtime exits zero after terminal machine failure | V3 launcher outcome precedence test | Issue-bound `terminal-failed` outcome overrides runtime success. | Existing dispatch-failure Todo reconciliation receives one stable event. |
| Old launcher propagates new producer skill | V3 old-launcher full-drain matrix, capability/bootstrap, and kit-change tests | Missing capability dispatches once via exact resume for non-clean-pushed or old-compatible deferral for clean+pushed; changed-kit tick does not refresh/dispatch. | Next process resumes the same declaration or creates one fresh declaration after the single compatible release. |
| Capacity-looking logs accompany terminal failure | V3 quota/rate-limit/overload tests | Explicit `terminal-failed` outcome is never inferred as provider capacity. | Dispatch-failure Todo reconciliation still receives one stable event. |
| Child outcome conflicts or names another issue | V3 exclusivity/issue-binding tests | Reject without overwrite; do not claim reconciliation succeeded. | Card stays in Spec with local run evidence for operator recovery. |
| Machine failure mislabeled human | V3 label/comment distinction assertion | No scheduled card comment or human-block label; close/release, write/verify the child outcome, and stop. | Retry evidence remains launcher-owned and deduplicated. |
| Claim leaks after failed terminal gate | V3 exact close/release assertion | Complete-read, close, verify, remove exact claim. | No stale Spec ownership. |
| Dev defense removed | V4 cross-skill regression | Test fails release. | Real bypass cannot ship. |
| Learning evidence muted | V4 event-wording/diff assertion | Test/diff fails release. | Metric stays honest. |
| Installed copy drifts | V5 parity/updater tests | Release blocked. | No partial runtime rollout. |
| Version collision | V5 origin/version check | Allocate next patch before commit. | Updater sees one monotonic release. |

No failure is silent: artifact diagnostics stay in the Spec attempt, scheduled
machine failures reach launcher reconciliation, release defects fail tests, and
future Dev defects retain bounce evidence.

## Spec-sweep review audit

| Item | Initial decision | Final outcome |
| --- | --- | --- |
| Review tier | Tier 1, plan-target | Escalated to Tier 2 after false-green parser premise; cannot decrease. |
| Predicted footprint | Ten files, 280-450 lines, no new module/dependency | Expanded by two existing launcher files because a cross-runtime agent cannot guarantee parent-process exit. |
| Engineering spec pass | Required after escalation | Clear with exact-resume/non-clean-pushed and compatible-deferral/clean-pushed bootstrap split plus restart ordering. |
| Engineering plan pass | Initial pass found live-ref version gap | Clear with full state-matrix one-dispatch proof, same/fresh next declarations, exact writers, and capacity tests. |
| Independent adversarial plan review | Initial pass found five material gaps | Clear after five corrective follow-ups; final pass verified old-reader compatibility, one-pass drain behavior, same/fresh declaration recovery, prior proofs, mappings, and ten-file ownership. Preferred Claude role unavailable through collaboration interface. |
| UI/design | Skipped: no UI/interaction/accessibility surface | Confirmed skipped. |
| DevEx | Skipped: no public API/CLI/SDK/adoption surface | Confirmed skipped. |
| Security | Specialized lens skipped: no auth/data/secret/external-input change; provenance challenged in engineering review | Confirmed skipped after Tier 2 provenance correction. |
| Performance | Skipped: bounded success-path process plus bootstrap/failure-only writers | Confirmed skipped. |
| Research | Skipped: no unfamiliar external mechanism | Complete. |

## Implementation Tasks

Synthesized from the bounded design. No additional tasks may be added unless the
selected reviews identify a verified gap.

- [ ] **T1 (P1, human: ~2h / Codex: ~20min)** — Validator — Make canonical
  correctness sections participate in exact C-to-V sourcing.
  - Surfaced by: adversarial review of `scripts/verification-contract.mjs:63-75,111-130` and a concrete source-removal false green.
  - Files: `tests/verification-contract.test.mjs`, `scripts/verification-contract.mjs`.
  - Verify: realistic-order reject fixtures, full validator suite, concrete pair CLI.
- [ ] **T2 (P1, human: ~5h / Codex: ~45min)** — Spec workflow and launcher —
  Add the launcher-source exact-pair gate, a reliable issue-bound terminal
  failure outcome, activation boundary, and fail-closed repair protocol.
  - Surfaced by: architecture evidence at `skills/spec-sweep/SKILL.md:65,79,90-101`, COD-288's bounce, inability to force parent exit, and the producer-before-consumer self-update race.
  - Files: `tests/linear-watch.test.mjs`, `scripts/linear-watch.mjs`, `tests/spec-sweep-doc.test.mjs`, `skills/spec-sweep/SKILL.md`, `.claude/skills/spec-sweep/SKILL.md`.
  - Verify: whole launcher/doc/validator suites from Tasks 1-2, including success-exit outcome precedence and failure classification.
- [ ] **T3 (P1, human: ~2h / Codex: ~20min)** — Distribution — Ship the
  operator contract and unique updater version with full regression evidence.
  - Surfaced by: cross-runtime installed-skill parity and VERSION-triggered updater requirements.
  - Files: `README.md`, `CHANGELOG.md`, `VERSION`.
  - Verify: updater integration, full suite, dry-run, version checks, selective diff.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | ---: | --- | --- |
| CEO Review | `/plan-ceo-review` | Scope and strategy | 0 | SKIPPED | Bounded factory-quality regression with no product strategy change. |
| Codex Review | independent reviewer | Adversarial premise and proof trace | 6 | CLEAR | Twelve material findings across initial/follow-up passes were folded; final pass found no unresolved decision. |
| Eng Review | `/plan-eng-review` | Architecture and tests | 7 | CLEAR | Final ten-file design covers parser truthfulness, producer/consumer activation, old-launcher bootstrap, terminal outcomes, capacity precedence, and live-ref release proof. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | SKIPPED | No UI surface. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | SKIPPED | No public API/CLI/SDK surface. |

**VERDICT:** TIER 2 SPEC + PLAN + INDEPENDENT REVIEW CLEAR — handoff is eligible after terminal validation and landing.

NO UNRESOLVED DECISIONS

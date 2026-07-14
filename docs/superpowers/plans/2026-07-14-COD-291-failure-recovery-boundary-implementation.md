# COD-291 Failure-Recovery Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop false route recovery/recurred loops by binding scheduled route
evidence to the launcher's exact context and requiring workspace/card/stage
recovery proof with workspace-isolated fingerprints and fail-closed legacy
continuity.

**Architecture:** Keep the existing helper, outcome file, launcher failure
events, and self-clearing Linear Todo machinery. Add four pure boundaries:
scheduled route-context resolution, closed deferred-outcome validation, clean
card-scoped child environment construction, and an exact route `stableTarget`
with a uniquely proven legacy fingerprint alias. Wire them into current flows with
no new persistence or dependency.

**Tech Stack:** Node.js 18+ ESM, built-in `node:test`, filesystem outcome files,
Linear GraphQL through existing helpers, Markdown release documentation.

## Global Constraints

- Work only in the configured `linear-board-sweeps` repository.
- Preserve the `repo-status` command and attended explicit-argument behavior.
- Preserve valid dependency outcome behavior, immutable claim ownership,
  pre-material route failure, Signoff, and human Ship for this generated card.
- Do not change `failed-recovery/v1`, its event names, threshold, or evidence.
- Outcome files remain first-write-wins and must be at most 64 KiB when read.
- Route `stableTarget` becomes canonical
  `{ sourceWorkspaceId, projectId, sweep, issueIdentifier }` identity for both
  failure deduplication and recovery; legacy aliases require a unique registry
  mapping.
- No new package, label, workflow state, retry store, sibling repo, production
  target, migration, merge, deploy, or external publication.

---

## Repo scope

Owning repository: `linear-board-sweeps` only. Branch naming should retain
`COD-291`. The configured deploy path is merge/push to `main`; there is no
production app deployment. QA must attach V1-V7 evidence to COD-291 and send the
`factory:learning-generated` card to Signoff. Only the owner may move it to Ship.

## File and interface map

| File | Responsibility in this change |
| --- | --- |
| `scripts/linear.mjs` | Resolve scheduled versus attended route authority; emit trusted CLI JSON/outcomes. |
| `tests/linear.test.mjs` | Prove C1-C2 through pure and CLI-level route matrices. |
| `scripts/linear-watch.mjs` | Validate bounded outcome protocol, scrub child identity, construct exact recovery proof, and reconcile current/recovered evidence. |
| `tests/linear-watch.test.mjs` | Prove C3-C7, races, workspace isolation, recurrence continuity, and safety regressions. |
| `README.md` | Record the planned and then shipped operator contract. |
| `CHANGELOG.md` | Describe the release behavior and compatibility. |
| `VERSION` | Allocate the next four-part patch version after origin reconciliation. |

No new runtime file is justified. The existing modules already own these seams,
and the planned helpers are small pure functions used only by their owning flow.

## Versioned contract boundary decision

`Versioned contract boundary: versioned-contract-boundary/v1`

Use this single shared decision for correctness, verification, scope closure,
and performance declarations in this plan. The reusable artifact is
`docs/superpowers/specs/2026-07-10-COD-155-correctness-contract-design.md`.

```bash
git log --diff-filter=A --format='%H' -- \
  docs/superpowers/specs/2026-07-10-COD-155-correctness-contract-design.md
# 4d208c0d7bd161bd15273615d31f5ea6ce47808e

git log --diff-filter=A --format='%H' -- .claude/skills/.sweep-version
# bd467095a1ddb2451aa5271bbef9e876491a5bde

git merge-base --is-ancestor \
  4d208c0d7bd161bd15273615d31f5ea6ce47808e \
  bd467095a1ddb2451aa5271bbef9e876491a5bde
# exit 1: artifact is not pre-boundary
```

Result: the histories are comparable and the artifact was introduced after the
installed marker. COD-291 must use the current versioned contracts; no legacy
gate applies. Missing or incomparable history remains fail-closed.

## Contract declarations

- `Scope closure: scope-closure/v1 — required` because entry points, trust
  boundaries, recovery state, evidence, release docs, and owner rollout change.
- `Correctness contract: correctness-contract/v1 — required` with C1-C7 from
  the design.
- `Verification contract: verification-contract/v1 — required` with V1-V7 from
  the design.
- `Performance contract: performance-contract/v1 — not required` because the
  implementation adds bounded local parsing/comparison/set membership, no new
  query or network/storage fan-out, and no material workload. The 64 KiB read
  limit and zero-fetch non-routed assertion are correctness bounds.

## Failure modes and ordering

1. Contradictory scheduled context exits 2 before live label use and writes only
   trusted expected identity.
2. Live missing/ambiguous/changed route exits 3 and writes one schema-valid
   deferred outcome.
3. Any present oversized, unreadable, unsupported, or inconsistent outcome is a
   failed child protocol, not runtime success.
4. Valid dependency outcomes remain dependency deferrals; an unclassifiable
   malformed shared file is failed protocol.
5. Stale parent or `.env` `AUTO_SWEEP_*` values are absent unless the current
   pick explicitly reintroduces them.
6. Route failure fingerprints include canonical source workspace; two
   same-basename registrations cannot share a Todo.
7. A matching current failure wins over an earlier recovered target, including
   immediate and final reconciliation in one tick.
8. A legacy open/Done Todo migrates or recurs only when basename, project,
   stage, issue, and active registry map uniquely to the current workspace;
   ambiguous history stays untouched.

## Parallel strategy

Task 1 and Task 2 test-fixture preparation can proceed independently after the
interfaces below are accepted. Tasks 2-4 all edit `scripts/linear-watch.mjs` and
`tests/linear-watch.test.mjs`; implement them sequentially to avoid conflicting
ownership and to keep each RED/GREEN cycle reviewable. Task 5 follows all code
tasks because release/version text must describe the final behavior.

### Task 1: Bind scheduled `repo-status` to launcher context

**Files:**

- Modify: `scripts/linear.mjs:55-82,335-365,778-810`
- Test: `tests/linear.test.mjs`

**Interfaces:**

- Consumes: parsed config, CLI issue/label/repo strings, and the four trusted
  scheduled environment values.
- Produces: exported
  `scheduledRepoStatusContext({ config, cli, env }) -> { mode, issueIdentifier,
  expectedLabel, expectedRepoEntry, eligible?, reason? }` or a bounded thrown
  error with `code = "SCHEDULED_CONTEXT_MISMATCH"`.
- Preserves: `repoRouteEligibility` and `fetchIssueLabels` signatures.

- [ ] **Step 1: Write failing pure-decision tests**

Add named tests that construct `config`/`cli`/`env` objects directly:

```js
test("scheduled repo context: non-routed invocation ignores accidental route args", () => {
  assert.deepEqual(scheduledRepoStatusContext({
    config: {},
    cli: { issueIdentifier: "COD-291", expectedLabel: "/wrong", expectedRepoEntry: "repo" },
    env: { AUTO_SWEEP_ISSUE: "COD-291" },
  }), {
    mode: "scheduled-non-routed",
    issueIdentifier: "COD-291",
    eligible: true,
    reason: "not-routed",
  });
});

test("scheduled repo context: routed tuple must match exported authority", () => {
  assert.throws(() => scheduledRepoStatusContext({
    config: { repoRouting: { byLabel: { "repo:kit": "." } } },
    cli: { issueIdentifier: "COD-291", expectedLabel: "repo:wrong", expectedRepoEntry: "." },
    env: {
      AUTO_SWEEP_ISSUE: "COD-291",
      AUTO_SWEEP_REPO_LABEL: "repo:kit",
      AUTO_SWEEP_REPO_ENTRY: ".",
      AUTO_SWEEP_REPO: "/managed/kit",
    },
  }), /scheduled route context mismatch/);
});
```

Also cover issue mismatch, configured routing with missing exported label,
exported label without configured routing, missing repo entry/path, exact routed
tuple, and attended mode.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test --test-name-pattern='scheduled repo context' tests/linear.test.mjs`

Expected: FAIL because `scheduledRepoStatusContext` is not exported.

- [ ] **Step 3: Implement the pure context resolver**

Use this decision order in `scripts/linear.mjs`:

```js
export function scheduledRepoStatusContext({ config = {}, cli = {}, env = {} } = {}) {
  const scheduledIssue = env.AUTO_SWEEP_ISSUE || "";
  const byLabel = config.repoRouting?.byLabel;
  const configured = Boolean(byLabel && typeof byLabel === "object"
    && !Array.isArray(byLabel) && Object.keys(byLabel).length);
  if (!scheduledIssue) return { mode: "attended", ...cli };
  if (cli.issueIdentifier !== scheduledIssue) {
    const error = new Error("scheduled route context mismatch: issue identifier");
    error.code = "SCHEDULED_CONTEXT_MISMATCH";
    throw error;
  }
  if (!configured && !env.AUTO_SWEEP_REPO_LABEL) {
    return { mode: "scheduled-non-routed", issueIdentifier: scheduledIssue,
      eligible: true, reason: "not-routed" };
  }
  const expectedLabel = env.AUTO_SWEEP_REPO_LABEL || "";
  const expectedRepoEntry = env.AUTO_SWEEP_REPO_ENTRY || "";
  if (!configured || !expectedLabel || !expectedRepoEntry || !env.AUTO_SWEEP_REPO
      || cli.expectedLabel !== expectedLabel
      || cli.expectedRepoEntry !== expectedRepoEntry
      || byLabel[expectedLabel] !== expectedRepoEntry) {
    const error = new Error("scheduled route context mismatch: configured route authority");
    error.code = "SCHEDULED_CONTEXT_MISMATCH";
    error.expectedLabel = expectedLabel;
    error.expectedRepoEntry = expectedRepoEntry;
    throw error;
  }
  return { mode: "scheduled-routed", issueIdentifier: scheduledIssue,
    expectedLabel, expectedRepoEntry };
}
```

The final implementation may factor the bounded error constructor, but must not
copy mismatched CLI values into its trusted fields.

- [ ] **Step 4: Wire the command and add CLI boundary tests**

For scheduled non-routed mode, print exactly:

```json
{"issue":"COD-291","eligible":true,"reason":"not-routed","matches":[]}
```

Exit 0, skip `fetchIssueLabels`, and do not call `writeAutoSweepOutcome`.
For routed mode, pass only resolver outputs to the existing eligibility check.
On `SCHEDULED_CONTEXT_MISMATCH`, exit 2 and write reason
`scheduled-context-mismatch`, `matches: []`, and trusted expected fields.
For config parse failure, Linear unreadability, or any other scheduled routed
catch path, construct expected fields directly from `AUTO_SWEEP_REPO_LABEL` and
`AUTO_SWEEP_REPO_ENTRY`, never from CLI arguments. Add an assertion that stale
CLI values cannot appear in the outcome even when config loading fails.
Attended mode retains current explicit arguments/config rules.

Run: `node --test --test-name-pattern='repo-status|scheduled repo context' tests/linear.test.mjs`

Expected: all named V1/V2 cases PASS with exact output, exit, fetch-count, and
outcome-file assertions.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/linear.mjs tests/linear.test.mjs
git commit -m "fix(COD-291): bind scheduled route context"
```

### Task 2: Validate the complete child-outcome protocol

**Files:**

- Modify: `scripts/linear-watch.mjs:6281-6315,6463-6509`
- Test: `tests/linear-watch.test.mjs:6000-6065`

**Interfaces:**

- Consumes: trusted `pick`, `pick.config.repoRouting.byLabel`, and an outcome
  path whose existence is checked once.
- Produces: exported
  `validateChildDeferredOutcome(value, pick) -> normalized deferred outcome | { kind:
  "child-outcome-invalid", code: "UNTRUSTED_CHILD_OUTCOME", reason }`.
- `childDeferredOutcomeForPick` distinguishes missing file from every invalid
  present file and enforces a 65,536-byte maximum before reading.

- [ ] **Step 1: Replace the permissive route fixture with a RED matrix**

Build a routed pick containing:

```js
const routedPick = {
  issueIdentifier: "COD-291",
  repoRoute: { label: "repo:kit", repoEntry: "." },
  config: { repoRouting: { byLabel: { "repo:kit": ".", "repo:other": "other" } } },
};
```

Table-drive absent file; invalid JSON; 65,537 bytes; unsupported version/kind;
extra top-level/routing field; missing issue/route field; non-routed pick; wrong
issue/tuple; strings over 256 bytes; duplicate/unconfigured matches; and every
wrong exit/reason/cardinality combination. Include valid exit-2 unreadable and
context-mismatch plus valid exit-3 missing, ambiguous, and changed cases.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node --test --test-name-pattern='child outcome protocol|child repository outcome' tests/linear-watch.test.mjs`

Expected: current code incorrectly returns success/null for invalid present
files and accepts a non-routed pick.

- [ ] **Step 3: Implement the closed validator and bounded reader**

Define constants and normalized fields:

```js
const AUTO_SWEEP_OUTCOME_MAX_BYTES = 64 * 1024;
const ROUTE_EXIT_2_REASONS = new Set(["unreadable", "scheduled-context-mismatch"]);
const ROUTE_EXIT_3_REASONS = new Set([
  "missing-route-label", "ambiguous-route-label", "route-changed",
]);
```

Require exact object keys, UTF-8 string byte length `1..256`, exact trusted
tuple, unique configured match pairs, and reason-specific cardinality. Return a
new normalized routing object. Never retain the raw object or raw file text.
Keep the existing valid dependency shape/classification. Treat any present file
that cannot first establish a valid kind/version as `child-outcome-invalid`.

- [ ] **Step 4: Prove dispatch and run-record behavior**

Drive `dispatchAsync` with child exit 0. For every invalid present route file,
assert:

```js
assert.equal(outcome.kind, "child-outcome-invalid");
assert.equal(outcome.code, "UNTRUSTED_CHILD_OUTCOME");
assert.notEqual(outcome.kind, "success");
```

Assert handoff/refill predicates remain false, the run record contains only
normalized bounded fields, and valid dependency deferral remains unchanged.

Run: `node --test --test-name-pattern='child outcome protocol|child repository outcome|dependency outcome' tests/linear-watch.test.mjs`

Expected: all V3/V5 named assertions PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "fix(COD-291): validate child outcome protocol"
```

### Task 3: Scrub inherited card-scoped environment

**Files:**

- Modify: `scripts/linear-watch.mjs:6517-6523`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**

- Consumes: parent process env, parsed workspace `.env`, exact `pick.childEnv`.
- Produces: exported
  `dispatchEnvironment(anchorPath, pick, { processEnv? }) -> env` with no
  inherited key whose name starts `AUTO_SWEEP_`.

- [ ] **Step 1: Write the stale-environment RED test**

Inject stale issue, label, repo, source anchor, owner, declaration, run, and
outcome-path keys in both parent and `.env`; give the pick only its current issue,
repo entry, and owner. Assert optional label remains absent and an ordinary
`PATH`, proxy, and `LINEAR_API_KEY` survive with the existing overlay order.

- [ ] **Step 2: Run and confirm RED**

Run: `node --test --test-name-pattern='dispatch environment' tests/linear-watch.test.mjs`

Expected: stale optional scheduled keys leak into the current child.

- [ ] **Step 3: Implement scrub-then-overlay**

Use a small pure filter twice:

```js
function withoutAutoSweepKeys(value = {}) {
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.startsWith("AUTO_SWEEP_")));
}

function dispatchEnvironment(anchorPath, pick = {}, { processEnv = process.env } = {}) {
  const envFile = path.join(anchorPath, ".env");
  const fileEnv = parseEnv(fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "");
  return {
    ...withoutAutoSweepKeys(processEnv),
    ...withoutAutoSweepKeys(fileEnv),
    ...(pick.childEnv || {}),
  };
}
```

- [ ] **Step 4: Run focused and dispatch regressions**

Run: `node --test --test-name-pattern='dispatch environment|dispatchAsync' tests/linear-watch.test.mjs`

Expected: V7 and existing dispatch tests PASS; ordinary environment behavior is
unchanged.

- [ ] **Step 5: Commit Task 3**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "fix(COD-291): isolate child sweep environment"
```

### Task 4: Separate failure identity from exact recovery proof

**Files:**

- Modify: `scripts/linear-watch.mjs:1940-2100,6920-6970,7500-7560,7642-7644`
- Test: `tests/linear-watch.test.mjs:6600-6800`

**Interfaces:**

- Produces exported
  `routeFailureTarget({ sourceWorkspace, projectId, sweep, issueIdentifier })`
  as canonical JSON with exactly those keys.
- Uses the exact target as route `stableTarget` and supplies a proven
  new-fingerprint → legacy-fingerprint alias map to reconciliation.
- `failureTodoDecisions(..., { recoveredTargets })` uses checked scope for
  non-route kinds and exact recovery target only for `repo-routing`.

- [ ] **Step 1: Write RED tests for identity and legacy continuity**

Cover:

```js
const a = routeFailureTarget({ sourceWorkspace: "/src/a/app", projectId: "p", sweep: "ship", issueIdentifier: "COD-158" });
const b = routeFailureTarget({ sourceWorkspace: "/src/b/app", projectId: "p", sweep: "ship", issueIdentifier: "COD-158" });
assert.notEqual(a, b);
assert.match(a, /"sourceWorkspaceId":"app-[a-f0-9]{8}"/);
assert.equal(a.includes("/src/a/app"), false);
```

Then assert two same-basename source workspaces have different fingerprints and
cannot update or recover each other. Cover a uniquely mapped legacy open Todo
that is updated in place with the new target/marker before create, a uniquely
mapped legacy Done marker that yields exactly one `recurred`, and zero/multiple
workspace mappings that leave legacy history untouched. Another card/stage
cannot close it.

- [ ] **Step 2: Run and confirm RED**

Run: `node --test --test-name-pattern='route recovery|failure Todo.*route|legacy route' tests/linear-watch.test.mjs`

Expected: current broad checked scope closes route Todos and no recovery-target
field exists.

- [ ] **Step 3: Add exact route identity and proven legacy aliases**

Implement canonical key order:

```js
export function routeFailureTarget({ sourceWorkspace, projectId, sweep, issueIdentifier } = {}) {
  if (![sourceWorkspace, projectId, sweep, issueIdentifier]
      .every((value) => typeof value === "string" && value)) return null;
  return JSON.stringify({ sourceWorkspaceId: stablePathSlug(sourceWorkspace),
    projectId, sweep, issueIdentifier });
}
```

Use this value as route `stableTarget` for new events and recovered-target sets.
Add `legacyRouteFingerprint(event)` using the old issue-only target. Before
reconciliation, build aliases only when project + legacy Anchor basename maps to
exactly one active registered source workspace and it matches the event. An
alias lets `failureTodoDecisions` update the old open Todo with the new target
and marker before create; recovered-history lookup checks the same alias. Never
infer an alias from basename alone.

- [ ] **Step 4: Enforce recovery precedence and double-reconciliation safety**

For `repo-routing`, require `recoveredTargets.has(stableTarget)` and ignore
`checkedScopes`. Add valid scan targets to the active workspace set. Add child
route failures to current failures before final reconciliation. Drive one child
failure through immediate and final reconciliation; assert one create/update,
no close, and no `recovered`/`recurred` event. A later exact healthy tick closes
once and emits one confirmed recovery.

- [ ] **Step 5: Run the focused state-machine tests**

Run: `node --test --test-name-pattern='route recovery|failure Todo|recovery transition' tests/linear-watch.test.mjs`

Expected: all V4/V6 assertions PASS, including cross-workspace isolation,
legacy continuity, current-failure precedence, double reconciliation, and honest
learning events.

- [ ] **Step 6: Commit Task 4**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "fix(COD-291): require exact route recovery proof"
```

### Task 5: Release documentation and complete verification

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `VERSION`
- Verify: all files from Tasks 1-4

**Interfaces:**

- Consumes: final merged behavior and current origin VERSION.
- Produces: one patch release description and complete V1-V7 handoff evidence.

- [ ] **Step 1: Reconcile the release number**

Fetch origin, compare `VERSION`, and allocate the next unused four-component
patch. Never reuse a number already present on origin. Update changelog/version
together with behavior text; do not publish an external release.

- [ ] **Step 2: Update operator documentation**

In README's self-healing/routing architecture, replace the planned COD-291 note
with shipped behavior: scheduled non-routed misuse is a no-I/O success, routed
identity comes from launcher context, invalid present outcome files fail child
protocol, inherited card identity is scrubbed, and route Todo recovery requires
the exact source workspace/card/stage.

- [ ] **Step 3: Run the contract validator**

```bash
node scripts/verification-contract.mjs validate \
  --spec docs/superpowers/specs/2026-07-14-COD-291-failure-recovery-boundary-design.md \
  --plan docs/superpowers/plans/2026-07-14-COD-291-failure-recovery-boundary-implementation.md
```

Expected: PASS with every C1-C7 appearing in exactly one V1-V7 row and every V
mapped below.

- [ ] **Step 4: Run focused suites**

```bash
node --test tests/linear.test.mjs
node --test tests/linear-watch.test.mjs
```

Expected: zero failures. Capture the exact test counts and commit SHA for Dev's
QA handoff.

- [ ] **Step 5: Run the full repository gate**

Run: `node --test`

Expected: zero failed tests. Confirm `git diff --check` is clean and the diff
touches only the declared single-repo scope.

- [ ] **Step 6: Commit Task 5**

```bash
git add README.md CHANGELOG.md VERSION \
  docs/superpowers/specs/2026-07-14-COD-291-failure-recovery-boundary-design.md \
  docs/superpowers/plans/2026-07-14-COD-291-failure-recovery-boundary-implementation.md
git commit -m "docs(COD-291): release routing recovery boundary"
```

## Scope closure traceability

| S ID | Implementing task(s) | Files/modules | Test or assertion | Rollout/owner evidence | Residual risk |
| --- | --- | --- | --- | --- | --- |
| S1 | Task 1 | `linear.mjs`, `linear.test.mjs` | V1-V2 exact CLI/fetch/outcome matrix | README/changelog in Task 5 | None after named fixtures. |
| S2 | Task 2 | `linear-watch.mjs`, watcher tests | V3 closed 64 KiB schema matrix | Run record and release notes | Future outcome version must extend validator deliberately. |
| S3 | Task 4 | failure/Todo/reconciliation code and tests | V4 distinct workspace fingerprints, unique/ambiguous legacy aliases, race, double-pass cases | Post-ship Todo behavior | Ambiguous legacy Todo remains attended-only. |
| S4 | Tasks 1-4 | existing gate/claim/dependency paths | V5 regression assertions and full suite | Existing human Ship gate | None introduced by COD-291. |
| S5 | Task 4 and post-Ship owner check | watcher events; `learning.mjs` unchanged | V6 named recurrence/recovery tests | Seven-day target 0 vs baseline 5 | Real failures may honestly keep metric above zero. |
| S6 | Task 5 | README, changelog, VERSION | doc assertions, contract validator, full suite | Owner moves Signoff→Ship; no external publication | Release publication remains attended if desired. |
| S7 | All | configured repository only | final diff path audit | merge/push-only deploy config | None. |
| S8 | Task 3 | dispatch environment and tests | V7 stale parent/`.env` fixture | normal kit rollout | New `AUTO_SWEEP_*` keys are automatically covered by prefix scrub. |

Bidirectional check: every S row maps to a task/proof; every task maps back to
S1-S8. Dependencies are ordered CLI → outcome → environment → recovery →
distribution. The only human action is the existing owner Ship move. No planned
surface lacks a configured owner or deploy path.

## Verification traceability

| ID | Implementing task(s) | Test layer and file | RED signal | GREEN command / assertion | QA evidence | Residual gap |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | Task 1 | Pure + CLI, `tests/linear.test.mjs` | Non-routed call throws/queries/writes outcome | named test; exit 0, reason `not-routed`, zero fetch, absent file | Repeat CLI subprocess result | None. |
| V2 | Task 1 | Pure + CLI matrix, `linear.test.mjs` | CLI args override env or wrong exit | named matrix; exact 0, contradictions 2, live change 3 | Attach exact JSON/exits | Linear unreadability is deterministically stubbed. |
| V3 | Task 2 | Validator + dispatch integration, watcher tests | Invalid present file yields success/authentic deferral | named protocol matrix and normalized run record | Repeat public outcome boundary | None; all low-level malformed paths automated. |
| V4 | Task 4 | Pure decision + orchestration, watcher tests | Cross-workspace close, duplicate, or race close | named two-workspace/legacy/double-pass assertions | Exercise one Todo fail→healthy lifecycle | Real scheduling timing is represented by deterministic order fixture. |
| V5 | Tasks 1-4 | Existing safety suites + named predicates | Invalid result reaches handoff/refill or overwrites dependency | named unsuccessful-result assertions plus full suite | Verify card remains pre-material | Merge/deploy remain unreachable in spec/dev; existing suites cover gates. |
| V6 | Task 4 + owner observation | Event unit tests + Factory Learning status | Evidence suppressed/misclassified | named recovered/recurred assertions; detector diff unchanged | Seven-day `learning-status --json` | Time-window result is necessarily post-Ship and owner-observed. |
| V7 | Task 3 | Unit + dispatch, watcher tests | Stale optional key reaches child | exact-key fixture; ordinary env preserved | Inspect child fixture output | None. |

Every C1-C7 maps exactly to V1-V7 in the design. No V relies only on the broad
suite; the full suite is the final regression gate.

## Developer experience acceptance

- Stable command and exit grammar: exit 0 ready/not-routed, exit 2 trusted
  context/unreadable protocol, exit 3 live route change.
- Invalid parent classification reports problem, bounded reason, trusted
  expected identity, and retry/recovery path without raw payload or secrets.
- No new install, configuration, dependency, dashboard, or docs navigation.
- README/changelog explain attended versus scheduled authority.
- Post-implementation `/devex-review` should confirm the planned 8.8/10 internal
  CLI score and deterministic one-log diagnosis.

## Spec-sweep review audit

- **Initial tier:** Tier 2 — Material.
- **Final tier target:** Tier 2 — Material; five tasks, four interacting runtime
  boundaries, two code modules, two test modules, and release docs.
- **Risk surfaces:** child/parent trust, malformed protocol, environment
  provenance, recovery precedence, workspace fingerprint identity, legacy aliases,
  evidence continuity, and human-approved generated-card rollout.
- **Engineering spec pass:** clear after four findings were folded in.
- **Independent adversarial spec pass:** clear after workspace fingerprint
  identity, proven legacy aliasing, closed schema, and double-reconciliation
  findings were folded in. Reviewer was an independent Codex subagent because
  this runtime could not explicitly dispatch the configured preferred Claude
  reviewer; no cross-model agreement is claimed.
- **DevEx lens:** clear in DX TRIAGE; CLI outputs/errors/docs are specified.
- **Plan engineering pass:** clear after correcting workspace fingerprint
  isolation, non-path workspace identity, generic invalid-outcome diagnostics,
  trusted catch-path fields, and the repository-native full test command.
- **UI/design skipped:** no user interface or accessibility surface.
- **Security skipped:** no auth, permission, credential, external-input, or new
  disclosure boundary; existing scheduled metadata is narrowed and diagnostics
  remain sanitized.
- **Performance skipped:** declared not required; bounded local work adds no I/O.
- **Research skipped:** all mechanisms and APIs are repository-owned and known.
- **Unresolved decisions:** none.

## Engineering review — plan pass

The Tier 2 plan pass challenged file ownership, task order, interface names,
error paths, compatibility, test layers, and rollout evidence.

| # | Priority | Plan finding | Correction |
| --- | --- | --- | --- |
| P1 | P1 | A workspace-specific recovery target did not prevent same-basename route failures from sharing the old issue-based fingerprint and updating one Todo. | Make the exact workspace/card/stage target the new `stableTarget`; prove distinct fingerprints and cross-workspace mutation isolation. |
| P2 | P1 | Writing canonical source paths into `stableTarget` would disclose local filesystem layout on Linear. | Reuse deterministic `stablePathSlug` as `sourceWorkspaceId`; assert the raw path is absent. |
| P3 | P2 | `UNTRUSTED_REPO_ROUTE_OUTCOME` was misleading when invalid JSON/size/version prevents trusting the kind. | Use generic `UNTRUSTED_CHILD_OUTCOME`; valid parsed dependency/route kinds retain their specific successful classifications. |
| P4 | P1 | A config-load/Linear catch path could still copy stale CLI expected values after the pure resolver was bypassed by the error. | Require every scheduled catch path to source expected identity only from exported environment and test config-load failure with stale CLI args. |
| P5 | P2 | The draft copied a generic `npm test` gate into a repository with no `package.json`. | Use the repository's actual full command, `node --test`, in the plan and external test artifact. |

All findings were folded into Tasks 1, 2, and 4 and their V2-V4 assertions.
The final footprint remains Tier 2, one repo, five ordered tasks. No new review
lens or unresolved decision was exposed.

## Implementation tasks summary

- [ ] T1 — Bind scheduled route context and prove V1-V2.
- [ ] T2 — Close the deferred-outcome schema and prove V3/V5.
- [ ] T3 — Scrub inherited scheduled identity and prove V7.
- [ ] T4 — Add exact route identity and proven legacy aliases; prove V4/V6.
- [ ] T5 — Update release docs/version and run all contract/regression gates.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | ---: | --- | --- |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | SKIPPED | Bounded generated reliability fix; CEO review is outside spec-sweep. |
| Codex Review | independent subagent | Adversarial premise trace | 1 | CLEAR | 4 findings folded into spec and plan. |
| Eng Review | `/plan-eng-review` | Architecture & tests | 3 logs / 2 passes | CLEAR | 4 spec and 5 plan findings resolved; final log corrects the plan finding count. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | SKIPPED | No UI surface. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | CLEAR | 7/10 → 9/10; stable CLI/error/doc contract. |

**VERDICT:** SPEC + PLAN ENG + ADVERSARIAL + DX CLEARED — ready for Dev.

NO UNRESOLVED DECISIONS

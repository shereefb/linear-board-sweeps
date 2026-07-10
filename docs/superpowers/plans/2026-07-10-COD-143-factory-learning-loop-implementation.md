# COD-143 Factory Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-improving factory loop that observes every registered learning-enabled workspace, automatically creates or updates medium/high-confidence improvement cards in Spec, and measures whether shipped improvements helped.

**Architecture:** Add a focused zero-dependency `scripts/learning.mjs` engine containing schemas, bounded evidence parsing, pure detectors, aggregation, state, and mutation planning. Keep process dispatch, capacity, Linear GraphQL IO, and CLI integration in `scripts/linear-watch.mjs`. Structured sweep events and a global bounded run index feed the engine; one pinned learning runner performs optional capability-denied synthesis and retry-safe Linear writes after delivery work, using the existing capacity ledger.

**Tech Stack:** Node.js 18+ ESM, built-in `node:test`, built-in filesystem/crypto/child-process modules, existing zero-dependency Linear GraphQL helper, Markdown cross-runtime sweep instructions.

## Global Constraints

- Preserve all three lenses: reliability, quality/rework, and throughput/cost.
- Observe every registered workspace with repo-local `learning.enabled=true`, even when delivery auto-sweep activation is paused.
- High- and medium-confidence findings automatically create/update bottom-of-Spec cards without `sweep:manual-only`; low confidence accumulates only.
- Deterministic code owns identity, routing, confidence, admission, mutation, and outcomes. Synthesis may annotate only an already-qualified finding.
- Generated cards must complete real QA and stop at Signoff. They are never fast-path eligible, and Ship requires `qa:passed` for their provenance.
- One designated learning runner owns automatic learning dispatch and Linear writes. Cross-host idempotency is defense-in-depth.
- Learning is lower priority than Ship, QA, Dev, and Spec; it counts against the host ceiling and consumes no same-repo slot.
- Stable card identity is version-independent: `[factory-learning root=<rootFingerprint> generation=<n>]`.
- `factory:learning-generated` is mandatory and fail-closed before issue creation.
- No new runtime dependency, hosted service, database, public webhook, or automatic configuration tuning.
- No raw prompts, stdout/stderr, environment values, secrets, or arbitrary card comment bodies in learning state, model input, or generated cards.
- Existing configs without `learning` remain valid and disabled.
- Complete test coverage is required for every branch listed in the design's test diagram.

---

## Engineering review decisions (unattended prose mode)

The approved design exceeded eight touched files because the complete feature spans scheduler code, canonical/installable skills, setup taxonomy, tests, and operator documentation. The user explicitly required maintaining scope, so the review retained the complete implementation and reduced complexity through one focused module rather than by removing capabilities.

### D1 — Stable identity across detector upgrades

ELI10: A detector version is implementation provenance, not the identity of the problem. If it lives in the lookup key, upgrading detection creates duplicate auto-swept cards.

Recommendation: use a version-independent root/generation marker and store detector versions separately.

**A) Version-independent marker (recommended). Completeness: 10/10.** Preserves one durable problem identity while retaining exact detector provenance in evidence blocks. Adds one explicit v1-to-v2 convergence test.

**B) Versioned marker. Completeness: 4/10.** Easier lookup text but duplicates active work after detector changes.

Net: adopt A.

### D2 — Registered versus delivery-active workspaces

ELI10: Pausing delivery should not make factory health history disappear. Learning enablement and delivery activation are separate controls.

Recommendation: build a learning workspace set from the registry/config before filtering delivery anchors by the `auto-sweep` project label.

**A) Separate workspace sets (recommended). Completeness: 10/10.** Preserves complete observation while leaving current delivery pause semantics unchanged.

**B) Reuse active delivery anchors. Completeness: 6/10.** Smaller diff but violates the approved every-registered-workspace scope.

Net: adopt A.

### D3 — Generated-card fast-path defense

ELI10: A generated improvement must be user-tested before Signoff. The existing fast path can skip that path unless both Dev and Ship recognize provenance.

Recommendation: exclude generated cards in Dev and require `qa:passed` in Ship as defense-in-depth.

**A) Producer and ship-gate checks (recommended). Completeness: 10/10.** Prevents both normal and stale/manually-added fast-path bypasses.

**B) Dev-only exclusion. Completeness: 7/10.** Correct in the normal path but trusts labels at the production boundary.

Net: adopt A.

### D4 — Capacity ledger support

ELI10: Calling a demand “learning” does not make the current ledger accept it. Stage, trigger, singleton identity, priority, and restart reconciliation must be explicit.

Recommendation: extend ledger validation for one registry-scoped learning reservation without adding learning to `SWEEP_CFG`.

**A) Explicit learning demand schema (recommended). Completeness: 10/10.** Reuses capacity safety and makes priority/recovery testable.

**B) Spawn outside the ledger. Completeness: 3/10.** Bypasses the host ceiling and breaks crash recovery.

Net: adopt A.

### D5 — Structured evidence and complete pagination

ELI10: Arbitrary prose is not a trustworthy database, and the newest 100 comments are not the complete idempotency history.

Recommendation: add a closed event taxonomy, a global run index, and a dedicated paginated marker/evidence scanner with cursor-cycle failure.

**A) Structured events plus complete scanner (recommended). Completeness: 10/10.** Provides reliable quality evidence and retry keys without parsing instructions.

**B) Parse existing comments/logs. Completeness: 4/10.** Faster initially but brittle, unbounded, and unsafe.

Net: adopt A.

### D6 — Capability-denied synthesis

ELI10: The writer, not a model child, owns mutation authority. Removing the Linear key is necessary but not sufficient when global tools or workspace files remain reachable.

Recommendation: run synthesis from an isolated temp directory with an allowlisted environment, no Linear/repo secrets, disabled tools/MCPs, read-only/ephemeral runtime flags, and schema-validated output. Fall back to deterministic card text on failure.

**A) Capability-denied optional synthesis (recommended). Completeness: 10/10.** Keeps automation available without trusting synthesis for correctness.

**B) Normal agent environment. Completeness: 4/10.** Simpler but violates the mutation trust boundary.

Net: adopt A.

### D7 — Canonical anchor identity and provenance

ELI10: Two symlink spellings of one repo must not become two workspaces, and an auto-generated card without its provenance label must never enter the pipeline.

Recommendation: canonicalize with realpath fallback, reject alias duplicates, and require the provenance label ID before `issueCreate`.

**A) Canonical and fail-closed (recommended). Completeness: 10/10.** Keeps routing/evidence stable and makes generated authority visible.

**B) Resolved strings and best-effort labels. Completeness: 5/10.** Preserves existing convenience but permits split identity and unmarked cards.

Net: adopt A.

### D8 — Generation-cap discoverability

ELI10: A Done card blocked for explicit recursion review is useless if the unblock workflow can never show it.

Recommendation: include Done only for learning-generated cards carrying a supported blocking label, after normal unblock states.

**A) Provenance-scoped Done unblock (recommended). Completeness: 10/10.** Makes the cap operable without flooding the manual queue.

**B) Leave Done excluded. Completeness: 6/10.** Keeps old ordering but strands the approved human review path.

Net: adopt A.

## What already exists

- `normalizeRegistry()`, managed anchor records, and `workspaceRepoPairs()` provide registry and routing foundations; extend them rather than add another registry.
- `atomicWriteJson()` provides the required crash-safe state writer.
- `writeRunRecord()` already captures card/stage/runtime/outcome/queue/capacity evidence; enrich and mirror its sanitized result into a global daily index.
- `failureFingerprint()`, self-clearing Todos, reaper/bounce markers, and observation percentiles provide reliability and throughput inputs.
- `createCapacityLedger()`, `createAdmissionQueue()`, and admission priorities already enforce the host ceiling and restart recovery.
- `teamMeta()`, `teamLabelMap()`, `addComment()`, issue create/update GraphQL, and bottom-rank helpers provide Linear mutation primitives.
- `doctorReport()` and `formatDoctorReport()` already expose versioned local state.
- `setup-team` already creates canonical workflow labels idempotently.

## File map

| Path | Responsibility |
| --- | --- |
| `scripts/learning.mjs` | New pure learning contracts, state normalization, event validation, bounded evidence readers, detectors, aggregation, outcome evaluation, and mutation planning. |
| `tests/learning.test.mjs` | New exhaustive unit and temp-filesystem tests for the learning engine. |
| `scripts/linear-watch.mjs` | Registry integration, card event env/CLI, global run index, learning due/run/status commands, capacity entry, synthesis dispatch, Linear IO, outcome orchestration, and doctor integration. |
| `tests/linear-watch.test.mjs` | Integration tests for scheduling, process capability boundary, GraphQL pagination/idempotency, writer, diagnostics, and restart behavior. |
| `scripts/linear.mjs` / `tests/linear.test.mjs` | Required provenance label and any reusable bottom-of-Spec create input helper. |
| `skills/{spec,dev,qa,ship}-sweep/SKILL.md` | Structured event emission and generated-card pipeline rules. |
| `.claude/skills/{spec,dev,qa,ship}-sweep/SKILL.md` | Installed canonical copies, kept byte-identical. |
| `skills/unblock-sweep/SKILL.md` + installed copy | Provenance-scoped Done generation-cap review behavior. |
| `templates/linear-sweep.json` / `.claude/linear-sweep.json` | Learning enablement and dogfood configuration. |
| `templates/AGENTS.snippet.md` / `AGENTS.md` | Describe the learning loop, new provenance label, and operator commands. |
| `README.md`, `SETUP.md`, `docs/linear-rules.md` | Operator architecture, setup, lifecycle, and safety rules. |
| `CHANGELOG.md`, `VERSION` | Release record and version bump during shipping. |

## Task 1: Learning contracts, canonical identity, and state

**Files:**
- Create: `scripts/learning.mjs`
- Create: `tests/learning.test.mjs`
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/learning.test.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Produces `LEARNING_STATE_VERSION`, `LEARNING_STAGE`, `LEARNING_TRIGGER`, `LEARNING_LENSES`, and `LEARNING_EVENT_TAXONOMY`.
- Produces `canonicalAnchorIdentity(path, deps?) -> string`.
- Produces `normalizeLearningRegistry(registry, deps?) -> normalizedRegistry` and `normalizeWorkspaceLearning(config) -> normalizedLearningConfig`.
- Produces `createLearningStateStore({ statePath, readJsonFn, writeJsonFn, now })` with `snapshot()`, `stageWindow()`, `confirmMutation()`, and `commitLens()`.
- `linear-watch.mjs` imports these interfaces; later tasks consume them unchanged.

- [ ] **Step 1: Write failing config, identity, and state tests**

```js
test("learning config defaults disabled and clamps the create budget", () => {
  assert.deepEqual(normalizeWorkspaceLearning({}), {
    enabled: false,
    lenses: { reliability: true, quality: true, throughput: true },
  });
  const reg = normalizeLearningRegistry({
    repos: ["/repo"],
    learning: { enabled: true, runner: true, coreSourceAnchor: "/repo", maxNewCardsPerRun: 999 },
  }, { realpathFn: (p) => p });
  assert.equal(reg.learning.maxNewCardsPerRun, 6);
});

test("canonical anchor aliases are rejected", () => {
  assert.throws(() => normalizeLearningRegistry({ repos: ["/a", "/alias"] }, {
    realpathFn: () => "/same",
  }), /duplicate canonical anchor/);
});

test("learning state write-ahead window survives an unconfirmed Linear write", () => {
  const store = memoryLearningStore();
  store.stageWindow("quality", {
    from: "2026-07-01T00:00:00.000Z",
    capturedThrough: "2026-07-08T00:00:00.000Z",
    mutations: [{ mutationId: "m1", action: "create" }],
  });
  assert.equal(store.snapshot().lenses.quality.pending.mutations.m1.status, "pending");
  assert.equal(store.snapshot().lenses.quality.lastSuccessfulCapturedThrough, null);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/learning.test.mjs tests/linear-watch.test.mjs`

Expected: import/export failures because the learning module and registry support do not exist.

- [ ] **Step 3: Implement the minimal contracts and atomic state store**

Implement explicit constants and pure normalizers. Canonical identity must use injected/real `fs.realpathSync.native` when possible and `path.resolve` only for a missing path. Reject duplicate aliases before mutating registry records. The store writes versioned state through injected `writeJsonFn` and advances a lens watermark only after every staged mutation is confirmed.

- [ ] **Step 4: Integrate normalized learning registry fields without changing legacy output**

`defaultRegistry()` gains:

```js
learning: {
  enabled: false,
  runner: false,
  coreSourceAnchor: null,
  maxNewCardsPerRun: 6,
  runtime: null,
}
```

`normalizeRegistry()` calls the imported normalizer and continues preserving unrelated fields. Registration uses canonical identity and refuses an existing alias.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `node --test tests/learning.test.mjs tests/linear-watch.test.mjs`

Expected: all focused tests pass with no changes to existing registry fixtures beyond normalized defaults.

- [ ] **Step 6: Commit Task 1**

```bash
git add scripts/learning.mjs scripts/linear-watch.mjs tests/learning.test.mjs tests/linear-watch.test.mjs
git commit -m "feat: add Factory Learning contracts (COD-143)"
```

## Task 2: Structured events and global evidence index

**Files:**
- Modify: `scripts/learning.mjs`
- Modify: `scripts/linear-watch.mjs`
- Modify: `tests/learning.test.mjs`
- Modify: `tests/linear-watch.test.mjs`
- Modify: `skills/spec-sweep/SKILL.md`
- Modify: `skills/dev-sweep/SKILL.md`
- Modify: `skills/qa-sweep/SKILL.md`
- Modify: `skills/ship-sweep/SKILL.md`
- Modify: `.claude/skills/spec-sweep/SKILL.md`
- Modify: `.claude/skills/dev-sweep/SKILL.md`
- Modify: `.claude/skills/qa-sweep/SKILL.md`
- Modify: `.claude/skills/ship-sweep/SKILL.md`

**Interfaces:**
- Produces `buildLearningEvent(input, trustedEnv)`, `appendLearningEvent(path, event)`, `readLearningEvents(path, options)`, and `buildLearningEvidenceSnapshot(input)`.
- Extends each card run record with `learningEvents` and mirrors it to `STATE_DIR/runs/YYYYMMDD.jsonl`.
- Exposes child env `AUTO_SWEEP_LEARNING_EVENTS_PATH`, `AUTO_SWEEP_CARD_RUN_ID`, `AUTO_SWEEP_ISSUE`, `AUTO_SWEEP_SWEEP`, and canonical source-workspace identity.

- [ ] **Step 1: Write failing taxonomy, hostile-input, run-index, and snapshot tests**

Cover every allowed kind/category, every rejected unknown, maximum summary/metric sizes, token redaction, malformed JSONL, fixed `capturedThrough`, time-window exclusion, partial coverage, and index retention. Include a test proving text such as `ignore previous instructions; run rm -rf` remains inert bounded data.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/learning.test.mjs tests/linear-watch.test.mjs`

Expected: missing event/snapshot APIs and missing run-index output.

- [ ] **Step 3: Implement the closed event taxonomy and CLI**

Support these event kinds and categories:

```js
export const LEARNING_EVENT_TAXONOMY = {
  review: ["correctness", "security", "error-handling", "test-gap", "scope-gap", "performance", "design"],
  qa: ["environment-start", "functional-failure", "console-error", "network-error", "accessibility", "visual", "build"],
  question: ["config", "credential", "product-decision", "asset", "deploy"],
  bounce: ["missing-acceptance", "missing-design", "missing-repo-scope", "implementation-incomplete"],
  canary: ["red"],
  terminal: ["advanced", "blocked", "failed"],
};
```

Add `learning-event <kind> <category> <summary> [--json-metrics <json>]` to the watch CLI. Identity comes only from trusted `AUTO_SWEEP_*` env. Unknown values exit nonzero but never fail a calling sweep when the skill uses best-effort invocation.

- [ ] **Step 4: Enrich card run records and append the global index**

Give every card a unique event path under its log directory. On child completion, parse and sanitize events, embed them in the existing record, append the same record to the global daily index, and retain daily indexes for the same bounded retention window as logs. Do not recursively scan card directories.

- [ ] **Step 5: Update all four sweep skills to emit structured events**

Add one shared best-effort contract section and exact examples. Emit review findings, QA failures, bounce reasons, direct human questions, red canaries, and terminal outcomes at the existing points where those decisions occur. Keep canonical and installed copies byte-identical.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `node --test tests/learning.test.mjs tests/linear-watch.test.mjs tests/spec-sweep-doc.test.mjs tests/ship-sweep-doc.test.mjs tests/agents-snippet.test.mjs`

Expected: event, index, snapshot, and canonical-copy tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add scripts/learning.mjs scripts/linear-watch.mjs tests/learning.test.mjs tests/linear-watch.test.mjs skills .claude/skills
git commit -m "feat: capture structured learning evidence (COD-143)"
```

## Task 3: Detectors, aggregation, and outcome evaluation

**Files:**
- Modify: `scripts/learning.mjs`
- Modify: `tests/learning.test.mjs`

**Interfaces:**
- Produces `runLearningDetectors(snapshot, config) -> Finding[]`.
- Produces `aggregateLearningFindings(findings) -> AggregateFinding[]`.
- Produces `rankQualifiedFindings(findings, maxNewCards) -> { admitted, deferred }`.
- Produces `evaluateLearningOutcome(evaluation, snapshot) -> OutcomeDecision`.
- Produces deterministic `renderFindingCard()` and `renderEvidenceDelta()` fallbacks.

- [ ] **Step 1: Write the complete failing detector matrix**

For every detector in the design, test below threshold, exact threshold, above threshold, distinct-card/run requirements, confidence, stable fingerprint, local/core scope, evidence coverage downgrade, and detector-version convergence. Throughput tests must prove the twenty-run floor and absolute-plus-relative regression requirement.

- [ ] **Step 2: Write failing aggregation and outcome tests**

Cover cross-lens root grouping, occurrence dedupe, ranking, six-create budget with unlimited updates, all four outcome statuses, fresh-evidence generation, one-active-generation rule, three-generation cap, and inconclusive coverage.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/learning.test.mjs`

Expected: detector/aggregation/evaluation APIs are absent.

- [ ] **Step 4: Implement pure detectors exactly from the design tables**

Detector definitions must declare `id`, `version`, `lens`, `minimumSample`, `qualify`, `fingerprintParts`, `metric`, and `evaluationWindow`. Hash only normalized stable facts with SHA-256; never include prose order, host display name, or detector version in the root fingerprint.

- [ ] **Step 5: Implement aggregation, ranking, deterministic rendering, and evaluation**

Grouping may merge only compatible root fingerprints and ownership scopes. The renderer must include observation, counts, evidence references, coverage, hypothesis label, desired outcome, acceptance metric, baseline, evaluation window, exclusions, marker, and detector provenance. No placeholder text is permitted.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `node --test tests/learning.test.mjs`

Expected: the full detector and outcome matrix passes.

- [ ] **Step 7: Commit Task 3**

```bash
git add scripts/learning.mjs tests/learning.test.mjs
git commit -m "feat: detect and evaluate factory improvements (COD-143)"
```

## Task 4: Low-priority learning scheduling and capability-denied synthesis

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Modify: `tests/linear-watch.test.mjs`
- Modify: `scripts/learning.mjs`
- Modify: `tests/learning.test.mjs`

**Interfaces:**
- Extends capacity entries to accept stage `learning` and trigger `learning` with a registry-scoped singleton key.
- Produces `learningDueDecisions()`, `buildLearningDemand()`, `buildLearningSynthesisCommand()`, and `dispatchLearningAsync()`.
- Adds `learning-status [--json]`, `learning-run [--dry-run]`, and `learning-run --automatic` internal execution.

- [ ] **Step 1: Write failing priority, singleton, restart, and due tests**

Prove Ship/QA/Dev/Spec outrank learning, only one learning reservation survives, a live reservation reconciles across restart, dead entries prune, capacity deferral preserves due state, learning consumes no same-repo slot, reliability/quality/throughput cadence rules work, and paused delivery workspaces remain observable.

- [ ] **Step 2: Write failing command-security tests**

Assert the Codex command includes `--sandbox read-only`, `--ephemeral`, `--ignore-user-config`, `--output-schema`, isolated `--cd`, and no writable repo directory. Assert Claude includes `--safe-mode`, `--strict-mcp-config` with an empty config, `--tools ""`, `--json-schema`, `--no-session-persistence`, and isolated cwd. Assert the child environment excludes `LINEAR_API_KEY`, API/token/secret-like keys, and repo env values.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/learning.test.mjs tests/linear-watch.test.mjs`

Expected: capacity validation rejects learning and no learning commands exist.

- [ ] **Step 4: Extend capacity validation and priority explicitly**

Do not add learning to `SWEEP_CFG`, `SWEEPS`, or propagated canonical sweep lists. Extend ledger stage/trigger validation only, use a stable registry demand key, and reject a second live learning reservation. Add the explicit lowest stage priority.

- [ ] **Step 5: Implement separate learning and delivery workspace resolution**

Read every registered config and key once. Build `learningWorkspaces` from repo-local learning enablement before activation filtering; derive delivery `anchors` exactly as today. Missing config/key produces named coverage/failure evidence without aborting other workspaces.

- [ ] **Step 6: Implement due checks and post-delivery spare-capacity dispatch**

Run the learning due check after delivery drain completes so it cannot suppress delivery candidates. Reserve through the capacity ledger, synthesize at most one registry batch, write the structured result, and release in `finally`. A runtime/model failure returns deterministic card rendering and records synthesis unavailable.

- [ ] **Step 7: Implement learning status and dry-run commands**

`learning-status` is read-only. `learning-run --dry-run` reads real bounded evidence and prints proposed creates/updates/evaluations without Linear mutation or cursor advancement. Non-dry `learning-run` requires `registry.learning.runner=true`.

- [ ] **Step 8: Run tests and verify GREEN**

Run: `node --test tests/learning.test.mjs tests/linear-watch.test.mjs`

Expected: scheduling/security/CLI tests pass and all existing dispatch tests remain green.

- [ ] **Step 9: Commit Task 4**

```bash
git add scripts/learning.mjs scripts/linear-watch.mjs tests/learning.test.mjs tests/linear-watch.test.mjs
git commit -m "feat: schedule bounded factory learning (COD-143)"
```

## Task 5: Retry-safe Linear writer, routing, labels, and recursion review

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Modify: `tests/linear-watch.test.mjs`
- Modify: `scripts/linear.mjs`
- Modify: `tests/linear.test.mjs`
- Modify: `skills/unblock-sweep/SKILL.md`
- Modify: `.claude/skills/unblock-sweep/SKILL.md`
- Modify: `tests/unblock-sweep-doc.test.mjs`

**Interfaces:**
- Produces paginated `fetchLearningIssues()` and `fetchLearningIssueComments()`.
- Produces `planLearningMutations(findings, liveIssues, config)` in `learning.mjs` and `executeLearningMutations()` in the watcher.
- Extends `REQUIRED_LABELS` with `factory:learning-generated`.
- Extends unblock normalization/order only for Done generated cards carrying supported blockers.

- [ ] **Step 1: Write failing mutation-matrix and pagination tests**

Cover no match, active match, Signoff/Ship preservation, Done recurrence, duplicate matches, marker older than 100 comments, cursor cycle, partial GraphQL error, timeout-after-success, human field/state preservation, bottom-of-Spec confirmation, route-label inclusion, missing provenance label failure, and unlimited update/six-create behavior.

- [ ] **Step 2: Write failing recursion/unblock tests**

Cover one generation, three-generation cap, one blocker comment/label, Done generated card appearing after normal unblock states, unrelated Done blocked cards remaining excluded, and resolution preserving Done.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/learning.test.mjs tests/linear-watch.test.mjs tests/linear.test.mjs tests/unblock-sweep-doc.test.mjs`

Expected: writer/query/label/unblock behavior is missing.

- [ ] **Step 4: Add migration-safe provenance label setup**

Add `factory:learning-generated` to `REQUIRED_LABELS` and setup tests. The writer independently loads the full team label map and refuses `issueCreate` if the exact label ID is absent. Do not reuse generic best-effort label filtering.

- [ ] **Step 5: Implement complete marker and occurrence scanning**

Paginate issues and comments with `pageInfo`, require complete pages, track seen cursors, and fail closed on a cycle or partial GraphQL response. Search by the version-independent marker and confirm all occurrence IDs before deciding.

- [ ] **Step 6: Implement create/update/recurrence/duplicate execution**

Persist each planned mutation before IO, execute comment/issue/relation/rank writes, re-read exact state/labels/marker/occurrences, then confirm the mutation. Creates include provenance and exact repo route label, omit `sweep:manual-only`, and land at bottom of Spec. Updates never replace human title/description/state/labels.

- [ ] **Step 7: Implement capped-generation unblock visibility**

Extend the query and ordering only for Done cards with both learning provenance and a supported blocking label. Update the skill contract and canonical copy.

- [ ] **Step 8: Run tests and verify GREEN**

Run: `node --test tests/learning.test.mjs tests/linear-watch.test.mjs tests/linear.test.mjs tests/unblock-sweep-doc.test.mjs`

Expected: the full mutation/retry/recursion matrix passes.

- [ ] **Step 9: Commit Task 5**

```bash
git add scripts/learning.mjs scripts/linear-watch.mjs scripts/linear.mjs tests skills/unblock-sweep .claude/skills/unblock-sweep
git commit -m "feat: write learning improvements to Linear (COD-143)"
```

## Task 6: Pipeline safety, diagnostics, templates, and documentation

**Files:**
- Modify: `skills/dev-sweep/SKILL.md`
- Modify: `skills/ship-sweep/SKILL.md`
- Modify: `.claude/skills/dev-sweep/SKILL.md`
- Modify: `.claude/skills/ship-sweep/SKILL.md`
- Modify: `scripts/linear-watch.mjs`
- Modify: `tests/linear-watch.test.mjs`
- Modify: `tests/ship-sweep-doc.test.mjs`
- Modify: `templates/linear-sweep.json`
- Modify: `.claude/linear-sweep.json`
- Modify: `templates/AGENTS.snippet.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `docs/linear-rules.md`

**Interfaces:**
- `doctorReport().learning` and human formatting expose lens/due/coverage/pending/error/evaluation state.
- Dev/Ship skills enforce generated-card QA/Signoff invariants.
- Templates document learning config, runner pin, commands, labels, and migration.

- [ ] **Step 1: Write failing doctor, skill-contract, and template tests**

Assert complete doctor JSON/human output, disabled/default state, missing/corrupt state gaps, due/pending/evaluation summaries, Dev fast-path exclusion, Ship `qa:passed` defense, canonical skill copies, config defaults, and AGENTS/README/setup taxonomy.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/linear-watch.test.mjs tests/ship-sweep-doc.test.mjs tests/spec-sweep-doc.test.mjs tests/agents-snippet.test.mjs`

Expected: learning diagnostics and documentation contracts are absent.

- [ ] **Step 3: Implement doctor and operator output**

Add an explicit `learning` report with enabled/runner/active, each lens's last success/due/sample/pending/error, coverage gaps, active/due evaluations, and synthesis availability. Learning errors may make learning diagnostics red but must not mark ordinary sweep health failed unless the shared launcher itself is unhealthy.

- [ ] **Step 4: Harden Dev and Ship skills**

Dev: before fast-path evaluation, declare `factory:learning-generated` an unconditional ineligibility reason. Ship: for that provenance, accept only `qa:passed`, never `fast-path:eligible`. Update installed copies and tests.

- [ ] **Step 5: Update configs and operator docs**

Document disabled-by-default workspace learning, registry runner/core setup, the three lenses, commands, capacity priority, auto-created Spec lifecycle, provenance label, migration setup rerun, outcome evaluation, recursion cap, security boundary, and kill switch. Enable all lenses in this repository's `.claude/linear-sweep.json` for dogfood; do not commit machine-specific source paths or runner registry state.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `node --test`

Expected: every existing and new test passes.

- [ ] **Step 7: Commit Task 6**

```bash
git add AGENTS.md README.md SETUP.md docs/linear-rules.md templates .claude skills scripts/linear-watch.mjs tests
git commit -m "docs: operate the Factory Learning Loop (COD-143)"
```

## Task 7: Dogfood, full verification, review, and ship evidence

**Files:**
- Modify if required by review: files named by verified findings only
- Modify: `CHANGELOG.md`
- Modify: `VERSION`
- Evidence: Linear `COD-143`

- [ ] **Step 1: Run a clean full test suite**

Run: `node --test`

Expected: all tests pass, zero failures/cancellations.

- [ ] **Step 2: Run historical learning dry-run**

Run: `node scripts/linear-watch.mjs learning-run --dry-run`

Expected: bounded coverage report and deterministic proposed create/update/evaluation list; no Linear writes or cursor advancement.

- [ ] **Step 3: Configure the local registry for attended dogfood without committing machine state**

Set `learning.enabled=true`, `learning.runner=true`, and `coreSourceAnchor` to the canonical registered COD-143 source anchor using a CLI command added by Task 4 or an idempotent registry writer. Confirm `learning-status --json` resolves the exact core project and all learning-enabled registered workspaces.

- [ ] **Step 4: Rerun team setup and execute one live learning pass**

Run the idempotent setup helper so provenance exists, then run `learning-run`. Confirm no more than six new Spec cards, unlimited idempotent updates, exact markers/labels/routes, no `sweep:manual-only`, bottom rank, and no duplicate occurrence comments. If historical data produces no qualified finding, use a temporary isolated fixture project/card and cleanly cancel the fixture after evidence is captured.

- [ ] **Step 5: Run independent code review and fix all verified P0/P1/P2 findings**

Review from `git merge-base origin/main HEAD` to `HEAD` against the design and this plan. Every fix must receive a regression test and a focused then full verification run.

- [ ] **Step 6: Re-run complete verification after review fixes**

Run:

```bash
git diff --check
node --test
node scripts/linear-watch.mjs doctor --json
node scripts/linear-watch.mjs learning-status --json
node scripts/linear-watch.mjs learning-run --dry-run
```

Expected: clean diff, all tests green, parseable diagnostics, bounded dry-run, and no unexpected writes.

- [ ] **Step 7: Update release metadata and COD-143 evidence**

Bump the patch version, add a CHANGELOG entry describing the operator-visible feature and migration, commit release metadata, and comment COD-143 with spec/plan paths, commits, test counts, dry/live evidence, review outcome, residual risk, and rollback/disable command.

- [ ] **Step 8: Ship from the feature branch**

Fetch/merge `origin/main`, rerun verification, push, create/update the PR, wait for required checks/reviews, merge to main, verify `origin/main` contains the merge, and move COD-143 to Done with the merge commit. This repo has no production app deploy; merge/push to main is the configured ship path.

## Test coverage diagram

```text
CODE PATHS                                           OPERATOR / BOARD FLOWS
[ ] scripts/learning.mjs                             [ ] registered learning workspace observation
  +-- config/canonical identity                        +-- delivery active
  |   +-- legacy disabled                              +-- delivery paused
  |   +-- valid core/local route                     [ ] learning scheduling
  |   +-- missing/alias conflict                       +-- no due work: zero model
  +-- state/WAL                                        +-- delivery work outranks learning
  |   +-- stage/confirm/commit                         +-- spare capacity/singleton/restart
  |   +-- corrupt/missing/retry                      [ ] automatic Linear lifecycle
  +-- event/index/snapshot                             +-- create bottom Spec + provenance
  |   +-- every taxonomy branch                        +-- update active/Signoff/Ship
  |   +-- hostile/malformed/partial                    +-- Done recurrence/duplicates
  |   +-- bounded retention/window                     +-- >100 comments/timeouts
  +-- 15 initial detectors                           [ ] generated-card safety
  |   +-- below/at/above threshold                     +-- no fast path
  |   +-- low/medium/high/severe                       +-- QA passed + Signoff
  |   +-- 20-run throughput floor                      +-- Ship rejects stale fast label
  +-- aggregate/rank/render                          [ ] outcome loop
  |   +-- cross-lens/dedupe/budget                     +-- four outcomes
  |   +-- deterministic fallback                       +-- fresh follow-up
  +-- outcome evaluator                                +-- generation cap + unblock
[ ] scripts/linear-watch.mjs                         [ ] operator UX
  +-- event CLI/global index                           +-- status JSON/human
  +-- ledger demand/due/priority                       +-- doctor JSON/human
  +-- secure synthesis/fallback                        +-- dry-run no mutation
  +-- paginated writer/confirmation                    +-- live dogfood

EVAL: synthesis schema fixtures must prove no authority-field changes and safe
fallback. No browser E2E is required because this repository has no app UI.
```

## Failure modes

| Codepath | Production failure | Test | Handling | Operator impact |
| --- | --- | --- | --- | --- |
| Config/core routing | Symlink alias or missing core | Unit + integration | Reject alias; keep core findings pending | Exact doctor diagnostic, no misfiled card |
| Evidence read | Malformed/truncated JSONL | Unit | Skip record, mark coverage partial | Finding confidence may drop; ordinary sweeps continue |
| Event append | Invalid category or hostile summary | Unit | Reject/bound/redact; sweep best-effort continues | Named local warning only |
| Global index | Write fails after card record | Integration | Record metrics gap; learning retries from card/local window | Learning delayed, delivery unaffected |
| Detector | Exception or insufficient sample | Unit | Isolate detector; keep other lenses | Detector error in status |
| Capacity | Full/malformed ledger | Integration | Defer/fail closed through existing ledger | Learning pending, delivery safety preserved |
| Synthesis | Runtime missing, schema invalid, or tool attempt | Integration/eval | Kill/reject and use deterministic body | Card still automated with synthesis-unavailable note |
| Linear search | Partial page or cursor cycle | Integration | Fail closed and retain pending mutation | No duplicate-risk write |
| Linear create | Timeout after success | Integration | Re-search marker and reconcile | At most one active primary |
| Provenance | Required label missing | Integration | Refuse create and surface setup error | No unmarked generated card |
| Human race | State/labels change during write | Integration | Re-read and preserve live fields | Evidence appended without overriding human action |
| Outcome | Window lacks sufficient evidence | Unit | Record inconclusive, no follow-up | Honest result on card |
| Recursion | Fourth automatic generation qualifies | Unit/integration | Block latest card and expose via unblock | Human decides before more work |

No path may have a silent failure with neither a test nor explicit diagnostic.

## Performance review

- Read one global daily run index rather than recursively discovering per-card logs.
- Bound JSONL days, lines, bytes, strings, occurrence references, and Linear pages.
- Reuse one evidence snapshot across all three lenses.
- Perform the due check locally and dispatch no model when no lens/evaluation is due.
- Run one learning batch per registry and at most six creates per batch.
- Place learning after delivery work and enforce the existing host ceiling.
- Treat Linear GraphQL `errors` as failure even with HTTP 200, matching Linear's official API guidance.
- Use async `spawn` with existing AbortSignal/double-settle guards; do not add another synchronous long-running child path.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
| --- | --- | --- |
| Contracts/state | `scripts/`, `tests/` | — |
| Evidence bridge | `scripts/`, `tests/`, sweep skills | Contracts/state |
| Detectors/outcomes | `scripts/learning.mjs`, learning tests | Contracts/state + evidence schema |
| Scheduler/synthesis | watcher + watcher tests | Contracts/state + detector output |
| Linear writer | watcher/Linear helpers + tests | Finding/mutation contracts |
| Safety/docs | sweep skills, templates, docs | Stable contracts and writer behavior |
| Dogfood/ship | whole branch | All implementation tasks |

Lane A: Contracts/state -> evidence bridge -> scheduler/synthesis -> Linear writer (sequential shared scheduler interfaces).

Lane B: Detectors/outcomes after the event/finding schema stabilizes; it can proceed independently of scheduler IO.

Lane C: Skill safety/docs after exact event CLI and provenance contracts stabilize; it can proceed independently of detector internals.

Launch B and C in parallel after Task 2. Merge/review them, then finish watcher integration and dogfood sequentially. Lanes A and writer work both touch `scripts/linear-watch.mjs`, so they must not run concurrently.

## NOT in scope

- Hosted dashboard, cross-host warehouse, database, queue service, or public webhook.
- Product/customer feedback, PostHog, support, Stripe, session replay, or churn adapters.
- Removal of the human Ship gate, automatic `ship:approved`, rollback automation, or fast-path use for generated work.
- Direct automatic changes to capacity, cadence, models, review depth, or detector thresholds outside a generated audited card.
- Invented token or dollar costs when runtimes do not expose them.
- Broad decomposition/refactor of the existing launcher unrelated to the learning boundary.
- Release publication outside merge/push to main; this kit's configured ship path has no production app deploy.

## Implementation Tasks

Synthesized from the engineering review. Each task derives from a verified finding or approved requirement.

- [ ] **T1 (P1, human: ~6h / CC: ~45min)** — contracts/state — Add canonical identities, normalized learning configuration, and write-ahead state.
  - Surfaced by: architecture review — symlink aliases and unconfirmed writes need stable recovery semantics.
  - Files: `scripts/learning.mjs`, `scripts/linear-watch.mjs`, learning/watcher tests.
  - Verify: focused config/state/restart tests.
- [ ] **T2 (P1, human: ~8h / CC: ~60min)** — evidence — Add validated sweep events and a bounded global run index.
  - Surfaced by: architecture/security review — arbitrary prose and recursive log scans cannot drive automatic admission.
  - Files: learning/watcher modules, four canonical/installed sweep skills, tests.
  - Verify: taxonomy, hostile input, malformed data, retention, and canonical-copy tests.
- [ ] **T3 (P1, human: ~10h / CC: ~75min)** — detectors — Implement all three lenses, aggregation, ranking, rendering, and outcome evaluation.
  - Surfaced by: approved scope — complete reliability, quality, throughput, and closed-loop measurement.
  - Files: `scripts/learning.mjs`, `tests/learning.test.mjs`.
  - Verify: every detector boundary and outcome branch.
- [ ] **T4 (P1, human: ~8h / CC: ~60min)** — scheduling — Admit one low-priority capability-denied learning child through the host ledger.
  - Surfaced by: architecture review — current ledger rejects unknown stage/trigger and normal runtime env violates the trust boundary.
  - Files: watcher/learning modules and tests.
  - Verify: priority, singleton, restart, secure command/env, due, and fallback tests.
- [ ] **T5 (P1, human: ~10h / CC: ~75min)** — Linear writer — Add complete pagination, marker/occurrence idempotency, routing, recurrence, and fail-closed provenance.
  - Surfaced by: architecture review — newest-100 comments and best-effort labels cannot guarantee retry safety.
  - Files: watcher/Linear helpers, unblock skill, tests.
  - Verify: mutation matrix, >100 comments, timeout, duplicate, generation, and unblock tests.
- [ ] **T6 (P1, human: ~5h / CC: ~40min)** — safety/operator UX — Enforce QA/Signoff, expose diagnostics, and document/migrate configuration.
  - Surfaced by: architecture/DX review — generated cards can otherwise use fast path and operators cannot inspect/control learning.
  - Files: sweep skills, watcher diagnostics, templates, AGENTS, README, SETUP, rules, tests.
  - Verify: full test suite and docs contracts.
- [ ] **T7 (P1, human: ~4h / CC: ~45min)** — dogfood/ship — Exercise historical and live paths, fix review findings, and ship with evidence.
  - Surfaced by: test/release review — automatic mutation requires observed live proof and merge verification.
  - Files: verified fixes, VERSION, CHANGELOG, COD-143 evidence.
  - Verify: complete ship checklist and origin/main merge.

## Engineering review completion summary

- Step 0 Scope Challenge: complete scope accepted as-is per explicit user direction; no approved capability reduced.
- Architecture Review: 8 issues found and folded.
- Code Quality Review: focused-module boundary and closed-taxonomy corrections folded; no unresolved issues.
- Test Review: combined code/operator coverage diagram produced; every identified gap mapped to a task.
- Performance Review: bounded global index, one shared snapshot, local due check, and low-priority capacity behavior folded; no unresolved issues.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 0 proposed; no deferred implementation is required for the approved feature.
- Failure modes: 0 silent critical gaps after planned tests and diagnostics.
- Outside voice: independent reviewer completed; all 8 verified findings folded.
- Parallelization: 3 lanes, 2 conditionally parallel after contracts stabilize, scheduler/writer sequential.
- Lake Score: 8/8 review recommendations chose the complete option.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | User-approved scope was preserved without reduction |
| Codex Review | independent reviewer | Independent second opinion | 1 | clear | 8 findings folded: stable identity, workspace scope, fast path, ledger, pagination, canonical paths, provenance, unblock visibility |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clear | Full architecture, code quality, test, performance, security, failure, and distribution review completed in prose mode |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not applicable | No application UI scope |
| DX Review | embedded operator review | Developer experience gaps | 1 | clear | Status, dry-run, doctor, migration, disable, and diagnostics requirements folded |

- **CODEX:** Independent review corrections were incorporated without reducing any approved lens, automation, routing, measurement, or safety scope.
- **VERDICT:** ENG + INDEPENDENT REVIEW CLEARED — ready to implement.

NO UNRESOLVED DECISIONS

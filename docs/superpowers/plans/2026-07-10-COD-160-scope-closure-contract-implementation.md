# COD-160 Scope Closure Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned, auditable scope-closure contract that traces material spec surfaces into plan tasks, proofs, and owners before formal review without hiding scope-gap evidence.

**Architecture:** Keep the existing docs-driven cross-runtime pipeline. Spec-sweep writes a risk-proportional `scope-closure/v1` declaration and `S1..Sn` inventory, performs a bidirectional procedural self-check, asks the existing selected reviewers to challenge it, and requires plan traceability before the unchanged terminal gate. A VERSION-triggered updater fixture proves the canonical skill reaches installed anchors; no runtime Markdown parser or new persistent state is introduced.

**Tech Stack:** Markdown cross-runtime skills, Node.js `node:test`, existing `runUpdate()` updater, git release markers, Factory Learning structured events.

## Global Constraints

- Owning repo is `linear-board-sweeps` only; do not edit contributor workspaces.
- Keep `skills/spec-sweep/SKILL.md` byte-identical to `.claude/skills/spec-sweep/SKILL.md`.
- Use the exact declaration `Scope closure: scope-closure/v1 — required | not required — <rationale>` in every newly generated spec and plan audit.
- Stable `S1..Sn` rows are an auditable procedural contract, not deterministic semantic validation. Preserve independent review.
- Material omissions found by the self-check or later review emit `review/scope-gap`; never suppress or recategorize findings to improve the metric.
- When COD-155 is installed, scope closure runs before correctness applicability; `S` rows may reference `C` IDs instead of duplicating invariants.
- Do not change learning detectors, outcome evaluation, Dev/QA/Ship behavior, labels, states, dependencies, or persisted schemas.
- Preserve adaptive reviews, specialized safety lenses, QA, Signoff, and the human Ship gate.
- At release time, fetch origin and choose a VERSION strictly greater than current `origin/main` and every live release branch. `1.2.0.6` is already used by an unmerged COD-142 branch and must not be reused.
- No production app deploy exists. Shipping is merge/push to `main`; external publishing is attended owner work or a Todo.

---

## Repo scope

- **Owning repo:** `linear-board-sweeps`.
- **Branch expectation:** one branch containing `COD-160`, pushed for Dev/QA and merged only after human Ship approval.
- **QA evidence:** focused doc tests, VERSION-triggered updater integration, full Node suite, canonical/installed byte equality, and release-doc inspection.
- **Deploy target:** none; the existing updater refreshes installed anchors after merge/push.
- **Sibling workspaces:** SafeTaper contributed evidence but receives changes only through the updater.

## What already exists

| Mechanism | Reuse decision |
| --- | --- |
| Adaptive review depth in `skills/spec-sweep/SKILL.md:48-69` | Add scope applicability before classification and use exposed surfaces as tier evidence. |
| Tier-selected engineering and independent review | Challenge the inventory without adding a review pass. |
| Structured `review/scope-gap` evidence | Reuse for material self-check omissions and later findings. |
| `runUpdate()` and `copySkillsInto()` in `scripts/linear-watch.mjs:4999-5135` | Reuse unchanged; add the missing VERSION-trigger success fixture. |
| Canonical/installed equality test | Extend with scope ordering, traceability, evidence, and terminal rules. |
| README/CHANGELOG/VERSION release pattern | Reuse with a unique post-merge marker. |

## NOT in scope

- Runtime parsing or semantic validation of generated Markdown.
- A merged scope/correctness mega-contract.
- New detector clustering or composite outcome evaluation.
- Product-specific checklists for any one observed finding.
- Historical artifact rewrites or direct edits to registered contributor anchors.

## Scope closure traceability

| Scope ID | Implementing task(s) | Files/modules | Test or assertion | Rollout/owner evidence | Residual risk |
| --- | --- | --- | --- | --- | --- |
| `S1` | Task 1 | canonical + installed spec-sweep, doc test | Ordering/applicability/inventory/traceability/terminal assertions and byte equality | Plan audit cites v1 contract | Agents can apply prose poorly; independent review remains. |
| `S2` | Tasks 1, 3 | spec-sweep and release artifacts | Scope-before-correctness text; unique marker after fetch | Dev handoff records reconciliation | COD-155 may land first or second. |
| `S3` | Task 2 | updater integration test | `runUpdate` installs newer marker and identical bytes on anchor origin/main | Focused updater test | Does not prove health of every external anchor. |
| `S4` | Task 3 | README, CHANGELOG, VERSION | Release text, marker checks, focused and full suites | README changes planned to active only with implementation | Concurrent releases can advance the marker again. |
| `S5` | Task 1 | evidence instructions + doc test | Exact `review/scope-gap` and `pre-review-self-check` assertions | Review audit retains findings | Supplemental signals do not gate the automated outcome. |
| `S6` | Task 3 | repo/release handoff | Selective diff, clean worktree, one configured repo | Normal QA, Signoff, human Ship | External publishing remains attended. |

## Dependency graph

```text
Task 1: contract tests + canonical skill pair
        |
        v
Task 2: VERSION-triggered updater fixture
        |
        v
Task 3: resync + unique VERSION + release docs + full verification
```

Sequential implementation: Task 2 validates Task 1 bytes, and Task 3 chooses a marker from the latest origin after both are green.

### Task 1: Specify and install `scope-closure/v1`

**Files:**
- Modify: `tests/spec-sweep-doc.test.mjs:12-50`
- Modify: `skills/spec-sweep/SKILL.md:46-70`
- Modify: `.claude/skills/spec-sweep/SKILL.md:46-70`

**Interfaces:**
- Consumes: brainstorming, adaptive review depth, plan audit/reassessment, learning-event, and terminal-gate instructions.
- Produces: applicability line, `S1..Sn` schema, procedural self-check, reviewer challenge, plan traceability, and honest evidence rule.

- [ ] **Step 1: Write failing documentation-contract tests**

Append to `tests/spec-sweep-doc.test.mjs`:

```js
test("scope closure is risk-proportional and precedes review selection", () => {
  const body = read(canonicalPath);
  const brainstormAt = body.indexOf("Brainstorm the spec");
  const scopeAt = body.indexOf("Scope closure: scope-closure/v1");
  const classifyAt = body.indexOf("Classify review depth");
  assert.ok(brainstormAt >= 0 && brainstormAt < scopeAt && scopeAt < classifyAt);
  assert.match(body, /required \| not required[^]*concrete[^]*Tier 0/i);
  assert.match(body, /S1\.\.Sn[^]*Surface and evidence[^]*Required outcome[^]*Owning repo\/module[^]*Closure proof/i);
  assert.match(body, /do not add ceremonial[^]*inapplicable/i);
});

test("scope closure traces both directions and composes with correctness", () => {
  const body = read(canonicalPath);
  assert.match(body, /run scope closure first[^]*correctness applicability/i);
  assert.match(body, /S[^]*row[^]*reference[^]*C[^]*IDs[^]*rather than duplicate/i);
  assert.match(body, /every[^]*S[^]*row[^]*implementing task[^]*proof/i);
  assert.match(body, /every planned task[^]*map[^]*S[^]*row/i);
  assert.match(body, /plan task[^]*new surface[^]*add[^]*S[^]*row[^]*reassess/i);
});

test("scope closure preserves evidence and fails the terminal gate closed", () => {
  const body = read(canonicalPath);
  assert.match(body, /pre-review-self-check[^]*review\/scope-gap|review\/scope-gap[^]*pre-review-self-check/i);
  assert.match(body, /never[^]*(suppress|recategorize)[^]*scope-gap/i);
  assert.match(body, /procedural[^]*independent reviewer/i);
  assert.match(body, /terminal review gate[^]*(absent|unmapped|contradictory|unresolved)/i);
});
```

- [ ] **Step 2: Run the focused test and observe the failure**

Run: `node --test tests/spec-sweep-doc.test.mjs`

Expected: the three new tests fail because the v1 contract is absent; existing adaptive-tier tests stay green.

- [ ] **Step 3: Add applicability, inventory, self-check, and composition instructions**

Insert after per-card brainstorming and before review-depth classification:

```markdown
3. **Build the scope-closure contract (versioned, risk-proportional).** Every draft spec and plan audit must contain `Scope closure: scope-closure/v1 — required | not required — <rationale>`. Mark it `required` whenever behavior, state, persistence, interfaces, dependencies, rollout, distribution, human approval, or user-visible failure behavior changes; mark it `not required` only for a genuine Tier 0 change with a concrete no-material-surface rationale. A required spec adds a `Scope closure inventory` before review selection with stable `S1..Sn` IDs and columns `Surface and evidence`, `Required outcome`, `Owning repo/module`, and `Closure proof`. Consider only material dimensions: entry points/outcomes; code/data/state/control boundaries including bounded reads; dependencies/prerequisites/order/cleanup/ownership transfer; failure/recovery/retry/partial success/cancellation/stale work; human approval/policy/credentials/assets/attended release; config/docs/versioning/packaging/updater/distribution; tests/QA/observability/rollout/acceptance measurement; and repo/deploy scope. Every row cites actual evidence and a falsifiable proof. Do not add ceremonial rows for inapplicable dimensions. A material surface escalates proposed Tier 0 work to at least Tier 1.

   When `correctness-contract/v1` is installed, run scope closure first, then correctness applicability, then review-depth classification. Scope rows own delivery coverage and may reference relevant `C` IDs rather than duplicate invariant prose; correctness rows own forbidden outcomes and recovery.

   Self-check both directions: every goal, acceptance criterion, failure mode, rollout step, and material predicted file/module maps to an `S` row; every row has a configured repo/module or explicit human owner and a proof that can fail; prerequisites precede dependents and cleanup; and no row assigns work to an unconfigured repo. This is a procedural, reviewer-mediated audit, not deterministic validation. If it finds a material surface omitted from the initial inventory, emit `review/scope-gap` with `{"findings":1,"discoveryPhase":"pre-review-self-check"}` before fixing the draft. Never suppress or recategorize it because discovery happened before formal review.
```

- [ ] **Step 4: Extend review, plan, reassessment, and terminal instructions**

Add to the selected-review step:

```markdown
For `scope-closure/v1 — required`, challenge repository evidence, every material code/operational/human/distribution/acceptance surface, falsifiable proofs, prerequisite and rollout order, and generic filler. Every verified omission remains `review/scope-gap`, whether self-check or selected review found it.
```

Add to the implementation-plan step:

```markdown
For `scope-closure/v1 — required`, add `Scope closure traceability` mapping each `S` ID to `Implementing task(s)`, `Files/modules`, `Test or assertion`, `Rollout/owner evidence`, and `Residual risk`. Check both directions: every row maps to a task/proof; every planned task and delivery surface maps to a row; prerequisites are ordered; human-only work has an attended-owner or Todo path; and applicable distribution work includes VERSION, canonical/installed parity, updater proof, release notes, and operator docs.
```

Extend reassessment and terminal gating:

```markdown
If a plan task exposes a new surface, add an `S` row, reconcile traceability, reassess tier monotonically, and run newly required reviews. Fail the terminal review gate when a required declaration, inventory, or traceability row is absent, unmapped, contradictory, or unresolved. Doc tests protect canonical instructions; they do not prove arbitrary artifacts semantically complete.
```

- [ ] **Step 5: Synchronize installed bytes and run tests**

```bash
cp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
node --test tests/spec-sweep-doc.test.mjs
```

Expected: `cmp` is silent and all focused tests pass.

- [ ] **Step 6: Commit the contract unit**

```bash
git add tests/spec-sweep-doc.test.mjs skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
git commit -m "COD-160 add scope closure contracts to spec sweep"
```

### Task 2: Prove VERSION-triggered updater propagation

**Files:**
- Modify: `tests/updater.integration.test.mjs:193-260`

**Interfaces:**
- Consumes: `runUpdate(reg, onFailure, { stateDir })`, kit `VERSION`, canonical `skills/`, and anchor `.sweep-version`.
- Produces: real-git proof that VERSION comparison triggers byte-identical installation and push to anchor origin/main.

- [ ] **Step 1: Add the success fixture**

Insert before the failed-fetch test. The fixture must:

```js
test("runUpdate: newer VERSION installs matching spec-sweep bytes on anchor main", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lw-update-success-"));
  try {
    const kitOrigin = path.join(root, "kit-origin.git");
    const kit = path.join(root, "kit");
    const anchorOrigin = path.join(root, "anchor-origin.git");
    const anchor = path.join(root, "anchor");
    const stateDir = path.join(root, "state");
    const nl = String.fromCharCode(10);

    g(root, "init", "--bare", "-b", "main", kitOrigin);
    g(root, "clone", kitOrigin, kit);
    g(kit, "config", "user.email", "t@t.t");
    g(kit, "config", "user.name", "t");
    fs.cpSync(path.join(KIT, "skills"), path.join(kit, "skills"), { recursive: true });
    fs.writeFileSync(path.join(kit, "VERSION"), `9.9.9${nl}`);
    g(kit, "add", "skills", "VERSION");
    g(kit, "commit", "-m", "seed newer kit");
    g(kit, "push", "origin", "main");

    g(root, "init", "--bare", "-b", "main", anchorOrigin);
    g(root, "clone", anchorOrigin, anchor);
    g(anchor, "config", "user.email", "t@t.t");
    g(anchor, "config", "user.name", "t");
    fs.mkdirSync(path.join(anchor, ".claude", "skills"), { recursive: true });
    fs.writeFileSync(path.join(anchor, ".claude", "skills", ".sweep-version"), `0.0.1${nl}`);
    g(anchor, "add", ".claude/skills/.sweep-version");
    g(anchor, "commit", "-m", "seed old anchor");
    g(anchor, "push", "origin", "main");

    const failures = [];
    runUpdate({ autoUpdate: true, kitPath: kit, kitRef: "main", repos: [anchor] }, (...args) => failures.push(args), { stateDir });
    assert.deepEqual(failures, []);
    g(anchor, "fetch", "origin", "main");
    assert.equal(g(anchor, "show", "origin/main:.claude/skills/.sweep-version"), "9.9.9");
    assert.equal(g(anchor, "show", "origin/main:.claude/skills/spec-sweep/SKILL.md"), fs.readFileSync(path.join(kit, "skills", "spec-sweep", "SKILL.md"), "utf8").trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Prove the assertion detects wrong bytes**

Temporarily replace the final expected expression with `"wrong bytes"`; run `node --test tests/updater.integration.test.mjs` and expect the new byte assertion to fail. Restore the real expression.

- [ ] **Step 3: Run and commit the real fixture**

```bash
node --test tests/updater.integration.test.mjs
git add tests/updater.integration.test.mjs
git commit -m "COD-160 prove version-triggered skill updates"
```

Expected: all updater integration tests pass before commit.

### Task 3: Release, document, and verify

**Files:**
- Modify: `VERSION:1`
- Modify: `CHANGELOG.md:1-10`
- Modify: `README.md:3-12`

**Interfaces:**
- Consumes: green Task 1/2 tests, current origin, and live remote VERSION markers.
- Produces: unique newer marker, release note, active architecture text, and complete verification evidence.

- [ ] **Step 1: Reconcile current main and preserve both contracts**

```bash
git fetch origin --prune
git merge origin/main
```

Expected: merge succeeds. If COD-155 landed, scope closure remains before correctness applicability in both canonical copies.

- [ ] **Step 2: Compute and verify the next unused marker**

```bash
git for-each-ref --format='%(refname)' refs/remotes/origin | while read -r ref; do git show "$ref:VERSION" 2>/dev/null || true; done | rg '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -V -u > "$AUTO_SWEEP_TMPDIR/live-versions.txt"
MAX_VERSION=$(tail -1 "$AUTO_SWEEP_TMPDIR/live-versions.txt")
NEXT_VERSION=$(node -e 'const v=process.argv[1].split(".").map(Number); v[3]+=1; process.stdout.write(v.join("."))' "$MAX_VERSION")
! rg -qx "$NEXT_VERSION" "$AUTO_SWEEP_TMPDIR/live-versions.txt"
```

Expected on the current graph: `MAX_VERSION=1.2.0.6`, `NEXT_VERSION=1.2.0.7`, and the uniqueness check exits 0. If origin advanced, use the computed higher value.

- [ ] **Step 3: Update VERSION and CHANGELOG**

Use `apply_patch` to replace VERSION with `$NEXT_VERSION`. Add at the top of CHANGELOG:

```markdown
## [$NEXT_VERSION] - $(date +%F)

### Changed

- Require material Spec cards to carry an auditable `scope-closure/v1` inventory whose stable surface IDs map into implementation tasks, proofs, rollout evidence, and owners before handoff.
- Compose scope closure with correctness and adaptive review depth without adding a review pass or weakening safety gates.

### Fixed

- Preserve material self-check omissions as `review/scope-gap` evidence, and prove the VERSION-triggered updater installs the changed canonical skill bytes.
```

- [ ] **Step 4: Change README from planned to active**

Add after the Factory Learning lifecycle paragraph, preserving any unshipped COD-155 planned note:

```markdown
Material specs carry a versioned scope-closure inventory whose stable surface IDs remain traceable into implementation tasks, proofs, rollout evidence, and owners. The contract is reviewer-mediated rather than a runtime semantic validator; self-check and formal-review omissions remain `review/scope-gap` evidence so earlier discovery cannot game the learning metric.
```

Update the adaptive review-depth bullet to state that required scope closure runs before tier selection and completed-plan reassessment.

- [ ] **Step 5: Run focused and full verification**

```bash
cmp skills/spec-sweep/SKILL.md .claude/skills/spec-sweep/SKILL.md
rg -n "scope-closure/v1|review/scope-gap" skills/spec-sweep/SKILL.md README.md CHANGELOG.md
node --test tests/spec-sweep-doc.test.mjs tests/updater.integration.test.mjs tests/agents-snippet.test.mjs
node --test tests/*.test.mjs
```

Expected: copy equality, required phrases, and every test pass with zero failures.

- [ ] **Step 6: Inspect scope and commit**

```bash
git status --short
git diff --check origin/main...
git diff --stat origin/main...
```

Expected: only the seven planned files differ; no whitespace errors or runtime implementation changes.

```bash
git add VERSION CHANGELOG.md README.md
git commit -m "COD-160 release scope closure contracts"
```

## Test coverage and failure modes

| Failure mode | Test/error handling | Outcome |
| --- | --- | --- |
| Missing required inventory/traceability | Doc contract requires fail-closed terminal language; reviewer checks artifact | Card remains in Spec |
| Self-check finds an omitted surface | Exact structured event rule is asserted | Finding remains visible and draft is corrected |
| COD-155 lands first | Ordering/no-duplication text is asserted | Merge preserves both contracts |
| Next marker already exists | Task computes max live marker after fetch | Strictly newer marker chosen |
| Updater copies wrong bytes | Real-git `runUpdate` fixture compares origin/main | Test fails before release |
| Anchor update fails | Existing updater failure/Todo behavior unchanged | Existing retry path owns recovery |
| Contract adds ceremony | Existing review-duration signal remains observable | Separate improvement can address overprocessing |

## Spec-sweep review audit

| Item | Outcome |
| --- | --- |
| Initial tier | Tier 2 — distributed workflow and terminal-gate contract |
| Predicted footprint | Seven files, roughly 140-220 changed lines, no runtime module/schema |
| Spec engineering review | Clear after six verified corrections |
| Independent spec review | Clear after two reconciliations; current-runtime reviewer used because explicit configured Claude dispatch is unsupported |
| Plan engineering review | Clear after aligning the new-surface regex with the exact planned wording and replacing release placeholders with fresh origin-derived values |
| UI/design | Skipped; no visual/interaction surface |
| API/CLI/SDK devex | Skipped; no public developer interface |
| Security | Skipped; no auth, secret, external-input, destructive, or data-access surface |
| Performance | Skipped; no production hot path |
| Research | Skipped; repository-local mechanism only |
| Final tier | Tier 2, unchanged |
| Unresolved decisions | None |

## Plan engineering review

- **Scope challenge:** accepted as-is. Seven files change together as one
  distributed skill release; no runtime module, new service, or independent
  subsystem justifies a split.
- **Architecture:** clear. Scope and correctness remain separate sources of truth,
  the updater implementation is reused, and release ordering is explicit.
- **Code quality:** one wording defect corrected. The planned doc test now matches
  `plan task ... new surface`, the exact phrase the skill will install.
- **Tests:** one execution defect corrected. The updater fixture exercises
  `runUpdate`, and release version/date values come from explicit commands rather
  than unresolved placeholders.
- **Performance:** no issue. Only bounded Markdown reasoning and existing real-git
  tests change; no production hot path is introduced.
- **Failure modes:** no silent critical gap remains. Contract omission, evidence
  suppression, contract-order drift, version collision, byte drift, and updater
  failure each have a named proof or existing owner path.
- **Parallelization:** one sequential lane: Task 1 -> Task 2 -> Task 3.
- **Decision:** keep the complete VERSION-triggered fixture and unique-marker
  release rule. Completeness: 10/10. A direct-copy-only test would be 7/10 because
  it bypasses the gate that failed the evidence review.

## Implementation Tasks

Synthesized from the engineering review. Each task maps to the detailed steps
above.

- [ ] **T1 (P1, human: ~2h / agent: ~20min)** — Spec contract — Add the
  `scope-closure/v1` applicability, inventory, traceability, evidence, and
  terminal-gate instructions to the canonical and installed skill copies.
  - Surfaced by: architecture and correctness review.
  - Files: `skills/spec-sweep/SKILL.md`, `.claude/skills/spec-sweep/SKILL.md`, `tests/spec-sweep-doc.test.mjs`.
  - Verify: `node --test tests/spec-sweep-doc.test.mjs` and byte-equality `cmp`.
- [ ] **T2 (P1, human: ~1h / agent: ~15min)** — Updater proof — Add a real-git
  `runUpdate` success fixture for newer VERSION and changed skill bytes.
  - Surfaced by: test review finding that direct `refreshAnchorSkills` bypassed VERSION admission.
  - Files: `tests/updater.integration.test.mjs`.
  - Verify: `node --test tests/updater.integration.test.mjs`.
- [ ] **T3 (P1, human: ~1h / agent: ~15min)** — Release — Reconcile origin,
  select a unique marker, document the release, and run focused/full verification.
  - Surfaced by: release collision and CHANGELOG scope findings.
  - Files: `VERSION`, `CHANGELOG.md`, `README.md`.
  - Verify: focused tests, `node --test tests/*.test.mjs`, selective diff, and clean worktree.

## Plan self-review

- Spec coverage: Tasks 1-3 map every `S1..S6` row and predicted file.
- Placeholder scan: the only angle-bracket token is the exact v1 schema's literal `<rationale>` contract; release-time version/date values are computed by explicit commands and no design choice is deferred.
- Interface consistency: Task 1 produces bytes, Task 2 validates them through `runUpdate`, and Task 3 releases the tested result.
- Scope: one configured repo, seven files, no detector/runtime/app code.

## Completed-plan review-depth reassessment

- **Footprint:** one canonical skill pair, two existing tests, VERSION, CHANGELOG, README; no launcher implementation or schema.
- **Dependencies:** three sequential tasks; release work consumes tested bytes and re-reads origin before selecting a marker.
- **Interfaces:** Markdown artifact contract plus existing structured-event and updater interfaces.
- **Failure handling:** independent review, fail-closed terminal language, honest finding emission, collision avoidance, real-git propagation proof.
- **Final tier:** Tier 2, unchanged; bounded files still alter the distributed workflow and terminal gate for every material future Spec card.
- **Specialized lenses:** no newly material lens.
- **Terminal gate:** clear. Both Tier 2 engineering passes and the independent
  adversarial spec review are reconciled; skipped lenses have material rationales,
  spec and plan agree, and no decision remains unresolved.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | skipped | Not part of the spec-sweep pipeline |
| Codex Review | independent adversarial reviewer | Independent premise challenge | 1 | clear | Six spec findings corrected across two reconciliation rounds |
| Eng Review | `/plan-eng-review` | Architecture & tests | 2 | clear | Six spec corrections and two plan execution corrections |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | No material UI surface |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | skipped | No public API/CLI/SDK surface |

**CROSS-MODEL:** Configured Claude reviewer dispatch was unavailable in this runtime; an independent current-runtime reviewer completed the required adversarial pass.

**VERDICT:** ENG + ADVERSARIAL CLEARED — ready for Dev implementation after docs land.

NO UNRESOLVED DECISIONS

# COD-179 Ship Progress Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scheduled Ship children accept their exact immutable pre-claim and reject exit-zero runs that produce no policy-valid progress.

**Architecture:** Preserve the launcher claim handshake and first-declaration-wins ownership model. Tighten the Ship instructions, then add a pure post-dispatch classifier that compares dispatch identity with a complete post-run card read before cleanup, failure reporting, handoff, or refill.

**Tech Stack:** Node.js ESM, `node:test`, Linear GraphQL helpers, Markdown canonical skills.

## Global Constraints

- Require the exact nonempty owner plus declaration pair.
- Complete Linear comment history resolves ownership; heartbeats prove liveness only.
- Never close or remove newer, incomplete, malformed, or ambiguous epochs.
- Preserve every genuine QA, dependency, approval, security, deploy, and human blocker.
- Keep both Ship skill copies byte-identical.
- Use TDD and commit only green logical units.

---

### Task 1: Scheduled Ship accepts only its declared pre-claim

**Files:**
- Modify: `.claude/skills/ship-sweep/SKILL.md`
- Modify: `skills/ship-sweep/SKILL.md`
- Test: `tests/qa-sweep-doc.test.mjs`

**Interfaces:**
- Consumes: `AUTO_SWEEP_ISSUE`, `AUTO_SWEEP_OWNER_TOKEN`, `AUTO_SWEEP_CLAIM_DECLARATION`.
- Produces: one unambiguous scheduled single-card preflight contract.

- [ ] **Step 1: Write the failing documentation test**

```js
test("Ship scheduled mode accepts only its exact immutable pre-claim", () => {
  for (const path of [".claude/skills/ship-sweep/SKILL.md", "skills/ship-sweep/SKILL.md"]) {
    const body = fs.readFileSync(path, "utf8");
    assert.match(body, /scheduled single-card[\s\S]{0,900}exact[\s\S]{0,300}owner[\s\S]{0,300}declaration/i);
    assert.match(body, /treat[\s\S]{0,200}pre-claim[\s\S]{0,250}not[\s\S]{0,120}competing/i);
  }
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='Ship scheduled mode accepts' tests/qa-sweep-doc.test.mjs`

Expected: FAIL because the current selection rule rejects every fresh Ship claim.

- [ ] **Step 3: Make the minimal skill change**

State that scheduled mode complete-reads the named issue and continues only when the open epoch exactly matches both environment identities. Missing, closed, malformed, ambiguous, or mismatched epochs fail closed. Only unrelated live claims mean another run owns the card. Copy the canonical file byte-for-byte to the mirror.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/qa-sweep-doc.test.mjs && cmp -s .claude/skills/ship-sweep/SKILL.md skills/ship-sweep/SKILL.md`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/ship-sweep/SKILL.md skills/ship-sweep/SKILL.md tests/qa-sweep-doc.test.mjs
git commit -m "fix(COD-179): accept declared Ship pre-claims"
```

### Task 2: Classify observable post-child progress

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Consumes: dispatch result, complete post-run card, optional verified resume record.
- Produces: `classifyPostDispatchProgress(result, card, { resumeRecord }) -> { kind, valid, ownsOpenClaim, reason }`.

- [ ] **Step 1: Write failing classifier tests**

```js
test("classifyPostDispatchProgress rejects exit-zero unchanged owned epochs", () => {
  assert.deepEqual(
    classifyPostDispatchProgress(successResult("ship"), completeOwnedCard("Ship")),
    {
      kind: "successful-no-op",
      valid: false,
      ownsOpenClaim: true,
      reason: "child exited successfully without an observable terminal outcome",
    },
  );
});

test("classifyPostDispatchProgress accepts downstream state with a closed epoch", () => {
  assert.equal(classifyPostDispatchProgress(successResult("ship"), closedOwnedCard("Done")).kind, "advanced");
});
```

Add separate cases for a legitimate blocker with a closed epoch, dependency/route deferral, verified resume metadata, mismatched ownership, incomplete history, and ambiguous history.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='classifyPostDispatchProgress' tests/linear-watch.test.mjs`

Expected: FAIL because the export does not exist.

- [ ] **Step 3: Implement the pure classifier**

Place it near `classifyDispatchOutcome`. Derive valid shapes from existing state, blocker, claim-ownership, deferral, and resume helpers. Never trust a child-authored success string.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern='classifyPostDispatchProgress' tests/linear-watch.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "feat(COD-179): classify observable sweep progress"
```

### Task 3: Reconcile successful no-ops as failures

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Consumes: `classifyPostDispatchProgress`, `fetchClaimCard`, exact claim cleanup, resume store.
- Produces: `reconcileDispatchProgress(apiKey, result, runtime, deps) -> { success, progress, claimResult, failure }`.

- [ ] **Step 1: Write the failing reconciliation test**

```js
test("reconcileDispatchProgress releases an unchanged owned Ship no-op", async () => {
  const calls = [];
  const value = await reconcileDispatchProgress("key", successResult("ship"), "codex", {
    fetchClaimCardFn: async () => completeOwnedCard("Ship"),
    releaseFailedDispatchClaimFn: async () => { calls.push("release"); return true; },
  });
  assert.equal(value.success, false);
  assert.equal(value.progress.kind, "successful-no-op");
  assert.deepEqual(calls, ["release"]);
});
```

Add a denial case proving changed or ambiguous ownership never calls cleanup.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='reconcileDispatchProgress' tests/linear-watch.test.mjs`

Expected: FAIL because the function is absent.

- [ ] **Step 3: Implement and integrate reconciliation**

Complete-read after child exit, classify, and downgrade `result.success` unless the terminal shape is valid. Use existing exact-declaration cleanup and failure-Todo paths. Run reconciliation before handoff and refill.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern='reconcileDispatchProgress|successful-no-op|completed Ship immediately offers' tests/linear-watch.test.mjs`

Expected: no-op never triggers refill; valid terminal Ship does.

- [ ] **Step 5: Commit**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "fix(COD-179): reject successful sweep no-ops"
```

### Task 4: Backward compatibility and bounded no-op telemetry

**Files:**
- Modify: `scripts/linear-watch.mjs`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:**
- Consumes: legacy children with no terminal record, current/last tick telemetry.
- Produces: observable-state inference plus `successfulNoOpCount` and latest affected issue.

- [ ] **Step 1: Write failing tests**

Create an old-child fixture with no outcome record but a downstream state and closed claim; it must pass. An unchanged/open fixture must fail and increment bounded telemetry.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='legacy child progress|successful no-op telemetry' tests/linear-watch.test.mjs`

Expected: FAIL because telemetry and compatibility inference are absent.

- [ ] **Step 3: Implement minimal compatibility**

Use observable state as authority when no record exists. Persist only count and latest issue identity, never comments, environment, owner, or declaration values.

- [ ] **Step 4: Verify focused and full suites**

Run: `node --test tests/linear-watch.test.mjs && node --test tests/*.test.mjs`

Expected: zero failures.

- [ ] **Step 5: Commit**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "feat(COD-179): report successful sweep no-ops"
```

### Task 5: Increment 1 gate

**Files:** Verify only.

- [ ] **Step 1: Run focused checks**

```bash
cmp -s .claude/skills/ship-sweep/SKILL.md skills/ship-sweep/SKILL.md
node --test --test-name-pattern='Ship scheduled mode|classifyPostDispatchProgress|reconcileDispatchProgress|successful-no-op' tests/qa-sweep-doc.test.mjs tests/linear-watch.test.mjs
```

Expected: exit 0.

- [ ] **Step 2: Run the complete suite**

Run: `node --test tests/*.test.mjs`

Expected: zero failures.

- [ ] **Step 3: Check repository state**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional COD-179 changes.


# COD-132 Unblock Pipeline Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the manual unblock queue to `Signoff`, `QA`, `Dev`, and `Spec`, ordered downstream-first with oldest-updated cards first inside each state.

**Architecture:** Add one exported pure helper that owns unblock-state eligibility and ranking, then call it once after the cross-anchor scan normalizes all cards. Keep agent-facing skill instructions synchronized through an exact contract test over both tracked skill copies.

**Tech Stack:** Node.js ESM, `node:test`, Markdown skill files, Linear GraphQL helper code.

## Global Constraints

- Eligible states are exactly `Signoff`, `QA`, `Dev`, and `Spec`.
- State priority is `Signoff`, then `QA`, then `Dev`, then `Spec`.
- Within one state, older `updatedAt` values come first.
- Backlog and every other state are omitted.
- Blocker labels, cross-anchor scanning, warnings, and resolve mutations remain unchanged.
- Preserve unrelated work in the original COD-128 checkout.

---

### Task 1: Filter and rank the unblock queue

**Files:**
- Modify: `tests/linear-watch.test.mjs`
- Modify: `scripts/linear-watch.mjs`

**Interfaces:**
- Consumes: normalized cards from `normalizeBlockedIssue`, each with `state` and `updatedAt` fields.
- Produces: `UNBLOCK_STATE_ORDER` as `readonly`-style frozen state names and `orderUnblockCards(cards)` returning a new filtered, sorted array.

- [ ] **Step 1: Write the failing helper regression test**

Add `UNBLOCK_STATE_ORDER` and `orderUnblockCards` to the import from `../scripts/linear-watch.mjs`, then add this test under the manual unblock helpers:

```js
test("orderUnblockCards: keeps pipeline states downstream-first and oldest-first within a state", () => {
  const cards = [
    { identifier: "SPEC", state: "Spec", updatedAt: "2026-07-01T00:00:00Z" },
    { identifier: "BACKLOG", state: "Backlog", updatedAt: "2026-06-01T00:00:00Z" },
    { identifier: "SIGNOFF-NEW", state: "Signoff", updatedAt: "2026-07-04T00:00:00Z" },
    { identifier: "DEV", state: "Dev", updatedAt: "2026-07-02T00:00:00Z" },
    { identifier: "QA", state: "QA", updatedAt: "2026-07-03T00:00:00Z" },
    { identifier: "SIGNOFF-OLD", state: "Signoff", updatedAt: "2026-07-01T00:00:00Z" },
    { identifier: "SHIP", state: "Ship", updatedAt: "2026-05-01T00:00:00Z" },
    { identifier: "UNKNOWN", state: "Custom", updatedAt: "2026-04-01T00:00:00Z" },
  ];

  assert.deepEqual(UNBLOCK_STATE_ORDER, ["Signoff", "QA", "Dev", "Spec"]);
  assert.deepEqual(
    orderUnblockCards(cards).map((card) => card.identifier),
    ["SIGNOFF-OLD", "SIGNOFF-NEW", "QA", "DEV", "SPEC"],
  );
  assert.deepEqual(cards.map((card) => card.identifier), [
    "SPEC", "BACKLOG", "SIGNOFF-NEW", "DEV", "QA", "SIGNOFF-OLD", "SHIP", "UNKNOWN",
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='orderUnblockCards' tests/linear-watch.test.mjs
```

Expected: FAIL because `UNBLOCK_STATE_ORDER` and `orderUnblockCards` are not exported.

- [ ] **Step 3: Add the minimal queue helper and use it in the scan**

Add next to `BLOCKING_LABELS` in `scripts/linear-watch.mjs`:

```js
export const UNBLOCK_STATE_ORDER = Object.freeze(["Signoff", "QA", "Dev", "Spec"]);

export function orderUnblockCards(cards) {
  const priority = new Map(UNBLOCK_STATE_ORDER.map((state, index) => [state, index]));
  return (cards || [])
    .filter((card) => priority.has(card.state))
    .sort((a, b) => {
      const stateDelta = priority.get(a.state) - priority.get(b.state);
      if (stateDelta) return stateDelta;
      return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    });
}
```

Replace the final mutation in `scanBlockedIssues`:

```js
cards.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
return { cards, warnings };
```

with:

```js
return { cards: orderUnblockCards(cards), warnings };
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test --test-name-pattern='orderUnblockCards' tests/linear-watch.test.mjs
```

Expected: PASS for the unblock ordering test with no failures.

- [ ] **Step 5: Commit the runtime behavior**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "COD-132 order unblock cards by pipeline state"
```

---

### Task 2: Synchronize and verify the unblock skill contract

**Files:**
- Create: `tests/unblock-sweep-doc.test.mjs`
- Modify: `.claude/skills/unblock-sweep/SKILL.md`
- Modify: `skills/unblock-sweep/SKILL.md`

**Interfaces:**
- Consumes: the JSON output contract of `node scripts/linear-watch.mjs unblock-list --json`.
- Produces: identical operator instructions in both tracked skill locations.

- [ ] **Step 1: Write the failing skill contract test**

Create `tests/unblock-sweep-doc.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CANONICAL_QUEUE_RULE = "Review only `Signoff`, `QA`, `Dev`, and `Spec` cards, in that order. The helper excludes Backlog and every other state; within a state, it orders cards from oldest-updated to newest-updated.";

test("unblock-sweep copies share the downstream-first queue contract", () => {
  const claudeCopy = fs.readFileSync(".claude/skills/unblock-sweep/SKILL.md", "utf8");
  const crossRuntimeCopy = fs.readFileSync("skills/unblock-sweep/SKILL.md", "utf8");

  assert.equal(claudeCopy, crossRuntimeCopy);
  assert.ok(claudeCopy.includes(CANONICAL_QUEUE_RULE));
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
node --test tests/unblock-sweep-doc.test.mjs
```

Expected: FAIL because the queue rule is absent from the current skill text.

- [ ] **Step 3: Add the minimal queue rule to both skill copies**

In both skill files, add this bullet immediately after the `unblock-list --json` preflight bullet:

```markdown
- Review only `Signoff`, `QA`, `Dev`, and `Spec` cards, in that order. The helper excludes Backlog and every other state; within a state, it orders cards from oldest-updated to newest-updated.
```

- [ ] **Step 4: Run the contract and focused runtime tests**

Run:

```bash
node --test tests/unblock-sweep-doc.test.mjs
node --test --test-name-pattern='orderUnblockCards' tests/linear-watch.test.mjs
```

Expected: both commands exit 0 with no failures.

- [ ] **Step 5: Run full verification**

Run:

```bash
node --test
git diff --check
```

Expected: the complete test suite passes, and `git diff --check` exits 0 without output.

- [ ] **Step 6: Commit the skill contract**

```bash
git add .claude/skills/unblock-sweep/SKILL.md skills/unblock-sweep/SKILL.md tests/unblock-sweep-doc.test.mjs
git commit -m "COD-132 document unblock pipeline priority"
```

---

### Task 3: Final evidence and Linear handoff

**Files:**
- No repository file changes expected.
- Update: Linear issue `COD-132` through the repository's authenticated Linear helper.

**Interfaces:**
- Consumes: committed diff and fresh test output.
- Produces: an auditable COD-132 comment and a pushed implementation branch when explicitly authorized.

- [ ] **Step 1: Inspect the final branch diff and commit list**

Run:

```bash
git status --short
git log --oneline main..HEAD
git diff --stat main...HEAD
git diff --check main...HEAD
```

Expected: clean status; design, runtime behavior, and skill-contract commits only; no whitespace errors.

- [ ] **Step 2: Re-run fresh full verification**

Run:

```bash
node --test
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Record evidence on COD-132**

Add a Linear comment containing the branch name, commit hashes, test count, exact ordering contract, and confirmation that Backlog/non-pipeline states are omitted. Keep `sweep:manual-only` until the user explicitly hands the card back to scheduled automation.

- [ ] **Step 4: Request push or integration direction if it has not already been provided**

Do not push, merge, or move COD-132 to QA without explicit authorization.

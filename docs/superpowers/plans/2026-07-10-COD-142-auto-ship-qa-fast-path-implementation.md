# COD-142 Auto-ship QA Fast-path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a fully QA-passed, commit-bound `fast-path:eligible` card directly from `QA` to `Ship`, while every missing, stale, changed, blocked, or explicitly approval-gated case continues to `Signoff`.

**Architecture:** Keep the pure QA policy function, add a minimal guarded Linear terminal-move helper, and make both QA and Ship re-read origin at their final mutation boundaries. Dev records the exact reviewed origin SHA; QA passes the raw optional config value and uses one guarded status/claim mutation; Ship binds an auto-promoted card to that SHA at sanity and again immediately before merge. Synchronize both cross-runtime skill distributions, installer/operator docs, and configuration comments.

**Tech Stack:** Node.js 18+ ESM, `node:test`, Markdown cross-runtime skills, JSON configuration templates.

## Global Constraints

- `qa-sweep` never merges, pushes `main`, deploys, or performs canary verification.
- `ship-sweep` remains the only merge/deploy actor and retains branch, build, repository-scope, single-runner, deploy, and canary gates.
- QA maps `fastPathEnabled: config.fastPath?.enabled` without `!== false`; omitted defaults on, while malformed values fail closed in Dev and QA and cannot auto-ship.
- Automatic Ship requires valid raw fast-path config, `config.requireShipApproval === false`, `fast-path:eligible`, `qa:passed`, exact `QA` state, no blocking/manual label, no foreign in-progress claim, and matching full reviewed/final origin SHAs.
- Any false, missing, malformed, unreadable, or ambiguous condition selects `Signoff`; it is not a QA failure and must not add `qa:needs-changes` or `blocked:needs-user`.
- Dev audit marker format is exactly `[auto-sweep-fast-path COD-### head=<full-git-sha>]` and is written only after the reviewed branch is pushed.
- QA automatic Ship marker format is exactly `[auto-sweep-auto-ship COD-### head=<full-git-sha>]`.
- QA terminal handoffs use `move-card-bottom-if-current`, which removes only the owned claim in one `issueUpdate` mutation after a fresh state/label guard. Linear has no atomic compare-and-swap, so the plan makes no CAS claim.
- Ship's fresh path validates the latest issue-specific auto-ship marker against current origin, then must re-fetch origin immediately before merge. If origin advanced, the mismatch blocks before merge; human/legacy cards with no auto marker retain their existing admission path.
- A reviewed/final SHA mismatch removes stale `fast-path:eligible`, records both SHAs, and sends the passing card to `Signoff`.
- Legacy fast-path comments without `head=` never authorize automatic Ship.
- `requireShipApproval: true` always preserves human Signoff.
- `.claude/skills/{dev,qa,ship}-sweep/SKILL.md` and `skills/{dev,qa,ship}-sweep/SKILL.md` remain byte-for-byte identical per sweep.
- Preserve unrelated `COD-141` changes in the source checkout; all COD-142 edits stay inside the isolated worktree.

---

### Task 1: Fail-closed QA handoff policy

**Files:**
- Modify: `scripts/linear.mjs`
- Modify: `tests/linear.test.mjs`

**Interfaces:**
- Consumes: final card/config facts already read by `qa-sweep`.
- Produces: `qaHandoffDecision(input) -> { destination: "Ship" | "Signoff", eligible: boolean, reason: string }`.
- Keeps policy pure: no filesystem, git, Linear, environment, or network reads.

- [ ] **Step 1: Write the failing decision-matrix tests**

Import `qaHandoffDecision` from `scripts/linear.mjs`. Add a valid baseline fixture:

```js
const QA_HANDOFF_BASE = Object.freeze({
  fastPathEnabled: true,
  requireShipApproval: false,
  stateName: "QA",
  labelNames: ["fast-path:eligible", "qa:passed", "qa:in-progress"],
  issueIdentifier: "COD-142",
  reviewedHead: "a".repeat(40),
  finalHead: "a".repeat(40),
  hasForeignClaim: false,
});
```

Test the eligible result exactly:

```js
assert.deepEqual(qaHandoffDecision(QA_HANDOFF_BASE), {
  destination: "Ship",
  eligible: true,
  reason: "eligible",
});
```

Add table-driven denial tests for these exact overrides and reasons:

```js
[
  [{ fastPathEnabled: false }, "fast-path-disabled"],
  [{ requireShipApproval: true }, "ship-approval-required"],
  [{ stateName: "Signoff" }, "not-in-qa"],
  [{ labelNames: ["qa:passed"] }, "missing-fast-path-label"],
  [{ labelNames: ["fast-path:eligible"] }, "missing-qa-pass"],
  [{ labelNames: ["fast-path:eligible", "qa:passed", "blocked:open-questions"] }, "blocked"],
  [{ labelNames: ["fast-path:eligible", "qa:passed", "blocked:needs-user"] }, "blocked"],
  [{ labelNames: ["fast-path:eligible", "qa:passed", "qa:needs-changes"] }, "blocked"],
  [{ labelNames: ["fast-path:eligible", "qa:passed", "sweep:manual-only"] }, "blocked"],
  [{ hasForeignClaim: true }, "foreign-claim"],
  [{ reviewedHead: null }, "missing-reviewed-head"],
  [{ reviewedHead: "abc123" }, "invalid-reviewed-head"],
  [{ finalHead: null }, "missing-final-head"],
  [{ finalHead: "abc123" }, "invalid-final-head"],
  [{ finalHead: "b".repeat(40) }, "head-mismatch"],
]
```

Every denial must deep-equal `{ destination: "Signoff", eligible: false, reason }`. Also assert that omitted `fastPathEnabled` preserves the default-on behavior, omitted `requireShipApproval` preserves the default-false behavior, uppercase hex SHAs compare case-insensitively, malformed/missing input fails closed, and the input object/label array are not mutated.

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```bash
node --test tests/linear.test.mjs
```

Expected: FAIL because `scripts/linear.mjs` does not export `qaHandoffDecision`.

- [ ] **Step 3: Implement the minimal pure policy**

Add near the existing eligibility helpers:

```js
const QA_HANDOFF_BLOCKING_LABELS = new Set([
  "blocked:open-questions",
  "blocked:needs-user",
  "qa:needs-changes",
  "sweep:manual-only",
]);
const FULL_GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export function qaHandoffDecision(input = {}) {
  const labels = new Set(Array.isArray(input.labelNames) ? input.labelNames : []);
  const deny = (reason) => ({ destination: "Signoff", eligible: false, reason });

  if (input.fastPathEnabled !== undefined && typeof input.fastPathEnabled !== "boolean") return deny("invalid-fast-path-enabled");
  if (input.fastPathEnabled === false) return deny("fast-path-disabled");
  if (input.requireShipApproval === true) return deny("ship-approval-required");
  if (input.stateName !== WORKFLOW_STATES.qa) return deny("not-in-qa");
  if (!labels.has("fast-path:eligible")) return deny("missing-fast-path-label");
  if (!labels.has("qa:passed")) return deny("missing-qa-pass");
  if ([...QA_HANDOFF_BLOCKING_LABELS].some((label) => labels.has(label))) return deny("blocked");
  if (input.hasForeignClaim !== false) return deny("foreign-claim");
  if (input.reviewedHead == null || input.reviewedHead === "") return deny("missing-reviewed-head");
  if (!FULL_GIT_SHA.test(input.reviewedHead)) return deny("invalid-reviewed-head");
  if (input.finalHead == null || input.finalHead === "") return deny("missing-final-head");
  if (!FULL_GIT_SHA.test(input.finalHead)) return deny("invalid-final-head");
  if (input.reviewedHead.toLowerCase() !== input.finalHead.toLowerCase()) return deny("head-mismatch");
  return { destination: WORKFLOW_STATES.ship, eligible: true, reason: "eligible" };
}
```

`hasForeignClaim` must be explicitly `false`; unknown claim state fails closed. `issueIdentifier` remains caller context for marker parsing/audit and is intentionally not part of the decision result.

- [ ] **Step 4: Run focused and full tests and observe GREEN**

Run:

```bash
node --test tests/linear.test.mjs
node --test tests/*.test.mjs
```

Expected: both commands exit 0; the full suite has at least the 304 baseline tests plus the new policy cases.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/linear.mjs tests/linear.test.mjs
git commit -m "feat(COD-142): add QA fast-path handoff policy"
```

---

### Task 2: Commit-bound sweep behavior and operator documentation

**Files:**
- Create: `tests/qa-sweep-doc.test.mjs`
- Modify: `.claude/skills/dev-sweep/SKILL.md`
- Modify: `skills/dev-sweep/SKILL.md`
- Modify: `.claude/skills/qa-sweep/SKILL.md`
- Modify: `skills/qa-sweep/SKILL.md`
- Modify: `.claude/skills/ship-sweep/SKILL.md`
- Modify: `skills/ship-sweep/SKILL.md`
- Modify: `.claude/linear-sweep.json`
- Modify: `templates/linear-sweep.json`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `docs/linear-rules.md`

**Interfaces:**
- Consumes: `qaHandoffDecision` policy and guarded `move-card-bottom-if-current` helper.
- Produces: exact reviewed-SHA Dev marker, exact automatic-Ship QA marker, and conditional `QA -> Ship` transition.
- Preserves: existing `QA -> Signoff` behavior for every denial and the existing Ship queue/sanity behavior.

- [ ] **Step 1: Create failing documentation-contract tests**

Create `tests/qa-sweep-doc.test.mjs` using `node:test`, `node:assert/strict`, and `node:fs`. Read both Dev, QA, and Ship skill copies. Assert:

```js
assert.match(dev, /\[auto-sweep-fast-path <KEY> head=<full-git-sha>\]/);
assert.match(dev, /only after[^\n]*push/i);
assert.match(qa, /\[auto-sweep-auto-ship <KEY> head=<full-git-sha>\]/);
assert.match(qa, /`fast-path:eligible`/);
assert.match(qa, /`qa:passed`/);
assert.match(qa, /`fastPathEnabled: config\.fastPath\?\.enabled`/);
assert.match(qa, /`requireShipApproval: config\.requireShipApproval`/);
assert.match(qa, /final origin[^\n]*SHA[^\n]*reviewed SHA/i);
assert.match(qa, /remove `fast-path:eligible`[^\n]*stale/i);
assert.match(qa, /policy denial[^\n]*not a QA failure/i);
assert.match(qa, /move-card-bottom-if-current <PREFIX-###> "QA" "Ship" "qa:in-progress"/);
assert.match(qa, /move-card-bottom-if-current <PREFIX-###> "QA" "Signoff" "qa:in-progress"/);
assert.match(ship, /automatically promoted by qa-sweep/i);
assert.match(ship, /only sweep that merges and deploys/i);
```

Assert byte equality for every canonical/distributed sweep pair. Assert operator docs mention commit-bound automatic QA-to-Ship routing, explicit approval preserving Signoff, and QA remaining non-production. Assert both JSON files parse and their `$comment_fastPath` strings describe the new behavior.

- [ ] **Step 2: Run the documentation test and observe RED**

Run:

```bash
node --test tests/qa-sweep-doc.test.mjs
```

Expected: FAIL because the skills still describe a human-only Ship move and do not contain commit-bound markers.

- [ ] **Step 3: Update Dev sweep in both distributions**

Change optional fast-path evaluation so §2 determines candidacy after reviews/checks, but does not yet apply the label. In §3, push first, resolve the full origin branch SHA, confirm it is the reviewed final commit, then add `fast-path:eligible` and this exact marker:

```text
[auto-sweep-fast-path <KEY> head=<full-git-sha>]
```

If the origin SHA cannot be proven, do not add the label. Dev still moves every successful card to `QA`.

- [ ] **Step 4: Update QA sweep in both distributions**

Keep the existing smoke/build gate. Replace the unconditional §4 `Signoff` destination with a final handoff decision that:

1. adds `qa:passed` and re-fetches the card;
2. obtains the final full SHA from origin, not the local worktree;
3. reads the latest well-formed issue-specific reviewed-SHA marker;
4. evaluates the exact Task 1 policy;
5. passes `fastPathEnabled: config.fastPath?.enabled`, then fetches origin and Linear again and reruns the full policy immediately before handoff;
6. posts `[auto-sweep-auto-ship <KEY> head=<full-git-sha>]` and uses `move-card-bottom-if-current` to move eligible cards to `Ship` while removing only `qa:in-progress`;
7. removes stale `fast-path:eligible`, records both SHAs, and uses the same guarded helper for a SHA-mismatched `Signoff` move;
8. routes every other denial to `Signoff` and explicitly states that a policy denial is not a QA failure.

Update the final re-read, machine handoff, and guardrail text to name the selected terminal destination while preserving the no-merge/no-deploy rule.

- [ ] **Step 5: Update Ship sweep wording in both distributions**

Describe `Ship` cards as either human-approved or automatically promoted by `qa-sweep` under the commit-bound fast-path policy. For auto-promoted fresh-path cards, validate the latest issue-specific marker against current origin during sanity and re-fetch origin immediately before merge for the same exact comparison. If origin advanced or the marker is malformed/missing its SHA, block before merge with evidence. Preserve legacy/human-moved behavior when no auto marker exists and state that `requireShipApproval: true` remains a deliberate human act.

- [ ] **Step 6: Update configuration and operator docs**

Update `.claude/linear-sweep.json` and `templates/linear-sweep.json` comments without adding a new key. Update `AGENTS.md`, `README.md`, `SETUP.md`, `docs/linear-rules.md`, and `templates/AGENTS.snippet.md` so they consistently say:

- normal passing cards: `QA -> Signoff -> [human] -> Ship`;
- eligible unchanged fast paths: `QA -> Ship` automatically after full QA;
- `requireShipApproval: true`: always `QA -> Signoff`;
- QA never merges/deploys and Ship remains single-runner;
- no immediate QA-to-Ship launcher handoff is added.

- [ ] **Step 7: Run focused and full tests and observe GREEN**

Run:

```bash
node --test tests/qa-sweep-doc.test.mjs tests/ship-sweep-doc.test.mjs tests/linear.test.mjs
node --test tests/*.test.mjs
git diff --check
```

Expected: all commands exit 0; canonical/distributed copies match byte-for-byte; no whitespace errors.

- [ ] **Step 8: Commit Task 2**

```bash
git add .claude/skills/dev-sweep/SKILL.md skills/dev-sweep/SKILL.md \
  .claude/skills/qa-sweep/SKILL.md skills/qa-sweep/SKILL.md \
  .claude/skills/ship-sweep/SKILL.md skills/ship-sweep/SKILL.md \
  .claude/linear-sweep.json templates/linear-sweep.json AGENTS.md README.md \
  SETUP.md docs/linear-rules.md tests/qa-sweep-doc.test.mjs
git commit -m "feat(COD-142): auto-promote unchanged fast paths after QA"
```

---

### Task 3: Final verification and handoff evidence

**Files:**
- Modify: `docs/superpowers/plans/2026-07-10-COD-142-auto-ship-qa-fast-path-implementation.md` only to check completed boxes if the executing workflow records them in-repo.
- No production files are added in this task.

**Interfaces:**
- Consumes: Tasks 1-2 commits.
- Produces: fresh verification evidence and a reviewed branch ready for the ship workflow.

- [ ] **Step 1: Verify exact policy and marker surfaces**

Run:

```bash
rg -n "auto-sweep-(fast-path|auto-ship)|requireShipApproval|qaHandoffDecision" \
  scripts tests .claude/skills skills AGENTS.md README.md SETUP.md docs/linear-rules.md \
  .claude/linear-sweep.json templates/linear-sweep.json
```

Expected: Dev marker, QA marker, deterministic helper, explicit-approval override, and both destinations are present; no stale statement says every Ship move is human-only.

- [ ] **Step 2: Run fresh full verification**

Run:

```bash
node --test tests/*.test.mjs
git diff --check origin/main...HEAD
git status --short
```

Expected: all tests pass, no whitespace errors, and only intentional plan bookkeeping is uncommitted.

- [ ] **Step 3: Independent whole-branch review**

Review `git diff $(git merge-base origin/main HEAD)...HEAD` against the design spec and this plan. Fix and re-review every Critical or Important finding before shipping.

- [ ] **Step 4: Post Linear implementation evidence**

Comment on `COD-142` with the branch, commits, test command/count, review result, and residual risk. Keep `sweep:manual-only` until the code is integrated; release `dev:in-progress` when implementation work is complete.

- [ ] **Step 5: Enter the ship workflow**

Run the repository ship workflow from the feature branch. It owns base synchronization, release metadata, final tests/review, push, and pull request creation. After the PR is green, land it under the user's explicit ship authorization and verify `main` contains the merge.

# Ship Owner-Token Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every scheduled Ship child is launcher-claimed and receives the exact nonempty `AUTO_SWEEP_OWNER_TOKEN` that owns `ship:in-progress`.

**Architecture:** Remove the unsafe Ship dispatch shortcut and route fresh Ship demands through the existing `claimCardSlots()` owner-token handshake used by other stages. Preserve Ship's existing one-card-per-source-workspace selection and route revalidation; resume demands continue reusing their original claim without a second claim write.

**Tech Stack:** Node.js ESM, `node:test`, Linear GraphQL helpers.

## Global Constraints

- Ship remains single-runner and one child per registered source workspace.
- No Ship child may launch without a confirmed owner-token claim.
- Resume dispatches must not create a second claim or heartbeat.
- Repository-route changes must fail closed before child launch.

---

### Task 1: Reproduce and fix fresh Ship claim admission

**Files:**
- Modify: `tests/linear-watch.test.mjs`
- Modify: `scripts/linear-watch.mjs`

**Interfaces:**
- Consumes: `expandDispatchBatch(batch, options)` and `claimCardSlotsFn(...)`.
- Produces: a Ship dispatch whose `ownerToken` and `childEnv.AUTO_SWEEP_OWNER_TOKEN` come from the confirmed claim slot.

- [x] **Step 1: Write the failing test**

Create an ordinary Ship demand without `ownerToken`, inject `claimCardSlotsFn` returning a confirmed slot with `ownerToken: "ship-owner"`, and assert the claim helper is called once and the resulting child exports `AUTO_SWEEP_OWNER_TOKEN=ship-owner`.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern='Ship claims ordinary demand' tests/linear-watch.test.mjs`

Expected: FAIL because the Ship-only shortcut does not call `claimCardSlotsFn` and omits `AUTO_SWEEP_OWNER_TOKEN`.

- [x] **Step 3: Write minimal implementation**

Delete the fresh Ship shortcut from `expandDispatchBatch()`. Let the shared limit/claim/slot-to-env path handle Ship, with its configured same-repo limit of `1`; keep route confirmation inside `claimCardSlots()`.

- [x] **Step 4: Run focused and full tests**

Run: `node --test --test-name-pattern='Ship claims ordinary demand|Ship receives the same card env' tests/linear-watch.test.mjs`

Expected: PASS.

Run: `node --test tests/*.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Audit and clear affected Linear blockers**

Search project comments for the exact missing-owner-token blocker, remove only that machine-generated blocker where ownership/state still permits a safe retry, and rerun COD-160 through the repaired launcher.

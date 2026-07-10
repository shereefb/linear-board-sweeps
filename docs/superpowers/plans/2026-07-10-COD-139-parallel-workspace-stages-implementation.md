# Parallel Workspace Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dispatch independently actionable Spec, Dev, and QA stages from one registered workspace concurrently without weakening cross-workspace repository collision safety or serial Ship behavior.

**Architecture:** Keep candidate construction and admission unchanged. Make `selectDispatchBatch()` permit multiple non-Ship candidates with the same anchor, while applying resolved-path overlap rejection only between candidates owned by different anchors.

**Tech Stack:** Node.js ES modules, `node:test`, shell-based launcher installation and service management.

## Global Constraints

- `parallel.maxNonShipDispatches` continues to count selected workspace/stage candidates.
- `capacity.maxActiveChildren` remains the host-wide child ceiling.
- Ship remains exclusive and serial.
- Dependency eligibility, repository routing, card claims, worktrees, ports, and per-repo/stage limits remain unchanged.

---

### Task 1: Correct batch selection

**Files:**
- Modify: `tests/linear-watch.test.mjs`
- Modify: `scripts/linear-watch.mjs`

**Interfaces:**
- Consumes: `selectDispatchBatch(candidates, options)` and each candidate's registered source workspace (`sourceAnchorPath || anchorPath`), `sweep`, and resolved repository set.
- Produces: the same candidate array interface, now containing multiple distinct stages from one registered workspace when bounded capacity allows.

- [ ] **Step 1: Write the failing regression tests**

Replace the same-anchor dedupe expectation with tests asserting that QA, Dev, and Spec from `/ws/a` are selected in stage order, that `maxNonShipDispatches: 2` selects only the first two, and that `/ws/b` resolving to `/ws/a` still collides with the selected `/ws/a` candidates.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern='selectDispatchBatch: (dispatches distinct stages|caps distinct stages)' tests/linear-watch.test.mjs`

Expected: FAIL because the current `usedAnchors` and resolved-path overlap checks return only one `/ws/a` candidate.

- [ ] **Step 3: Implement the minimal selector change**

Deduplicate by registered source workspace plus stage. Track each selected candidate's registered source workspace and repository set, then reject overlap only across different registered source workspaces.

- [ ] **Step 4: Verify GREEN and run the full suite**

Run the focused command from Step 2, then `node --test`.

Expected: all tests pass.

### Task 2: Document, review, release, and install

**Files:**
- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `CHANGELOG.md`
- Modify: `VERSION`

**Interfaces:**
- Consumes: the corrected selector behavior.
- Produces: operator documentation and a propagated kit release.

- [ ] **Step 1: Update operator documentation**

State that non-Ship batching is by workspace/stage candidate, distinct stages in
one workspace may run together, and resolved repository overlap is excluded
across different registered workspaces.

- [ ] **Step 2: Review and verify**

Run project health checks and an independent diff review. Resolve all actionable
findings, then rerun `node --test`.

- [ ] **Step 3: Release and ship**

Bump the patch release, update the changelog, commit with `COD-139`, push, open
and merge the PR after checks pass.

- [ ] **Step 4: Install and verify live**

Install the merged version, propagate it to every registered anchor, relaunch the
watcher, and use `linear-watch doctor --json` plus tick logs to verify healthy
capacity and concurrent reservations when multiple stages are actionable.

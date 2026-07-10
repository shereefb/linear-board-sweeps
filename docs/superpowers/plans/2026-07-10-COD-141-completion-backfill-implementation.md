# COD-141 Completion Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep eligible sweep work running after child completion without weakening Ship or claim ownership safety.

**Architecture:** Extend the existing completion-discovery path instead of adding a second scheduler. Ship uses the same bounded refill builder as other stages, while successful same-state exits re-read Linear and release only the completed child's launcher-owned claim before refill discovery runs.

**Tech Stack:** Node.js ESM, `node:test`, Linear GraphQL helpers, launchd-managed local installation.

## Global Constraints

- Ship remains limited to one active child per registered source workspace.
- The host capacity ceiling remains 10.
- Claim cleanup must prove the latest heartbeat owner before removing a label.
- Dependency, routing, checkout, runtime, and human gates remain fail-closed.

---

### Task 1: Completion regressions

**Files:**
- Modify: `tests/linear-watch.test.mjs`

- [x] Add a failing test proving a completed Ship child produces a deferred refill demand for the next eligible Ship card in the same workspace.
- [x] Add a failing test proving successful same-state completion selects owned-claim cleanup while successful forward progress does not.
- [x] Run the focused tests and confirm both failures describe the missing behavior.

### Task 2: Minimal scheduler implementation

**Files:**
- Modify: `scripts/linear-watch.mjs`

- [x] Permit Ship through the existing completion refill builder with an effective per-workspace limit of one.
- [x] On successful completion, re-read the issue and release the launcher-owned claim only when the issue still belongs to the completed sweep's workflow state.
- [x] Keep the existing admission queue as the sole executor of refill demands.
- [x] Run the focused tests and confirm they pass.

### Task 3: Release and rollout

**Files:**
- Modify: `README.md`
- Modify: `docs/linear-rules.md`
- Modify: `CHANGELOG.md`
- Modify: `VERSION`

- [x] Document completion-driven refill and live-process claim semantics.
- [x] Bump the repository's four-part patch version in `VERSION`.
- [ ] Run the full suite, syntax checks, independent review, and deployment verification.
- [ ] Push, merge, install the new kit, refresh all registered managed workspaces, restart the watcher, and verify source/managed/install version parity.

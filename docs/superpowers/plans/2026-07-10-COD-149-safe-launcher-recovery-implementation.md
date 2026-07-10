# COD-149 Safe Launcher Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve incomplete Dev worktrees safely, resume them deterministically, and treat capacity/dependency deferrals as queue state rather than generic failure Todos.

**Architecture:** Add an atomically persisted launcher resume store under the existing state directory and a stable per-card Linear audit marker. The dispatch-result path decides whether a same-state successful child may release its claim after Git checks; a retained record feeds a narrow resume-admission path. Capacity outcomes are classified from bounded child-log evidence and scheduled with capped backoff plus configured runtime fallbacks before generic failure reconciliation.

**Tech Stack:** Node.js ESM, Node built-ins (`fs`, `path`, `child_process`), Linear GraphQL helpers, `node:test`.

## Global Constraints

- Never run `git reset`, `git checkout`, `git restore`, `git clean`, `git stash`, auto-commit, or broad deletion in any recovery path.
- A claim can be released only after re-reading the card and proving the latest heartbeat owner matches the completed child.
- Resume only the matching local worktree/card/stage/owner-token/route tuple; any mismatch fails closed.
- Keep state atomic with `atomicWriteJson`; state and comments must be idempotent.
- Generic failure Todos remain for genuine dispatch/routing failures, but not dependency deferral, recognized capacity/quota exhaustion, or preserved-work recovery.
- No new dependency; preserve the zero-dependency launcher design.

---

### Task 1: Define and test persisted resume state

**Files:**
- Modify: `scripts/linear-watch.mjs:63-105, 1890-2011`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:** `RESUME_STATE_VERSION`, `RESUME_NEEDED_TAG`, and `createResumeStore(options)`. The store exposes `get(pick)`, `upsert(record)`, `clear(pick)`, `due(pick)`, and `protectedClaim(card, cfg, now)`; a record contains `{ sourceWorkspace, sweep, issueIdentifier, issueId, ownerToken, worktreePath, branch, repoEntry, reason, nextEligibleAt, attempts, createdAt, updatedAt }`.

- [ ] **Step 1: Write failing tests** for atomic upsert, stable identity, due time, exact clear, malformed-state fail-closed behavior, and reaper protection. Reaper tests must prove that a valid local protected record refreshes only its matching claim heartbeat; an expired/mismatched/missing record follows normal stale reaping and escalation.
- [ ] **Step 2: Run RED** — `node --test tests/linear-watch.test.mjs --test-name-pattern="resume store"`; expect missing-store failures.
- [ ] **Step 3: Implement minimally** — add `resume-needed.json` under `STATE_DIR`, deterministic identity from canonical workspace/stage/card, schema validation, and atomic persistence modelled on `createObservationStore`. Reject missing owner, worktree, branch, route, or finite eligibility time; never persist raw logs or credentials. Integrate a bounded resume-aware branch into `reapDecisions`: only a valid exact record on its original host protects a claim, and protection writes a fresh matching heartbeat rather than exempting the claim forever.
- [ ] **Step 4: Run GREEN** — repeat the focused command; expect all resume-store tests to pass.
- [ ] **Step 5: Commit** — stage only `scripts/linear-watch.mjs` and `tests/linear-watch.test.mjs` with subject `COD-149 persist resume-needed state`.

### Task 2: Gate same-state claim release on clean, pushed work

**Files:**
- Modify: `scripts/linear-watch.mjs:4660-4755, 5147-5500`
- Test: `tests/linear-watch.test.mjs:3456-3524`

**Interfaces:** `successfulSameStateRecoveryDecision(pick, card, options)` returns `{ kind: "release" | "resume-needed" | "preserve", reason, branch }`. `reconcileOwnedDispatchClaim` accepts injected recovery, resume-store, comment, and Git dependencies.

- [ ] **Step 1: Write failing tests** for clean/pushed release; modified plus untracked files; clean worktree with commits ahead of origin; and missing worktree/changed status/missing claim/changed heartbeat owner preserving everything.
- [ ] **Step 2: Run RED** — `node --test tests/linear-watch.test.mjs --test-name-pattern="same-state recovery"`; expect missing decision failures.
- [ ] **Step 3: Implement minimally** — use `git status --porcelain --untracked-files=all`, then bounded `git fetch origin <issueIdentifier>`, `git rev-parse --verify origin/<issueIdentifier>`, and `git rev-list --count origin/<issueIdentifier>..<issueIdentifier>`. Fetch failure, stale/missing remote ref, or local commits ahead of origin is preserve/resume-needed, never release. Only clean/pushed ownership-proven work calls `releaseOwnedDispatchClaim`; dirty/unpushed work keeps claim/worktree, upserts resume state, and creates or updates one `[auto-sweep-resume-needed owner=<owner> claim=<claim>]` comment with sanitized reason/time. Extend the claim-card query with comment IDs and add a `commentUpdate` helper; select/update an existing exact owner/token marker, otherwise create one, then re-read to converge duplicate races. Clean release clears its matching resume record.
- [ ] **Step 4: Run GREEN** — `node --test tests/linear-watch.test.mjs --test-name-pattern="same-state recovery|successful child completion"`; expect the SAF-210 modified/untracked case to retain its claim and create one resume outcome.
- [ ] **Step 5: Commit** — stage only launcher/tests with subject `COD-149 preserve incomplete successful worktrees`.

### Task 3: Admit only matching preserved-work resumes

**Files:**
- Modify: `scripts/linear-watch.mjs:4235-4260, 5650-6345`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:** `resumeAdmissionDecision(pick, freshCard, resumeRecord, now)` and a dedicated `resume` admission demand. Candidate preparation admits a due matching record before ordinary unclaimed-card selection for its same repository/stage slot.

- [ ] **Step 1: Write failing tests** proving a due matching resume is selected despite its live claim, bypasses `claimCardSlots`, reuses its original owner token, and emits no second heartbeat/claim write. Test the same exact-match bypass through initial dispatch, refill, and handoff paths; non-due resumes skip; changed owner/state/route/worktree/claim fails closed; and an unrelated dirty worktree still creates the existing blocker.
- [ ] **Step 2: Run RED** — `node --test tests/linear-watch.test.mjs --test-name-pattern="resume admission|dirty checkout"`; expect matching resumes to be filtered or blocked.
- [ ] **Step 3: Implement minimally** — consult resume state before normal live-claim filtering and construct a dedicated demand that bypasses `claimCardSlots` but preserves the original owner token, route, and deterministic worktree. Thread the exact-match bypass through initial dispatch, same-repo refill, and handoff dirty-checkout guards so none can emit a dirty-checkout failure Todo for SAF-210-shaped work. Rediscover a matching claimed Dev card plus dirty deterministic worktree as resume-needed when state is missing/corrupt; never reset, stash, remove, or create a failure Todo.
- [ ] **Step 4: Run GREEN** — repeat the focused command; expect only the SAF-210-shaped worktree to resume.
- [ ] **Step 5: Commit** — stage only launcher/tests with subject `COD-149 resume matching preserved worktrees`.

### Task 4: Classify capacity deferral and use configured fallback lanes

**Files:**
- Modify: `scripts/linear-watch.mjs:426-445, 5147-5500, 5580-5705`
- Modify: `.claude/linear-sweep.json`, `README.md`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:** optional `runtimes.<sweep>.fallbacks`, an ordered array of `{ runtime, model?, effort? }`; `classifyCapacityOutcome(outcome, logTail)`; and a retry record using the resume store with `reason: "capacity"`.

- [ ] **Step 1: Write failing tests** for recognized quota/rate-limit/model-capacity signatures, capped retry times, first fallback selection, exhausted retry deferral, and no failure-Todo decision for recognized capacity outcomes. Assert unknown exits retain generic failure behavior.
- [ ] **Step 2: Run RED** — `node --test tests/linear-watch.test.mjs --test-name-pattern="capacity outcome|runtime fallback"`; expect generic exits/no fallback support.
- [ ] **Step 3: Implement minimally** — inspect only a bounded tail of launcher-owned logs, classify documented patterns without persisting text, and use `1m`, `5m`, `15m`, then capped `60m` backoff. Thread a selected runtime override through preflight, command building, run records, and lane identity. When fallback configuration is absent/exhausted, defer rather than emit a failure Todo.
- [ ] **Step 4: Run GREEN** — `node --test tests/linear-watch.test.mjs --test-name-pattern="capacity outcome|runtime fallback|failure Todo"`.
- [ ] **Step 5: Commit** — stage launcher/tests/config/docs only with subject `COD-149 retry capacity failures safely`.

### Task 5: Preserve dependency semantics and enforce allowlist-only cleanup

**Files:**
- Modify: `scripts/linear-watch.mjs:4235-4260, 5650-6345`
- Modify: `README.md`, `docs/superpowers/specs/2026-07-08-auto-sweep-launcher-design.md`, `.claude/skills/dev-sweep/SKILL.md`
- Test: `tests/linear-watch.test.mjs`

**Interfaces:** dependency-deferred results bypass generic failure reconciliation; `generatedArtifactCleanupTargets(pick)` returns only launcher-owned `tmpDir`, `logDir`, `screenshotDir`, and `browserProfileDir` paths that are outside all repository/worktree paths.

- [ ] **Step 1: Write failing tests** that dependency deferral creates no failure event/Todo and releases only temporary admission; cleanup accepts a run-root artifact but rejects worktree, repo, ancestor, arbitrary paths, and an allowlisted path symlinked into a worktree; recovery helpers never invoke forbidden Git cleanup commands. Audit existing `fs.rmSync` call sites and explicitly test that none is reachable from preserved-work recovery.
- [ ] **Step 2: Run RED** — `node --test tests/linear-watch.test.mjs --test-name-pattern="dependency deferral|generated artifact cleanup"`.
- [ ] **Step 3: Implement minimally** — keep dependency deferral out of `failures` in initial, handoff, and completion paths; add realpath/lstat-aware run-root allowlist validation without any Git cleanup. Update README, canonical launcher design, Dev-sweep, and QA-sweep instructions to remove reset-dirty-worktree guidance and state the preserve/resume contract.
- [ ] **Step 4: Run GREEN** — repeat the focused command.
- [ ] **Step 5: Commit** — stage only listed code/tests/docs with subject `COD-149 document safe recovery boundaries`.

### Task 6: Full verification and handoff

**Files:**
- Verify: `tests/linear-watch.test.mjs` and all repository tests

- [ ] **Step 1: Run focused launcher tests** — `node --test tests/linear-watch.test.mjs`; expect the SAF-210 regression, owner mismatch, capacity fallback, dependency deferral, and allowlist tests to pass.
- [ ] **Step 2: Run full verification** — `node --test`; expect every repository test to pass.
- [ ] **Step 3: Inspect scope** — run `git diff origin/main...HEAD --check` and `git diff --stat origin/main...HEAD`; expect only COD-149 launcher, tests, config, and recovery docs.
- [ ] **Step 4: Push feature branch** — `git push -u origin codex/COD-149-safe-launcher-recovery`; expect a verified branch for QA.

## Spec-sweep review audit

- Final tier: Tier 2, due to claim ownership, local persistence, concurrency/admission, and data-loss risk.
- Required: plan review before code; source-level code review plus independent reviewer after code.
- Specialized review: security/UI not material; performance is covered by the engineering review and bounded I/O/backoff tests.
- Risks addressed: uncommitted-work loss, claim release, duplicate dispatch, remote divergence, raw-error leakage, and repeated generic failure Todos.

## Review additions

The plan review added reaper-aware claim protection, a dedicated already-claimed resume demand, exact-match dirty-checkout bypasses across all dispatch paths, remote fetch verification, race-safe marker-comment updates, symlink-safe cleanup validation, and QA-sweep documentation updates. These are mandatory before ship.

## Execution shape

Sequential implementation is required: every task changes launcher orchestration in `scripts/linear-watch.mjs`, so parallel branches would create high-conflict changes and make state-machine review harder.

```
success in claimed Dev
  ├─ clean + fetched/pushed + owner match ──> release claim ──> normal queue
  └─ dirty/unpushed/fetch failure ──> persist resume + stable comment
                                      └─ reaper refreshes matching claim
                                          └─ due exact-match demand resumes same worktree
```

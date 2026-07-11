# COD-149: Safe launcher recovery for preserved Dev worktrees

## Decision

The launcher must treat an uncommitted card worktree as preserved work in progress, never as disposable recovery residue. It must not auto-commit, reset, checkout, stash, clean, remove, or otherwise discard a dirty worktree.

When a child exits successfully but leaves its card in the stage it claimed, the launcher may release its claim only after it has re-read the card, proved it still owns the claim, proved the card worktree is clean, and proved the branch has no commits missing from origin. Otherwise it retains the claim and schedules a narrow, deterministic resume of that same worktree.

## Background: SAF-210

SAF-210 demonstrated the unsafe gap. Its Dev child returned exit code zero while the card remained in Dev. The deterministic worktree still had one modified and two untracked test files. The launcher released `dev:in-progress`, then later created the generic dirty-checkout Todo SAF-273 because normal dispatch correctly refused to enter the dirty worktree. The code was preserved, but progress required manual intervention.

COD-149 makes that state a deliberate recovery outcome instead: the card remains claimed, the worktree remains untouched, and the next eligible launcher tick resumes the same worktree. A generic failure Todo is neither created nor needed for this expected recovery path.

## Goals

- Preserve incomplete local work without silently shipping or deleting it.
- Allow a successful-but-incomplete Dev run to resume automatically in the exact deterministic worktree.
- Keep claims owner-safe: no run may release or resume another owner's work.
- Treat model quota/capacity exhaustion as bounded, retryable queue state with provider fallback.
- Treat dependency deferral as ordinary queue state, not a launcher failure.
- Limit all automated cleanup to an explicit generated-artifact allowlist.

## Non-goals

- Recover uncommitted work on a different host. Uncommitted files remain machine-local; the original host protects and resumes them.
- Auto-commit unfinished work or infer that a dirty tree is complete.
- Change the human gate for Ship, the exact-`Done` dependency rule, or existing clean-worktree completion cleanup.
- Add a generic retry framework for every child failure; this design only changes known capacity/quota conditions and successful same-stage exits with preserved work.

## Recovery model

### Two records, separate responsibilities

A local structured resume record is authoritative for machine-local scheduling: card identifier, stage, owner token, deterministic worktree path, branch/ref observation, resume reason, bounded retry metadata, and next eligible time. It must be updated atomically and removed only after a verified successful handoff or an explicit human-directed resolution.

A single stable Linear audit comment is the human-visible counterpart. It is keyed by card identifier and owner token and is created or updated idempotently; retries do not add comment spam. It records only sanitized facts: that the worktree is preserved, the resume reason, and the next eligibility time. It cannot be the scheduler's sole source of truth because it cannot atomically represent local paths or backoff state.

### Successful child that remains in its claimed state

After a `success` result, the launcher re-fetches the card. It verifies all of the following before releasing its claim:

1. The card is still in the claimed sweep state.
2. The expected in-progress label remains present.
3. The latest heartbeat owner exactly matches the completed child owner token.
4. The deterministic card worktree has no tracked or untracked changes according to `git status --porcelain --untracked-files=all`.
5. The local branch is not ahead of its expected upstream branch; the branch and its pushed commit are visible on origin.

If all checks pass, ordinary same-state claim release and queue/refill behavior remains valid.

If the worktree is dirty or the branch is unpushed, the launcher must leave the claim and worktree unchanged, write or refresh the one local resume record and one Linear audit comment, and suppress generic failure-Todo reconciliation for this result. It must not release the claim merely because the process returned zero.

### Resume admission

A preserved-work resume is a separate admission path, not ordinary unclaimed-card selection. On or after its recorded eligibility time, it may run only when all of these still match: the local resume record, card identifier, stage, owner token, claim label and heartbeat, deterministic worktree path, and primary repository route. A mismatch is fail-closed: leave files and claim untouched, record an actionable audit reason, and do not start a second worktree.

The matching resume candidate is considered before ordinary cards for its same repository/stage slot. This avoids the existing live-claim filter skipping it forever while still ensuring that an arbitrary fresh claim cannot resume local WIP. A missing or corrupt local record is handled conservatively: a matching claimed Dev card plus a dirty deterministic worktree is rediscovered as resume-needed, not cleaned or released.

## Retry and deferral policy

### Capacity and provider errors

The launcher classifies known model quota/capacity failures before generic failure handling. Its retry state stores a bounded attempt count, next eligible time, prior provider/model lane, and sanitized error class. It uses capped exponential backoff and, when configuration provides a fallback lane, tries that fallback before retrying the same exhausted lane.

Capacity exhaustion produces a deferred queue outcome and audit evidence, never a generic failure Todo. Reaching the attempt cap pauses further automatic attempts until the recorded retry window or an explicit human action; it still must not be represented as a generic runtime/dispatch failure.

### Dependency deferral

Dependency preflight deferral is ordinary queue state. The launcher releases only temporary admission that it owns, records bounded dependency observation if needed, and lets a later exact-`Done` dependency check restore eligibility. It creates no failure Todo or `blocked:needs-user` label solely for a `blockedBy` relation.

## Cleanup boundary

Recovery cleanup is deny-by-default. Only named launcher-generated artifacts outside repository worktrees may be deleted—for example, a run's dedicated temporary directory, log file, screenshot directory, and browser profile directory. Every allowed path must be derived from launcher-owned run roots, validated against the explicit allowlist, and logged before deletion.

The following are forbidden in recovery paths: `git reset`, `git checkout`, `git restore`, `git clean`, `git stash`, broad worktree removal, broad recursive deletion, auto-commit, and any deletion under a card worktree. Existing cleanup for a verified clean, completed worktree remains outside this recovery path and must also prove its target is launcher-owned.

## Review depth decision

Predicted implementation surface: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`, `README.md`, and the canonical launcher design document; roughly 300–500 changed lines across dispatch-result reconciliation, selection/admission, local state, and tests.

This is **Tier 2 — Material**. It changes claim ownership, retry semantics, scheduling/admission, worktree safety, local persistence, and operator-visible failure behavior. It has concurrency and data-loss-risk surfaces, plus a performance concern from additional Git/Linear reads. The plan must receive both engineering reviews and an independent adversarial review. Security is not a material auth/data-exposure change, but the review must examine command/path safety. Performance review is required through the engineering review's performance section and must define bounded I/O and backoff behavior. UI and DevEx lenses are not materially applicable.

## Acceptance criteria

1. No recovery path auto-commits, resets, checks out, restores, cleans, stashes, or broadly removes a dirty worktree.
2. A successful same-state child releases its claim only after ownership, clean worktree, and pushed-branch verification.
3. A dirty or unpushed same-state result keeps its claim, preserves its exact worktree, and creates/reuses one resume-needed outcome.
4. The next eligible matching tick resumes that one preserved worktree without ordinary selection skipping its live claim.
5. A missing/corrupt local resume record is rediscovered conservatively from matching card and worktree evidence.
6. Quota/model-capacity errors use bounded backoff and configured provider fallback without creating generic failure Todos.
7. Dependency deferrals create no generic failure Todo.
8. Automated cleanup accepts only explicit generated-artifact paths and rejects worktree/repository paths.
9. Tests cover every success, preservation, resume, mismatch, retry, deferral, and cleanup branch above, including SAF-210's modified/untracked-file regression.

## Canonical documentation impact

`README.md` and `docs/superpowers/specs/2026-07-08-auto-sweep-launcher-design.md` currently describe immediate claim release for same-state successful exits and resetting dirty worktrees. The implementation must replace those statements with this preservation contract. Until implementation lands, documentation describing this behavior must label it as **planned (COD-149)** rather than claim it is live.

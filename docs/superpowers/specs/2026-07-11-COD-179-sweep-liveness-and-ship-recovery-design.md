# COD-179 Sweep Liveness and Ship Recovery Design

**Status:** Approved in conversation on 2026-07-11

## Problem

The launcher can report a healthy successful run without producing useful board progress. The observed failure is COD-157: the launcher created a valid immutable `ship:in-progress` claim, exported its owner and declaration to the Ship child, and the child rejected that same claim as if another run owned it. The child exited `0`, the launcher preserved the still-live claim, and the card remained unshipped.

This is broader than one contradictory Ship instruction. Today, process success is treated as workflow success even when the card did not advance, gain a legitimate blocker, record a resumable state, or close its claim. A long-lived tick can also wait indefinitely for children, and Ship refill depends too heavily on global drain timing. These gaps turn safe fail-closed behavior into silent queue stalls.

## Goals

1. A scheduled Ship child accepts only the exact immutable claim epoch declared for it.
2. A child exit is successful only when Linear or verified local recovery state records an allowed outcome.
3. Expired children cannot hold a tick or claim forever.
4. A completed or blocked Ship child immediately frees and refills that source workspace's Ship slot.
5. `health` and `doctor` explain stalls in operator terms.
6. Recovery changes only claims and blockers proven to be machine-stranded by this defect.

## Non-goals

- Weakening QA, dependency, approval, security, deploy, or canary gates.
- Automatically clearing genuine `blocked:needs-user`, `qa:needs-changes`, Todo dependencies, or failing test gates.
- Guessing ownership from a heartbeat, label, process ID, or partial comment history.
- Repairing ambiguous claim history automatically.
- Increasing Ship concurrency beyond one child per registered source workspace.

## Design Principles

The system remains fail closed at material boundaries, but it must fail visibly and release capacity safely. Ownership and progress are separate facts: immutable claim declarations authorize a child, while post-run reconciliation proves whether useful workflow progress occurred. Exit status alone proves neither.

## Increment 1: Restore Ship Correctness and Detect Successful No-ops

### Scheduled Ship pre-claim

In scheduled single-card mode, Ship requires nonempty `AUTO_SWEEP_OWNER_TOKEN` and `AUTO_SWEEP_CLAIM_DECLARATION`. Before material work it complete-reads the card's claim history and resolves the `ship:in-progress` epoch by first-declaration-wins rules.

The child continues only when all of these facts hold:

- the card remains in `Ship`;
- `ship:in-progress` is present;
- the open epoch's owner and declaration exactly match both environment values;
- the declaration has no verified close marker;
- no blocking or foreign in-progress claim invalidates the Ship gate.

That matching epoch is the child's pre-claim, not a competing run. A missing, malformed, ambiguous, closed, or mismatched epoch stops before material work. Multi-card attended Ship behavior retains queue selection and skips unrelated live claims.

Both `skills/ship-sweep/SKILL.md` and `.claude/skills/ship-sweep/SKILL.md` remain byte-identical.

### Machine-readable child outcome

Each scheduled child writes one terminal outcome record to its launcher-provided run directory. The record is scoped by card run ID and contains:

- issue, sweep, owner, and declaration identifiers;
- outcome kind: `advanced`, `blocked`, `deferred`, `resume-needed`, or `failed`;
- observed start and terminal state;
- the specific Linear marker, blocker, or recovery record that supports the outcome;
- completion timestamp.

The record is evidence input, not authority. A child cannot declare itself successful merely by writing it.

### Post-child reconciliation

After the process exits, the launcher complete-reads the issue and validates the claimed outcome against Linear and verified local recovery state. Allowed terminal shapes are:

| Outcome | Required evidence |
|---|---|
| `advanced` | Expected downstream/terminal state and the original claim epoch closed |
| `blocked` | Card-specific blocker evidence, claim epoch closed, and owned claim label removed |
| `deferred` | Machine-checkable dependency/route/capacity reason and no material mutation |
| `resume-needed` | Matching verified resume record and still-open owned epoch |
| `failed` | Closed/released owned epoch or an explicit cleanup failure surfaced to health |

Exit `0` with no valid terminal shape is `successful-no-op`. The launcher treats it as a failed dispatch, closes and releases only an epoch whose exact owner and declaration it still proves, records a bounded cooldown, and exposes the failure through existing failure-Todo reconciliation. It never removes a newer or ambiguous claim.

### Compatibility

During rollout, missing terminal outcome records are reconciled from observable state first. If the state proves a valid legacy terminal shape, accept it. If the card is unchanged with the launcher's claim still open, classify it as a no-op. This avoids requiring every installed skill copy to update atomically while still eliminating silent success.

## Increment 2: Bound Runtime, Refill Ship, and Expose Stalls

### Stage-specific runtime limits

Use the existing stage stale windows as conservative default child runtime limits, with explicit configuration only if the repository already exposes an appropriate runtime setting. The launcher records last verified liveness from immutable-epoch heartbeats and process state.

When a child exceeds its limit:

1. re-read complete claim history and process state;
2. send a graceful termination signal;
3. wait a bounded grace period, then force-terminate only that child if necessary;
4. reconcile the same allowed terminal shapes;
5. close/release only the exact still-owned epoch when no resumable work exists;
6. otherwise preserve a verified resume record;
7. apply bounded retry cooldown and surface the timeout.

A tick must not remain indefinitely blocked on one child.

### Workspace-local Ship refill

After every Ship child terminal reconciliation, rescan only that source workspace's Ship queue. If its single Ship slot is free, dispatch the next eligible card immediately. Refill stops at the existing drain, hop, cooldown, and safety limits. Other stages and workspaces continue independently.

### Health and doctor output

`health` and `doctor --json` add bounded, non-secret diagnostics:

- active child age and last verified heartbeat age;
- expired or unresponsive child;
- successful no-op count and latest affected issue;
- stranded claim count by classification;
- oldest actionable Ship card and wait age;
- Ship runner state and whether a workspace-local Ship slot is occupied;
- reconciliation or cleanup failures requiring attended action.

Process existence alone no longer makes a tick healthy when its state timestamp and child evidence are stale.

## Recovery Procedure

Recovery runs only after the repaired launcher and skills pass verification.

1. Run `claim-migration-status --json` without a concurrent migration command.
2. For `legacy-unowned`, use attended reset only with target `legacy`.
3. For `orphan-declaration`, use attended reset only with the exact declaration ID.
4. For `ambiguous`, inspect and correct or remove the exact malformed/conflicting Linear marker, then rerun status. Never guess.
5. Remove a machine-generated blocker only when its comment identifies this self-claim/no-op defect and current card gates are otherwise valid.
6. Do not clear genuine test, dependency, QA, approval, security, deploy, or human blockers. SAF-250 remains blocked until its recorded test gate is resolved.
7. Retry recovered cards through the normal launcher, then verify state, claim closure, merge/deploy evidence, and queue refill.

## Testing

Increment 1 tests cover:

- scheduled Ship accepts its exact open declaration;
- it rejects missing, mismatched, closed, malformed, and ambiguous declarations;
- canonical and mirrored Ship skills are identical;
- exit `0` with unchanged state and open owned claim becomes `successful-no-op`;
- reconciliation never closes or removes a newer/ambiguous claim;
- valid advanced, blocked, deferred, and resume outcomes remain accepted;
- compatibility reconciliation works when an older child writes no outcome record.

Increment 2 tests cover:

- graceful timeout, forced timeout after grace, and verified cleanup;
- live heartbeats prevent premature timeout within the configured bound;
- one expired child does not hold the whole tick indefinitely;
- Ship completion and blocking both trigger workspace-local refill;
- refill preserves one Ship child per source workspace;
- health/doctor expose stale child, no-op, stranded claim, and oldest Ship wait evidence.

The final gate runs focused tests, the complete test suite, skill byte-equality checks, `git diff --check`, `doctor --json`, and `claim-migration-status --json` with no competing diagnostic process.

## Rollout and Rollback

Ship correctness and no-op detection ship first. Runtime limits, refill, and health changes ship only after Increment 1 is live and claim migration is readable. Recovery begins last.

Rollback may disable new timeout/refill behavior, but must not revert immutable declaration ownership or reintroduce heartbeat-derived ownership. If reconciliation produces uncertain evidence, disable dispatch and preserve claims for attended inspection rather than widening cleanup authority.

## Success Criteria

- A launcher-owned Ship child can no longer reject its own exact declaration.
- No child exit `0` is accepted without observable, policy-valid progress.
- No tick waits forever for an expired child.
- A free workspace Ship slot refills without waiting for global delivery drain.
- Operators can identify why the oldest Ship card is waiting from one health report.
- Every repaired historical card has exact ownership evidence, and no genuine blocker is cleared.

---
name: ship-sweep
description: Merge + deploy the configured Linear project's human-approved "Ship" cards to production, canary-verify, then move to "Done". The only sweep that touches prod. Project-agnostic — reads .claude/linear-sweep.json. Runs single-runner (one designated host). Use when asked to "ship the Ship cards", "run the ship sweep", or on a schedule.
---

# Ship Sweep

Take cards a human has approved into **"Ship"** and land them: merge to `main`, deploy to production, canary-verify, and move to **"Done"** with evidence. This is the **only** sweep that merges and deploys — every card it touches was either smoke-tested green by qa-sweep (`qa:passed`) or marked by dev-sweep as `fast-path:eligible`, and explicitly moved to "Ship" by a person. If anything is off, it stops before or after deploy and flags a human; it never silently ships a broken change.

> **Runtime (Claude Code + Codex).** Cross-runtime skill — map its actions to your runtime's tools. On **Codex**, see `AGENTS.md` "Board sweeps" for the mapping (`shell`, `apply_patch`, `spawn_agent`/`wait_agent`, `update_plan`) and use your own commit attribution. On **Claude Code**, use the Skill tool + Task subagents. "Deploy" = `config.deploy`; "canary" = the `/canary` skill (or, on Codex, a post-deploy health check of the same URLs/endpoints).

## 0. Preflight (fail fast)

- **Load repo config.** Read `.claude/linear-sweep.json` (fields per spec-sweep §0). Missing file → exit with a one-line error. The production deploy path is `config.deploy` — read it before shipping.
- **Require `LINEAR_API_KEY`** (env or the repo's gitignored `.env`); confirm git push credentials and any credentials in `config.credentialsNote`.
- **Coding guardrail.** Before merge-review debugging or any code change/refactor needed during shipping, invoke `andrej-karpathy-skill` from the `andrej-karpathy-skills` plugin. If the skill is unavailable, apply its core checks manually: think before coding, keep the change simple, make surgical edits, and verify the goal before calling the work complete.
- **Single-runner check.** ship-sweep dispatch is pinned to one host (`shipRunner` in the launcher registry) so two machines can't merge + deploy the same card. If you were started by the launcher, it already gated this. If you're unsure you're the designated runner and another may be too, stop and say so — a double prod deploy is worse than a delayed one.
- **Child dependency preflight (mandatory).** In scheduled single-card mode, after startup and before the first material mutation, run:
  ```bash
  node "$AUTO_SWEEP_KIT_PATH/scripts/linear.mjs" dependency-status "$AUTO_SWEEP_ISSUE"
  ```
  Only the exact canonical `Done` state releases a blocker; Canceled, Duplicate, Archived, and every other state remain blocked. Handle the command by exit status: **Exit `0`:** continue. **Exit `3`:** comment the visible blocker identifiers/states, remove only this sweep's owned claim (`ship:in-progress`), and stop without material work. **Exit `2`:** report unreadable dependency data, remove only this sweep's owned claim (`ship:in-progress`), and stop. Never infer readiness from partial output.
- Team = `config.teamName` (`config.teamKey`); operate only within `config.project`. Repos: `config.repos`. Ensure labels exist; create if missing: `ship:in-progress`, `blocked:needs-user`, `sweep:manual-only`.
- **Repo/deploy scope is part of the ship gate.** Default expectation: one card ships one deployable repo. A multi-repo card may ship only when every touched repo is listed in `config.repos`, every implementation branch/PR is present, and `config.deploy` describes each production target and canary expectation. If QA/dev evidence points to an unconfigured sibling repo, do not merge the configured repo as a partial product ship; comment the mismatch and require a split card, a per-repo ship, or an updated multi-repo config/runbook.

## 1. Select cards (top-of-column order, drain queue, claimed)

List "Ship" cards **in `config.project`**, top-to-bottom as they appear in the Linear column. For each:
- **Skip** if `blocked:needs-user` or `sweep:manual-only` and no new human reply resolves it; **skip** if `ship:in-progress` < 120 min old (another run owns it — merge + deploy + canary is slow). Reclaim a stale claim.
- **Claim** with `ship:in-progress` before starting; remove it when you finish, block, or bail.
- Continue selecting and processing one actionable card at a time until no actionable "Ship" cards remain. This preserves one production deploy at a time without leaving approved cards waiting for a later run.
- After each terminal transition or card-specific block, re-list the queue before choosing the next card. If a card is blocked, it is no longer actionable; keep draining any remaining unblocked cards.
- After the queue first appears empty, re-list "Ship" once more before exiting. If new actionable cards appeared while you were shipping, continue the same one-at-a-time loop, then perform the final empty-queue recheck again.

## 2. Resume detection FIRST — key on the merge commit, not the branch

ship-sweep is the one **non-idempotent** sweep: it merges, then deletes the branch, then deploys. So "does the branch exist?" is destroyed mid-flight and **must not** be the resume key. Before treating a card as fresh work, look at what already happened, in this order:

1. **Is the `<PREFIX>-###` merge already on `main`?** (search `main` for the merge commit / check the PR's merged state, in every repo from `config.repos`).
2. **Is there an `[auto-sweep-deployed <ISO>]` marker comment** on the card?

Branch by what you find:

| Merge on `main`? | Deploy marker? | You are… | Do |
|---|---|---|---|
| No | — | **fresh work** | run the sanity gate below, then §3+ |
| Yes | No | **resuming after a crash post-merge** | do NOT re-merge — go straight to §5 (deploy), then §6–7 |
| Yes | Yes | **resuming the tail** | just run §6 canary (if not recorded) and §7 |

**Sanity gate (fresh path only).** Before merging, confirm: the `<PREFIX>-###` branch exists on origin for each configured repo the card claims to touch; either `qa:passed` is present OR (`fast-path:eligible` is present AND `config.fastPath.enabled !== false`); no live foreign `*:in-progress` claim remains on the card; the build/tests are green in reconstructed worktree(s); QA/dev evidence does not point to an unconfigured sibling repo; `config.deploy` covers every repo/production target being shipped; and — if `config.requireShipApproval` is true — the `ship:approved` label is present. **Any missing → comment exactly what's missing, add `blocked:needs-user`, remove `ship:in-progress`, leave the card in "Ship", and stop.** Do not merge a card that didn't actually pass QA or receive an enabled explicit fast-path marker, or (when required) wasn't explicitly approved.

## 3. Optional final security gate

If the card is security-labelled (per `config.reviewLenses`), run `/cso` on the merged diff before deploying. A P0/P1 finding blocks: comment it, add `blocked:needs-user`, keep the card in "Ship", stop.

## 4. Merge → cleanup

1. **Merge to `main`** (`--no-ff`), resolving against `origin/main` first (merge origin/main, rebuild, retest if needed).
2. **Push `main`** with the shared push discipline (fetch → rebase/merge origin/main → push; retry up to 2×; never force). Push **every** repo you merged.
3. **Only after the push lands**, clean up: delete the merged branch, `git worktree prune`, close/merge the PR. (Order matters — resume detection in §2 finds the merge commit on `main`, so the branch may safely be gone, but the push must have landed first.)

## 5. Deploy

1. **Deploy to production** via `config.deploy`. If a deploy step is manual/unavailable in this environment (e.g. `hs project upload`, a Vercel env var, a Supabase migration to apply), use the retry-safe prerequisite workflow below to create or reuse a `Todo` card for the human deploy step rather than leaving it ambiguous; treat the deploy as pending, release `ship:in-progress`, and stop.
2. **On a completed deploy, post `[auto-sweep-deployed <ISO8601 now>]` as a comment BEFORE touching status.** This is the idempotency marker §2 reads on resume — write it the moment the deploy lands, so a crash before §7 doesn't cause a re-deploy.

## 6. Canary + docs

- Run **`/canary`** (post-deploy health check) against the deployed feature's URLs/endpoints. Record the result on the card either way.
- Run **`/document-release`** to update user-facing docs for what shipped.

## 7. Terminal transition

- **Canary green:** move the card to the **bottom of "Done"** with a comment: which deploy path ran, the canary result, and the merge commit(s). Remove `ship:in-progress`. Prefer the repo helper (`node scripts/linear.mjs move-card-bottom <PREFIX-###> "Done"`) so the status and bottom rank update together.
- **Canary red (the change is already live):** **move the card to the bottom of "Done", add `blocked:needs-user`, and post a red comment** with the canary findings. Do **NOT** attempt an autonomous rollback (high-risk and deploy-target-specific — flag the human) and do **NOT** leave the card in "Ship" (it IS deployed; leaving it there invites a re-ship). "Done + blocked:needs-user" means *shipped, please verify.* Remove `ship:in-progress`.

### Retry-safe prerequisite blockers

When a prerequisite can be completed as its own issue, use only a `blockedBy` relation from the dependent to that blocker. Follow this exact mini-workflow so retries converge:

1. **Search for the stable audit marker** `[auto-sweep-dependency <dependent> blocked-by <blocker>]` and for an existing matching or orphaned blocker before creating anything.
2. **Create or reuse the blocker issue**; never create a duplicate when a matching issue already exists.
3. **Create the `blockedBy` relation only if it is absent.**
4. **Add the audit comment only if the stable marker is absent.**
5. **Re-read the relation**; once it exists, stop material work and remove only the dependent's owned `ship:in-progress` claim.

A separately completable blocker is relation-only: never add `blocked:needs-user` merely because a `blockedBy` relation exists. The launcher resumes the dependent only after every blocker reaches exact canonical `Done`. A direct human answer without its own issue retains the existing human-block label path (`blocked:needs-user`). Preserve the existing label gates for a failing sanity check, security finding, ambiguous decision, or red canary; those are human-review states, not mirrored dependency labels.

## Blocked / needs-user

If you need direct human review or an answer that is not its own completable task (a failing sanity gate, a security block, ambiguous intended behavior, or a red canary): comment the specifics, add `blocked:needs-user`, remove `ship:in-progress`, and leave the card where it is (Ship if not yet merged; Done if already deployed). Ask once; resume when they reply. A manual deploy step follows the relation-only prerequisite workflow above instead.

If the blocker is card-specific (for example, missing `qa:passed` on one card), re-list and continue draining other actionable cards. If the blocker is global to the run (for example, missing Linear auth, broken git push credentials, or an unavailable deploy path that would affect every remaining card), stop after releasing the current claim and recording the blocker.

## Machine-independence & handoff (auto-sweep)

Every card must be resumable on any machine — this run, the launcher, and any other machine coordinate ONLY through origin. ship-sweep is single-runner, but a crash still has to hand off cleanly.

- **Heartbeat while you hold a claim.** Roughly every 5 minutes that you own a card via `ship:in-progress`, post `[auto-sweep-heartbeat <ISO8601 now>]`. A claim idle past 120 min is treated as crashed and auto-released by the launcher — merge/deploy/canary is long, so heartbeat diligently.
- **The merge commit + the deploy marker are the truth, not the branch.** §2 reconstructs where you are from `main` (merge landed?) and the `[auto-sweep-deployed]` marker (deploy landed?), never from branch existence — because §4 deletes the branch mid-flight. Always push `main` before deleting the branch, and always write the deploy marker before moving to Done.
- **Push discipline (never force).** For every merge/push: `git fetch` → rebase/merge `origin/main` → push; retry up to 2× on non-fast-forward; if it still fails, comment and stop. Never force-push.
- **Re-read before the terminal move.** Right before moving to "Done", re-fetch the card. If a human moved it out of "Ship" while you worked, do NOT silently override — reconcile via §2 (if your merge/deploy already landed, still record the deploy + move to Done; otherwise comment and stop).

## Guardrails

- **Ships to production** — the highest-risk sweep. Only ever ship a card that is `qa:passed` or has `fast-path:eligible` while `config.fastPath.enabled !== false`, is green-building, has no live foreign in-progress claim, and a human moved to "Ship" (and, if `requireShipApproval`, carries `ship:approved`). When in doubt, `blocked:needs-user` and stop; never deploy a card that didn't pass QA or receive enabled fast-path eligibility.
- Never treat a docs/spec merge in the anchor repo as proof that sibling app code shipped. If implementation/QA evidence is in another repo, that repo must be configured and shipped, or the card must be split/manual-shipped with explicit audit comments.
- **Single-runner.** Never run two ship agents against the same card/repo concurrently; dispatch is pinned to one host.
- One card at a time, but keep draining until the actionable "Ship" queue is empty and a final re-list confirms it. Use top-of-column order, claim/release via `ship:in-progress`, and stay within `config.project`.
- No autonomous rollback — a red canary flags a human, it does not revert prod.
- Every question → a card comment (or a new Todo card for manual deploy steps); never AskUserQuestion.
- The card comments + the `[auto-sweep-deployed]` marker + canary result are the audit trail.

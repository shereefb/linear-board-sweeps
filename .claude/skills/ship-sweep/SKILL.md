---
name: ship-sweep
description: Merge + deploy the configured Linear project's human-approved "Ready to Ship" cards to production, canary-verify, then move to "Done". The only sweep that touches prod. Project-agnostic — reads .claude/linear-sweep.json. Runs single-runner (one designated host). Use when asked to "ship the ready-to-ship cards", "run the ship sweep", or on a schedule.
---

# Ship Sweep

Take cards a human has approved into **"Ready to Ship"** and land them: merge to `main`, deploy to production, canary-verify, and move to **"Done"** with evidence. This is the **only** sweep that merges and deploys — every card it touches was already smoke-tested green by qa-sweep (`qa:passed`) and explicitly moved to "Ready to Ship" by a person. If anything is off, it stops before or after deploy and flags a human; it never silently ships a broken change.

> **Runtime (Claude Code + Codex).** Cross-runtime skill — map its actions to your runtime's tools. On **Codex**, see `AGENTS.md` "Board sweeps" for the mapping (`shell`, `apply_patch`, `spawn_agent`/`wait_agent`, `update_plan`) and use your own commit attribution. On **Claude Code**, use the Skill tool + Task subagents. "Deploy" = `config.deploy`; "canary" = the `/canary` skill (or, on Codex, a post-deploy health check of the same URLs/endpoints).

## 0. Preflight (fail fast)

- **Load repo config.** Read `.claude/linear-sweep.json` (fields per spec-sweep §0). Missing file → exit with a one-line error. The production deploy path is `config.deploy` — read it before shipping.
- **Require `LINEAR_API_KEY`** (env or the repo's gitignored `.env`); confirm git push credentials and any credentials in `config.credentialsNote`.
- **Coding guardrail.** Before merge-review debugging or any code change/refactor needed during shipping, invoke `andrej-karpathy-skill` from the `andrej-karpathy-skills` plugin. If the skill is unavailable, apply its core checks manually: think before coding, keep the change simple, make surgical edits, and verify the goal before calling the work complete.
- **Single-runner check.** ship-sweep dispatch is pinned to one host (`shipRunner` in the launcher registry) so two machines can't merge + deploy the same card. If you were started by the launcher, it already gated this. If you're unsure you're the designated runner and another may be too, stop and say so — a double prod deploy is worse than a delayed one.
- Team = `config.teamName` (`config.teamKey`); operate only within `config.project`. Repos: `config.repos`. Ensure labels exist; create if missing: `ship:in-progress`, `blocked:needs-user`.

## 1. Select cards (top-of-column order, bounded, claimed)

List "Ready to Ship" cards **in `config.project`**, top-to-bottom as they appear in the Linear column. For each:
- **Skip** if `blocked:needs-user` and no new human reply resolves it; **skip** if `ship:in-progress` < 120 min old (another run owns it — merge + deploy + canary is slow). Reclaim a stale claim.
- **Claim** with `ship:in-progress` before starting; remove it when you finish, block, or bail.
- Process **at most 1 card per run** — one production deploy at a time. If none are actionable, exit cleanly (normal no-op).

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

**Sanity gate (fresh path only).** Before merging, confirm: the `<PREFIX>-###` branch exists on origin, `qa:passed` is present, the build/tests are green in a reconstructed worktree, and — if `config.requireShipApproval` is true — the `ship:approved` label is present. **Any missing → comment exactly what's missing, add `blocked:needs-user`, remove `ship:in-progress`, leave the card in "Ready to Ship", and stop.** Do not merge a card that didn't actually pass QA or (when required) wasn't explicitly approved.

## 3. Optional final security gate

If the card is security-labelled (per `config.reviewLenses`), run `/cso` on the merged diff before deploying. A P0/P1 finding blocks: comment it, add `blocked:needs-user`, keep the card in "Ready to Ship", stop.

## 4. Merge → cleanup

1. **Merge to `main`** (`--no-ff`), resolving against `origin/main` first (merge origin/main, rebuild, retest if needed).
2. **Push `main`** with the shared push discipline (fetch → rebase/merge origin/main → push; retry up to 2×; never force). Push **every** repo you merged.
3. **Only after the push lands**, clean up: delete the merged branch, `git worktree prune`, close/merge the PR. (Order matters — resume detection in §2 finds the merge commit on `main`, so the branch may safely be gone, but the push must have landed first.)

## 5. Deploy

1. **Deploy to production** via `config.deploy`. If a deploy step is manual/unavailable in this environment (e.g. `hs project upload`, a Vercel env var, a Supabase migration to apply), **create a `Todo` card** for the human deploy step rather than leaving it ambiguous — then treat the deploy as pending, not done.
2. **On a completed deploy, post `[auto-sweep-deployed <ISO8601 now>]` as a comment BEFORE touching status.** This is the idempotency marker §2 reads on resume — write it the moment the deploy lands, so a crash before §7 doesn't cause a re-deploy.

## 6. Canary + docs

- Run **`/canary`** (post-deploy health check) against the deployed feature's URLs/endpoints. Record the result on the card either way.
- Run **`/document-release`** to update user-facing docs for what shipped.

## 7. Terminal transition

- **Canary green:** move the card to the **bottom of "Done"** with a comment: which deploy path ran, the canary result, and the merge commit(s). Remove `ship:in-progress`. Prefer the repo helper (`node scripts/linear.mjs move-card-bottom <PREFIX-###> "Done"`) so the status and bottom rank update together.
- **Canary red (the change is already live):** **move the card to the bottom of "Done", add `blocked:needs-user`, and post a red comment** with the canary findings. Do **NOT** attempt an autonomous rollback (high-risk and deploy-target-specific — flag the human) and do **NOT** leave the card in "Ready to Ship" (it IS deployed; leaving it there invites a re-ship). "Done + blocked:needs-user" means *shipped, please verify.* Remove `ship:in-progress`.

## Blocked / needs-user

If you can't finish without the owner (a failing sanity gate, a security block, a manual deploy step you can't perform, ambiguous intended behavior): comment the specifics, add `blocked:needs-user`, remove `ship:in-progress`, and leave the card where it is (Ready to Ship if not yet merged; Done if already deployed). Ask once; resume when they reply.

## Machine-independence & handoff (auto-sweep)

Every card must be resumable on any machine — this run, the launcher, and any other machine coordinate ONLY through origin. ship-sweep is single-runner, but a crash still has to hand off cleanly.

- **Heartbeat while you hold a claim.** Roughly every 5 minutes that you own a card via `ship:in-progress`, post `[auto-sweep-heartbeat <ISO8601 now>]`. A claim idle past 120 min is treated as crashed and auto-released by the launcher — merge/deploy/canary is long, so heartbeat diligently.
- **The merge commit + the deploy marker are the truth, not the branch.** §2 reconstructs where you are from `main` (merge landed?) and the `[auto-sweep-deployed]` marker (deploy landed?), never from branch existence — because §4 deletes the branch mid-flight. Always push `main` before deleting the branch, and always write the deploy marker before moving to Done.
- **Push discipline (never force).** For every merge/push: `git fetch` → rebase/merge `origin/main` → push; retry up to 2× on non-fast-forward; if it still fails, comment and stop. Never force-push.
- **Re-read before the terminal move.** Right before moving to "Done", re-fetch the card. If a human moved it out of "Ready to Ship" while you worked, do NOT silently override — reconcile via §2 (if your merge/deploy already landed, still record the deploy + move to Done; otherwise comment and stop).

## Guardrails

- **Ships to production** — the highest-risk sweep. Only ever ship a card that is `qa:passed`, green-building, and a human moved to "Ready to Ship" (and, if `requireShipApproval`, carries `ship:approved`). When in doubt, `blocked:needs-user` and stop; never deploy a card that didn't pass QA.
- **Single-runner.** Never run two ship agents against the same card/repo concurrently; dispatch is pinned to one host.
- ≤1 card/run; top-of-column order; claim/release via `ship:in-progress`; stay within `config.project`.
- No autonomous rollback — a red canary flags a human, it does not revert prod.
- Every question → a card comment (or a new Todo card for manual deploy steps); never AskUserQuestion.
- The card comments + the `[auto-sweep-deployed]` marker + canary result are the audit trail.

---
name: qa-sweep
description: Smoke-test the configured Linear project's "In Review" cards as a real user, fix UX/UI bugs, attach screenshots + review notes, then merge → deploy → move to Done. Project-agnostic — reads .claude/linear-sweep.json. Use when asked to "QA the in-review cards", "run the QA sweep", or on a schedule.
---

# QA Sweep

Act as a user: exercise each "In Review" feature in a real dev environment, in as much detail as possible, confirm it works well, fix UX/UI bugs you find, then land it (merge → deploy → Done) with screenshots + a written review on the card.

**This sweep MERGES to `main` and DEPLOYS TO PRODUCTION.** It is far higher-risk than the docs-only spec sweep. It ships ONLY a feature that passed a real smoke test with a green build. If anything is off, it stops before merging and reports. Prefer running this attended, or at least review its card comments promptly; do not schedule it as aggressively as the spec sweep.

> **Runtime (Claude Code + Codex).** Cross-runtime skill — map its actions to your runtime's tools. On **Codex**, see `AGENTS.md` "Board sweeps" for the mapping (`shell`, `apply_patch`, `spawn_agent`/`wait_agent`, `update_plan`) and use your own commit attribution. On **Claude Code**, use the Skill tool + Task subagents. "Run the app" = your runtime's dev-server method (see §2.2).

## 0. Preflight (fail fast)

- **Load repo config.** Read `.claude/linear-sweep.json` (fields per spec-sweep §0). Missing file → exit with a one-line error. The production deploy path is `config.deploy` — read it before shipping.
- **Require `LINEAR_API_KEY`** (env or the repo's gitignored `.env`); confirm git push credentials and any credentials in `config.credentialsNote`.
- Confirm you can run the app. Use your runtime's dev-server method: **Claude Code** → the `preview_*` tools (never Bash for servers); **Codex** → start `npm run dev` via `shell` in the background and read its logs. Capture console/network/server output either way to catch errors.
- Team = `config.teamName` (`config.teamKey`); operate only within `config.project`. Repos: `config.repos`. Ensure labels exist; create if missing: `qa:in-progress`, `qa:needs-changes`, `blocked:needs-user`.

## 1. Select cards (oldest-first, bounded, claimed)

List "In Review" cards **in `config.project`**, oldest-first. For each:
- **Skip** if `blocked:needs-user` or `qa:needs-changes` and no new human reply resolves it; **skip** if `qa:in-progress` < 90 min old (another run owns it — QA is slow). Reclaim a stale claim.
- **Claim** with `qa:in-progress` before starting; remove it when you finish, block, or bail.
- Respect the 24h-rule: if the card's code/branch/worktree was created in the last 24h and looks actively in progress by a human, leave it — comment and skip.
- Process **at most 2 cards per run** (each is a full env + smoke test + deploy). If none are actionable, exit cleanly (normal no-op).

## 2. Per card — smoke test as a user

1. **Locate the work:** from the card + git, find the repo(s) from `config.repos`, branch, worktree, and/or PR for the feature. Read the card description + the linked spec/plan so you know the intended behavior.
2. **Stand up a dev environment:** check out the branch/worktree; start the app with the preview tooling. Seed data if the flow needs it.
3. **Exercise the feature as a user, in detail.** Walk the actual user flows the card adds — happy path AND the obvious edge cases. Click through, fill forms, trigger the states. Watch console + network + server logs for errors. Use subagents/parallel work for independent flows.
4. **Capture screenshots** of the key states (before/after, each important screen). Save them; you'll attach them to the card.
5. **Fix UX/UI bugs you find** — layout, copy, broken states, missing loading/empty/error handling, a11y basics. Commit fixes on the card's branch (stage selectively; `<PREFIX>-###` in the subject). Re-test after each fix.
6. **Update canonical docs** per `config.canonicalDocs` if the feature changed data shape or architecture and those docs are now stale.

## 3. Gate — only ship a green feature

Proceed to §4 ONLY if: the smoke test passes, the build is green (`npm run build` / tests / lint as applicable), and no unresolved errors remain. **Otherwise do NOT merge or deploy:** post your findings + screenshots to the card, add `qa:needs-changes`, remove `qa:in-progress`, leave the card in "In Review", and move on. If the blocker needs the owner, use `blocked:needs-user` and comment what's needed.

## 4. Land it (merge → cleanup → deploy)

Only after §3 passes:
1. **Merge to `main`** (`--no-ff`), resolving against `origin/main` first (merge origin/main, rebuild, retest if needed).
2. **Clean up** the card's local worktree, branch, and PR (delete the merged branch; remove the worktree; close/merge the PR).
3. **Sync `main` with `origin/main`** and push.
4. **Deploy to production** via `config.deploy`. Note in the card which deploy path ran. If a deploy step is manual/unavailable in this environment (e.g. `hs project upload`, a Vercel env var, a Supabase migration to apply), push the merge and **create a `Todo` card** for the human deploy step rather than leaving it ambiguous.

## 5. Finalize on the card

- **Attach the screenshots to the Linear card** (Linear file upload: `fileUpload` mutation → PUT the bytes to the returned signed URL with its headers → reference the asset URL as a markdown image in a comment / as an attachment).
- Post a **review write-up**: what you tested, what passed, bugs found + fixed (with commit refs), any residual risk, and which deploy ran.
- **Move the card to "Done"**; remove `qa:in-progress`.

## Blocked / needs-user

If you can't finish without the owner (ambiguous intended behavior, missing credentials/data, a product decision): comment the specifics, add `blocked:needs-user`, leave the card in "In Review", remove `qa:in-progress`. Ask once; resume when they reply.

## Guardrails

- **Ships to production** — only ever ship a feature that passed a real smoke test with a green build. When in doubt, `qa:needs-changes` and stop; never deploy a failing feature.
- ≤2 cards/run; oldest-first; claim/release via `qa:in-progress`; stay within `config.project`.
- Fix scope = UX/UI + obvious bugs found during QA. A feature that's fundamentally broken or half-built goes back with `qa:needs-changes`, not "fixed" into a rewrite.
- Every question → a card comment; never AskUserQuestion.
- The card comments + screenshots are the audit trail.

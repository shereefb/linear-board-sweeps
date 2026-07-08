---
name: dev-sweep
description: Develop the configured Linear project's "Ready for Dev" + "In Progress" cards on isolated worktrees, run code review, then move to "In Review" and push the branch (no merge). Project-agnostic — reads .claude/linear-sweep.json. Use when asked to "develop the ready-for-dev cards", "run the dev sweep", or on a schedule.
---

# Dev Sweep

Build features from cards that are "Ready for Dev" or "In Progress", one worktree per feature, with subagents/parallel work where it helps. Land each at "In Review" with a pushed branch and a clean code review — **never merge, never deploy** (that's the QA sweep's job). Your baseline expectation is an **excellent spec** to build from; if a card isn't that, bounce it.

> **Runtime (Claude Code + Codex).** Cross-runtime skill — map its actions to your runtime's tools. On **Codex**, see `AGENTS.md` "Board sweeps" for the mapping (`shell`, `apply_patch`, `spawn_agent`/`wait_agent`, `update_plan`), detect worktree/branch state with read-only git first, and use your own commit attribution. On **Claude Code**, use the Skill tool + Task subagents. The code-review pass = the `code-review` skill on the diff plus one independent code-reviewer subagent (Claude: `feature-dev:code-reviewer`; Codex: a `spawn_agent` reviewer).

## 0. Preflight (fail fast)

- **Load repo config.** Read `.claude/linear-sweep.json` (see spec-sweep §0 for fields). Missing file → exit with a one-line error.
- **Require `LINEAR_API_KEY`** (env or the repo's gitignored `.env`); confirm git push credentials and any credentials named in `config.credentialsNote`.
- Team = `config.teamName` (`config.teamKey`); operate only within `config.project`. Repos: `config.repos`. Ensure labels exist; create if missing: `dev:in-progress`, `blocked:needs-user`.

## 1. Select cards (oldest-first, bounded, claimed)

List "Ready for Dev" + "In Progress" cards **in `config.project`**, oldest-first. For each:
- **Read the comments FIRST.** A card can sit in "Ready for Dev" *after a review* with change requests — understand what's missing before writing code. For "In Progress" cards, respect the 24h rule: if there's a human's active worktree/branch from the last 24h, leave it (comment + skip).
- **Skip** if `blocked:needs-user` and no new human reply resolves it; **skip** if `dev:in-progress` < 90 min old (another run owns it). Reclaim a stale claim.
- **Spec-quality gate:** expect excellent specs. If a card is under-specified (no clear spec/plan, ambiguous acceptance, missing design decisions), **move it to "Needs Spec"** with a comment naming exactly what's under-specified, and leave it — do NOT develop from a weak spec. (The spec-sweep loop re-specs it.)
- **Claim** with `dev:in-progress` before starting; remove it when you finish, block, or bounce.
- Process **at most 2 cards per run**. If none are actionable, exit cleanly (normal no-op).

## 2. Per feature — build it

1. **Isolate on a worktree.** Create a git worktree off `main` (superpowers:using-git-worktrees), branch named with the `<PREFIX>-###` key, in the correct repo from `config.repos`. One worktree per card — features never share a tree.
2. **Develop against the spec + plan** (and any review-comment change requests). Use subagents / parallel work where the design decomposes cleanly; prefer TDD (superpowers:test-driven-development) for logic. Match existing code conventions.
3. **Update canonical docs** per `config.canonicalDocs`. If the feature changes data shape / subsystems and the config names architecture/schema docs, update them (marking not-yet-live as planned). For a single-repo project keep the architecture doc (e.g. `CLAUDE.md`) accurate.
4. **Code review — run BOTH.** Run `/code-review` (the code-review skill) on the diff AND the `code-reviewer` subagent (feature-dev:code-reviewer) for an independent pass. Fix every real finding until quality is genuinely great; re-review after fixes. Verify the build + tests are green (`npm run build`, `npm test`, `npm run lint` as applicable).

## 3. Land at "In Review" (no merge)

- Push the worktree's branch to `origin` (open/refresh a PR if that's the repo's convention). **Do NOT merge to `main`. Do NOT deploy.** Do NOT delete the worktree/branch — it's unmerged and awaiting the QA sweep / human review.
- Move the card to **"In Review"** with a comment: what was built, the spec/plan followed, code-review outcome (both passes) + notable fixes, the branch name, and any residual risk.
- Remove `dev:in-progress`.

## 4. Blocked / hand-offs

- **Needs the user to continue *development*** (a product decision, missing credential/asset, an API only they can provision): add `blocked:needs-user`, **keep the card in "Ready for Dev"**, comment exactly what's needed, and leave it. Resume when they reply. Ask once.
- **Needs the user to *deploy / ship*** (an env var, a prod migration, a third-party registration like `hs project upload`, an operator config — see `config.deploy`): don't block the dev — **create a new Linear card in status "Todo"** in `config.project` describing the ship prerequisite, link it to the feature card, and continue.

## Guardrails

- Writes **code** (not docs-only) but **never merges and never deploys** — "In Review" + a pushed branch is the human/QA gate.
- One worktree per card; ≤2 cards/run; oldest-first; claim/release via `dev:in-progress`; stay within `config.project`.
- Only build from excellent specs — a weak card goes to "Needs Spec", not into guesswork.
- Both code reviews must run and their real findings be fixed before "In Review".
- Every question → a card comment (or a new Todo card for ship needs); never AskUserQuestion.
- Card comments + the PR are the audit trail.

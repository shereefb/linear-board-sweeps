---
name: dev-sweep
description: Develop the configured Linear project's "Ready for Dev" cards on isolated worktrees, run code review, then move to "In Review" and push the branch (no merge). Project-agnostic — reads .claude/linear-sweep.json. Use when asked to "develop the ready-for-dev cards", "run the dev sweep", or on a schedule.
---

# Dev Sweep

Build features from "Ready for Dev" cards, one worktree per feature, with subagents/parallel work where it helps. Active development is represented by `Ready for Dev` plus the `dev:in-progress` claim label, not a separate board state. Land each at "In Review" with a pushed branch and a clean code review — **never merge, never deploy** (that's the QA sweep's job). Your baseline expectation is an **excellent spec** to build from; if a card isn't that, bounce it.

> **Runtime (Claude Code + Codex).** Cross-runtime skill — map its actions to your runtime's tools. On **Codex**, see `AGENTS.md` "Board sweeps" for the mapping (`shell`, `apply_patch`, `spawn_agent`/`wait_agent`, `update_plan`), detect worktree/branch state with read-only git first, and use your own commit attribution. On **Claude Code**, use the Skill tool + Task subagents. The code-review pass = the `code-review` skill on the diff plus one independent code-reviewer subagent (Claude: `feature-dev:code-reviewer`; Codex: a `spawn_agent` reviewer).

> **Reviewer runtime role.** If `.claude/linear-sweep.json` defines `runtimes.review`, prefer that runtime/model for independent reviewer subagents when your runtime supports explicit reviewer dispatch. If unsupported, run the reviewer in the current runtime and note that limitation in the Linear handoff. `review` is a role only, never a scheduled sweep.

## 0. Preflight (fail fast)

- **Load repo config.** Read `.claude/linear-sweep.json` (see spec-sweep §0 for fields). Missing file → exit with a one-line error.
- **Require `LINEAR_API_KEY`** (env or the repo's gitignored `.env`); confirm git push credentials and any credentials named in `config.credentialsNote`.
- **Coding guardrail.** Before writing, reviewing, debugging, refactoring, or otherwise changing code, invoke `andrej-karpathy-skill` from the `andrej-karpathy-skills` plugin. If the skill is unavailable, apply its core checks manually: think before coding, keep the change simple, make surgical edits, and verify the goal before calling the work complete.
- Team = `config.teamName` (`config.teamKey`); operate only within `config.project`. Repos: `config.repos`. Ensure labels exist; create if missing: `dev:in-progress`, `blocked:needs-user`.

## 1. Select cards (top-of-column order, bounded, claimed)

**Single-card auto-sweep mode.** If `AUTO_SWEEP_ISSUE` is set (or the unattended prompt names a single issue key), process only that issue and ignore every other Ready-for-Dev card. Treat an existing fresh `dev:in-progress` claim plus an `[auto-sweep-heartbeat ... owner=...]` comment as the launcher's pre-claim for this child, not as a competing run. Use `AUTO_SWEEP_WORKTREE`, `AUTO_SWEEP_LOG_DIR`, `AUTO_SWEEP_TMPDIR`, `AUTO_SWEEP_APP_PORT`, `AUTO_SWEEP_SCREENSHOT_DIR`, and `AUTO_SWEEP_BROWSER_PROFILE_DIR` when present instead of inventing local paths or ports.

List "Ready for Dev" cards **in `config.project`**, top-to-bottom as they appear in the Linear column. For each:
- **Read the comments FIRST.** A card can sit in "Ready for Dev" *after a review* with change requests — understand what's missing before writing code. Respect the 24h rule: if there's a human's active worktree/branch from the last 24h, leave it (comment + skip).
- **Skip** if `blocked:needs-user` and no new human reply resolves it; **skip** if `dev:in-progress` < 90 min old (another run owns it). Reclaim a stale claim.
- **Spec-quality gate:** expect excellent specs. If a card is under-specified (no clear spec/plan, ambiguous acceptance, missing design decisions), **move it to the bottom of "Needs Spec"** with a comment naming exactly what's under-specified, and leave it — do NOT develop from a weak spec. Prefer the repo helper (`node scripts/linear.mjs move-card-bottom <PREFIX-###> "Needs Spec"`) so the status and bottom rank update together. (The spec-sweep loop re-specs it.)
- **Claim** with `dev:in-progress` before starting; remove it when you finish, block, or bounce.
- **Label the card if it's bare** (generate-if-missing): if `config.reviewLenses` is set and the card carries none of its domain labels, classify it from the spec/plan + diff surface and apply the matching domain labels to Linear (comment what you applied). This drives the gated quality lenses in §2. A human relabel always wins — never override one.
- Process **at most 2 cards per run**. If none are actionable, exit cleanly (normal no-op).

## 2. Per feature — build it

1. **Isolate on a worktree.** Create a git worktree off `main` (superpowers:using-git-worktrees), branch named with the `<PREFIX>-###` key, in the correct repo from `config.repos`. One worktree per card — features never share a tree.
2. **Develop against the spec + plan** (and any review-comment change requests). Use subagents / parallel work where the design decomposes cleanly; prefer TDD (superpowers:test-driven-development) for logic. Match existing code conventions. **For a frontend card, run a design pass (`/frontend-design` or a taste pass like `/design-taste-frontend`) as you build** — raise the visual floor here so qa-sweep isn't the first design feedback.
3. **Update canonical docs** per `config.canonicalDocs`. If the feature changes data shape / subsystems and the config names architecture/schema docs, update them (marking not-yet-live as planned). For a single-repo project keep the architecture doc (e.g. `CLAUDE.md`) accurate.
4. **Gated quality lenses (by card type).** In addition to the always-on code review below: a **security-sensitive card** (auth / data / external input) → `/cso` on the actual diff (the plan-review caught design flaws; this catches implementation flaws). A **perf-sensitive card** → `/benchmark` in the worktree before landing. Fold findings in.
5. **Code review — run BOTH.** Run `/code-review` (the code-review skill) on the diff AND the `code-reviewer` subagent (feature-dev:code-reviewer) for an independent pass. Fix every real finding until quality is genuinely great; re-review after fixes.
6. **Verify green — observed, not asserted.** Confirm the build + tests are green (`npm run build`, `npm test`, `npm run lint` as applicable), and use the `verify` skill to exercise the change end-to-end so "it works" is something you watched happen, not a claim.
7. **Optional fast-path eligibility.** Fast path is enabled by default; skip this evaluation only when `config.fastPath.enabled === false`. When enabled, evaluate it only after implementation, verification, code review, and independent review are complete. Add `fast-path:eligible` and an `[auto-sweep-fast-path <KEY>]` audit comment only when all configured gates pass: diff size under `maxChangedFiles` and `maxDiffLines`, no `disallowedLabels`, only allowed low-risk labels when `allowedLabels` is set, no data/schema/auth/external-input/deploy/API/CLI/SDK/UI/perf surface, all checks green, no unresolved review findings, and the independent reviewer explicitly says high confidence. If any gate fails, do not add the label; include the reason in the normal In Review handoff. The card still lands in **In Review** — a human may then move it directly to Ready to Ship to skip QA Passed.

## 3. Land at "In Review" (no merge)

- Push the worktree's branch to `origin` (open/refresh a PR if that's the repo's convention). **Do NOT merge to `main`. Do NOT deploy.** Do NOT delete the worktree/branch — it's unmerged and awaiting the QA sweep / human review.
- Move the card to the **bottom of "In Review"** with a comment: what was built, the spec/plan followed, code-review outcome (both passes) + notable fixes, the branch name, fast-path eligibility/ineligibility if evaluated, and any residual risk. Prefer the repo helper (`node scripts/linear.mjs move-card-bottom <PREFIX-###> "In Review"`) so the status and bottom rank update together.
- Remove `dev:in-progress`.

## 4. Blocked / hand-offs

- **Needs the user to continue *development*** (a product decision, missing credential/asset, an API only they can provision): add `blocked:needs-user`, **keep the card in "Ready for Dev"**, comment exactly what's needed, and leave it. Resume when they reply. Ask once.
- **Needs a human-only action you can't perform** (an env var / secret set in the hosting dashboard, a prod migration, a DNS record, a webhook registered in a third-party console, an OAuth app connected, a billing/plan approval, any platform deploy step you can't trigger — see `config.deploy` and the `Todo` lane in the board rules): don't block the dev — **create a new Linear card in status "Todo"** in `config.project` stating *what* to do, *where* (which dashboard/console), and *why* (which feature it unblocks); link it to the feature card, and continue. If the agent could do it itself, do it — don't make a `Todo`.

## Machine-independence & handoff (auto-sweep)

Every card must be resumable on any machine — this run, the auto-sweep launcher, and any other machine coordinate ONLY through origin. Follow these whether a human or the launcher started you.

- **Heartbeat while you hold a claim.** Roughly every 5 minutes that you own a card via `dev:in-progress`, post a comment `[auto-sweep-heartbeat <ISO8601 now>]`. A claim with no heartbeat past its stale threshold is treated as crashed and auto-released by the launcher — a long, quiet run that skips heartbeats can be reaped out from under you.
- **Origin holds everything at rest.** Before you change a card's status OR leave it blocked, ensure all its artifacts are committed and pushed in **every repo you touched** (`config.repos`). Uncommitted work in a local worktree is allowed only while you are actively building.
- **Checkpoint WIP.** Commit + push the branch at natural checkpoints (after the build first goes green, before code review), not only at the end, so a crash strands as little as possible.
- **Push discipline (never force).** For every push: `git fetch` → rebase your commits onto the updated remote ref → push; on a non-fast-forward rejection retry up to 2×; if it still fails, comment what happened on the card and stop. Never force-push.
- **Worktrees are disposable; the branch is the truth.** `<PREFIX>-###` is deterministic from the card id. Picking up a card, in each relevant repo: `git fetch`; if `origin/<PREFIX>-###` exists and no local worktree does, rebuild it at `<repo>/.worktrees/<PREFIX>-###`; if a local worktree already exists (a prior crashed run, possibly dirty), `git reset --hard origin/<PREFIX>-###` before working. Prune worktrees whose remote branch is gone (`git worktree prune`).
- **Re-read before the terminal move.** Right before moving the card to "In Review", re-fetch it. If a human (or another run) moved it out of "Ready for Dev", do NOT override — comment what you built + the branch name, release `dev:in-progress`, and stop.
- **Mark backward bounces.** When you send a card back to "Needs Spec", add a comment `[auto-sweep-bounce Ready for Dev→Needs Spec]`. Two backward bounces within 48h and the launcher parks the card with `blocked:needs-user` — so bounce only on a real spec-quality gate, and say exactly what's missing.

## Guardrails

- Writes **code** (not docs-only) but **never merges and never deploys** — "In Review" + a pushed branch is the human/QA gate.
- One worktree per card; ≤2 cards/run; top-of-column order; claim/release via `dev:in-progress`; stay within `config.project`.
- Only build from excellent specs — a weak card goes to "Needs Spec", not into guesswork.
- Both code reviews must run and their real findings be fixed before "In Review".
- Every question → a card comment (or a new Todo card for ship needs); never AskUserQuestion.
- Card comments + the PR are the audit trail.

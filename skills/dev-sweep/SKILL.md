---
name: dev-sweep
description: Develop the configured Linear project's "Dev" cards on isolated worktrees, run code review, then move to "QA" and push the branch (no merge). Project-agnostic — reads .claude/linear-sweep.json. Use when asked to "develop the Dev cards", "run the dev sweep", or on a schedule.
---

# Dev Sweep

Build features from "Dev" cards, one worktree per feature, with subagents/parallel work where it helps. Active development is represented by `Dev` plus the `dev:in-progress` claim label, not a separate board state. Land each at "QA" with a pushed branch and a clean code review — **never merge, never deploy** (that's the QA sweep's job). Your baseline expectation is an **excellent spec** to build from; if a card isn't that, bounce it.

> **Runtime (Claude Code + Codex).** Cross-runtime skill — map its actions to your runtime's tools. On **Codex**, see `AGENTS.md` "Board sweeps" for the mapping (`shell`, `apply_patch`, `spawn_agent`/`wait_agent`, `update_plan`), detect worktree/branch state with read-only git first, and use your own commit attribution. On **Claude Code**, use the Skill tool + Task subagents. The code-review pass = the `code-review` skill on the diff plus one independent code-reviewer subagent (Claude: `feature-dev:code-reviewer`; Codex: a `spawn_agent` reviewer).

> **Reviewer runtime role.** If `.claude/linear-sweep.json` defines `runtimes.review`, prefer that runtime/model for independent reviewer subagents when your runtime supports explicit reviewer dispatch. If unsupported, run the reviewer in the current runtime and note that limitation in the Linear handoff. `review` is a role only, never a scheduled sweep.

## 0. Preflight (fail fast)

### Direct manual handoff

When `MANUAL_SWEEP_STAGE=dev`, process only `MANUAL_SWEEP_ISSUE` when its state equals `MANUAL_SWEEP_EXPECTED_STATE`; validate route, dependencies, and no foreign claim before claiming it, write/reuse `[manual-sweep-handoff dev <id>]`, heartbeat, and release only that claim. This is the sole exception to the normal `sweep:manual-only` skip and never applies to scheduled runs. For `manual-sweep:fast-track-requested`, preserve every eligibility gate but bypass only size and allowed-label checks; factory-learning, disabled fast path, material risk, failed checks/reviews/lenses deny and remove stale eligibility.

- **Load workspace config.** In scheduled mode, read `$AUTO_SWEEP_ANCHOR/.claude/linear-sweep.json`; otherwise read `.claude/linear-sweep.json` from the current repo root (see spec-sweep §0 for fields). The routed primary repo may be a sibling and is not required to carry a duplicate config. Missing file → exit with a one-line error.
- **Require `LINEAR_API_KEY`** (env or the repo's gitignored `.env`); confirm git push credentials and any credentials named in `config.credentialsNote`.
- **Coding guardrail.** Before writing, reviewing, debugging, refactoring, or otherwise changing code, invoke `andrej-karpathy-skill` from the `andrej-karpathy-skills` plugin. If the skill is unavailable, apply its core checks manually: think before coding, keep the change simple, make surgical edits, and verify the goal before calling the work complete.
- **Child repository preflight (mandatory when routed).** In scheduled single-card mode, when `AUTO_SWEEP_REPO_LABEL` is set, run `node "$AUTO_SWEEP_KIT_PATH/scripts/linear.mjs" repo-status "$AUTO_SWEEP_ISSUE" "$AUTO_SWEEP_REPO_LABEL" "$AUTO_SWEEP_REPO_ENTRY"` immediately after startup and before the dependency check, claim, worktree mutation, merge, deploy, or any other material work. **Exit `0`:** continue. **Exit `3`:** the live app label is missing, ambiguous, or changed; comment the returned route evidence, remove only this sweep's owned claim if present, and stop. **Exit `2`:** routing is unreadable or misconfigured; report it, remove only this sweep's owned claim if present, and stop. Never add `blocked:needs-user` for this machine-checkable routing failure; the launcher's self-clearing routing Todo owns the retry signal.
- **Child dependency preflight (mandatory).** In scheduled single-card mode, after startup and before the first material mutation, run:
  ```bash
  node "$AUTO_SWEEP_KIT_PATH/scripts/linear.mjs" dependency-status "$AUTO_SWEEP_ISSUE"
  ```
  Only the exact canonical `Done` state releases a blocker; Canceled, Duplicate, Archived, and every other state remain blocked. Handle the command by exit status: **Exit `0`:** continue. **Exit `3`:** comment the visible blocker identifiers/states, remove only this sweep's owned claim (`dev:in-progress`), and stop without material work. **Exit `2`:** report unreadable dependency data, remove only this sweep's owned claim (`dev:in-progress`), and stop. Never infer readiness from partial output.
- Team = `config.teamName` (`config.teamKey`); operate only within `config.project`. Repos: `config.repos`. Ensure labels exist; create if missing: `dev:in-progress`, `blocked:needs-user`, `sweep:manual-only`.
- **Scheduled primary repo:** when `AUTO_SWEEP_REPO` is set, it is the launcher's label-routed managed repository for this card; `AUTO_SWEEP_SOURCE_REPO` is its source checkout. Treat that repo as primary and put the card worktree at `AUTO_SWEEP_WORKTREE`. Other entries in `config.repos` remain available only for plan-approved multi-repo scope; never switch primary ownership implicitly.

## 1. Select cards (top-of-column order, bounded, claimed)

**Single-card auto-sweep mode.** If `AUTO_SWEEP_ISSUE` is set (or the unattended prompt names a single issue key), process only that issue and ignore every other Dev card. Treat an existing fresh `dev:in-progress` claim plus an `[auto-sweep-heartbeat ... owner=...]` comment as the launcher's pre-claim for this child, not as a competing run. Use `AUTO_SWEEP_WORKTREE`, `AUTO_SWEEP_LOG_DIR`, `AUTO_SWEEP_TMPDIR`, `AUTO_SWEEP_APP_PORT`, `AUTO_SWEEP_SCREENSHOT_DIR`, and `AUTO_SWEEP_BROWSER_PROFILE_DIR` when present instead of inventing local paths or ports. Store screenshots, generated evidence, browser profiles, and scratch files under those env paths, never in repo roots.

List "Dev" cards **in `config.project`**, top-to-bottom as they appear in the Linear column. For each:
- **Read the comments FIRST.** A card can sit in "Dev" *after a review* with change requests — understand what's missing before writing code. Respect the 24h rule: if there's a human's active worktree/branch from the last 24h, leave it (comment + skip).
- **Skip** if `blocked:needs-user` or `sweep:manual-only` and no new human reply resolves it; **skip** if `dev:in-progress` < 90 min old (another run owns it). Reclaim a stale claim.
- **Spec-quality gate:** expect excellent specs. If a card is under-specified (no clear spec/plan, ambiguous acceptance, missing design decisions), **move it to the bottom of "Spec"** with a comment naming exactly what's under-specified, and leave it — do NOT develop from a weak spec. Prefer the repo helper (`node scripts/linear.mjs move-card-bottom <PREFIX-###> "Spec"`) so the status and bottom rank update together. (The spec-sweep loop re-specs it.)
- **Repo-scope gate:** before coding, confirm the plan's repo scope is a subset of `config.repos`. Default to one deployable repo per card. If the plan or comments require a sibling repo that is not configured, bounce to "Spec" or block with `blocked:needs-user` and state the exact split/config needed. If it is a true configured multi-repo card, every touched repo must get a branch/PR, verification evidence, and ship/deploy note in the handoff.
- **Manual/dedicated-work gate:** if a "Dev" card is intentionally ongoing human work, batch documentation enrichment, or otherwise does not fit the unattended feature-dev worktree/PR cycle, add `sweep:manual-only`, comment exactly why it is parked and what manual/dedicated path should continue it, and stop considering it actionable until a human clears the label with unblock-sweep. Do not leave it unlabeled in "Dev" after a no-op pass; that creates an infinite scheduled dispatch loop.
- **Claim** with `dev:in-progress` before starting; remove it when you finish, block, or bounce.
- **Label the card if it's bare** (generate-if-missing): if `config.reviewLenses` is set and the card carries none of its domain labels, classify it from the spec/plan + diff surface and apply the matching domain labels to Linear (comment what you applied). This drives the gated quality lenses in §2. A human relabel always wins — never override one.
- Process **at most 2 cards per run**. If none are actionable, exit cleanly (normal no-op).

## 2. Per feature — build it

1. **Isolate on a worktree.** Create a git worktree off `main` (superpowers:using-git-worktrees), branch named with the `<PREFIX>-###` key, in the correct repo from `config.repos`. One worktree per card — features never share a tree.
2. **Develop against the spec + plan** (and any review-comment change requests). Use subagents / parallel work where the design decomposes cleanly; prefer TDD (superpowers:test-driven-development) for logic. Match existing code conventions. **For a frontend card, run a design pass (`/frontend-design` or a taste pass like `/design-taste-frontend`) as you build** — raise the visual floor here so qa-sweep isn't the first design feedback.
3. **Update canonical docs** per `config.canonicalDocs`. If the feature changes data shape / subsystems and the config names architecture/schema docs, update them (marking not-yet-live as planned). For a single-repo project keep the architecture doc (e.g. `CLAUDE.md`) accurate.
4. **Gated quality lenses (by card type).** In addition to the always-on code review below: a **security-sensitive card** (auth / data / external input) → `/cso` on the actual diff (the plan-review caught design flaws; this catches implementation flaws). A **perf-sensitive card** → `/benchmark` in the worktree before landing. Fold findings in.
5. **Execute required performance proofs.** For `performance-contract/v1 — required`, first reuse the `Versioned contract boundary: versioned-contract-boundary/v1` decision from the plan; never create a contract-specific history interpretation in Dev. If its artifact/marker history is missing or incomparable, fail closed and return the card to Spec. Then map every `P` ID to the diff and run its proof through `/benchmark`. Record the tested commit SHA, `P` ID, command/fixture, bounded output or result location, relevant environment or assumptions, and proof kind. For `measured`, also record warm-up/repetitions, baseline, candidate, statistic, threshold, and result. For `deterministic-bound`, record declared bound, assertion command/fixture, observed maximum or result, and pass/fail. After pushing the tested commit, include every `P` ID, proof kind, and result in the Linear QA handoff. Fix implementation misses in Dev; a material missing budget, invalid fixture, or contract defect emits `review/performance` and bounces to Spec as `missing-design`.
6. **Code review — run BOTH.** Run `/code-review` (the code-review skill) on the diff AND the `code-reviewer` subagent (feature-dev:code-reviewer) for an independent pass. Fix every real finding until quality is genuinely great; re-review after fixes.
7. **Verify green — observed, not asserted.** Confirm the build + tests are green (`npm run build`, `npm test`, `npm run lint` as applicable), and use the `verify` skill to exercise the change end-to-end so "it works" is something you watched happen, not a claim.
8. **Optional fast-path candidacy.** A card carrying `factory:learning-generated` is unconditionally ineligible for the fast path: remove/ignore any stale `fast-path:eligible` label and require the normal QA → Signoff path. For all other cards, fast path is enabled by default when `config.fastPath.enabled` is omitted. If it is present but is not a boolean, malformed `fastPath.enabled` must fail closed: do not evaluate candidacy and do not add `fast-path:eligible`. Skip evaluation when it is exactly `false`. When it is exactly `true` or omitted, evaluate candidacy only after implementation, verification, code review, and independent review are complete. The candidate gates are: diff size under `maxChangedFiles` and `maxDiffLines`, no `disallowedLabels`, only allowed low-risk labels when `allowedLabels` is set, no data/schema/auth/external-input/deploy/API/CLI/SDK/UI/perf surface, all checks green, no unresolved review findings, and the independent reviewer explicitly says high confidence. Record the result for §3, but do not add `fast-path:eligible` or its audit marker yet. If any gate fails, include the reason in the normal QA handoff. Every successful card still lands in **QA** for full QA.

## 3. Land at "QA" (no merge)

- Push the worktree's branch to `origin` (open/refresh a PR if that's the repo's convention). For a fast-path candidate, only after that push succeeds: fetch origin, resolve the branch's full origin SHA, and prove it is the exact final commit that received both reviews. Then add `fast-path:eligible` and post `[auto-sweep-fast-path <KEY> head=<full-git-sha>]`. If the full origin SHA or reviewed-final-commit match cannot be proven, do not add the label or marker and record that denial in the QA handoff. **Do NOT merge to `main`. Do NOT deploy.** Do NOT delete the worktree/branch — it's unmerged and awaiting the QA sweep / human review.
- Move the card to the **bottom of "QA"** with a comment: what was built, the spec/plan followed, code-review outcome (both passes) + notable fixes, the branch name, fast-path eligibility/ineligibility if evaluated, and any residual risk. Prefer the repo helper (`node scripts/linear.mjs move-card-bottom <PREFIX-###> "QA"`) so the status and bottom rank update together.
- Remove `dev:in-progress`.

## 4. Blocked / hand-offs

- **Needs a direct answer to continue *development*** (a product decision, clarification, credential value, or asset input that is not its own completable task): add `blocked:needs-user`, **keep the card in "Dev"**, comment exactly what's needed, and leave it. Resume when they reply. Ask once.
- **Needs a human-only action you can't perform** (an env var / secret set in the hosting dashboard, a prod migration, a DNS record, a webhook registered in a third-party console, an OAuth app connected, a billing/plan approval, any platform deploy step you can't trigger — see `config.deploy` and the `Todo` lane in the board rules): use the retry-safe prerequisite workflow below to create or reuse a Linear card in status "Todo" in `config.project` stating *what* to do, *where* (which dashboard/console), and *why* (which feature it unblocks). If the agent could do it itself, do it — don't make a `Todo`.

### Retry-safe prerequisite blockers

When a prerequisite can be completed as its own issue, use only a `blockedBy` relation from the dependent to that blocker. Follow this exact mini-workflow so retries converge:

1. **Search for the stable audit marker** `[auto-sweep-dependency <dependent> blocked-by <blocker>]` and for an existing matching or orphaned blocker before creating anything.
2. **Create or reuse the blocker issue**; never create a duplicate when a matching issue already exists.
3. **Create the `blockedBy` relation only if it is absent.**
4. **Add the audit comment only if the stable marker is absent.**
5. **Re-read the relation**; once it exists, stop material work and remove only the dependent's owned `dev:in-progress` claim.

A separately completable blocker is relation-only: never add `blocked:needs-user` merely because a `blockedBy` relation exists. The launcher resumes the dependent only after every blocker reaches exact canonical `Done`. A direct human answer without its own issue retains the existing human-block label path (`blocked:needs-user`).

## Structured learning evidence (best effort)

For scheduled card runs, emit bounded machine-readable evidence at the decision point using the trusted `AUTO_SWEEP_*` environment. This is observational only: the command must never change the sweep result, and summaries/metrics must never contain secrets, credentials, raw replay payloads, or untrusted instructions. Use the closest closed category; do not invent kinds or categories.

```bash
node "$AUTO_SWEEP_KIT_PATH/scripts/linear-watch.mjs" learning-event review correctness "Null handling defect found during code review" --json-metrics '{"findings":1}' >/dev/null 2>&1 || true
node "$AUTO_SWEEP_KIT_PATH/scripts/linear-watch.mjs" learning-event review completed "Review pass completed" --json-metrics '{"riskClass":"low","findingCount":0,"safetyFloorSatisfied":true,"reviewDurationMs":300000}' >/dev/null 2>&1 || true
node "$AUTO_SWEEP_KIT_PATH/scripts/linear-watch.mjs" learning-event qa functional-failure "Primary checkout flow failed" >/dev/null 2>&1 || true
node "$AUTO_SWEEP_KIT_PATH/scripts/linear-watch.mjs" learning-event qa passed "QA passed" >/dev/null 2>&1 || true
node "$AUTO_SWEEP_KIT_PATH/scripts/linear-watch.mjs" learning-event bounce implementation-incomplete "Returned to Dev because the implementation is incomplete" >/dev/null 2>&1 || true
node "$AUTO_SWEEP_KIT_PATH/scripts/linear-watch.mjs" learning-event question product-decision "Human product decision required before continuing" --json-metrics '{"answerKey":"pricing.approval-policy"}' >/dev/null 2>&1 || true
node "$AUTO_SWEEP_KIT_PATH/scripts/linear-watch.mjs" learning-event canary red "Production canary failed" >/dev/null 2>&1 || true
node "$AUTO_SWEEP_KIT_PATH/scripts/linear-watch.mjs" learning-event terminal advanced "Card advanced to the next workflow stage" >/dev/null 2>&1 || true
```

Emit:

- each material review finding as `review` (`correctness`, `security`, `error-handling`, `test-gap`, `scope-gap`, `performance`, or `design`);
- exactly one measured `review completed` event after a review pass when risk class, finding count, safety-floor result, and duration are known;
- each QA failure as `qa` (`environment-start`, `functional-failure`, `console-error`, `network-error`, `accessibility`, `visual`, or `build`);
- exactly one `qa passed` event for a successful QA pass, so rework-rate evidence has a denominator;
- each backward workflow return as `bounce` (`missing-acceptance`, `missing-design`, `missing-repo-scope`, or `implementation-incomplete`);
- each direct human dependency as `question` (`config`, `credential`, `product-decision`, `asset`, or `deploy`) with a stable bounded `metrics.answerKey` or `metrics.policyKey` naming the exact reusable policy/config decision; never use the broad category as the key;
- each red production canary as `canary red`;
- exactly one terminal event before releasing the claim: `terminal advanced`, `terminal blocked`, or `terminal failed`.

## Machine-independence & handoff (auto-sweep)

Every card must be resumable on any machine — this run, the auto-sweep launcher, and any other machine coordinate ONLY through origin. Follow these whether a human or the launcher started you.

- **Heartbeat while you hold a claim.** Roughly every 5 minutes that you own a card via `dev:in-progress`, post a comment `[auto-sweep-heartbeat <ISO8601 now>]`. A claim with no heartbeat past its stale threshold is treated as crashed and auto-released by the launcher — a long, quiet run that skips heartbeats can be reaped out from under you.
- **Origin holds everything at rest.** Before you change a card's status OR leave it blocked, ensure all its artifacts are committed and pushed in **every repo you touched** (`config.repos`). Uncommitted work in a local worktree is allowed only while you are actively building.
- **Checkpoint WIP.** Commit + push the branch at natural checkpoints (after the build first goes green, before code review), not only at the end, so a crash strands as little as possible.
- **Push discipline (never force).** For every push: `git fetch` → rebase your commits onto the updated remote ref → push; on a non-fast-forward rejection retry up to 2×; if it still fails, comment what happened on the card and stop. Never force-push.
- **Preserve worktrees with local WIP.** `<PREFIX>-###` is deterministic from the card id. A clean worktree may be rebuilt from `origin/<PREFIX>-###`; a dirty existing card worktree is preserved exactly as found. Never reset, checkout, restore, clean, stash, auto-commit, prune, or remove it. The launcher retains its matching claim and resumes the same worktree only through its exact local resume record.
- **Re-read before the terminal move.** Right before moving the card to "QA", re-fetch it. If a human (or another run) moved it out of "Dev", do NOT override — comment what you built + the branch name, release `dev:in-progress`, and stop.
- **Mark backward bounces.** When you send a card back to "Spec", add a comment `[auto-sweep-bounce Dev→Spec]`. Two backward bounces within 48h and the launcher parks the card with `blocked:needs-user` — so bounce only on a real spec-quality gate, and say exactly what's missing.

## Guardrails

- Writes **code** (not docs-only) but **never merges and never deploys** — "QA" + a pushed branch is the human/QA gate.
- One worktree per card; ≤2 cards/run; top-of-column order; claim/release via `dev:in-progress`; stay within `config.project`.
- Keep repo and deploy scope honest: do not produce a branch in an unconfigured sibling repo unless the card has first been split or the config/runbook explicitly includes that repo.
- Only build from excellent specs — a weak card goes to "Spec", not into guesswork.
- Both code reviews must run and their real findings be fixed before "QA".
- Every question → a card comment (or a new Todo card for ship needs); never AskUserQuestion.
- Card comments + the PR are the audit trail.

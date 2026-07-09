---
name: spec-sweep
description: Autonomously develop specs + implementation plans for the configured Linear project's "Spec" cards and move them to "Dev". Project-agnostic — reads .claude/linear-sweep.json for the team/project/prefix. Runs unattended (e.g. hourly cron) or on demand. Use when asked to "spec the Spec cards", "run the spec sweep", or on a schedule.
---

# Spec Sweep

Autonomously turn this repo's Linear "Spec" cards into review-hardened specs + implementation plans and advance them to "Dev". Designed to run **unattended on a schedule** — assume no human is watching. Never block waiting for input; route all questions to card comments. **Touch only spec/plan/design docs — never write app code, run migrations, or deploy.**

> **Runtime (Claude Code + Codex).** This skill speaks in *actions*; map them to your runtime's tools. On **Codex**, see the "Board sweeps" section of `AGENTS.md` for the tool mapping (`shell`, `apply_patch`, `spawn_agent`/`wait_agent`, `update_plan`) and use your own commit attribution. On **Claude Code**, use the Skill tool for named skills and Task for subagents. Referenced helper skills (`brainstorming`, `plan-eng-review`, `code-review`, `test-driven-development`, `using-git-worktrees`) load natively on both when installed.

> **Reviewer runtime role.** If `.claude/linear-sweep.json` defines `runtimes.review`, prefer that runtime/model for independent reviewer subagents when your runtime supports explicit reviewer dispatch. If unsupported, run the reviewer in the current runtime and note that limitation in the Linear handoff. `review` is a role only, never a scheduled sweep.

> **Karpathy planning guardrail.** Spec-sweep stays docs-only. When a spec or plan reasons about future code changes, use `andrej-karpathy-skill` from the `andrej-karpathy-skills` plugin if available; if unavailable, apply its core checks manually: think first, keep the plan simple, keep future edits surgical, and define concrete verification.

## 0. Preflight (fail fast, cleanly)

- **Load repo config.** Read `.claude/linear-sweep.json` from the repo root. It provides `teamName`, `teamKey`, `project`, `projectId`, `issuePrefix`, `repos`, `specsDir`, `plansDir`, `canonicalDocs`, `deploy`, `credentialsNote`. Every SafeTaper-style hardcode below is replaced by these values. If the file is missing, exit with a one-line error telling the user to create it.
- **Require `LINEAR_API_KEY`.** Load it from the environment or the repo's gitignored `.env` (`set -a && . ./.env && set +a`). If unset, exit immediately with a clear one-line error — do not attempt to recover a key from transcripts. Confirm git push credentials and any other credentials named in `config.credentialsNote` if a card needs live data.
- **Scope:** team = `config.teamName` (key `config.teamKey`); operate only within the `config.project` project. Repos to touch: `config.repos`.
- Ensure these labels exist in the team; create any that are missing: `blocked:open-questions`, `spec:in-progress`, `sweep:manual-only`.

## 1. Select cards (top-of-column order, bounded)

**Single-card auto-sweep mode.** If `AUTO_SWEEP_ISSUE` is set (or the unattended prompt names a single issue key), process only that issue and ignore every other Spec card. Treat an existing fresh `spec:in-progress` claim plus an `[auto-sweep-heartbeat ... owner=...]` comment as the launcher's pre-claim for this child, not as a competing run. Use `AUTO_SWEEP_WORKTREE`, `AUTO_SWEEP_LOG_DIR`, `AUTO_SWEEP_TMPDIR`, `AUTO_SWEEP_SCREENSHOT_DIR`, and `AUTO_SWEEP_BROWSER_PROFILE_DIR` when present instead of inventing local paths. In same-repo parallel mode, draft only this card's docs before landing. If this child performs its own fetch/merge/push/card move, first acquire a repo-local landing lock such as `mkdir "$(git -C "$AUTO_SWEEP_WORKTREE" rev-parse --git-common-dir)/auto-sweep-spec-landing.lock"` and release it on exit; hold that lock only for the serialized landing section.

List "Spec" cards **in `config.project`**, top-to-bottom as they appear in the Linear column, and for each decide:

- **Skip** if it has `sweep:manual-only`. **Skip** if it has `blocked:open-questions` AND its newest comment is not a human answer postdating your questions. Do NOT re-post questions — that is spam.
- **Resume** if it has `blocked:open-questions` and the newest comment IS a human answer to your questions: remove the label, proceed to spec it.
- **Skip** if it has a `spec:in-progress` label less than 45 min old (another run owns it). Reclaim it if the label is stale (≥45 min).
- **Triage, don't manufacture:** if the card is already done, a duplicate, or too vague to be a real feature, do not invent a spec — comment your reasoning and move it (Done / Duplicate / leave with a note), then continue.
- **Claim** before working: add `spec:in-progress`. Remove it when you finish, block, or bail.
- **Label the card if it's bare** (generate-if-missing): if `config.reviewLenses` is set and the card carries none of its domain labels, classify the feature from the card + the relevant code and apply the matching domain labels to Linear (comment what you applied). spec-sweep is the earliest touch, so labelling here is what lets the gated review lenses (below) fire for this card and every downstream sweep. A human relabel always wins — never override one.

Process **at most 3 cards per run**. The queue drains over successive runs. If "Spec" is empty or every card is skipped, exit cleanly — a normal no-op run.

## 2. Per card

1. **Research first if the card needs unfamiliar external knowledge** (a new integration, an unfamiliar API/SDK — gated on the `research` lens or your own read of the card): run `/deep-research` before brainstorming so the spec is grounded, not guessed.
2. **Brainstorm the spec** (superpowers:brainstorming), exploring the actual code in the relevant repo(s) from `config.repos`. Follow the brainstorming skill's design → spec flow, adapted to run without live user input.
3. **Engineering review via `/plan-eng-review` in prose (non-interactive) mode.** Invoke `plan-eng-review` on the spec. Because this run is unattended, use the skill's **prose-mode decision handling** (its "AskUserQuestion unavailable → prose fallback"): render each decision brief as prose — a plain-English ELI10, an explicit `Completeness: X/10` per option, recommended option first — then **proceed with the recommended option** and record the brief in the spec's engineering-review section. NEVER call AskUserQuestion and NEVER stop as `BLOCKED` for a review decision. Also spawn one independent adversarial reviewer subagent that traces every "reuse"/mechanism/premise claim against the real code (file:line) and fold its findings in. **Do not reduce scope based on the review unless you are fully convinced it is right** — corrections and added plumbing are expected; a scope cut needs strong justification stated in the card. This step reliably catches load-bearing false premises — treat it as mandatory.
4. **Gated review lenses (by card type, same prose/non-interactive mode as step 3).** Fire only the lenses the card's domain labels warrant — do NOT run `/autoplan` (it bundles CEO review, which is deliberately out of this pipeline). Run each applicable one and fold its prose recommendations into the spec's review section:
   - **UI card** → `/plan-design-review`
   - **API / CLI / SDK card** → `/plan-devex-review`
   - **Security-sensitive card** (auth / data / external input) → `/cso` on the plan
   A card matching no lens runs only step 3. Each lens catches its defect class now, at the cheapest stage, instead of at QA or never.
5. **Write the implementation plan.**
6. **Update canonical architecture/schema docs** per `config.canonicalDocs`. If the config names an `architecture` and/or `schema` doc, and the spec changes data shape / subsystems, update those docs to reflect the design, marking not-yet-built items as *planned* (e.g. "(planned, <PREFIX>-###)"). Add a short "Schema & architecture impact" summary to the spec itself. If `config.canonicalDocs.schema` is null (single-repo project), just keep the architecture doc (e.g. `CLAUDE.md`) accurate.

## 3. Land it (docs only; auto-merge to main)

- Write spec → `<config.specsDir>/YYYY-MM-DD-<prefix-key>-<topic>-design.md` and plan → `<config.plansDir>/…-implementation.md` in the affected repo.
- Commit on a branch off `main`. **Stage selectively — never `git add -A`.** Put the `<PREFIX>-###` key in the commit subject. End commit messages with your runtime's co-authorship trailer (Claude Code: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; Codex: your own attribution).
- **Merge to `main` (`--no-ff`) and push.** In single-card auto-sweep mode, hold the repo-local landing lock from §1 for this fetch/merge/push/card-move section. If a push is rejected non-fast-forward, merge `origin/main` and retry. Delete the merged branch; leave the repo on `main`, clean and synced.
- **Docs only.** If the change would touch app code, stop and comment on the card instead of committing.
- Move the card to the **bottom of "Dev"** with a summary comment linking the spec + plan paths and listing the review's key corrections. Remove `spec:in-progress`. Prefer the repo helper (`node scripts/linear.mjs move-card-bottom <PREFIX-###> "Dev"`) so the status and bottom rank update together.

## 4. Blocked on questions

When the spec genuinely can't be finished without answers only the owner can give: post them as a **single numbered comment** on the card, add `blocked:open-questions`, remove `spec:in-progress`, and **leave it in "Spec"** (do not move to Dev). A later run resumes it once the owner replies (see §1). Ask each question once — never re-post.

## Machine-independence & handoff (auto-sweep)

Every card must be resumable on any machine — this run, the auto-sweep launcher, and any other machine coordinate ONLY through origin. Follow these whether a human or the launcher started you.

- **Heartbeat while you hold a claim.** Roughly every 5 minutes that you own a card via `spec:in-progress`, post a comment `[auto-sweep-heartbeat <ISO8601 now>]`. A claim with no heartbeat past its stale threshold is treated as crashed and auto-released by the launcher.
- **Origin holds everything at rest.** Your artifacts are the spec + plan docs; §3 already merges them to the anchor repo's `main` and pushes before you move the card to "Dev". Never move the card without that push landing — dev-sweep on another machine reads the spec from `main`.
- **Push discipline (never force).** For the merge push: `git fetch` → rebase/merge `origin/main` → push; on a non-fast-forward rejection retry up to 2×; if it still fails, comment on the card and stop. Never force-push.
- **Re-read before the terminal move.** Right before moving the card to "Dev", re-fetch it. If a human (or another run) moved it out of "Spec", do NOT override — comment where the spec/plan landed, release `spec:in-progress`, and stop.
- **Mark backward moves.** If you send a card backward (e.g. to Backlog as too-vague), add a comment `[auto-sweep-bounce Spec→Backlog]`. Repeated backward moves within 48h get the card parked with `blocked:needs-user` for a human.

## Guardrails (unattended)

- Docs/specs only. No app code, no migrations, no deploys, no prod writes beyond reads needed to design.
- ≤3 cards per run; top-of-column order; claim/release via `spec:in-progress`; stay within `config.project`.
- Every question goes to a card comment — never wait on interactive input, never use AskUserQuestion (meaningless unattended).
- Prefer parallel subagents for independent cards and for the per-card reviews.
- Leave a clean audit trail: the card comments ARE the log of what happened and why.

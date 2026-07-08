---
name: spec-sweep
description: Autonomously develop specs + implementation plans for the configured Linear project's "Needs Spec" cards and move them to "Ready for Dev". Project-agnostic — reads .claude/linear-sweep.json for the team/project/prefix. Runs unattended (e.g. hourly cron) or on demand. Use when asked to "spec the needs-spec cards", "run the spec sweep", or on a schedule.
---

# Spec Sweep

Autonomously turn this repo's Linear "Needs Spec" cards into review-hardened specs + implementation plans and advance them to "Ready for Dev". Designed to run **unattended on a schedule** — assume no human is watching. Never block waiting for input; route all questions to card comments. **Touch only spec/plan/design docs — never write app code, run migrations, or deploy.**

> **Runtime (Claude Code + Codex).** This skill speaks in *actions*; map them to your runtime's tools. On **Codex**, see the "Board sweeps" section of `AGENTS.md` for the tool mapping (`shell`, `apply_patch`, `spawn_agent`/`wait_agent`, `update_plan`) and use your own commit attribution. On **Claude Code**, use the Skill tool for named skills and Task for subagents. Referenced helper skills (`brainstorming`, `plan-eng-review`, `code-review`, `test-driven-development`, `using-git-worktrees`) load natively on both when installed.

## 0. Preflight (fail fast, cleanly)

- **Load repo config.** Read `.claude/linear-sweep.json` from the repo root. It provides `teamName`, `teamKey`, `project`, `projectId`, `issuePrefix`, `repos`, `specsDir`, `plansDir`, `canonicalDocs`, `deploy`, `credentialsNote`. Every SafeTaper-style hardcode below is replaced by these values. If the file is missing, exit with a one-line error telling the user to create it.
- **Require `LINEAR_API_KEY`.** Load it from the environment or the repo's gitignored `.env` (`set -a && . ./.env && set +a`). If unset, exit immediately with a clear one-line error — do not attempt to recover a key from transcripts. Confirm git push credentials and any other credentials named in `config.credentialsNote` if a card needs live data.
- **Scope:** team = `config.teamName` (key `config.teamKey`); operate only within the `config.project` project. Repos to touch: `config.repos`.
- Ensure these labels exist in the team; create any that are missing: `blocked:open-questions`, `spec:in-progress`.

## 1. Select cards (oldest-first, bounded)

List "Needs Spec" cards **in `config.project`**, oldest-first, and for each decide:

- **Skip** if it has `blocked:open-questions` AND its newest comment is not a human answer postdating your questions. Do NOT re-post questions — that is spam.
- **Resume** if it has `blocked:open-questions` and the newest comment IS a human answer to your questions: remove the label, proceed to spec it.
- **Skip** if it has a `spec:in-progress` label less than 45 min old (another run owns it). Reclaim it if the label is stale (≥45 min).
- **Triage, don't manufacture:** if the card is already done, a duplicate, or too vague to be a real feature, do not invent a spec — comment your reasoning and move it (Done / Duplicate / leave with a note), then continue.
- **Claim** before working: add `spec:in-progress`. Remove it when you finish, block, or bail.

Process **at most 3 cards per run**. The queue drains over successive runs. If "Needs Spec" is empty or every card is skipped, exit cleanly — a normal no-op run.

## 2. Per card

1. **Brainstorm the spec** (superpowers:brainstorming), exploring the actual code in the relevant repo(s) from `config.repos`. Follow the brainstorming skill's design → spec flow, adapted to run without live user input.
2. **Engineering review via `/plan-eng-review` in prose (non-interactive) mode.** Invoke `plan-eng-review` on the spec. Because this run is unattended, use the skill's **prose-mode decision handling** (its "AskUserQuestion unavailable → prose fallback"): render each decision brief as prose — a plain-English ELI10, an explicit `Completeness: X/10` per option, recommended option first — then **proceed with the recommended option** and record the brief in the spec's engineering-review section. NEVER call AskUserQuestion and NEVER stop as `BLOCKED` for a review decision. Also spawn one independent adversarial reviewer subagent that traces every "reuse"/mechanism/premise claim against the real code (file:line) and fold its findings in. **Do not reduce scope based on the review unless you are fully convinced it is right** — corrections and added plumbing are expected; a scope cut needs strong justification stated in the card. This step reliably catches load-bearing false premises — treat it as mandatory.
3. **Write the implementation plan.**
4. **Update canonical architecture/schema docs** per `config.canonicalDocs`. If the config names an `architecture` and/or `schema` doc, and the spec changes data shape / subsystems, update those docs to reflect the design, marking not-yet-built items as *planned* (e.g. "(planned, <PREFIX>-###)"). Add a short "Schema & architecture impact" summary to the spec itself. If `config.canonicalDocs.schema` is null (single-repo project), just keep the architecture doc (e.g. `CLAUDE.md`) accurate.

## 3. Land it (docs only; auto-merge to main)

- Write spec → `<config.specsDir>/YYYY-MM-DD-<prefix-key>-<topic>-design.md` and plan → `<config.plansDir>/…-implementation.md` in the affected repo.
- Commit on a branch off `main`. **Stage selectively — never `git add -A`.** Put the `<PREFIX>-###` key in the commit subject. End commit messages with your runtime's co-authorship trailer (Claude Code: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; Codex: your own attribution).
- **Merge to `main` (`--no-ff`) and push.** If a push is rejected non-fast-forward, merge `origin/main` and retry. Delete the merged branch; leave the repo on `main`, clean and synced.
- **Docs only.** If the change would touch app code, stop and comment on the card instead of committing.
- Move the card to **"Ready for Dev"** with a summary comment linking the spec + plan paths and listing the review's key corrections. Remove `spec:in-progress`.

## 4. Blocked on questions

When the spec genuinely can't be finished without answers only the owner can give: post them as a **single numbered comment** on the card, add `blocked:open-questions`, remove `spec:in-progress`, and **leave it in "Needs Spec"** (do not move to Ready for Dev). A later run resumes it once the owner replies (see §1). Ask each question once — never re-post.

## Machine-independence & handoff (auto-sweep)

Every card must be resumable on any machine — this run, the auto-sweep launcher, and any other machine coordinate ONLY through origin. Follow these whether a human or the launcher started you.

- **Heartbeat while you hold a claim.** Roughly every 5 minutes that you own a card via `spec:in-progress`, post a comment `[auto-sweep-heartbeat <ISO8601 now>]`. A claim with no heartbeat past its stale threshold is treated as crashed and auto-released by the launcher.
- **Origin holds everything at rest.** Your artifacts are the spec + plan docs; §3 already merges them to the anchor repo's `main` and pushes before you move the card to "Ready for Dev". Never move the card without that push landing — dev-sweep on another machine reads the spec from `main`.
- **Push discipline (never force).** For the merge push: `git fetch` → rebase/merge `origin/main` → push; on a non-fast-forward rejection retry up to 2×; if it still fails, comment on the card and stop. Never force-push.
- **Re-read before the terminal move.** Right before moving the card to "Ready for Dev", re-fetch it. If a human (or another run) moved it out of "Needs Spec", do NOT override — comment where the spec/plan landed, release `spec:in-progress`, and stop.
- **Mark backward moves.** If you send a card backward (e.g. to Backlog as too-vague), add a comment `[auto-sweep-bounce Needs Spec→Backlog]`. Repeated backward moves within 48h get the card parked with `blocked:needs-user` for a human.

## Guardrails (unattended)

- Docs/specs only. No app code, no migrations, no deploys, no prod writes beyond reads needed to design.
- ≤3 cards per run; oldest-first; claim/release via `spec:in-progress`; stay within `config.project`.
- Every question goes to a card comment — never wait on interactive input, never use AskUserQuestion (meaningless unattended).
- Prefer parallel subagents for independent cards and for the per-card reviews.
- Leave a clean audit trail: the card comments ARE the log of what happened and why.

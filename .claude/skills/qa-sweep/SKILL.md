---
name: qa-sweep
description: Smoke-test the configured Linear project's "QA" cards as a real user, fix UX/UI bugs, attach screenshots + review notes, then route each passing card to "Signoff" or commit-bound automatic "Ship". Never merges, never deploys — that's ship-sweep's job. Project-agnostic — reads .claude/linear-sweep.json. Use when asked to "QA the QA cards", "run the QA sweep", or on a schedule.
---

# QA Sweep

Act as a user: exercise each "QA" feature in a real dev environment, in as much detail as possible, confirm it works well, fix UX/UI bugs you find, then attach screenshots + a written review and select the terminal handoff. Normal passing cards move to **"Signoff"** for human review; an unchanged, commit-bound fast-path candidate may move automatically to **"Ship"** after the same full QA. ship-sweep does the merge + deploy.

**This sweep NEVER merges and NEVER deploys.** It lands a green, smoke-tested feature at the selected holding queue and stops; ship-sweep remains the only production path. Because QA never touches prod, it is safe to schedule as aggressively as the other non-production sweeps.

> **Runtime (Claude Code + Codex).** Cross-runtime skill — map its actions to your runtime's tools. On **Codex**, see `AGENTS.md` "Board sweeps" for the mapping (`shell`, `apply_patch`, `spawn_agent`/`wait_agent`, `update_plan`) and use your own commit attribution. On **Claude Code**, use the Skill tool + Task subagents. "Run the app" = your runtime's dev-server method (see §2.2).

> **Reviewer runtime role.** If `.claude/linear-sweep.json` defines `runtimes.review`, prefer that runtime/model for independent reviewer subagents when your runtime supports explicit reviewer dispatch. If unsupported, run the reviewer in the current runtime and note that limitation in the Linear handoff. `review` is a role only, never a scheduled sweep.

## 0. Preflight (fail fast)

- **Load workspace config.** In scheduled mode, read `$AUTO_SWEEP_ANCHOR/.claude/linear-sweep.json`; otherwise read `.claude/linear-sweep.json` from the current repo root (fields per spec-sweep §0). The routed primary repo may be a sibling and is not required to carry a duplicate config. Missing file → exit with a one-line error. (No deploy path needed — qa-sweep never deploys.)
- **Require `LINEAR_API_KEY`** (env or the repo's gitignored `.env`); confirm git push credentials and any credentials in `config.credentialsNote`.
- **Coding guardrail.** Before any code-fix, debugging, refactoring, or review work, invoke `andrej-karpathy-skill` from the `andrej-karpathy-skills` plugin. If the skill is unavailable, apply its core checks manually: think before coding, keep the change simple, make surgical edits, and verify the goal before calling the work complete.
- **Child repository preflight (mandatory when routed).** In scheduled single-card mode, when `AUTO_SWEEP_REPO_LABEL` is set, run `node "$AUTO_SWEEP_KIT_PATH/scripts/linear.mjs" repo-status "$AUTO_SWEEP_ISSUE" "$AUTO_SWEEP_REPO_LABEL" "$AUTO_SWEEP_REPO_ENTRY"` immediately after startup and before the dependency check, claim, worktree mutation, merge, deploy, or any other material work. **Exit `0`:** continue. **Exit `3`:** the live app label is missing, ambiguous, or changed; comment the returned route evidence, remove only this sweep's owned claim if present, and stop. **Exit `2`:** routing is unreadable or misconfigured; report it, remove only this sweep's owned claim if present, and stop. Never add `blocked:needs-user` for this machine-checkable routing failure; the launcher's self-clearing routing Todo owns the retry signal.
- **Child dependency preflight (mandatory).** In scheduled single-card mode, after startup and before the first material mutation, run:
  ```bash
  node "$AUTO_SWEEP_KIT_PATH/scripts/linear.mjs" dependency-status "$AUTO_SWEEP_ISSUE"
  ```
  Only the exact canonical `Done` state releases a blocker; Canceled, Duplicate, Archived, and every other state remain blocked. Handle the command by exit status: **Exit `0`:** continue. **Exit `3`:** comment the visible blocker identifiers/states, remove only this sweep's owned claim (`qa:in-progress`), and stop without material work. **Exit `2`:** report unreadable dependency data, remove only this sweep's owned claim (`qa:in-progress`), and stop. Never infer readiness from partial output.
- Confirm you can run the app. Use your runtime's dev-server method: **Claude Code** → the `preview_*` tools (never Bash for servers); **Codex** → start `npm run dev` via `shell` in the background and read its logs. Capture console/network/server output either way to catch errors. For authenticated flows, `/connect-chrome` + `/setup-browser-cookies` give a real-user session.
- Team = `config.teamName` (`config.teamKey`); operate only within `config.project`. Repos: `config.repos`. Ensure labels exist; create if missing: `qa:in-progress`, `qa:needs-changes`, `qa:passed`, `blocked:needs-user`, `sweep:manual-only`.
- **Scheduled primary repo:** when `AUTO_SWEEP_REPO` is set, it is the launcher's label-routed managed repository for this card; `AUTO_SWEEP_SOURCE_REPO` is its source checkout. Treat that repo as primary and put the card worktree at `AUTO_SWEEP_WORKTREE`. Other entries in `config.repos` remain available only for plan-approved multi-repo scope; never switch primary ownership implicitly.

## 1. Select cards (top-of-column order, bounded, claimed)

**Single-card auto-sweep mode.** If `AUTO_SWEEP_ISSUE` is set (or the unattended prompt names a single issue key), process only that issue and ignore every other QA card. Treat an existing fresh `qa:in-progress` claim plus an `[auto-sweep-heartbeat ... owner=...]` comment as the launcher's pre-claim for this child, not as a competing run. Use `AUTO_SWEEP_WORKTREE`, `AUTO_SWEEP_LOG_DIR`, `AUTO_SWEEP_TMPDIR`, `AUTO_SWEEP_APP_PORT`, `AUTO_SWEEP_SCREENSHOT_DIR`, and `AUTO_SWEEP_BROWSER_PROFILE_DIR` when present instead of inventing local paths, ports, screenshot directories, or browser profiles. Store screenshots, generated evidence, browser profiles, and scratch files under those env paths, never in repo roots.

List "QA" cards **in `config.project`**, top-to-bottom as they appear in the Linear column. For each:
- **Skip** if `blocked:needs-user`, `qa:needs-changes`, or `sweep:manual-only` and no new human reply resolves it; **skip** if `qa:in-progress` < 120 min old (another run owns it — QA is slow). Reclaim a stale claim.
- **Claim** with `qa:in-progress` before starting; remove it when you finish, block, or bail.
- **Label the card if it's bare** (generate-if-missing): if `config.reviewLenses` is set and the card carries none of its domain labels, classify the feature from the card + diff surface and apply the matching domain labels to Linear (comment what you applied). A human relabel always wins — never override one. This keeps design/security review lenses firing on legacy cards. (Most cards are labelled at spec time; this covers mid-pipeline entries.)
- Respect the 24h-rule: if the card's code/branch/worktree was created in the last 24h and looks actively in progress by a human, leave it — comment and skip.
- Process **at most 2 cards per run** (each is a full env + smoke test). If none are actionable, exit cleanly (normal no-op).

## 2. Per card — smoke test as a user

1. **Locate the work:** from the card + git, find the repo(s) from `config.repos`, branch, worktree, and/or PR for the feature. Read the card description + the linked spec/plan so you know the intended behavior. If the only implementation evidence is in an unconfigured sibling repo, do not mark `qa:passed` for this ship path; block or bounce with the exact split/config update needed.
2. **Stand up a dev environment:** check out the branch/worktree; start the app with the preview tooling. Seed data if the flow needs it.
3. **Exercise the feature as a user, in detail — use `/qa` as the test engine** (or `/qa-only` for the report form) rather than ad-hoc clicking. Walk the actual user flows the card adds — happy path AND the obvious edge cases. Click through, fill forms, trigger the states. Watch console + network + server logs for errors. Use subagents/parallel work for independent flows. If a `/plan-eng-review` test plan exists for the branch, feed it in as primary test input.
4. **Capture screenshots** of the key states (before/after, each important screen). Save them; you'll attach them to the card.
5. **Design pass + fix UX/UI bugs.** For UI cards, run `/design-review` on the running feature for a structured visual audit instead of eyeballing. Fix what you find — layout, copy, broken states, missing loading/empty/error handling, a11y basics. Commit fixes on the card's branch (stage selectively; `<PREFIX>-###` in the subject). Re-test after each fix.
6. **Update canonical docs** per `config.canonicalDocs` if the feature changed data shape or architecture and those docs are now stale.

## 3. Gate — pass, or send back

Proceed to §4 ONLY if: the smoke test passes, the build is green (`npm run build` / tests / lint as applicable), and no unresolved errors remain. **Otherwise do NOT pass it:** post your findings + screenshots to the card, add `qa:needs-changes`, remove `qa:in-progress`, leave the card in "QA", and move on. If the blocker needs the owner, use `blocked:needs-user` and comment what's needed.

## 4. Select the terminal handoff (no merge, no deploy)

Only after §3 passes:
1. **Attach the screenshots to the Linear card** (Linear file upload: `fileUpload` mutation → PUT the bytes to the returned signed URL with its headers → reference the asset URL as a markdown image in a comment / as an attachment).
2. Post a **review write-up**: what you tested, what passed, bugs found + fixed (with commit refs), and any residual risk.
3. Add **`qa:passed`** — this is ship-sweep's green signal and its pre-merge evidence — then re-fetch the card so the handoff decision uses current state and labels.
4. Fetch origin and resolve the branch's final full SHA from `origin/<PREFIX>-###`, never from the local worktree. Read the latest well-formed, issue-specific `[auto-sweep-fast-path <KEY> head=<full-git-sha>]` comment; a legacy marker without `head=` is not reviewed-SHA evidence. Compare the final origin branch SHA against that reviewed SHA.
5. Evaluate `qaHandoffDecision` with the exact current facts: `config.fastPath.enabled !== false`, `config.requireShipApproval === false`, state `QA`, current labels including `fast-path:eligible` and `qa:passed`, the issue identifier, both full SHAs, and any live foreign `*:in-progress` claim. Unknown, unreadable, or malformed evidence fails closed to `Signoff`.
6. **Eligible:** post `[auto-sweep-auto-ship <KEY> head=<full-git-sha>]` with the matching reviewed/final SHA evidence and policy facts, release `qa:in-progress`, and run `node scripts/linear.mjs move-card-bottom <PREFIX-###> "Ship"`. This is a queue transition only: do not invoke ship-sweep directly and do not add a launcher handoff.
7. **SHA mismatch:** remove `fast-path:eligible` because it is stale, record the reviewed SHA and final origin SHA in the review write-up, release `qa:in-progress`, and run `node scripts/linear.mjs move-card-bottom <PREFIX-###> "Signoff"`.
8. **Every other denial:** record the policy reason, release `qa:in-progress`, and move the passing card to the bottom of `Signoff` with the same helper. A policy denial is not a QA failure: keep `qa:passed` and do not add `qa:needs-changes`.

Immediately before the selected terminal move, re-fetch the card one final time. If a human or another run moved it out of `QA`, do not override; comment the completed QA evidence, release `qa:in-progress`, and stop. **Leave the branch pushed and unmerged; do not delete the worktree/branch/PR** — ship-sweep needs them. Normal cards continue through `QA` → `Signoff` → human approval → `Ship`; only an eligible unchanged fast path takes automatic `QA` → `Ship`, and `requireShipApproval: true` always preserves `Signoff`.

## Blocked / needs-user

If you need a direct owner answer that is not its own completable task (ambiguous intended behavior, a credential value/data input, or a product decision): comment the specifics, add `blocked:needs-user`, leave the card in "QA", remove `qa:in-progress`. Ask once; resume when they reply.

### Retry-safe prerequisite blockers

When a prerequisite can be completed as its own issue, use only a `blockedBy` relation from the dependent to that blocker. Follow this exact mini-workflow so retries converge:

1. **Search for the stable audit marker** `[auto-sweep-dependency <dependent> blocked-by <blocker>]` and for an existing matching or orphaned blocker before creating anything.
2. **Create or reuse the blocker issue**; never create a duplicate when a matching issue already exists.
3. **Create the `blockedBy` relation only if it is absent.**
4. **Add the audit comment only if the stable marker is absent.**
5. **Re-read the relation**; once it exists, stop material work and remove only the dependent's owned `qa:in-progress` claim.

A separately completable blocker is relation-only: never add `blocked:needs-user` merely because a `blockedBy` relation exists. The launcher resumes the dependent only after every blocker reaches exact canonical `Done`. A direct human answer without its own issue retains the existing human-block label path (`blocked:needs-user`). Preserve `qa:needs-changes` for actual QA failures; a prerequisite relation alone does not replace or create that gate.

## Machine-independence & handoff (auto-sweep)

Every card must be resumable on any machine — this run, the auto-sweep launcher, and any other machine coordinate ONLY through origin. Follow these whether a human or the launcher started you.

- **Heartbeat while you hold a claim.** Roughly every 5 minutes that you own a card via `qa:in-progress`, post a comment `[auto-sweep-heartbeat <ISO8601 now>]`. A claim with no heartbeat past its stale threshold is treated as crashed and auto-released by the launcher — QA runs are long, so heartbeat diligently.
- **Reconstruct the environment from the branch, not a local worktree.** `<PREFIX>-###` is deterministic from the card. In each relevant repo (`config.repos`): `git fetch`; if `origin/<PREFIX>-###` exists and no local worktree does, rebuild it at `<repo>/.worktrees/<PREFIX>-###`; if a local worktree exists from a prior run, `git reset --hard origin/<PREFIX>-###` before testing. This is how QA runs on a different machine than dev did.
- **Push discipline (never force).** When you commit UX fixes, push the card's branch: `git fetch` → rebase onto `origin/<PREFIX>-###` → push; retry up to 2× on rejection; never force-push. **Do not touch `main`** — qa-sweep never merges. Leave the branch intact and unmerged for ship-sweep.
- **Re-read before the selected terminal move.** Right before moving the card to "Signoff" or "Ship", re-fetch it. If a human moved it out of "QA", do NOT override — comment your findings, release `qa:in-progress`, and stop.
- **Mark backward moves.** Sending a card back with `qa:needs-changes` is a normal QA outcome and does not need a bounce marker; but if you move it further back (to "Dev"/"Spec"), add `[auto-sweep-bounce QA→<to>]` so the launcher can park a card that oscillates.

## Guardrails

- **Never merges, never deploys** — lands a green, smoke-tested feature at the selected `Signoff` or `Ship` queue and stops. ship-sweep alone owns merge, deploy, and canary work; QA automatic routing does not launch it immediately.
- Only pass a feature that passed a real smoke test with a green build. When in doubt, `qa:needs-changes` and stop.
- QA evidence must match ship scope. A card cannot pass QA for a repo/deploy path that is not configured to ship it; split the card or require a multi-repo config/runbook first.
- ≤2 cards/run; top-of-column order; claim/release via `qa:in-progress`; stay within `config.project`.
- Fix scope = UX/UI + obvious bugs found during QA. A feature that's fundamentally broken or half-built goes back with `qa:needs-changes`, not "fixed" into a rewrite.
- Every question → a card comment; never AskUserQuestion.
- The card comments + screenshots are the audit trail.

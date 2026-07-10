# linear-board-sweeps

A portable kit that installs a **Linear-driven, cross-runtime (Claude Code + Codex) feature workflow** into any repo. Four autonomous "board sweeps" carry work across a Linear board, with a human gate before anything ships:

```
Spec ─spec─▶ Dev ─dev─▶ QA ─qa─▶ Signoff ─[human]─▶ Ship ─ship─▶ Done
 (docs +            (code on a worktree,   (smoke-test as    (human           (merge, deploy,
  gated reviews)     review, push,          a user, fix UX,   reviews +         canary-verify)
                     no merge)              no merge)         approves)
```

Reviewing and shipping are separate: qa-sweep tests but never merges, a human approves by moving the card to **Ship**, and only then does ship-sweep merge + deploy. A machine never ships to production without a person having approved that specific card.

Point Claude or Codex at this repo from any project, on any machine, and it has everything it needs to set that project up for the workflow.

## Use it

From inside the target repo, tell your agent (Claude Code or Codex):

> "Set up this repo for Linear sweeping. Clone `https://github.com/shereefb/linear-board-sweeps` into a sibling folder if it isn't already there, then follow its SETUP.md end to end."

**The agent does everything** — it clones this kit itself, reads [SETUP.md](SETUP.md), then creates the board statuses + labels, installs the skills, writes the repo config, wires the Codex adapter, and (on an always-on machine) installs the auto-sweep launcher, registers the workspace, activates the project, and turns on the schedule. The only things it needs from you: a Linear API key (`lin_api_…`) once, and your team/project name.

- **Manual invocation only?** The agent stops after the base install; you run sweeps with the phrases below.
- **Automatic triggering?** Tell it "…and set up auto-sweep triggering on this machine" (or just answer its Step 11 prompt). It installs the launcher and activates the project — see [Triggering](#triggering-auto-sweep).

(SETUP.md Step 0 handles the clone, so the same prompt works whether or not the kit is already on the machine.)

## What's inside

| Path | What it is |
|------|-----------|
| `SETUP.md` | The agent-facing bootstrap procedure (what to prompt, where to put everything, exact commands). |
| [`CHANGELOG.md`](CHANGELOG.md) | User-facing release history for the kit. |
| `skills/{spec,dev,qa,ship}-sweep/SKILL.md` | The four cross-runtime scheduled sweep skills. Project-agnostic — they read `.claude/linear-sweep.json`. spec-sweep uses adaptive review depth, spec/dev/qa run materially gated review lenses, and ship-sweep is the only one that merges + deploys. |
| `skills/unblock-sweep/SKILL.md` | Manual-only interactive workflow for resolving cards parked with blocking labels across registered anchors. It is copied to anchors but never scheduled. |
| `scripts/linear.mjs` | Zero-dependency Linear engine (Node 18+): `whoami`, `setup-team`, `ensure-project`, `create-card`, `move-card-bottom`, `retire-state`, `rename-states`, `dependency-status`, `query`. |
| `scripts/linear-watch.mjs` | Zero-dependency auto-sweep launcher: `register`/`unregister`, `activate`/`deactivate` (toggle the project label), `ship-runner [on\|off]` (pin ship dispatch to this host), `list`, `tick [--dry-run]`, `health`, `doctor [--json]`. Polls Linear cheaply and dispatches a sweep only when a queue has actionable work, using the visible Linear column order — see [Triggering](#triggering-auto-sweep). |
| `scripts/linear-watch.sh` + `scripts/install-watch.sh` + `templates/launchd/…watch.plist` | launchd wrapper, installer, and plist that run the launcher every 10 min on a Mac (mini). |
| `templates/linear-sweep.json` | The per-repo config the skills read. Copied + filled into the target's `.claude/`. |
| `templates/AGENTS.snippet.md` | The "Board sweeps" section appended to the target's `AGENTS.md` — how Codex finds the skills. |
| `templates/gitignore.snippet` | `.env` + `.claude/` tracking rules for the target's `.gitignore`. |
| `docs/linear-rules.md` | The canonical board taxonomy (statuses, labels) + feature-tracking rules. |
| `docs/superpowers/reports/` | Evidence-backed retrospectives and workflow reports produced by sweep cards such as COD-89. |

## How it stays runtime-agnostic

The `SKILL.md` files speak in **actions** ("brainstorm a spec", "dispatch a reviewer subagent", "run the dev server"), not tool names.

- **Claude Code** discovers `.claude/skills/` natively and maps actions to its tools (Skill, Task, `preview_*`).
- **Codex** auto-loads `AGENTS.md`; the "Board sweeps" section points it at the same `SKILL.md` files, gives the Codex tool mapping (`shell`, `apply_patch`, `spawn_agent`, `update_plan`), and installs the Karpathy coding guardrail with a manual fallback if the plugin is unavailable.

Same files, both runtimes. Invoke with natural language: "run the spec sweep", "run the dev sweep", "run the QA sweep", "run the ship sweep".

`unblock-sweep` is different: it is a human-invoked maintenance workflow, not part of the scheduled queue. Invoke it when you want to review cards blocked on user input; it lists blocked cards across registered anchors, records your resolution as a Linear comment, and removes only the blocking labels you choose.

## Triggering (auto-sweep)

Instead of running the sweeps by hand, the launcher (`scripts/linear-watch.mjs`) can run them automatically when a card lands in the matching queue. It's built for one always-on machine (a Mac mini) driving **many workspaces**:

- **Unit = workspace, not repo.** One Linear project maps to one workspace (a container folder of N sibling git repos), anchored at the repo that holds `.claude/`. You `register` each anchor once; activation is a Linear **project label `auto-sweep`** you toggle in the UI.
- **Card scope = deploy scope.** By default, each card should own one deployable repo. If a feature spans sibling repos, split it into per-repo implementation cards under a parent product card, or configure the workspace as a true multi-repo ship target: list every repo in `linear-sweep.json`, write deploy instructions for every production target, and require handoff comments to name each branch/PR and QA result. The ship sweep will block when evidence points to an unconfigured sibling repo.
- **Adaptive Spec review depth.** spec-sweep classifies each card from the actual code, draft spec, and predicted risk: mechanical Tier 0 work may skip engineering review, bounded Tier 1 work gets one targeted spec or implementation-plan pass, and material Tier 2 work gets both. After the plan exposes the concrete file map, task graph, tests, and failure modes, the tier may stay level or increase but never decrease. Material security and performance gates remain mandatory regardless of tier, while a domain label alone does not force an irrelevant heavyweight lens.
- **Cheap when idle.** Every ~10 min the launcher makes a few Linear API calls and a fast-forward `git pull` — **zero LLM tokens** — and dispatches a heavyweight agent pass only when a queue holds genuinely actionable work.
- **Board order is priority.** Within a status column, the next card is the top visible card in Linear (`Issue.sortOrder`), after blocked/live-claimed cards are filtered. Sweeps move completed or bounced cards to the bottom of the destination column via `node scripts/linear.mjs move-card-bottom <KEY-###> "<State>"`.
- **Dependencies are relations, not labels.** A `blockedBy` relation is ready only when every visible blocker is in exact canonical `Done`; Canceled, Duplicate, Archived, and other terminal-looking states remain unresolved. The launcher checks relations during scan and claim confirmation, and every scheduled child runs `node "$AUTO_SWEEP_KIT_PATH/scripts/linear.mjs" dependency-status "$AUTO_SWEEP_ISSUE"` before its first material mutation. For an independently completable prerequisite, use the relation alone: never add `blocked:needs-user` merely because a `blockedBy` relation exists. That label remains for a direct human answer with no separate blocker issue and for its existing crash/bounce safety uses.
- **Self-healing.** A crashed session's claim is auto-released via a heartbeat (not a raw timer), poison/oscillating cards escalate to `blocked:needs-user`, manual/dedicated work can be parked with `sweep:manual-only`, a holding-state reaper releases claims stranded in `Signoff`, scheduled tick failures create self-clearing `Todo` cards when Linear is reachable, and a PID-liveness lock keeps exactly one launcher tick supervising a bounded child-agent batch at a time.
- **Manual work stays manual.** Cards created or moved during direct user conversations, or by non-sweep skills, should carry `sweep:manual-only` unless the user explicitly wants launchd to pick them up. Clear that label only when handing the card back to the scheduled sweep pipeline.
- **Machine-independent.** All work and tooling flow through origin; launchd runs from a managed clean kit clone and scheduled sweeps run from managed workspace clones under `~/.local/share/linear-board-sweeps/workspaces/<anchor>/`. Day-to-day edits in human source checkouts are advisory once pushed commits are available on origin. Dirty managed clones and active card worktrees still block dispatch with exact path samples.
- **Artifact isolation.** The launcher gives child sweeps `AUTO_SWEEP_LOG_DIR`, `AUTO_SWEEP_TMPDIR`, `AUTO_SWEEP_SCREENSHOT_DIR`, and `AUTO_SWEEP_BROWSER_PROFILE_DIR` under state/cache paths so screenshots, logs, browser profiles, and temporary evidence do not dirty repo roots.
- **Shipping is single-runner.** Production merge + deploy happens only in ship-sweep, only from the human-gated `Ship` column. Pin ship dispatch to one host (`node scripts/linear-watch.mjs ship-runner on`) so two machines can never deploy the same card.
- **Host-wide child ceiling.** Launcher-registry `capacity.maxActiveChildren` defaults to exactly `10` and clamps configured values to `1..32`. It is a ceiling across initial, refill, and handoff top-level scheduled children, including surviving children recorded across launcher restarts; repo-local `parallel.*` settings shape demand beneath it. The ceiling does not count reviewer subagents created inside a scheduled child, and Ship remains exclusive and serial.
- **Bounded non-ship parallelism.** `parallel.maxNonShipDispatches` defaults to `2`, so one tick can dispatch a small batch of non-ship sweeps when their resolved repo paths do not overlap. Set it to `1` for serial mode; that workspace then runs alone or waits for the next tick. ship always stays serial.
- **Same-repo card slots.** Inside a selected non-ship workspace/sweep candidate, `parallel.sameRepoCardLimits` defaults to `spec:4`, `dev:4`, `qa:1`, `ship:1`. The parent launcher claims exact cards with owner-token heartbeats, dispatches child agents with `AUTO_SWEEP_ISSUE` and isolated worktree/log/temp/port paths, and writes per-card run records. `maxNonShipDispatches` counts workspace candidates; `sameRepoCardLimits` counts active child card slots.
- **Same-repo refill.** `parallel.maxSameRepoRefillDispatches` defaults to `8` and is clamped to `0..20`; `0` disables refill. When a successful non-ship child frees a same-repo slot, the parent launcher re-checks that same source queue and can backfill the next actionable card without waiting for the rest of the batch or the next timer tick. Refill is separate from handoff: handoff continues the completed card forward, while refill keeps the original same-repo pool near capacity.
- **Bounded queue draining.** `parallel.maxDrainPasses` defaults to `5` and is clamped to `1..5`. After a dispatch finishes, the launcher can re-scan queues up to four more times before exiting, so cards added during the run can be picked up without waiting for the next timer tick.
- **Immediate non-production handoffs.** After a successful spec handoff, the parent launcher can immediately dispatch dev for that same card; after successful dev, it can immediately dispatch QA. `parallel.maxHandoffTriggerHops` defaults to `2`, clamps to `0..3`, and `0` disables this. A parent tick spends at most `parallel.maxNonShipDispatches` handoff dispatch slots, while same-repo refill has its own `parallel.maxSameRepoRefillDispatches` budget. QA still stops at the human signoff queue; ship is never triggered by a handoff or refill.
- **Default fast path.** `fastPath` is enabled by default; dev-sweep may mark tiny, high-confidence changes `fast-path:eligible`, and a human can then move the card from `QA` straight to `Ship` to skip `Signoff`. Set `fastPath.enabled` to `false` to require normal QA for every card.
- **Runtime selection** lives in `linear-sweep.json`. The launcher resolves `runtimes.<sweep>` first, then falls back to legacy `runtime` + `models.<sweep>`, then to Codex defaults. The template uses Codex with `gpt-5.6-sol` high for Spec, `gpt-5.6-terra` high for Dev, `gpt-5.6-sol` medium for QA, and `gpt-5.6-terra` medium for Ship, so unattended launchd ticks do not depend on a separate Claude login. `runtimes.review` is a reviewer role preference, not a scheduled sweep.
- **Runtime executable preflight.** After choosing the configured runtime, executable resolution is the matching `CODEX_BIN` or `CLAUDE_BIN` environment override, then `PATH`; for Codex only, it next checks the ChatGPT.app bundled Codex and the legacy Codex.app bundle, then must fail before claim. Claude requires its override or `PATH` entry and stops after those checks. A missing runtime therefore cannot leave a new workflow claim behind.

Setup is a few idempotent commands per workspace (full agent-runnable procedure in [SETUP.md](SETUP.md) Step 11):

```bash
scripts/install-watch.sh                                 # create managed kit clone + install wrapper/plist (no activation)
node scripts/linear-watch.mjs register <anchor-repo>     # register the workspace anchor
node scripts/linear-watch.mjs activate <anchor-repo>     # add the auto-sweep label to the project (API)
node scripts/linear-watch.mjs doctor                     # inspect registry, managed clones, env, dirtiness
node scripts/linear-watch.mjs tick --dry-run             # validate live, spends no tokens
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.linear-board-sweeps.watch.plist  # turn on the 10-min timer
```

`list` shows each anchor + managed path + `[auto-sweep: ON/off]` + this host's ship-runner state; `doctor` shows source-vs-managed paths, dirty source advisory status, managed blocking status, env presence, kit path, host/user, and ship-runner state; `health` reads `current-tick.json` while a tick is running, so a live PID with systemic current tick failures is unhealthy; `deactivate` pauses a project. Scheduled launcher failures that happen after project metadata and a usable API key are available are reconciled into deduplicated `Todo` cards marked with `[auto-sweep-tick-failure <fingerprint>]`; a later tick that checks the same scope cleanly comments recovery and moves the Todo to `Done`. Full design + rationale: [`docs/superpowers/specs/2026-07-08-auto-sweep-launcher-design.md`](docs/superpowers/specs/2026-07-08-auto-sweep-launcher-design.md) and [`2026-07-08-gated-reviews-and-ship-split-design.md`](docs/superpowers/specs/2026-07-08-gated-reviews-and-ship-split-design.md). **Ship-runner:** production deploys run only on the one host with `ship-runner on`; qa-sweep no longer deploys, so it's safe to auto-run. `--dry-run` validates queue counting but not the merge/deploy path — watch the first real ship attended.

`doctor` reports capacity active/max/high-water, current-tick failures, runtime resolution, dependency/capacity deferred counts, host load and free-memory samples, and persistent current-backlog queue p50/p90 from `observations.json`. On macOS, optional memory-pressure available percentage appears separately from free bytes; missing metrics are reported as gaps and do not fail a child. This evidence is observational: the launcher does not auto-throttle or shorten the ten-minute interval. Keep the default ceiling and take a 24-hour observation before tuning `capacity.maxActiveChildren`, same-repo slots, or the polling interval.

### Workflow extensions and reports

Recent and planned launcher/workflow changes:

- `COD-82`: bounded non-ship parallel dispatch across disjoint, non-overlapping workspace repo sets, while ship remains serial and single-runner.
- `COD-83`: default-on fast-path eligibility markers for tiny, high-confidence changes; a human can then skip `Signoff` by moving the card directly from `QA` to `Ship`.
- `COD-84`: a manual, never-scheduled `unblock-sweep` workflow that finds user-blocked cards across registered anchors and helps the operator resolve them one at a time.
- `COD-88`: Karpathy coding-skill routing in installed Codex instructions and code-writing sweep guardrails.
- `COD-89`: dogfood retrospective landed under `docs/superpowers/reports/`, with timing, token, cadence, and user-interruption learnings plus follow-up cards.
- `COD-91`: self-clearing Linear `Todo` cards for scheduled tick failures, deduped by failure fingerprint.
- `COD-94`: structured scheduled-run records for sweep retrospectives, with explicit `unavailable` fields when runtimes do not expose usage.
- `COD-97`: per-stage runtime overrides so scheduled sweeps can mix Claude and Codex while preserving legacy `runtime` + `models` configs.
- `COD-98`: bounded drain-after-dispatch so sweeps can catch cards added while a pass was running without waiting for the next timer tick.
- `COD-99`: retire the `In Progress` state from normal workflow; `Dev` plus `dev:in-progress` becomes the active-dev representation.
- `COD-100`: same-repo per-card parallelism with default spec/dev limits of 4, QA limit of 1, owner-token card claims, isolated child env, card-specific run records, and ship still serial.
- `COD-113`: same-repo capacity refill so a Dev slot freed by a child moving to QA can be backfilled before the whole batch or next timer tick.
- `COD-116`: managed workspace clones, exact dirty-path diagnostics, artifact isolation, and a `doctor` command so scheduled sweeps are no longer coupled to dirty human checkouts.

## Requirements

- Node 18+ (for the Linear engine).
- A Linear Personal API key with access to the target team.
- For `dev-sweep` under Codex: `multi_agent = true` in `~/.codex/config.toml`.

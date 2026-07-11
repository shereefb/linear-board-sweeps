# SETUP — bootstrap the board-sweeps workflow into a repo

## Factory Learning Loop

Factory Learning observes bounded structured evidence through three lenses: reliability, quality/rework, and throughput/cost. A single registry-pinned learning runner executes only after delivery work drains and never receives repository write tools or secret-bearing environment values. Medium- and high-confidence findings automatically create or update `factory:learning-generated` cards at the bottom of Spec; low-confidence patterns accumulate without creating cards.

Generated cards follow Spec -> Dev -> QA -> Signoff and always require the human Ship move. They are never fast-path eligible, and Ship requires `qa:passed`. A `factory:learning-generated` card never auto-ships or uses the auto-ship marker and always requires the human move to Ship. After Done, a fixed evaluation window records the measurable outcome; only no-change/regression with fresh qualifying evidence can recur. Generation three is the cap, after which `blocked:needs-user` routes the Done card to manual review.

**You are an AI coding agent (Claude Code or Codex).** The user pointed you at this kit to install the spec → dev → qa Linear board-sweep workflow into their **target repo**. Follow these steps in order. `KIT` = this repo's path; `TARGET` = the repo you're setting up (usually the current working directory).

Do the work; don't just describe it. Prompt the user only for the inputs in Step 1.

---

## Step 0 — Get the kit + prerequisites

- **Obtain `KIT` yourself.** If you're already reading this file, you have it — set `KIT` to its path. If not (the user gave you only the prompt), clone it into a folder sibling to `TARGET` and use that as `KIT`:
  ```bash
  git clone https://github.com/shereefb/linear-board-sweeps "$(dirname "$TARGET")/linear-board-sweeps"
  ```
  If the sibling folder already exists, `git -C "<that path>" pull` instead of cloning. Don't ask the user to clone it — do it.
- Node 18+ (for `scripts/linear.mjs`, which uses global `fetch`).
- The user needs a **Linear API key** (`lin_api_…`): Linear → Settings → Security & access → Personal API keys → Create key.
- `TARGET` is a git repo.

## Step 1 — Ask the user (one short round)

Collect these. Suggest sensible defaults; only the first three are required.

1. **Linear team** — name or key (e.g. `Codex` / `COD`). The board lives here.
2. **Project name** — the Linear project the sweeps operate on (e.g. `My App`). Created if it doesn't exist.
3. **Linear API key** (`lin_api_…`).
4. **Issue prefix** — defaults to the team key.
5. **Deploy path** — how this repo reaches production (e.g. "Vercel auto-deploys on push to main; DB migrations applied manually").
6. **Repos the sweeps may touch** — defaults to `[TARGET's folder name]`.
7. **Canonical docs** — architecture doc (defaults to `CLAUDE.md`/`AGENTS.md`); schema doc if the project keeps one (else null).

## Step 2 — Store the key (never commit, never echo)

Write `TARGET/.env` (create if absent) with:

```
LINEAR_API_KEY="lin_api_…"
```

Ensure `.env` is gitignored — append `KIT/templates/gitignore.snippet` contents to `TARGET/.gitignore` (dedupe lines already present). Verify: `git -C TARGET check-ignore .env` must print `.env`. Load it for the commands below: `set -a && . ./.env && set +a`.

## Step 3 — Verify connectivity

```bash
node "KIT/scripts/linear.mjs" whoami
```

Confirm the viewer + that the target team appears. If the team is missing, the key lacks access — stop and tell the user.

## Step 4 — Create the board statuses + labels (idempotent)

```bash
node "KIT/scripts/linear.mjs" setup-team "<Team>"
```

Creates `Spec`, `Dev`, `QA`, `Signoff`, `Ship`, `Archived`, and the workflow labels if missing (see `docs/linear-rules.md`). Safe to re-run.

## Step 5 — Resolve the project id

```bash
node "KIT/scripts/linear.mjs" ensure-project "<Team>" "<Project>"
```

Copy the printed `projectId` for the config.

For an existing pre-rename board, pause auto-sweep, merge the code update first, then rename legacy columns in place before reactivating:

```bash
node "KIT/scripts/linear.mjs" rename-states "<projectId>"
node "KIT/scripts/linear-watch.mjs" tick --dry-run
```

## Step 6 — Install the skills

Copy the sweep skill folders and manual unblock skill into the target's Claude Code skills dir:

```bash
mkdir -p "TARGET/.claude/skills"
cp -R "KIT/skills/spec-sweep" "KIT/skills/dev-sweep" "KIT/skills/qa-sweep" "KIT/skills/ship-sweep" "KIT/skills/unblock-sweep" "TARGET/.claude/skills/"
```

Claude Code discovers these natively. (For Codex, Step 8 wires them via AGENTS.md.)

## Step 7 — Write the repo config

Copy `KIT/templates/linear-sweep.json` to `TARGET/.claude/linear-sweep.json` and fill every `<placeholder>` from Steps 1 + 5 (teamName, teamKey, project, projectId, issuePrefix, repos, deploy, canonicalDocs, credentialsNote). For a project whose cards have different primary repos, copy `$example_repoRouting` to `repoRouting`, replace its label/repo pairs, and ensure each value exactly matches one `repos` entry. Remove the example block for a single-repo project. This file is what makes the skills project-agnostic.

If `TARGET/.gitignore` has a broad `.claude/*` ignore, make sure `!.claude/skills/` and `!.claude/linear-sweep.json` are present (the gitignore snippet includes them) so the skills + config are tracked.

## Step 8 — Wire Codex (AGENTS.md adapter)

Append `KIT/templates/AGENTS.snippet.md` to `TARGET/AGENTS.md` (create `AGENTS.md` at the repo root if it doesn't exist). Replace `<TEAM>`, `<KEY>`, `<PROJECT>`, `<DEPLOY>` to match the config. This is how **Codex** finds the sweeps (it auto-loads `AGENTS.md`; it does not scan `.claude/skills/`). The snippet also installs the coding workflow guardrail: use `andrej-karpathy-skill` before code-writing/review/debug/refactor work, or apply its core checks manually if the skill is unavailable.

If the user will run `dev-sweep` under Codex, ensure `~/.codex/config.toml` has multi-agent support enabled. Preserve any existing `[features]` entries and add the missing key yourself:

```toml
[features]
multi_agent = true
```

Verify it is present before continuing:

```bash
grep -A20 '^\[features\]' ~/.codex/config.toml | grep '^multi_agent = true'
```

Verify the adapter includes the coding workflow guardrail:

```bash
grep -q 'andrej-karpathy-skill' TARGET/AGENTS.md
grep -q 'Coding workflow' TARGET/AGENTS.md
```

## Step 9 — Commit

Stage selectively (never `git add -A`): `.claude/skills/`, `.claude/linear-sweep.json`, `AGENTS.md`, `.gitignore`. **Do not stage `.env`.** Commit with a clear message. Don't push unless asked.

## Step 10 — Tell the user how to run it

- **Claude Code:** the skills auto-register — say "run the spec sweep" / "run the dev sweep" / "run the QA sweep" (or "spec the Spec cards", etc.).
- **Codex** (working in this repo): same natural-language phrases — Codex reads the AGENTS.md "Board sweeps" section and follows the named `SKILL.md`. Needs `LINEAR_API_KEY` in its env and `multi_agent = true` for dev-sweep; Step 8 should already have enabled it.
- **Manual unblock:** say "run the unblock sweep" when blocked cards need your input. It is interactive, never scheduled, and removes blocking labels only after you choose a resolution.
- Point them at `docs/linear-rules.md` for the board taxonomy, and remind them: **create cards for the actual features/bugs** and let the sweeps carry them across the board.
- **Manual/non-sweep cards:** when an agent creates or moves a card during a direct user conversation, or from any non-sweep skill, add `sweep:manual-only` unless the user explicitly wants the scheduled sweeps to pick it up. This keeps launchd from racing user-directed work. Clear `sweep:manual-only` only when handing the card back to the normal sweep pipeline.

## Step 11 — Auto-sweep triggering (run the sweeps automatically)

This makes the sweeps fire on a schedule when cards land in a queue, instead of you invoking them by hand. It runs on **one always-on machine** (e.g. a Mac mini). If the user only wants manual invocation, skip this step and tell them the natural-language phrases from Step 10. Full design + rationale: `KIT/docs/superpowers/specs/2026-07-08-auto-sweep-launcher-design.md`.

**Do this step only on the always-on machine.** If you're not sure this is that machine, ask the user before installing launchd. Every command below is idempotent — safe to re-run.

**Concepts you need (read once):**
- **Workspace** = one Linear project ↔ one **anchor repo** (the repo holding `.claude/linear-sweep.json`, i.e. `TARGET`) plus any sibling repos it lists in `config.repos`. One anchor per project.
- **Activation** = a Linear **project label `auto-sweep`**. The launcher only sweeps a registered anchor whose project carries that label. `activate`/`deactivate` toggle it via the API.
- **Manual-only issue label** = `sweep:manual-only`. Use it on cards created or moved by direct user conversations and non-sweep skills unless the card is meant to enter the unattended queue immediately. The scheduled launcher skips these cards in every sweep; `unblock-sweep` can clear the label after a human chooses to resume automation.
- **Dependency gate** = a `blockedBy` relation releases only when every blocker is in exact canonical `Done`; other completed-type states do not release it. The launcher checks before and during claim, and every scheduled child runs `node "$AUTO_SWEEP_KIT_PATH/scripts/linear.mjs" dependency-status "$AUTO_SWEEP_ISSUE"` before material work. Use a relation alone for a separate prerequisite: never add `blocked:needs-user` merely because a `blockedBy` relation exists.
- **Claim rollout gate** = run `node scripts/linear-watch.mjs claim-migration-status --json` on the launcher host. It read-only scans every registered workspace, complete-hydrates claim history, and exits nonzero for legacy labels, orphan declarations, ambiguous history, unreadable workspaces, or other non-rollout-safe epochs. Ownership is first-declaration-wins from `[auto-sweep-claim v1 ...]`; `AUTO_SWEEP_OWNER_TOKEN` and `AUTO_SWEEP_CLAIM_DECLARATION` are separate, heartbeats are liveness only, and every label/state release closes and verifies the exact declaration before mutation. Drain active legacy workers or use the launcher's attended reset path; never invent declarations for old labels. During rollback, pause launchers and close/reset declarations before installing any version that still treats heartbeat owners as authority.
- **`ANCHOR`** below = the absolute path to `TARGET` (the source anchor repo). Registration creates managed workspace metadata under `~/.local/share/linear-board-sweeps/workspaces/<anchor>/`. Repeat this step's register/activate for each anchor if the user runs several projects on this machine.

1. **Ensure runtime selection exists** in `ANCHOR/.claude/linear-sweep.json`. If it was copied from the template (Step 7) it already has this. If not, add:
   ```jsonc
   "runtime": "codex",                       // legacy fallback when runtimes.<sweep> is absent
   "models": {
     "spec": { "model": "gpt-5.6-sol", "effort": "high" },
     "dev":  { "model": "gpt-5.6-terra", "effort": "high" },
     "qa":   { "model": "gpt-5.6-sol", "effort": "medium" },
     "ship": { "model": "gpt-5.6-terra", "effort": "medium" }
   },
   "runtimes": {
     "spec":   { "runtime": "codex",  "model": "gpt-5.6-sol", "effort": "high" },
     "dev":    { "runtime": "codex",  "model": "gpt-5.6-terra", "effort": "high" },
     "review": { "runtime": "claude", "model": "claude-opus-4-8" },
     "qa":     { "runtime": "codex",  "model": "gpt-5.6-sol", "effort": "medium" },
     "ship":   { "runtime": "codex",  "model": "gpt-5.6-terra", "effort": "medium" }
   },
   "parallel": {
     "maxNonShipDispatches": 2,
     "maxDrainPasses": 5,
     "maxSameRepoRefillDispatches": 8,
     "maxHandoffTriggerHops": 2,
     "sameRepoCardLimits": {
       "spec": 4,
       "dev": 4,
       "qa": 1,
       "ship": 1
     }
   },
   "fastPath": {
     "enabled": true,
     "maxChangedFiles": 2,
     "maxDiffLines": 80,
     "allowedLabels": ["bug", "chore", "docs"],
     "disallowedLabels": ["auth", "security", "data", "frontend", "design", "ui", "api", "cli", "sdk", "integration", "research", "performance"],
     "requireReviewerConfidence": "high"
   }
   ```
   The launcher resolves `runtimes.<sweep>` first, then legacy `runtime` + `models.<sweep>`, then Codex defaults. The default scheduled sweeps use Codex so unattended launchd ticks do not depend on a separate Claude login; only switch a scheduled sweep to Claude after confirming that `claude` is installed, logged in, and usable non-interactively. Use explicit supported best-model overrides so scheduled sweeps do not silently drift with runtime defaults. `runtimes.review` is a reviewer role preference for the sweep instructions, not a scheduled stage.
   Executable preflight then resolves the matching `CODEX_BIN` or `CLAUDE_BIN` override, `PATH`, the ChatGPT.app bundled Codex, the legacy Codex.app bundle, and otherwise must fail before claim. The last two fallbacks apply to Codex; a configured Claude runtime needs its override or `PATH` entry.
   The default `parallel.maxNonShipDispatches` is `2`, giving the launcher bounded non-ship parallelism across workspace/stage candidates. Distinct Spec, Dev, and QA candidates from one registered workspace may run together; resolved repository overlap is rejected only across different registered workspaces. Ship is highest priority but does not consume this budget or suppress other stages; at most one Ship child runs per registered source workspace. `parallel.sameRepoCardLimits` controls active per-card slots inside each selected non-ship workspace/stage candidate; defaults are spec/dev `4`, QA `1`, and Ship forced to one card per workspace. `parallel.maxSameRepoRefillDispatches` defaults to `8` and is clamped to `0..20`; it caps mid-batch completion backfills, including same-primary-repo Spec/Dev/QA refill and workspace-scoped Ship refill across routed repos, and `0` disables refill. A completed Ship child can therefore admit the next eligible Ship card from its source workspace without waiting for unrelated children, whether that card arrived through human approval or valid commit-bound QA auto-promotion, while the admission queue preserves the one-Ship-per-workspace limit. `parallel.maxDrainPasses` defaults to `5` and is clamped to `1..5`, so after dispatched passes the launcher can re-check queues up to four times for cards that arrived while the sweep was running. Set `maxNonShipDispatches`, `maxSameRepoRefillDispatches`, or `maxDrainPasses` to `1` for stricter bounded mode on smaller machines.
   `parallel.maxHandoffTriggerHops` defaults to `2` and is clamped to `0..3`: successful spec→dev and dev→QA handoffs may continue immediately for the same card in the same supervised launcher run. Set it to `0` to disable immediate handoffs. A parent tick spends at most `parallel.maxNonShipDispatches` handoff dispatch slots, while completion refill has its own `parallel.maxSameRepoRefillDispatches` budget. QA can select `Signoff` or `Ship` after testing, but no immediate QA-to-Ship launcher handoff is added; Ship is never handoff-triggered.
   Launcher-registry `capacity.maxActiveChildren` defaults to exactly `10` and clamps to `1..32`. This host-wide ceiling covers initial, refill, and handoff top-level scheduled children across all registered anchors and surviving ledger entries after a launcher restart; the repo-local `parallel.*` values above create demand beneath it. It does not count reviewer subagents spawned inside those children. The installer adds the default to legacy registries while preserving their other fields.
   `fastPath.enabled` defaults true so dev-sweep can bind tiny, high-confidence eligibility to the reviewed full origin SHA. Commit-bound QA-to-Ship automatic routing occurs only after full QA when the final origin SHA is unchanged; all other passing cards follow `QA` → `Signoff` → human approval → `Ship`. `fastPath.enabled: false` or `requireShipApproval: true` always preserves `Signoff`. `qa-sweep` never merges or deploys, and ship-sweep remains the single-runner production path.

2. **Install the launcher** (creates/updates a managed clean kit clone under `~/.local/share/linear-board-sweeps/kit`, symlinks the wrapper, materializes the launchd plist, and points `registry.json` at that managed clone — does NOT activate the schedule):
   ```bash
   "KIT/scripts/install-watch.sh"
   ```

3. **Register the anchor.** The installer already wired `kitPath`/`kitRemote`; registration adds the source workspace anchor and managed clone paths:
   ```bash
   node "KIT/scripts/linear-watch.mjs" register "ANCHOR"
   ```
   Source checkout dirtiness is advisory after this point; scheduled dispatch runs from managed clones populated from origin. Unpushed local commits are not visible to unattended sweeps.

   **Optional Factory Learning.** Leave the template's repo-local `learning.enabled: false` for the default disabled behavior. To opt this workspace in, set it to `true` and choose any of the three lens `enabled` flags. Observation does not depend on the project's delivery `auto-sweep` label. Re-run `node "KIT/scripts/linear.mjs" setup-team "<Team>"` after upgrading so `factory:learning-generated` exists.

   On exactly one learning host, edit `~/.config/linear-board-sweeps/registry.json` and merge this machine-local block; use the canonical path of a registered source anchor and never commit this registry:

   ```json
   "learning": {
     "enabled": true,
     "runner": true,
     "coreSourceAnchor": "/canonical/registered/core-anchor",
     "maxNewCardsPerRun": 6,
     "runtime": null
   }
   ```

   Keep `runner: false` on every other host. The core anchor receives findings whose ownership spans workspaces; proven local findings stay in their workspace. If the core workspace uses `repoRouting`, its anchor repo must be the target of exactly one `repoRouting.byLabel` label; without routing, the anchor must be the default first `repos` entry. Missing or ambiguous core ownership fails closed. Deterministic code owns confidence, routing, admission, mutation, and outcomes. Optional model synthesis runs in an isolated temporary directory with an allowlisted environment and cannot access Linear credentials or mutate repositories.

4. **Activate the project** (adds the `auto-sweep` label via the API; creates the label if it doesn't exist yet):
   ```bash
   node "KIT/scripts/linear-watch.mjs" activate "ANCHOR"
   node "KIT/scripts/linear-watch.mjs" list        # each anchor → projectId + [auto-sweep: ON]
   ```

5. **Validate the host and managed workspace**:
   ```bash
   node "KIT/scripts/linear-watch.mjs" doctor
   node "KIT/scripts/linear-watch.mjs" doctor --json
   ```
   `doctor` reports the registry path, host/user, managed kit path, source and managed anchor paths, env-file presence, dirty source advisory status, dirty managed dispatch blockers, runtime resolution, capacity active/max/high-water, current-tick failures, dependency/capacity deferred counts, load, free memory, and persistent current-backlog queue p50/p90 from `observations.json`. Its learning block reports per-lens last success/due/sample/pending/error state, coverage gaps, active/due evaluations, and synthesis availability. A learning error is isolated from ordinary sweep health. Optional macOS memory-pressure percentage is shown separately from free bytes.

6. **Dry-run against the live board** (spends NO tokens — logs the dispatch it *would* make, per active workspace/sweep):
   ```bash
   node "KIT/scripts/linear-watch.mjs" tick --dry-run
   tail -n 40 ~/.local/state/linear-board-sweeps/*/*/$(date +%Y%m%d).log
   ```
   Expect the anchor's project to read active and real actionable counts. If it reads "paused", activation didn't take — re-check step 4. With `parallel.maxNonShipDispatches > 1`, dry-run logs every non-ship dispatch selected for the bounded batch. With `parallel.sameRepoCardLimits`, dry-run also logs the exact card slots it would claim and dispatch without writing claim labels. `parallel.maxSameRepoRefillDispatches` is visible in live `refill-trigger` / `refill-skip` logs after a child completes; dry-run cannot simulate that mid-batch completion. With `parallel.maxDrainPasses > 1`, dry-run can show repeated bounded pass logs without launching agents.

   If Factory Learning is enabled, validate it separately:

   ```bash
   node "KIT/scripts/linear-watch.mjs" learning-status --json
   node "KIT/scripts/linear-watch.mjs" learning-run --dry-run
   ```

   Both are read-only; the dry-run prints deterministic proposed creates, updates, and due evaluations with no Linear writes or cursor movement. A live attended `learning-run` requires this host's `learning.runner: true`. Generated cards land at the bottom of Spec without `sweep:manual-only`, must pass real QA and Signoff, and still require a human move to Ship. Disable repo-local `learning.enabled`, or set registry `learning.enabled`/`runner` false, as the kill switch.

7. **Activate the schedule** (10-min timer) and confirm health:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.linear-board-sweeps.watch.plist
   node "KIT/scripts/linear-watch.mjs" health      # reads current-tick.json or the last completed tick
   ```
   Stop later with `launchctl bootout gui/$(id -u)/com.linear-board-sweeps.watch`. Pause one project without stopping the launcher: `node "KIT/scripts/linear-watch.mjs" deactivate "ANCHOR"`.

### Upgrade existing registered anchors

Run this attended on the always-on host. Stop the timer, update the kit, and use `node "KIT/scripts/linear-watch.mjs" list` to enumerate every registered `ANCHOR`. For each listed anchor, set `ANCHOR` to its absolute source path and run:

```bash
for SWEEP in spec dev qa ship unblock; do
  mkdir -p "$ANCHOR/.claude/skills/$SWEEP-sweep"
  cp "$KIT/skills/$SWEEP-sweep/SKILL.md" "$ANCHOR/.claude/skills/$SWEEP-sweep/SKILL.md"
  cmp "$KIT/skills/$SWEEP-sweep/SKILL.md" "$ANCHOR/.claude/skills/$SWEEP-sweep/SKILL.md"
done
```

Verify the anchor's existing `AGENTS.md` contains the exact-`Done` dependency preflight and relation-only label rule; edit only that managed Board sweeps section and preserve unrelated user instructions. Review, commit, and push those exact skill/AGENTS changes in each anchor before resuming its schedule. Re-run `KIT/scripts/install-watch.sh` once on the host to migrate the registry to `capacity.maxActiveChildren: 10` without dropping existing settings.

Before restarting launchd, run `doctor`, `doctor --json`, and `tick --dry-run` from the updated kit. `health` uses `current-tick.json`, so a live process with systemic current tick failures remains red. The resource and queue metrics are evidence only: the launcher does not auto-throttle. Keep the ten-minute interval and default capacity for a 24-hour observation before tuning the ceiling or repo-local slots.

Perform a one-time dry-run audit for each project returned by `list`: in Linear, filter for `blocked:needs-user`, then report only cards that also have a current visible `blockedBy` relation. Require attended confirmation and direct provenance in issue history/comments that the label merely mirrored that still-current relation and that no later human request reused the label before removing it. Preserve ambiguous labels. This audit is limited to current visible relations: bounded cycle detection and cross-team token visibility mean it is not an organization-wide guarantee. Do not infer an invisible relation, reconstruct a removed relation, or bulk-delete labels.

**Managed workspace notes.** Scheduled sweeps clone/fetch/ff-only every configured repo in `config.repos` into one managed workspace root. Label routing pairs source and managed clones by config index; scheduled children receive the managed config owner as `AUTO_SWEEP_ANCHOR`, the selected primary clone as `AUTO_SWEEP_REPO`, its source as `AUTO_SWEEP_SOURCE_REPO`, and a worktree below it as `AUTO_SWEEP_WORKTREE`. The single workspace config stays at `$AUTO_SWEEP_ANCHOR/.claude/linear-sweep.json`; sibling repos do not need copies. `.env` is copied only when it exists in the source repo and is gitignored there, then written in the managed clone with mode `0600`. Screenshots, logs, browser profiles, and temporary files should use the launcher-provided `AUTO_SWEEP_LOG_DIR`, `AUTO_SWEEP_TMPDIR`, `AUTO_SWEEP_SCREENSHOT_DIR`, and `AUTO_SWEEP_BROWSER_PROFILE_DIR` paths under state/cache directories, not repo roots.

**Scheduling caution — decide before activating.** `qa-sweep` never merges or deploys, but it can fix UX bugs, push review branches, and move an unchanged eligible card into `Ship` after full QA. `ship-sweep` is the only production merge/deploy path and runs from `Ship`; the normal path still uses the human-gated `Ship` column, while the commit-bound fast path is automatic only when explicit approval is disabled. Pin ship dispatch to one host with `node "KIT/scripts/linear-watch.mjs" ship-runner on` before relying on scheduled shipping.

**If this is NOT the always-on machine** (or the user only wants manual runs): skip Step 11 entirely. The sweeps still work on demand via the Step 10 phrases; another machine can pick up any card because all work flows through origin (see each SKILL.md's "Machine-independence & handoff" section).

## Verify (before declaring done)

- `git -C TARGET check-ignore .env` prints `.env` (key is safe).
- `TARGET/.claude/linear-sweep.json` has a real `projectId` and no `<placeholders>`.
- `TARGET/.claude/skills/{spec,dev,qa,ship}-sweep/SKILL.md` and `TARGET/.claude/skills/unblock-sweep/SKILL.md` exist.
- `TARGET/AGENTS.md` contains the "Board sweeps" section with real values and the `andrej-karpathy-skill` coding workflow guardrail.
- `node KIT/scripts/linear.mjs whoami` succeeds with the target's `.env` loaded.

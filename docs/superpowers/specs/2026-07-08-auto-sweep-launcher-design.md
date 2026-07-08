# Auto-sweep launcher — design

**Date:** 2026-07-08
**Status:** Approved design, pre-implementation (hardened after `/plan-eng-review`: heartbeat-based reaping, shared push discipline, bounce-loop stop, worktree reconciliation, test suite, launcher liveness)
**Scope:** Add a launcher to the `linear-board-sweeps` kit so the three sweeps run automatically when cards land in their queues, across multiple workspaces on a single Mac mini — while keeping all work and tooling machine-independent (recoverable from origin) and self-updating from the kit's GitHub.

## Problem

Today the three sweeps (spec / dev / qa) are pull-based batch processors invoked by hand ("run the dev sweep") or on an ad-hoc schedule. The user wants:

1. Sweeps to fire when a card moves into the corresponding Linear status, for a growing set of projects on one always-on Mac mini, **without burning LLM tokens on empty polls**.
2. Cards to never get permanently stuck when a Claude/Codex session crashes mid-card.
3. **Machine independence:** any card at rest must be resumable on another machine — nothing important trapped in one machine's local state.
4. **Self-updating skills:** installed skills should track improvements published to the kit's GitHub.

## Domain model (corrected)

The unit the board operates on is **not** a single git repo:

- **One Linear project ↔ one workspace ↔ N sibling git repos.** A *workspace* is a container folder (e.g. `SafeTaper Apps/`) that itself is usually **not** a git repo; it holds several independent git repos, each with its own GitHub origin (`safetaper-admin`, `safetaper-coach`, `safetaper-client-portal`, …).
- **Anchor repo:** exactly one repo in the workspace holds `.claude/linear-sweep.json` + the installed skills (SafeTaper: `safetaper-admin`). The launcher sets the agent's working directory to the anchor (like `codex exec --cd safetaper-admin`); the skills then reach sibling repos as needed.
- **`config.repos`** in `linear-sweep.json` is an **array** of the repos the sweeps may touch, resolved as folder names under the **workspace root** (= the anchor's parent directory), with an explicit path allowed per entry for repos that live elsewhere.
- A single card may produce work (branches/commits) in **several** of the workspace's repos.

This matches the kit's existing skills, which already say "operate within `config.project` … Repos: `config.repos`" and pick "the correct repo from `config.repos`." The launcher generalizes cleanly: it schedules one project = one anchor, and the agent spans that anchor's `config.repos`.

## Constraints & key facts

- A sweep is a **heavyweight, stateful, local run** (git worktrees, push credentials, dev server, code review). It needs a live machine with the repos checked out. No cloud function substitutes for it, so *something* always-on must exist on the Mac mini regardless of trigger mechanism.
- The sweeps are already **idempotent, bounded, claim-based** and self-select cards by status. "Trigger on move" is therefore a *launcher* problem — deciding **when** to invoke unchanged sweeps — not a rewrite.
- The tooling already travels through origin: **skills + `linear-sweep.json` are committed into the anchor repo** (SETUP Step 6 `cp -R`, Step 9 stage/commit; the gitignore snippet un-ignores them). Only `.env` (the Linear key) is machine-local. A fresh clone of the workspace's repos on another machine has the tooling; it needs only its own `.env`.
- The dev branch is **already pushed** on → In Review, and branch names are **deterministic from the card id** (`<PREFIX>-###`). That is most of a handoff mechanism; it just needs to become an explicit invariant across every transition and every repo.
- **Verified against the live Linear API (2026-07-08):** projects support labels (`Project.labels`) and `projects(filter:{ labels:{ name:{ eq:"auto-sweep" } } })` filters server-side — one cheap query returns exactly the active projects.
- **Prior art:** `SafeTaper Apps/safetaper-admin/ops/scheduler/` implements a single-workspace version (parameterized zsh wrapper + Python pre-flight reaper + launchd plists). This design ports its proven ideas to the kit in Node, generalizes to multiple workspaces, and fixes its age-based lock-reclaim bug.

## Non-goals (YAGNI)

- True webhook / zero-latency triggering (needs public ingress + always-on host; ~10-min polling latency is harmless for heavyweight runs).
- Parallel sweep execution (start strictly one-agent-at-a-time; revisit only if backlog demands it).
- Multi-project-per-workspace (one workspace = one Linear project = one anchor).
- Any change to the sweeps' *decision* logic — only additive guardrails (push-on-transition, worktree reconstruction/reconciliation, fetch-in-preflight, heartbeat, state re-read before terminal move, bounce-loop stop).

## Guiding principle

**Origin is the single source of truth — for work state *and* for tooling.** The only thing allowed to be machine-local is a card *actively* In Progress (its uncommitted WIP). Everything else — completed/paused work, spec docs, skill versions — lives on origin, so any machine can pick up any card.

## Architecture

One new zero-dependency Node engine, `scripts/linear-watch.mjs` (sibling to `scripts/linear.mjs`), driven by a thin zsh wrapper under launchd.

```
launchd (StartInterval 600s)
   └─▶ scripts/linear-watch.sh              # sets PATH for launchd's minimal env
         └─▶ node scripts/linear-watch.mjs tick
               0. UPDATE   (ff-only pull of the kit; refresh anchor skills)   [cheap]
               1. read registry → anchor paths
               2. read each anchor's .claude/linear-sweep.json + .env
               3. ONE query per distinct Linear key:
                    projects labeled `auto-sweep` → active projectIds        [cheap]
               4. active = registry ∩ labeled  (warn on mismatches)
               5. for each active workspace × sweep(spec,dev,qa):
                      REAP  stale claims        (unstick crashed cards)       [cheap]
                      COUNT actionable cards    (launch gate; paginated)      [cheap]
               6. dispatch AT MOST ONE agent pass (foreground, cwd = anchor)
               7. write last-successful-tick heartbeat, then exit
```

Steps 0–5 + 7 are local file reads + cheap Linear GraphQL calls + a fast-forward git pull — **no LLM**. An idle board costs a few API calls per tick and zero tokens. Tokens are spent only in step 6, only when a queue holds genuinely actionable work. `tick --dry-run` runs 0–5 and **logs the dispatch it would make without spending a token** — use it to validate the gate against a live board before activating.

### Component boundaries

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `linear-watch.mjs register/unregister/list` | Maintain the registry (anchor-path address book) | registry file, anchor's config |
| `linear-watch.mjs tick [--dry-run]` | One scheduled pass: update, resolve active workspaces, reap, count, dispatch one, write heartbeat | registry, Linear API, per-anchor `.env`, kit clone, runtime CLI |
| updater (internal) | ff-only pull kit; refresh + commit + push anchor skills (to `main`) if newer; log kit diff | kit clone, anchor repo git |
| reaper (internal) | Release claims stale by **heartbeat age**; escalate crash-loop and bounce-loop poison cards | Linear API |
| pre-flight counter (internal) | Count actionable cards per `(workspace, sweep)`, paginated | Linear API |
| dispatcher (internal) | Build + run the runtime command for one pass, cwd = anchor | per-anchor `runtime`, the sweep SKILL |
| Linear client (shared) | `gql()` + team/label resolution — **imported from `linear.mjs`**, not reimplemented | Linear API |
| `linear-watch.sh` | launchd env shim (PATH), invokes `tick` | node |
| `install-watch.sh` | Symlink wrapper, copy plist, print activation command | — |
| launchd plist | Fire `tick` every 600s | wrapper |

Each unit is independently testable (see Testing): `register`/`list` are pure registry ops; the reaper, counter, command-builder, workspace resolution, PID-lock, and updater are pure functions of their inputs; `tick`/`tick --dry-run` run by hand and are watched in the log. The Linear client is shared with `linear.mjs` so there is one API layer to maintain.

## Tracking & activation

### Registry (anchor-path resolution only)

`~/.config/linear-board-sweeps/registry.json` — machine-level, deliberately **outside** the versioned kit so local layout never leaks into a portable repo:

```json
{
  "autoUpdate": true,
  "kitPath": "/Users/teacher/code/linear-board-sweeps",
  "kitRef": "main",
  "repos": ["/Users/teacher/code/SafeTaper Apps/safetaper-admin"]
}
```

- `repos` holds **anchor repo paths** (the repo that contains `.claude/linear-sweep.json`), one per workspace/project.
- `register <path>` validates `<path>/.claude/linear-sweep.json` exists, then appends (dedup) the absolute path.
- `unregister <path>` removes it; `list` prints each anchor, its resolved projectId, and whether it currently carries the `auto-sweep` label.
- `kitPath` / `kitRef` / `autoUpdate` drive the updater (below).

The registry stores **only paths + update settings**. projectId, team, prefix, runtime, and `config.repos` are read fresh from each anchor's own `linear-sweep.json` at tick time — single source of truth, no duplication.

### Workspace resolution

For a registered anchor at `<anchor>`, the **workspace root** is `dirname(<anchor>)`. Each entry in `config.repos` resolves to `<workspaceRoot>/<entry>`, unless the entry is itself an absolute or explicitly-relative path (then used as-is). The agent runs with cwd = `<anchor>`; the skills reach the resolved sibling repos.

### Activation (the on/off switch)

A Linear **project label `auto-sweep`**. A project is swept iff its anchor is **registered** *and* the project is **labeled** `auto-sweep`. Toggling the label in the Linear UI activates/pauses a project without touching the Mac mini. The launcher logs a warning when a labeled project has no registered anchor, or a registered anchor's project lacks the label, so drift is visible.

**API-support fallback:** project labels are verified to exist. If a future Linear change breaks the filter, the fallback is a sentinel issue-label or a local `"autoSweep": true` flag per anchor (which loses toggle-from-Linear). Not needed now.

## Machine-independence & handoff

**Invariant: a card at rest in any status has all its artifacts on origin — in every repo it touched.** "At rest" = not actively being worked this instant. Three additive guardrails across the skills implement it:

1. **Push before every status change *and* every block/hand-off, for every touched repo** — using the **shared push discipline** (below).
   - spec-sweep commits + pushes spec/plan docs to the **anchor repo's `main`** before → Ready for Dev (docs land on main so any machine's dev-sweep sees them immediately; additive files, no conflict with feature branches).
   - dev-sweep pushes the `<PREFIX>-###` branch in **each** touched repo before → In Review *and* before leaving a `blocked:needs-user` card (partial work is recoverable elsewhere).
   - qa-sweep's merge is already pushed; it pushes every repo it merged.
2. **Re-read the card before the terminal move.** Right before any status transition, re-fetch the card and confirm it is still in the state the run claimed. If a human (or another process) moved it out from under the run, **do not override** — comment what was built and where the branch is, release the claim, and stop. The claim label stops another *sweep*; this stops the run from clobbering a human's concurrent move.
3. **Worktree = reconstruct-and-reconcile, never assume-clean.** Worktrees are the one genuinely machine-local git artifact — disposable caches; the branch is the truth. On picking up an In Progress / In Review card, the skill runs `git fetch` in each candidate repo, then:
   - **No local worktree** but `origin/<PREFIX>-###` exists → rebuild it at the **deterministic path** `<repo>/.worktrees/<PREFIX>-###`: `git worktree add <repo>/.worktrees/<PREFIX>-### <PREFIX>-###` tracking the remote branch.
   - **Local worktree exists** (a prior crashed run on this machine left it, possibly dirty) → reconcile before working: reset it to `origin/<PREFIX>-###` (`git reset --hard`), discarding stranded uncommitted WIP that never reached origin. Never resume on top of an unknown dirty tree.
   Because the branch name derives from the card and the path is deterministic, any machine reconstructs (or reconciles) the exact worktrees from the card alone, and there is never a path collision or an already-checked-out conflict.
4. **Prune stale worktrees across the workspace.** After QA merges/deletes branches, other machines may hold local worktrees for now-gone remote branches; each sweep's preflight prunes worktrees whose upstream branch is gone (`git worktree prune` + gone-branch detection) in every repo it manages.

**Shared push discipline (one routine, every push).** Every push the design adds — spec docs to `main`, dev branches, WIP checkpoints, qa merges, and the auto-updater's skills commit — goes through the same routine: `git fetch`, replay/rebase the local commits onto the updated remote ref, then push; on a non-fast-forward rejection retry up to **2×**; on final failure **log + comment on the card + skip** (never force-push). This is what keeps an unattended launcher self-healing when a human pushes the same branch from a laptop between the fetch and the push, instead of wedging silently.

**Allowed machine-local state:** a card *actively* In Progress may have uncommitted WIP in one machine's worktree. If that session crashes, the reaper releases the claim and another machine resumes **from the last pushed commit** (uncommitted scraps on the dead machine are forfeit — accepted, and reconciled away by guardrail 3). To shrink the loss window, dev-sweep commits + pushes WIP at natural checkpoints (after the build first goes green, before code review), not only at the end.

**Cross-machine reaper safety:** the reaper keys on a **heartbeat** the running sweep refreshes (see Stuck-card handling), not on raw `updatedAt` — so a long, heads-down run that hasn't touched the card is *not* mistaken for a crash by a second machine's reaper. Residual risk: two machines claiming the same unclaimed card in the same instant (Linear has no atomic label compare-and-set). With a single launcher on the Mac mini this is near-zero; the fallback is a harmless duplicate branch push caught as a conflict by the push discipline / at QA. Noted, not engineered around.

## Stuck-card handling

Two complementary guards for two distinct failure modes.

### 1. Local run-lock with PID liveness (guards *live* concurrency)

A **global single-flight tick lock** at `~/.local/state/linear-board-sweeps/tick.lock` stores the launcher **PID**. A subsequent tick reclaims it only when that PID is **dead** (`kill -0` fails) — never merely because it is old.

> This fixes a latent bug in the safetaper prototype, which reclaims its lock purely by age (>90 min): a legitimately long run that crosses the threshold gets a second agent launched on the same workspace. PID-liveness reclaim eliminates that — a crashed run frees the lock immediately; a slow-but-alive run is left alone.

Because dispatch is foreground and one-at-a-time, this single global lock is sufficient; no per-`(workspace, sweep)` local locks are needed.

### 2. Heartbeat + claim reaper (cleans up *after* a crash)

The tick lock dies with the launcher process, but the **Linear claim label** (`<sweep>:in-progress`) that a sweep sets *inside its session* outlives a crashed session — nothing local can prove that remote session is gone. Raw `updatedAt` is a poor liveness signal: a long, heads-down run (a big dev-sweep with subagents) can go >90 min without touching the card and would look crashed to a *second machine's* reaper, causing a false reap → two sessions on one card. So liveness is explicit:

- **Heartbeat:** while a sweep holds a claim, it refreshes a heartbeat on the card every few minutes — the cheapest correct form is re-stamping the claim (removing + re-adding `<sweep>:in-progress`, which bumps the label's `updatedAt`) or writing a hidden `[auto-sweep-heartbeat <ISO8601>]` marker comment it overwrites. The reaper reads **heartbeat age**, not raw card `updatedAt`.
- **Reap:** a card in the sweep's state, still carrying `<sweep>:in-progress`, whose **heartbeat** is older than a per-sweep **stale threshold** → remove the claim label + post an audit comment `[auto-sweep-reaper]`. Actionable again next tick. (Absent a heartbeat — e.g. a session that crashed before its first beat — fall back to claim age.)
- **Escalate (crash-loop):** count `[auto-sweep-reaper]` comments **within a rolling 48h window** (not all-time — three unrelated infra blips weeks apart should not permanently block a card); after **3** reaps in that window, apply `blocked:needs-user` instead of retrying, and **reset the count when the card successfully advances state**. Stop-loss on a card the runtime keeps dying on.
- **Stale thresholds** must exceed the longest *normal* single-card run, but the heartbeat makes them a backstop rather than the primary signal: **spec 30 / dev 90 / qa 120 min** (tunable). Heartbeat interval defaults to ~5 min (≪ any threshold).

### 3. Bounce-loop stop (guards *token spend*, not crashes)

A card can be genuinely picked up yet immediately bounced: dev-sweep moves an under-specified card to "Needs Spec", spec-sweep re-specs it to "Ready for Dev", dev bounces it again. Each lap costs a full agent dispatch on the best model with no crash and no reap, so the crash-loop escalation never fires. Guard it separately: each bounce writes a `[auto-sweep-bounce <from>→<to>]` marker; after **2** round-trips between the same two states, apply `blocked:needs-user` and stop feeding it — a card two sweeps can't agree on needs a human. Same rolling-window + reset-on-advance semantics as the crash-loop counter.

**Why all three:** the PID-lock catches crashes fast on the local side; the heartbeat reaper unsticks the Linear-side label a crashed *remote* session left behind (without false-reaping a live one); the bounce-loop stop caps token spend on a card that oscillates without ever crashing.

**Query completeness:** both the reaper and the counter list issues in the sweep's states. `issues(first: 250)` silently drops cards beyond 250, which would leave a stuck card unreaped or actionable work uncounted. Both queries **paginate via cursor** to completeness (the per-project in-state population is small, so this is a correctness guard, not a hot path).

## Concurrency policy

- **One agent at a time** on the Mac mini. Each tick updates + reaps + counts across *all* active `(workspace, sweep)` pairs (cheap), then dispatches **at most one** agent pass (foreground) and exits.
- **Selection order** when several pairs are actionable: `qa → dev → spec` (push work toward Done first), then the top visible card in the Linear column by `Issue.sortOrder`. Round-robin fairness emerges across ticks.
- During a long foreground dispatch, later launchd fires find the tick lock held (live PID) and exit immediately — reaping pauses for that run's duration, which is fine: an actively-worked card needs no reaping, and other workspaces' stuck cards wait at most one run's length (well under the escalation thresholds).
- Parallelism and background dispatch are deferred; the design leaves room (per-pair locks + a semaphore) but does not build them.

## Per-workspace runtime dispatch

Each anchor's `.claude/linear-sweep.json` gains a runtime + per-sweep model block:

```json
"runtime": "codex",
"models": {
  "spec": { "model": "gpt-5.5-codex", "effort": "high" },
  "dev":  { "model": "gpt-5.5-codex", "effort": "high" },
  "qa":   { "model": "gpt-5.5-codex", "effort": "high" }
}
```

- `runtime` is `"codex"` (default) or `"claude"`. One runtime per workspace; the `models` entries name the model **for that runtime's family** (codex → a Codex/OpenAI model; claude → a Claude model such as `claude-opus-4-8`).
- **Per-sweep tiering** is deliberate: spec / dev / qa have different cost/quality profiles, so each can carry its own `model` + reasoning `effort`. For now all three are set to the best model at high effort (codex: `gpt-5.5-codex` @ high; claude: `claude-opus-4-8` @ high); this leaves room to drop spec/qa to a cheaper tier later without any code change.
- Any entry omitted → fall back to the runtime's own configured default (`~/.codex/config.toml` / Claude Code settings).

The command-builder maps a `(runtime, model, effort)` triple for one unattended pass, cwd = anchor:

- **codex:** `codex exec --cd <anchor> -m <model> -c model_reasoning_effort=<effort> "<prompt>"`
- **claude:** `claude -p "<prompt>" --model <model>` (with `<effort>` mapped to Claude Code's reasoning/thinking control) executed in `<anchor>`

The exact effort flags are confirmed against each CLI during implementation; the config captures the intent (`gpt-5.5-codex`/`claude-opus-4-8` at `high`) and the builder wires it to whatever each runtime exposes. Subagents the sweeps spawn inherit their model from the runtime's own agent config, layered under this main-loop selection.

Prompt (both): *"Unattended scheduled run. Follow the `<sweep>-sweep` skill exactly, perform ONE pass, then stop. Do not ask questions — route them to card comments per the skill."* stdout/stderr → the per-workspace/sweep log.

## Auto-update (origin-propagated, Approach A)

Skills are committed copies in each anchor repo, sourced from a single **kit clone** per machine (`registry.kitPath`). Auto-update reuses origin as the propagation channel — a skill update flows machine-to-machine exactly like work does.

At the top of each tick (lock-guarded, before any dispatch), when `registry.autoUpdate` is true:

1. **Fast-forward the kit clone:** verify the kit clone's `origin` URL matches the expected kit remote (guard against a swapped remote on a high-authority path), then `git -C <kitPath> pull --ff-only origin <kitRef>` (default `kitRef = main`). ff-only means a diverged/dirty kit clone is left alone and logged, never force-updated. **Log the incoming kit diff** (`<oldSHA>..<newSHA>` + changed paths) so every autonomous self-update is auditable after the fact.
2. **Compare versions:** the kit carries a version marker (its `VERSION` file or `git rev-parse HEAD`); each anchor records its installed marker at `.claude/skills/.sweep-version`.
3. **If the kit is newer**, for each registered anchor (skip any with a dirty tree or an in-flight sweep — the lock covers the latter):
   - Re-copy `skills/{spec,dev,qa}-sweep` from the kit into `<anchor>/.claude/skills/`, write the new `.sweep-version`.
   - Commit **to the anchor's `main`, not to whatever branch its primary working tree happens to be on** (operate on `main` explicitly via a dedicated worktree or `git` plumbing — a stray checked-out feature branch must not receive the skills commit), staging **only** `.claude/skills/`, message `chore(sweeps): update skills to <marker>`, then **push** via the shared push discipline.
4. **Log** every version transition, the kit diff, and every skip (dirty tree, non-ff kit, remote-URL mismatch, anchor not on/behind `main`).

**Propagation to other machines:** each sweep's preflight already `git fetch`es the repos it works in (see Handoff); it also fast-forwards the anchor's `main` when clean, so a skills update pushed by the Mac mini is picked up by any other machine on its next run. A dev branch cut before an update simply inherits the newer skills after it merges/rebases — acceptable.

**Launcher self-update comes free:** the wrapper and plist point into the kit clone, so a ff-pulled `linear-watch.mjs` runs on the *next* tick with no extra mechanism. The plist rarely changes; when it does, re-run `install-watch.sh`.

**Safety rails:** expected-remote-URL check before pulling; ff-only pulls; per-tick kit-diff audit log; never modify app code (only `.claude/skills/`); commit only to `main`; never commit over a dirty tree; `autoUpdate: false` kill-switch; `kitRef` pinnable to a tag/SHA later without redesign (default `main` per decision — the one place the design follows a moving ref, so the remote-URL check + diff log are its compensating controls). Every action logged.

## Testing

A launcher with autonomous push, deploy, and token-spend authority must have its safety and gate logic tested — this is cheap here because the core is pure Node with zero deps (`node:test` + a stubbed Linear client). The suite is part of the deliverable, not a follow-up.

Required unit coverage (the first two are non-negotiable — they are the safety mechanism):

1. **PID-liveness lock** — dead PID → reclaimed; live PID → left alone; missing/garbage lock file → treated as free; the exact "long run crossed the old age threshold" case that motivated the fix.
2. **Heartbeat reaper** — fresh heartbeat → not reaped; stale heartbeat → reaped + audit comment; absent heartbeat → claim-age fallback; crash-loop escalation fires at 3-within-48h and **not** on 3-spread-over-weeks; counter resets on state advance; **bounce-loop** escalation fires at 2 round-trips.
3. **Gate / counter** — excludes fresh claims and `blocked:*`; counts genuinely actionable cards; **paginates past 250**.
4. **Command-builder** — `(runtime, model, effort)` → exact argv for codex and claude; omitted model/effort → runtime default (no flag emitted).
5. **Workspace resolution** — `config.repos` as sibling folder names under the anchor's parent; explicit/absolute path entries used as-is; deterministic worktree path derivation.
6. **Registry ops** — `register` validates `.claude/linear-sweep.json` presence, dedups, stores absolute paths; `unregister`/`list`.
7. **Updater** — ff-only (non-ff kit → skip), version compare, dirty-anchor skip, remote-URL-mismatch skip, commits to `main` only.
8. **Push discipline** — non-ff rejection → fetch/rebase/retry ≤2× → skip+comment on final failure (no force-push).

Integration smoke: `tick --dry-run` against a seeded test project asserts the dispatch decision without spending a token.

## Install, logging, files

### New files (in the kit)

- `scripts/linear-watch.mjs` — the engine (`register` / `unregister` / `activate` / `deactivate` / `list` / `tick [--dry-run]` / `health`, with internal update/reap/count/dispatch; imports `linear.mjs`'s Linear client). `register` auto-wires `kitPath`/`kitRemote`; `activate`/`deactivate` toggle the project's `auto-sweep` label via the API (find-or-create the label, then add/remove it from the project) so setup needs no Linear UI step.
- `scripts/linear-watch.sh` — launchd env shim (PATH for node/git/codex/claude), calls `node linear-watch.mjs tick`.
- `scripts/install-watch.sh` — symlink the wrapper to `~/.local/bin`, copy the plist to `~/Library/LaunchAgents`, **print** the `launchctl bootstrap gui/$(id -u) …` command. Never auto-activates.
- `templates/launchd/com.linear-board-sweeps.watch.plist` — `StartInterval 600`, `RunAtLoad false`, stdout/err to `~/.local/state/linear-board-sweeps/`.
- `VERSION` (or rely on the kit's git SHA) — the update marker.

### Edited files

- `templates/linear-sweep.json` — add `"runtime"` + the per-sweep `"models"` block (defaults: `gpt-5.5-codex` @ high per sweep for codex; a `claude`-runtime example showing `claude-opus-4-8` @ high).
- `skills/{spec,dev,qa}-sweep/SKILL.md` — the handoff guardrails (push-on-transition per touched repo via the shared push discipline; re-read card state before the terminal move; fetch + reconstruct/reconcile worktrees at the deterministic path; prune stale worktrees), a periodic heartbeat while a claim is held, and, for dev-sweep, WIP checkpoint pushes.
- `SETUP.md` — a "Triggering / auto-sweep" section: create the `auto-sweep` project label, `register` each anchor, `tick --dry-run` to validate, install + activate the launcher, the `health` check, per-workspace runtime, auto-update settings, and the qa caution below.
- `README.md` — a row in the "What's inside" table for the launcher.
- `docs/linear-rules.md` — document the `auto-sweep` project label as the activation marker.

### Logging & liveness

`~/.local/state/linear-board-sweeps/<anchor-slug>/<sweep>/YYYYMMDD.log`, with >14-day rotation (deleting old logs each tick). Every tick logs: update result + kit diff, workspaces resolved, reaps/bounces performed, actionable counts, and any dispatch (with exit code). This is the cost/behavior audit trail.

**Launcher liveness (guards silent whole-system death).** Everything hinges on one launchd job; if node moves, the key expires, or the plist fails to load, the launcher stops and *no cards move*, with nothing surfaced. So every successful tick writes `~/.local/state/linear-board-sweeps/last-tick` (ISO8601 + git SHA of the kit). `linear-watch.mjs health` reports the age of that stamp (and non-zero-exits if it exceeds, say, 3× the interval) so a trivial external check — or the operator — can tell the difference between "idle, nothing to do" and "dead." A hard failure inside a tick (bad key, unreadable registry) also emits one clearly-tagged `FATAL` log line rather than exiting silently.

## QA-sweep caution

`qa-sweep` **merges and deploys to production** — now across whichever workspace repos a card touched. Per safetaper's deliberate gating, SETUP recommends leaving qa-sweep on manual `launchctl kickstart` (or its own opt-in) per workspace rather than the shared auto-timer, so a prod deploy is never triggered purely by a card moving to "In Review". spec/dev sweeps are safe to auto-run (they never merge or deploy). Operator choice, surfaced in SETUP, not a hard-coded block.

## Tuning knobs (defaults; all easily changed)

| Knob | Default | Notes |
|------|---------|-------|
| Poll interval | 600 s | launchd `StartInterval`; idle ticks are free |
| Heartbeat interval | ~5 min | Running sweep refreshes its claim; ≪ any reap threshold |
| Reap threshold (spec/dev/qa) | 30 / 90 / 120 min | Backstop on heartbeat age; exceeds the longest normal single-card run |
| Crash-loop escalate-after | 3 reaps / 48 h | Then `blocked:needs-user`; resets on state advance |
| Bounce-loop escalate-after | 2 round-trips / 48 h | Then `blocked:needs-user`; resets on state advance |
| Push retry | 2× | fetch/rebase/retry, then skip + comment (never force) |
| Liveness alarm | 3× interval | `health` non-zero-exits past this staleness |
| Dispatches per tick | 1 | One agent at a time |
| Log retention | 14 days | |
| Default runtime | codex | Per-workspace override to claude |
| Model (per sweep) | `gpt-5.5-codex` (codex) / `claude-opus-4-8` (claude) | Per-sweep tiering; unset → runtime default |
| Reasoning effort | high | Per sweep; mapped to each CLI's effort control |
| `kitRef` | `main` | Follow kit main; pinnable to a tag/SHA later |
| `autoUpdate` | true | Registry kill-switch |

## Open questions

None blocking. Project-label API support is verified; workspace model, tracking, concurrency, handoff, and auto-update are decided; the `/plan-eng-review` findings (heartbeat reaping, shared push discipline, state re-read, bounce-loop stop, worktree reconciliation, test suite, launcher liveness, updater-targets-main, pagination, kit-diff audit, `--dry-run`) are folded in. To confirm during implementation, not design: the exact codex/claude effort flags and the GPT-5.5-Codex model string against the installed CLIs. Reap/heartbeat thresholds and interval are best tuned against real runs after landing.

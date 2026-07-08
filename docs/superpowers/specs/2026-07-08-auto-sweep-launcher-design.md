# Auto-sweep launcher — design

**Date:** 2026-07-08
**Status:** Approved design, pre-implementation
**Scope:** Add an event-adjacent launcher to the `linear-board-sweeps` kit so the three sweeps run automatically when cards land in their queues, across multiple repos on a single Mac mini.

## Problem

Today the three sweeps (spec / dev / qa) are pull-based batch processors invoked by hand ("run the dev sweep") or on an ad-hoc schedule. The user wants them to fire when a card is moved into the corresponding Linear status, for a growing set of repos (starting with two) on one always-on Mac mini — without burning LLM tokens on empty polls, and without cards getting permanently stuck when a Claude/Codex session crashes mid-card.

## Constraints & key facts

- A sweep is a **heavyweight, stateful, local run** (git worktrees, push credentials, dev server, code review). It needs a live machine that has the repo checked out. No cloud function can stand in for it. Therefore *something* always-on must exist on the Mac mini regardless of trigger mechanism.
- The sweeps are already **idempotent, bounded, claim-based** batch processors that self-select cards by status. "Trigger on move" is therefore a *launcher* problem — deciding **when** to invoke an unchanged sweep — not a rewrite of the sweeps.
- Each target repo is **self-describing**: its `.claude/linear-sweep.json` holds team/project/prefix/repos, and its gitignored `.env` holds the Linear key. The launcher needs to learn only two things per repo: **where it is on disk** and **whether it is active**.
- A Linear label can express *active*, but not *where the code lives*. Those are two separate questions; the launcher needs both.
- **Verified against the live Linear API (2026-07-08):** projects support labels (`Project.labels`), and `projects(filter:{ labels:{ name:{ eq:"auto-sweep" } } })` filters server-side — one cheap query returns exactly the active projects.
- **Prior art:** `SafeTaper Apps/safetaper-admin/ops/scheduler/` already implements a single-repo version of this (parameterized zsh wrapper + Python pre-flight reaper + launchd plists). This design ports its proven ideas to the kit (in Node, multi-repo) and fixes one latent bug (age-based lock reclaim).

## Non-goals (YAGNI)

- True webhook / zero-latency triggering (needs public ingress + always-on host; ~10-min polling latency is harmless for heavyweight runs).
- Parallel sweep execution across repos (start strictly one-agent-at-a-time; revisit only if backlog demands it).
- Cross-machine coordination beyond what the existing claim labels already provide.
- Any change to the sweep skills' internal logic.

## Architecture

One new zero-dependency Node engine, `scripts/linear-watch.mjs` (sibling to `scripts/linear.mjs`), driven by a thin zsh wrapper under launchd.

```
launchd (StartInterval 600s)
   └─▶ scripts/linear-watch.sh        # sets PATH for launchd's minimal env
         └─▶ node scripts/linear-watch.mjs tick
               1. read registry → repo paths
               2. read each repo's .claude/linear-sweep.json + .env
               3. ONE query per distinct Linear key:
                    projects labeled `auto-sweep` → active projectIds
               4. active = registry ∩ labeled  (warn on mismatches)
               5. for each active repo × sweep(spec,dev,qa):
                      REAP  stale claims        (unstick crashed cards)
                      COUNT actionable cards    (launch gate)
               6. dispatch AT MOST ONE agent pass (foreground), then exit
```

Steps 1–5 are all local file reads + cheap Linear GraphQL calls — **no LLM**. An idle board costs a few API calls per tick and zero tokens. Tokens are spent only in step 6, and only when a queue holds genuinely actionable work.

### Component boundaries

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `linear-watch.mjs register/unregister/list` | Maintain the registry (path address book) | registry file, target repo's config |
| `linear-watch.mjs tick` | One scheduled pass: resolve active repos, reap, count, dispatch one | registry, Linear API, per-repo `.env`, runtime CLI |
| reaper (internal) | Release stale claims; escalate poison cards | Linear API |
| pre-flight counter (internal) | Count actionable cards per `(repo, sweep)` | Linear API |
| dispatcher (internal) | Build + run the runtime command for one pass | per-repo `runtime`, the sweep SKILL |
| `linear-watch.sh` | launchd env shim (PATH), invokes `tick` | node |
| `install-watch.sh` | Symlink wrapper, copy plist, print activation command | — |
| launchd plist | Fire `tick` every 600s | wrapper |

Each unit is independently testable: `register`/`list` are pure registry ops; `tick` can be run by hand (`node scripts/linear-watch.mjs tick`) and watched in the log; reaper and counter are pure functions of Linear state.

## Tracking & activation

### Registry (path resolution only)

`~/.config/linear-board-sweeps/registry.json` — machine-level, deliberately **outside** the versioned kit so local layout never leaks into a portable repo:

```json
{ "repos": ["/Users/teacher/code/project-a", "/Users/teacher/code/project-b"] }
```

- `node scripts/linear-watch.mjs register <path>` — validate `<path>/.claude/linear-sweep.json` exists, then append (dedup) the absolute path.
- `unregister <path>` — remove it.
- `list` — print registered repos and, for each, its resolved projectId + whether it currently carries the `auto-sweep` label.

The registry stores **only paths**. Everything else (projectId, team, prefix, runtime) is read fresh from each repo's own `linear-sweep.json` at tick time — single source of truth, no duplication.

### Activation (the on/off switch)

A Linear **project label `auto-sweep`**. A project is swept iff it is both **registered** (resolvable to a local path) and **labeled** `auto-sweep`. Toggling the label in the Linear UI activates/pauses a project without touching the Mac mini.

**Assumption:** one repo ↔ one Linear project. The launcher logs a warning when a labeled project has no registered repo, or a registered repo's project lacks the label (so drift is visible, not silent).

**API-support fallback:** project labels are verified to exist. If a future Linear change breaks the project-label filter, the fallback is a sentinel issue-label the launcher looks up, or a local `"autoSweep": true` flag per repo (which loses the toggle-from-Linear benefit). Not needed now.

## Stuck-card handling

Two complementary guards, because there are two distinct failure modes.

### 1. Local run-lock with PID liveness (guards *live* concurrency)

A **global single-flight tick lock** at `~/.local/state/linear-board-sweeps/tick.lock` stores the launcher **PID**. A subsequent tick reclaims the lock only when that PID is **dead** (`kill -0` fails) — never merely because it is old.

> This fixes a latent bug in the safetaper prototype: it reclaims its lock purely by age (>90 min), so a legitimately long run that crosses the threshold gets a *second* agent launched on the same repo. PID-liveness reclaim eliminates that: a crashed run frees the lock immediately; a slow-but-alive run is left alone.

Because dispatch is foreground and one-at-a-time, this single global lock is sufficient — no per-`(repo, sweep)` local locks are needed.

### 2. Time-threshold claim reaper (cleans up *after* a crash)

The tick lock dies with the launcher process, but the **Linear claim label** (`<sweep>:in-progress`) that a sweep sets *inside its session* outlives a crashed session — nothing local can prove that remote session is gone. So the reaper runs every tick, per `(repo, sweep)`:

- **Reap:** a card in the sweep's state, still carrying `<sweep>:in-progress`, whose `updatedAt` is older than a per-sweep **stale threshold** → remove the claim label + post an audit comment tagged `[auto-sweep-reaper]`. The card becomes actionable again next tick.
- **Escalate:** count prior `[auto-sweep-reaper]` comments on the card. After **3** auto-releases of the same card, apply `blocked:needs-user` instead of retrying — a card the runtime keeps dying on is a human problem, not a retry problem. This is the stop-loss on poison cards.
- **Stale thresholds** must exceed the longest *normal* single-card run for each sweep. Defaults (tunable): **spec 30 min · dev 90 min · qa 120 min**. `updatedAt` is the idle signal — any real progress (the running session commenting or moving the card) keeps it fresh.

**Why both:** the PID-lock catches crashes fast and precisely on the local side; the claim reaper is the backstop that unsticks the Linear-side label a crashed *remote* session left behind; escalation caps the damage of a card nothing can process.

### Cross-process coordination

A human running a sweep by hand, or a second machine, is coordinated by the **existing claim-label freshness** in the sweeps — not by the tick lock. The reaper never releases a claim whose `updatedAt` is still within the stale threshold, so an actively-worked card is safe.

## Concurrency policy

- **One agent at a time** on the Mac mini. Each tick reaps + counts across *all* active `(repo, sweep)` pairs (cheap), then dispatches **at most one** agent pass (foreground) and exits.
- **Selection order** when several pairs are actionable: `qa → dev → spec` (push work rightward toward Done first), then oldest card first. Round-robin fairness emerges across successive ticks.
- During a long foreground dispatch, subsequent launchd fires find the tick lock held (live PID) and exit immediately — reaping pauses for the duration of that run, which is acceptable: an actively-worked card needs no reaping, and other repos' stuck cards wait at most one run's length (well under the escalation thresholds).
- Parallelism and background dispatch are deferred; the design leaves room for them (per-pair locks + a semaphore) but does not build them.

## Per-repo runtime dispatch

Each repo's `.claude/linear-sweep.json` gains one field:

```json
"runtime": "codex"
```

`"codex"` (default) or `"claude"`. A command-builder maps it for one unattended pass:

- **codex:** `codex exec --cd <repo> "<prompt>"`
- **claude:** `claude -p "<prompt>"` executed in `<repo>`

Prompt (both runtimes): *"Unattended scheduled run. Follow the `<sweep>-sweep` skill exactly, perform ONE pass, then stop. Do not ask questions — route them to card comments per the skill."* stdout/stderr → the per-repo/sweep log.

## Install, logging, files

### New files (in the kit)

- `scripts/linear-watch.mjs` — the engine (`register` / `unregister` / `list` / `tick`).
- `scripts/linear-watch.sh` — launchd env shim (sets PATH for node/git/codex/claude), calls `node linear-watch.mjs tick`.
- `scripts/install-watch.sh` — symlink the wrapper to `~/.local/bin`, copy the plist to `~/Library/LaunchAgents`, **print** the `launchctl bootstrap gui/$(id -u) …` activation command. Never auto-activates.
- `templates/launchd/com.linear-board-sweeps.watch.plist` — `StartInterval 600`, `RunAtLoad false`, stdout/err to `~/.local/state/linear-board-sweeps/`.

### Edited files

- `templates/linear-sweep.json` — add `"runtime": "codex"`.
- `SETUP.md` — a "Triggering / auto-sweep" section: create the `auto-sweep` project label, `register` each repo, install + activate the launcher, per-repo runtime, and the qa caution below.
- `README.md` — a row in the "What's inside" table for the launcher.
- `docs/linear-rules.md` — document the `auto-sweep` project label as the activation marker.

### Logging

`~/.local/state/linear-board-sweeps/<repo-slug>/<sweep>/YYYYMMDD.log`, with >14-day rotation (deleting old logs each tick, per the coach script's pattern). Every tick logs: repos resolved, reaps performed, actionable counts, and any dispatch (with exit code). This is the cost/behavior audit trail.

## QA-sweep caution

`qa-sweep` **merges and deploys to production**. Carried over from safetaper's deliberate gating: SETUP will recommend that qa-sweep be left on manual `launchctl kickstart` (or its own opt-in) per repo rather than the shared auto-timer, so a prod deploy is never triggered purely by a card moving to "In Review". The spec/dev sweeps are safe to auto-run (they never merge or deploy). This is a per-repo operator choice, surfaced in SETUP, not a hard-coded block.

## Tuning knobs (defaults; all easily changed)

| Knob | Default | Notes |
|------|---------|-------|
| Poll interval | 600 s | launchd `StartInterval`; idle ticks are free, so shorter is cheap latency-wise |
| Reap threshold (spec/dev/qa) | 30 / 90 / 120 min | Must exceed the longest normal single-card run |
| Escalate-after | 3 reaps | Then `blocked:needs-user` |
| Dispatches per tick | 1 | One agent at a time |
| Log retention | 14 days | |
| Default runtime | codex | Per-repo override to claude |

## Open questions

None blocking. Project-label API support is verified; runtime, tracking, and concurrency are decided. Reap thresholds and interval are best tuned against real runs after landing.

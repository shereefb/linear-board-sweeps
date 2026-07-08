# linear-board-sweeps

A portable kit that installs a **Linear-driven, cross-runtime (Claude Code + Codex) feature workflow** into any repo. Three autonomous "board sweeps" carry work across a Linear board:

```
Needs Spec ──spec-sweep──▶ Ready for Dev ──dev-sweep──▶ In Review ──qa-sweep──▶ Done
   (docs only)               (code on a worktree,          (smoke-test as a user,
                              review, push, no merge)        fix UX, merge, deploy)
```

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
| `skills/{spec,dev,qa}-sweep/SKILL.md` | The three cross-runtime sweep skills. Project-agnostic — they read `.claude/linear-sweep.json`. |
| `scripts/linear.mjs` | Zero-dependency Linear engine (Node 18+): `whoami`, `setup-team`, `ensure-project`, `create-card`, `query`. |
| `scripts/linear-watch.mjs` | Zero-dependency auto-sweep launcher: `register`/`unregister`, `activate`/`deactivate` (toggle the project label), `list`, `tick [--dry-run]`, `health`. Polls Linear cheaply and dispatches a sweep only when a queue has actionable work — see [Triggering](#triggering-auto-sweep). |
| `scripts/linear-watch.sh` + `scripts/install-watch.sh` + `templates/launchd/…watch.plist` | launchd wrapper, installer, and plist that run the launcher every 10 min on a Mac (mini). |
| `templates/linear-sweep.json` | The per-repo config the skills read. Copied + filled into the target's `.claude/`. |
| `templates/AGENTS.snippet.md` | The "Board sweeps" section appended to the target's `AGENTS.md` — how Codex finds the skills. |
| `templates/gitignore.snippet` | `.env` + `.claude/` tracking rules for the target's `.gitignore`. |
| `docs/linear-rules.md` | The canonical board taxonomy (statuses, labels) + feature-tracking rules. |

## How it stays runtime-agnostic

The `SKILL.md` files speak in **actions** ("brainstorm a spec", "dispatch a reviewer subagent", "run the dev server"), not tool names.

- **Claude Code** discovers `.claude/skills/` natively and maps actions to its tools (Skill, Task, `preview_*`).
- **Codex** auto-loads `AGENTS.md`; the "Board sweeps" section points it at the same `SKILL.md` files and gives the Codex tool mapping (`shell`, `apply_patch`, `spawn_agent`, `update_plan`).

Same files, both runtimes. Invoke with natural language: "run the spec sweep", "run the dev sweep", "run the QA sweep".

## Triggering (auto-sweep)

Instead of running the sweeps by hand, the launcher (`scripts/linear-watch.mjs`) can run them automatically when a card lands in the matching queue. It's built for one always-on machine (a Mac mini) driving **many workspaces**:

- **Unit = workspace, not repo.** One Linear project maps to one workspace (a container folder of N sibling git repos), anchored at the repo that holds `.claude/`. You `register` each anchor once; activation is a Linear **project label `auto-sweep`** you toggle in the UI.
- **Cheap when idle.** Every ~10 min the launcher makes a few Linear API calls and a fast-forward `git pull` — **zero LLM tokens** — and dispatches a heavyweight agent pass only when a queue holds genuinely actionable work.
- **Self-healing.** A crashed session's claim is auto-released via a heartbeat (not a raw timer), poison/oscillating cards escalate to `blocked:needs-user`, and a PID-liveness lock keeps exactly one agent running at a time.
- **Machine-independent.** All work and tooling flow through origin; skills auto-update by the launcher fast-forwarding your kit clone and pushing refreshed skills to each anchor.
- **Per-workspace runtime + per-sweep model** live in `linear-sweep.json` (`runtime`, `models`), default `codex`.

Setup is a few idempotent commands per workspace (full agent-runnable procedure in [SETUP.md](SETUP.md) Step 11):

```bash
scripts/install-watch.sh                                 # symlink wrapper + install plist (no activation)
node scripts/linear-watch.mjs register <anchor-repo>     # register; auto-wires kitPath for self-update
node scripts/linear-watch.mjs activate <anchor-repo>     # add the auto-sweep label to the project (API)
node scripts/linear-watch.mjs tick --dry-run             # validate live, spends no tokens
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.linear-board-sweeps.watch.plist  # turn on the 10-min timer
```

`list` shows each anchor + `[auto-sweep: ON/off]`; `health` reports liveness; `deactivate` pauses a project. Full design + rationale: [`docs/superpowers/specs/2026-07-08-auto-sweep-launcher-design.md`](docs/superpowers/specs/2026-07-08-auto-sweep-launcher-design.md). **QA caution:** qa-sweep merges + deploys to prod — keep it on manual `kickstart` unless you really want auto-deploys.

## Requirements

- Node 18+ (for the Linear engine).
- A Linear Personal API key with access to the target team.
- For `dev-sweep` under Codex: `multi_agent = true` in `~/.codex/config.toml`.

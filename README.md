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

> "Set up the Linear board-sweeps workflow in this repo. Clone `https://github.com/shereefb/linear-board-sweeps` into a sibling folder if it isn't already there, then follow its SETUP.md."

**The agent does everything** — it clones this kit itself, reads [SETUP.md](SETUP.md), then creates the board statuses + labels, installs the skills, writes the repo config, wires the Codex adapter, and tells you how to run it. The only things it needs from you: a Linear API key (`lin_api_…`) once, and your team/project name.

(SETUP.md Step 0 handles the clone, so the same prompt works whether or not the kit is already on the machine.)

## What's inside

| Path | What it is |
|------|-----------|
| `SETUP.md` | The agent-facing bootstrap procedure (what to prompt, where to put everything, exact commands). |
| `skills/{spec,dev,qa}-sweep/SKILL.md` | The three cross-runtime sweep skills. Project-agnostic — they read `.claude/linear-sweep.json`. |
| `scripts/linear.mjs` | Zero-dependency Linear engine (Node 18+): `whoami`, `setup-team`, `ensure-project`, `create-card`, `query`. |
| `templates/linear-sweep.json` | The per-repo config the skills read. Copied + filled into the target's `.claude/`. |
| `templates/AGENTS.snippet.md` | The "Board sweeps" section appended to the target's `AGENTS.md` — how Codex finds the skills. |
| `templates/gitignore.snippet` | `.env` + `.claude/` tracking rules for the target's `.gitignore`. |
| `docs/linear-rules.md` | The canonical board taxonomy (statuses, labels) + feature-tracking rules. |

## How it stays runtime-agnostic

The `SKILL.md` files speak in **actions** ("brainstorm a spec", "dispatch a reviewer subagent", "run the dev server"), not tool names.

- **Claude Code** discovers `.claude/skills/` natively and maps actions to its tools (Skill, Task, `preview_*`).
- **Codex** auto-loads `AGENTS.md`; the "Board sweeps" section points it at the same `SKILL.md` files and gives the Codex tool mapping (`shell`, `apply_patch`, `spawn_agent`, `update_plan`).

Same files, both runtimes. Invoke with natural language: "run the spec sweep", "run the dev sweep", "run the QA sweep".

## Requirements

- Node 18+ (for the Linear engine).
- A Linear Personal API key with access to the target team.
- For `dev-sweep` under Codex: `multi_agent = true` in `~/.codex/config.toml`.

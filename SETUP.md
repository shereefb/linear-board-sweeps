# SETUP — bootstrap the board-sweeps workflow into a repo

**You are an AI coding agent (Claude Code or Codex).** The user pointed you at this kit to install the spec → dev → qa Linear board-sweep workflow into their **target repo**. Follow these steps in order. `KIT` = this repo's path; `TARGET` = the repo you're setting up (usually the current working directory).

Do the work; don't just describe it. Prompt the user only for the inputs in Step 1.

---

## Step 0 — Prerequisites

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

Creates `Needs Spec`, `Ready for Dev`, `Archived` and the six workflow labels if missing (see `docs/linear-rules.md`). Safe to re-run.

## Step 5 — Resolve the project id

```bash
node "KIT/scripts/linear.mjs" ensure-project "<Team>" "<Project>"
```

Copy the printed `projectId` for the config.

## Step 6 — Install the skills

Copy the three skill folders into the target's Claude Code skills dir:

```bash
mkdir -p "TARGET/.claude/skills"
cp -R "KIT/skills/spec-sweep" "KIT/skills/dev-sweep" "KIT/skills/qa-sweep" "TARGET/.claude/skills/"
```

Claude Code discovers these natively. (For Codex, Step 8 wires them via AGENTS.md.)

## Step 7 — Write the repo config

Copy `KIT/templates/linear-sweep.json` to `TARGET/.claude/linear-sweep.json` and fill every `<placeholder>` from Steps 1 + 5 (teamName, teamKey, project, projectId, issuePrefix, repos, deploy, canonicalDocs, credentialsNote). This file is what makes the skills project-agnostic.

If `TARGET/.gitignore` has a broad `.claude/*` ignore, make sure `!.claude/skills/` and `!.claude/linear-sweep.json` are present (the gitignore snippet includes them) so the skills + config are tracked.

## Step 8 — Wire Codex (AGENTS.md adapter)

Append `KIT/templates/AGENTS.snippet.md` to `TARGET/AGENTS.md` (create `AGENTS.md` at the repo root if it doesn't exist). Replace `<TEAM>`, `<KEY>`, `<PROJECT>`, `<DEPLOY>` to match the config. This is how **Codex** finds the sweeps (it auto-loads `AGENTS.md`; it does not scan `.claude/skills/`).

If the user will run `dev-sweep` under Codex, tell them to add to `~/.codex/config.toml`:

```toml
[features]
multi_agent = true
```

## Step 9 — Commit

Stage selectively (never `git add -A`): `.claude/skills/`, `.claude/linear-sweep.json`, `AGENTS.md`, `.gitignore`. **Do not stage `.env`.** Commit with a clear message. Don't push unless asked.

## Step 10 — Tell the user how to run it

- **Claude Code:** the skills auto-register — say "run the spec sweep" / "run the dev sweep" / "run the QA sweep" (or "spec the needs-spec cards", etc.).
- **Codex** (working in this repo): same natural-language phrases — Codex reads the AGENTS.md "Board sweeps" section and follows the named `SKILL.md`. Needs `LINEAR_API_KEY` in its env and `multi_agent = true` for dev-sweep.
- Point them at `docs/linear-rules.md` for the board taxonomy, and remind them: **create cards for the actual features/bugs** and let the sweeps carry them across the board.

## Verify (before declaring done)

- `git -C TARGET check-ignore .env` prints `.env` (key is safe).
- `TARGET/.claude/linear-sweep.json` has a real `projectId` and no `<placeholders>`.
- `TARGET/.claude/skills/{spec,dev,qa}-sweep/SKILL.md` exist.
- `TARGET/AGENTS.md` contains the "Board sweeps" section with real values.
- `node KIT/scripts/linear.mjs whoami` succeeds with the target's `.env` loaded.

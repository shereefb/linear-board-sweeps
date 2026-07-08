# SETUP — bootstrap the board-sweeps workflow into a repo

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

If the user will run `dev-sweep` under Codex, ensure `~/.codex/config.toml` has multi-agent support enabled. Preserve any existing `[features]` entries and add the missing key yourself:

```toml
[features]
multi_agent = true
```

Verify it is present before continuing:

```bash
grep -A20 '^\[features\]' ~/.codex/config.toml | grep '^multi_agent = true'
```

## Step 9 — Commit

Stage selectively (never `git add -A`): `.claude/skills/`, `.claude/linear-sweep.json`, `AGENTS.md`, `.gitignore`. **Do not stage `.env`.** Commit with a clear message. Don't push unless asked.

## Step 10 — Tell the user how to run it

- **Claude Code:** the skills auto-register — say "run the spec sweep" / "run the dev sweep" / "run the QA sweep" (or "spec the needs-spec cards", etc.).
- **Codex** (working in this repo): same natural-language phrases — Codex reads the AGENTS.md "Board sweeps" section and follows the named `SKILL.md`. Needs `LINEAR_API_KEY` in its env and `multi_agent = true` for dev-sweep; Step 8 should already have enabled it.
- Point them at `docs/linear-rules.md` for the board taxonomy, and remind them: **create cards for the actual features/bugs** and let the sweeps carry them across the board.

## Step 11 — Auto-sweep triggering (run the sweeps automatically)

This makes the sweeps fire on a schedule when cards land in a queue, instead of you invoking them by hand. It runs on **one always-on machine** (e.g. a Mac mini). If the user only wants manual invocation, skip this step and tell them the natural-language phrases from Step 10. Full design + rationale: `KIT/docs/superpowers/specs/2026-07-08-auto-sweep-launcher-design.md`.

**Do this step only on the always-on machine.** If you're not sure this is that machine, ask the user before installing launchd. Every command below is idempotent — safe to re-run.

**Concepts you need (read once):**
- **Workspace** = one Linear project ↔ one **anchor repo** (the repo holding `.claude/linear-sweep.json`, i.e. `TARGET`) plus any sibling repos it lists in `config.repos`. One anchor per project.
- **Activation** = a Linear **project label `auto-sweep`**. The launcher only sweeps a registered anchor whose project carries that label. `activate`/`deactivate` toggle it via the API.
- **`ANCHOR`** below = the absolute path to `TARGET` (the anchor repo). Repeat this step's register/activate for each anchor if the user runs several projects on this machine.

1. **Ensure `runtime` + `models` exist** in `ANCHOR/.claude/linear-sweep.json`. If it was copied from the template (Step 7) it already has them. If not, add:
   ```jsonc
   "runtime": "codex",                       // or "claude"
   "models": {
     "spec": { "model": "gpt-5.5", "effort": "high" },
     "dev":  { "model": "gpt-5.5", "effort": "high" },
     "qa":   { "model": "gpt-5.5", "effort": "high" },
     "ship": { "model": "gpt-5.5", "effort": "high" }
   },
   "parallel": {
     "maxNonShipDispatches": 1
   }
   ```
   Use explicit supported best-model overrides so scheduled sweeps do not silently drift with runtime defaults. For Codex, prefer the best model available to the installed account (for this kit's default, `gpt-5.5` with `high` effort). For a `claude` workspace use claude model ids (e.g. `claude-opus-4-8`). Confirm the chosen `runtime` CLI (`codex` or `claude`) is installed and on `PATH`.
   Keep `parallel.maxNonShipDispatches` at `1` unless this machine can comfortably run multiple non-ship agents; values above `1` only parallelize disjoint anchors whose resolved repo paths do not overlap. ship-sweep is always serial.

2. **Install the launcher** (symlinks the wrapper, materializes the launchd plist — does NOT activate the schedule):
   ```bash
   "KIT/scripts/install-watch.sh"
   ```

3. **Register the anchor.** This also auto-wires the kit clone for auto-update (`kitPath`/`kitRemote`) on first run — no registry editing needed:
   ```bash
   node "KIT/scripts/linear-watch.mjs" register "ANCHOR"
   ```

4. **Activate the project** (adds the `auto-sweep` label via the API; creates the label if it doesn't exist yet):
   ```bash
   node "KIT/scripts/linear-watch.mjs" activate "ANCHOR"
   node "KIT/scripts/linear-watch.mjs" list        # each anchor → projectId + [auto-sweep: ON]
   ```

5. **Dry-run against the live board** (spends NO tokens — logs the dispatch it *would* make, per active workspace/sweep):
   ```bash
   node "KIT/scripts/linear-watch.mjs" tick --dry-run
   tail -n 40 ~/.local/state/linear-board-sweeps/*/*/$(date +%Y%m%d).log
   ```
   Expect the anchor's project to read active and real actionable counts. If it reads "paused", activation didn't take — re-check step 4. With `parallel.maxNonShipDispatches > 1`, dry-run logs every non-ship dispatch selected for the bounded batch.

6. **Activate the schedule** (10-min timer) and confirm health:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.linear-board-sweeps.watch.plist
   node "KIT/scripts/linear-watch.mjs" health      # "last tick …" or "tick in progress"
   ```
   Stop later with `launchctl bootout gui/$(id -u)/com.linear-board-sweeps.watch`. Pause one project without stopping the launcher: `node "KIT/scripts/linear-watch.mjs" deactivate "ANCHOR"`.

**QA caution — decide before activating.** `qa-sweep` never merges or deploys, but it can fix UX bugs and push review branches. `ship-sweep` is the only production path and only runs from the human-gated `Ready to Ship` column. Pin ship dispatch to one host with `node "KIT/scripts/linear-watch.mjs" ship-runner on` before relying on scheduled shipping.

**If this is NOT the always-on machine** (or the user only wants manual runs): skip Step 11 entirely. The sweeps still work on demand via the Step 10 phrases; another machine can pick up any card because all work flows through origin (see each SKILL.md's "Machine-independence & handoff" section).

## Verify (before declaring done)

- `git -C TARGET check-ignore .env` prints `.env` (key is safe).
- `TARGET/.claude/linear-sweep.json` has a real `projectId` and no `<placeholders>`.
- `TARGET/.claude/skills/{spec,dev,qa}-sweep/SKILL.md` exist.
- `TARGET/AGENTS.md` contains the "Board sweeps" section with real values.
- `node KIT/scripts/linear.mjs whoami` succeeds with the target's `.env` loaded.

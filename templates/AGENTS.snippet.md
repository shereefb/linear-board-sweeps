<!-- Append this to the TARGET repo's AGENTS.md (create AGENTS.md at repo root if missing).
     This is the Codex adapter: Codex auto-loads AGENTS.md and follows the SKILL.md files it names.
     Replace the <PLACEHOLDERS> to match .claude/linear-sweep.json. -->

---

# Board sweeps (cross-runtime Linear automation)

Three Linear board sweeps drive features from idea → shipped on the **<TEAM>** team's **<PROJECT>** project. They are **canonical, cross-runtime skills**: the same `SKILL.md` files run under Claude Code (discovered natively) and Codex (via this section). Read the whole `SKILL.md` before acting.

**Config:** all three read `.claude/linear-sweep.json` at the repo root for the team/project/prefix and repo-specific paths — nothing is hardcoded. Team `<TEAM>` (key `<KEY>`), project `<PROJECT>`, issue prefix `<KEY>-###`. Deploy path: <DEPLOY>.

**Codex tool mapping (all three):** read/search/git via `shell`; edit files via `apply_patch`; subagents via `spawn_agent`/`wait_agent`/`close_agent` (needs `[features] multi_agent = true` in `~/.codex/config.toml`); progress via `update_plan`; run the dev server via `shell` in the background (no `preview_*` tools on Codex). Use your own commit attribution — not the `Co-Authored-By: Claude` trailer shown in the files. Detect worktree/branch state with read-only git before creating/finishing branches.

- **Spec sweep** — "Needs Spec" → "Ready for Dev" (docs-only): `.claude/skills/spec-sweep/SKILL.md`. Engineering review runs in prose mode (auto-decide via prose; never AskUserQuestion, never BLOCKED).
- **Dev sweep** — "Ready for Dev" + "In Progress" → "In Review" (writes code on a worktree, runs code review + an independent reviewer subagent, pushes the branch, no merge): `.claude/skills/dev-sweep/SKILL.md`.
- **QA sweep** — "In Review" → "Done" (smoke-test as a user, fix UX bugs, screenshots to the card, then MERGE + DEPLOY TO PROD): `.claude/skills/qa-sweep/SKILL.md`. Higher-risk — ships only a green, smoke-tested feature; prefer attended.

**Statuses:** Backlog → Needs Spec → Ready for Dev → In Progress → In Review → Done. Plus **`Todo`** = a human-only action item the agent can't do (DNS, a dashboard secret, a third-party console step, a deploy the agent can't trigger); sweeps spin these off and link them to the feature card so the user has one tracked to-do list. Also Canceled/Duplicate/Archived. **Workflow labels:** `spec:in-progress`, `dev:in-progress`, `qa:in-progress`, `qa:needs-changes`, `blocked:open-questions`, `blocked:needs-user`.

**Auth:** `LINEAR_API_KEY` lives in the gitignored `.env` at repo root (`set -a && . ./.env && set +a`), never committed.

## Linear feature tracking (going forward)

Track every product/engineering feature, bug, or product-impacting change on the <PROJECT> board. Find or create a `<KEY>-*` issue for the work itself (not meta "design X" cards — attach specs/plans/review notes to the feature card). Put the `<KEY>-###` key in the branch name / commit subjects where practical. Raw ideas → Backlog; selected-but-underspecified → Needs Spec; designed → Ready for Dev; active → In Progress; PR/review/QA → In Review; shipped/verified → Done. Work discovered after the fact → a `Done` card titled `Completed: …` with a short summary + evidence.

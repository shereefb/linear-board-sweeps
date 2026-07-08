<!-- Append this to the TARGET repo's AGENTS.md (create AGENTS.md at repo root if missing).
     This is the Codex adapter: Codex auto-loads AGENTS.md and follows the SKILL.md files it names.
     Replace the <PLACEHOLDERS> to match .claude/linear-sweep.json. -->

---

# Board sweeps (cross-runtime Linear automation)

Four Linear board sweeps drive features from idea → shipped on the **<TEAM>** team's **<PROJECT>** project, with a human gate before anything reaches production. They are **canonical, cross-runtime skills**: the same `SKILL.md` files run under Claude Code (discovered natively) and Codex (via this section). Read the whole `SKILL.md` before acting.

## Coding workflow

- For any task involving writing, reviewing, debugging, refactoring, or otherwise changing code, invoke the installed Andrej Karpathy skill (`andrej-karpathy-skill` from the `andrej-karpathy-skills` plugin) before starting that work.
- If the skill is unavailable in the current session, apply its core checks manually: think before coding, keep the change simple, make surgical edits, and verify the goal before calling the work complete.

**Config:** all four read `.claude/linear-sweep.json` at the repo root for the team/project/prefix and repo-specific paths — nothing is hardcoded. Team `<TEAM>` (key `<KEY>`), project `<PROJECT>`, issue prefix `<KEY>-###`. Deploy path: <DEPLOY>. Optional `reviewLenses` gate card-type review lenses; optional `requireShipApproval` hardens the ship gate.

**Codex tool mapping (all four):** read/search/git via `shell`; edit files via `apply_patch`; subagents via `spawn_agent`/`wait_agent`/`close_agent` (needs `[features] multi_agent = true` in `~/.codex/config.toml`); progress via `update_plan`; run the dev server via `shell` in the background (no `preview_*` tools on Codex). Use your own commit attribution — not the `Co-Authored-By: Claude` trailer shown in the files. Detect worktree/branch state with read-only git before creating/finishing branches.

- **Spec sweep** — "Needs Spec" → "Ready for Dev" (docs-only, + card-type-gated design/devex/security plan reviews): `.claude/skills/spec-sweep/SKILL.md`. Engineering review runs in prose mode (auto-decide via prose; never AskUserQuestion, never BLOCKED).
- **Dev sweep** — "Ready for Dev" + "In Progress" → "In Review" (writes code on a worktree, gated security/perf/design lenses, code review + an independent reviewer subagent, verifies green, pushes the branch, no merge): `.claude/skills/dev-sweep/SKILL.md`.
- **QA sweep** — "In Review" → "QA Passed" (smoke-test as a user via `/qa`, `/design-review`, fix UX bugs, screenshots to the card; **never merges, never deploys**): `.claude/skills/qa-sweep/SKILL.md`.
- **Ship sweep** — "Ready to Ship" → "Done" (the only sweep that MERGES + DEPLOYS TO PROD; canary-verifies; resume-on-merge-commit): `.claude/skills/ship-sweep/SKILL.md`. **Single-runner** (pin dispatch to one host) and fires only on cards a human moved into "Ready to Ship".
- **Unblock sweep** — manual-only interactive review of cards carrying `blocked:open-questions`, `blocked:needs-user`, or `qa:needs-changes` across registered anchors: `.claude/skills/unblock-sweep/SKILL.md`. Never scheduled; clears blockers only after a human supplies a resolution.

**Statuses:** Backlog → Needs Spec → Ready for Dev → In Progress → In Review → **QA Passed** → **Ready to Ship** (human-only move) → Done. Plus **`Todo`** = a human-only action item the agent can't do (DNS, a dashboard secret, a third-party console step, a deploy the agent can't trigger); sweeps spin these off and link them to the feature card so the user has one tracked to-do list. Also Canceled/Duplicate/Archived. **Workflow labels:** `spec:in-progress`, `dev:in-progress`, `qa:in-progress`, `qa:needs-changes`, `qa:passed`, `ship:in-progress`, `ship:approved`, `fast-path:eligible`, `blocked:open-questions`, `blocked:needs-user`.

**Auth:** `LINEAR_API_KEY` lives in the gitignored `.env` at repo root (`set -a && . ./.env && set +a`), never committed.

## Linear feature tracking (going forward)

Track every product/engineering feature, bug, or product-impacting change on the <PROJECT> board. Find or create a `<KEY>-*` issue for the work itself (not meta "design X" cards — attach specs/plans/review notes to the feature card). Put the `<KEY>-###` key in the branch name / commit subjects where practical. Raw ideas → Backlog; selected-but-underspecified → Needs Spec; designed → Ready for Dev; active → In Progress; PR/review → In Review; QA-passed, awaiting sign-off → QA Passed; human-approved to ship → Ready to Ship; shipped/verified → Done. Work discovered after the fact → a `Done` card titled `Completed: …` with a short summary + evidence.

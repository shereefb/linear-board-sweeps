# COD-88 Karpathy skill routing - implementation plan

**Date:** 2026-07-08
**Card:** COD-88
**Spec:** `docs/superpowers/specs/2026-07-08-COD-88-karpathy-skill-routing-design.md`

## Goal

Ensure the portable Linear sweep kit tells Codex to use the Andrej Karpathy skill before appropriate code work, without making the kit depend on that plugin being installed.

## Steps

1. Update Codex adapter instructions.
   - Add a "Coding workflow" subsection to root `AGENTS.md`.
   - Add the same subsection to `templates/AGENTS.snippet.md`.
   - Keep the fallback explicit: if the skill is unavailable, manually apply the four checks.

2. Update sweep skills.
   - In `skills/dev-sweep/SKILL.md` and `.claude/skills/dev-sweep/SKILL.md`, add the guardrail before code editing begins.
   - In QA and ship sweep files, add the guardrail for any code-fix or merge-review work.
   - In spec-sweep files, add a docs-only note that Karpathy checks may inform plans but spec-sweep must not edit app code.
   - Keep the propagated skill text sufficient for already-installed repos, because auto-update does not rewrite target `AGENTS.md`.

3. Update setup documentation.
   - Update `SETUP.md` where it installs or verifies `AGENTS.md` snippets.
   - If setup has exact snippet replacement text, update it rather than relying on README prose.

4. Add verification.
   - Add a lightweight test or script assertion that `templates/AGENTS.snippet.md` contains `andrej-karpathy-skill`.
   - If no test harness covers setup text today, add the assertion to the most relevant existing Node test file or create a small `node:test` file for template invariants.

5. Propagation.
   - Ensure both top-level `skills/` and `.claude/skills/` copies are updated, because the kit and installed anchor copies both exist in this repo.
   - Decide whether AGENTS adapter migration is in scope. If not, create or link a follow-up card for migrating existing target `AGENTS.md` files.

## Verification

Run:

```bash
node --test
rg "andrej-karpathy-skill|Coding workflow" AGENTS.md templates/AGENTS.snippet.md skills .claude/skills SETUP.md
```

Manual acceptance: create a temporary target repo from setup instructions or inspect the generated snippet path and confirm the installed `AGENTS.md` would include the new coding workflow rule.

## Risks

- Updating only `.claude/skills/` would make this repo behave correctly but leave the distributable `skills/` stale.
- Requiring the plugin installation would reduce portability; keep fallback language.

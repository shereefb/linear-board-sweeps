# COD-88 Karpathy skill routing - design

**Date:** 2026-07-08
**Status:** Ready for implementation after spec-sweep engineering review.
**Card:** COD-88, "Make sure the karpathy coding skill is used when appropriate as well"

## Problem

This repository's current session instructions include a global rule to invoke the Andrej Karpathy skill before code work, but the portable kit template does not install that rule into target repositories. The target `AGENTS.md` snippet only maps board-sweep tools and skills (`templates/AGENTS.snippet.md:13`). The root `AGENTS.md` for this repo has the same board-sweep mapping but no Karpathy routing rule (`AGENTS.md:7`).

The sweeps themselves also name several helper skills, but they do not mention the Karpathy skill. Spec-sweep references brainstorming and plan review (`.claude/skills/spec-sweep/SKILL.md:10`), while dev-sweep references code review and worktrees (`.claude/skills/dev-sweep/SKILL.md:10`). As a result, installed target repos may not consistently apply the simple "think first, keep it small, make surgical edits, verify" guardrail when a dev, QA, ship, or ad hoc code task changes code.

## Brainstormed approaches

1. **Recommended: add an explicit Karpathy routing rule to the installed Codex adapter and relevant sweep skills.** This keeps the rule close to where Codex reads instructions and where sweep work begins.
2. **Only update this repo's AGENTS.md.** This helps this anchor repo but does not propagate to target repos that install from the template.
3. **Rely on users' global Codex configuration.** This is brittle because the kit promises portable setup across machines and repos.

## Design

Add the Karpathy skill as a first-class coding guardrail in the kit's installed instructions:

- `templates/AGENTS.snippet.md` should include a short "Coding workflow" subsection that says code writing, reviewing, debugging, refactoring, or code-changing tasks must invoke `andrej-karpathy-skill` from the `andrej-karpathy-skills` plugin before editing. If unavailable, apply the core checks manually.
- Root `AGENTS.md` should mirror the same rule for this repo.
- `dev-sweep`, `qa-sweep`, and `ship-sweep` should mention the guardrail in their preflight or build/review sections because those sweeps can write code or merge code.
- `spec-sweep` should mention it only as a non-code guardrail: spec-sweep remains docs-only, but if a spec requires reasoning about future code changes, the Karpathy checks should inform the plan. It must not turn spec-sweep into code editing.
- `SETUP.md` should install/update the snippet so future target repos receive the rule. If setup has a verification checklist for target `AGENTS.md`, add this rule to that checklist.

Already-installed repos need a separate path. The auto-updater currently copies sweep skill directories (`scripts/linear-watch.mjs:528`) and commits `.claude/skills` only (`scripts/linear-watch.mjs:544`, `scripts/linear-watch.mjs:556`). That means changing `templates/AGENTS.snippet.md` helps new installs but does not update existing target `AGENTS.md` files. To reach existing anchors, implementation must either put the rule directly in propagated sweep `SKILL.md` files or add an explicit AGENTS adapter migration path. The first implementation should do both the template update and the propagated sweep-skill guardrail; AGENTS migration can be a follow-up if it needs owner review.

This is a documentation/instruction feature, not a runtime dependency. The implementation should not vendor the skill, install plugins, or fail a sweep when the skill is absent. The fallback is explicitly manual application of the four checks.

## Engineering review

### Engineering decision D1 - enforcement level

The decision is whether to make Karpathy routing a hard runtime dependency or an instruction-level guardrail. The risk of a hard dependency is that installed repos without the plugin would fail otherwise valid work.

Recommendation: use instruction-level enforcement with a manual fallback.

A) Instruction-level guardrail with fallback (recommended). Completeness: 9/10. It makes the desired behavior explicit across installed repos while preserving portability when the plugin is unavailable.

B) Hard dependency in setup. Completeness: 6/10. It enforces consistency but makes the kit depend on one user's plugin ecosystem and can break Claude Code installs.

C) Root AGENTS only. Completeness: 4/10. It helps this repo but misses the reusable kit path.

Net: make the behavior portable through instructions, not plugin installation.

### Independent adversarial review

Premises to verify before implementation:

- The installed Codex adapter comes from `templates/AGENTS.snippet.md`, not only root `AGENTS.md` (`README.md:38`).
- Current snippet lacks a coding workflow rule (`templates/AGENTS.snippet.md:13`).
- Dev-sweep is the primary code-writing sweep (`.claude/skills/dev-sweep/SKILL.md:28`).
- QA-sweep can also commit bug/UX fixes, so it needs the guardrail before code-fix commits.
- Auto-update currently propagates `.claude/skills`, not target `AGENTS.md`, so existing installs need the rule in skill files too.
- Spec-sweep is docs-only and must stay that way (`.claude/skills/spec-sweep/SKILL.md:8`, `.claude/skills/spec-sweep/SKILL.md:69`).

## Schema and architecture impact

No Linear schema or launcher architecture change. The canonical docs impact is instruction propagation: `README.md` and `SETUP.md` should describe that the installed Codex adapter includes the Karpathy coding guardrail. Sweep skills should stay cross-runtime and phrase this as an action, not a Codex-only tool call.

## Acceptance criteria

- Root `AGENTS.md` includes a coding workflow rule for `andrej-karpathy-skill`.
- `templates/AGENTS.snippet.md` includes the same rule so new target repos get it.
- Code-writing sweep skills mention invoking the guardrail before editing code.
- Spec-sweep remains docs-only and does not instruct itself to edit app code.
- The fallback behavior is documented for sessions where the skill is unavailable.
- Tests or setup verification check that generated snippets include the rule.
- Existing installed repos receive the guardrail through propagated sweep skill updates even before any AGENTS migration exists.

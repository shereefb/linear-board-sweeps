# COD-97: Runtime Interchangeability Implementation Plan

Linear: COD-97
Spec: docs/superpowers/specs/2026-07-08-COD-97-runtime-interchangeability-design.md
Date: 2026-07-08

## Goal

Let one workspace use different agent runtimes and models for different sweep stages while preserving every existing `runtime` plus `models` config.

## Implementation Steps

1. Add a pure runtime resolver.

   File: `scripts/linear-watch.mjs`

   - Export `runtimeConfigForSweep(config, sweep)`.
   - Resolution order:
     1. `config.runtimes?.[sweep]`
     2. legacy `config.runtime` plus `config.models?.[sweep]`
     3. `{ runtime: "codex" }`
   - Return a new object: `{ runtime, model, effort }`.
   - Do not mutate `config`.

2. Wire dispatch through the resolver.

   File: `scripts/linear-watch.mjs`

   - Replace direct reads of `config.runtime` and `config.models[sweep]`.
   - Pass the resolved values into `buildCommand()`.
   - Make `logFor()` include resolved runtime/model/effort, sanitized to short values, so operators can verify stage selection from logs.
   - Pass resolved runtime/model/effort into post-dispatch failure events. The current path builds the target/message from `pick.config.runtime || "codex"`, which would hide a failing per-stage override.
   - Extend `failureTodoBody()` or its event input so the Todo names the resolved runtime/model/effort that failed, not only the generic `Target`.

3. Extend tests.

   File: `tests/linear-watch.test.mjs`

   Add tests for:

   - Per-sweep `runtimes.ship` overrides legacy `runtime`.
   - Per-sweep model/effort overrides legacy `models.ship`.
   - Legacy config still returns the same values as today.
   - Empty config falls back to `{ runtime: "codex" }`.
   - `runtimes.review` does not affect `SWEEPS` or scheduled dispatch lists.

4. Update config template.

   File: `templates/linear-sweep.json`

   - Add the mixed-runtime default:
     - `spec`: `claude` / `claude-opus-4-8`
     - `dev`: `codex` / `gpt-5.5` / `high`
     - `review`: `claude` / `claude-opus-4-8`
     - `qa`: `codex` / `gpt-5.5` / `high`
     - `ship`: `claude` / `claude-sonnet-5`
   - Keep legacy `runtime` and `models` fields for compatibility. Explain that `runtimes` entries override them.
   - Replace the current comment that says gated reviews have no per-lens model tier. New wording should distinguish review lenses, which still run inside a sweep, from independent reviewer subagents, which may prefer `runtimes.review`.

5. Update operator docs.

   Files: `README.md`, `SETUP.md`

   - Replace "one runtime per workspace" language with "legacy workspace default plus optional per-stage overrides."
   - Show the complete mixed-runtime example.
   - State that unavailable model names fail loudly and should be corrected in config.
   - Keep `node scripts/linear-watch.mjs tick --dry-run` as the validation step.
   - Fix the stale QA caution in `SETUP.md`: QA no longer merges or deploys; ship-sweep is the only scheduled production merge/deploy path, and it remains human-gated by the Ready to Ship column.

6. Update sweep instructions for review role.

   Files:

   - `skills/spec-sweep/SKILL.md`
   - `skills/dev-sweep/SKILL.md`
   - `skills/qa-sweep/SKILL.md`
   - `.claude/skills/spec-sweep/SKILL.md`
   - `.claude/skills/dev-sweep/SKILL.md`
   - `.claude/skills/qa-sweep/SKILL.md`

   Add a short cross-runtime note:

   - When spawning an independent reviewer and the runtime supports explicit model selection, prefer `config.runtimes.review`.
   - If not supported, run the reviewer in the current runtime and note that in the Linear comment.
   - Do not add `review` to `SWEEP_CFG`; it is a role, not a scheduled board stage.

## Tests

Run:

```bash
node --test
```

Targeted checks before the full suite:

```bash
node --test tests/linear-watch.test.mjs
node -e 'import("./scripts/linear-watch.mjs").then(m => console.log(m.runtimeConfigForSweep({ runtimes: { ship: { runtime: "claude", model: "claude-sonnet-5" } } }, "ship")))'
```

Manual validation:

```bash
node scripts/linear-watch.mjs tick --dry-run
```

The dry run should show the selected queue without launching an agent. The next real dispatch log should include the resolved runtime/model for the chosen sweep.

## NOT in Scope

- Model availability probing against Codex or Claude accounts.
- New scheduler state or Linear statuses.
- Moving the board card directly to Ready to Ship.
- Runtime-specific nested subagent orchestration from the launcher.

## What Already Exists

- `buildCommand()` already supports `codex` and `claude` argv.
- `dispatch()` already builds exactly one command per sweep.
- `templates/linear-sweep.json` already carries runtime/model defaults.
- `tests/linear-watch.test.mjs` already has command-builder tests.
- Tick-failure Todo handling can surface unsupported model/runtime failures after COD-91 implementation.

## Failure Modes

- Unsupported model name: runtime exits non-zero; log and Todo path should surface it.
- Unsupported model name hidden by legacy failure reporting: include resolved runtime/model/effort in the failure event and Todo.
- Missing `claude` binary on a host selected for a Claude sweep: existing ENOENT handling returns 127 and logs a fatal dispatch failure.
- Ambiguous config with both legacy and per-sweep entries: resolver precedence makes per-sweep entries win.
- Accidental scheduled `review` sweep: tests assert `review` is not in `SWEEPS`.

## Parallelization

Sequential implementation is recommended. The change is small and all slices touch the same launcher/config/docs surface.

## Verification Checklist

- [ ] Resolver tests pass.
- [ ] Existing command-builder tests still pass.
- [ ] Template JSON remains valid.
- [ ] README and SETUP describe compatibility and precedence.
- [ ] SETUP no longer claims QA merges or deploys.
- [ ] Failure Todos identify the resolved runtime/model/effort on dispatch failures.
- [ ] Sweep skills mention review role config without making `review` schedulable.
- [ ] `node --test` passes.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | Keep resolver pure, preserve legacy config, do not schedule `review` |
| DX Review | `/plan-devex-review` | Operator-facing config | 1 | CLEAR | Add complete mixed-runtime example, precedence, and failure behavior |

- **VERDICT:** ENG + DX CLEARED - ready to implement.

NO UNRESOLVED DECISIONS

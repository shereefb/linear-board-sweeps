# COD-97: Runtime Interchangeability Design

Linear: COD-97
Status: planned
Date: 2026-07-08

## Problem

The launcher currently lets a workspace choose one runtime for all scheduled sweeps:

```json
{
  "runtime": "codex",
  "models": {
    "spec": { "model": "gpt-5.5", "effort": "high" },
    "dev": { "model": "gpt-5.5", "effort": "high" },
    "qa": { "model": "gpt-5.5", "effort": "high" },
    "ship": { "model": "gpt-5.5", "effort": "high" }
  }
}
```

That is not enough for the desired operating mode: spec with Claude Opus 4.8, code with GPT-5.5, review with Claude Opus 4.8, and ship with Claude Sonnet 5. The sweep kit is already cross-runtime at the skill layer, but scheduled dispatch is not yet cross-runtime per stage.

## Goals

- Allow each sweep stage to choose its own runtime and model without changing skill files per repo.
- Keep existing `runtime` plus `models` configs valid so installed anchors do not break.
- Let review roles be configured explicitly enough that downstream sweeps can invoke the right runtime family for independent review work.
- Make dispatch logs and future run records report the runtime/model/effort that were actually used.
- Make tick-failure Todo cards name the resolved runtime/model/effort, not the legacy workspace runtime.
- Keep the launcher simple: config resolution should stay a small pure function with focused tests.

## Non-goals

- No production deploy changes.
- No provider abstraction beyond the two supported CLIs: `codex` and `claude`.
- No automatic model availability probing. Unsupported model failures should still surface through the existing dispatch failure path and tick-failure Todo flow.
- No interactive model picker. Defaults live in `.claude/linear-sweep.json`.
- No implementation during this spec sweep.

## Existing Mechanism

`scripts/linear-watch.mjs` owns scheduled dispatch. `dispatch()` reads `config.runtime`, then reads `config.models[sweep]`, and passes both into `buildCommand()`.

`buildCommand()` already maps:

- `codex` to `codex exec --cd <anchor> -m <model> -c model_reasoning_effort=<effort> "<prompt>"`
- `claude` to `claude -p "<prompt>" --model <model>`

The narrow missing piece is configuration shape and resolution. The code should not introduce a second scheduler.

## Proposed Config Shape

Add optional per-sweep `runtimes` entries:

```json
{
  "runtime": "codex",
  "models": {
    "spec": { "model": "gpt-5.5", "effort": "high" },
    "dev": { "model": "gpt-5.5", "effort": "high" },
    "qa": { "model": "gpt-5.5", "effort": "high" },
    "ship": { "model": "gpt-5.5", "effort": "high" }
  },
  "runtimes": {
    "spec": { "runtime": "claude", "model": "claude-opus-4-8" },
    "dev": { "runtime": "codex", "model": "gpt-5.5", "effort": "high" },
    "qa": { "runtime": "codex", "model": "gpt-5.5", "effort": "high" },
    "ship": { "runtime": "claude", "model": "claude-sonnet-5" },
    "review": { "runtime": "claude", "model": "claude-opus-4-8" }
  }
}
```

Resolution order for a scheduled sweep:

1. `config.runtimes[sweep]` when present.
2. Legacy `config.runtime` plus `config.models[sweep]`.
3. Runtime default: `codex` with no model/effort flags.

The `review` entry is not a scheduled sweep. It is a named role that sweep prompts and future helper code can read when spawning independent reviewers. That keeps the launcher focused on top-level sweeps while preserving the user's requested default of Claude review.

## Default Preset

Once implemented, the kit default should be:

| Role | Runtime | Model | Effort |
|---|---|---|---|
| spec | claude | claude-opus-4-8 | runtime default |
| dev | codex | gpt-5.5 | high |
| review | claude | claude-opus-4-8 | runtime default |
| qa | codex | gpt-5.5 | high |
| ship | claude | claude-sonnet-5 | runtime default |

If a named model is not available in an operator's account, dispatch should fail loudly and create or reuse the tick-failure Todo path rather than silently falling back to a weaker model.

## Runtime Command Behavior

`buildCommand()` should remain the only argv builder. Add a small resolver such as `runtimeConfigForSweep(config, sweep)` that returns:

```js
{ runtime, model, effort }
```

`dispatch()` then becomes:

```js
const resolved = runtimeConfigForSweep(config, sweep);
const { cmd, args, cwd } = buildCommand({ ...resolved, sweep, anchorPath });
```

The resolver should be pure and unit-tested.

## Review Role Behavior

The sweeps already require independent reviewers in skill prose. This design makes the desired review runtime explicit in config, but does not require the launcher to spawn nested review agents. The implementation should:

- Document `runtimes.review` in the template and setup instructions.
- Add a small note to the sweep skills telling agents to prefer `config.runtimes.review` for independent review subagents when their runtime supports explicit model selection.
- Preserve the current fallback: if a runtime cannot honor the requested reviewer model, it still runs the review in the current agent/runtime and records that limitation in the card comment.

This avoids making scheduled dispatch wait on or orchestrate nested agent APIs across runtimes.

## Engineering Review

### D1 - Config shape

ELI10: The choice is whether to replace the old config or add a new optional layer. Replacing it is tidy, but it risks breaking every installed anchor. Adding `runtimes` keeps old configs alive while allowing each sweep to override the runtime.

Recommendation: A because it is the smallest backward-compatible change.

A) Add `runtimes` beside existing fields (recommended). Completeness: 10/10. It supports mixed runtimes immediately and keeps current anchors valid. The cost is one extra config concept, but the resolver can make precedence explicit and testable.

B) Replace `runtime` and `models` with a new `stages` object. Completeness: 7/10. It is cleaner for brand-new installs, but every existing config needs migration at once. The launcher would need compatibility code anyway.

C) Encode runtime inside each `models[sweep]` entry. Completeness: 8/10. It is compact, but it muddles the old meaning of `models` and makes role entries like `review` feel bolted on.

Net: Add `runtimes`, keep legacy fields, and make precedence obvious.

### Scope Challenge

What already exists:

- `buildCommand()` already emits runtime-specific argv.
- `dispatch()` already selects per-sweep model/effort.
- `templates/linear-sweep.json`, `SETUP.md`, and `README.md` already explain runtime/model config.
- `tests/linear-watch.test.mjs` already covers command-building behavior.

Minimum change:

- Add a pure resolver.
- Update dispatch to use it.
- Update tests, template, setup docs, README, and sweep instructions.

Complexity check: this should be well under eight touched implementation files and should not introduce new services/classes.

### Architecture Review

No new scheduler is needed. The core risk is config ambiguity, so the plan must specify precedence and test legacy compatibility. The resolver should also avoid mutating the config object so dry-run ticks remain predictable.

Failure scenario: an anchor has both `runtime: "codex"` and `runtimes.ship.runtime: "claude"`. Without explicit precedence, operators cannot predict what ships. The resolver test must assert `runtimes.ship` wins for `ship` while legacy config still drives other sweeps.

Adversarial correction folded: post-dispatch failure handling currently derives its failure target/message from `pick.config.runtime || "codex"`. After COD-97, that would hide the bad per-stage model that actually failed. The implementation must pass the resolved runtime/model/effort into the failure event and Todo body so operators know whether `claude-opus-4-8`, `gpt-5.5`, or another configured model caused the failure.

### Code Quality Review

Keep the resolver in `scripts/linear-watch.mjs` near `buildCommand()`, where the runtime dispatch vocabulary already lives. Do not introduce a new module for one pure function. Avoid broad template rewrites; update only the runtime-related paragraphs and JSON.

### Test Review

Required tests:

```text
runtimeConfigForSweep(config, "ship")
  +-- [GAP] per-sweep runtime wins over legacy runtime
  +-- [GAP] per-sweep model/effort wins over legacy model
  +-- [GAP] legacy runtime + models still work
  +-- [GAP] omitted config falls back to codex defaults
  +-- [GAP] role entry such as review is ignored by SWEEPS scheduling

buildCommand()
  +-- [TESTED] codex model + effort flags
  +-- [TESTED] omitted model/effort
  +-- [TESTED] claude --model
```

Run `node --test` after implementation.

### Performance Review

No performance-sensitive path changes. The resolver is one object lookup per dispatched sweep. It should not add Linear API calls or filesystem reads.

## DevEx Review

Classification: CLI/tooling config.

Developer persona: an operator installing this kit into multiple repos and deciding which agent family should own each stage.

TTHW target: under 5 minutes to understand and edit runtime defaults from `SETUP.md` plus the config template.

Key DX corrections folded into the plan:

- Show one complete mixed-runtime JSON example, not just prose.
- State exact precedence so operators can reason about overrides.
- State failure behavior for unavailable models.
- Keep legacy config documented as supported, not deprecated yet.
- Make dry-run validation part of the verification path.

DX score after plan: 8/10. It will be 10/10 once implementation also prints the resolved runtime/model in dry-run output or structured run records.

## Adversarial Review

Claim checked: "The launcher already has per-runtime argv support." Verified by `scripts/linear-watch.mjs` `buildCommand()` and existing tests in `tests/linear-watch.test.mjs`.

Claim checked: "Current config is one runtime per workspace." Verified by `dispatch()` reading `config.runtime || "codex"` and `config.models[sweep]`.

Main correction: do not make `review` a scheduled sweep. `SWEEPS` derives from `SWEEP_CFG`; adding `review` there would accidentally dispatch a non-board stage. Keep `review` as a role-only config entry and document how sweep agents should use it.

Additional adversarial corrections:

- `SETUP.md` still contains a stale warning that `qa-sweep` merges and deploys. COD-97's operator-doc pass must correct that because mixed runtime setup is exactly where operators decide what the scheduler may run unattended.
- `templates/linear-sweep.json` currently says gated review lenses inherit the dispatched agent and have no per-lens model tier. COD-97 must replace that sentence with the new distinction: review lenses still run inside their sweep, while independent reviewer subagents may prefer `runtimes.review` when the runtime supports it.

## Schema & Architecture Impact

`linear-sweep.json` gains an optional planned `runtimes` object. Existing `runtime` and `models` fields remain valid.

`README.md` should mark per-stage runtime selection as planned under COD-97 until the implementation lands.

## Acceptance Criteria

- A config can dispatch spec with Claude, dev/QA with Codex, and ship with Claude in one workspace.
- Existing configs that only have `runtime` plus `models` still dispatch exactly as before.
- Tests cover resolver precedence and command output.
- Template and setup docs show the requested default: spec Opus 4.8, dev GPT-5.5, review Opus 4.8, ship Sonnet 5.
- Dry-run or logs expose enough runtime/model detail to verify the chosen stage config without reading code.

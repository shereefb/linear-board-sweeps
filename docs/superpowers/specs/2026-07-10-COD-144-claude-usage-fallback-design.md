# COD-144 Claude Usage Fallback Design

**Linear:** COD-144, “Claude fallback”
**Status:** Revised design approved for implementation
**Date:** 2026-07-10

## Problem

The scheduled launcher resolves one runtime/model for each sweep and launches that command once. If a Codex child exits because the account has exhausted its usable plan allowance, the launcher treats it like every other nonzero child exit: the card remains claimed until recovery/reaping and the tick creates or updates a failure Todo. A host with an authenticated Claude subscription therefore sits idle even though the same cross-runtime sweep could continue there.

COD-144 should let the configured Codex-first stages use one Claude fallback when, and only when, the Codex process provides positive evidence that account usage is exhausted. The requested fallback mapping is:

| Stage | Primary | Claude fallback | Claude effort |
|---|---|---|---|
| Spec | `gpt-5.6-sol`, high | `claude-fable-5` | runtime default |
| Dev | `gpt-5.6-terra`, high | `claude-sonnet-5` | high |
| QA | `gpt-5.6-sol`, medium | `claude-opus-4-8` | runtime default |
| Ship | `gpt-5.6-terra`, medium | `claude-sonnet-5` | medium |

The product goal is to consume the available Codex plan first, then continue useful scheduled work on the Claude plan instead of losing the tick.

## Goals

- Allow each scheduled stage to declare one optional fallback runtime/model/effort beside its existing primary runtime config.
- Attempt the fallback exactly once after a positively classified Codex usage-exhaustion failure.
- Preserve the same card, worktree, owner-token claim, environment, capacity reservation, cancellation signal, logs, and downstream reconciliation across both attempts.
- Pass `--effort` to Claude Code when configured.
- Record both attempts and the final runtime in logs and structured run records without recording raw provider output or credentials.
- Keep legacy `runtime` plus `models` configs and existing `runtimes.<stage>` entries valid.
- Preserve current failure behavior for ordinary agent errors, invalid models, auth failures, network failures, signals, and test failures.

## Non-goals

- No fallback from Claude to Codex or multi-provider routing graph.
- No external quota API, background probe daemon, or pre-spend quota call.
- No fallback for a generic nonzero exit, transient error, unavailable model, overload, authentication failure, or missing executable.
- No change to Linear workflow states, claim ownership, queue ordering, capacity accounting, human Ship approval, or deployment behavior.
- No application code, migration, deployment, or release publishing in this spec sweep.

## July 11 recovery revision

Usage exhaustion is expected daily and is operational state, not a card failure. The launcher therefore combines the immediate one-hop fallback with a persistent, host-wide runtime cooldown:

1. Positively classified Codex exhaustion cools the Codex runtime and immediately continues the same card with its configured Claude fallback.
2. Positively classified Claude exhaustion cools Claude too. The card's exact claim, worktree, owner token, and capacity-safe resume record remain intact.
3. While one runtime is cooling down, new work selects the configured healthy runtime before executable preflight. It does not launch a sacrificial Codex process per card.
4. While every configured runtime is cooling down, work remains locally deferred. The launcher makes no Linear comment, Todo, label, or state mutation for the usage event.
5. Cooldowns last 60 minutes. At expiry, normal global admission ordering permits one probe; the first new positive exhaustion renews the cooldown for another 60 minutes, while success clears it.
6. Cooldown state is atomically persisted under launcher state and survives restarts. Its bounded record contains host, runtime, optional model scope, normalized reason, timestamps, and probe ownership only—never raw provider output.
7. `doctor` and local logs expose cooling runtimes and next probe times. Authentication, missing executables, invalid configuration, ordinary agent errors, and malformed provider output remain distinct actionable failures.

The cooldown key is host plus runtime. A model is included only when the provider's trusted error envelope explicitly identifies a model-specific allowance. This prevents unrelated workspaces sharing the same local subscription from repeatedly probing it while avoiding unnecessary provider-wide suppression for an explicitly model-scoped limit.

COD-149's generic per-card capacity retry remains useful for transient service capacity, but provider usage exhaustion takes the shared cooldown path first. It must not create a failure Todo or advance a per-card fallback counter.

## Research and existing mechanism

### Primary-source findings

- The current Codex CLI documents `codex exec --json` as newline-delimited JSON events, one per state change. That gives the launcher attempt-local structured evidence instead of scraping the shared daily text log. See [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands#codex-exec).
- Anthropic documents `claude -p` for non-interactive automation, `--model` for a full model ID, and structured output modes. The installed Claude Code 2.1.205 additionally exposes `--effort low|medium|high|xhigh|max`. See [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage).
- Anthropic’s current model catalog confirms `claude-fable-5`, `claude-opus-4-8`, and `claude-sonnet-5` as model IDs. See [Claude model overview](https://platform.claude.com/docs/en/about-claude/models/overview).
- Neither public CLI reference promises a stable, dedicated process exit code for subscription exhaustion. Classification must therefore be conservative, fixture-driven, bounded, and fail closed when output is unknown.
- The upstream Codex source at revision [`bfe31598`](https://github.com/openai/codex/commit/bfe31598c79bd2e5b9089030ae7f2978457015c8) defines JSONL `error` and `turn.failed` envelopes with a message field ([exec events](https://github.com/openai/codex/blob/bfe31598c79bd2e5b9089030ae7f2978457015c8/codex-rs/exec/src/exec_events.rs)) and maps core error notifications into them ([JSONL processor](https://github.com/openai/codex/blob/bfe31598c79bd2e5b9089030ae7f2978457015c8/codex-rs/exec/src/event_processor_with_jsonl_output.rs)).
- At the same revision, the deliberately supported personal/model usage-limit subset begins `You've hit your usage limit.` or `You've hit your usage limit for `, while transient TPM rate limiting, model overload, context exhaustion, quota/billing, and authentication use different messages/types ([protocol error source](https://github.com/openai/codex/blob/bfe31598c79bd2e5b9089030ae7f2978457015c8/codex-rs/protocol/src/error.rs), [message fixtures](https://github.com/openai/codex/blob/bfe31598c79bd2e5b9089030ae7f2978457015c8/codex-rs/protocol/src/error_tests.rs)). Workspace credit-depleted and workspace spend-cap variants intentionally fail closed and do not trigger COD-144 unless separately reviewed. Local command help independently confirms installed `codex-cli 0.144.0-alpha.4` supports `--json` JSONL mode; it does not establish that binary's source revision. The pinned upstream contract plus the locally observed CLI capability form the supported classifier baseline.

### Code already in place

- `runtimeConfigForSweep()` resolves the primary `{ runtime, model, effort }` (`scripts/linear-watch.mjs:426-441`).
- `resolveRuntimeExecutable()` and `preflightRuntimeCandidates()` resolve one primary executable before admission (`scripts/linear-watch.mjs:448-525`).
- `buildCommand()` builds both Codex and Claude commands, but Claude currently ignores configured effort (`scripts/linear-watch.mjs:537-551`).
- `dispatchAsync()` owns child spawning, the capacity PID attachment, cancellation, daily log, and one final run record (`scripts/linear-watch.mjs:5431-5497`).
- `dispatchBatch()` and `reconcileDispatchResult()` expect one final result per card and already centralize claim/failure-Todo handling (`scripts/linear-watch.mjs:5525-5544`, `5603-5665`).
- `tests/linear-watch.test.mjs` already uses event-emitter child doubles for command, spawn, PID, signal, outcome, and run-record coverage.

The design should extend this seam rather than introduce a second scheduler.

## Design decisions

### D1: Configuration shape

ELI10: The fallback belongs to the stage it protects. Keeping it inside the existing stage object lets an operator read the primary and backup together and avoids another top-level precedence system.

Recommendation: A because it adds one backward-compatible field to the mechanism COD-97 already established.

A) Add singular `fallback` under each `runtimes.<stage>` entry (recommended). **Completeness: 10/10.** It expresses the requested one-hop behavior directly and keeps the review role unchanged. A singular field deliberately prevents an unbounded provider chain.

B) Add a top-level `runtimeFallbacks.<stage>` object. **Completeness: 8/10.** It works, but splits one stage’s dispatch policy across two distant config sections and creates another precedence rule.

C) Replace each stage object with a `runtimeChain` array. **Completeness: 7/10.** It is extensible but overbuilds a one-fallback requirement and invites retry/order semantics the launcher does not need.

Net: use one nested fallback and leave omitted config behavior unchanged.

```json
{
  "runtimes": {
    "spec": {
      "runtime": "codex",
      "model": "gpt-5.6-sol",
      "effort": "high",
      "fallback": { "runtime": "claude", "model": "claude-fable-5" }
    },
    "dev": {
      "runtime": "codex",
      "model": "gpt-5.6-terra",
      "effort": "high",
      "fallback": { "runtime": "claude", "model": "claude-sonnet-5", "effort": "high" }
    },
    "review": { "runtime": "claude", "model": "claude-opus-4-8" },
    "qa": {
      "runtime": "codex",
      "model": "gpt-5.6-sol",
      "effort": "medium",
      "fallback": { "runtime": "claude", "model": "claude-opus-4-8" }
    },
    "ship": {
      "runtime": "codex",
      "model": "gpt-5.6-terra",
      "effort": "medium",
      "fallback": { "runtime": "claude", "model": "claude-sonnet-5", "effort": "medium" }
    }
  }
}
```

`runtimes.review` remains a role-only reviewer preference and does not accept scheduled fallback semantics.

### D2: Exhaustion detection

ELI10: Retrying every Codex failure under Claude could repeat partially completed work or hide a real bug. The launcher must switch plans only when Codex itself reports that usable account allowance is exhausted.

Recommendation: A because structured, attempt-local evidence is safer than reading a shared log and safer than treating all nonzero exits alike.

A) Add `--json` to scheduled Codex commands, tee the child’s JSONL to the normal log, and feed bounded parsed error events into a pure exhaustion classifier (recommended). **Completeness: 10/10.** The classifier recognizes only reviewed usage-limit fixtures and returns false for malformed, oversized, unrelated, transient, auth, model, network, and generic exit data.

B) Search the daily log after a nonzero exit. **Completeness: 4/10.** Same-repo parallel children append to the same file, so another child’s text can trigger a false fallback.

C) Treat any Codex nonzero exit as fallback-worthy. **Completeness: 2/10.** This hides real failures and can run the same material work twice after partial mutation.

Net: positive structured evidence permits one fallback; uncertainty preserves the original failure.

The classifier contract is intentionally narrow and versioned to the researched Codex event contract:

```js
codexUsageExhausted(events) -> boolean
```

- Input is stdout from this Codex child attempt only. Stderr is tee'd to the log but never classified.
- A recognized account-usage-exhaustion error returns `true` only for one of these exact structural predicates:
  - `event.type === "error"` and `event.message` starts with `You've hit your usage limit.` or `You've hit your usage limit for `; or
  - `event.type === "turn.failed"` and `event.error.message` starts with one of those same strings.
- The implementation fixtures must cite upstream revision `bfe31598` and record that `codex-cli 0.144.0-alpha.4` was the locally observed JSONL-capable version without claiming a version-to-commit mapping. A future CLI that changes the envelope or prefix fails closed until its fixture is reviewed.
- Ordinary rate throttling, service overload, context-window exhaustion, auth failure, unavailable/invalid model, network failure, cancellation, malformed JSON, missing output, and unknown messages return `false`.
- Tests pin sanitized real-shaped fixtures. Raw output is never copied into a Linear comment, failure Todo, or run record.

### D3: Attempt orchestration

ELI10: Codex and Claude are two attempts at the same reserved job, not two jobs. Keeping the retry inside `dispatchAsync()` prevents a second claim, capacity slot, worktree, or handoff.

Recommendation: A because it preserves every existing outer scheduling invariant.

A) Refactor `dispatchAsync()` around a private single-attempt helper and perform at most one fallback inside the same promise (recommended). **Completeness: 10/10.** The primary PID is attached to the existing reservation; if fallback begins, the capacity ledger updates that same reservation to the fallback PID before work continues. The outer caller receives one final result plus bounded attempt metadata.

B) Let `dispatchBatch()` enqueue a new fallback pick. **Completeness: 6/10.** It risks a second capacity reservation and complicates claim ownership, ordering, and per-card completion callbacks.

C) End the tick and rely on the next tick to select Claude. **Completeness: 5/10.** It requires persistent runtime override state and delays recovery without improving safety.

Net: one dispatch owns one or two sequential process attempts and produces one terminal result.

```text
claimed card + one capacity reservation
                 |
                 v
        launch configured Codex
          |              |
       success      nonzero/signal/error
          |              |
       terminal    positive usage-exhausted evidence?
                         | no  -> original terminal failure
                         | yes
                         v
                resolve + launch Claude once
                         |
                  success or failure
                         |
                         v
             one final reconciliation/result
```

## Detailed behavior

### Runtime resolution and validation

- Extend the primary runtime result with an optional normalized fallback, or add a neighboring pure `fallbackRuntimeConfigForSweep(config, sweep)` helper. Do not mutate config.
- A fallback is eligible only when the primary runtime is `codex`, the fallback runtime is `claude`, the fallback model is a non-empty string, any present effort is one of the installed CLI's `low`, `medium`, `high`, `xhigh`, or `max` values, and the stage is one of `spec`, `dev`, `qa`, or `ship`.
- Missing, blank, wrong-type, or unsupported fallback fields disable fallback for that stage without changing primary dispatch.
- The fallback executable is resolved only after positive exhaustion evidence. A missing Claude executable becomes the final typed start failure and enters existing failure-Todo/owned-claim cleanup behavior.
- Do not reserve a second capacity token. Before the fallback can continue, replace/reattach the existing reservation’s child PID so cancellation and stale-capacity cleanup track the live process.

### Command and output handling

- Scheduled Codex commands add `--json`; their JSONL remains in the existing log.
- Claude commands emit `--effort <level>` when configured. Unset effort emits no flag.
- The async child path uses pipe-and-tee handling so each attempt’s output can be classified without rereading the shared file. Both stdout and stderr must always be drained and streamed to the existing log. A synchronous log write failure disables classification, terminates and awaits the active child, and returns one typed dispatch-I/O failure; it must not escape a stream callback, crash the launcher, double-settle, or close the shared fd twice.
- Classification is stdout-only. Maintain at most a 16 KiB in-progress stdout line; if a line exceeds that cap, discard it through the next newline. Parse only complete UTF-8 JSON lines. Retain at most 32 candidate `error`/`turn.failed` envelopes and 64 KiB of candidate bytes total; overflow disables further classification for that attempt but never interrupts logging or the child. Non-error events are parsed then discarded immediately.
- The synchronous `dispatch()` function is currently unused by tick orchestration. Keep it behaviorally aligned or remove it only if tests prove it has no supported caller; do not leave divergent fallback semantics.

### Outcomes, claims, and failure Todos

- A successful fallback makes the overall dispatch successful. Normal child completion/handoff logic runs once.
- A failed fallback makes its typed result the final outcome. Failure reporting names both the primary exhaustion and the fallback runtime/model without raw provider text.
- A primary success remains final even if stdout contained an exhaustion-shaped error event. Fallback requires both positive bounded evidence and the primary's typed `exit` outcome with an integer, nonzero exit code; null/unknown closes fail closed, and a primary non-exhaustion failure remains the final outcome exactly as today.
- Signals and launcher interruption never initiate fallback.
- A valid dependency/repository deferral outcome file takes precedence over exhaustion evidence for every child close, including a nonzero exit with an exhaustion-looking event, and never initiates fallback.
- Claim release, failure-Todo reconciliation, refill, handoff, learning evidence, and terminal metrics run once against the final overall result.
- `reconcileDispatchResult()` must use the result's final runtime metadata rather than re-resolving the configured primary. In particular, a missing fallback executable must never poison the Codex executable cache or report Codex as the disappeared runtime.
- A fallback child reuses the same `onSpawn` callback to replace the existing capacity entry's `childPid`; `attachChildPid()` already supports replacing that field under the ledger mutation lock (`scripts/linear-watch.mjs:2354-2364`).
- A fresh fallback agent receives the same single-card prompt and `AUTO_SWEEP_*` environment. It must treat the existing card worktree and the sweep skills' resume rules as authoritative, so partial docs/code/merge state from the exhausted attempt is inspected and resumed rather than discarded.
- Check `signal.aborted` after the primary closes, before fallback executable resolution, and again immediately before fallback spawn. Either gap returns one interrupted result and must not launch Claude.

### Structured run record

Add bounded attempt metadata while preserving current fields:

```json
{
  "runtime": "claude",
  "model": "claude-sonnet-5",
  "effort": "high",
  "fallbackUsed": true,
  "attempts": [
    { "runtime": "codex", "model": "gpt-5.6-terra", "effort": "high", "outcome": "usage-exhausted" },
    { "runtime": "claude", "model": "claude-sonnet-5", "effort": "high", "outcome": "success" }
  ]
}
```

The attempt list is capped at two and contains only runtime/model/effort and normalized outcomes. Existing consumers that read the top-level final runtime fields remain valid.

## Failure modes

| Failure | Required behavior | Verification |
|---|---|---|
| Codex usage exhausted, Claude succeeds | One fallback, one successful final result, one handoff | Async dispatch test with two child doubles |
| Codex usage exhausted, Claude binary missing | Final typed start failure, owned claim released by existing start-failure path | Resolver/spawn test |
| Codex usage exhausted, Claude exits nonzero | No third attempt; final failure Todo names both attempts | Dispatch + reconciliation test |
| Codex ordinary agent/test failure | No fallback | Negative classifier and dispatch test |
| Codex transient rate limit/overload | No fallback; existing failure path | Negative fixture test |
| Codex malformed/oversized JSONL | Bounded memory, no fallback, no crash | Parser boundary tests |
| Exhaustion-looking text appears on stderr | Log it, never classify it, no fallback | Stream trust-boundary test |
| Cancellation before/during primary | Interrupt primary, no fallback | Existing signal test extended |
| Cancellation between primary close and fallback spawn | No fallback process; one interrupted final result | Two gap-race tests |
| Cancellation during fallback | Interrupt fallback, one interrupted final result | New signal test |
| Capacity PID reattachment fails | Terminate fallback and fail closed while preserving reservation safety | Capacity attachment test |
| Child writes dependency/repo deferral outcome | Preserve typed deferral and do not fallback | Existing outcome-channel regression tests |

## Pre-plan engineering review

The Tier 2 spec pass ran in unattended prose mode. The review target was this design spec; the recommended option was applied for each issue without pausing.

### Architecture

**Finding 1 (P1, confidence 10/10): final-runtime attribution.** `reconcileDispatchResult()` currently re-runs `runtimeConfigForSweep(pick.config, pick.sweep)` and uses that primary runtime for executable-cache and failure reporting (`scripts/linear-watch.mjs:5603-5645`). If a lazily resolved Claude fallback is missing, unchanged code would mark Codex unavailable. Recommendation: carry explicit `finalRuntimeConfig`, `finalRuntimeExecutable`, final lane key/scope/target, and both attempt summaries on the dispatch result; use them for claim reason, failure target/text, cache invalidation, and run records. **Completeness: 10/10.** Accepted and folded above.

**Finding 2 (P1, confidence 9/10): capacity ownership across the second PID.** The admission queue reserves once and passes `reservation.attachChildPid` into `dispatchAsync()` (`scripts/linear-watch.mjs:5981-5985`); the ledger setter safely replaces `entry.childPid` (`scripts/linear-watch.mjs:2354-2364`). Recommendation: call the same callback for the fallback PID and fail closed before fallback work if reattachment fails. **Completeness: 10/10.** Accepted and folded above.

**Finding 3 (P1, confidence 8/10): partially completed primary work.** Usage exhaustion can occur after tools have mutated the worktree or, for Ship, after a merge step. Recommendation: preserve the same worktree/env/claim, start the fallback with the same single-card sweep prompt, and explicitly rely on each sweep's existing repository inspection and Ship resume-on-merge-commit rules. Never create a clean second worktree or reset state. **Completeness: 10/10.** Accepted and folded above.

**Finding 4 (P1, confidence 9/10): classifier evidence and trust boundary.** Public docs alone do not define the error envelope or usage-limit message. Recommendation: pin the exact `error`/`turn.failed` envelope and two message prefixes from upstream Codex source revision `bfe31598`, fail closed on every other shape, and bound stdout parsing. **Completeness: 10/10.** Accepted after source verification and folded into D2.

**Finding 5 (P1, confidence 9/10): outcome and cancellation races.** Current deferral files override process classification at close, while the proposed two-attempt flow creates two abort gaps. Recommendation: preserve deferral precedence even for nonzero/exhaustion-looking output and check abort before resolution and immediately before spawn. **Completeness: 10/10.** Accepted and folded above.

### Code quality

Keep fallback resolution, JSONL classification, and the single-attempt helper in `scripts/linear-watch.mjs` near the existing runtime/dispatch functions. One pure classifier and one private attempt helper are sufficient; a new module, generic provider framework, or retry engine would be overbuilt.

### Test coverage

```text
runtime config
  +-- omitted fallback preserves primary-only behavior
  +-- valid stage fallback is normalized without config mutation
  +-- malformed/review-role/non-Codex-to-Claude fallback is ignored

Codex evidence classifier
  +-- recognized account usage exhaustion -> true
  +-- generic exit/auth/model/network/overload/transient throttle -> false
  +-- malformed, split, and oversized JSONL -> bounded false

dispatch lifecycle
  +-- primary success -> one process / one result
  +-- exhaustion -> Claude success / one final success
  +-- exhaustion -> fallback ENOENT/nonzero/interruption / one final failure
  +-- ordinary Codex failure/signal/deferral -> no fallback
  +-- primary and fallback PIDs attach to one reservation
  +-- second PID attachment failure kills fallback and fails closed
  +-- run record and failure reconciliation use final runtime + two attempts
```

Every branch above requires a focused Node unit/integration-style test with child-process doubles. No browser/E2E or LLM quality eval is appropriate because the feature is launcher process orchestration with deterministic inputs.

### Performance

No hot-path issue. Parsing is streaming and bounded, fallback is sequential, and the maximum remains two child processes for one reserved dispatch. The plan must specify byte/event caps so hostile or accidental output cannot grow memory with run length.

### Independent adversarial review

The configured reviewer role (`claude` / `claude-opus-4-8`) was attempted first but the host's Claude CLI was not authenticated. The independent review therefore ran in the current Codex runtime, which is a recorded runtime limitation rather than a skipped gate.

Initial verdict: **NEEDS_CORRECTION**. It identified six verified gaps: missing classifier provenance, final-runtime cache/record attribution, concrete parser bounds, nonzero deferral precedence, between-attempt cancellation, and the external-input security lens. All six were corrected. A second pass found one source-accuracy overstatement about workspace credit/spend-cap messages; the spec now defines the two accepted prefixes as a deliberate fail-closed subset and avoids mapping the local binary to an unproven source revision.

Final verdict after re-read: **CLEAR**. Every reuse/mechanism/premise claim required for plan generation is code- or source-backed, with no unresolved decision.

## Review depth decision

| Dimension | Initial assessment |
|---|---|
| Predicted implementation footprint | `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`, `templates/linear-sweep.json`, `.claude/linear-sweep.json`, `README.md`, and `SETUP.md`; about 180-300 changed lines |
| Behavior/state | Adds a conditional second external process attempt and changes final runtime/outcome telemetry |
| Persistence/interface | Backward-compatible config-schema and run-record additions; no database persistence |
| Dependencies | Existing Codex and Claude CLIs only; no package dependency |
| Rollout | Config-gated per stage; omitted `fallback` preserves current behavior |
| User-visible failure | Operators see fallback attempt/final runtime or the existing failure Todo |
| Material risks | External CLI output contract, process/PID lifecycle, false-positive duplicate execution, cancellation, claim/capacity safety |
| Initial tier | **Tier 2 — Material** |
| Required review targets | Spec engineering pass + independent adversarial premise review before plan; plan engineering pass after plan |
| Rationale | This is an unfamiliar external-runtime integration with interacting process, capacity, claim, and error paths. Tier 2 is the required floor even though it stays in one launcher module. |

## Specialized lens audit

| Lens | Decision | Rationale |
|---|---|---|
| Research | **Run** | External Codex/Claude CLI flags, model IDs, and output constraints are material; primary sources and installed CLI help were checked. |
| UI/design | Skip | No visual hierarchy, interaction, accessibility, responsive, or user-flow surface. |
| API/CLI/SDK devex | Skip heavyweight lens | The launcher invokes CLIs but does not change their public commands; operator config is documented directly in this spec/plan. |
| Security | **Run** | Provider-controlled stdout authorizes a second material execution, so it is an external-input trust boundary. The focused CSO review requires exact structural allowlisting, bounded stdout-only parsing, full stream draining, no output-to-command flow, redaction, and no raw provider data in Linear/run records. |
| Performance | Skip | At most one sequential fallback process after terminal primary failure; no hot-path or throughput algorithm changes. |

## Focused security review

Scope: COD-144's runtime-fallback design only. The review treated provider-controlled process output as external input and evaluated the launcher, fallback process, config, logs, claims, and run records as the attack surface.

```text
Codex process stdout (untrusted signal)
        |
        | complete JSON line, exact envelope + prefix, bounded
        v
pure exhaustion classifier ---- false ----> existing terminal failure
        |
       true
        |
trusted repo config selects fixed Claude argv (no shell)
        |
        v
same worktree + same trusted env + same claim/capacity reservation
```

Threat-model conclusions:

- **Tampering / duplicate execution:** an exhaustion-looking string in an agent message, tool output, stderr, malformed JSON, oversized line, or unknown event cannot authorize fallback. Only the two source-backed error envelopes and prefixes can. Deferral and cancellation state outrank the classifier.
- **Command injection:** provider output never becomes an executable, argument, model, prompt, path, or environment value. Fallback argv comes only from trusted repo config and is passed as an argv array, not through a shell.
- **Information disclosure:** raw provider output continues only to the local run log. Linear comments, failure Todos, learning evidence, and run records receive normalized outcome names, never raw error text. Existing failure-message sanitization remains in force.
- **Credential boundary:** a configured Claude fallback receives the same trusted child environment as a configured Claude primary. Enabling `fallback.runtime: "claude"` is the operator’s explicit cross-provider authorization; no fallback is synthesized when config omits it.
- **Resource abuse:** both streams are drained, classification memory is capped, only one sequential fallback is allowed, no second capacity token is allocated, and log-write failures terminate/await the child without uncaught callback exceptions.
- **Privilege:** Claude receives no permissions, worktree, secrets, tools, or deployment authority beyond what the same stage already grants when Claude is configured as primary.

Daily confidence-gate result: **no reportable vulnerability remains in the proposed design after the mandatory controls above**. The security safety floor is clear for plan generation. This focused AI-assisted review is not a substitute for a professional security audit.

## Repo scope

Owning repo: `linear-board-sweeps` only. No sibling repository, production deploy, migration, or release target is involved. Shipping is the configured docs/code merge-and-push path; any external publishing remains owner-attended or a Todo.

## Schema and architecture impact

`linear-sweep.json` gains an optional planned singular `fallback` object inside scheduled `runtimes.<stage>` entries. Structured run records gain optional, bounded fallback-attempt metadata. Existing config and record consumers remain compatible. `README.md` must describe this as **planned (COD-144)** until implementation ships.

## Acceptance criteria

- Existing anchors without `fallback` dispatch exactly as before.
- The template and live dogfood config carry the requested four Claude fallbacks.
- A positively classified Codex usage-exhaustion result paired with an integer, nonzero primary `exit` triggers exactly one Claude attempt in the same card dispatch; exhaustion-shaped output followed by success or a null/unknown exit does not.
- Generic nonzero exits, auth/model/network errors, transient throttling, malformed output, signals, and deferrals do not trigger fallback.
- Claude receives the configured full model ID and optional `--effort` value.
- Capacity and claim ownership remain single-job invariants across both attempts.
- Logs and run records show both normalized attempts and the final runtime without raw provider output or secrets.
- Focused dispatch/config tests pass, followed by the full Node suite; the two known no-routing baseline failures are either unchanged or independently fixed before claiming full-suite green.

## NOT in scope

- Provider-neutral policy engines, cost optimization, load balancing, or more than one fallback.
- Live quota probes or account/plan APIs.
- Automatic fallback on ordinary rate limits, overload, invalid models, or arbitrary agent failure.
- Changes to reviewer-role dispatch, Linear stages, deployment, or application behavior.

## Spec self-review

- No placeholders or unresolved product decisions remain.
- The fallback trigger is conservative and testable.
- Config, process lifecycle, telemetry, failure behavior, and compatibility requirements agree.
- The scope is one implementation plan in one repository.
- Final reassessment remains **Tier 2 — Material**. The plan engineering pass, independent plan reviewer, research lens, and focused security lens are clear after corrections; the UI/design, heavyweight devex, and performance lenses remain inapplicable for the documented reasons.

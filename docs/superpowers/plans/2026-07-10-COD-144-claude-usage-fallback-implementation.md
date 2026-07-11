# COD-144 Claude Usage Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue a Codex-first scheduled sweep with one configured Claude attempt when Codex emits positively identified account-usage exhaustion evidence.

**Architecture:** Keep one launcher demand, claim, worktree, capacity reservation, abort signal, and final reconciliation. Add a singular per-stage fallback config, source-pinned bounded JSONL evidence collection, and a private one-process attempt helper inside the existing launcher; `dispatchAsync()` may invoke that helper twice sequentially but returns one final result with two normalized attempts.

**Tech Stack:** Node.js ESM, built-in `child_process`, `StringDecoder`, filesystem APIs, `node:test`, JSON config, Markdown operator docs.

## Global Constraints

- Owning repository: `linear-board-sweeps` only.
- Fallback is optional and singular: configured Codex primary to configured Claude fallback only.
- Fallback runs exactly once and only for the exact source-backed JSONL envelope/message predicates in the spec.
- One demand keeps one claim, worktree, environment, capacity reservation, and final reconciliation across both attempts.
- No new package dependency, provider framework, retry loop, account probe, workflow state, deployment behavior, or application code.
- Provider output never becomes command/config input and never enters Linear comments, failure Todos, learning evidence, or structured run records.
- Parsing limits: stdout-only; 16 KiB maximum in-progress line; 32 candidate error events; 64 KiB candidate bytes; overflow fails closed while both streams continue to the log.
- A valid dependency/repository outcome file and launcher cancellation outrank exhaustion evidence.
- Configured fallback mapping: Spec Fable 5/default effort; Dev Sonnet 5/high; QA Opus 4.8/default effort; Ship Sonnet 5/medium.

---

## Repo scope

| Repo | Branch expectation | QA evidence | Deploy/ship path |
|---|---|---|---|
| `linear-board-sweeps` | `codex/COD-144-claude-fallback` from current `origin/main` | Focused launcher tests, JSON parse checks, docs tests, then full `node --test tests/*.test.mjs` | No production deploy. Normal merge/push to `main`; release publishing remains owner-attended or a Todo. |

## File map

| File | Responsibility |
|---|---|
| `scripts/linear-watch.mjs` | Resolve fallback config, build runtime argv, collect bounded Codex evidence, orchestrate two sequential attempts, emit final metadata, and reconcile/cache the correct runtime lane. |
| `tests/linear-watch.test.mjs` | Unit/integration-style coverage for config, classifier/parser bounds, command flags, attempt lifecycle, PID replacement, cancellation, deferral precedence, final records, and failure attribution. |
| `templates/linear-sweep.json` | Default portable four-stage Claude fallback mapping and operator comments. |
| `.claude/linear-sweep.json` | Dogfood the same fallback mapping in this workspace. |
| `README.md` | Replace planned COD-144 architecture wording with shipped behavior and safety boundaries. |
| `SETUP.md` | Explain fallback config, prerequisites, detection limits, and verification. |

## What already exists

- `runtimeConfigForSweep()` already resolves the primary stage runtime without mutating config.
- `resolveRuntimeExecutable()` already validates Codex/Claude executables.
- `buildCommand()` already owns runtime argv construction.
- `dispatchAsync()` already owns spawning, logging, cancellation, PID attachment, outcome classification, and run-record completion.
- `attachChildPid()` already replaces the PID on one capacity entry under its mutation lock.
- `childDeferredOutcomeForPick()` already gives child preflight outcome files precedence at process close.
- `dispatchBatch()` and `reconcileDispatchResult()` already produce one card result and run claim/failure reconciliation once.
- Existing event-emitter child doubles cover the relevant launcher seams.

## NOT in scope

- Claude-to-Codex fallback, more than one fallback, provider-neutral chains, cost routing, or backoff.
- Fallback for transient TPM limits, model overload, workspace credits/spend caps, quota/billing, auth, network, context, signals, malformed output, or generic failures.
- Persisting exhausted-lane state across cards/ticks; each dispatched card tests its configured primary, allowing a reset Codex allowance to recover naturally.
- Packaging/release automation or any production deploy.
- Refactoring unrelated scheduler, capacity, learning, or Linear APIs.

### Task 1: Resolve fallback config and build deterministic runtime commands

**Files:**
- Modify: `tests/linear-watch.test.mjs` near runtime resolver/command builder tests
- Modify: `scripts/linear-watch.mjs` near `runtimeConfigForSweep()` and `buildCommand()`

**Interfaces:**
- Consumes: existing `config.runtimes[sweep]`, `SWEEPS`, and `unattendedPrompt()`.
- Produces: `fallbackRuntimeConfigForSweep(config, sweep) -> { runtime, model, effort } | null`; `buildCommand()` emits Codex JSONL and Claude effort flags.

- [ ] **Step 1: Write failing fallback resolver tests**

Add table-driven assertions:

```js
test("fallbackRuntimeConfigForSweep: accepts only scheduled codex-to-claude fallback", () => {
  const config = { runtimes: {
    dev: {
      runtime: "codex", model: "gpt-5.6-terra", effort: "high",
      fallback: { runtime: "claude", model: "claude-sonnet-5", effort: "high" },
    },
    review: { runtime: "claude", model: "claude-opus-4-8", fallback: { runtime: "codex" } },
  } };
  assert.deepEqual(fallbackRuntimeConfigForSweep(config, "dev"), {
    runtime: "claude", model: "claude-sonnet-5", effort: "high",
  });
  assert.equal(fallbackRuntimeConfigForSweep(config, "review"), null);
  assert.equal(fallbackRuntimeConfigForSweep({}, "dev"), null);
});
```

Also assert malformed fallback objects, non-Codex primaries, non-Claude fallbacks, unknown stages, missing/blank/non-string models, and effort values outside `low|medium|high|xhigh|max` return `null`, and the input object is unchanged. Omitted effort remains valid.

- [ ] **Step 2: Run the resolver test and confirm the expected failure**

Run:

```bash
node --test --test-name-pattern='fallbackRuntimeConfigForSweep' tests/linear-watch.test.mjs
```

Expected: FAIL because the export does not exist.

- [ ] **Step 3: Implement the minimal pure fallback resolver**

Add beside `runtimeConfigForSweep()`:

```js
export function fallbackRuntimeConfigForSweep(config = {}, sweep) {
  if (!SWEEPS.includes(sweep)) return null;
  const primary = runtimeConfigForSweep(config, sweep);
  const fallback = config?.runtimes?.[sweep]?.fallback;
  const model = typeof fallback?.model === "string" ? fallback.model.trim() : "";
  const validEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);
  if (primary.runtime !== "codex" || fallback?.runtime !== "claude" || !model) return null;
  if (fallback.effort !== undefined && !validEfforts.has(fallback.effort)) return null;
  return { runtime: "claude", model, effort: fallback.effort };
}
```

Do not change the existing primary resolver return shape; its current deep-equality callers remain compatible.

- [ ] **Step 4: Write failing command-builder tests**

Extend the existing command tests to require:

```js
assert.ok(buildCommand({ runtime: "codex", sweep: "dev", anchorPath: "/ws" }).args.includes("--json"));
assert.deepEqual(
  buildCommand({ runtime: "claude", sweep: "ship", model: "claude-sonnet-5", effort: "medium", anchorPath: "/ws" }).args.slice(-4),
  ["--model", "claude-sonnet-5", "--effort", "medium"],
);
```

Preserve the unattended prompt assertion and add a no-effort Claude case.

- [ ] **Step 5: Run command tests and confirm they fail for missing flags**

Run:

```bash
node --test --test-name-pattern='buildCommand' tests/linear-watch.test.mjs
```

Expected: the new Codex `--json` and Claude `--effort` assertions fail.

- [ ] **Step 6: Add only the two required flags**

In `buildCommand()`:

```js
if (runtime === "claude") {
  const args = ["-p", prompt];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return { cmd: "claude", args, cwd: anchorPath };
}
const args = ["exec", "--json", "--cd", anchorPath];
```

- [ ] **Step 7: Run the focused resolver and command tests**

Run:

```bash
node --test --test-name-pattern='fallbackRuntimeConfigForSweep|buildCommand' tests/linear-watch.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "feat(COD-144): configure Claude runtime fallbacks"
```

### Task 2: Parse source-pinned Codex usage evidence with hard bounds

**Files:**
- Modify: `tests/linear-watch.test.mjs` near dispatch outcome tests
- Modify: `scripts/linear-watch.mjs` near dispatch outcome helpers

**Interfaces:**
- Consumes: stdout `Buffer` chunks from one Codex attempt.
- Produces: `isCodexUsageExhaustedEvent(value) -> boolean`; `createCodexUsageEvidenceCollector(options) -> { push(chunk), finish(), exhausted() }`.

- [ ] **Step 1: Add real-shaped positive and negative event fixtures**

Use sanitized source-backed fixtures and provenance comments:

```js
// Envelope: openai/codex bfe31598 exec_events.rs; message family: protocol/error.rs.
const PERSONAL_LIMIT_ERROR = { type: "error", message: "You've hit your usage limit. Try again later." };
const MODEL_LIMIT_FAILURE = { type: "turn.failed", error: { message: "You've hit your usage limit for codex_other. Switch to another model now, or try again later." } };
const TPM_LIMIT = { type: "error", message: "Rate limit reached for gpt-5 on tokens per min. Please try again in 11s." };
const WORKSPACE_CREDITS = { type: "error", message: "Your workspace has run out of credits." };
```

Assert only the first two return `true`. Add negative cases for agent/item messages containing the same phrase, overload, context, auth, quota, workspace spend/credit variants, missing fields, arrays, and primitives.

- [ ] **Step 2: Add parser boundary tests before implementation**

Cover:

```text
chunk-split JSON + newline                         -> true
positive stderr supplied to log-only path          -> false
16 KiB+ unterminated line then valid positive line -> false for discarded line; later valid line may match
malformed UTF-8 / malformed JSON                   -> false, no throw
33 candidate events                                -> classification disabled after cap
candidate bytes > 64 KiB                           -> classification disabled after cap
finish() with no newline                           -> parses only when within line cap
```

The overflow tests must also assert the collector retains no raw event array.

- [ ] **Step 3: Run parser tests and confirm missing exports fail**

Run:

```bash
node --test --test-name-pattern='Codex usage evidence' tests/linear-watch.test.mjs
```

Expected: FAIL because the predicate/collector do not exist.

- [ ] **Step 4: Implement the exact predicate**

```js
const CODEX_USAGE_LIMIT_PREFIXES = ["You've hit your usage limit.", "You've hit your usage limit for "];

export function isCodexUsageExhaustedEvent(value) {
  const message = value?.type === "error"
    ? value.message
    : value?.type === "turn.failed" ? value?.error?.message : null;
  return typeof message === "string"
    && CODEX_USAGE_LIMIT_PREFIXES.some((prefix) => message.startsWith(prefix));
}
```

Do not case-fold, regex-match generic `usage limit`, or inspect arbitrary nested strings.

- [ ] **Step 5: Implement the bounded streaming collector**

Use `StringDecoder` so split UTF-8 sequences are handled. The closure must:

- append decoded stdout until newline;
- discard an in-progress line once it exceeds 16 KiB through its next newline;
- parse complete lines one at a time;
- count/retain only normalized candidate metadata, never raw events;
- stop classification after 32 candidates or 64 KiB of candidate lines;
- invalidate any earlier positive match if either candidate bound is later exceeded, so a valid-looking prefix followed by a flood still fails closed;
- keep logging independent of classification state;
- expose only a boolean exhaustion result.

Do not feed stderr into this collector.

- [ ] **Step 6: Run focused classifier/parser tests**

Run:

```bash
node --test --test-name-pattern='Codex usage evidence' tests/linear-watch.test.mjs
```

Expected: PASS with positive, negative, split, malformed, and overflow cases.

- [ ] **Step 7: Commit Task 2**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "feat(COD-144): classify bounded Codex usage evidence"
```

### Task 3: Orchestrate one fallback inside the existing dispatch lifecycle

**Files:**
- Modify: `tests/linear-watch.test.mjs` near `dispatchAsync`, capacity PID, run-record, and reconciliation tests
- Modify: `scripts/linear-watch.mjs` near `dispatch()`, `dispatchAsync()`, `writeRunRecord()`, and `reconcileDispatchResult()`

**Interfaces:**
- Consumes: primary/fallback runtime configs, `spawnFn`, an explicitly injected `resolveRuntimeExecutableFn` dispatch option (defaulting to `resolveRuntimeExecutable`), `onSpawn`, abort signal, outcome file, and trusted child env.
- Produces: one final outcome containing `finalRuntimeConfig`, `finalRuntimeExecutable`, `finalRuntimeLaneKey`, `finalRuntimeScope`, `finalRuntimeStableTarget`, `fallbackUsed`, and at most two normalized `attempts`.

- [ ] **Step 1: Add a reusable child double for piped dispatch attempts**

In tests, build children with `PassThrough` stdout/stderr, a PID, `kill()` recorder, and explicit `close` emission. Make the spawn double return queued children and capture executable/argv/options per attempt. Inject a `writeChunkFn` wrapper (defaulting to `fs.writeSync`) so stdout and stderr write failures can be exercised without damaging a real fd.

- [ ] **Step 2: Write failing happy/fallback lifecycle tests**

Add tests for:

```text
primary success                         -> one spawn, fallbackUsed=false
primary success + exhaustion event      -> one spawn, primary success remains final
primary null exit + exhaustion event    -> one spawn, anomalous Codex exit remains final
primary exhaustion + Claude success     -> two sequential spawns, finalRuntime=claude, success
primary exhaustion + no fallback config -> one spawn, original Codex exit and attribution
primary ordinary exit                   -> one spawn, no fallback
primary signal/interruption             -> one spawn, no fallback
primary exhaustion + Claude nonzero     -> two spawns, final Claude failure, no third spawn
primary exhaustion + Claude ENOENT       -> typed final start failure, Claude lane metadata
```

Assert the second command uses the same `cwd`, `env`, single-card prompt, log directory, worktree env, and abort signal.

- [ ] **Step 3: Write failing precedence/race/PID tests**

Add:

- dependency and repository outcome files plus positive exhaustion stdout and nonzero primary exit: typed deferral wins and spawn count stays one;
- abort immediately after primary close but before resolver: interrupted, no Claude spawn;
- abort after resolver but before spawn: interrupted, no Claude spawn;
- `onSpawn` receives primary then fallback PID in order;
- second PID attachment rejection kills the fallback, waits for close, and returns `CAPACITY_ATTACH_FAILED` without releasing the outer reservation early.
- injected stdout and stderr log-write failures disable classification, terminate and await the active child, return one `dispatch-io-error`/`LOG_WRITE_FAILED` result, and cannot crash or double-settle.

- [ ] **Step 4: Run focused dispatch tests and confirm failures**

Run:

```bash
node --test --test-name-pattern='dispatchAsync.*fallback|fallback.*PID|fallback.*deferral|fallback.*abort' tests/linear-watch.test.mjs
```

Expected: FAIL because dispatch is primary-only.

- [ ] **Step 5: Extract one private process-attempt helper**

Create a private helper that owns exactly one child:

```js
runDispatchAttempt({ executable, command, cwd, env, fd, runtimeCfg, signal, spawnFn, onSpawn, classifyCodexStdout, writeChunkFn })
  -> Promise<{ outcome, runtimeCfg, executable, usageExhausted }>
```

It must pipe and drain both streams, invoke `writeChunkFn(fd, chunk)` for every chunk, send only Codex stdout to the collector, preserve the current PID-attachment failure kill/wait behavior, and settle once. A spawn `error` is the terminal outcome unless the helper is already in the PID-attachment kill/wait path; a later `close` must never overwrite it or close the shared fd. If either stream write throws, atomically enter a log-failure state, disable/discard classifier evidence, stop further writes, terminate the child, await `close`, and resolve one `{ kind: "dispatch-io-error", code: "LOG_WRITE_FAILED", ... }` outcome. The outer `dispatchAsync()` alone owns and closes that fd after the final attempt. Reconciliation treats this as a normal dispatch failure Todo, not an executable/start failure or unavailable runtime lane; the admission queue still releases the capacity reservation once dispatch resolves.

Remove the unused synchronous `dispatch()` after confirming `rg -n '\bdispatch\(' scripts tests` has no caller outside its definition; this avoids a primary-only implementation drifting beside the supported async path.

- [ ] **Step 6: Implement the two-attempt state machine in `dispatchAsync()`**

Extend the dispatch options destructuring to accept `resolveRuntimeExecutableFn = resolveRuntimeExecutable`; tests use this seam to trigger the two abort gaps deterministically. Flow:

```js
const primary = await runDispatchAttempt(...);
const deferred = childDeferredOutcomeForPick(pick);
if (deferred) return finish(deferred, primaryMeta);
const fallbackEligible = primary.outcome.kind === "exit"
  && Number.isInteger(primary.outcome.exitCode)
  && primary.outcome.exitCode !== 0
  && primary.usageExhausted
  && fallbackCfg;
if (!fallbackEligible) return finish(primary.outcome, primaryMeta);
if (signal?.aborted) return finish(interruptedOutcome(...), primaryMeta);
const resolution = resolveRuntimeExecutableFn("claude", env);
if (signal?.aborted) return finish(interruptedOutcome(...), primaryMeta);
if (!resolution.ok) return finish(executableMissingOutcome(...), bothMeta);
const fallback = await runDispatchAttempt(...);
return finish(childDeferredOutcomeForPick(pick) || fallback.outcome, bothMeta);
```

`finish()` writes one run record and returns one final outcome. Attempts contain only normalized runtime/model/effort/outcome. Never include provider messages. If classifier bounds overflow after an earlier match, `primary.usageExhausted` is false and this branch is not entered. Likewise, a matching event followed by primary exit 0 is final success, a null/unknown exit fails closed without fallback, and a valid exhaustion failure without fallback config preserves the original one-attempt Codex outcome, record attribution, and reconciliation.

- [ ] **Step 7: Make run records final-runtime aware**

Update `writeRunRecord()` input so top-level `runtime`, `model`, `effort`, and `resolvedRuntimeExecutable` describe the final attempt, while optional `fallbackUsed` and capped `attempts` preserve the path. Existing primary-only records retain their current values and schema fields.

- [ ] **Step 8: Make reconciliation consume final lane metadata**

In `reconcileDispatchResult()`:

- use `result.finalRuntimeConfig || runtimeConfigForSweep(...)` for runtime summary and claim reason;
- use final executable/lane scope/key/target for `runtimeDisabledByOutcome()`;
- on missing Claude, cache only the Claude lane as unavailable, never `pick.runtimeLaneKey` for Codex;
- include normalized primary-exhausted/fallback-failed context in the failure stable target and message;
- keep claim release, failure Todo, observation clearing, refill, and handoff exactly once.

- [ ] **Step 9: Add final-record and failure-attribution assertions**

Verify:

```text
Codex exhausted -> Claude success: record runtime/model=Claude, 2 attempts, no failure Todo
Codex exhausted -> Claude missing: claim start-failure cleanup runs, Claude lane cached, Codex lane untouched
Codex exhausted -> Claude exit: failure target names primary exhaustion + Claude final failure
Codex exhaustion event + exit 0: primary success, one normalized attempt
Codex exhaustion event + null exit: original anomalous exit, one normalized attempt
Codex exhausted + no fallback: original Codex failure/record/reconciliation unchanged
log write failure: typed dispatch-I/O failure, child killed/awaited, one record/finalization
primary-only success/failure: existing record and reconciliation assertions unchanged
```

- [ ] **Step 10: Run all launcher tests**

Run:

```bash
node --test tests/linear-watch.test.mjs
```

Expected: PASS.

- [ ] **Step 11: Commit Task 3**

```bash
git add scripts/linear-watch.mjs tests/linear-watch.test.mjs
git commit -m "feat(COD-144): retry exhausted Codex sweeps with Claude"
```

### Task 4: Ship the four-stage defaults and operator contract

**Files:**
- Modify: `tests/linear-watch.test.mjs` near default-config assertions
- Modify: `templates/linear-sweep.json`
- Modify: `.claude/linear-sweep.json`
- Modify: `README.md`
- Modify: `SETUP.md`

**Interfaces:**
- Consumes: the config schema implemented in Tasks 1-3.
- Produces: matching portable/live defaults and operator documentation.

- [ ] **Step 1: Extend config parity tests before editing JSON**

Parse both config files and assert this exact mapping:

```js
const expectedFallbacks = {
  spec: { runtime: "claude", model: "claude-fable-5" },
  dev: { runtime: "claude", model: "claude-sonnet-5", effort: "high" },
  qa: { runtime: "claude", model: "claude-opus-4-8" },
  ship: { runtime: "claude", model: "claude-sonnet-5", effort: "medium" },
};
```

Also assert the existing four Codex primaries and Claude reviewer role are unchanged.

- [ ] **Step 2: Run the parity test and confirm it fails**

Run:

```bash
node --test --test-name-pattern='default configs' tests/linear-watch.test.mjs
```

Expected: FAIL because no fallback objects exist.

- [ ] **Step 3: Add matching fallback objects to template and live config**

Edit only `runtimes.spec/dev/qa/ship`. Update `$comment_runtime` to state:

- fallback is singular and optional;
- it runs only for positively classified Codex personal/model usage exhaustion;
- workspace credits/spend caps and every generic failure fail closed;
- Claude must be installed/authenticated on the runner.

Keep `runtimes.review` unchanged.

- [ ] **Step 4: Update README and SETUP**

In `README.md`, remove `(planned, COD-144)` and document shipped behavior, one reservation/two attempts, failure exclusions, and normalized run-record attempts.

In `SETUP.md`, add:

- the complete four-stage JSON example;
- `claude --version` and attended `claude` login verification before unattended use;
- Codex JSONL source/version compatibility note;
- how to disable fallback by removing `fallback`;
- a dry-run caveat: dry-run validates config/selection but cannot synthesize a real exhaustion event;
- a focused test command for deterministic verification.

- [ ] **Step 5: Parse JSON and run config/docs tests**

Run:

```bash
node -e 'for (const f of ["templates/linear-sweep.json", ".claude/linear-sweep.json"]) JSON.parse(require("fs").readFileSync(f, "utf8")); console.log("json ok")'
node --test --test-name-pattern='default configs|operator docs|runtime' tests/linear-watch.test.mjs tests/agents-snippet.test.mjs
```

Expected: `json ok` and all selected tests PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add tests/linear-watch.test.mjs templates/linear-sweep.json .claude/linear-sweep.json README.md SETUP.md
git commit -m "docs(COD-144): document Claude usage fallback defaults"
```

### Task 5: Final regression and safety verification

**Files:**
- Verify only; modify Task 1-4 files only if a test exposes a COD-144 defect.

**Interfaces:**
- Consumes: completed implementation and docs.
- Produces: evidence that fallback is bounded, compatible, and docs/config stay synchronized.

- [ ] **Step 1: Run focused fallback tests with no name filter gaps**

Run:

```bash
node --test tests/linear-watch.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run documentation and config tests**

Run:

```bash
node --test tests/agents-snippet.test.mjs tests/install-watch.test.mjs tests/spec-sweep-doc.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run the complete repository suite**

Run:

```bash
node --test tests/*.test.mjs
```

Expected: all tests PASS. Baseline on 2026-07-10 was 431/433 with two unrelated `tests/linear.test.mjs` failures caused by this anchor omitting `repoRouting.byLabel`; do not claim full green if they remain. Verify COD-144 introduces no new failure and either resolve those failures on their own scoped card or report the unchanged baseline explicitly.

- [ ] **Step 4: Inspect the final diff for scope and secrets**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
```

Expected: only the six implementation/config/doc files plus the COD-144 spec and plan; no logs, raw provider events, credentials, temp files, or generated caches.

- [ ] **Step 5: Manually audit the invariant matrix**

Confirm from tests and code:

```text
one claim             yes
one capacity token    yes
at most two PIDs      yes, sequential and reattached
at most one fallback  yes
deferral before retry yes
abort before retry    yes, both gaps
raw output external   no
unknown event retry   no
final lane attribution yes
```

- [ ] **Step 6: Commit only if verification required a correction**

```bash
git add <only corrected COD-144 files>
git commit -m "fix(COD-144): harden Claude fallback verification"
```

## Failure modes and operator experience

| Production failure | Test | Handling | Operator-visible result |
|---|---|---|---|
| Personal/model Codex allowance exhausted | Positive envelope tests | One configured Claude attempt | Log/run record show normalized two-attempt path |
| Unknown/new Codex message | Negative/version test | No fallback | Existing dispatch failure Todo; update fixture only after review |
| Workspace credit/spend cap | Negative fixture | No fallback | Existing fail-closed path |
| Claude not installed | Lazy resolver test | No spawn; release owned claim as start failure | Failure Todo names Claude missing; Codex lane remains healthy |
| Claude not authenticated/invalid model | Fallback nonzero test | No third attempt | Final Claude failure with primary-exhausted context |
| Output flood/malformed JSON | Bound tests | Continue logging, disable classification | Existing primary failure; no memory growth/false fallback |
| Exhaustion event followed by exit 0 | Success-gate test | Primary success wins; no fallback | One successful Codex attempt |
| Stdout/stderr log write fails | Injected writer tests | Disable classifier, terminate/await child, settle typed I/O failure once | Normal failure Todo; no launcher crash or poisoned runtime lane |
| Deferral plus exhaustion-looking output | Precedence tests | Deferral wins | No failure Todo and no Claude attempt |
| Abort in either retry gap | Race tests | Return interrupted | No Claude process after cancellation |
| Fallback PID cannot attach | Capacity test | Kill fallback, wait close, fail closed | Capacity entry remains safe until outer release |
| Fallback succeeds after partial primary edits | Shared worktree/env assertions | Fresh agent inspects/resumes same state | One normal terminal handoff |

## Test coverage diagram

```text
config -> primary resolver [existing]
       -> fallback resolver
          +-- absent/malformed/review/non-Claude [unit]
          +-- valid stage mapping [unit]

Codex stdout -> bounded line collector
               +-- complete/split valid JSON [unit]
               +-- malformed/UTF-8/oversized [unit]
               +-- error envelope + exact prefix [unit]
               +-- every near-negative family [unit]
               +-- stderr lookalike [unit]

dispatchAsync -> primary attempt
                +-- success ----------------------> final once [integration-style]
                +-- deferral/non-exhaustion ------> final once [integration-style]
                +-- usage exhaustion
                    +-- abort gap ----------------> interrupted [integration-style]
                    +-- Claude unavailable -------> final start failure [integration-style]
                    +-- fallback attempt
                        +-- PID attach fail -------> kill/fail closed [integration-style]
                        +-- abort/signal/exit -----> final once [integration-style]
                        +-- success ---------------> final once [integration-style]

final result -> run record final runtime + attempts [integration-style]
             -> failure cache/target final lane [integration-style]
             -> claim/refill/handoff once [existing + regression]
```

## Parallelization

Sequential implementation, no parallelization opportunity. Tasks 1-4 repeatedly touch `scripts/linear-watch.mjs` and `tests/linear-watch.test.mjs`; parallel worktrees would create avoidable conflicts and split the dispatch invariant across reviewers.

## Tier 2 plan engineering review

The unattended engineering pass inspected the concrete launcher seams before accepting this plan:

- `scripts/linear-watch.mjs:426-440` returns only the primary runtime tuple, so the fallback resolver remains an additive sibling and does not change existing deep-equality callers.
- `scripts/linear-watch.mjs:537-552` is the single command-construction boundary; adding Codex `--json` and Claude `--effort` there keeps provider flags out of orchestration logic.
- `scripts/linear-watch.mjs:5169-5204` already validates the child outcome file and gives dependency/repository deferrals typed outcomes; the two-attempt state machine must call this helper before deciding to resolve or spawn Claude and again after Claude closes.
- `scripts/linear-watch.mjs:5327-5386` currently attributes run records to the primary pick, which is why final runtime/executable values must become explicit inputs rather than being inferred from `pick.runtimeExecutable`.
- `scripts/linear-watch.mjs:5431-5508` currently gives one promise ownership of spawn, cancellation, PID attachment, and run-record finalization. The extraction retains those semantics per attempt while moving fd/run-record ownership to the outer dispatcher.
- `scripts/linear-watch.mjs:5603-5650` currently derives failure and unavailable-lane metadata from the primary config/pick. Reconciliation therefore must consume final metadata from the result; otherwise a missing Claude binary would incorrectly poison the healthy Codex lane.
- `scripts/linear-watch.mjs:2354-2365` replaces `childPid` atomically under the capacity mutation lock, so sequential PID replacement needs no new reservation primitive.

Decisions made in prose, following the required unattended review mode:

| Dimension | Decision and correction |
|---|---|
| Architecture | **Accept with correction.** Keep fallback inside `dispatchAsync()` and add `resolveRuntimeExecutableFn` as an explicit injected option; no parallel provider processes or second reservation. |
| Code quality | **Accept with correction.** A private attempt helper owns exactly one process, but the outer dispatcher alone owns the shared fd and final run record. Define `error`/`close` settlement so a late event cannot overwrite the first terminal result. |
| Test quality | **Accept with correction.** In addition to positive-before-cap tests, prove that later bound overflow invalidates an earlier match; prove both resolver/spawn abort gaps through the injected resolver seam. |
| Reliability | **Accept.** Deferral files and cancellation outrank retry, PID replacement is atomic, and reconciliation runs once against final metadata. |
| Performance | **Accept.** Parsing is streaming and bounded; the only extra process is one sequential fallback after a narrow predicate. No persistent cache or hot-loop work is added. |
| Scope | **Accept.** Six implementation/config/operator files plus these two design artifacts, one repo, no deployment or release work. |

Result: **CLEAR after corrections above.** No user decision or architecture ambiguity remains.

## Focused security review of the implementation plan

The plan's material trust boundary is provider-controlled stdout authorizing a second unattended process. The focused review is clear because the implementation requires exact JSONL envelope and prefix allowlists, stdout-only classification, strict line/event/byte limits, fail-closed overflow (including invalidation of an earlier match), full stream draining to the existing trusted log, and no provider payload in argv, config, Linear, learning events, failure targets, or run records. The fallback executable/model/effort come only from trusted config and the existing resolver. Cancellation and typed child outcome files take precedence before a second spawn.

Daily security gate: **CLEAR.** This is a bounded defensive review, not a claim of complete security assurance.

## Spec-sweep review audit

| Item | Outcome |
|---|---|
| Initial tier | Tier 2 — unfamiliar external-runtime integration with process/PID/claim/capacity risk |
| Predicted footprint | 6 implementation/config/docs files; about 180-300 lines |
| Spec engineering pass | Clear after final-runtime, PID, partial-work, source-provenance, outcome-precedence, and cancellation corrections |
| Independent spec reviewer | Clear after two correction passes; configured Claude reviewer unavailable because CLI was not logged in, so current Codex reviewer used and limitation recorded |
| Research lens | Clear: official CLI docs, installed CLI help, Anthropic model docs, and pinned upstream Codex source |
| Security lens | Clear: exact allowlist, bounded stdout-only parsing, no output-to-command flow, normalized records, explicit cross-provider config |
| UI/design lens | Skipped: no UI/interaction/accessibility surface |
| Devex lens | Skipped: invokes existing CLIs; public command ergonomics do not change; operator config documented directly |
| Performance lens | Skipped: bounded parsing and one sequential fallback, no hot-path materiality |
| Plan engineering pass | Clear after injected-resolver, overflow-invalidation, and single-owner child-settlement corrections |
| Independent plan reviewer | Clear after two correction rounds: non-success gating, strict config normalization, safe log-I/O failure settlement, no-config compatibility, and integer/nonzero exit validation. Configured Claude reviewer was unavailable because its CLI was not logged in, so an independent current-Codex reviewer was used and this limitation is recorded. |
| Final tier | Tier 2 — unchanged after plan reassessment |
| Plan reassessment | Clear: spec and plan agree, all required Tier 2 reviews are clear, specialized mandatory lenses are satisfied, and no unresolved decision remains |

## Plan self-review

- Every acceptance criterion maps to a task/test.
- Every new interface is named before a later task consumes it.
- No placeholder, generic “add tests,” or unresolved product decision remains.
- Task order is TDD-first and each task ends with an independently reviewable commit.
- Scope remains one repository and no deploy/release action is implied.

## GSTACK REVIEW REPORT

| Gate | Target | Outcome |
|---|---|---|
| Initial classification | COD-144 design and predicted implementation footprint | Tier 2 — Material |
| Spec engineering | Design architecture, state, failure, and compatibility paths | CLEAR after final-runtime, PID, partial-work, provenance, precedence, and cancellation corrections |
| Independent spec review | Design spec | CLEAR after two correction passes |
| Plan engineering | Concrete repository seams, architecture, code quality, tests, reliability, performance, and scope | CLEAR after resolver injection, overflow invalidation, settlement ownership, and exact source-line checks |
| Independent plan review | Implementation plan and agreement with spec | CLEAR after success/null-exit gating, strict fallback validation, safe log-I/O handling, and compatibility tests |
| Research lens | Codex JSONL/source predicates, installed CLI flags, Claude model IDs | CLEAR |
| Security lens | Provider-output trust boundary, bounds, command flow, credential boundary, cancellation | CLEAR |
| UI/design lens | No UI or accessibility surface | SKIPPED — inapplicable |
| Devex lens | No public CLI/API contract change; operator config documented inline | SKIPPED — heavyweight lens inapplicable |
| Performance lens | One bounded parser and at most one sequential fallback | SKIPPED — no material hot-path risk |
| Final reassessment | Completed spec and plan | Tier 2 — CLEAR |

Reviewer-runtime limitation: the configured Claude review CLI was not authenticated, so independent spec/plan adversarial passes used a separate current-Codex reviewer. No review was silently omitted.

NO UNRESOLVED DECISIONS

# Gated review lenses + review/ship split — design

**Date:** 2026-07-08
**Status:** Hardened after `/plan-eng-review` (prose mode) + independent outside voice — all findings folded in; ready to implement. See `## GSTACK REVIEW REPORT` at the end.
**Scope:** Two changes to the `linear-board-sweeps` sweep model, both aimed at catching each class of defect at the cheapest stage and at decoupling *reviewing* from *shipping*:

1. **Gated review lenses.** Spread gstack's review skills across the three sweeps, each fired only when the card's type warrants it, so design/DX/security defects are caught at spec (plan) and re-verified at QA (live) instead of being discovered late or never.
2. **Review/ship split.** Break qa-sweep's fused "test + merge + deploy" into two stages separated by a human gate: qa-sweep tests only (never merges), a human approves, and a **new ship-sweep** merges + deploys + canary-verifies.

## Problem

The current pipeline concentrates all review at two choke points — `plan-eng-review` at spec, `code-review` at dev — and fuses QA with production shipping in a single unattended sweep.

```
Needs Spec ──spec-sweep──▶ Ready for Dev ──dev-sweep──▶ In Review ──qa-sweep──▶ Done
   (eng-review only)         (code-review only)          (test + merge + DEPLOY, combined)
```

Two consequences:

- **Defects are caught late or never.** Visual-design, developer-experience, security, and performance problems have no review lens. The only design feedback in the whole system is qa-sweep fixing UX bugs *after* the feature is built — the most expensive place to catch a design flaw.
- **Reviewing and shipping are coupled.** qa-sweep smoke-tests *and* merges to `main` *and* deploys to production in one pass. There is no point at which the developer eyeballs a green feature before it ships. This is also why the README must warn "leave qa-sweep on manual `kickstart` … unless you really want auto-deploys" — the sweep is too dangerous to automate precisely because testing and prod-shipping are the same step.

## Guiding principle

**Catch each defect class at the cheapest stage, and never let a machine ship to production without a human having approved that specific card.** Reviewing is a machine job spread across stages; the final ship approval is a human-only transition that a machine then executes.

---

# Part A — Gated review lenses

## The defect → stage → skill matrix

Each defect class maps to the earliest stage that can catch it. A lens fires only when the card's type makes it relevant (see "Gating" below).

| Defect class | Catch stage(s) | Skill(s) | Fires when |
|---|---|---|---|
| Correctness of the *plan* | spec | `plan-eng-review` + adversarial subagent | always *(today)* |
| Bad UX design | spec (plan) → qa (live) | `plan-design-review` → `/design-review` | card touches UI |
| Bad API/CLI/SDK ergonomics | spec (plan) → qa (live) | `plan-devex-review` → `/devex-review` | card touches API/CLI/SDK surface |
| Security hole | spec (plan) → dev (diff) → ship (pre-deploy) | `/cso` at each | card touches auth / data / external input |
| Needs external knowledge | spec (pre-brainstorm) | `/deep-research` | new integration / unfamiliar API |
| Correctness of the *code* | dev | `code-review` + `feature-dev:code-reviewer` | always *(today)* |
| "It works" is asserted, not observed | dev | `verify` / `verification-before-completion` | always |
| Behavior / regression | qa | `/qa` (structured, replaces ad-hoc click-through) | always |
| Perf regression | dev or qa | `/benchmark` | perf-sensitive surface |
| Broken deploy | **ship** (post-deploy) | `/canary` | always (see Part B) |

The pre-deploy security check runs in **ship-sweep** (it needs the merged diff), not qa-sweep.

**Deliberately excluded:** `plan-ceo-review`. Strategy/scope/ambition review is too broad for a per-card sweep and would bounce cards on subjective grounds. Scope is a human's call before a card reaches `Needs Spec`.

**Consequence for spec-sweep:** because ceo-review is out, spec-sweep must **not** call `/autoplan` (which bundles ceo + eng + design + devex and runs all four). Instead it invokes the individual `plan-*-review` skills, gated. Same prose/non-interactive fallback the sweep already uses for `plan-eng-review`.

## Per-sweep additions

### spec-sweep §2 (per card)
After the always-on `plan-eng-review` + adversarial reviewer, conditionally add:
- UI card → `plan-design-review`
- API/CLI/SDK card → `plan-devex-review`
- Security-sensitive card → `/cso` on the plan
- Research-needing card → `/deep-research` *before* brainstorming (step 1)

Each runs in prose/non-interactive mode, recommended option folded into the spec's review section, findings applied unless strongly wrong (existing scope-cut discipline unchanged).

### dev-sweep §2 (per feature)
- Frontend card → a design pass (`/frontend-design` or a taste pass like `/design-taste-frontend`) **before** code-review, to raise the floor so qa-sweep isn't the first design feedback.
- Security-sensitive card → `/cso` on the actual diff (plan-review caught design flaws; this catches implementation flaws).
- Perf-sensitive card → `/benchmark` in the worktree before landing.
- Wrap the "build/tests green" gate (step 4) with `verify` so the pass is **observed**, not asserted.

### qa-sweep §2–3 (smoke test)
- Replace ad-hoc click-through with `/qa` as the test engine (or `/qa-only` for the report form).
- Replace ad-hoc "fix UX bugs" with a structured `/design-review` pass on the running feature.
- Authenticated flows → `/connect-chrome` + `/setup-browser-cookies` for real-user sessions.
- (Security and canary move to ship-sweep — see Part B.)

## Gating mechanism (shared)

Lenses fire on **card type/domain**, read from the card's labels. `linear-rules.md` already defines type labels (`Feature`/`Bug`/`Improvement`) and domain labels as **optional and team-specific**. To drive gating deterministically without forcing a taxonomy on every team, add an optional `reviewLenses` block to `linear-sweep.json`:

```jsonc
"reviewLenses": {
  "ui":        { "labels": ["frontend", "design", "ui"] },
  "devex":     { "labels": ["api", "cli", "sdk"] },
  "security":  { "labels": ["auth", "security", "data"] },
  "perf":      { "labels": ["performance"] },
  "research":  { "labels": ["integration", "research"] }
}
```

- A sweep maps the card's labels against these sets to decide which lenses fire. **Gating is label-only** — no per-run diff inference; the label is the single source of truth for a card's type.
- **The `reviewLenses` labels must exist as team labels before they can be applied.** Writing a label to a card needs its Linear label **id** (`setIssueLabels` takes ids), and the domain labels (`frontend`, `api`, `auth`, …) are NOT in `REQUIRED_LABELS` — nothing creates them today, so a naive write would silently no-op and gating would never engage. **Fix:** `setup-team` find-or-creates every label named in a project's `reviewLenses` block (extend it to read the config's label set), so the ids exist before any sweep tries to apply them.
- **Self-healing labels (generate-if-missing).** A card carrying none of the `reviewLenses` domain labels is not silently skipped. The **first sweep to claim it** classifies it once — from its title, description, linked spec/plan, and (for dev/qa) its diff surface — and **writes the inferred domain labels back to Linear** (using the ids `setup-team` created) before gating, plus a comment saying what it applied and why. The label then persists: downstream sweeps and the human read a cheap label, not a repeated inference. Classification only ever *adds* domain labels; it never removes a human's label, and **a human relabel always wins** — if the human corrects a mis-classification, the sweep re-reads the new labels and does not re-assert its own (the correction path). A card that genuinely spans no lens (pure config/docs) runs only the always-on lenses.
  - Earliest touch is spec-sweep (`Needs Spec`), so most cards are labelled before dev/qa ever see them; the generate-if-missing step at each sweep's claim covers cards that entered mid-pipeline.
- If the `reviewLenses` block is absent entirely, only the always-on lenses run (eng-review at spec, code-review at dev, `/qa` at qa) — safe default, zero new cost and no auto-labelling for teams that don't opt in.

## Cost guardrail

The whole architecture is "cheap when idle, heavyweight only when actionable," with per-sweep model tiering in `linear-sweep.json` (`models`). Adding four review lenses to *every* card would break that. Gating is therefore mandatory, not optional, and the heavy lenses (`plan-design-review`, `plan-devex-review`, `/design-review`, `/cso`) run only when they actually fire.

**Per-lens model tiering is out of scope — it is not feasible in the current dispatch model.** `dispatch()` → `buildCommand()` emits exactly one `-m <model>` per agent pass (`linear-watch.mjs:85-100`); lenses run *inside* that one dispatched agent via Skill calls and inherit its model. There is no launcher hook to give an in-agent lens a different tier without the skill re-spawning sub-runs at another model — an architecture the one-`codex exec`/`claude -p`-per-pass dispatch doesn't provide. So all of a sweep's lenses run at the sweep's single configured tier. (If per-lens tiering is ever wanted, it's a separate change to the dispatch model, not a config addition.)

---

# Part B — Review/ship split

## New pipeline

One new human-only gate (`QA Passed` → `Ready to Ship`), one new sweep (ship-sweep).

```
… In Review ──qa-sweep──▶ QA Passed ──[human review]──▶ Ready to Ship ──ship-sweep──▶ Done
              (test only,   (human-review          (human-only            (merge +
               no merge)      column)                transition)            deploy + canary)
```

## Board taxonomy changes

Two new statuses between `In Review` and `Done`. Both are `started` (active WIP columns). **Set the board `position` on creation** so they render *between* `In Review` and `Done` — `workflowStateCreate` sets no position by default, so without it the new states land at the top/bottom of the board out of pipeline order.

| Status | Type | Meaning | Who moves it here |
|---|---|---|---|
| `In Review` | started | Built, pushed, awaiting QA | dev-sweep *(unchanged)* |
| `QA Passed` | started | Smoke-tested green, evidence attached, **awaiting human sign-off** | **qa-sweep** |
| `Ready to Ship` | started | Human reviewed and approved shipping | **human, manually (only)** |
| `Done` | completed | Merged + deployed + canary-verified | **ship-sweep** |

New labels:

| Label | Purpose |
|---|---|
| `qa:passed` | qa-sweep's green signal; ship-sweep verifies its presence before merging |
| `ship:in-progress` | ship-sweep owns this card (stale after **120 min** — merge + deploy + canary bake is slow) |
| `ship:approved` | *(optional, config-gated)* deliberate per-card human approval; see "the human gate" below |

Status names **decided**: `QA Passed` (machine says green) → `Ready to Ship` (human says go).

## The human gate (approval, honestly framed)

ship-sweep watches `Ready to Ship`, and moving a card there is the developer's approval signal. Two layers keep an accidental move from shipping junk:

1. **The `qa:passed` + green-build sanity gate** (ship-sweep step 2) means a card that never actually passed QA cannot be shipped even if it lands in `Ready to Ship` by mistake.
2. **Serial dispatch** means a mistaken *bulk* drag of several cards ships **one card per tick** (~10 min apart), leaving a window for a human to pull the rest back before they deploy.

**This is a strong policy gate, not a structural invariant** (earlier framing overstated it): Linear does not itself forbid a machine/automation/bulk-drag from entering `Ready to Ship`, and a *move* is not proof anyone *reviewed*. For teams that want a harder gate, `linear-sweep.json` may set `"requireShipApproval": true`, which makes ship-sweep additionally require a human-applied **`ship:approved`** label (a second deliberate act) before it will merge. Off by default (the move is the approval); opt-in for higher-stakes projects.

Corollary: qa-sweep, now that it never deploys, is safe to auto-run aggressively, and the README's "run qa attended" caveat goes away. The prod-risk moves entirely to ship-sweep, gated behind the human `Ready to Ship` move.

## qa-sweep changes

- **Delete §4** (merge → cleanup → deploy) entirely.
- **§3 gate** becomes: pass → add `qa:passed` + screenshots + review write-up → move card to `QA Passed`, branch left unmerged/undeleted for ship-sweep. Fail → `qa:needs-changes` back to `In Review` (unchanged).
- **Drop the claim before the status move, or the reaper will lose it.** Remove `qa:in-progress` in the same step as (or immediately before) the move to `QA Passed`. `QA Passed` is a holding state no sweep fetches; a claim stranded there after a crash is invisible to the per-sweep reaper (see "reaper holding-state pass" below).
- **Guardrails** flip from "ships to production" to "never merges, never deploys" — now symmetric with dev-sweep. Both non-merging; the branch is the truth; `Ready to Ship`/`QA Passed` are the gates.

## ship-sweep (new skill)

Claims `Ready to Ship` cards, oldest-first, `ship:in-progress` claim with heartbeat. `SWEEP_CFG.ship = { states: ["Ready to Ship"], claim: "ship:in-progress", blocked: ["blocked:needs-user"], staleMin: 120 }` — the `blocked` array is required so a card parked by the pre-merge sanity check (step 2) is not immediately re-dispatched.

**Concurrency: one in-flight prod deploy per repo — and this is NOT free today.** The launcher's tick lock is **per-host** (`~/.local/state/.../tick.lock`), but the design is explicitly multi-machine ("resumable on any machine, coordinate ONLY through origin"). The `ship:in-progress` claim label is a check-then-set with no atomicity, so two launchers on two hosts can both see no claim, both claim, and **both merge + deploy the same card to production** (a TOCTOU race). Mitigation, in order of strength:
- **Pin ship-sweep to a single designated runner** (a `shipRunner: true` flag in the registry; only that host dispatches ship). Cleanest, and realistic given one always-on Mac mini. **This is the default.**
- Failing that, **claim-confirmation re-read**: immediately after writing `ship:in-progress`, re-fetch the card and abort if a second claim/heartbeat appeared. Shrinks the window; does not close it.

A full cross-host claim protocol (and any move to parallel dispatch) is deferred — see **COD-82**. Until then, ship stays serial and single-runner.

### Steps

1. **Preflight (fail fast):** load `linear-sweep.json`, `LINEAR_API_KEY`, `config.deploy`, push creds. Confirm this host is the `shipRunner` (else skip). Ensure labels exist.
2. **Resume detection FIRST — key on the merge commit, not the branch.** ship-sweep is the one non-idempotent sweep: it merges, then *deletes the branch*, then deploys. So "branch exists" is destroyed mid-flight and cannot be the resume key. Before treating a card as fresh work, check whether its `<PREFIX>-###` merge already landed on `main` (search `main` for the merge commit / the PR's merged state) and whether a `[auto-sweep-deployed <ISO>]` marker comment exists:
   - **Not merged** → fresh work: run the sanity gate (below), then §3+.
   - **Merged, no deploy marker** → resume: skip merge, go straight to deploy (step 5) then finalize. Do NOT re-merge.
   - **Merged + deploy marker present** → resume tail: just run canary (if not yet recorded) and move to `Done`.
   The pre-merge **sanity gate** (fresh path only): `qa:passed` present, build/tests green in a reconstructed worktree, and — if `requireShipApproval` — `ship:approved` present. Any missing → comment + `blocked:needs-user`, release claim, leave in `Ready to Ship`, do **not** merge.
3. **Optional final security gate:** `/cso` on the merged diff for security-labelled cards.
4. **Merge → cleanup** (ported from qa-sweep's old §4): merge to `main` `--no-ff` resolving against `origin/main`; push `main` (never force). Delete the merged branch, prune worktree, close PR **only after the push lands** (so resume detection can still find the merge commit on `main`).
5. **Deploy** via `config.deploy`. On success, **post `[auto-sweep-deployed <ISO>]`** as the idempotency marker *before* touching status. `Todo` card for any manual deploy step.
6. **`/canary` post-deploy check + `/document-release`.** Record the canary result on the card.
7. **Terminal transition:**
   - **Canary green** → move to `Done` with deploy path + canary result; remove `ship:in-progress`.
   - **Canary red** (change is already live) → **move to `Done` + add `blocked:needs-user` + a red review comment.** Do NOT attempt an autonomous rollback (high-risk, deploy-target-specific) and do NOT leave it in `Ready to Ship` (it IS deployed, and leaving it there invites a re-ship). `Done` + `blocked:needs-user` = "shipped, verify me."

Machine-independence section mirrors the other sweeps (heartbeat, origin-holds-everything, push discipline never-force, re-read before terminal move), with the resume-on-merge-commit rule above replacing the other sweeps' resume-on-branch rule.

## Launcher / config changes

Adding a sweep is **not** one edit — the launcher has several hardcoded per-sweep lists. Change all of them, and DRY them so the *next* sweep is a one-line add:

- **`SWEEP_CFG`** (`linear-watch.mjs:48`) — add the `ship` entry above.
- **`SWEEP_ORDER`** (`:54`) — prepend `ship`: `["ship","qa","dev","spec"]`. Ship is the most-downstream stage; dispatch it first ("push toward Done"). Today an unlisted sweep gets `indexOf === -1` and sorts first *by accident* (`selectDispatch`, `:232`) — make it explicit.
- **The literal `["spec","dev","qa"]` in `tick()`** (`:591`) — this is independent of `SWEEP_CFG`. **DRY:** derive it from `Object.keys(SWEEP_CFG)` so it can't drift.
- **`copySkillsInto`** (`:469`, `["spec-sweep","dev-sweep","qa-sweep"]`) — **critical, easy to miss.** This is the ONLY mechanism that propagates skills from the kit to registered anchors on self-update. Miss it and `runUpdate` dispatches a ship pass into an anchor whose `.claude/skills/` never received `ship-sweep/SKILL.md` — the agent runs with no skill and the whole feature silently no-ops on every machine. **DRY:** pull the skill-dir list from one constant shared with `SWEEP_CFG`.
- **Reaper holding-state pass** — the per-sweep reaper only scans states its sweep fetches. The status split adds `QA Passed` (fetched by nobody) which can hold a stranded `qa:in-progress` after a crash, and a card dragged out of `Ready to Ship` mid-ship leaks `ship:in-progress`. Add a small reaper pass over the **holding states** (`QA Passed`, plus `Ready to Ship` already covered by ship) that releases any `*:in-progress` claim whose heartbeat is stale, regardless of owning sweep.
- **`scripts/linear.mjs`** — add the two states to `REQUIRED_STATES` (`:13`, with `position`) and the labels to `REQUIRED_LABELS` (`:20`); extend `setup-team` to also find-or-create the project's `reviewLenses` label set.
- **`registry`** — add `shipRunner` (which host may dispatch ship).
- **`docs/linear-rules.md`** — add the two statuses, the labels, the ship stale threshold, and update the who-moves-what table.
- **`README.md`** — update the pipeline diagram, drop the qa-sweep "run attended" caveat, add the ship-sweep row and the honestly-framed human-gate note.
- **`templates/AGENTS.snippet.md`** — add ship-sweep to the Codex-facing skill list + tool mapping.

## What already exists (reused, not rebuilt)

- **Merge/deploy logic** — ported from qa-sweep's old §4 rather than written fresh.
- **Push discipline** — `pushWithRetry` (`linear-watch.mjs:351`) already does fetch/rebase/retry, never force. ship reuses it.
- **Claim/heartbeat/reaper** — `reapDecisions`, `heartbeatAgeMin`, `SWEEP_CFG` extend to ship; only the holding-state pass is new.
- **State/label creation** — `setup-team`'s `REQUIRED_STATES`/`REQUIRED_LABELS` loop (`linear.mjs:62-88`) already creates the board idempotently; the new taxonomy is data added to those arrays.
- **Audit-marker comment pattern** — `[auto-sweep-heartbeat …]` / `[auto-sweep-bounce …]` already exist; `[auto-sweep-deployed …]` is one more of the same kind.

## Tests (required, not optional)

The launcher unit-tests the pure decision functions; extend them:
- `selectDispatch` with four sweeps → ship sorts first.
- **ship resume-state**: card in `Ready to Ship`, branch gone, merge commit on `main` → "finish the move", NOT "re-merge" (the highest-value new test — it guards the non-idempotent path).
- ship resume with `[auto-sweep-deployed]` marker → canary-tail only.
- **Reaper holding-state pass**: stranded `qa:in-progress` on a `QA Passed` card is released.
- Cross-host claim race: two launchers, `shipRunner` pin → only the pinned host dispatches ship.
- Canary-red transition → `Done` + `blocked:needs-user`, not left in `Ready to Ship`.
- `ship.blocked` honored: a `blocked:needs-user` card in `Ready to Ship` is not re-dispatched.

## Non-goals (YAGNI)

- **Bounded parallel dispatch** (an agent per independent queue/workspace) — deferred to **COD-82**; hard-blocked on the cross-host claim protocol. Serial + single-runner is the default now.
- Autonomous rollback on canary failure (flag the human; rollback is deploy-target-specific).
- Per-lens model tiering (infeasible in the one-model-per-pass dispatch; see Cost guardrail).
- ceo-review anywhere in the pipeline (scope is a pre-`Needs Spec` human decision).
- Running every review lens on every card (gating is mandatory).
- A separate human-review status *distinct from* `QA Passed` (the `QA Passed` column *is* the human-review queue).

## Files touched

| File | Change |
|---|---|
| `skills/spec-sweep/SKILL.md` | §1 generate-if-missing domain labels + gate for `/deep-research`; §2 gated `plan-design-review` / `plan-devex-review` / `/cso`; note "not `/autoplan`, no ceo" |
| `skills/dev-sweep/SKILL.md` | §1 generate-if-missing labels at claim; §2 gated design pass / `/cso` diff / `/benchmark`; wrap green-gate with `verify` |
| `skills/qa-sweep/SKILL.md` | §1 generate-if-missing labels; adopt `/qa` + `/design-review` + `/connect-chrome`; **delete §4**; §3 → `QA Passed`; drop claim before the move; flip guardrails |
| `skills/ship-sweep/SKILL.md` | **New** — resume-on-merge-commit, sanity gate, merge/deploy, deploy marker, `/canary`, `/document-release`, canary-red → `Done`+`blocked:needs-user` |
| `docs/linear-rules.md` | +2 statuses, +2–3 labels, ship stale threshold, who-moves table |
| `templates/linear-sweep.json` | `ship` sweep entry; `reviewLenses` block; `shipRunner`; optional `requireShipApproval` (no per-lens model tier) |
| `scripts/linear-watch.mjs` | `SWEEP_CFG.ship` (+`blocked`,`staleMin:120`); `SWEEP_ORDER` ship-first; DRY tick loop from `SWEEP_CFG`; **`copySkillsInto` + DRY skill-dir list**; reaper holding-state pass; `shipRunner` gate |
| `scripts/linear.mjs` | `REQUIRED_STATES` (+2, with `position`); `REQUIRED_LABELS` (+2–3); `setup-team` creates `reviewLenses` labels |
| `README.md` | Pipeline diagram, drop qa caveat, ship row, honest human-gate note |
| `templates/AGENTS.snippet.md` | ship-sweep for Codex |

## Open decisions (for review)

1. ~~**Status names**~~ — **decided:** `QA Passed` → `Ready to Ship`.
2. ~~**ship-sweep auto-eligibility**~~ — **decided:** auto-eligible, but **single-runner** (`shipRunner` pin) to close the cross-host double-deploy race. Move-to-`Ready to Ship` is the approval; `requireShipApproval` is an opt-in harder gate.
3. ~~**Cards-per-run / concurrency**~~ — **decided:** serial, one in-flight prod deploy, single runner. Broader parallelism deferred to COD-82.
4. ~~**`reviewLenses` gating**~~ — **decided:** label-only, self-healing generate-if-missing, with `setup-team` creating the label set first.

## Rollout

1. Land the board taxonomy (states + labels, with `position`) via `scripts/linear.mjs setup-team` additions — additive, no existing card moves.
2. Land ship-sweep + qa-sweep's §4 removal **together** (qa must stop deploying the same moment ship starts), including the full launcher change-set above (esp. `copySkillsInto`).
3. Land the gated review lenses independently (Part A is orthogonal to Part B — either can ship first).
4. **Validate the safe parts** with `node scripts/linear-watch.mjs tick --dry-run` (spends no tokens) — but note dry-run only exercises **queue counting**, NOT the merge→delete→deploy path. **First real ship run must be attended** (or pointed at a staging deploy target) before ship-sweep runs unattended on a live project.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` (prose mode) | Architecture & tests (required) | 1 | issues_found → all folded | 2 P1, 8 P2, 3 P3 + 7 test gaps, all folded into this revision |
| Outside Voice | independent subagent | Independent 2nd opinion | 1 | issues_found → folded | 10 findings; 6 net-new folded (cross-host race, per-lens tiering infeasible, domain-label creation, reaper holding-state blind spot, dry-run false confidence, moved≠reviewed) |

**CROSS-MODEL:** Both reviewers independently flagged the merge/deploy resume gap (branch deleted destroys the resume key) and the `copySkillsInto` silent no-op — high-confidence, both folded. The outside voice **corrected** the review on one point: the "one deploy per repo" concurrency claim was only single-host-safe; the cross-host TOCTOU double-deploy race was folded as a P1 (single-runner `shipRunner` pin).
**VERDICT:** ENG CLEARED (prose mode) — every finding folded into the design above; the plan is implementation-ready. Deferred parallelism tracked as COD-82.

NO UNRESOLVED DECISIONS

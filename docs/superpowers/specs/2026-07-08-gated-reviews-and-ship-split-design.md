# Gated review lenses + review/ship split — design

**Date:** 2026-07-08
**Status:** Proposed design, pre-implementation (author draft — not yet `/plan-eng-review` hardened)
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
| Security hole | spec (plan) → dev (diff) → qa (pre-ship*) | `/cso` at each | card touches auth / data / external input |
| Needs external knowledge | spec (pre-brainstorm) | `/deep-research` | new integration / unfamiliar API |
| Correctness of the *code* | dev | `code-review` + `feature-dev:code-reviewer` | always *(today)* |
| "It works" is asserted, not observed | dev | `verify` / `verification-before-completion` | always |
| Behavior / regression | qa | `/qa` (structured, replaces ad-hoc click-through) | always |
| Perf regression | dev or qa | `/benchmark` | perf-sensitive surface |
| Broken deploy | **ship** (post-deploy) | `/canary` | always (see Part B) |

\* The pre-ship security check moves with the deploy — see Part B (ship-sweep), not qa-sweep.

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
- **Self-healing labels (generate-if-missing).** A legacy or unlabelled card is not silently skipped. The **first sweep to claim a card that carries none of the `reviewLenses` domain labels** classifies it once — from its title, description, linked spec/plan, and (for dev/qa) its diff surface — and **writes the inferred domain labels back to Linear** before gating. It also comments what it applied and why. From then on the label is persisted: every downstream sweep (and the human) sees the same classification, and the lens decision is a cheap label read, not a repeated inference. Classification only ever *adds* domain labels; it never removes a human's label. A card that genuinely spans no lens (pure config/docs) is labelled as such (or left bare) and simply runs only the always-on lenses.
  - Earliest touch is spec-sweep (`Needs Spec`), so most cards are labelled before dev/qa ever see them; the generate-if-missing step at each sweep's claim covers cards that entered mid-pipeline.
- If the `reviewLenses` block is absent entirely, only the always-on lenses run (eng-review at spec, code-review at dev, `/qa` at qa) — safe default, zero new cost and no auto-labelling for teams that don't opt in.

## Cost guardrail

The whole architecture is "cheap when idle, heavyweight only when actionable," with per-sweep model tiering in `linear-sweep.json` (`models`). Adding four review lenses to *every* card would break that. Gating is therefore mandatory, not optional, and the heavy lenses (`plan-design-review`, `plan-devex-review`, `/design-review`, `/cso`) run on the sweep's configured tier only when they actually fire. Extend `models` to allow a per-lens tier override so, e.g., a design review can run on a stronger model than the eng-review that always runs.

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

Two new statuses between `In Review` and `Done`:

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
| `ship:in-progress` | ship-sweep owns this card (stale after 90 min — deploys are slow) |

Status names **decided**: `QA Passed` (machine says green) → `Ready to Ship` (human says go).

## Why the gate is safe by construction

ship-sweep watches `Ready to Ship`, and **only a human can move a card into `Ready to Ship`.** So even when ship-sweep is registered for the auto-sweep launcher, it can only ever fire on cards the developer personally approved. The human gate is *upstream of the machine* — a structural invariant, not a flag someone might forget to flip. Corollary: qa-sweep, now that it never deploys, becomes safe to auto-run aggressively, and the README's "run qa attended" caveat goes away.

## qa-sweep changes

- **Delete §4** (merge → cleanup → deploy) entirely.
- **§3 gate** becomes: pass → add `qa:passed` + screenshots + review write-up → move card to `QA Passed`, branch left unmerged/undeleted for ship-sweep. Fail → `qa:needs-changes` back to `In Review` (unchanged).
- **Guardrails** flip from "ships to production" to "never merges, never deploys" — now symmetric with dev-sweep. Both non-merging; the branch is the truth; `Ready to Ship`/`QA Passed` are the gates.

## ship-sweep (new skill)

Claims `Ready to Ship` cards, oldest-first, `ship:in-progress` claim with heartbeat.

**Concurrency: one in-flight prod deploy per repo.** ship-sweep processes cards sequentially and may handle more than one card in a run, but two cards whose repo sets (`config.repos`) overlap are serialized — the second card's merge/deploy/canary waits until the first card's is fully finished. Cards that touch *disjoint* repos may proceed back-to-back. In practice, since the launcher already runs strictly one agent at a time and ship-sweep works a card to completion (merge → deploy → canary → Done) before the next, this is naturally satisfied; the invariant is stated explicitly so it survives any later move to parallel per-card subagents.

1. **Preflight (fail fast):** load `linear-sweep.json`, `LINEAR_API_KEY`, `config.deploy`, push creds. Ensure labels exist.
2. **Sanity re-check before merge** (guards a card mis-dragged into `Ready to Ship`): the `<PREFIX>-###` branch exists on origin, `qa:passed` evidence is present, and the build/tests are green in a reconstructed worktree. Missing any → comment + `blocked:needs-user`, release claim, do **not** merge.
3. **Optional final security gate:** `/cso` on the merged diff for security-labelled cards.
4. **Merge → cleanup → deploy** (ported verbatim from qa-sweep's old §4): merge to `main` `--no-ff` resolving against `origin/main`; delete merged branch, prune worktree, close PR; sync + push; deploy via `config.deploy`; `Todo` card for any manual deploy step.
5. **`/canary` post-deploy check.** On failure of an *already-deployed* change: comment findings + `blocked:needs-user` and stop — **do not attempt an autonomous rollback** (rollback is high-risk and deploy-target-specific; flag the human). Note the canary result on the card either way.
6. **`/document-release`** to update docs.
7. **Move to `Done`** with deploy path + canary result; remove `ship:in-progress`.

Machine-independence section mirrors the other sweeps (heartbeat, origin-holds-everything, push discipline never-force, re-read before terminal move, bounce marker).

## Launcher / config changes

- `linear-sweep.json`: add `ship` to the sweep set (`runtime`, `models`, stale threshold), and the `reviewLenses` block from Part A.
- `scripts/linear-watch.mjs`: register the `Ready to Ship` → ship-sweep mapping in the queue→sweep table; add `ship:in-progress` to the reaper's stale-claim set (90-min threshold).
- `docs/linear-rules.md`: add the two statuses, two labels, the ship stale threshold, and update the who-moves-what table.
- `README.md`: update the pipeline diagram, drop the qa-sweep "run attended" caveat, add the ship-sweep row and the "safe by construction" note.
- `templates/AGENTS.snippet.md`: add ship-sweep to the Codex-facing skill list + tool mapping.

## Non-goals (YAGNI)

- Autonomous rollback on canary failure (flag the human; rollback is deploy-target-specific).
- ceo-review anywhere in the pipeline (scope is a pre-`Needs Spec` human decision).
- Running every review lens on every card (gating is mandatory).
- A separate human-review status *distinct from* `QA Passed` (the `QA Passed` column *is* the human-review queue; the human's approval is the move out of it).
- Changing the sweeps' selection/claim/bounce logic (Part B is additive: a status split + one new sweep reusing the existing merge/deploy code).

## Files touched

| File | Change |
|---|---|
| `skills/spec-sweep/SKILL.md` | §1 generate-if-missing domain labels + gate for `/deep-research`; §2 gated `plan-design-review` / `plan-devex-review` / `/cso`; note "not `/autoplan`, no ceo" |
| `skills/dev-sweep/SKILL.md` | §1 generate-if-missing labels at claim; §2 gated design pass / `/cso` diff / `/benchmark`; wrap green-gate with `verify` |
| `skills/qa-sweep/SKILL.md` | §1 generate-if-missing labels at claim; adopt `/qa` + `/design-review` + `/connect-chrome`; **delete §4**; §3 → `QA Passed`; flip guardrails |
| `skills/ship-sweep/SKILL.md` | **New** — claims `Ready to Ship`, sanity-check, merge/deploy, `/canary`, `/document-release` → `Done` |
| `docs/linear-rules.md` | +2 statuses, +2 labels, ship stale threshold, who-moves table |
| `templates/linear-sweep.json` | `ship` sweep entry; `reviewLenses` block; per-lens model tier |
| `scripts/linear-watch.mjs` | Queue→sweep mapping + reaper stale set for `ship` |
| `README.md` | Pipeline diagram, drop qa caveat, ship row, safety note |
| `templates/AGENTS.snippet.md` | ship-sweep for Codex |

## Open decisions (for review)

1. ~~**Status names**~~ — **decided:** `QA Passed` → `Ready to Ship`.
2. ~~**ship-sweep auto-eligibility**~~ — **decided:** auto-sweep-eligible. Moving a card to `Ready to Ship` is the approval; the launcher may then merge + deploy it unattended. Safe by construction (human gate upstream).
3. ~~**Cards-per-run**~~ — **decided:** one in-flight prod deploy **per repo** (disjoint-repo cards may proceed back-to-back); see ship-sweep concurrency note.
4. ~~**`reviewLenses` gating**~~ — **decided:** label-only. Cards with no domain labels (legacy/mid-pipeline) are auto-classified and labelled by the first claiming sweep (generate-if-missing); no per-run diff inference. See the Gating section.

## Rollout

1. Land the board taxonomy (statuses + labels) via `scripts/linear.mjs setup-team` additions — additive, no existing card moves.
2. Land ship-sweep + qa-sweep's §4 removal together (they're one logical change; qa must stop deploying the same moment ship starts).
3. Land the gated review lenses independently (Part A is orthogonal to Part B — either can ship first).
4. Validate with `node scripts/linear-watch.mjs tick --dry-run` (spends no tokens) before activating ship-sweep on any real project.

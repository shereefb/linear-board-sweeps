# Linear board rules

The sweeps assume this board shape. `scripts/linear.mjs setup-team` creates anything missing.

## Statuses (workflow states)

The pipeline flows left → right. Linear ships most of these by default; the sweeps add six (`Spec`, `Dev`, `QA`, `Signoff`, `Ship`, `Archived`). `Signoff` and `Ship` are positioned between `QA` and `Done`. **`Ship` is the human gate: only a person moves a card into it, and ship-sweep merges + deploys only from there.**

| Status | Type | Meaning | Who moves it here |
|--------|------|---------|-------------------|
| `Backlog` | backlog | Raw idea, not yet selected | human |
| `Spec` | unstarted | Selected but under-specified | human, or dev-sweep bouncing a weak card |
| `Dev` | unstarted | Designed + spec'd + reviewed to its final adaptive tier | **spec-sweep** |
| `QA` | started | Built, pushed, awaiting QA | **dev-sweep** |
| `Signoff` | started | Smoke-tested green, evidence attached, awaiting human sign-off | **qa-sweep** |
| `Ship` | started | Human reviewed and approved shipping after `Signoff`, or after a dev-marked fast path | **human, manually (only)** |
| `Done` | completed | Merged + deployed + canary-verified | **ship-sweep** |
| `Todo` | unstarted | **A human action item the agent can't do** (see below) | dev/qa-sweep (or any sweep) spins these off |
| `Canceled` | canceled | Won't do | human |
| `Duplicate` | duplicate | Superseded by another card | anyone |
| `Archived` | completed | Recorded for history; superseded/retired work | anyone |

`In Progress` is a legacy state retained for history and stale-claim cleanup only. Normal active development stays in `Dev` and carries `dev:in-progress`.

### The `Todo` lane — things only the user can do

`Todo` is the board's hand-off lane for **work the agent cannot perform itself and must delegate to the human.** Whenever a sweep hits a step that requires a person — a credential, a console click, a real-world action — it does **not** silently block or drop it. It extracts a `Todo` card describing exactly what the user must do, links it to the feature card, and keeps going. The scheduled launcher can also create system-owned `Todo` cards for operator-visible tick failures, marked with `[auto-sweep-tick-failure <fingerprint>]`. This gives the user a single tracked list of "what's waiting on me."

Typical `Todo` cards:

- **Infra / DNS** — add a DNS record, point a domain, configure a CDN.
- **Credentials & secrets** — provision an API key, set an env var in the hosting dashboard (Vercel/Fly/etc.), rotate a token.
- **Third-party portals** — register a webhook in an external console, connect an OAuth app, verify a sender domain, upload an app to a store.
- **Platform / deploy steps the agent can't trigger** — apply a prod DB migration, run a one-off deploy command, flip a feature flag in a SaaS UI.
- **Account / billing / legal** — approve a paid plan, sign a DPA, grant a permission the agent lacks.
- **Scheduled launcher failures** — fix a broken runtime command, unreachable Linear query, stale reaper write, auto-update failure, or other operator issue that prevents a tick from completing normally.

Each human hand-off `Todo` card should state, in plain language: *what* to do, *where* (which dashboard/console), and *why* (which feature it unblocks). When the user finishes it, they move the card to `Done` (or comment "done") and the linked feature can proceed. A human hand-off `Todo` is never something the agent could have done itself — if the agent can do it, it does, and no card is created.

Scheduled launcher failure `Todo` cards are deduplicated by fingerprint. Repeated ticks update the existing card at most daily unless the normalized error changes. When a later tick checks the same scope without seeing the failure, the launcher comments `[auto-sweep-tick-recovered <fingerprint> <ISO>]` and moves the Todo to `Done`. If config or credentials are too broken to write Linear, no impossible Todo is attempted; the failure stays visible in local logs and `linear-watch.mjs health` exits non-zero.

## Dependency relations

A dependent card may run only when every current visible `blockedBy` relation points to a blocker in exact canonical `Done`. Canceled, Duplicate, Archived, and other terminal-looking states remain unresolved; state type alone is insufficient. The launcher checks during queue scan and fresh claim confirmation. A scheduled child checks again, before its first material mutation, with `node "$AUTO_SWEEP_KIT_PATH/scripts/linear.mjs" dependency-status "$AUTO_SWEEP_ISSUE"` and fails closed if relation data is unreadable or incomplete.

For an independently completable prerequisite, create or reuse its issue, create the relation, and leave the dependent unclaimed. Use the relation alone: never add `blocked:needs-user` merely because a `blockedBy` relation exists. Keep `blocked:needs-user` for a direct human answer without a separate issue and for the existing crash/bounce protections. When the final blocker reaches exact `Done`, the dependent becomes eligible on the next fresh read without a dependency-label edit.

An in-progress claim means a child process owns the card. After a successful child exit, the launcher re-reads the card. If the card remains in that sweep's workflow state and the latest heartbeat owner still matches the completed child, the launcher removes only that owned claim before discovering refill work. Forward progress, another owner's newer heartbeat, or an unreadable issue leaves the label untouched. A freed Ship slot may refill from any correctly routed Ship card in the same registered source workspace, while the capacity ledger continues to allow only one active Ship child for that workspace.

Bounded cycle detection is an operational limitation, not a full graph crawl: diagnosis is only as complete as the active registered queue and relations returned to the service account. Multi-hop cycles through other workflow states, projects, teams, or invisible relations may not be diagnosed, and cross-team token visibility can omit data the launcher cannot know exists. This is not an organization-wide guarantee; operators must inspect persistent waits and access boundaries rather than assuming no reported cycle means no cycle.

## Workflow labels

Claim/release + blocked signals. The sweeps create these if missing.

| Label | Purpose |
|-------|---------|
| `spec:in-progress` | spec-sweep owns this card (stale after 45 min) |
| `dev:in-progress` | dev-sweep owns this card (stale after 90 min) |
| `qa:in-progress` | qa-sweep owns this card (stale after 120 min) |
| `qa:needs-changes` | QA found problems; back to the author |
| `qa:passed` | qa-sweep's green signal; ship-sweep's pre-merge evidence |
| `ship:in-progress` | ship-sweep owns this card (stale after 120 min) |
| `ship:approved` | *(optional)* deliberate human ship approval, required only when `config.requireShipApproval` is true |
| `fast-path:eligible` | dev-sweep's conservative marker for tiny, high-confidence changes; lets a human skip `Signoff` by manually moving from `QA` to `Ship` |
| `blocked:open-questions` | spec-sweep asked the owner questions; waiting on a reply |
| `blocked:needs-user` | dev/qa/ship blocked on a human (decision, credential, deploy) |
| `sweep:manual-only` | direct user conversation or another non-sweep skill owns the card; scheduled sweeps skip it until a human clears the label |

Use `sweep:manual-only` whenever a card is created or moved outside the scheduled sweep pipeline — for example during a direct conversation with the user, a one-off implementation session, or another non-sweep skill. Omit it only when the explicit intent is to enqueue the card for unattended spec/dev/qa/ship automation immediately. Clear it with `unblock-sweep` or an explicit human handoff when the normal sweeps should resume.

## Adaptive spec-review depth

spec-sweep records an initial review tier after codebase exploration and brainstorming:

- **Tier 0 — Mechanical:** zero engineering reviews for genuinely localized work with objective acceptance and no meaningful behavior, state, persistence, contract, dependency, migration, rollout, or material risk change.
- **Tier 1 — Bounded:** exactly one `/plan-eng-review` pass. The sweep targets the spec when requirements or architecture carry the uncertainty, or the implementation plan when execution, ordering, failure handling, or tests carry it.
- **Tier 2 — Material:** both passes. The spec review clears before plan generation, and the completed implementation plan is reviewed afterward.

Tier 0 cannot include material auth/security, data-integrity, external-input, concurrency, performance, accessibility, destructive-operation, or cross-repo risk. Destructive data migrations, auth-boundary changes, concurrency/locking, cross-repo production changes, and irreversible rollouts require Tier 2. Major public contract changes and unfamiliar external integrations default to Tier 2 unless concrete evidence supports a bounded Tier 1 classification.

Domain labels make specialized review lenses candidates, not automatic work. Pure copy, token, spacing, or icon changes may skip design review with a recorded rationale; material interaction/accessibility, public developer experience, security, and performance surfaces run their relevant lens. Security and performance gates remain mandatory whenever their material surface is present, regardless of the engineering-review tier.

After writing the implementation plan, spec-sweep reassesses the concrete file map, interfaces, dependency graph, task order, tests, failure modes, and rollout work. The final tier may stay level or increase, never decrease. Before moving the card to Dev, the spec and plan audit must record the initial and final tiers, predicted footprint, risk surfaces, selected and skipped reviews, any escalation, and outcomes. Every review required by the final tier and every materially applicable specialized lens must be clear, the two artifacts must agree, and no unresolved decisions may remain.

## Fast-path eligibility

Fast path is enabled by default in `linear-sweep.json`. Dev-sweep may add `fast-path:eligible` only after implementation, verification, code review, and independent review are all green and the change is below the configured size/risk thresholds. Set `fastPath.enabled` to `false` to require normal QA for every card. Dev-sweep still moves the card to `QA`; it never moves a card to `Ship`.

A human can then either leave the card in `QA` for normal qa-sweep, or manually move it directly to `Ship` to skip `Signoff`. ship-sweep accepts `qa:passed` or enabled `fast-path:eligible` evidence, but only after the card is already in the human-gated `Ship` column and has no live foreign `*:in-progress` claim. If `fastPath.enabled` is `false`, ship-sweep requires `qa:passed`.

Type labels (`Feature`/`Bug`/`Improvement` or your team's equivalent), Severity, and domain labels are optional and team-specific — the sweeps don't require them.

## The `auto-sweep` project label (activation for the launcher)

`auto-sweep` is a **project-level** label (not an issue label), and it is the on/off switch for the auto-sweep launcher (`scripts/linear-watch.mjs`). A registered workspace is swept automatically **iff its Linear project carries this label** — add it in the Linear UI to activate a project, remove it to pause, without touching the machine that runs the launcher. Projects without it are ignored even if their anchor is registered.

The launcher also writes/reads a few **audit-marker comments** on cards (you don't create these by hand): `[auto-sweep-heartbeat <ISO>]` (a running sweep proving it's alive), `[auto-sweep-reaper]` (a stale claim it auto-released), `[auto-sweep-orphan]` (a launcher-owned claim released after a start/defer failure or a successful same-state child exit), `[auto-sweep-bounce <from>→<to>]` (a card that moved backward — two within 48h and the card is parked with `blocked:needs-user`), `[auto-sweep-tick-failure <fingerprint>]` (a self-clearing scheduled launcher failure Todo), and `[auto-sweep-tick-recovered <fingerprint> <ISO>]` (the launcher observed recovery and moved that Todo to Done).

## Manual unblock workflow

`unblock-sweep` is a human-invoked skill for reviewing cards that carry `blocked:open-questions`, `blocked:needs-user`, or `qa:needs-changes` across all registered anchors, including paused projects. It shows one blocked card at a time, records the user's resolution in a Linear audit comment, and removes only the selected blocking label(s). It is copied to anchors for Claude/Codex discovery but is not part of scheduled `SWEEPS`.

After upgrading a legacy installation, perform a one-time dry-run audit across every registered project: find cards with `blocked:needs-user` and report only those that also have a current visible `blockedBy` relation. Label removal requires attended confirmation and direct provenance that the label merely mirrored the still-current relation and no later human request reused it; preserve ambiguous labels. The audit shares the scheduler's bounded cycle detection and cross-team token visibility limits, so it does not provide an organization-wide guarantee and must never bulk-remove labels or infer invisible/removed relations.

## Tracking rules (going forward)

- One card = one product/engineering feature, bug, or user outcome. **Not** meta-cards like "design X" or "write the plan" — attach the design doc, plan, review notes, and verification evidence to the feature card instead.
- Default to **one deployable repo per card**. If the user outcome spans sibling repos with independent deploy paths, create one parent/product card plus per-repo implementation cards, or split the original card before Dev so each child owns exactly one repo branch, QA surface, and ship path.
- A true multi-repo card is allowed only when the workspace config is multi-repo on purpose: every touched repo is listed in `config.repos`, `config.deploy` names each production target and the required order, and the card's handoff comments name the branch/PR and verification evidence for every repo. Without that, do not let a sibling-repo implementation ride a single-repo ship path; block or split it before Ship.
- When one project contains cards with different primary repos, configure `repoRouting.byLabel`. Every scheduled card must carry exactly one mapped label; missing, ambiguous, invalid, or changed routing fails closed before claim/spawn and surfaces a self-clearing routing failure. `AUTO_SWEEP_REPO` is the selected managed primary repo; configured siblings are available only for explicit multi-repo scope.
- Put the `<PREFIX>-###` key in the branch name / PR title / commit subjects where practical.
- Cards created or moved by direct user conversation or non-sweep skills should carry `sweep:manual-only` unless the user explicitly wants unattended sweeps to pick them up right away.
- Raw ideas → `Backlog`. Selected-but-underspecified → `Spec`. Designed/active → `Dev` (active work carries `dev:in-progress`). PR/review → `QA`. QA-passed, awaiting sign-off → `Signoff`. Tiny fast-path-eligible changes may be moved by a human from `QA` directly to `Ship`; otherwise human-approved shipping happens from `Signoff` → `Ship`. Shipped + verified → `Done`.
- Work discovered after the fact → a `Done` card titled `Completed: …` with a short plain-English summary + evidence.
- Every question during an unattended sweep run goes to a **card comment** — never block on interactive input.

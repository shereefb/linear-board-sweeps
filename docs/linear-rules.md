# Linear board rules

The sweeps assume this board shape. `scripts/linear.mjs setup-team` creates anything missing.

## Statuses (workflow states)

The pipeline flows left → right. Linear ships most of these by default; the sweeps add three (`Needs Spec`, `Ready for Dev`, `Archived`).

| Status | Type | Meaning | Who moves it here |
|--------|------|---------|-------------------|
| `Backlog` | backlog | Raw idea, not yet selected | human |
| `Needs Spec` | unstarted | Selected but under-specified | human, or dev-sweep bouncing a weak card |
| `Ready for Dev` | unstarted | Designed + spec'd + eng-reviewed | **spec-sweep** |
| `In Progress` | started | Actively being built | **dev-sweep** (or human) |
| `In Review` | started | Built, pushed, awaiting QA | **dev-sweep** |
| `Done` | completed | Smoke-tested + merged + deployed | **qa-sweep** |
| `Todo` | unstarted | Ship prerequisite (env var, migration, platform deploy) | dev/qa-sweep spins these off |
| `Canceled` | canceled | Won't do | human |
| `Duplicate` | duplicate | Superseded by another card | anyone |
| `Archived` | completed | Recorded for history; superseded/retired work | anyone |

## Workflow labels

Claim/release + blocked signals. The sweeps create these if missing.

| Label | Purpose |
|-------|---------|
| `spec:in-progress` | spec-sweep owns this card (stale after 45 min) |
| `dev:in-progress` | dev-sweep owns this card (stale after 90 min) |
| `qa:in-progress` | qa-sweep owns this card (stale after 90 min) |
| `qa:needs-changes` | QA found problems; back to the author |
| `blocked:open-questions` | spec-sweep asked the owner questions; waiting on a reply |
| `blocked:needs-user` | dev/qa blocked on a human (decision, credential, deploy) |

Type labels (`Feature`/`Bug`/`Improvement` or your team's equivalent), Severity, and domain labels are optional and team-specific — the sweeps don't require them.

## Tracking rules (going forward)

- One card = one product/engineering feature, bug, or user outcome. **Not** meta-cards like "design X" or "write the plan" — attach the design doc, plan, review notes, and verification evidence to the feature card instead.
- Put the `<PREFIX>-###` key in the branch name / PR title / commit subjects where practical.
- Raw ideas → `Backlog`. Selected-but-underspecified → `Needs Spec`. Designed → `Ready for Dev`. Active → `In Progress`. PR/review/QA → `In Review`. Shipped + verified → `Done`.
- Work discovered after the fact → a `Done` card titled `Completed: …` with a short plain-English summary + evidence.
- Every question during an unattended sweep run goes to a **card comment** — never block on interactive input.

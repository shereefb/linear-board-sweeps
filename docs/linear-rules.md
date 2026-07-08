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
| `Todo` | unstarted | **A human action item the agent can't do** (see below) | dev/qa-sweep (or any sweep) spins these off |
| `Canceled` | canceled | Won't do | human |
| `Duplicate` | duplicate | Superseded by another card | anyone |
| `Archived` | completed | Recorded for history; superseded/retired work | anyone |

### The `Todo` lane — things only the user can do

`Todo` is the board's hand-off lane for **work the agent cannot perform itself and must delegate to the human.** Whenever a sweep hits a step that requires a person — a credential, a console click, a real-world action — it does **not** silently block or drop it. It extracts a `Todo` card describing exactly what the user must do, links it to the feature card, and keeps going. This gives the user a single tracked list of "what's waiting on me."

Typical `Todo` cards:

- **Infra / DNS** — add a DNS record, point a domain, configure a CDN.
- **Credentials & secrets** — provision an API key, set an env var in the hosting dashboard (Vercel/Fly/etc.), rotate a token.
- **Third-party portals** — register a webhook in an external console, connect an OAuth app, verify a sender domain, upload an app to a store.
- **Platform / deploy steps the agent can't trigger** — apply a prod DB migration, run a one-off deploy command, flip a feature flag in a SaaS UI.
- **Account / billing / legal** — approve a paid plan, sign a DPA, grant a permission the agent lacks.

Each `Todo` card should state, in plain language: *what* to do, *where* (which dashboard/console), and *why* (which feature it unblocks). When the user finishes it, they move the card to `Done` (or comment "done") and the linked feature can proceed. A `Todo` is never something the agent could have done itself — if the agent can do it, it does, and no card is created.

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

## The `auto-sweep` project label (activation for the launcher)

`auto-sweep` is a **project-level** label (not an issue label), and it is the on/off switch for the auto-sweep launcher (`scripts/linear-watch.mjs`). A registered workspace is swept automatically **iff its Linear project carries this label** — add it in the Linear UI to activate a project, remove it to pause, without touching the machine that runs the launcher. Projects without it are ignored even if their anchor is registered.

The launcher also writes/reads a few **audit-marker comments** on cards (you don't create these by hand): `[auto-sweep-heartbeat <ISO>]` (a running sweep proving it's alive), `[auto-sweep-reaper]` (a stale claim it auto-released), and `[auto-sweep-bounce <from>→<to>]` (a card that moved backward — two within 48h and the card is parked with `blocked:needs-user`).

## Tracking rules (going forward)

- One card = one product/engineering feature, bug, or user outcome. **Not** meta-cards like "design X" or "write the plan" — attach the design doc, plan, review notes, and verification evidence to the feature card instead.
- Put the `<PREFIX>-###` key in the branch name / PR title / commit subjects where practical.
- Raw ideas → `Backlog`. Selected-but-underspecified → `Needs Spec`. Designed → `Ready for Dev`. Active → `In Progress`. PR/review/QA → `In Review`. Shipped + verified → `Done`.
- Work discovered after the fact → a `Done` card titled `Completed: …` with a short plain-English summary + evidence.
- Every question during an unattended sweep run goes to a **card comment** — never block on interactive input.

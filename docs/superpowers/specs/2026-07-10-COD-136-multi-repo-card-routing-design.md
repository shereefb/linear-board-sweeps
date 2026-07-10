# COD-136: Label-Based Multi-Repository Card Routing

Linear: COD-136
Status: approved design
Date: 2026-07-10

## Problem

The launcher materializes every repository in a configured workspace, but it
always derives a card's worktree from `config.repos[0]`. SafeTaper uses one Linear
project for five applications, so Guide, Admin, Portal, and Slack cards are sent
to the Coach checkout. Those cards are then parked as manual-only or dependency
blocked even though the scheduler, host capacity, and Linear dependency gate are
healthy.

Adding the sibling repositories to `config.repos` alone would not fix this: it
would preserve the same first-entry worktree choice while widening the ship
scope. The launcher needs an explicit, deterministic primary-repository route
for each card, while retaining every configured repository for intentional
multi-repo work.

## Goals

- Route each SafeTaper card from its existing `app:*` label to one configured
  primary repository.
- Resolve both source and managed repository paths by configuration index so a
  managed sibling's stable-slug path is never guessed.
- Fail closed before claim or spawn if routing is missing, ambiguous, invalid, or
  changes during dispatch admission.
- Preserve legacy first-repository behavior for workspaces without routing config.
- Carry the selected route through initial dispatch, same-repo refill, and stage
  handoff, and expose it to the child.
- Keep relation-only dependency gating: a `blockedBy` relation never adds
  `blocked:needs-user`, and exact `Done` releases dependents automatically.
- Configure every SafeTaper repository and document every production target,
  canary, and attended gate.
- Keep the host ceiling at ten. Routing should improve useful concurrency by
  separating independently owned repos; it must not weaken the serial Ship gate.

## Non-goals

- Do not infer ownership from title, description, branch, or issue identifier.
- Do not automatically choose among multiple mapped app labels.
- Do not create a second SafeTaper Linear project per repository.
- Do not make Guide's attended Vercel cutover or Slack's missing Vercel linkage
  autonomous.
- Do not remove genuine human blockers such as Firebase authentication.
- Do not add a mirrored dependency label.

## Configuration

Routing is opt-in:

```json
{
  "repos": [
    "safetaper-coach",
    "safetaper-guide",
    "safetaper-admin",
    "safetaper-client-portal",
    "safetaper-slack"
  ],
  "repoRouting": {
    "byLabel": {
      "app:coach": "safetaper-coach",
      "app:guide": "safetaper-guide",
      "app:admin": "safetaper-admin",
      "app:portal": "safetaper-client-portal",
      "app:slack": "safetaper-slack"
    }
  }
}
```

When `repoRouting` is absent, the launcher preserves the existing first-repo
default. When it is present, a card must carry exactly one label named in
`repoRouting.byLabel`. The mapping value must exactly equal an entry in
`config.repos`. Zero matches, multiple matches (including two labels mapped to
the same repo), duplicate repo entries, or an unknown target are configuration
errors. They produce a stable, self-clearing `repo-routing` failure Todo and do
not mutate the feature card except to release a launcher-owned claim if a race
is detected after claiming.

The exact-one-label rule makes ownership visible on the board and prevents a
future label edit from silently changing the destination. A genuinely
multi-repo card still has one primary app label; all configured sibling repos
remain materialized and available to its plan. For example, SAF-200 is primarily
Admin and may also verify its existing Coach PR because both repos are configured.

## Route Model

The launcher resolves source and managed repository arrays using the same
`config.repos` order, then creates:

```text
route = {
  label,
  repoEntry,
  sourceRepoPath,
  managedRepoPath
}
```

`managedRepoPath` is authoritative for the card worktree. The child receives:

```text
AUTO_SWEEP_REPO=<managed primary repo>
AUTO_SWEEP_SOURCE_REPO=<source primary repo>
AUTO_SWEEP_REPO_LABEL=<expected routing label>
AUTO_SWEEP_REPO_ENTRY=<expected configured repo entry>
AUTO_SWEEP_WORKTREE=<managed primary repo>/.worktrees/<issue>
```

The child still runs with the managed anchor as cwd and can inspect
`config.repos` for explicitly approved multi-repo work. The canonical sweep
skills must treat `AUTO_SWEEP_REPO` as the scheduled card's primary repo and must
not switch primary ownership implicitly.

Before dependency checks, claim acquisition, or material work, every scheduled
child runs `linear.mjs repo-status` with the expected label and repo entry. The
command re-reads the live issue labels and writes a typed
`repo-routing-deferred` child outcome on any mismatch. Child outcomes are
first-failure-wins so a later successful preflight cannot erase an earlier
routing or dependency failure.

## Admission And Race Handling

Routing is checked at every path that can schedule work:

1. Queue scan partitions actionable cards into routed and route-failed cards.
   Only routed cards enter candidate counts, board ordering, observations, and
   capacity admission.
2. Initial and refill dispatch refetch the card immediately before claim. The
   fresh labels must resolve to the same route carried by the demand.
3. Ship performs the same fresh route check immediately before spawn; it remains
   unclaimed until the canonical Ship child owns the existing serial gate.
4. Handoff refetches the moved card and requires the route to remain unchanged.
5. A mismatch records a routing failure, releases only an already-owned launcher
   claim if one exists, and performs no material work.

Routing failure scope is stage-specific (`<sweep>:routing`) and the stable target
is the issue identifier. A successful complete routing scan marks that scope
checked, allowing the existing failure-Todo reconciler to close recovered Todos.
Logs name the issue, matched labels, and expected configured values without
including secrets.

## Parallelism

`parallel.maxNonShipDispatches` remains the workspace-candidate limit and
`capacity.maxActiveChildren` remains the crash-recoverable host ceiling of ten.
Ship remains serial. The selected managed primary repo becomes the key for
same-repo active counts and refill eligibility:

- a completed Guide child refills only another Guide card;
- Admin and Guide children may run concurrently when host capacity exists;
- two cards routed to the same primary repo respect that repo's per-card slot
  limit;
- broad dirty-checkout checks remain conservative across all configured repos.

Initial and dry-run admission share the same per-primary-repo selector.
Follow-up handoff/refill reserves a repo slot atomically before child execution,
so concurrent completions cannot briefly exceed the configured same-repo limit.

This uses the current host more efficiently without increasing its maximum
fan-out. The earlier stall was caused by zero eligible/routable work, not CPU or
memory pressure, so no interval or capacity increase accompanies this fix.

## SafeTaper Deployment Matrix

`config.deploy` becomes a per-repository object:

| Primary repo | Production path | Canary | Gate |
|---|---|---|---|
| Coach | Firebase Hosting Git workflow; ADC wrapper for Functions | `https://fir-coach-d68fe.web.app/` and `/schedule`; functions list | Firestore indexes and mobile promotion remain attended |
| Admin | Linked Vercel project `safetaper-coach-admin`; promote a validated preview | `/api/health`, then secret-gated auth smoke | Preserve dark-launch/test-mode gates; production-writing smoke requires approval |
| Portal | Linked Vercel project `safetaper-client-portal`; Git integration or explicit Vercel deploy | `https://hello.safetaper.com/`, `/eligibility`, `/start` | Hosted env must be verified; no unattended signup/payment writes |
| Slack | Existing Vercel production domain | `/`, `/health`, `/test` plus manifest URL check | Fail closed until the repo is linked to the existing project; dashboard changes are attended |
| Guide | Intended existing Vercel project `safetapercoach` | Preview core-guide flow after app/runbook exists | Ship remains attended and relation-blocked until cutover, rollback, URL, and executable canary are approved |

## Recovery Sequence

After the launcher and SafeTaper config are installed and dry-run proves routes:

1. Push SAF-207's existing clean Guide commit, document recovery, remove only
   `sweep:manual-only`, and leave it in Dev for the scheduler to claim.
2. Complete SAF-248 only after Admin routing and the Admin+Coach QA/Ship runbook
   are proven. Its existing relation then releases SAF-200 automatically; no
   label removal is needed.
3. Leave SAF-204 and SAF-234 relation-blocked by the single existing SAF-245
   Firebase-auth Todo. Complete SAF-245 only after a read-only production auth
   check succeeds.
4. Leave genuine human blockers unchanged. SAF-249 is already Done and requires
   no recovery mutation.

## Verification

- Pure routing tests cover legacy fallback, each label, missing/ambiguous/invalid
  routes, source/managed index pairing, and stable failure events.
- Dispatch tests prove no claim/spawn on route errors or label races.
- Initial, refill, handoff, Ship, worktree/env, same-repo count, and slugged
  managed sibling behavior are covered.
- All Node tests pass, followed by the repository review workflow.
- Installed `doctor`, `--dry-run`, launchd state, managed clone state, and one
  attended live tick prove every registered workspace is healthy.
- Linear relations are reread after recovery mutations; dependents must become
  ready from exact Done without `blocked:needs-user` removal.

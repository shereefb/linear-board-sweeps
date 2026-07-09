# COD-116: Managed Runner Isolation And Recovery Design

Linear: COD-116
Status: planned
Date: 2026-07-09

## Problem

Scheduled sweeps are still too easy to stop accidentally. COD-110 moved launchd onto a managed clean kit clone, so ordinary edits in this `linear-board-sweeps` checkout no longer dirty the launcher runtime. But the launcher still dispatches child sweeps against registered human anchor checkouts. When those anchors contain normal local work, screenshots, editor artifacts, or an uncommitted fix, the unattended tick refuses to dispatch and opens a `Todo` card such as:

```text
anchor checkout has 2 uncommitted path(s); refusing unattended dev-sweep dispatch until committed, stashed, or reverted
```

That refusal is correct for safety. It is also fragile as an operating model:

- Human workspaces and unattended automation share the same checkout surface.
- Generated QA/design artifacts can land in the repo root and block future dispatches.
- Dirty-checkout failures report only a count, not the exact paths.
- Recovery can lag if a later tick does not revisit the same dispatch scope.
- The operator has no single "doctor" command that explains which host, registry entry, managed clone, or anchor is currently blocking scheduled work.
- Multi-machine setups make this harder to reason about because one host can report dirty paths under `/Users/teacher/...` while another operator is looking at `/Users/jarvis/...`.

The result is exactly the recent pattern: there may be no real Dev or QA work in progress, but scheduled ticks still fail because the runner is coupled to a dirty human checkout.

## Goals

- Keep unattended launchd dispatch independent from day-to-day human anchor checkouts.
- Preserve the safety invariant: scheduled sweeps never run from a dirty checkout.
- Preserve multi-repo workspace semantics where `.claude/linear-sweep.json` can refer to sibling repos.
- Make generated artifacts land outside tracked repo roots by default.
- Report dirty checkout blockers with exact path samples and the host/managed path involved.
- Reconcile dirty-checkout recovery even when no new card is selected for that same dispatch scope.
- Provide an idempotent `doctor` command that tells an operator what is registered, what launchd is using, what is dirty, and how to fix or refresh it.
- Keep ship serial and human-gated.

## Non-goals

- Do not make the launcher ignore dirty checkouts.
- Do not auto-stash, auto-commit, or auto-revert user work.
- Do not replace launchd with a long-lived service.
- Do not introduce a central remote control plane.
- Do not copy arbitrary untracked files from human workspaces into managed workspaces.
- Do not dispatch production ship work from more than the configured ship-runner host.
- Do not implement the hardening in this spec-sweep pass; this pass defines the design and plan.

## Brainstormed Approaches

### A) Ignore or allowlist common generated artifacts

Completeness: 4/10. This reduces failures from screenshots like `cod-65-stage-config-desktop.png`, but it does not solve dirty user edits, multi-host confusion, runtime drift, or exact recovery. It also creates a new policy problem: the allowlist will keep growing, and a bad allowlist could hide files that should block dispatch.

### B) Managed runtime kit plus managed workspace clones (recommended)

Completeness: 10/10. The existing managed kit clone becomes one part of a fuller managed runtime. Each registered human anchor records a source workspace, but scheduled dispatch runs inside a managed workspace root under the launcher data directory. The managed root contains clean clones for the anchor repo and any configured sibling repos. The launcher fast-forwards those clones from origin before dispatch, then dirty-checks the managed clones, not the human checkouts.

This keeps the safety invariant while removing the most common accidental blocker. A dirty human checkout can still be reported by `doctor`, but it does not stop unattended work once the relevant commits are pushed to origin.

### C) Run everything through remote CI or a hosted worker

Completeness: 7/10. This would isolate automation strongly, but it is larger than the current local-first launchd architecture. It would also introduce new auth, secret, cost, and debugging surfaces. The project already has a working local launcher; COD-116 should harden that model before replacing it.

Net: implement B. Use allowlists only for artifact placement rules, not as a dirty-check bypass.

## Proposed Behavior

Registration remains human-facing:

```bash
node scripts/linear-watch.mjs register /Users/jarvis/Documents/code/SafeTaper\ Apps/safetaper-coach
```

The registry stores both the source anchor and a managed workspace path:

```json
{
  "repos": ["/Users/jarvis/Documents/code/SafeTaper Apps/safetaper-coach"],
  "managedAnchors": {
    "/Users/jarvis/Documents/code/SafeTaper Apps/safetaper-coach": {
      "sourceAnchorPath": "/Users/jarvis/Documents/code/SafeTaper Apps/safetaper-coach",
      "managedWorkspaceRoot": "/Users/jarvis/.local/share/linear-board-sweeps/workspaces/safetaper-coach",
      "managedAnchorPath": "/Users/jarvis/.local/share/linear-board-sweeps/workspaces/safetaper-coach/safetaper-coach",
      "createdAt": "2026-07-09T00:00:00.000Z",
      "updatedAt": "2026-07-09T00:00:00.000Z"
    }
  }
}
```

Before dispatch, the launcher resolves the source anchor config, then materializes a managed workspace:

```text
source workspace
  /Users/jarvis/Documents/code/SafeTaper Apps/
    safetaper-coach/        # source anchor, holds .claude/linear-sweep.json
    safetaper-admin/        # sibling repo from config.repos

managed workspace
  ~/.local/share/linear-board-sweeps/workspaces/safetaper-coach/
    safetaper-coach/        # managed anchor clone
    safetaper-admin/        # managed sibling clone
```

For scheduled dispatch, `pick.anchorPath` becomes the managed anchor path and resolved repo paths point at managed sibling clones. For attended commands, `register`, `activate`, `deactivate`, `list`, and `doctor` still accept and display source paths so the operator recognizes their workspace.

## Managed Workspace Resolution

The current launcher treats the anchor parent directory as the workspace root. That cannot be lost. A managed anchor clone alone is not enough because relative sibling entries in `.claude/linear-sweep.json` would otherwise resolve to missing paths.

Implementation should add a helper:

```text
resolveWorkspaceRepos(anchorPath, config, { mode: "source" | "managed", registryEntry })
```

Rules:

- Source mode preserves current behavior.
- Managed mode maps every configured repo to a clone under `managedWorkspaceRoot`.
- Relative repo entries keep their repo basename under the managed workspace root.
- Absolute repo entries are supported by cloning their remote into the managed workspace under a stable sanitized basename, while recording the source absolute path in metadata.
- Missing or remote-less repos block scheduled dispatch with an exact setup failure. They should not silently fall back to the human checkout.

This keeps multi-repo overlap detection, worktree creation, skill refresh, and child env setup working against managed paths.

## Secret And Environment Handling

The launcher needs `LINEAR_API_KEY`, and child sweeps may need app-specific local env. The managed workspace must not turn secrets into tracked files or broad copies of the human checkout.

Recommendation:

- Continue reading the control-plane `LINEAR_API_KEY` from the source anchor `.env` during registration and `doctor`.
- When materializing a managed anchor, copy only configured allowed env files (`.env` by default) from source to managed if they exist and are gitignored in the source repo.
- Set mode `0600` on copied env files.
- Never copy files that are tracked by git.
- If the source env file is missing, leave managed env absent and let `doctor` report the missing key.
- Document that pushed commits are the source of code truth; copied env files are only local runtime inputs.

This is intentionally conservative. It avoids a hidden sync of untracked source files while preserving the current `.env` setup path.

## Dirty-Checkout Policy

Scheduled dispatch should dirty-check:

- managed kit clone;
- managed anchor clone;
- every managed repo clone that a selected sweep may touch.

It should not dirty-check the source human anchor as a dispatch blocker. `doctor` can still report source dirtiness as advisory information.

Dirty events should include exact path samples:

```text
managed anchor checkout has 3 uncommitted path(s); refusing unattended dev-sweep dispatch until cleaned
paths:
  ?? cod-65-stage-config-desktop.png
  ?? cod-65-stage-config-mobile.png
  M  README.md
```

Cap the list at 25 paths and include an overflow count. The failure Todo title can remain short, but the body should include the path sample, host, source anchor path, managed anchor path, and recovery command hints.

## Artifact Isolation

Child env already includes:

- `AUTO_SWEEP_WORKTREE`
- `AUTO_SWEEP_LOG_DIR`
- `AUTO_SWEEP_TMPDIR`
- `AUTO_SWEEP_APP_PORT`
- `AUTO_SWEEP_SCREENSHOT_DIR`
- `AUTO_SWEEP_BROWSER_PROFILE_DIR`

COD-116 should make this contract stricter:

- Scheduled sweep skills must use `AUTO_SWEEP_SCREENSHOT_DIR` for generated screenshots and videos.
- Launcher-created screenshot, browser profile, temp, and log directories must live under the managed run root, not under a repo root.
- `doctor` should flag recent image/video artifacts in source repo roots as advisory cleanup suggestions.
- Tests should assert that child env paths never point inside the tracked repo root except `AUTO_SWEEP_WORKTREE`, which is intentionally disposable.

Generated evidence can still be uploaded or linked to Linear. It should not become untracked files in an anchor checkout unless a human explicitly chooses to save it there.

## Recovery Reconciliation

COD-91 introduced self-clearing failure Todos, but dirty-checkout recovery currently depends on a later tick checking the same scope. If no card is selected for that scope, recovery can appear stale.

Add a recovery scan:

- On every active tick, read open auto-sweep failure Todos for the project.
- For dirty-checkout fingerprints, parse the stable target from the Todo metadata.
- Re-check that target if it is a known managed kit, managed anchor, or managed repo path for this host.
- If clean, comment recovery and move the Todo to `Done`, even if no dispatch was attempted for that sweep in this tick.
- If the target belongs to another host or an unknown source path, leave it open and include that in `doctor`.

This makes recovery tied to the failing checkout becoming clean, not to queue luck.

## Doctor Command

Add:

```bash
node scripts/linear-watch.mjs doctor
node scripts/linear-watch.mjs doctor --json
node scripts/linear-watch.mjs doctor <anchor>
```

Human output should answer:

- Which registry file is in use?
- Which kit clone does launchd point at?
- Is the loaded launchd plist pointing at the managed wrapper?
- Which anchors are registered and active?
- For each anchor, what are the source and managed paths?
- Are managed clones present, clean, on the expected branch, and fast-forwardable?
- Which configured repos cannot be cloned because they lack an origin remote?
- Are copied env files present with safe permissions?
- Which source checkouts are dirty advisory-only?
- Which open auto-sweep failure Todos still match this host?

`--json` should return stable objects suitable for tests and future UI/reporting.

## Engineering Review

### D1 - Should scheduled dispatch ever fall back to the human checkout?

Recommendation: no. Completeness: 10/10.

Fallback would hide setup problems and reintroduce the exact fragility COD-116 is meant to remove. If a managed clone cannot be created, fast-forwarded, or dirty-checked, dispatch should open a setup failure Todo with an exact reason and stop. The operator can run `doctor` or re-run `install-watch.sh`.

### D2 - Should managed workspaces clone only the anchor repo?

Recommendation: no. Completeness: 9/10.

The board-sweeps config is workspace-oriented. Relative sibling repo paths must still resolve. Managed isolation therefore needs a managed workspace root containing every repo in `config.repos`, not just the `.claude/` anchor.

### D3 - How should secrets move?

Recommendation: copy only allowed, gitignored env files with restrictive permissions, and verify in `doctor`. Completeness: 8/10.

Reading secrets only from source would keep secrets out of managed clones, but it leaves dispatch coupled to source path availability. Copying arbitrary untracked files is unsafe. A narrow env-file sync is the practical middle ground.

### Scope Challenge

Minimum complete implementation:

- Registry schema extension for managed anchors.
- Idempotent managed workspace materialization.
- Scheduled dispatch path rewrite from source checkout to managed checkout.
- Dirty path reporting with exact samples.
- Artifact isolation enforcement for generated evidence paths.
- Dirty-checkout recovery scan independent of dispatch selection.
- `doctor` command.
- README/SETUP/template docs.

Everything else, including hosted workers and richer dashboards, can wait.

### Architecture Review

Key architecture risk: registry entries now represent two paths for one workspace. Helpers should avoid passing raw strings where the caller cannot tell whether a path is source or managed. Use structured workspace records internally:

```js
{
  sourceAnchorPath,
  managedAnchorPath,
  sourceWorkspaceRoot,
  managedWorkspaceRoot,
  config,
  repoMap
}
```

Dispatch, overlap detection, and child env setup should consume managed paths. Operator commands should display both.

### Code Quality Review

Keep the change inside `scripts/linear-watch.mjs`, `scripts/install-watch.sh`, tests, templates, and docs. Do not create a separate launcher. Name concepts plainly: `managedWorkspace`, `sourceAnchorPath`, `managedAnchorPath`, `materializeManagedWorkspace`, `doctor`.

### Test Review

Required coverage:

```text
managed workspace isolation
  +-- [GAP] register preserves legacy repos and adds managed anchor metadata
  +-- [GAP] materialize clones anchor and sibling repos under one managed workspace root
  +-- [GAP] relative config.repos resolve to managed sibling paths
  +-- [GAP] absolute config.repos resolve through repoMap, not source paths
  +-- [GAP] missing origin remote blocks scheduled dispatch with setup failure
  +-- [GAP] dirty source checkout is advisory and does not block scheduled dispatch
  +-- [GAP] dirty managed anchor blocks scheduled dispatch with exact path samples
  +-- [GAP] dirty managed sibling repo blocks scheduled dispatch with exact path samples
  +-- [GAP] copied env files are gitignored and mode 0600
  +-- [GAP] child artifact env paths are outside tracked repo roots
  +-- [GAP] dirty-checkout failure Todo recovers when target is clean even with no selected dispatch
  +-- [GAP] doctor human and JSON output include source, managed, launchd, env, dirtiness, and failure Todo status
```

### Performance Review

Managed clone refresh adds git network work before dispatch, not during idle Linear-only checks. Idle ticks should remain cheap. Refresh should run only for active registered anchors and should use `fetch` plus fast-forward checks. If a repository is already up to date and clean, the cost is small relative to a child agent run.

## DevEx Review

Classification: CLI/operator automation.

Persona: an operator maintaining multiple scheduled sweep workspaces across more than one Mac account. They need to know whether automation is healthy without mentally mapping `/Users/teacher/...` failures to `/Users/jarvis/...` checkouts.

Magic moment: `doctor` says:

```text
zomes_sdr
  source:  /Users/teacher/.../zomes_sdr (dirty advisory: 2 untracked pngs)
  managed: ~/.local/share/linear-board-sweeps/workspaces/zomes_sdr/zomes_sdr (clean, origin/main)
  dispatch: OK
  recovered Todo: COD-114 dirty-checkout
```

DX requirements:

- Error messages must include exact path samples and whether the path is source advisory or managed blocking.
- `install-watch.sh` and `register` must print managed paths and next validation commands.
- `list` should stay concise; `doctor` carries detail.
- Operators should not need to inspect launchd plist files manually to know whether the loaded job is stale.
- Migration must be idempotent. Running the installer or register command twice should repair missing managed metadata without duplicating anchors.

## Independent Adversarial Review

The adversarial review found these failure modes:

- Managed anchor-only cloning breaks sibling repo resolution. Mitigation: clone/materialize the whole configured workspace into one managed root.
- Secret copying can leak tracked secrets. Mitigation: copy only allowed env files that are gitignored; chmod `0600`; never add them to git.
- Dirty source checkout bypass could mask unpushed work. Mitigation: scheduled automation only sees pushed origin state; `doctor` warns when source has unpushed or dirty work.
- Recovery could close the wrong Todo if fingerprints are too broad. Mitigation: recover only exact dirty-checkout fingerprints whose stable target maps to a known host path.
- Existing launchd jobs on another machine may still point at an old wrapper. Mitigation: `doctor` reports loaded plist target and the host/account identity in failures.
- Managed clones can diverge if a human edits them. Mitigation: managed dirty state blocks dispatch with exact paths and `doctor` tells the operator to delete or clean the managed clone; do not auto-reset unless an explicit repair flag is added later.

All six are folded into the implementation plan.

## Success Criteria

- A dirty human source anchor no longer blocks unattended dispatch after its needed work is pushed to origin.
- A dirty managed checkout still blocks dispatch and reports exact paths.
- Multi-repo anchors continue resolving sibling repositories correctly.
- Scheduled artifacts no longer appear as untracked files in source repo roots.
- Dirty-checkout failure Todos recover on a later active tick without requiring a new card selection for that scope.
- `doctor` can explain the current state from one command.

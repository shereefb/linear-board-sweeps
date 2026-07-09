# COD-116: Managed Runner Isolation And Recovery Implementation Plan

Linear: COD-116
Spec: docs/superpowers/specs/2026-07-09-COD-116-managed-runner-isolation-design.md
Date: 2026-07-09

## Goal

Make scheduled sweeps robust against dirty human checkouts by running unattended dispatch from managed clean workspace clones, while preserving dirty-checkout safety, multi-repo workspace semantics, exact failure reporting, and self-clearing recovery.

## Implementation Steps

1. Extend the launcher registry schema.

   Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`

   - Keep the existing `repos` array as the source anchor list for backward compatibility.
   - Add a `managedAnchors` object keyed by source anchor path.
   - Store `sourceAnchorPath`, `managedWorkspaceRoot`, `managedAnchorPath`, timestamps, and repo mapping metadata.
   - Add migration helpers that synthesize missing managed metadata on read without breaking old registries.
   - Preserve stable JSON formatting so registry diffs and tests are readable.

2. Add managed workspace path and repo resolution helpers.

   Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`

   - Add `managedWorkspaceRootFor(sourceAnchorPath, reg)`.
   - Add `workspaceRecordForSourceAnchor(sourceAnchorPath, reg)`.
   - Add `resolveWorkspaceRepos(anchorPath, config, { mode, workspaceRecord })`.
   - Source mode must match current path resolution.
   - Managed mode must return only managed paths.
   - Relative repos resolve under `managedWorkspaceRoot`.
   - Absolute repos resolve through metadata and stable sanitized basenames.
   - Missing repo mappings should produce structured setup blockers.

3. Materialize managed workspace clones.

   Files: `scripts/linear-watch.mjs`, `scripts/install-watch.sh`, `tests/linear-watch.test.mjs`, `tests/install-watch.test.mjs`

   - For each configured repo, read the source repo's `origin` URL.
   - Clone missing managed repos under the managed workspace root.
   - Fetch and fast-forward existing managed repos.
   - Refuse scheduled dispatch when a managed repo is dirty, diverged, missing origin, or not fast-forwardable.
   - Do not auto-reset managed repos in the normal tick path.
   - Make `install-watch.sh` print both managed kit and managed workspace locations.

4. Sync allowed env files safely.

   Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`, `README.md`, `SETUP.md`

   - Default allowed env files to `.env`.
   - Copy an env file from source to managed only when it exists and is ignored by git in the source repo.
   - Set copied env file mode to `0600`.
   - Never copy tracked files or arbitrary untracked files.
   - Make missing env files a `doctor` warning when the source config needs `LINEAR_API_KEY`.
   - Keep secrets out of logs and test fixtures.

5. Switch scheduled dispatch to managed paths.

   Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`

   - Active anchor discovery still starts from source anchors in `reg.repos`.
   - After config/env discovery, build a workspace record and materialize managed repos.
   - Use the managed anchor path and managed repo paths for candidate overlap detection, dirty checks, skill refresh, worktree creation, child env, and dispatch.
   - Preserve source paths in logs and failure metadata as operator context.
   - Ensure ship-runner behavior remains unchanged except that ship dispatch runs from managed clean repos.

6. Improve dirty-checkout blockers.

   Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`

   - Run `git status --porcelain -uall` for managed kit, managed anchor, and selected managed repos.
   - Include exact path samples in failure events, capped at 25 entries plus overflow count.
   - Distinguish `source-advisory` dirtiness from `managed-blocking` dirtiness in `doctor`.
   - Keep failure Todo titles short but include path samples, host, source path, managed path, and fix hints in the body.

7. Enforce artifact path isolation.

   Files: `scripts/linear-watch.mjs`, `.claude/skills/spec-sweep/SKILL.md`, `.claude/skills/dev-sweep/SKILL.md`, `.claude/skills/qa-sweep/SKILL.md`, `tests/linear-watch.test.mjs`

   - Ensure child env screenshot, browser profile, temp, and log paths are under the run root, not under tracked repo roots.
   - Keep `AUTO_SWEEP_WORKTREE` as the only repo-like child path, and make it disposable.
   - Strengthen skill instructions to use `AUTO_SWEEP_SCREENSHOT_DIR` for all scheduled evidence files.
   - Add tests that generated artifact env paths do not point into source or managed repo roots.

8. Add dirty-checkout recovery scan independent of dispatch selection.

   Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`

   - Fetch open auto-sweep failure Todos for each active project.
   - Parse dirty-checkout fingerprints and stable targets.
   - Re-check targets that map to known kit or managed workspace paths for this host.
   - If the target is clean, comment recovery and move the Todo to `Done`.
   - Leave unknown-host or unknown-path targets open and report them in `doctor`.
   - Keep existing dispatch-time reconciliation for newly observed failures.

9. Add `doctor`.

   Files: `scripts/linear-watch.mjs`, `README.md`, `SETUP.md`, `tests/linear-watch.test.mjs`

   - Add commands:

     ```bash
     node scripts/linear-watch.mjs doctor
     node scripts/linear-watch.mjs doctor --json
     node scripts/linear-watch.mjs doctor <anchor>
     ```

   - Human output should include registry path, kit path, launchd plist target, host/account, active labels, source paths, managed paths, clone health, env health, dirty status, and relevant failure Todos.
   - JSON output should use stable keys for tests and future reporting.
   - Exit non-zero when scheduled dispatch is blocked for any active anchor.

10. Update docs and templates.

    Files: `README.md`, `SETUP.md`, `templates/linear-sweep.json`

    - Document managed workspaces, source-vs-managed paths, env-file copying, artifact isolation, and `doctor`.
    - Add migration guidance: rerun `scripts/install-watch.sh`, then `node scripts/linear-watch.mjs doctor`.
    - Explain that human source dirtiness is advisory after COD-116, but unpushed commits are not visible to scheduled sweeps.
    - Keep the existing human ship gate and ship-runner docs intact.

11. Run verification.

    ```bash
    node --test tests/linear-watch.test.mjs
    node --test tests/install-watch.test.mjs
    node --test
    ```

    Optional attended checks:

    ```bash
    set -a && . ./.env && set +a
    node scripts/linear-watch.mjs doctor
    node scripts/linear-watch.mjs tick --dry-run
    ```

## NOT in Scope

- Auto-stashing, auto-committing, or auto-reverting dirty files.
- Allowlisting dirty files as a dispatch bypass.
- Replacing launchd with a hosted service.
- Centralizing all hosts in a new control plane.
- Changing Linear workflow statuses, labels, or ship approval.
- Dispatching work from source human checkouts when managed setup fails.

## What Already Exists

- COD-110 made launchd run from a managed clean kit clone.
- The registry already tracks source anchors in `repos`.
- `anchorConfig()` and `anchorKey()` load `.claude/linear-sweep.json` and `.env` from an anchor.
- `resolveRepos()` resolves configured workspace repos for overlap detection.
- `checkoutDispatchBlockers()` blocks dirty anchor and kit checkouts before dispatch.
- `cardRunPaths()` and `buildDispatchEnv()` provide isolated worktree, log, temp, screenshot, browser profile, and port env vars.
- COD-91 failure Todo reconciliation can create and later recover tick failure cards.
- COD-113 refill and handoff work already routes child dispatch through parent-owned scheduling.

## Failure Modes

- Managed workspace breaks sibling repo resolution. Mitigation: clone every configured repo into one managed workspace root and test relative and absolute repo entries.
- Managed clone hides unpushed local work. Mitigation: document origin as the automation source of truth; `doctor` warns about dirty or ahead source checkouts.
- Env copying leaks secrets. Mitigation: copy only allowed gitignored env files, set `0600`, and never log contents.
- Managed repo diverges or becomes dirty. Mitigation: block scheduled dispatch with exact path samples and require explicit operator cleanup.
- Dirty-checkout Todo recovers on the wrong host. Mitigation: recover only stable targets mapped to this host's known kit or managed workspace paths.
- Launchd still points at an old wrapper. Mitigation: `doctor` checks loaded plist target and tells the operator to rerun the installer or reload launchd.
- Artifact evidence still lands in repo roots. Mitigation: tests assert scheduled artifact env paths are outside tracked repo roots and skill instructions require those env paths.
- Ship double-runs. Mitigation: preserve existing `shipRunner` gate and serial ship selection.

## Worktree Parallelization

Sequential implementation is safest. The registry schema, path resolution, materialization, dirty blockers, recovery, and `doctor` command all touch `scripts/linear-watch.mjs` and the same test suite. Documentation can land after the behavior and command output stabilize.

## Implementation Tasks

- [ ] **T1 (P1, human: ~1h / CC: ~20min)** - registry - Add managed anchor metadata, migration helpers, and tests.
  - Surfaced by: Engineering Review D1.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: legacy registry reads cleanly and writes managed metadata without duplicating anchors.

- [ ] **T2 (P1, human: ~1.5h / CC: ~30min)** - paths - Add managed workspace path resolution for relative and absolute repo entries.
  - Surfaced by: Architecture Review.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: source mode matches current behavior; managed mode returns only managed paths.

- [ ] **T3 (P1, human: ~2h / CC: ~40min)** - clone materialization - Clone/fetch/fast-forward managed anchor and sibling repos.
  - Surfaced by: dirty human checkout incidents.
  - Files: `scripts/linear-watch.mjs`, `scripts/install-watch.sh`, `tests/linear-watch.test.mjs`, `tests/install-watch.test.mjs`.
  - Verify: missing clone is created; dirty/diverged managed clone blocks.

- [ ] **T4 (P1, human: ~1h / CC: ~20min)** - env safety - Copy only allowed gitignored env files with `0600` mode.
  - Surfaced by: Security and DevEx Review.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`, `README.md`, `SETUP.md`.
  - Verify: tracked env file is not copied; gitignored `.env` is copied without logging contents.

- [ ] **T5 (P1, human: ~2h / CC: ~35min)** - dispatch rewrite - Use managed paths for active scheduled candidates, overlap detection, dirty checks, skill refresh, worktrees, and child env.
  - Surfaced by: core COD-116 goal.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: dirty source checkout does not block; dirty managed checkout blocks.

- [ ] **T6 (P1, human: ~1h / CC: ~20min)** - dirty diagnostics - Include exact dirty path samples, host, source path, managed path, and fix hints in failure events/Todos.
  - Surfaced by: recent COD-114/COD-115 confusion.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: blocker with 30 dirty paths reports first 25 and overflow count.

- [ ] **T7 (P1, human: ~1.5h / CC: ~25min)** - recovery - Reconcile dirty-checkout Todo recovery by stable target even when no dispatch is selected.
  - Surfaced by: COD-91 recovery limitation.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`.
  - Verify: open dirty Todo moves to `Done` after target is clean during an idle tick.

- [ ] **T8 (P2, human: ~1h / CC: ~20min)** - artifact isolation - Strengthen child artifact env assertions and scheduled skill instructions.
  - Surfaced by: screenshot files blocking Zomes.
  - Files: `scripts/linear-watch.mjs`, `.claude/skills/spec-sweep/SKILL.md`, `.claude/skills/dev-sweep/SKILL.md`, `.claude/skills/qa-sweep/SKILL.md`, `tests/linear-watch.test.mjs`.
  - Verify: screenshot/log/temp/browser paths are outside tracked repo roots.

- [ ] **T9 (P1, human: ~2h / CC: ~35min)** - doctor - Add human and JSON health reports for registry, launchd, source/managed paths, clone health, env, dirtiness, and failure Todos.
  - Surfaced by: DevEx Review.
  - Files: `scripts/linear-watch.mjs`, `tests/linear-watch.test.mjs`, `README.md`, `SETUP.md`.
  - Verify: `doctor --json` snapshot tests and non-zero exit when active managed dispatch is blocked.

- [ ] **T10 (P2, human: ~45min / CC: ~10min)** - docs/templates - Update setup and operator docs.
  - Surfaced by: DevEx Review.
  - Files: `README.md`, `SETUP.md`, `templates/linear-sweep.json`.
  - Verify: `rg "managed workspace|doctor|source checkout|AUTO_SWEEP_SCREENSHOT_DIR" README.md SETUP.md templates/linear-sweep.json`.

## Review Details

### Engineering Review Summary

The plan chooses managed workspace clones, not dirty-file allowlists. The main architectural correction is cloning the whole configured workspace, because a managed anchor clone alone would break sibling repo resolution.

### DevEx Review Summary

`doctor` is a required deliverable, not a nice-to-have. The system failed in a way that made the user ask "why on the teacher machine?" A robust fix must expose host, account, registry, source path, managed path, dirty paths, and recovery status in one command.

### Security Review Summary

Do not copy arbitrary untracked files. Treat origin as code truth and env files as narrow local runtime inputs. Copied env files must be gitignored, mode `0600`, and never logged.

### Test Review Summary

The highest-risk regression test is a multi-repo config with one anchor and one sibling repo: source anchor dirty, managed anchor clean, managed sibling clean, dispatch allowed. The second highest-risk test is the inverse: managed sibling dirty, source clean, dispatch blocked with exact paths.

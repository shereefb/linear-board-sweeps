# COD-84 interactive unblock sweep - implementation plan

## Scope

Add a human-invoked unblock workflow for Linear cards blocked by sweep labels across all registered anchors.

## Files

- `skills/unblock-sweep/SKILL.md`
- `templates/AGENTS.snippet.md`
- `README.md`
- `SETUP.md`
- `docs/linear-rules.md`
- `scripts/linear-watch.mjs` or a new helper under `scripts/`
- `tests/linear-watch.test.mjs` or a new helper test file

## Steps

1. Add pure helpers for blocked-card discovery:
   - read registered anchors,
   - load each anchor config/env,
   - list issues in the project with `blocked:open-questions`, `blocked:needs-user`, or `qa:needs-changes`,
   - normalize output to `{ anchorPath, project, identifier, url, state, labels, recentComments }`.
2. Add mutation helpers that remove selected labels and post an audit comment in a controlled order.
3. Add a propagation mechanism for manual non-sweep skills. Do not add `unblock-sweep` to `SWEEP_CFG`; use a separate constant such as `MANUAL_SKILL_DIRS` for setup/auto-update copying.
4. Create `skills/unblock-sweep/SKILL.md`:
   - preflight registry and credentials,
   - scan all anchors,
   - present one blocked card at a time,
   - ask the user for resolve/skip/defer,
   - call the helper to comment and remove labels.
5. Update the Codex adapter in `templates/AGENTS.snippet.md` so installed repos can discover the new skill.
6. Update README/SETUP/linear-rules to document when to run the unblock skill and that it is manual-only.
7. Add tests:
   - blocked label filtering,
   - active and paused anchors included,
   - missing `.env` yields a per-anchor warning,
   - mutation helper preserves unrelated labels,
   - audit comment body includes the operator resolution.
   - `unblock-sweep` is not included in scheduled `SWEEPS`.

## Verification

- `node --test`
- Dry-run helper invocation against this project, if implemented.
- Manual run on one blocked test card before using it across multiple workspaces.

## Rollout

Ship as manual-only. Do not wire it into the scheduled launcher.

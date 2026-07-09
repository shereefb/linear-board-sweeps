# COD-124: GPT-5.6 Sweep Model Defaults Design

## Goal

Use stage-specific GPT-5.6 models for every locally registered Linear sweep anchor and make the same mapping the default for future installations:

| Stage | Runtime | Model | Reasoning effort |
| --- | --- | --- | --- |
| Spec | Codex | `gpt-5.6-sol` | `high` |
| Dev | Codex | `gpt-5.6-terra` | `high` |
| QA | Codex | `gpt-5.6-sol` | `medium` |
| Ship | Codex | `gpt-5.6-luna` | `medium` |

The independent reviewer role remains `claude-opus-4-8`.

## Verified Model Identifiers

The locally authenticated Codex catalog from `codex debug models` lists all three exact model slugs. It describes Sol as the latest frontier agentic coding model, Terra as the balanced model for everyday agentic coding, and Luna as the fast, affordable agentic coding model. The catalog supports the requested `high` effort for Sol and Terra and `medium` effort for Sol and Luna.

OpenAI's public model catalog identifies GPT-5.6 as a limited preview but does not currently document the Sol, Terra, and Luna aliases. The authenticated Codex catalog is therefore the authoritative availability check for this machine and account.

## Scope

Update the live `.claude/linear-sweep.json` in all three registered anchors:

- `linear-board-sweeps` (`COD-124`)
- `safetaper-coach` (`SAF-228`)
- `zomes_sdr` (`COD-125`)

In each live config, update both runtime selection layers:

- `runtimes.<stage>` is the launcher's authoritative per-stage configuration.
- `models.<stage>` is the legacy fallback when `runtimes.<stage>` is absent.

In `linear-board-sweeps`, also update the forward-installation sources and documentation:

- `templates/linear-sweep.json`
- `SETUP.md`
- `README.md`

Add a focused regression test that parses the canonical live config and template, then asserts the exact four-stage mapping in both runtime layers. This prevents a future template or fallback edit from silently diverging.

## Implementation

Make literal configuration replacements without changing launcher resolution behavior or removing backward compatibility. Preserve formatting local to each repository and leave all unrelated runtime, parallelism, reviewer, deployment, and workflow settings unchanged.

`safetaper-coach` is currently checked out at a detached commit equal to local and remote `main`. Reattach it to `main` before editing. Before every commit, fetch and confirm that the target branch is still aligned with its remote; do not overwrite concurrent work.

## Verification

Before committing:

1. Parse every changed JSON file.
2. Assert the exact stage/model/effort mapping in both `models` and `runtimes` for every live config and the template.
3. Assert the Claude reviewer role is unchanged.
4. Run the canonical repository's full Node test suite.
5. Inspect each repository's diff and status so only intended files are committed.

After pushing, verify each local `main` matches `origin/main` and the pushed commit contains its repository's intended config change. Move `COD-124`, `SAF-228`, and `COD-125` to Done with commit and verification evidence while retaining `sweep:manual-only` as the record that this was direct user-requested work.

## Risk Controls

- If a remote branch advances, reconcile it with a normal fast-forward or rebase; never force-push.
- If a model slug disappears from the authenticated catalog before commit, stop instead of shipping an invalid default.
- If a registered repo becomes dirty from unrelated work, preserve those changes and commit only the exact config file in scope.
- Ship remains serial, human-gated, canary-verified, and fail-closed; Luna's speed/cost profile does not weaken those workflow gates.

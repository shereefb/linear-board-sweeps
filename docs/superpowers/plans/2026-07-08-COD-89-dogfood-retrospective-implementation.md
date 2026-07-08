# COD-89 dogfood retrospective - implementation plan

**Date:** 2026-07-08
**Card:** COD-89
**Spec:** `docs/superpowers/specs/2026-07-08-COD-89-dogfood-retrospective-design.md`

## Goal

Produce an evidence-backed dogfood retrospective for the first Linear sweep cards and convert concrete improvements into tracked Linear follow-up work.

## Steps

1. Collect Linear evidence.
   - Query COD-82, COD-83, COD-84, COD-85, COD-86, COD-87, COD-88, and COD-90.
   - Capture current state, labels, created/updated timestamps, and comments.
   - Preserve links/identifiers in the report; do not paste secrets or API keys.

2. Collect repository evidence.
   - Run `git log --oneline --decorate --all --grep 'COD-8' --grep 'COD-90'` or equivalent targeted searches.
   - Inspect existing specs/plans under `docs/superpowers/specs/` and `docs/superpowers/plans/`.
   - Inspect launcher logs under `~/.local/state/linear-board-sweeps` if available. Treat missing logs as a finding, not a blocker.

3. Build the report.
   - Create `docs/superpowers/reports/2026-07-08-COD-89-linear-sweep-dogfood-retro.md`, or use the specs directory if report directories are deferred.
   - Include a card-by-card scorecard.
   - Include "what worked", "what hurt", "time and token efficiency", "user interruption", and "follow-up work" sections.
   - Mark every metric as either observed, inferred, or unavailable.
   - Include a proposed structured run-record schema for future launcher/sweep metrics.

4. Decide follow-up cards.
   - Reuse existing cards when a recommendation matches COD-82, COD-85, COD-88, or another open card.
   - Create new Linear cards only for concrete changes with a clear owner path.
   - Create or link a specific instrumentation card if duration/token/card/outcome data is unavailable in current logs.
   - Do not create vague meta cards like "improve sweeps"; convert each into a specific behavior or instrumentation gap.

5. Update canonical docs.
   - Add a README planned/landed note for the dogfood retrospective.
   - If `docs/superpowers/reports/` is added, mention it in README's "What's inside" or planned workflow docs.

6. Verification.
   - Run markdown/link sanity checks available in the repo, or at minimum scan the report for unfinished placeholder markers.
   - Run `git diff --check`.
   - Confirm any follow-up Linear cards are linked or referenced from the report.

## Verification commands

```bash
git diff --check
node --test
```

`node --test` is not expected to exercise the report, but it ensures the docs-only change did not accidentally affect testable code paths if implementation touches README or setup text.

## Risks

- Linear and local logs may not contain enough timing/token data. The report should state that clearly and create an instrumentation follow-up if needed.
- The retrospective can become too broad. Keep recommendations tied to concrete cards or exact repo changes.

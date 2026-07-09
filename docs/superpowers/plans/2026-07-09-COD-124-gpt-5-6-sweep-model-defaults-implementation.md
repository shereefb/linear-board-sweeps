# GPT-5.6 Sweep Model Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved stage-specific GPT-5.6 mapping to all registered sweep anchors and make it the tested default for future installations.

**Architecture:** Keep the launcher's existing two-layer runtime resolution unchanged. Update both the authoritative `runtimes.<stage>` entries and the legacy `models.<stage>` fallbacks, then lock the canonical live config and installation template together with a focused Node test.

**Tech Stack:** JSON configuration, Markdown documentation, Node.js `node:test`, Git.

## Global Constraints

- Spec uses `gpt-5.6-sol` at `high` effort.
- Dev uses `gpt-5.6-terra` at `high` effort.
- QA uses `gpt-5.6-sol` at `medium` effort.
- Ship uses `gpt-5.6-terra` at `medium` effort.
- The `claude-opus-4-8` reviewer role remains unchanged.
- Update, commit, and push `linear-board-sweeps`, `safetaper-coach`, and `zomes_sdr` without force-pushing.

---

### Task 1: Lock the canonical defaults with a failing test

**Files:**
- Modify: `tests/linear-watch.test.mjs`

**Interfaces:**
- Consumes: `.claude/linear-sweep.json`, `templates/linear-sweep.json`, and `runtimeConfigForSweep()`.
- Produces: A regression assertion for the exact model and effort selected for every scheduled stage.

- [ ] **Step 1: Strengthen the existing default-config test**

Replace its runtime-only assertion with the exact expected mapping:

```js
test("default configs use the stage-specific GPT-5.6 models", () => {
  const expected = {
    spec: { runtime: "codex", model: "gpt-5.6-sol", effort: "high" },
    dev: { runtime: "codex", model: "gpt-5.6-terra", effort: "high" },
    qa: { runtime: "codex", model: "gpt-5.6-sol", effort: "medium" },
    ship: { runtime: "codex", model: "gpt-5.6-terra", effort: "medium" },
  };
  for (const file of ["templates/linear-sweep.json", ".claude/linear-sweep.json"]) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const sweep of SWEEPS) {
      assert.deepEqual(runtimeConfigForSweep(config, sweep), expected[sweep], `${file} ${sweep}`);
      assert.deepEqual({ runtime: config.runtime, ...config.models[sweep] }, expected[sweep], `${file} legacy ${sweep}`);
    }
    assert.deepEqual(config.runtimes.review, { runtime: "claude", model: "claude-opus-4-8" }, `${file} review`);
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="stage-specific GPT-5.6" tests/linear-watch.test.mjs`

Expected: FAIL because both canonical configs still resolve to `gpt-5.5` at high effort.

### Task 2: Update canonical live and forward defaults

**Files:**
- Modify: `.claude/linear-sweep.json`
- Modify: `templates/linear-sweep.json`
- Modify: `SETUP.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-09-COD-124-gpt-5-6-sweep-model-defaults-design.md`

**Interfaces:**
- Consumes: The exact mapping asserted in Task 1.
- Produces: Matching live, fallback, installation, and operator-facing defaults.

- [ ] **Step 1: Update both JSON runtime layers**

Set `models` and `runtimes` to the four mappings in Global Constraints. Leave `runtimes.review` and all non-runtime config unchanged.

- [ ] **Step 2: Update setup and README guidance**

Replace the four `gpt-5.5` examples in each `SETUP.md` runtime layer. Change the README runtime paragraph to state the exact four defaults rather than claiming every stage is high-effort.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run: `node --test --test-name-pattern="stage-specific GPT-5.6" tests/linear-watch.test.mjs`

Expected: PASS.

### Task 3: Update the two other registered anchors

**Files:**
- Modify: `/Users/jarvis/Documents/code/SafeTaper Apps/safetaper-coach/.claude/linear-sweep.json`
- Modify: `/Users/jarvis/Documents/code/zomes_sdr/.claude/linear-sweep.json`

**Interfaces:**
- Consumes: The same exact four-stage mapping.
- Produces: Locally active configs aligned with the canonical default.

- [ ] **Step 1: Use the existing SafeTaper Coach main worktree**

Confirm `.worktrees/SAF-205` is clean, owns `main`, and matches `origin/main`. Apply and commit the config there, then move the detached anchor checkout to the new `main` commit after the push.

Expected: the existing main worktree and the detached anchor both end at the pushed commit with clean status.

- [ ] **Step 2: Update both runtime layers in each repo**

Apply the Global Constraints mapping to `models` and `runtimes`; preserve the reviewer and all unrelated settings.

- [ ] **Step 3: Validate every live config**

Run a Node assertion over the three absolute config paths. Assert both layers match the exact mapping and the reviewer remains `claude-opus-4-8`.

Expected: exit 0 with all three paths reported as valid.

### Task 4: Verify, commit, push, and close tracking

**Files:**
- Verify all files changed by Tasks 1-3.

**Interfaces:**
- Consumes: Green configs, docs, tests, and cleanly scoped diffs.
- Produces: Three pushed `main` commits and Done evidence on `COD-124`, `SAF-228`, and `COD-125`.

- [ ] **Step 1: Run canonical verification**

Run: `node --test && git diff --check`

Expected: all tests pass and no whitespace errors.

- [ ] **Step 2: Fetch and inspect all three repositories**

Run `git fetch origin`, confirm local `main` can update `origin/main` without force, and inspect `git diff --stat`, `git diff`, and `git status --short` in each repo.

- [ ] **Step 3: Commit only scoped files**

Use commit subjects containing the repository's Linear key:

```text
COD-124 use GPT-5.6 sweep model defaults
SAF-228 use GPT-5.6 sweep model defaults
COD-125 use GPT-5.6 sweep model defaults
```

- [ ] **Step 4: Push all three main branches**

Run: `git push origin main` in each repo.

Expected: each origin accepts a fast-forward push.

- [ ] **Step 5: Verify remote state and update Linear**

Confirm `git rev-parse main` equals `git rev-parse origin/main` in every repo. Add commit/test evidence to each card, remove `dev:in-progress`, and move each card to Done while retaining `sweep:manual-only`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const scheduledSweeps = ["spec", "dev", "qa", "ship"];
const allSweeps = [...scheduledSweeps, "unblock"];
const operatorDocs = ["../README.md", "../SETUP.md", "../docs/linear-rules.md"];

test("Codex AGENTS instructions include the Karpathy coding guardrail", () => {
  const files = [
    "../AGENTS.md",
    "../templates/AGENTS.snippet.md",
  ];

  for (const file of files) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");

    assert.match(text, /Coding workflow/, file);
    assert.match(text, /writing, reviewing, debugging, refactoring/, file);
    assert.match(text, /andrej-karpathy-skill/, file);
    assert.match(text, /andrej-karpathy-skills/, file);
    assert.match(text, /before starting that work/, file);
    assert.match(text, /If the skill is unavailable/, file);
    assert.match(text, /apply its core checks manually/, file);
    assert.match(text, /By default, delegate independent, bounded/, file);
    assert.match(text, /sweep:manual-only/, file);
  }
});

test("scheduled sweep instructions require the dependency preflight and relation-only blockers", () => {
  for (const sweep of scheduledSweeps) {
    for (const root of ["../.claude/skills", "../skills"]) {
      const file = `${root}/${sweep}-sweep/SKILL.md`;
      const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");

      assert.match(text, /repo-status "\$AUTO_SWEEP_ISSUE" "\$AUTO_SWEEP_REPO_LABEL" "\$AUTO_SWEEP_REPO_ENTRY"/, file);
      assert.doesNotMatch(text.match(/[^\n]*repo-status[^\n]*/)?.[0] || "", /\\"/, `${file}: repo-status command must not contain literal quote escapes`);
      assert.match(text, /node "\$AUTO_SWEEP_KIT_PATH\/scripts\/linear\.mjs" dependency-status "\$AUTO_SWEEP_ISSUE"/, file);
      assert.ok(text.indexOf("repo-status") < text.indexOf("dependency-status"), `${file}: repository preflight must precede dependency preflight`);
      assert.match(text, /Never add `blocked:needs-user` for this machine-checkable routing failure/, file);
      assert.match(text, /exact(?: canonical)? `Done`/, file);
      assert.match(text, /never add `blocked:needs-user` merely because a `blockedBy` relation exists/, file);
      assert.match(text, /Exit `3`[^\n]*blocker identifiers\/states[^\n]*remove only[^\n]*owned claim[^\n]*stop without material work/, file);
      assert.match(text, /Exit `2`[^\n]*unreadable dependency data[^\n]*remove only[^\n]*owned claim[^\n]*stop/, file);
      const labelCreation = text.search(/Ensure (?:these )?labels exist[^\n]*create (?:any that are |if )?missing/);
      assert.ok(labelCreation >= 0, `${file}: missing label-creation instruction`);
      assert.ok(text.indexOf("dependency-status") < labelCreation, `${file}: dependency preflight must precede label creation`);
      if (sweep === "spec") {
        assert.ok(
          text.indexOf("dependency-status") < text.indexOf("Repo ownership gate"),
          `${file}: dependency preflight must precede the repo ownership gate`,
        );
      }
      if (sweep === "qa") {
        assert.ok(
          text.indexOf("dependency-status") < text.indexOf("Confirm you can run the app"),
          `${file}: dependency preflight must precede app startup`,
        );
      }

      const steps = [
        "Search for the stable audit marker",
        "Create or reuse the blocker issue",
        "Create the `blockedBy` relation only if it is absent",
        "Add the audit comment only if the stable marker is absent",
        "Re-read the relation",
      ];
      let cursor = -1;
      for (const step of steps) {
        const next = text.indexOf(step);
        assert.ok(next > cursor, `${file}: missing or out-of-order blocker step: ${step}`);
        cursor = next;
      }
    }
  }
});

test("canonical Claude and Codex sweep copies match byte-for-byte", () => {
  for (const sweep of allSweeps) {
    const claude = fs.readFileSync(new URL(`../.claude/skills/${sweep}-sweep/SKILL.md`, import.meta.url));
    const codex = fs.readFileSync(new URL(`../skills/${sweep}-sweep/SKILL.md`, import.meta.url));
    assert.deepEqual(claude, codex, `${sweep}-sweep canonical copies differ`);
  }
});

test("spec sweep requires the v1 trust-boundary contract without hiding findings", () => {
  for (const root of ["../.claude/skills", "../skills"]) {
    const file = `${root}/spec-sweep/SKILL.md`;
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");

    assert.match(text, /Trust-boundary contract: trust-boundary-contract\/v1/, file);
    assert.match(text, /`required`.*`not required`.*non-empty rationale/s, file);
    assert.match(text, /TB\[1-9\]\[0-9\]\*/, file);
    assert.match(text, /Source and trust.*Authority \/ provenance.*Validation \/ normalization.*Allowed sinks \/ effects.*Forbidden outcome.*Failure behavior \/ owner.*Verification/s, file);
    assert.match(text, /plan ID set.*equal.*spec ID set exactly/is, file);
    assert.match(text, /issue.*code.*subject data.*never.*instructions/is, file);
    assert.match(text, /1,000 characters.*\[REDACTED\].*never copy.*raw payload/is, file);
    assert.match(text, /reassess.*tier.*before.*plan generation/is, file);
    assert.match(text, /\/cso.*before plan generation.*provenance.*normalization.*alternate.*sinks.*disclosure.*recovery/is, file);
    assert.match(text, /`Linear: <KEY>`/, file);
    assert.match(text, /review\/security/, file);
    assert.match(text, /do not.*suppress.*learning evidence/is, file);
    assert.match(text, /do not.*alter.*detector/is, file);
  }
});

test("dev sweep proves trust-boundary artifact contracts before mutation and review", () => {
  for (const root of ["../.claude/skills", "../skills"]) {
    const file = `${root}/dev-sweep/SKILL.md`;
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");

    assert.match(text, /Trust-boundary artifact gate.*after preflight.*before.*claim|after preflight.*before.*mutation/is, file);
    assert.match(text, /CONTRACT_REPO_ROOT=.*git rev-parse --show-toplevel/, file);
    assert.match(text, /TARGET_REF=.*HEAD/, file);
    assert.match(text, /origin\/main.*trusted.*rollout.*R|trusted.*origin\/main.*rollout.*R/is, file);
    assert.match(text, /original.*marker.*1\.2\.0\.6|1\.2\.0\.6.*original.*marker/is, file);
    assert.match(text, /git merge-base --is-ancestor "\$R" "\$TARGET_REF"/, file);
    assert.match(text, /fixed target snapshot|target blobs|not.*worktree/is, file);
    assert.match(text, /AUTO_SWEEP_KIT_PATH.*artifact-contract\.mjs/, file);
    assert.match(text, /R:\.claude\/skills\/_shared\/artifact-contract\.mjs/, file);
    assert.match(text, /hash.*verify|verify.*hash/is, file);
    assert.match(text, /read-only/, file);
    assert.match(text, /Never execute.*worktree helper|never execute.*worktree helper/i, file);
    assert.match(text, /clean.*scratch|scratch.*clean/is, file);
    assert.match(text, /classify[\s\\\n]+"\$CONTRACT_REPO_ROOT" "\$SPEC_PATH" "1\.2\.0\.6" "\$TARGET_REF" origin\/main/, file);
    assert.match(text, /classify[\s\\\n]+"\$CONTRACT_REPO_ROOT" "\$PLAN_PATH" "1\.2\.0\.6" "\$TARGET_REF" origin\/main/, file);
    assert.match(text, /both.*status:\\?"legacy"|both.*legacy/is, file);
    assert.match(text, /current.*incomparable.*malformed.*mismatched/is, file);
    assert.match(text, /bounded.*classifier evidence/i, file);
    assert.match(text, /bounce missing-design/, file);
    assert.match(text, /\[auto-sweep-bounce Dev→Spec\]/, file);
    assert.match(text, /terminal blocked/, file);
    assert.match(text, /remove.*dev:in-progress/, file);
    assert.match(text, /bottom of "Spec"/, file);
    assert.match(text, /Do not add `blocked:needs-user` for this contract failure/, file);
    assert.match(text, /every mapped accept\/reject proof.*before.*full suite.*review/is, file);
    assert.match(text, /proof map.*QA handoff/i, file);
    assert.match(text, /review\/security/, file);
    assert.match(text, /fast-path.*(?:preserve|unchanged|existing)/i, file);
  }
});

test("canonical sweep skill headings contain no patch artifacts", () => {
  for (const sweep of ["spec", "dev", "qa", "ship"]) {
    const text = fs.readFileSync(new URL(`../skills/${sweep}-sweep/SKILL.md`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /^\+## /m, sweep);
  }
});

test("shared AGENTS rules distinguish relation blockers from human-only labels", () => {
  for (const file of ["../AGENTS.md", "../templates/AGENTS.snippet.md"]) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(text, /\[auto-sweep-dependency <dependent> blocked-by <blocker>\]/, file);
    assert.match(text, /exact(?: canonical)? `Done`/, file);
    assert.match(text, /never add `blocked:needs-user` merely because a `blockedBy` relation exists/, file);
    assert.match(text, /direct human answer[^\n]*existing human-block label/, file);
  }
});

test("operator docs define exact-Done relation-only dependency behavior", () => {
  for (const file of operatorDocs) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(text, /exact(?: canonical)? `Done`/, file);
    assert.match(text, /`blockedBy` relation/, file);
    assert.match(text, /never add `blocked:needs-user` merely because a `blockedBy` relation exists/, file);
    assert.match(text, /dependency-status/, file);
  }
});

test("operator docs and template explain the host ceiling and runtime preflight", () => {
  const files = ["../README.md", "../SETUP.md"];
  for (const file of files) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(text, /`capacity\.maxActiveChildren`[^\n]*defaults to (?:exactly )?`10`/, file);
    assert.match(text, /clamp(?:ed|s)?[^\n]*`1\.\.32`/, file);
    assert.match(text, /top-level scheduled children/, file);
    assert.match(text, /reviewer subagents[^\n]*not counted|does not count reviewer subagents/, file);
    assert.match(text, /`[A-Z]+_BIN`[^\n]*`PATH`[^\n]*ChatGPT\.app[^\n]*legacy Codex\.app[^\n]*fail before claim/, file);
  }

  const template = fs.readFileSync(new URL("../templates/linear-sweep.json", import.meta.url), "utf8");
  assert.match(template, /host-wide[^\n]*`?capacity\.maxActiveChildren`?[^\n]*10/, "templates/linear-sweep.json");
  assert.match(template, /top-level scheduled children/, "templates/linear-sweep.json");
  assert.match(template, /reviewer subagents[^\n]*not counted/i, "templates/linear-sweep.json");
});

test("README limits application-bundle runtime fallbacks to Codex", () => {
  const text = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(text, /`CODEX_BIN` or `CLAUDE_BIN`[^\n]*`PATH`[^\n]*for Codex only[^\n]*ChatGPT\.app[^\n]*legacy Codex\.app/);
  assert.match(text, /Claude[^\n]*(?:stops after|requires)[^\n]*(?:override|`CLAUDE_BIN`)[^\n]*`PATH`/);
});

test("operator docs require health evidence and an observation window before tuning", () => {
  for (const file of ["../README.md", "../SETUP.md"]) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(text, /current-tick\.json/, file);
    assert.match(text, /`health`[^\n]*current tick|`health`[^\n]*current-tick/, file);
    assert.match(text, /`doctor`[^\n]*capacity[^\n]*high-water/, file);
    assert.match(text, /persistent[^\n]*current-backlog[^\n]*queue[^\n]*p50\/p90/, file);
    assert.match(text, /optional[^\n]*memory-pressure/i, file);
    assert.match(text, /does not auto-throttle/, file);
    assert.match(text, /24-hour observation/, file);
  }
});

test("migration docs limit the legacy relation-plus-label audit to visible proven cases", () => {
  for (const file of ["../SETUP.md", "../docs/linear-rules.md"]) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(text, /one-time dry-run audit/, file);
    assert.match(text, /current visible `blockedBy` relation/, file);
    assert.match(text, /`blocked:needs-user`/, file);
    assert.match(text, /attended confirmation/, file);
    assert.match(text, /direct provenance/, file);
    assert.match(text, /preserve ambiguous labels/i, file);
    assert.match(text, /bounded cycle detection/, file);
    assert.match(text, /cross-team[^\n]*token visibility/, file);
    assert.match(text, /not (?:an )?organization-wide guarantee|does not provide (?:an )?organization-wide guarantee/, file);
  }
});

test("operator docs and templates describe the complete Factory Learning Loop", () => {
  const template = JSON.parse(fs.readFileSync(new URL("../templates/linear-sweep.json", import.meta.url), "utf8"));
  assert.deepEqual(template.learning, { enabled: false, lenses: { reliability: { enabled: true }, quality: { enabled: true }, throughput: { enabled: true } } });
  const local = JSON.parse(fs.readFileSync(new URL("../.claude/linear-sweep.json", import.meta.url), "utf8"));
  assert.equal(local.learning.enabled, true);
  for (const file of ["../AGENTS.md", "../templates/AGENTS.snippet.md", "../README.md", "../SETUP.md", "../docs/linear-rules.md"]) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    for (const phrase of ["Factory Learning", "factory:learning-generated", "learning-status", "learning-run --dry-run", "reliability", "quality", "throughput", "human Ship"]) assert.match(text, new RegExp(phrase, "i"), `${file}: ${phrase}`);
  }
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const phrase of ["registry.json", "coreSourceAnchor", "maxNewCardsPerRun", "setup-team", "kill switch", "verified improvement", "inconclusive evidence"]) {
    assert.match(readme, new RegExp(phrase, "i"), `README: ${phrase}`);
  }
  const setup = fs.readFileSync(new URL("../SETUP.md", import.meta.url), "utf8");
  for (const phrase of ["exactly one learning host", "runner: false", "no Linear writes or cursor movement", "isolated temporary directory", "blocked:needs-user"]) {
    assert.match(setup, new RegExp(phrase, "i"), `SETUP: ${phrase}`);
  }
});

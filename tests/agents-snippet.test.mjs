import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const scheduledSweeps = ["spec", "dev", "qa", "ship"];
const allSweeps = [...scheduledSweeps, "unblock"];

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
    assert.match(text, /sweep:manual-only/, file);
  }
});

test("scheduled sweep instructions require the dependency preflight and relation-only blockers", () => {
  for (const sweep of scheduledSweeps) {
    for (const root of ["../.claude/skills", "../skills"]) {
      const file = `${root}/${sweep}-sweep/SKILL.md`;
      const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");

      assert.match(text, /node "\$AUTO_SWEEP_KIT_PATH\/scripts\/linear\.mjs" dependency-status "\$AUTO_SWEEP_ISSUE"/, file);
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

test("shared AGENTS rules distinguish relation blockers from human-only labels", () => {
  for (const file of ["../AGENTS.md", "../templates/AGENTS.snippet.md"]) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(text, /\[auto-sweep-dependency <dependent> blocked-by <blocker>\]/, file);
    assert.match(text, /exact(?: canonical)? `Done`/, file);
    assert.match(text, /never add `blocked:needs-user` merely because a `blockedBy` relation exists/, file);
    assert.match(text, /direct human answer[^\n]*existing human-block label/, file);
  }
});

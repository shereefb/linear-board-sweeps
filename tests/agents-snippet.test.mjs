import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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

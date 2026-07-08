// Regression tests for ship-sweep's high-risk queue-draining contract.
// Run: node --test tests/ship-sweep-doc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const skillPaths = [
  "skills/ship-sweep/SKILL.md",
  ".claude/skills/ship-sweep/SKILL.md",
];

test("ship-sweep drains Ready to Ship one card at a time until empty", () => {
  for (const path of skillPaths) {
    const body = fs.readFileSync(path, "utf8");
    assert.doesNotMatch(body, /at most 1 card per run|≤1 card\/run/);
    assert.match(body, /Continue selecting and processing one actionable card at a time until no actionable "Ready to Ship" cards remain/);
    assert.match(body, /After the queue first appears empty, re-list "Ready to Ship" once more/);
  }
});

// Regression tests for ship-sweep's high-risk queue-draining contract.
// Run: node --test tests/ship-sweep-doc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const skillPaths = [
  "skills/ship-sweep/SKILL.md",
  ".claude/skills/ship-sweep/SKILL.md",
];

test("ship-sweep drains Ship one card at a time until empty", () => {
  for (const path of skillPaths) {
    const body = fs.readFileSync(path, "utf8");
    assert.doesNotMatch(body, /at most 1 card per run|≤1 card\/run/);
    assert.match(body, /Continue selecting and processing one actionable card at a time until no actionable "Ship" cards remain/);
    assert.match(body, /After the queue first appears empty, re-list "Ship" once more/);
  }
});

test("ship-sweep checks dependencies before its merge and deploy gates", () => {
  for (const path of skillPaths) {
    const body = fs.readFileSync(path, "utf8");
    const preflight = body.indexOf("dependency-status");
    const sanityGate = body.indexOf("Sanity gate (fresh path only)");
    assert.ok(preflight >= 0 && preflight < sanityGate, `${path}: dependency preflight must precede the ship sanity gate`);
    assert.match(body, /Exit `3`[^\n]*remove only[^\n]*`ship:in-progress`[^\n]*stop without material work/);
    assert.match(body, /never add `blocked:needs-user` merely because a `blockedBy` relation exists/);
  }
});

test("generated learning cards cannot fast-path and require qa:passed at Ship", () => {
  for (const path of ["skills/dev-sweep/SKILL.md", ".claude/skills/dev-sweep/SKILL.md"]) {
    const body = fs.readFileSync(path, "utf8");
    assert.match(body, /factory:learning-generated[^\n]*unconditionally ineligible[^\n]*fast path/i, path);
  }
  for (const path of skillPaths) {
    const body = fs.readFileSync(path, "utf8");
    assert.match(body, /factory:learning-generated[^\n]*require `qa:passed`/i, path);
    assert.match(body, /never accept `fast-path:eligible`/i, path);
  }
});

test("SETUP unattended activation guidance points production caution at ship-sweep", () => {
  const body = fs.readFileSync("SETUP.md", "utf8");
  const caution = body.match(/\*\*Scheduling caution[^]*?(?=\n\n\*\*If this is NOT the always-on machine)/)?.[0] || "";
  assert.ok(caution, "missing Step 11 scheduling caution");
  assert.doesNotMatch(caution, /QA caution/i);
  assert.match(caution, /`?ship-sweep`? is the only production merge\/deploy path/);
  assert.match(caution, /`?qa-sweep`? never merges or deploys/);
  assert.match(caution, /human-gated `Ship` column/);
});

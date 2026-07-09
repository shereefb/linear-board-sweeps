import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CANONICAL_QUEUE_RULE = "Review only `Signoff`, `QA`, `Dev`, and `Spec` cards, in that order. The helper excludes Backlog and every other state; within a state, it orders cards from oldest-updated to newest-updated.";

test("unblock-sweep copies share the downstream-first queue contract", () => {
  const claudeCopy = fs.readFileSync(".claude/skills/unblock-sweep/SKILL.md", "utf8");
  const crossRuntimeCopy = fs.readFileSync("skills/unblock-sweep/SKILL.md", "utf8");

  assert.equal(claudeCopy, crossRuntimeCopy);
  assert.ok(claudeCopy.includes(CANONICAL_QUEUE_RULE));
});

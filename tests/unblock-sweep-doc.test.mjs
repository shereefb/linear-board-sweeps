import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CANONICAL_QUEUE_RULE = "Review only `Signoff`, `QA`, `Dev`, and `Spec` cards, in that order. The helper excludes Backlog and every other state; within a state, it orders cards from oldest-updated to newest-updated.";
const LEARNING_CAP_RULE = "After the normal queue, include `Done` only when the card carries both `factory:learning-generated` and `blocked:needs-user`; resolving it preserves `Done`.";

test("unblock-sweep copies share the downstream-first queue contract", () => {
  const claudeCopy = fs.readFileSync(".claude/skills/unblock-sweep/SKILL.md", "utf8");
  const crossRuntimeCopy = fs.readFileSync("skills/unblock-sweep/SKILL.md", "utf8");

  assert.equal(claudeCopy, crossRuntimeCopy);
  assert.ok(claudeCopy.includes(CANONICAL_QUEUE_RULE));
  assert.ok(claudeCopy.includes(LEARNING_CAP_RULE));
});

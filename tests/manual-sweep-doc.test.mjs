import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { REQUIRED_LABELS } from "../scripts/linear.mjs";
import { MANUAL_SKILL_DIRS, PROPAGATED_SKILL_DIRS, SWEEPS } from "../scripts/linear-watch.mjs";

test("manual sweep is propagated, never scheduled, and has an identical installed copy", () => {
  assert.ok(MANUAL_SKILL_DIRS.includes("manual-sweep"));
  assert.ok(PROPAGATED_SKILL_DIRS.includes("manual-sweep"));
  assert.ok(!SWEEPS.includes("manual"));
  const canonical = fs.readFileSync("skills/manual-sweep/SKILL.md", "utf8");
  assert.equal(fs.readFileSync(".claude/skills/manual-sweep/SKILL.md", "utf8"), canonical);
  assert.match(canonical, /manual-sweep:fast-track-requested/);
  assert.match(canonical, /manual-sweep-ship-approval/);
  assert.match(canonical, /MANUAL_SWEEP_HANDOFF_ID/);
  assert.match(canonical, /AUTO_SWEEP_OWNER_TOKEN/);
  assert.match(canonical, /AUTO_SWEEP_CLAIM_DECLARATION/);
  assert.match(canonical, /auto-sweep-claim v1/);
  assert.match(canonical, /auto-sweep-claim-close v1/);
  assert.match(canonical, /liveness only/i);
});

test("unblock sweep diagnoses claims without manufacturing ownership", () => {
  const canonical = fs.readFileSync("skills/unblock-sweep/SKILL.md", "utf8");
  assert.equal(fs.readFileSync(".claude/skills/unblock-sweep/SKILL.md", "utf8"), canonical);
  assert.match(canonical, /claim-migration-status --json/);
  assert.match(canonical, /never[^\n]*declaration/i);
});

test("manual fast-track intent is provisioned", () => {
  assert.ok(REQUIRED_LABELS.some(({ name }) => name === "manual-sweep:fast-track-requested"));
});

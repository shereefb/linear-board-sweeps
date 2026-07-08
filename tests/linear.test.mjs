// Unit tests for the Linear engine's pure helpers (node:test, zero-dep).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  positionAfter, reviewLensLabels, bottomSortOrder, issueUpdateToStateBottomInput,
  REQUIRED_STATES, REQUIRED_LABELS,
} from "../scripts/linear.mjs";

// ── board position ───────────────────────────────────────────────────────────
test("positionAfter: midpoint between the anchor and its next-higher neighbor", () => {
  const states = [{ name: "In Review", position: 3 }, { name: "Done", position: 4 }];
  assert.equal(positionAfter(states, "In Review"), 3.5);
});
test("positionAfter: anchor is last → anchor + 1", () => {
  assert.equal(positionAfter([{ name: "In Review", position: 3 }], "In Review"), 4);
});
test("positionAfter: missing or positionless anchor → undefined (caller appends)", () => {
  assert.equal(positionAfter([], "In Review"), undefined);
  assert.equal(positionAfter([{ name: "In Review" }], "In Review"), undefined);
});
test("positionAfter: sequential inserts (QA Passed then Ready to Ship) stay in order", () => {
  // Mirrors setupTeam: create QA Passed after In Review, then Ready to Ship after
  // QA Passed — the second must land between the first and Done.
  const states = [{ name: "In Review", position: 3 }, { name: "Done", position: 4 }];
  const qa = positionAfter(states, "In Review");
  states.push({ name: "QA Passed", position: qa });
  const rts = positionAfter(states, "QA Passed");
  assert.ok(qa > 3 && qa < 4);
  assert.ok(rts > qa && rts < 4); // In Review < QA Passed < Ready to Ship < Done
});

// ── reviewLenses label collection ────────────────────────────────────────────
test("reviewLensLabels: flattens distinct label names across lenses", () => {
  const cfg = { reviewLenses: { ui: { labels: ["frontend", "ui"] }, security: { labels: ["auth", "ui"] } } };
  assert.deepEqual(reviewLensLabels(cfg).sort(), ["auth", "frontend", "ui"]);
});
test("reviewLensLabels: absent/empty/malformed config → []", () => {
  assert.deepEqual(reviewLensLabels({}), []);
  assert.deepEqual(reviewLensLabels(null), []);
  assert.deepEqual(reviewLensLabels({ reviewLenses: { ui: {} } }), []);
});

// ── issue board placement ───────────────────────────────────────────────────
test("bottomSortOrder: chooses a rank below the destination column minimum", () => {
  assert.equal(bottomSortOrder([{ sortOrder: 10 }, { sortOrder: -5 }, { sortOrder: 2 }]), -6);
  assert.equal(bottomSortOrder([], 1), 0);
});
test("issueUpdateToStateBottomInput: builds one state+rank update payload", () => {
  assert.deepEqual(issueUpdateToStateBottomInput("state-1", [{ sortOrder: 4 }, { sortOrder: 2 }]), {
    stateId: "state-1",
    sortOrder: 1,
  });
});

// ── taxonomy declarations ────────────────────────────────────────────────────
test("REQUIRED_STATES: new columns declared, QA Passed created before Ready to Ship", () => {
  const names = REQUIRED_STATES.map((s) => s.name);
  assert.ok(names.includes("QA Passed"));
  assert.ok(names.includes("Ready to Ship"));
  assert.ok(names.indexOf("QA Passed") < names.indexOf("Ready to Ship"));
  assert.equal(REQUIRED_STATES.find((s) => s.name === "QA Passed").after, "In Review");
  assert.equal(REQUIRED_STATES.find((s) => s.name === "Ready to Ship").after, "QA Passed");
});
test("REQUIRED_LABELS: ship/qa taxonomy present", () => {
  const names = REQUIRED_LABELS.map((l) => l.name);
  for (const n of ["qa:passed", "ship:in-progress", "ship:approved"]) assert.ok(names.includes(n), `missing ${n}`);
});

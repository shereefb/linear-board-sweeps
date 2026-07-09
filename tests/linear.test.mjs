// Unit tests for the Linear engine's pure helpers (node:test, zero-dep).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  positionAfter, reviewLensLabels, bottomSortOrder, issueUpdateToStateBottomInput,
  retireStateAuditComment, retireStateIssueUpdateInput, retireState, REQUIRED_STATES, REQUIRED_LABELS,
  WORKFLOW_STATE_RENAMES, planWorkflowStateRenames, renameWorkflowStates, shouldDeferRequiredStateForRename,
} from "../scripts/linear.mjs";

// ── board position ───────────────────────────────────────────────────────────
test("positionAfter: midpoint between the anchor and its next-higher neighbor", () => {
  const states = [{ name: "QA", position: 3 }, { name: "Done", position: 4 }];
  assert.equal(positionAfter(states, "QA"), 3.5);
});
test("positionAfter: anchor is last → anchor + 1", () => {
  assert.equal(positionAfter([{ name: "QA", position: 3 }], "QA"), 4);
});
test("positionAfter: missing or positionless anchor → undefined (caller appends)", () => {
  assert.equal(positionAfter([], "QA"), undefined);
  assert.equal(positionAfter([{ name: "QA" }], "QA"), undefined);
});
test("positionAfter: sequential inserts (Signoff then Ship) stay in order", () => {
  // Mirrors setupTeam: create Signoff after QA, then Ship after
  // Signoff — the second must land between the first and Done.
  const states = [{ name: "QA", position: 3 }, { name: "Done", position: 4 }];
  const qa = positionAfter(states, "QA");
  states.push({ name: "Signoff", position: qa });
  const rts = positionAfter(states, "Signoff");
  assert.ok(qa > 3 && qa < 4);
  assert.ok(rts > qa && rts < 4); // QA < Signoff < Ship < Done
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
test("retireStateIssueUpdateInput: moves state/rank without label mutation", () => {
  assert.deepEqual(retireStateIssueUpdateInput("ready-id", [{ sortOrder: 0 }, { sortOrder: -4 }]), {
    stateId: "ready-id",
    sortOrder: -5,
  });
});
test("retireStateAuditComment: records state retirement and label preservation", () => {
  const body = retireStateAuditComment("In Progress", "Dev");
  assert.match(body, /Retiring legacy workflow state `In Progress`/);
  assert.match(body, /moved this card to `Dev`/);
  assert.match(body, /Existing labels were preserved as-is/);
  assert.match(body, /no new claim label was added/);
});
test("retireState: moves source cards, omits label mutation, and comments after update", async () => {
  const calls = [];
  const gqlFn = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes("project(id:$id)")) {
      return { project: { teams: { nodes: [{ states: { nodes: [
        { id: "in-progress-id", name: "In Progress" },
        { id: "ready-id", name: "Dev" },
      ] } }] } } };
    }
    if (query.includes("state:{ name:{ eq:$state }") && variables.state === "In Progress") {
      return { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { id: "issue-1", identifier: "COD-1", title: "Active", sortOrder: 10, url: "https://linear/COD-1" },
      ] } };
    }
    if (query.includes("state:{ name:{ eq:$state }") && variables.state === "Dev") {
      return { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { id: "issue-2", sortOrder: 4 },
        { id: "issue-3", sortOrder: -2 },
      ] } };
    }
    if (query.includes("issueUpdate")) {
      assert.deepEqual(variables, { id: "issue-1", input: { stateId: "ready-id", sortOrder: -3 } });
      assert.equal(Object.hasOwn(variables.input, "labelIds"), false);
      assert.equal(Object.values(variables.input).includes("dev:in-progress"), false);
      return { issueUpdate: { success: true, issue: { identifier: "COD-1", state: { name: "Dev" }, sortOrder: -3, url: "https://linear/COD-1" } } };
    }
    if (query.includes("commentCreate")) {
      assert.equal(variables.id, "issue-1");
      assert.match(variables.b, /Existing labels were preserved as-is/);
      return { commentCreate: { success: true } };
    }
    throw new Error(`unexpected query: ${query}`);
  };
  const logs = [];
  const moved = await retireState("project-1", "In Progress", "Dev", { gqlFn, log: (line) => logs.push(line) });
  assert.deepEqual(moved.map((issue) => issue.identifier), ["COD-1"]);
  const updateIndex = calls.findIndex((c) => c.query.includes("issueUpdate"));
  const commentIndex = calls.findIndex((c) => c.query.includes("commentCreate"));
  assert.ok(updateIndex >= 0);
  assert.ok(commentIndex > updateIndex);
  assert.ok(logs.some((line) => line.includes("Moved 1 card")));
});

// ── taxonomy declarations ────────────────────────────────────────────────────
test("REQUIRED_STATES: new columns declared, Signoff created before Ship", () => {
  const names = REQUIRED_STATES.map((s) => s.name);
  for (const n of ["Spec", "Dev", "QA", "Signoff", "Ship"]) assert.ok(names.includes(n), `missing ${n}`);
  assert.ok(names.includes("Signoff"));
  assert.ok(names.includes("Ship"));
  assert.ok(names.indexOf("Signoff") < names.indexOf("Ship"));
  assert.equal(REQUIRED_STATES.find((s) => s.name === "QA").after, "Dev");
  assert.equal(REQUIRED_STATES.find((s) => s.name === "Signoff").after, "QA");
  assert.equal(REQUIRED_STATES.find((s) => s.name === "Ship").after, "Signoff");
});
test("REQUIRED_LABELS: ship/qa/manual-only taxonomy present", () => {
  const names = REQUIRED_LABELS.map((l) => l.name);
  for (const n of ["qa:passed", "ship:in-progress", "ship:approved", "fast-path:eligible", "sweep:manual-only"]) assert.ok(names.includes(n), `missing ${n}`);
});

// ── workflow state rename migration ─────────────────────────────────────────
test("planWorkflowStateRenames: complete legacy board produces ordered rename operations", () => {
  const states = WORKFLOW_STATE_RENAMES.map((r, i) => ({ id: `state-${i}`, name: r.from }));
  assert.deepEqual(planWorkflowStateRenames(states), WORKFLOW_STATE_RENAMES.map((r, i) => ({
    id: `state-${i}`,
    from: r.from,
    to: r.to,
  })));
});

test("planWorkflowStateRenames: already-renamed board is idempotent", () => {
  const states = WORKFLOW_STATE_RENAMES.map((r, i) => ({ id: `state-${i}`, name: r.to }));
  assert.deepEqual(planWorkflowStateRenames(states), []);
});

test("planWorkflowStateRenames: partial or colliding board fails before mutation", () => {
  const partial = [
    { id: "old-dev", name: "Ready for Dev" },
    { id: "new-dev", name: "Dev" },
    { id: "qa", name: "In Review" },
  ];
  assert.throws(() => planWorkflowStateRenames(partial), /partial or colliding board state/);
});

test("shouldDeferRequiredStateForRename: protects old boards but lets fresh default In Review create QA", () => {
  assert.equal(shouldDeferRequiredStateForRename("QA", ["In Review"]), false);
  assert.equal(shouldDeferRequiredStateForRename("QA", ["In Review", "Needs Spec"]), true);
  assert.equal(shouldDeferRequiredStateForRename("Spec", ["Needs Spec", "In Review"]), true);
  assert.equal(shouldDeferRequiredStateForRename("Ship", ["Backlog", "Done"]), false);
});

test("renameWorkflowStates: calls workflowStateUpdate with resolved state ids and target names", async () => {
  const states = WORKFLOW_STATE_RENAMES.map((r, i) => ({ id: `state-${i}`, name: r.from }));
  const calls = [];
  const gqlFn = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes("project(id:$id)")) {
      return { project: { teams: { nodes: [{ states: { nodes: states } }] } } };
    }
    if (query.includes("workflowStateUpdate")) {
      return { workflowStateUpdate: { success: true, workflowState: { id: variables.id, name: variables.input.name } } };
    }
    throw new Error(`unexpected query: ${query}`);
  };
  const logs = [];
  const renamed = await renameWorkflowStates("project-1", { gqlFn, log: (line) => logs.push(line) });
  assert.equal(renamed.length, WORKFLOW_STATE_RENAMES.length);
  const updates = calls.filter((c) => c.query.includes("workflowStateUpdate"));
  assert.deepEqual(updates.map((c) => c.variables), WORKFLOW_STATE_RENAMES.map((r, i) => ({
    id: `state-${i}`,
    input: { name: r.to },
  })));
  assert.ok(logs.some((line) => line.includes("Renamed 5 workflow state")));
});

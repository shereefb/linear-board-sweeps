// Unit tests for the Linear engine's pure helpers (node:test, zero-dep).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  positionAfter, reviewLensLabels, bottomSortOrder, issueUpdateToStateBottomInput,
  retireStateAuditComment, retireStateIssueUpdateInput, retireState, REQUIRED_STATES, REQUIRED_LABELS,
  WORKFLOW_STATE_RENAMES, planWorkflowStateRenames, renameWorkflowStates, shouldDeferRequiredStateForRename,
  WORKFLOW_STATES, normalizeBlockingRelations, dependencyEligibility, fetchIssueDependencies,
  repoRouteEligibility, fetchIssueLabels,
} from "../scripts/linear.mjs";

test("dependency eligibility releases only exact Done blockers", () => {
  assert.equal(WORKFLOW_STATES.done, "Done");
  const connection = {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      { id: "r1", type: "blocks", issue: { id: "b1", identifier: "COD-1", state: { id: "s1", name: "Done", type: "completed" } } },
      { id: "r2", type: "related", issue: { id: "x", identifier: "COD-2", state: { id: "s2", name: "Done", type: "completed" } } },
    ],
  };
  const blockers = normalizeBlockingRelations(connection);
  assert.deepEqual(blockers.map((b) => b.identifier), ["COD-1"]);
  assert.deepEqual(dependencyEligibility(blockers, true), { eligible: true, reason: "ready", unresolved: [] });
});

test("dependency eligibility fails closed for terminal non-Done and incomplete pages", () => {
  const canceled = [{ relationId: "r", id: "b", identifier: "COD-3", stateId: "s", stateName: "Canceled", stateType: "canceled" }];
  assert.equal(dependencyEligibility(canceled, true).eligible, false);
  assert.equal(dependencyEligibility([], false).reason, "incomplete-relations");
});

test("dependency normalization fails closed when a blocks relation has no issue", () => {
  assert.throws(
    () => normalizeBlockingRelations({ pageInfo: { hasNextPage: false }, nodes: [{ id: "r", type: "blocks", issue: null }] }),
    /blocking relation r has no readable issue/,
  );
});

test("repo route eligibility requires one live mapped label matching the expected label and repo", () => {
  const byLabel = { "app:coach": "coach", "app:guide": "guide" };
  assert.deepEqual(repoRouteEligibility(["app:guide", "frontend"], byLabel, "app:guide", "guide"), {
    eligible: true,
    reason: "ready",
    matches: [{ label: "app:guide", repoEntry: "guide" }],
  });
  assert.equal(repoRouteEligibility([], byLabel, "app:guide", "guide").reason, "missing-route-label");
  assert.equal(repoRouteEligibility(["app:coach", "app:guide"], byLabel, "app:guide", "guide").reason, "ambiguous-route-label");
  assert.equal(repoRouteEligibility(["app:coach"], byLabel, "app:guide", "guide").reason, "route-changed");
  assert.throws(() => repoRouteEligibility(["app:guide"], null, "app:guide", "guide"), /repoRouting.byLabel/);
});

test("fetchIssueLabels returns the canonical identifier and exact live label names", async () => {
  const calls = [];
  const result = await fetchIssueLabels("key", "SAF-207", {
    gqlFn: async (query, variables, apiKey) => {
      calls.push({ query, variables, apiKey });
      return { issue: { identifier: "SAF-207", labels: { nodes: [{ name: "app:guide" }, { name: "frontend" }] } } };
    },
  });
  assert.deepEqual(result, { issue: "SAF-207", labelNames: ["app:guide", "frontend"] });
  assert.equal(calls[0].apiKey, "key");
});

test("fetchIssueDependencies paginates inverse blocking relations to completion", async () => {
  const calls = [];
  const gqlFn = async (query, variables, apiKey) => {
    calls.push({ query, variables, apiKey });
    assert.match(query, /inverseRelations\(first:50,\s*after:\$cursor\)/);
    const firstPage = variables.cursor === null;
    return {
      issue: {
        identifier: "COD-9",
        inverseRelations: {
          pageInfo: { hasNextPage: firstPage, endCursor: firstPage ? "next" : null },
          nodes: [{
            id: firstPage ? "r1" : "r2",
            type: "blocks",
            issue: {
              id: firstPage ? "b1" : "b2",
              identifier: firstPage ? "COD-1" : "COD-2",
              state: { id: firstPage ? "s1" : "s2", name: firstPage ? "Dev" : "Done", type: firstPage ? "unstarted" : "completed" },
            },
          }],
        },
      },
    };
  };

  const result = await fetchIssueDependencies("key", "COD-9", { gqlFn });
  assert.deepEqual(result.blockers.map((b) => b.identifier), ["COD-1", "COD-2"]);
  assert.equal(result.complete, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.variables.cursor), [null, "next"]);
  assert.ok(calls.every((call) => call.apiKey === "key"));
});

test("fetchIssueDependencies fails closed when a continuation cursor cycles", async () => {
  const calls = [];
  const nextCursor = new Map([[null, "A"], ["A", "B"], ["B", "A"]]);
  const gqlFn = async (_query, variables) => {
    calls.push(variables.cursor);
    if (calls.length > 3) throw new Error("pagination did not stop at the repeated cursor");
    return {
      issue: {
        identifier: "COD-9",
        inverseRelations: {
          pageInfo: { hasNextPage: true, endCursor: nextCursor.get(variables.cursor) },
          nodes: [],
        },
      },
    };
  };

  const result = await fetchIssueDependencies("key", "COD-9", { gqlFn });
  assert.deepEqual(calls, [null, "A", "B"]);
  assert.equal(result.complete, false);
});

test("fetchIssueDependencies rejects query failures instead of returning an empty blocker set", async () => {
  const gqlFn = async () => { throw new Error("Linear query failed"); };
  await assert.rejects(fetchIssueDependencies("key", "COD-9", { gqlFn }), /Linear query failed/);
});

const linearCli = fileURLToPath(new URL("../scripts/linear.mjs", import.meta.url));
function runDependencyStatusCli(inverseRelations, env = {}) {
  const response = { data: { issue: { identifier: "COD-9", inverseRelations } } };
  const preloadSource = `globalThis.fetch = async () => ({ json: async () => (${JSON.stringify(response)}) });`;
  const preload = `data:text/javascript,${encodeURIComponent(preloadSource)}`;
  return spawnSync(process.execPath, ["--import", preload, linearCli, "dependency-status", "COD-9"], {
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "key", ...env },
  });
}

function runRepoStatusCli(labelNames, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-repo-status-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "linear-sweep.json"), JSON.stringify({
    repos: ["coach", "guide"],
    repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } },
  }));
  const response = { data: { issue: { identifier: "SAF-207", labels: { nodes: labelNames.map((name) => ({ name })) } } } };
  const preloadSource = `globalThis.fetch = async () => ({ json: async () => (${JSON.stringify(response)}) });`;
  const preload = `data:text/javascript,${encodeURIComponent(preloadSource)}`;
  return spawnSync(process.execPath, ["--import", preload, linearCli, "repo-status", "SAF-207", "app:guide", "guide"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "key", ...env },
  });
}

test("repo-status CLI fails closed on a live label race and writes a parent outcome", () => {
  const ready = runRepoStatusCli(["app:guide"]);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).eligible, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-route-outcome-"));
  const outcomePath = path.join(dir, "outcome.json");
  const changed = runRepoStatusCli(["app:coach"], { AUTO_SWEEP_OUTCOME_PATH: outcomePath });
  assert.equal(changed.status, 3, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).reason, "route-changed");
  assert.deepEqual(JSON.parse(fs.readFileSync(outcomePath, "utf8")), {
    version: 1,
    kind: "repo-routing-deferred",
    issueIdentifier: "SAF-207",
    routeExitCode: 3,
    routing: { reason: "route-changed", expectedLabel: "app:guide", expectedRepoEntry: "guide", matches: [{ label: "app:coach", repoEntry: "coach" }] },
  });
});
test("child preflights preserve the first deferred outcome if a later check mistakenly continues", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-first-outcome-"));
  const outcomePath = path.join(dir, "outcome.json");
  const changed = runRepoStatusCli(["app:coach"], { AUTO_SWEEP_OUTCOME_PATH: outcomePath });
  assert.equal(changed.status, 3, changed.stderr);
  const readyDependency = runDependencyStatusCli({ pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, {
    AUTO_SWEEP_OUTCOME_PATH: outcomePath,
  });
  assert.equal(readyDependency.status, 0, readyDependency.stderr);
  assert.equal(JSON.parse(fs.readFileSync(outcomePath, "utf8")).kind, "repo-routing-deferred");
});

test("dependency-status CLI emits blocker JSON and maps readiness to exit status", () => {
  const blocked = runDependencyStatusCli({
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [{ id: "r1", type: "blocks", issue: { id: "b1", identifier: "COD-1", state: { id: "s1", name: "Dev", type: "unstarted" } } }],
  });
  assert.equal(blocked.status, 3, blocked.stderr);
  assert.deepEqual(JSON.parse(blocked.stdout), {
    issue: "COD-9",
    eligible: false,
    reason: "blocked",
    blockers: [{ identifier: "COD-1", stateName: "Dev" }],
  });

  const ready = runDependencyStatusCli({ pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] });
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).eligible, true);

  const incomplete = runDependencyStatusCli({ pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] });
  assert.equal(incomplete.status, 2, incomplete.stderr);
  assert.equal(JSON.parse(incomplete.stdout).reason, "incomplete-relations");
});

test("dependency-status CLI writes a machine-readable parent outcome for blocked and unreadable dependencies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-dependency-cli-outcome-"));
  const blockedPath = path.join(dir, "blocked.json");
  const blocked = runDependencyStatusCli({
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [{ id: "r1", type: "blocks", issue: { id: "b1", identifier: "COD-1", state: { id: "s1", name: "Dev", type: "unstarted" } } }],
  }, { AUTO_SWEEP_OUTCOME_PATH: blockedPath });
  assert.equal(blocked.status, 3, blocked.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(blockedPath, "utf8")), {
    version: 1,
    kind: "dependency-deferred",
    issueIdentifier: "COD-9",
    dependencyExitCode: 3,
    dependency: { reason: "blocked", blockers: [{ identifier: "COD-1", stateName: "Dev" }] },
  });

  const unreadablePath = path.join(dir, "unreadable.json");
  const unreadable = runDependencyStatusCli({ pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] }, {
    AUTO_SWEEP_OUTCOME_PATH: unreadablePath,
  });
  assert.equal(unreadable.status, 2, unreadable.stderr);
  assert.equal(JSON.parse(fs.readFileSync(unreadablePath, "utf8")).dependencyExitCode, 2);
});

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

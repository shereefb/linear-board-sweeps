// Unit tests for the Linear engine's pure helpers (node:test, zero-dep).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimCloseMarker, claimDeclarationMarker, claimHeartbeatMarker } from "../scripts/claim-ownership.mjs";
import {
  positionAfter, reviewLensLabels, bottomSortOrder, issueUpdateToStateBottomInput,
  retireStateAuditComment, retireStateIssueUpdateInput, retireState, REQUIRED_STATES, REQUIRED_LABELS,
  WORKFLOW_STATE_RENAMES, planWorkflowStateRenames, renameWorkflowStates, shouldDeferRequiredStateForRename,
  WORKFLOW_STATES, normalizeBlockingRelations, dependencyEligibility, fetchIssueDependencies,
  repoRouteEligibility, fetchIssueLabels, qaHandoffDecision, guardedTerminalMoveDecision,
  guardedTerminalMoveInput, latestClaimHeartbeat, fetchCompleteIssueComments, moveCardBottomIfCurrent,
} from "../scripts/linear.mjs";

test("fetchCompleteIssueComments paginates claim history and rejects cursor cycles", async () => {
  const pages = [
    { nodes: [{ id: "c2", body: "two", createdAt: "2026-07-11T00:00:02.000Z" }], pageInfo: { hasNextPage: true, endCursor: "next" } },
    { nodes: [{ id: "c1", body: "one", createdAt: "2026-07-11T00:00:01.000Z" }], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  let call = 0;
  const comments = await fetchCompleteIssueComments("issue", { gqlFn: async (_query, variables) => {
    assert.equal(variables.cursor, call === 0 ? null : "next");
    return { issue: { comments: pages[call++] } };
  } });
  assert.deepEqual(comments.map(({ id }) => id), ["c1", "c2"]);

  let cycleCall = 0;
  await assert.rejects(fetchCompleteIssueComments("issue", { gqlFn: async () => ({ issue: { comments: {
    nodes: [], pageInfo: { hasNextPage: true, endCursor: cycleCall++ ? "same" : "same" },
  } } }) }), /pagination incomplete/);
});

test("fetchCompleteIssueComments rejects malformed nodes and duplicate ids across pages", async () => {
  for (const node of [
    { id: "", body: "body", createdAt: "2026-07-11T00:00:01.000Z" },
    { id: "c1", createdAt: "2026-07-11T00:00:01.000Z" },
    { id: "c1", body: "body", createdAt: "not-a-date" },
  ]) {
    await assert.rejects(fetchCompleteIssueComments("issue", {
      gqlFn: async () => ({ issue: { comments: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    }), /comments unreadable/);
  }
  let call = 0;
  const pages = [
    { nodes: [{ id: "duplicate", body: "one", createdAt: "2026-07-11T00:00:01.000Z" }], pageInfo: { hasNextPage: true, endCursor: "next" } },
    { nodes: [{ id: "duplicate", body: "two", createdAt: "2026-07-11T00:00:02.000Z" }], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  await assert.rejects(fetchCompleteIssueComments("issue", {
    gqlFn: async () => ({ issue: { comments: pages[call++] } }),
  }), /duplicate comment id/);
});

const QA_HANDOFF_BASE = Object.freeze({
  fastPathEnabled: true,
  requireShipApproval: false,
  stateName: "QA",
  labelNames: ["fast-path:eligible", "qa:passed", "qa:in-progress"],
  issueIdentifier: "COD-142",
  reviewedHead: "a".repeat(40),
  finalHead: "a".repeat(40),
  hasForeignClaim: false,
});

test("QA handoff sends an eligible fast path to Ship", () => {
  assert.deepEqual(qaHandoffDecision(QA_HANDOFF_BASE), {
    destination: "Ship",
    eligible: true,
    reason: "eligible",
  });
});

const QA_HANDOFF_DENIALS = [
  [{ fastPathEnabled: false }, "fast-path-disabled"],
  [{ requireShipApproval: true }, "ship-approval-required"],
  [{ labelNames: ["fast-path:eligible", "qa:passed", "qa:in-progress", "factory:learning-generated"] }, "factory-learning-requires-signoff"],
  [{ stateName: "Signoff" }, "not-in-qa"],
  [{ labelNames: ["qa:passed"] }, "missing-fast-path-label"],
  [{ labelNames: ["fast-path:eligible"] }, "missing-qa-pass"],
  [{ labelNames: ["fast-path:eligible", "qa:passed", "blocked:open-questions"] }, "blocked"],
  [{ labelNames: ["fast-path:eligible", "qa:passed", "blocked:needs-user"] }, "blocked"],
  [{ labelNames: ["fast-path:eligible", "qa:passed", "qa:needs-changes"] }, "blocked"],
  [{ labelNames: ["fast-path:eligible", "qa:passed", "sweep:manual-only"] }, "blocked"],
  [{ hasForeignClaim: true }, "foreign-claim"],
  [{ reviewedHead: null }, "missing-reviewed-head"],
  [{ reviewedHead: "abc123" }, "invalid-reviewed-head"],
  [{ finalHead: null }, "missing-final-head"],
  [{ finalHead: "abc123" }, "invalid-final-head"],
  [{ finalHead: "b".repeat(40) }, "head-mismatch"],
];

for (const [override, reason] of QA_HANDOFF_DENIALS) {
  test(`QA handoff denies with ${reason}`, () => {
    assert.deepEqual(qaHandoffDecision({ ...QA_HANDOFF_BASE, ...override }), {
      destination: "Signoff",
      eligible: false,
      reason,
    });
  });
}

const QA_HANDOFF_INVALID_CONFIG = [
  [{ fastPathEnabled: "false" }, "invalid-fast-path-enabled"],
  [{ fastPathEnabled: null }, "invalid-fast-path-enabled"],
  [{ fastPathEnabled: 0 }, "invalid-fast-path-enabled"],
  [{ requireShipApproval: "true" }, "invalid-ship-approval"],
  [{ requireShipApproval: null }, "invalid-ship-approval"],
  [{ requireShipApproval: 0 }, "invalid-ship-approval"],
];

for (const [override, reason] of QA_HANDOFF_INVALID_CONFIG) {
  test(`QA handoff fails closed with ${reason} for ${JSON.stringify(override)}`, () => {
    assert.deepEqual(qaHandoffDecision({ ...QA_HANDOFF_BASE, ...override }), {
      destination: "Signoff",
      eligible: false,
      reason,
    });
  });
}

test("QA handoff defaults fast path on and ship approval off", () => {
  const { fastPathEnabled: _fastPathEnabled, requireShipApproval: _requireShipApproval, ...input } = QA_HANDOFF_BASE;
  assert.deepEqual(qaHandoffDecision(input), {
    destination: "Ship",
    eligible: true,
    reason: "eligible",
  });
  assert.deepEqual(qaHandoffDecision({
    ...input,
    fastPathEnabled: undefined,
    requireShipApproval: undefined,
  }), {
    destination: "Ship",
    eligible: true,
    reason: "eligible",
  });
});

test("QA handoff compares full Git SHAs case-insensitively", () => {
  assert.deepEqual(qaHandoffDecision({
    ...QA_HANDOFF_BASE,
    reviewedHead: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    finalHead: "abcdef0123456789abcdef0123456789abcdef01",
  }), {
    destination: "Ship",
    eligible: true,
    reason: "eligible",
  });
});

test("QA handoff fails closed for malformed or missing input", () => {
  for (const input of [undefined, null, "invalid", [], { labelNames: "fast-path:eligible" }]) {
    const decision = qaHandoffDecision(input);
    assert.equal(decision.destination, "Signoff");
    assert.equal(decision.eligible, false);
  }
});

test("QA handoff does not mutate the input or labels", () => {
  const labelNames = Object.freeze([...QA_HANDOFF_BASE.labelNames]);
  const input = Object.freeze({ ...QA_HANDOFF_BASE, labelNames });
  const before = structuredClone(input);
  qaHandoffDecision(input);
  assert.deepEqual(input, before);
});

const GUARDED_MOVE_BASE = Object.freeze({
  stateName: "QA",
  expectedState: "QA",
  destinationState: "Ship",
  labelNames: ["qa:passed", "fast-path:eligible", "qa:in-progress"],
  ownedClaim: "qa:in-progress",
  ownerToken: "owner-142",
  heartbeatOwner: "owner-142",
  heartbeatMalformed: false,
});

test("guarded terminal move allows only a current source card with its owned claim", () => {
  assert.deepEqual(guardedTerminalMoveDecision(GUARDED_MOVE_BASE), { eligible: true, reason: "ready" });
});

for (const [override, reason] of [
  [{ destinationState: "Done" }, "invalid-destination"],
  [{ destinationState: "Dev" }, "invalid-destination"],
  [{ destinationState: "Unexpected" }, "invalid-destination"],
  [{ expectedState: "Dev", stateName: "Dev", ownedClaim: "dev:in-progress", destinationState: "QA" }, "invalid-destination"],
  [{ stateName: "Signoff" }, "source-state-changed"],
  [{ labelNames: ["qa:passed"] }, "owned-claim-missing"],
  [{ labelNames: ["qa:passed", "qa:in-progress", "blocked:needs-user"] }, "blocking-label"],
  [{ labelNames: ["qa:passed", "qa:in-progress", "sweep:manual-only"] }, "blocking-label"],
  [{ labelNames: ["qa:passed", "qa:in-progress", "dev:in-progress"] }, "foreign-claim"],
  [{ ownedClaim: "fast-path:eligible" }, "invalid-owned-claim"],
  [{ ownerToken: "" }, "missing-owner-token"],
  [{ heartbeatOwner: null }, "missing-owner-heartbeat"],
  [{ heartbeatOwner: "newer-owner" }, "owner-mismatch"],
  [{ heartbeatOwner: null, heartbeatMalformed: true }, "malformed-heartbeat"],
  [{ labelNames: ["qa:passed", "fast-path:eligible", "qa:in-progress", "factory:learning-generated"] }, "factory-learning-requires-signoff"],
]) {
  test(`guarded terminal move denies ${reason}`, () => {
    assert.deepEqual(guardedTerminalMoveDecision({ ...GUARDED_MOVE_BASE, ...override }), { eligible: false, reason });
  });
}

test("guarded terminal move allows a generated learning card to move from QA to Signoff", () => {
  assert.deepEqual(guardedTerminalMoveDecision({
    ...GUARDED_MOVE_BASE,
    destinationState: "Signoff",
    labelNames: [...GUARDED_MOVE_BASE.labelNames, "factory:learning-generated"],
  }), { eligible: true, reason: "ready" });
});

test("latestClaimHeartbeat selects the newest exact-claim owner", () => {
  assert.deepEqual(latestClaimHeartbeat([
    { body: "[auto-sweep-heartbeat 2026-07-10T10:00:00.000Z owner=older claim=qa:in-progress]", createdAt: "2026-07-10T10:00:00.000Z" },
    { body: "[auto-sweep-heartbeat 2026-07-10T10:05:00.000Z owner=owner-142 claim=qa:in-progress] still working", createdAt: "2026-07-10T10:05:00.000Z" },
    { body: "[auto-sweep-heartbeat 2026-07-10T10:06:00.000Z owner=dev-owner claim=dev:in-progress]", createdAt: "2026-07-10T10:06:00.000Z" },
  ], "qa:in-progress"), { owner: "owner-142", malformed: false });
});

test("latestClaimHeartbeat fails ownership closed for a newer malformed exact-claim comment", () => {
  assert.deepEqual(latestClaimHeartbeat([
    { body: "[auto-sweep-heartbeat 2026-07-10T10:00:00.000Z owner=owner-142 claim=qa:in-progress]", createdAt: "2026-07-10T10:00:00.000Z" },
    { body: "[auto-sweep-heartbeat malformed claim=qa:in-progress]", createdAt: "2026-07-10T10:05:00.000Z" },
  ], "qa:in-progress"), { owner: null, malformed: true });
  assert.throws(() => latestClaimHeartbeat([], "qa:in-progress", { complete: false }), /comments incomplete/);
});

test("guarded terminal move input removes only the owned claim", () => {
  assert.deepEqual(guardedTerminalMoveInput(
    "ship-state",
    [{ sortOrder: 7 }, { sortOrder: -3 }],
    "claim-id",
  ), {
    stateId: "ship-state",
    sortOrder: -4,
    removedLabelIds: ["claim-id"],
  });
});

test("guarded terminal move closes the exact declaration before issueUpdate", async () => {
  const calls = [];
  let commentRead = 0;
  const gqlFn = async (query, variables) => {
    const kind = query.includes("project { id }") ? "metadata"
      : query.includes("issues(first:100") ? "destination"
        : query.includes("comments(first:100") ? (commentRead++ === 0 ? "final-read" : "close-read")
          : query.includes("labels(first:250)") ? "final-facts"
            : query.includes("commentCreate") ? "close"
              : query.includes("issueUpdate") ? "issue-update" : "unexpected";
    calls.push({ kind, query, variables });
    if (query.includes("project { id }")) return { issue: {
      id: "issue-142", identifier: "COD-142", project: { id: "project" },
      team: { states: { nodes: [{ id: "qa-state", name: "QA" }, { id: "ship-state", name: "Ship" }] } },
    } };
    if (query.includes("labels(first:250)")) return { issue: {
      id: "issue-142", identifier: "COD-142", state: { name: "QA" },
      labels: { pageInfo: { hasNextPage: false }, nodes: [
        { id: "passed", name: "qa:passed" }, { id: "claim", name: "qa:in-progress" }, { id: "product", name: "frontend" },
      ] },
    } };
    if (query.includes("comments(first:100")) {
      const nodes = [{
        id: "declaration", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner-142", declarationId: "decl-142" }),
        createdAt: "2026-07-10T10:00:00.000Z",
      }];
      if (commentRead > 1) nodes.push({
        id: "close", body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl-142", reason: "terminal" }),
        createdAt: "2026-07-10T10:06:00.000Z",
      });
      return { issue: { comments: { pageInfo: { hasNextPage: false }, nodes } } };
    }
    if (query.includes("issues(first:100")) return {
      issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "other", sortOrder: -8 }] },
    };
    if (query.includes("commentCreate")) return { commentCreate: { success: true, comment: {
      id: "close", body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl-142", reason: "terminal" }),
      createdAt: "2026-07-10T10:06:00.000Z",
    } } };
    if (query.includes("issueUpdate")) return { issueUpdate: { success: true, issue: {
      identifier: "COD-142", state: { name: "Ship" }, sortOrder: -9, url: "https://linear/COD-142",
    } } };
    throw new Error(`unexpected query: ${query}`);
  };

  const result = await moveCardBottomIfCurrent("COD-142", "QA", "Ship", "qa:in-progress", "owner-142", "decl-142", { gqlFn, log: () => {} });
  assert.equal(result.moved, true);
  const destinationIndex = calls.findIndex((call) => call.kind === "destination");
  const commentsIndex = calls.findIndex((call) => call.kind === "final-read");
  const finalFactsIndex = calls.findIndex((call) => call.kind === "final-facts");
  assert.ok(destinationIndex >= 0 && commentsIndex > destinationIndex, "destination pagination must precede claim-history pagination");
  assert.ok(finalFactsIndex > commentsIndex, "the final state/labels guard must follow claim-history pagination");
  assert.deepEqual(calls.map((call) => call.kind), [
    "metadata", "destination", "final-read", "final-facts", "close", "close-read", "final-facts", "issue-update",
  ]);
  assert.equal(calls.find((call) => call.kind === "close").variables.b,
    claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl-142", reason: "terminal" }));
  assert.match(calls.find((call) => call.kind === "close").query, /comment\s*\{\s*id\s+body\s+createdAt\s*\}/);
  assert.deepEqual(calls.filter((call) => call.query.includes("issueUpdate")).map((call) => call.variables), [{
    id: "issue-142",
    input: { stateId: "ship-state", sortOrder: -9, removedLabelIds: ["claim"] },
  }]);
  assert.equal(Object.hasOwn(calls.find((call) => call.query.includes("issueUpdate")).variables.input, "labelIds"), false);
});

function guardedMoveHarness({
  initialState = "QA",
  initialLabelNames = ["qa:passed", "qa:in-progress"],
  postCloseState = initialState,
  postCloseLabelNames = initialLabelNames,
  createdComment = {
    id: "created-close",
    body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl-142", reason: "terminal" }),
    createdAt: "2026-07-10T10:06:00.000Z",
  },
  commentCreateResponse,
  closedCommentPages,
  issueUpdateResponse = { success: true, issue: {
    identifier: "COD-142", state: { name: "Ship" }, sortOrder: -1, url: "https://linear/COD-142",
  } },
} = {}) {
  const declaration = {
    id: "declaration",
    body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner-142", declarationId: "decl-142" }),
    createdAt: "2026-07-10T10:00:00.000Z",
  };
  const calls = [];
  let closed = false;
  let factRead = 0;
  const defaultClosedPages = [{
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: createdComment ? [declaration, createdComment] : [declaration],
  }];
  const closePages = closedCommentPages || defaultClosedPages;
  const gqlFn = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes("project { id }")) return { issue: {
      id: "issue-142", identifier: "COD-142", project: { id: "project" },
      team: { states: { nodes: [{ id: "qa-state", name: "QA" }, { id: "ship-state", name: "Ship" }] } },
    } };
    if (query.includes("issues(first:100")) return {
      issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "other", sortOrder: 0 }] },
    };
    if (query.includes("comments(first:100")) {
      if (!closed) return { issue: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [declaration] } } };
      const index = variables.cursor == null ? 0 : closePages.findIndex((page) => page.cursor === variables.cursor);
      return { issue: { comments: closePages[index] } };
    }
    if (query.includes("labels(first:250)")) {
      const stateName = factRead === 0 ? initialState : postCloseState;
      const labelNames = factRead++ === 0 ? initialLabelNames : postCloseLabelNames;
      return { issue: {
        id: "issue-142", identifier: "COD-142", state: { name: stateName },
        labels: { pageInfo: { hasNextPage: false }, nodes: labelNames.map((name, index) => ({ id: `${name}-${index}`, name })) },
      } };
    }
    if (query.includes("commentCreate")) {
      closed = true;
      return { commentCreate: commentCreateResponse === undefined
        ? { success: true, comment: createdComment }
        : commentCreateResponse };
    }
    if (query.includes("issueUpdate")) return { issueUpdate: issueUpdateResponse };
    throw new Error(`unexpected query: ${query}`);
  };
  return {
    calls,
    run: () => moveCardBottomIfCurrent(
      "COD-142", "QA", "Ship", "qa:in-progress", "owner-142", "decl-142", { gqlFn, log: () => {} },
    ),
  };
}

test("guarded terminal move rejects its duplicate close when a competing close won first", async () => {
  const competingClose = {
    id: "competing-close",
    body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl-142", reason: "terminal" }),
    createdAt: "2026-07-10T10:05:00.000Z",
  };
  const ownClose = {
    id: "created-close",
    body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl-142", reason: "terminal" }),
    createdAt: "2026-07-10T10:06:00.000Z",
  };
  const harness = guardedMoveHarness({
    createdComment: ownClose,
    closedCommentPages: [{ pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { id: "declaration", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner-142", declarationId: "decl-142" }), createdAt: "2026-07-10T10:00:00.000Z" },
      competingClose,
      ownClose,
    ] }],
  });
  await assert.rejects(harness.run(), /terminal claim close unverified/);
  assert.equal(harness.calls.some((call) => call.query.includes("issueUpdate")), false);
});

for (const [name, override, reason] of [
  ["blocker", { postCloseLabelNames: ["qa:passed", "qa:in-progress", "blocked:needs-user"] }, "blocking-label"],
  ["foreign claim", { postCloseLabelNames: ["qa:passed", "qa:in-progress", "dev:in-progress"] }, "foreign-claim"],
  ["Factory Learning label", { postCloseLabelNames: ["qa:passed", "qa:in-progress", "factory:learning-generated"] }, "factory-learning-requires-signoff"],
  ["source state change", { postCloseState: "Signoff" }, "source-state-changed"],
  ["owned claim removal", { postCloseLabelNames: ["qa:passed"] }, "owned-claim-missing"],
]) {
  test(`guarded terminal move denies a post-close ${name} race`, async () => {
    const harness = guardedMoveHarness(override);
    assert.deepEqual(await harness.run(), { moved: false, issue: "COD-142", reason });
    assert.equal(harness.calls.some((call) => call.query.includes("issueUpdate")), false);
  });
}

for (const [name, issueUpdateResponse] of [
  ["missing issue", { success: true, issue: null }],
  ["wrong identifier", { success: true, issue: { identifier: "COD-999", state: { name: "Ship" }, sortOrder: -1, url: "https://linear/COD-999" } }],
  ["wrong destination", { success: true, issue: { identifier: "COD-142", state: { name: "Signoff" }, sortOrder: -1, url: "https://linear/COD-142" } }],
  ["wrong sort order", { success: true, issue: { identifier: "COD-142", state: { name: "Ship" }, sortOrder: 0, url: "https://linear/COD-142" } }],
  ["missing URL", { success: true, issue: { identifier: "COD-142", state: { name: "Ship" }, sortOrder: -1, url: "" } }],
]) {
  test(`guarded terminal move rejects ${name} in the issueUpdate response`, async () => {
    await assert.rejects(guardedMoveHarness({ issueUpdateResponse }).run(), /guarded move response unreadable/);
  });
}

for (const [name, commentCreateResponse] of [
  ["failed commentCreate", { success: false, comment: null }],
  ["missing created comment", { success: true, comment: null }],
  ["malformed created comment", { success: true, comment: { id: "", body: "bad", createdAt: "bad" } }],
]) {
  test(`guarded terminal move rejects ${name} without issueUpdate`, async () => {
    const harness = guardedMoveHarness({ commentCreateResponse });
    await assert.rejects(harness.run(), /terminal claim close failed/);
    assert.equal(harness.calls.some((call) => call.query.includes("issueUpdate")), false);
  });
}

test("guarded terminal move verifies its exact close on a later comment page", async () => {
  const close = {
    id: "created-close",
    body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl-142", reason: "terminal" }),
    createdAt: "2026-07-10T10:06:00.000Z",
  };
  const harness = guardedMoveHarness({
    createdComment: close,
    closedCommentPages: [
      { pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: [
        { id: "declaration", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner-142", declarationId: "decl-142" }), createdAt: "2026-07-10T10:00:00.000Z" },
      ] },
      { cursor: "next", pageInfo: { hasNextPage: false, endCursor: null }, nodes: [close] },
    ],
  });
  assert.equal((await harness.run()).moved, true);
});

test("guarded terminal move rejects a newer epoch after its close", async () => {
  const close = {
    id: "created-close",
    body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl-142", reason: "terminal" }),
    createdAt: "2026-07-10T10:06:00.000Z",
  };
  const harness = guardedMoveHarness({
    createdComment: close,
    closedCommentPages: [{ pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { id: "declaration", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner-142", declarationId: "decl-142" }), createdAt: "2026-07-10T10:00:00.000Z" },
      close,
      { id: "new-declaration", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "new-owner", declarationId: "new-decl" }), createdAt: "2026-07-10T10:07:00.000Z" },
    ] }],
  });
  await assert.rejects(harness.run(), /terminal claim close unverified/);
  assert.equal(harness.calls.some((call) => call.query.includes("issueUpdate")), false);
});

test("guarded terminal move denies a stale declaration even with a late heartbeat", async () => {
  const calls = [];
  const comments = [
    { id: "old-declaration", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "old-owner", declarationId: "old-decl" }), createdAt: "2026-07-10T10:00:00.000Z" },
    { id: "old-close", body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "old-decl", reason: "released" }), createdAt: "2026-07-10T10:01:00.000Z" },
    { id: "new-declaration", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "new-owner", declarationId: "new-decl" }), createdAt: "2026-07-10T10:02:00.000Z" },
    { id: "late-old-heartbeat", body: claimHeartbeatMarker({ claim: "qa:in-progress", declarationId: "old-decl", at: "2026-07-10T10:05:00.000Z" }), createdAt: "2026-07-10T10:05:00.000Z" },
  ];
  const gqlFn = async (query) => {
    calls.push(query);
    if (query.includes("project { id }")) return { issue: {
      id: "issue-142", identifier: "COD-142", project: { id: "project" },
      team: { states: { nodes: [{ id: "ship-state", name: "Ship" }] } },
    } };
    if (query.includes("issues(first:100")) return { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
    if (query.includes("comments(first:100")) return { issue: { comments: { pageInfo: { hasNextPage: false }, nodes: comments } } };
    if (query.includes("labels(first:250)")) return { issue: {
      id: "issue-142", identifier: "COD-142", state: { name: "QA" },
      labels: { pageInfo: { hasNextPage: false }, nodes: [{ id: "claim", name: "qa:in-progress" }] },
    } };
    throw new Error(`unexpected query: ${query}`);
  };

  const result = await moveCardBottomIfCurrent(
    "COD-142", "QA", "Ship", "qa:in-progress", "old-owner", "old-decl", { gqlFn, log: () => {} },
  );
  assert.deepEqual(result, { moved: false, issue: "COD-142", reason: "owner-mismatch" });
  assert.equal(calls.some((query) => query.includes("commentCreate") || query.includes("issueUpdate")), false);
});

for (const [lateLabel, reason] of [["blocked:needs-user", "blocking-label"], ["dev:in-progress", "foreign-claim"]]) {
  test(`moveCardBottomIfCurrent denies late ${lateLabel} from the final read without mutation`, async () => {
    const calls = [];
    const gqlFn = async (query) => {
      calls.push(query);
      if (query.includes("project { id }")) return { issue: {
        id: "issue-142", identifier: "COD-142", project: { id: "project" },
        team: { states: { nodes: [{ id: "ship-state", name: "Ship" }] } },
      } };
      if (query.includes("issues(first:100")) return { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
      if (query.includes("labels(first:250)")) return { issue: {
        id: "issue-142", identifier: "COD-142", state: { name: "QA" },
        labels: { pageInfo: { hasNextPage: false }, nodes: [
          { id: "claim", name: "qa:in-progress" }, { id: "late", name: lateLabel },
        ] },
      } };
      if (query.includes("comments(first:100")) return { issue: {
        comments: { pageInfo: { hasNextPage: false }, nodes: [
          { id: "legacy-heartbeat", body: "[auto-sweep-heartbeat 2026-07-10T10:05:00.000Z owner=owner-142 claim=qa:in-progress]", createdAt: "2026-07-10T10:05:00.000Z" },
        ] },
      } };
      throw new Error(`unexpected query: ${query}`);
    };
    assert.deepEqual(
      await moveCardBottomIfCurrent("COD-142", "QA", "Ship", "qa:in-progress", "owner-142", "decl-142", { gqlFn, log: () => {} }),
      { moved: false, issue: "COD-142", reason },
    );
    assert.equal(calls.some((query) => query.includes("issueUpdate")), false);
  });
}

test("moveCardBottomIfCurrent denies a blocker added while claim history paginates", async () => {
  const calls = [];
  let commentPage = 0;
  const gqlFn = async (query) => {
    calls.push(query);
    if (query.includes("project { id }")) return { issue: {
      id: "issue-142", identifier: "COD-142", project: { id: "project" },
      team: { states: { nodes: [{ id: "ship-state", name: "Ship" }] } },
    } };
    if (query.includes("issues(first:100")) return { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
    if (query.includes("comments(first:100")) return { issue: { comments: [
      { pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: [
        { id: "old", body: "ordinary", createdAt: "2026-07-10T10:00:00.000Z" },
      ] },
      { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { id: "heartbeat", body: "[auto-sweep-heartbeat 2026-07-10T10:05:00.000Z owner=owner-142 claim=qa:in-progress]", createdAt: "2026-07-10T10:05:00.000Z" },
      ] },
    ][commentPage++] } };
    if (query.includes("labels(first:250)")) return { issue: {
      id: "issue-142", identifier: "COD-142", state: { name: "QA" },
      labels: { pageInfo: { hasNextPage: false }, nodes: [
        { id: "claim", name: "qa:in-progress" }, { id: "blocker", name: "blocked:needs-user" },
      ] },
    } };
    throw new Error(`unexpected query: ${query}`);
  };

  const result = await moveCardBottomIfCurrent("COD-142", "QA", "Ship", "qa:in-progress", "owner-142", "decl-142", { gqlFn, log: () => {} });
  assert.deepEqual(result, { moved: false, issue: "COD-142", reason: "blocking-label" });
  assert.ok(calls.findIndex((query) => query.includes("comments(first:100"))
    < calls.findIndex((query) => query.includes("labels(first:250)")));
  assert.equal(calls.some((query) => query.includes("issueUpdate")), false);
});

test("required setup taxonomy includes the exact learning provenance label", () => {
  assert.equal(REQUIRED_LABELS.filter((label) => label.name === "factory:learning-generated").length, 1);
});
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
function runGuardedMoveCli({ stateName = "QA", labelNames = ["qa:passed", "qa:in-progress"], ownerToken = "owner-142", declarationOwner = "owner-142", declarationId = "decl-142", unreadable = false, commentsComplete = true } = {}) {
  const metadataIssue = unreadable ? null : {
    id: "issue-142", identifier: "COD-142", project: { id: "project" },
    team: { states: { nodes: [{ id: "qa-state", name: "QA" }, { id: "ship-state", name: "Ship" }] } },
  };
  const finalIssue = unreadable ? null : {
    id: "issue-142", identifier: "COD-142", state: { name: stateName },
    labels: { pageInfo: { hasNextPage: false }, nodes: labelNames.map((name, index) => ({ id: `label-${index}`, name })) },
  };
  const declarationComment = {
    id: "declaration",
    body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: declarationOwner, declarationId }),
    createdAt: "2026-07-10T10:00:00.000Z",
  };
  const closeComment = {
    id: "close",
    body: claimCloseMarker({ claim: "qa:in-progress", declarationId, reason: "terminal" }),
    createdAt: "2026-07-10T10:06:00.000Z",
  };
  const preloadSource = `let closed = false;
  globalThis.fetch = async (_url, options) => {
    const { query } = JSON.parse(options.body);
    let data;
    if (query.includes("comments(first:100")) data = { issue: { comments: ${unreadable ? "null" : `{ pageInfo: { hasNextPage: ${!commentsComplete}, endCursor: null }, nodes: closed ? ${JSON.stringify([declarationComment, closeComment])} : ${JSON.stringify([declarationComment])} }`} } };
    else if (query.includes("labels(first:250)")) data = { issue: ${JSON.stringify(finalIssue)} };
    else if (query.includes("issue(id:$id)")) data = { issue: ${JSON.stringify(metadataIssue)} };
    else if (query.includes("issues(first:100")) data = { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
    else if (query.includes("commentCreate")) { closed = true; data = { commentCreate: { success: true, comment: ${JSON.stringify(closeComment)} } }; }
    else if (query.includes("issueUpdate")) data = { issueUpdate: { success: true, issue: { identifier: "COD-142", state: { name: "Ship" }, sortOrder: 0, url: "https://linear/COD-142" } } };
    else throw new Error("unexpected query: " + query);
    return { json: async () => ({ data }) };
  };`;
  const preload = `data:text/javascript,${encodeURIComponent(preloadSource)}`;
  return spawnSync(process.execPath, ["--import", preload, linearCli, "move-card-bottom-if-current", "COD-142", "QA", "Ship", "qa:in-progress", ownerToken, declarationId], {
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "key" },
  });
}

test("move-card-bottom-if-current CLI maps moved, denied, and unreadable outcomes to 0/3/2", () => {
  const moved = runGuardedMoveCli();
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(JSON.parse(moved.stdout).moved, true);

  const denied = runGuardedMoveCli({ stateName: "Signoff" });
  assert.equal(denied.status, 3, denied.stderr);
  assert.deepEqual(JSON.parse(denied.stdout), { moved: false, issue: "COD-142", reason: "source-state-changed" });

  const newerOwner = runGuardedMoveCli({ declarationOwner: "newer-owner" });
  assert.equal(newerOwner.status, 3, newerOwner.stderr);
  assert.equal(JSON.parse(newerOwner.stdout).reason, "owner-mismatch");

  const unreadable = runGuardedMoveCli({ unreadable: true });
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /not found.*unreadable/i);

  const incomplete = runGuardedMoveCli({ commentsComplete: false });
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stderr, /comments incomplete/i);
});

function runDependencyStatusCli(inverseRelations, env = {}) {
  const response = { data: { issue: { identifier: "COD-9", inverseRelations } } };
  const preloadSource = `globalThis.fetch = async () => ({ json: async () => (${JSON.stringify(response)}) });`;
  const preload = `data:text/javascript,${encodeURIComponent(preloadSource)}`;
  return spawnSync(process.execPath, ["--import", preload, linearCli, "dependency-status", "COD-9"], {
    encoding: "utf8",
    env: { ...process.env, AUTO_SWEEP_ANCHOR: "", AUTO_SWEEP_OUTCOME_PATH: "", LINEAR_API_KEY: "key", ...env },
  });
}

function runRepoStatusCli(labelNames, env = {}, { configDir, cwd } = {}) {
  const dir = configDir || fs.mkdtempSync(path.join(os.tmpdir(), "linear-repo-status-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "linear-sweep.json"), JSON.stringify({
    repos: ["coach", "guide"],
    repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } },
  }));
  const response = { data: { issue: { identifier: "SAF-207", labels: { nodes: labelNames.map((name) => ({ name })) } } } };
  const preloadSource = `globalThis.fetch = async () => ({ json: async () => (${JSON.stringify(response)}) });`;
  const preload = `data:text/javascript,${encodeURIComponent(preloadSource)}`;
  return spawnSync(process.execPath, ["--import", preload, linearCli, "repo-status", "SAF-207", "app:guide", "guide"], {
    cwd: cwd || dir,
    encoding: "utf8",
    env: { ...process.env, AUTO_SWEEP_ANCHOR: "", AUTO_SWEEP_OUTCOME_PATH: "", LINEAR_API_KEY: "key", ...env },
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
test("repo-status CLI reads routing config from the scheduled workspace anchor", () => {
  const anchor = fs.mkdtempSync(path.join(os.tmpdir(), "linear-repo-anchor-"));
  const routedRepo = fs.mkdtempSync(path.join(os.tmpdir(), "linear-routed-repo-"));
  const result = runRepoStatusCli(
    ["app:guide"],
    { AUTO_SWEEP_ANCHOR: anchor },
    { configDir: anchor, cwd: routedRepo },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).eligible, true);
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIM_CLOSE_TAG,
  CLAIM_DECLARATION_TAG,
  CLAIM_HEARTBEAT_TAG,
  CLAIM_PROTOCOL_VERSION,
  CLAIM_RESET_TAG,
  claimCloseMarker,
  claimDeclarationMarker,
  claimHeartbeatMarker,
  claimResetMarker,
  parseClaimMarker,
  resolveClaimOwnership,
} from "../scripts/claim-ownership.mjs";

const BASE_TIME = Date.parse("2026-07-11T00:00:00.000Z");
const iso = (offset) => new Date(BASE_TIME + offset * 1_000).toISOString();
const comment = (id, body, offset) => ({ id, body, createdAt: iso(offset) });

test("marker builders and parser use the strict versioned protocol", () => {
  const declaration = claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-a", declarationId: "decl-a" });
  const heartbeat = claimHeartbeatMarker({ claim: "dev:in-progress", declarationId: "decl-a", at: iso(1) });
  const close = claimCloseMarker({ claim: "dev:in-progress", declarationId: "decl-a", reason: "released" });
  const reset = claimResetMarker({ claim: "dev:in-progress", target: "decl-a", reason: "orphan-declaration" });

  assert.equal(CLAIM_PROTOCOL_VERSION, "v1");
  assert.equal(CLAIM_DECLARATION_TAG, "[auto-sweep-claim");
  assert.equal(CLAIM_HEARTBEAT_TAG, "[auto-sweep-heartbeat");
  assert.equal(CLAIM_CLOSE_TAG, "[auto-sweep-claim-close");
  assert.equal(CLAIM_RESET_TAG, "[auto-sweep-claim-reset");
  assert.equal(declaration, "[auto-sweep-claim v1 claim=dev:in-progress owner=owner-a declaration=decl-a]");
  assert.equal(heartbeat, `[auto-sweep-heartbeat v1 claim=dev:in-progress declaration=decl-a at=${iso(1)}]`);
  assert.equal(close, "[auto-sweep-claim-close v1 claim=dev:in-progress declaration=decl-a reason=released]");
  assert.equal(reset, "[auto-sweep-claim-reset v1 claim=dev:in-progress target=decl-a reason=orphan-declaration]");
  assert.deepEqual(parseClaimMarker(comment("c1", declaration, 0)), {
    type: "declaration", claim: "dev:in-progress", ownerToken: "owner-a", declarationId: "decl-a",
    commentId: "c1", createdAt: iso(0),
  });
  assert.equal(parseClaimMarker(comment("c2", "ordinary comment", 0)), null);
});

test("marker builders reject whitespace, invalid timestamps, and unsupported reasons", () => {
  assert.throws(() => claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner a", declarationId: "decl-a" }), /ownerToken/);
  assert.throws(() => claimHeartbeatMarker({ claim: "dev:in-progress", declarationId: "decl-a", at: "yesterday" }), /at/);
  assert.throws(() => claimHeartbeatMarker({ claim: "dev:in-progress", declarationId: "decl-a", at: "1" }), /at/);
  assert.throws(() => claimCloseMarker({ claim: "dev:in-progress", declarationId: "decl-a", reason: "other" }), /reason/);
  assert.throws(() => claimResetMarker({ claim: "dev:in-progress", target: "decl-a", reason: "legacy" }), /target/);
});

test("first declaration owns the epoch and later declarations never promote", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-a", declarationId: "decl-a" }), 0),
    comment("c2", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-b", declarationId: "decl-b" }), 1),
    comment("c3", claimCloseMarker({ claim: "dev:in-progress", declarationId: "decl-a", reason: "released" }), 2),
  ];
  assert.deepEqual(resolveClaimOwnership({ comments, complete: true, claim: "dev:in-progress", labelPresent: false }), {
    status: "closed", reason: "epoch-closed", boundaryCommentId: "c3", boundaryCreatedAt: iso(2),
  });
});

test("a delayed heartbeat for a closed declaration cannot affect the next epoch", () => {
  const result = resolveClaimOwnership({ comments: [
    comment("c1", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "old", declarationId: "old-decl" }), 0),
    comment("c2", claimCloseMarker({ claim: "qa:in-progress", declarationId: "old-decl", reason: "reaped" }), 1),
    comment("c3", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "new", declarationId: "new-decl" }), 2),
    comment("c4", claimHeartbeatMarker({ claim: "qa:in-progress", declarationId: "old-decl", at: iso(3) }), 3),
  ], complete: true, claim: "qa:in-progress", labelPresent: true });
  assert.equal(result.ownerToken, "new");
  assert.equal(result.declarationId, "new-decl");
  assert.equal(result.livenessAt, iso(2));
});

test("createdAt then id ordering deterministically chooses the winner", () => {
  const at = iso(0);
  const comments = [
    { id: "c-b", body: claimDeclarationMarker({ claim: "spec:in-progress", ownerToken: "owner-b", declarationId: "decl-b" }), createdAt: at },
    { id: "c-a", body: claimDeclarationMarker({ claim: "spec:in-progress", ownerToken: "owner-a", declarationId: "decl-a" }), createdAt: at },
  ];
  const result = resolveClaimOwnership({ comments, complete: true, claim: "spec:in-progress", labelPresent: true });
  assert.equal(result.ownerToken, "owner-a");
  assert.equal(result.declarationId, "decl-a");
  assert.ok(Object.isFrozen(result));
});

test("only matching heartbeats extend active-declaration liveness", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "winner", declarationId: "winner-decl" }), 0),
    comment("c2", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "loser", declarationId: "loser-decl" }), 1),
    comment("c3", claimHeartbeatMarker({ claim: "qa:in-progress", declarationId: "unknown", at: iso(8) }), 2),
    comment("c4", claimHeartbeatMarker({ claim: "qa:in-progress", declarationId: "loser-decl", at: iso(9) }), 3),
    comment("c5", claimHeartbeatMarker({ claim: "qa:in-progress", declarationId: "winner-decl", at: iso(4) }), 4),
  ];
  assert.deepEqual(resolveClaimOwnership({ comments, complete: true, claim: "qa:in-progress", labelPresent: true }), {
    status: "owned", reason: "active-declaration", ownerToken: "winner", declarationId: "winner-decl",
    declaredAt: iso(0), heartbeatAt: iso(4), livenessAt: iso(4),
  });
});

test("a matching heartbeat timestamp before declaration cannot reduce liveness", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner", declarationId: "decl" }), 5),
    comment("c2", claimHeartbeatMarker({ claim: "qa:in-progress", declarationId: "decl", at: iso(1) }), 6),
  ];
  const result = resolveClaimOwnership({ comments, complete: true, claim: "qa:in-progress", labelPresent: true });
  assert.equal(result.heartbeatAt, null);
  assert.equal(result.livenessAt, iso(5));
});

test("a later matching heartbeat comment cannot replace a newer accepted timestamp", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner", declarationId: "decl" }), 0),
    comment("c2", claimHeartbeatMarker({ claim: "qa:in-progress", declarationId: "decl", at: iso(10) }), 1),
    comment("c3", claimHeartbeatMarker({ claim: "qa:in-progress", declarationId: "decl", at: iso(5) }), 2),
  ];
  const result = resolveClaimOwnership({ comments, complete: true, claim: "qa:in-progress", labelPresent: true });
  assert.equal(result.heartbeatAt, iso(10));
  assert.equal(result.livenessAt, iso(10));
});

for (const reason of ["released", "reaped", "orphaned", "terminal", "blocked", "failed"]) {
  test(`close reason ${reason} closes the winning epoch`, () => {
    const comments = [
      comment("c1", claimDeclarationMarker({ claim: "ship:in-progress", ownerToken: "owner", declarationId: "decl" }), 0),
      comment("c2", claimCloseMarker({ claim: "ship:in-progress", declarationId: "decl", reason }), 1),
    ];
    assert.deepEqual(resolveClaimOwnership({ comments, complete: true, claim: "ship:in-progress", labelPresent: false }), {
      status: "closed", reason: "epoch-closed", boundaryCommentId: "c2", boundaryCreatedAt: iso(1),
    });
  });
}

test("an exact orphan reset closes the epoch and permits a new declaration", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "old", declarationId: "old-decl" }), 0),
    comment("c2", claimResetMarker({ claim: "dev:in-progress", target: "old-decl", reason: "orphan-declaration" }), 1),
    comment("c3", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "new", declarationId: "new-decl" }), 2),
  ];
  assert.equal(resolveClaimOwnership({ comments, complete: true, claim: "dev:in-progress", labelPresent: true }).ownerToken, "new");
});

test("a legacy reset is a boundary before the first declaration", () => {
  const comments = [
    comment("c1", "[auto-sweep-heartbeat 2026-07-10T00:00:00.000Z owner=legacy claim=dev:in-progress]", 0),
    comment("c2", claimResetMarker({ claim: "dev:in-progress", target: "legacy", reason: "legacy" }), 1),
  ];
  assert.deepEqual(resolveClaimOwnership({ comments, complete: true, claim: "dev:in-progress", labelPresent: false }), {
    status: "closed", reason: "epoch-closed", boundaryCommentId: "c2", boundaryCreatedAt: iso(1),
  });
});

test("duplicate and delayed closes for an already-closed winner are no-ops", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "old", declarationId: "old-decl" }), 0),
    comment("c2", claimCloseMarker({ claim: "qa:in-progress", declarationId: "old-decl", reason: "released" }), 1),
    comment("c3", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "new", declarationId: "new-decl" }), 2),
    comment("c4", claimCloseMarker({ claim: "qa:in-progress", declarationId: "old-decl", reason: "failed" }), 3),
  ];
  assert.equal(resolveClaimOwnership({ comments, complete: true, claim: "qa:in-progress", labelPresent: true }).declarationId, "new-decl");
});

test("a delayed duplicate close does not change the authoritative boundary time", () => {
  const result = resolveClaimOwnership({ comments: [
    comment("c1", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner", declarationId: "decl" }), 0),
    comment("c2", claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl", reason: "released" }), 1),
    comment("c3", claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl", reason: "failed" }), 30),
  ], complete: true, claim: "qa:in-progress", labelPresent: true });
  assert.equal(result.boundaryCommentId, "c2");
  assert.equal(result.boundaryCreatedAt, iso(1));
});

test("duplicate and delayed resets for an already-reset target are no-ops", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "old", declarationId: "old-decl" }), 0),
    comment("c2", claimResetMarker({ claim: "qa:in-progress", target: "old-decl", reason: "orphan-declaration" }), 1),
    comment("c3", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "new", declarationId: "new-decl" }), 2),
    comment("c4", claimResetMarker({ claim: "qa:in-progress", target: "old-decl", reason: "orphan-declaration" }), 3),
  ];
  assert.equal(resolveClaimOwnership({ comments, complete: true, claim: "qa:in-progress", labelPresent: true }).declarationId, "new-decl");
});

test("a delayed duplicate reset does not change the authoritative boundary time", () => {
  const result = resolveClaimOwnership({ comments: [
    comment("c1", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner", declarationId: "decl" }), 0),
    comment("c2", claimResetMarker({ claim: "qa:in-progress", target: "decl", reason: "orphan-declaration" }), 1),
    comment("c3", claimResetMarker({ claim: "qa:in-progress", target: "decl", reason: "orphan-declaration" }), 30),
  ], complete: true, claim: "qa:in-progress", labelPresent: true });
  assert.equal(result.boundaryCommentId, "c2");
  assert.equal(result.boundaryCreatedAt, iso(1));
});

test("a delayed reset for an exactly closed winner is a no-op", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "old", declarationId: "old-decl" }), 0),
    comment("c2", claimCloseMarker({ claim: "qa:in-progress", declarationId: "old-decl", reason: "released" }), 1),
    comment("c3", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "new", declarationId: "new-decl" }), 2),
    comment("c4", claimResetMarker({ claim: "qa:in-progress", target: "old-decl", reason: "orphan-declaration" }), 3),
  ];
  assert.equal(resolveClaimOwnership({ comments, complete: true, claim: "qa:in-progress", labelPresent: true }).declarationId, "new-decl");
});

test("markers for other stages are isolated", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "dev-owner", declarationId: "dev-decl" }), 0),
    comment("c2", claimCloseMarker({ claim: "dev:in-progress", declarationId: "dev-decl", reason: "terminal" }), 1),
    comment("c3", claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "qa-owner", declarationId: "qa-decl" }), 2),
  ];
  assert.equal(resolveClaimOwnership({ comments, complete: true, claim: "qa:in-progress", labelPresent: true }).ownerToken, "qa-owner");
});

test("label and declaration mismatches fail closed without inventing ownership", () => {
  assert.deepEqual(resolveClaimOwnership({ comments: [], complete: true, claim: "dev:in-progress", labelPresent: true }), {
    status: "legacy-unowned", reason: "label-without-declaration",
  });
  const comments = [comment("c1", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }), 0)];
  assert.equal(resolveClaimOwnership({ comments, complete: true, claim: "dev:in-progress", labelPresent: false }).status, "orphan-declaration");
  assert.deepEqual(resolveClaimOwnership({ comments: [], complete: true, claim: "dev:in-progress", labelPresent: false }), {
    status: "unclaimed", reason: "no-claim",
  });
});

test("incomplete input is ambiguous", () => {
  assert.deepEqual(resolveClaimOwnership({ comments: [], complete: false, claim: "dev:in-progress", labelPresent: false }), {
    status: "ambiguous", reason: "incomplete-comments",
  });
  assert.deepEqual(resolveClaimOwnership({ complete: true, claim: "dev:in-progress", labelPresent: false }), {
    status: "ambiguous", reason: "incomplete-comments",
  });
});

test("malformed relevant markers and unreadable timestamps are ambiguous", () => {
  const malformed = [comment("c1", "[auto-sweep-claim v1 claim=dev:in-progress owner=owner]", 0)];
  assert.equal(resolveClaimOwnership({ comments: malformed, complete: true, claim: "dev:in-progress", labelPresent: true }).reason, "malformed-marker");
  const unreadableCreatedAt = [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: "never" }];
  assert.equal(resolveClaimOwnership({ comments: unreadableCreatedAt, complete: true, claim: "dev:in-progress", labelPresent: true }).reason, "unreadable-timestamp");
  const unreadableHeartbeat = [comment("c1", "[auto-sweep-heartbeat v1 claim=dev:in-progress declaration=decl at=never]", 0)];
  assert.equal(resolveClaimOwnership({ comments: unreadableHeartbeat, complete: true, claim: "dev:in-progress", labelPresent: true }).reason, "unreadable-timestamp");
});

test("conflicting duplicate declaration IDs are ambiguous", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-a", declarationId: "same" }), 0),
    comment("c2", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-b", declarationId: "same" }), 1),
  ];
  assert.equal(resolveClaimOwnership({ comments, complete: true, claim: "dev:in-progress", labelPresent: true }).reason, "conflicting-declaration-id");
});

test("unknown and losing close references are ambiguous", () => {
  const unknown = [comment("c1", claimCloseMarker({ claim: "dev:in-progress", declarationId: "unknown", reason: "released" }), 0)];
  assert.equal(resolveClaimOwnership({ comments: unknown, complete: true, claim: "dev:in-progress", labelPresent: false }).reason, "invalid-close-target");
  const losing = [
    comment("c1", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "winner", declarationId: "winner" }), 0),
    comment("c2", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "loser", declarationId: "loser" }), 1),
    comment("c3", claimCloseMarker({ claim: "dev:in-progress", declarationId: "loser", reason: "released" }), 2),
  ];
  assert.equal(resolveClaimOwnership({ comments: losing, complete: true, claim: "dev:in-progress", labelPresent: true }).reason, "invalid-close-target");
});

test("invalid reset targets are ambiguous", () => {
  const comments = [
    comment("c1", claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "winner", declarationId: "winner" }), 0),
    comment("c2", claimResetMarker({ claim: "dev:in-progress", target: "unknown", reason: "orphan-declaration" }), 1),
  ];
  assert.equal(resolveClaimOwnership({ comments, complete: true, claim: "dev:in-progress", labelPresent: false }).reason, "invalid-reset-target");
});

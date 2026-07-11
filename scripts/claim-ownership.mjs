export const CLAIM_PROTOCOL_VERSION = "v1";
export const CLAIM_DECLARATION_TAG = "[auto-sweep-claim";
export const CLAIM_HEARTBEAT_TAG = "[auto-sweep-heartbeat";
export const CLAIM_CLOSE_TAG = "[auto-sweep-claim-close";
export const CLAIM_RESET_TAG = "[auto-sweep-claim-reset";

const CLOSE_REASONS = new Set(["released", "reaped", "orphaned", "terminal", "blocked", "failed"]);
const TOKEN_PATTERN = "[^\\s\\[\\]]{1,256}";
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DECLARATION_RE = new RegExp(`^\\[auto-sweep-claim v1 claim=(${TOKEN_PATTERN}) owner=(${TOKEN_PATTERN}) declaration=(${TOKEN_PATTERN})\\]$`);
const HEARTBEAT_RE = new RegExp(`^\\[auto-sweep-heartbeat v1 claim=(${TOKEN_PATTERN}) declaration=(${TOKEN_PATTERN}) at=(${TOKEN_PATTERN})\\]$`);
const CLOSE_RE = new RegExp(`^\\[auto-sweep-claim-close v1 claim=(${TOKEN_PATTERN}) declaration=(${TOKEN_PATTERN}) reason=(${TOKEN_PATTERN})\\]$`);
const RESET_RE = new RegExp(`^\\[auto-sweep-claim-reset v1 claim=(${TOKEN_PATTERN}) target=(${TOKEN_PATTERN}) reason=(${TOKEN_PATTERN})\\]$`);

function frozen(value) {
  return Object.freeze(value);
}

function token(value, name) {
  if (typeof value !== "string" || !new RegExp(`^${TOKEN_PATTERN}$`).test(value)) {
    throw new TypeError(`${name} must be a nonempty whitespace-free token`);
  }
  return value;
}

function timestamp(value, name) {
  if (typeof value !== "string" || !ISO8601_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO8601 timestamp`);
  }
  return value;
}

export function claimDeclarationMarker({ claim, ownerToken, declarationId } = {}) {
  return `${CLAIM_DECLARATION_TAG} ${CLAIM_PROTOCOL_VERSION} claim=${token(claim, "claim")} owner=${token(ownerToken, "ownerToken")} declaration=${token(declarationId, "declarationId")}]`;
}

export function claimHeartbeatMarker({ claim, declarationId, at } = {}) {
  return `${CLAIM_HEARTBEAT_TAG} ${CLAIM_PROTOCOL_VERSION} claim=${token(claim, "claim")} declaration=${token(declarationId, "declarationId")} at=${timestamp(at, "at")}]`;
}

export function claimCloseMarker({ claim, declarationId, reason } = {}) {
  token(reason, "reason");
  if (!CLOSE_REASONS.has(reason)) throw new TypeError("reason must be a supported claim close reason");
  return `${CLAIM_CLOSE_TAG} ${CLAIM_PROTOCOL_VERSION} claim=${token(claim, "claim")} declaration=${token(declarationId, "declarationId")} reason=${reason}]`;
}

export function claimResetMarker({ claim, target, reason } = {}) {
  token(reason, "reason");
  token(target, "target");
  if (reason === "legacy" && target !== "legacy") throw new TypeError("target must be legacy for a legacy reset");
  if (reason === "orphan-declaration" && target === "legacy") throw new TypeError("target must be a declaration for an orphan reset");
  if (reason !== "legacy" && reason !== "orphan-declaration") throw new TypeError("reason must be a supported claim reset reason");
  return `${CLAIM_RESET_TAG} ${CLAIM_PROTOCOL_VERSION} claim=${token(claim, "claim")} target=${target} reason=${reason}]`;
}

function malformed(comment, claim, reason = "malformed-marker") {
  return frozen({ type: "malformed", claim, reason, commentId: comment?.id });
}

function markerClaim(body) {
  return /(?:^|\s)claim=([^\s\[\]]+)/.exec(body)?.[1];
}

function validCommentMetadata(comment) {
  return comment && typeof comment.id === "string" && comment.id.length > 0
    && typeof comment.createdAt === "string" && ISO8601_RE.test(comment.createdAt)
    && Number.isFinite(Date.parse(comment.createdAt));
}

export function parseClaimMarker(comment) {
  if (!comment || typeof comment.body !== "string") return null;
  const body = comment.body;
  let match;
  let type;

  if (body.startsWith(`${CLAIM_CLOSE_TAG} `)) {
    type = "close";
    match = CLOSE_RE.exec(body);
  } else if (body.startsWith(`${CLAIM_RESET_TAG} `)) {
    type = "reset";
    match = RESET_RE.exec(body);
  } else if (body.startsWith(`${CLAIM_HEARTBEAT_TAG} ${CLAIM_PROTOCOL_VERSION}`)) {
    type = "heartbeat";
    match = HEARTBEAT_RE.exec(body);
  } else if (body.startsWith(`${CLAIM_HEARTBEAT_TAG} `)) {
    // Pre-v1 heartbeat comments are migration evidence, never ownership events.
    return null;
  } else if (body.startsWith(`${CLAIM_DECLARATION_TAG} `)) {
    type = "declaration";
    match = DECLARATION_RE.exec(body);
  } else {
    return null;
  }

  if (!match) return malformed(comment, markerClaim(body));
  if (!validCommentMetadata(comment)) return malformed(comment, match[1], "unreadable-timestamp");

  const base = { type, claim: match[1] };
  if (type === "declaration") Object.assign(base, { ownerToken: match[2], declarationId: match[3] });
  if (type === "heartbeat") {
    if (!ISO8601_RE.test(match[3]) || !Number.isFinite(Date.parse(match[3]))) {
      return malformed(comment, match[1], "unreadable-timestamp");
    }
    Object.assign(base, { declarationId: match[2], at: match[3] });
  }
  if (type === "close") {
    if (!CLOSE_REASONS.has(match[3])) return malformed(comment, match[1]);
    Object.assign(base, { declarationId: match[2], reason: match[3] });
  }
  if (type === "reset") {
    const validReset = (match[3] === "legacy" && match[2] === "legacy")
      || (match[3] === "orphan-declaration" && match[2] !== "legacy");
    if (!validReset) return malformed(comment, match[1]);
    Object.assign(base, { target: match[2], reason: match[3] });
  }
  Object.assign(base, { commentId: comment.id, createdAt: comment.createdAt });
  return frozen(base);
}

function ambiguous(reason) {
  return frozen({ status: "ambiguous", reason });
}

function parseAndSortRelevant(comments, claim) {
  const value = [];
  for (const comment of comments) {
    const event = parseClaimMarker(comment);
    if (!event) continue;
    if (event.type === "malformed") {
      if (event.claim === undefined || event.claim === claim) return { error: event.reason };
      continue;
    }
    if (event.claim === claim) value.push(event);
  }
  value.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    || (a.commentId < b.commentId ? -1 : a.commentId > b.commentId ? 1 : 0));
  return { value };
}

function foldEpoch(events) {
  let declaration = null;
  let boundary = null;
  let heartbeatAt = null;
  let legacyReset = false;
  const declarations = new Map();
  const closedWinners = new Set();

  for (const event of events) {
    if (event.type === "declaration") {
      const existing = declarations.get(event.declarationId);
      if (existing) {
        if (existing.ownerToken !== event.ownerToken || existing.claim !== event.claim) {
          return { error: "conflicting-declaration-id" };
        }
        continue;
      }
      declarations.set(event.declarationId, event);
      if (!declaration) {
        declaration = event;
        heartbeatAt = null;
      }
      continue;
    }

    if (event.type === "heartbeat") {
      if (declaration?.declarationId === event.declarationId) {
        const livenessAt = heartbeatAt ?? declaration.createdAt;
        if (Date.parse(event.at) > Date.parse(livenessAt)) heartbeatAt = event.at;
      }
      continue;
    }

    if (event.type === "close") {
      if (closedWinners.has(event.declarationId)) continue;
      if (declaration?.declarationId !== event.declarationId) return { error: "invalid-close-target" };
      closedWinners.add(event.declarationId);
      declaration = null;
      heartbeatAt = null;
      boundary = event;
      continue;
    }

    if (event.target === "legacy") {
      if (legacyReset) continue;
      if (declaration) return { error: "invalid-reset-target" };
      legacyReset = true;
      boundary = event;
      continue;
    }

    if (closedWinners.has(event.target)) continue;
    if (declaration?.declarationId !== event.target) return { error: "invalid-reset-target" };
    closedWinners.add(event.target);
    declaration = null;
    heartbeatAt = null;
    boundary = event;
  }

  return { declaration, boundary, heartbeatAt };
}

export function resolveClaimOwnership({ comments, complete, claim, labelPresent } = {}) {
  if (complete !== true || !Array.isArray(comments)) return ambiguous("incomplete-comments");
  const events = parseAndSortRelevant(comments, claim);
  if (events.error) return ambiguous(events.error);
  const epoch = foldEpoch(events.value);
  if (epoch.error) return ambiguous(epoch.error);
  if (!epoch.declaration) {
    const boundary = epoch.boundary ? {
      boundaryCommentId: epoch.boundary.commentId,
      boundaryCreatedAt: epoch.boundary.createdAt,
    } : {};
    if (labelPresent) return frozen({ status: "legacy-unowned", reason: "label-without-declaration", ...boundary });
    if (epoch.boundary) return frozen({ status: "closed", reason: "epoch-closed", ...boundary });
    return frozen({ status: "unclaimed", reason: "no-claim" });
  }

  const identity = {
    ownerToken: epoch.declaration.ownerToken,
    declarationId: epoch.declaration.declarationId,
    declaredAt: epoch.declaration.createdAt,
  };
  if (!labelPresent) return frozen({ status: "orphan-declaration", reason: "declaration-without-label", ...identity });
  return frozen({
    status: "owned",
    reason: "active-declaration",
    ...identity,
    heartbeatAt: epoch.heartbeatAt,
    livenessAt: epoch.heartbeatAt ?? epoch.declaration.createdAt,
  });
}

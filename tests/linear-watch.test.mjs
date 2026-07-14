// Unit tests for the auto-sweep launcher's pure decision logic (node:test, zero-dep).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnProcess, spawnSync as spawnProcessSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dependencyEligibility } from "../scripts/linear.mjs";
import { aggregateLearningFindings, buildLearningEvidenceSnapshot } from "../scripts/learning.mjs";
import { claimCloseMarker, claimDeclarationMarker, claimHeartbeatMarker, claimResetMarker, resolveClaimOwnership } from "../scripts/claim-ownership.mjs";
import * as watchModule from "../scripts/linear-watch.mjs";
import {
  resolveRepos, resolveWorkspaceRepos, workspaceRepoPairs, resolveCardRepoRoute, routeCardsByRepo, managedWorkspaceRootFor, workspaceRecordForSourceAnchor,
  normalizeRegistry, materializeManagedWorkspacePlan, materializeManagedWorkspace, syncAllowedEnvFiles,
  recoveredTargetsForManagedWorkspace, handoffDirtyCheckoutFailures, handoffRepoRoutingDecision,
  dirtyCheckoutEvent, doctorReport, formatDoctorReport,
  worktreePath, runtimeConfigForSweep, fallbackRuntimeConfigForSweep, resolveRuntimeExecutable, preflightRuntimeCandidates, buildCommand, lockIsReclaimable, isNewerVersion,
  heartbeatAgeMin, countMarkers, reapDecisions, bounceDecisions, bouncePairKey,
  countActionable, actionableCards, applyDecisionsInMemory,
  annotateBoundedDependencyCycles, dependencyCycleFailureEvents,
  boardOrderValue, sortByBoardPosition, selectDispatch, selectDispatchBatch, preflightAndSelectDispatchBatch, rotateNonShipCandidates,
  compareAdmissionDemand, createCapacityLedger, createAdmissionQueue, createObservationStore, createResourceSampler, dependencyDeferredIssue, admitDemand,
  withCapacityLedgerMutationLock, shouldStartPostDeliveryLearning,
  dispatchLearningAsync,
  runAdmissionDemands,
  parallelLimit, sameRepoCardLimit, selectCardSlots, ownerToken, declarationToken,
  drainPassLimit, runDrainLoop, maxSameRepoRefillDispatches, maxHandoffTriggerHops, nextSweepForHandoff, handoffTriggerKey,
  retryCooldown, claimConfirmed, cardWorktreePath, cardRunPaths, withCardDispatchEnv,
  buildLauncherEvidenceRunRecord, appendLauncherEvidenceRun, trustedLauncherSourceRepoEntry, recordConfirmedReapEvidence, recordConfirmedOrphanEvidence,
  dryRunDispatchMessages, createChildIndexAllocator, createSameRepoActiveCounts,
  sameRepoAvailableSlots, claimCardSlots, expandDispatchBatch, buildSameRepoRefillDispatches, classifyDispatchOutcome, runtimeDisabledByOutcome, isCodexUsageExhaustedEvent, createCodexUsageEvidenceCollector, createClaudeUsageEvidenceCollector, isFinalProviderUsageExhaustion, shouldClearRuntimeCooldown, createDispatchAbortContext, dispatchAsync, dispatchBatch, parseEnv, pushWithRetry, checkoutDispatchBlockers,
  admissionDemandsForCandidates,
  fetchCompleteClaimComments, withCompleteClaimHistory, normalizeRelationUnknownCard,
  fetchScheduledPassCards, fetchScheduledQueueCards, fetchClaimMigrationCards, fetchCompleteMigrationCard, claimMigrationStatusReport, resetClaimMigration,
  rediscoveredResumeRecordForCard, completeRecentIssueComments,
  SWEEP_CFG, DEFAULT_MAX_NON_SHIP_DISPATCHES, DEFAULT_MAX_DRAIN_PASSES, MAX_DRAIN_PASSES,
  DEFAULT_MAX_ACTIVE_CHILDREN, MAX_ACTIVE_CHILDREN,
  OBSERVATION_STATE_VERSION, OBSERVATION_RETENTION_MS, MAX_DEPENDENCY_DEFERRED_ISSUES,
  RESUME_STATE_VERSION,
  DEFAULT_MAX_SAME_REPO_REFILL_DISPATCHES, MAX_SAME_REPO_REFILL_DISPATCHES,
  DEFAULT_SAME_REPO_CARD_LIMITS, SAME_REPO_PORT_BASE,
  foreignClaimReleases, SWEEPS, SWEEP_ORDER, SKILL_DIRS, HOLDING_STATES,
  LEGACY_CLEANUP_STATES, CLAIM_CLEANUP_STATES, MAX_STALE_MIN,
  REAPER_TAG, BOUNCE_TAG, HEARTBEAT_TAG, RETRY_TAG, ORPHAN_TAG,
  BLOCKING_LABELS, MANUAL_SKILL_DIRS, PROPAGATED_SKILL_DIRS,
  UNBLOCK_STATE_ORDER, orderUnblockCards,
  blockingLabelsForIssue, normalizeBlockedIssue, labelIdsAfterRemoving,
  claimMigrationSummary,
  buildUnblockAuditComment, resolutionTextFromArgs, resolveBlockedIssue,
  FAILURE_TODO_TAG, failureFingerprint, sanitizeFailureMessage,
  failureTodoTitle, failureTodoBody, failureTodoDecisions, reconcileFailureTodos, healthStatus, atomicWriteJson, finalizeTickState,
  rotateLearningRunIndexes,
  rotateLearningEventFiles,
  buildLearningDemand, buildLearningSynthesisCommand, learningChildEnvironment,
  filterLearningFindingsForRun,
  resolveRegisteredLearningWorkspaces, readLearningRunIndex, runPostDeliveryLearning,
  fetchLearningIssueComments, fetchLearningIssues, learningRelationExists, executeLearningMutations, executeLearningEvaluations,
  executeLearningCycleWrites,
  buildLiveLearningDryRunPlan, learningRunExecutionDecision,
  createResumeStore, createRuntimeCooldownStore, selectRuntimeForCooldown, resumeResolutionNoticeNeeded,
  successfulSameStateRecoveryDecision, resumeAdmissionDecision, closeOwnedClaim,
  classifyCapacityOutcome, capacityRetryAt, generatedArtifactCleanupTargets,
} from "../scripts/linear-watch.mjs";

const claimIso = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}.000Z`;
const completeUnclaimedCard = (card) => ({ ...card, commentsComplete: true, comments: [] });

function claimCommentPages(pages) {
  let call = 0;
  return async (_query, variables) => {
    const page = pages[call++];
    assert.equal(variables.cursor, call === 1 ? null : pages[call - 2].endCursor);
    return { issue: { comments: { nodes: page.nodes, pageInfo: {
      hasNextPage: page.hasNextPage,
      endCursor: page.endCursor,
    } } } };
  };
}

test("fetchCompleteClaimComments paginates oldest-to-newest with ids", async () => {
  const comments = await fetchCompleteClaimComments("key", "issue", { gqlFn: claimCommentPages([
    { nodes: [{ id: "c2", body: "two", createdAt: claimIso(2) }], hasNextPage: true, endCursor: "p2" },
    { nodes: [{ id: "c1", body: "one", createdAt: claimIso(1) }], hasNextPage: false, endCursor: null },
  ]) });
  assert.deepEqual(comments.map(({ id }) => id), ["c1", "c2"]);
});

test("fetchCompleteClaimComments rejects cursor cycles and unreadable pages", async () => {
  const cyclic = claimCommentPages([
    { nodes: [], hasNextPage: true, endCursor: "same" },
    { nodes: [], hasNextPage: true, endCursor: "same" },
  ]);
  await assert.rejects(fetchCompleteClaimComments("key", "issue", { gqlFn: cyclic }), /pagination incomplete/);
  await assert.rejects(fetchCompleteClaimComments("key", "issue", {
    gqlFn: async () => ({ issue: { comments: { nodes: [] } } }),
  }), /comments unreadable/);
});

test("fetchCompleteClaimComments rejects malformed nodes and duplicate ids across pages", async () => {
  for (const node of [
    { id: "", body: "body", createdAt: claimIso(1) },
    { id: "c1", createdAt: claimIso(1) },
    { id: "c1", body: "body", createdAt: "not-a-date" },
  ]) {
    await assert.rejects(fetchCompleteClaimComments("key", "issue", {
      gqlFn: async () => ({ issue: { comments: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    }), /comments unreadable/);
  }
  await assert.rejects(fetchCompleteClaimComments("key", "issue", { gqlFn: claimCommentPages([
    { nodes: [{ id: "duplicate", body: "one", createdAt: claimIso(1) }], hasNextPage: true, endCursor: "next" },
    { nodes: [{ id: "duplicate", body: "two", createdAt: claimIso(2) }], hasNextPage: false, endCursor: null },
  ]) }), /duplicate comment id/);
});

test("scheduled snapshots are never complete ownership evidence", () => {
  const snapshotNode = {
    id: "issue", identifier: "COD-169", updatedAt: claimIso(1), sortOrder: 1,
    state: { name: "Dev" }, labels: { nodes: [] }, comments: { nodes: [] },
  };
  const snapshot = normalizeRelationUnknownCard(snapshotNode);
  assert.equal(snapshot.commentsComplete, false);
  const hydrated = withCompleteClaimHistory(snapshot, [{ id: "c1", body: "one", createdAt: claimIso(1) }]);
  assert.equal(hydrated.commentsComplete, true);
  assert.equal(hydrated.comments[0].id, "c1");
});

test("scheduled claim history is hydrated only for cards carrying claim or retry material", async () => {
  const claimed = {
    id: "claimed", identifier: "COD-169", stateName: "Dev", labelNames: ["dev:in-progress"],
    comments: [], commentsComplete: false,
  };
  const plain = {
    id: "plain", identifier: "COD-170", stateName: "Dev", labelNames: [],
    comments: [], commentsComplete: false,
  };
  const retrying = {
    id: "retrying", identifier: "COD-148", stateName: "Dev", labelNames: [],
    comments: [{ id: "retry", body: `${RETRY_TAG} v1 claim=dev:in-progress owner=owner declaration=decl]`, createdAt: claimIso(1) }], commentsComplete: false,
  };
  const fetched = [];
  const result = await fetchScheduledPassCards("key", "COD", "project", ["Dev"], {
    fetchAdmissionFn: async () => new Map([["Dev", [claimed, plain, retrying]]]),
    fetchCompleteClaimCommentsFn: async (_apiKey, issueId) => {
      fetched.push(issueId);
      return [{ id: "c1", body: "history", createdAt: claimIso(1) }];
    },
  });
  assert.deepEqual(fetched, ["claimed", "retrying"]);
  assert.equal(result.admissionByState.get("Dev")[0].commentsComplete, true);
  assert.equal(result.cleanupByState.get("Dev")[0].commentsComplete, true);
  assert.equal(result.admissionByState.get("Dev")[1].commentsComplete, false);
  assert.equal(result.admissionByState.get("Dev")[2].commentsComplete, true);
});

function pipedDispatchChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = (signal) => { child.killCalls.push(signal); return true; };
  child.close = (exitCode, signal = null) => child.emit("close", exitCode, signal);
  return child;
}

function queuedDispatchSpawn(children, calls = []) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = children.shift();
    assert.ok(child, "spawn queue exhausted");
    return child;
  };
}
const NOW = Date.parse("2026-07-08T12:00:00Z");
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const dependencyReadyCard = (card = {}) => ({ blockers: [], blockersComplete: true, ...card });

test("resume store: persists only a valid exact record and protects its matching claim", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-store-"));
  const statePath = path.join(dir, "resume-needed.json");
  const now = Date.parse("2026-07-10T12:00:00Z");
  const store = createResumeStore({ resumePath: statePath, now: () => now });
  const record = store.upsert({ sourceWorkspace: "/managed", sweep: "dev", issueIdentifier: "SAF-210", issueId: "id-210", ownerToken: "owner-210", claimDeclarationId: "decl-210", worktreePath: "/managed/.worktrees/SAF-210", branch: "SAF-210", repoEntry: ".", reason: "dirty", nextEligibleAt: new Date(now).toISOString(), attempts: 0 });
  assert.equal(record.issueIdentifier, "SAF-210");
  assert.equal(store.due({ sourceWorkspace: "/managed", sweep: "dev", issueIdentifier: "SAF-210" }).ownerToken, "owner-210");
  assert.equal(store.protectedClaim({ identifier: "SAF-210", labelNames: ["dev:in-progress"], commentsComplete: true, comments: [
    { id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-210", declarationId: "decl-210" }), createdAt: claimIso(1) },
    { id: "c2", body: `${HEARTBEAT_TAG} ${new Date(now).toISOString()} owner=owner-210 claim=dev:in-progress]`, createdAt: claimIso(2) },
  ] }, SWEEP_CFG.dev, now).ownerToken, "owner-210");
  assert.equal(store.clear({ sourceWorkspace: "/managed", sweep: "dev", issueIdentifier: "SAF-210", ownerToken: "other" }), false);
  assert.equal(store.clear({ sourceWorkspace: "/managed", sweep: "dev", issueIdentifier: "SAF-210", ownerToken: "owner-210" }), false);
  assert.equal(store.clear({ sourceWorkspace: "/managed", sweep: "dev", issueIdentifier: "SAF-210", ownerToken: "owner-210", claimDeclarationId: "decl-210" }), true);
  const legacy = store.upsert({ sourceWorkspace: "/managed", sweep: "dev", issueIdentifier: "SAF-211", issueId: "id-211", ownerToken: "legacy-owner", worktreePath: "/managed/.worktrees/SAF-211", branch: "SAF-211", repoEntry: ".", reason: "legacy dirty", nextEligibleAt: new Date(now).toISOString(), attempts: 0 });
  assert.equal(legacy, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resume store: v2 requires declaration identity and v1 fails closed", () => {
  assert.equal(RESUME_STATE_VERSION, 2);
  const base = { sourceWorkspace: "/managed", sweep: "dev", issueIdentifier: "COD-169", issueId: "id", ownerToken: "owner", worktreePath: "/managed/.worktrees/COD-169", branch: "COD-169", repoEntry: ".", reason: "dirty", nextEligibleAt: new Date(NOW).toISOString(), attempts: 0 };
  const v1 = createResumeStore({ readJsonFn: () => ({ version: 1, entries: { legacy: { ...base, claimDeclarationId: "decl" } } }) });
  assert.deepEqual(v1.read(), { healthy: false, entries: {} });
  const missingDeclaration = createResumeStore({ readJsonFn: () => ({ version: 2, entries: { bad: base } }) });
  assert.deepEqual(missingDeclaration.read(), { healthy: false, entries: {} });
});

test("resume store: exact v2 rediscovery can replace an unreadable v1 store", () => {
  let persisted = null;
  const record = { sourceWorkspace: "/managed", sweep: "dev", issueIdentifier: "COD-169", issueId: "id", ownerToken: "owner", claimDeclarationId: "decl", worktreePath: "/managed/.worktrees/COD-169", branch: "COD-169", repoEntry: ".", reason: "rediscovered dirty worktree", nextEligibleAt: new Date(NOW).toISOString(), attempts: 0 };
  const store = createResumeStore({
    readJsonFn: () => persisted || { version: 1, entries: { legacy: { ...record, claimDeclarationId: undefined } } },
    writeJsonFn: (_path, value) => { persisted = value; },
    now: () => NOW,
  });
  assert.equal(store.get(record), null);
  assert.equal(store.upsert(record).claimDeclarationId, "decl");
  assert.equal(persisted.version, 2);
});

test("resume store: a valid rediscovery repairs malformed persisted state", () => {
  let persisted = { version: RESUME_STATE_VERSION, entries: { broken: { ownerToken: "partial" } } };
  const store = createResumeStore({ now: () => NOW, readJsonFn: () => persisted,
    writeJsonFn: (_path, value) => { persisted = value; } });
  const record = { sourceWorkspace: "/source/app", sweep: "dev", issueIdentifier: "COD-149", issueId: "issue-149",
    ownerToken: "owner-149", claimDeclarationId: "decl-149", worktreePath: "/managed/app/.worktrees/COD-149", branch: "COD-149", repoEntry: "app",
    reason: "rediscovered dirty worktree", nextEligibleAt: new Date(NOW).toISOString(), attempts: 0 };
  assert.equal(store.upsert(record)?.issueIdentifier, "COD-149");
  assert.equal(store.get(record)?.ownerToken, "owner-149");
});

test("same-state recovery: dirty and unpushed work preserves the claim, only clean pushed work releases", () => {
  const pick = { sweep: "dev", issueIdentifier: "SAF-210", ownerToken: "owner", claimDeclarationId: "decl", worktreePath: "/wt", branch: "SAF-210" };
  const card = { stateName: "Dev", labelNames: ["dev:in-progress"], commentsComplete: true, comments: [
    { id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: claimIso(1) },
  ] };
  const dirty = successfulSameStateRecoveryDecision(pick, card, { gitFn: (_cwd, args) => args[0] === "status" ? { status: 0, out: " M test.mjs\n?? new.test.mjs\n" } : { status: 0, out: "0" } });
  assert.equal(dirty.kind, "resume-needed");
  const unpushed = successfulSameStateRecoveryDecision(pick, card, { gitFn: (_cwd, args) => args[0] === "status" ? { status: 0, out: "" } : args[0] === "rev-list" ? { status: 0, out: "1" } : { status: 0, out: "ok" } });
  assert.equal(unpushed.kind, "resume-needed");
  const clean = successfulSameStateRecoveryDecision(pick, card, { existsFn: () => true, gitFn: (_cwd, args) => args[0] === "status" ? ({ status: 0, out: "" }) : args[0] === "rev-list" ? ({ status: 0, out: "0" }) : ({ status: 0, out: "ok" }) });
  assert.equal(clean.kind, "release");
});

test("resume admission: only an exact due claimed record can bypass ordinary dirty blocking", () => {
  const pick = { anchorPath: "/managed", config: { repos: ["."] }, sweep: "dev", issueIdentifier: "SAF-210", issueId: "id", ownerToken: "owner", claimDeclarationId: "decl", worktreePath: "/managed/.worktrees/SAF-210", branch: "SAF-210", repoRoute: { repoEntry: ".", managedRepoPath: "/managed" } };
  const card = { ...pick, stateName: "Dev", labelNames: ["dev:in-progress"], commentsComplete: true, comments: [
    { id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: claimIso(1) },
  ] };
  const record = { sourceWorkspace: "/managed", sweep: "dev", issueIdentifier: "SAF-210", ownerToken: "owner", claimDeclarationId: "decl", worktreePath: pick.worktreePath, branch: "SAF-210", repoEntry: ".", nextEligibleAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), attempts: 0 };
  assert.equal(resumeAdmissionDecision(pick, card, record, NOW).kind, "resume");
  assert.equal(resumeAdmissionDecision({ ...pick, claimDeclarationId: undefined }, card, { ...record, claimDeclarationId: undefined }, NOW).kind, "preserve");
  assert.equal(resumeAdmissionDecision(pick, card, { ...record, ownerToken: "other" }, NOW).kind, "preserve");
  assert.equal(resumeAdmissionDecision({ ...pick, worktreePath: "/tmp/arbitrary", branch: "other" }, card,
    { ...record, worktreePath: "/tmp/arbitrary", branch: "other" }, NOW).kind, "preserve");
});

test("resume reaper protection expires and validates the deterministic tuple", () => {
  let persisted = null;
  const store = createResumeStore({ now: () => NOW, readJsonFn: () => persisted,
    writeJsonFn: (_path, value) => { persisted = value; } });
  const record = { sourceWorkspace: "/source/app", sweep: "dev", issueIdentifier: "COD-149", issueId: "issue-149",
    ownerToken: "owner-149", claimDeclarationId: "decl-149", worktreePath: "/managed/app/.worktrees/COD-149", branch: "COD-149", repoEntry: "app",
    reason: "dirty", nextEligibleAt: new Date(NOW).toISOString(), attempts: 0 };
  store.upsert(record);
  const card = { identifier: "COD-149", labelNames: ["dev:in-progress"], commentsComplete: true,
    comments: [{ id: "decl", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-149", declarationId: "decl-149" }), createdAt: minsAgo(100) }] };
  assert.ok(store.protectedClaim(card, SWEEP_CFG.dev, NOW, { validateRecord: () => true }));
  assert.equal(store.protectedClaim(card, SWEEP_CFG.dev, NOW + 25 * 3600000,
    { validateRecord: () => true }).protectionState, "needs-resolution");
  assert.equal(store.protectedClaim(card, SWEEP_CFG.dev, NOW,
    { validateRecord: () => false }).protectionState, "needs-resolution");
  const decisions = reapDecisions([{ ...card, id: "issue-149", updatedAt: minsAgo(100) }], SWEEP_CFG.dev,
    NOW + 25 * 3600000, { protectedClaim: (candidate) => store.protectedClaim(candidate, SWEEP_CFG.dev,
      NOW + 25 * 3600000, { validateRecord: () => false }) });
  assert.deepEqual(decisions.map((decision) => decision.action), ["protect-resume"]);
  assert.equal(decisions[0].protectionState, "needs-resolution");
});

test("resume resolution notices are declaration-scoped and deduplicated", () => {
  const decision = { ownerToken: "owner-149", claimDeclarationId: "decl-149" };
  const card = { comments: [] };
  assert.equal(resumeResolutionNoticeNeeded(card, SWEEP_CFG.dev, decision), true);
  card.comments.push({ body: "[auto-sweep-resume-resolution v1 claim=dev:in-progress owner=owner-149 declaration=decl-149]" });
  assert.equal(resumeResolutionNoticeNeeded(card, SWEEP_CFG.dev, decision), false);
  assert.equal(resumeResolutionNoticeNeeded(card, SWEEP_CFG.dev, { ...decision, claimDeclarationId: "decl-150" }), true);
});

test("resume rediscovery: routed cards preserve their routed worktree and repo identity", () => {
  const card = {
    id: "issue-210", identifier: "SAF-210", stateName: "Dev", labelNames: ["dev:in-progress"],
    commentsComplete: true,
    comments: [{ id: "decl", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-210", declarationId: "decl-210" }), createdAt: minsAgo(1) }],
    repoRoute: { ok: true, repoEntry: "safetaper-guide", managedRepoPath: "/managed/guide" },
  };
  const record = rediscoveredResumeRecordForCard({
    sourceWorkspace: "/source/coach", anchorPath: "/managed/coach", sweep: "dev", card,
  }, NOW);
  assert.equal(record.repoEntry, "safetaper-guide");
  assert.equal(record.worktreePath, "/managed/guide/.worktrees/SAF-210");
  assert.equal(record.ownerToken, "owner-210");
  assert.equal(record.claimDeclarationId, "decl-210");
});

test("capacity outcome: recognized quota failures defer with bounded retry and configured fallback", () => {
  assert.equal(classifyCapacityOutcome({ kind: "exit" }, "Error: model capacity exceeded"), "model-capacity");
  assert.equal(classifyCapacityOutcome({ kind: "exit" }, "429 quota exceeded"), "quota");
  assert.equal(classifyCapacityOutcome({ kind: "exit" }, "syntax error"), null);
  assert.equal(capacityRetryAt(NOW, 0), NOW + 60_000);
  assert.equal(capacityRetryAt(NOW, 99), NOW + 60 * 60_000);
});

test("runtime cooldown store: persists one-hour provider exhaustion and clears on success", () => {
  let raw = null;
  let now = NOW;
  const store = createRuntimeCooldownStore({
    cooldownPath: "/state/runtime-cooldowns.json",
    now: () => now,
    readJsonFn: () => raw,
    writeJsonFn: (_path, value) => { raw = structuredClone(value); },
  });
  const marked = store.markExhausted({ host: "runner", runtime: "codex" });
  assert.equal(Date.parse(marked.cooldownUntil), NOW + 60 * 60_000);
  assert.equal(store.get({ host: "runner", runtime: "codex" }).reason, "usage-exhausted");

  now += 30 * 60_000;
  assert.equal(store.status({ host: "runner", runtime: "codex" }).kind, "cooling");
  now += 31 * 60_000;
  assert.equal(store.status({ host: "runner", runtime: "codex" }).kind, "probe-due");
  assert.equal(store.clear({ host: "runner", runtime: "codex" }), true);
  assert.equal(store.status({ host: "runner", runtime: "codex" }).kind, "ready");
});

test("runtime cooldown routing: skips a cooling primary and quietly defers when both providers cool", () => {
  let raw = null;
  const store = createRuntimeCooldownStore({
    now: () => NOW,
    readJsonFn: () => raw,
    writeJsonFn: (_path, value) => { raw = structuredClone(value); },
  });
  const config = { runtimes: { dev: {
    runtime: "codex", model: "gpt-5.6-terra",
    fallback: { runtime: "claude", model: "claude-sonnet-5" },
  } } };
  store.markExhausted({ host: "runner", runtime: "codex" });
  assert.equal(selectRuntimeForCooldown(config, "dev", { store, host: "runner" }).runtimeConfig.runtime, "claude");
  store.markExhausted({ host: "runner", runtime: "claude" });
  const deferred = selectRuntimeForCooldown(config, "dev", { store, host: "runner" });
  assert.equal(deferred.runtimeConfig, null);
  assert.equal(deferred.deferredUntil, new Date(NOW + 60 * 60_000).toISOString());
});

test("runtime cooldown routing: admits only one probe for an expired runtime", () => {
  let raw = null;
  let now = NOW;
  const store = createRuntimeCooldownStore({ now: () => now, readJsonFn: () => raw, writeJsonFn: (_path, value) => { raw = structuredClone(value); } });
  const config = { runtimes: { dev: { runtime: "codex", model: "gpt", fallback: { runtime: "claude", model: "claude" } } } };
  store.markExhausted({ host: "runner", runtime: "codex" });
  store.markExhausted({ host: "runner", runtime: "claude" });
  now += 60 * 60_000;
  const probes = new Set();
  assert.equal(selectRuntimeForCooldown(config, "dev", { store, host: "runner", probes }).runtimeConfig.runtime, "codex");
  assert.equal(selectRuntimeForCooldown(config, "dev", { store, host: "runner", probes }).runtimeConfig.runtime, "claude");
  assert.equal(selectRuntimeForCooldown(config, "dev", { store, host: "runner", probes }).runtimeConfig, null);
});

test("runtime cooldown routing: malformed persisted state fails closed", () => {
  const store = createRuntimeCooldownStore({ readJsonFn: () => ({ version: 1, entries: { bad: { runtime: "codex" } } }) });
  const selected = selectRuntimeForCooldown({ runtimes: { dev: { runtime: "codex" } } }, "dev", { store, host: "runner" });
  assert.equal(selected.runtimeConfig, null);
  assert.equal(selected.storeHealthy, false);
});

test("generated artifact cleanup: rejects repositories, worktrees, ancestors, and symlink escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-"));
  const repo = path.join(root, "repo"); const wt = path.join(repo, ".worktrees", "SAF-210"); const cache = path.join(root, "cache", "run", "tmp");
  fs.mkdirSync(wt, { recursive: true }); fs.mkdirSync(cache, { recursive: true });
  fs.symlinkSync(wt, path.join(root, "cache", "run", "escape"));
  const targets = generatedArtifactCleanupTargets({ tmpDir: cache, logDir: path.join(root, "logs"), screenshotDir: wt, browserProfileDir: path.join(root, "cache", "run", "escape"), worktreePath: wt, anchorPath: repo, managedRepoPaths: [repo] });
  assert.deepEqual(targets, [fs.realpathSync(cache)]);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── workspace resolution ─────────────────────────────────────────────────────
test("resolveRepos: folder names resolve as siblings under the anchor's parent", () => {
  const repos = resolveRepos("/ws/safetaper-admin", { repos: ["safetaper-admin", "safetaper-coach"] });
  assert.deepEqual(repos.map((r) => r.path), ["/ws/safetaper-admin", "/ws/safetaper-coach"]);
});
test("resolveRepos: absolute and ./ entries are used as-is", () => {
  const repos = resolveRepos("/ws/anchor", { repos: ["/elsewhere/repo", "./nested"] });
  assert.deepEqual(repos.map((r) => r.path), ["/elsewhere/repo", "/ws/anchor/nested"]);
});
test("resolveRepos: empty repos defaults to the anchor itself", () => {
  assert.deepEqual(resolveRepos("/ws/anchor", {}).map((r) => r.path), ["/ws/anchor"]);
});
test("workspaceRepoPairs: pairs source and stable-slug managed repos by config index", () => {
  const sourceAnchorPath = "/source/safetaper-coach";
  const workspaceRecord = {
    sourceAnchorPath,
    managedWorkspaceRoot: "/managed/ws",
    managedAnchorPath: "/managed/ws/safetaper-coach",
    repoMap: {
      "/source/safetaper-coach": { managedPath: "/managed/ws/safetaper-coach" },
      "/source/safetaper-guide": { managedPath: "/managed/ws/source-safetaper-guide-a1b2" },
    },
  };
  assert.deepEqual(workspaceRepoPairs(sourceAnchorPath, {
    repos: ["safetaper-coach", "safetaper-guide"],
  }, workspaceRecord), [
    {
      repoEntry: "safetaper-coach",
      sourceRepoPath: "/source/safetaper-coach",
      managedRepoPath: "/managed/ws/safetaper-coach",
    },
    {
      repoEntry: "safetaper-guide",
      sourceRepoPath: "/source/safetaper-guide",
      managedRepoPath: "/managed/ws/source-safetaper-guide-a1b2",
    },
  ]);
});
test("resolveCardRepoRoute: preserves first-repo behavior without routing config", () => {
  const pairs = [
    { repoEntry: "coach", sourceRepoPath: "/source/coach", managedRepoPath: "/managed/coach" },
    { repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
  ];
  assert.deepEqual(resolveCardRepoRoute({
    config: { repos: ["coach", "guide"] },
    card: { identifier: "SAF-1", labelNames: ["app:guide"] },
    repoPairs: pairs,
  }), { ok: true, label: null, ...pairs[0] });
});
test("resolveCardRepoRoute: maps each configured app label to its exact repo entry", () => {
  const entries = ["safetaper-coach", "safetaper-guide", "safetaper-admin", "safetaper-client-portal", "safetaper-slack"];
  const byLabel = {
    "app:coach": entries[0],
    "app:guide": entries[1],
    "app:admin": entries[2],
    "app:portal": entries[3],
    "app:slack": entries[4],
  };
  const pairs = entries.map((repoEntry) => ({ repoEntry, sourceRepoPath: `/source/${repoEntry}`, managedRepoPath: `/managed/${repoEntry}` }));
  for (const [label, repoEntry] of Object.entries(byLabel)) {
    assert.deepEqual(resolveCardRepoRoute({
      config: { repos: entries, repoRouting: { byLabel } },
      card: { identifier: "SAF-1", labelNames: [label] },
      repoPairs: pairs,
    }), { ok: true, label, ...pairs.find((pair) => pair.repoEntry === repoEntry) });
  }
});
test("resolveCardRepoRoute: fails closed for missing, ambiguous, invalid, and duplicate routes", () => {
  const pairs = [
    { repoEntry: "coach", sourceRepoPath: "/source/coach", managedRepoPath: "/managed/coach" },
    { repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
  ];
  const base = { repos: ["coach", "guide"], repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } } };
  assert.equal(resolveCardRepoRoute({ config: base, card: { identifier: "SAF-1", labelNames: [] }, repoPairs: pairs }).code, "missing-route-label");
  assert.equal(resolveCardRepoRoute({ config: base, card: { identifier: "SAF-1", labelNames: ["app:coach", "app:guide"] }, repoPairs: pairs }).code, "ambiguous-route-label");
  assert.equal(resolveCardRepoRoute({
    config: { ...base, repoRouting: { byLabel: { "app:guide": "unknown" } } },
    card: { identifier: "SAF-1", labelNames: ["app:guide"] }, repoPairs: pairs,
  }).code, "invalid-route-target");
  assert.equal(resolveCardRepoRoute({
    config: { repos: ["coach", "coach"], repoRouting: { byLabel: { "app:coach": "coach" } } },
    card: { identifier: "SAF-1", labelNames: ["app:coach"] }, repoPairs: [pairs[0], pairs[0]],
  }).code, "duplicate-repo-entry");
  assert.equal(resolveCardRepoRoute({
    config: { repos: ["coach"], repoRouting: { byLabel: { "app:one": "coach", "app:two": "coach" } } },
    card: { identifier: "SAF-1", labelNames: ["app:one", "app:two"] }, repoPairs: [pairs[0]],
  }).code, "ambiguous-route-label");
  for (const repoRouting of [null, false]) {
    assert.equal(resolveCardRepoRoute({
      config: { repos: ["coach"], repoRouting },
      card: { identifier: "SAF-1", labelNames: ["app:coach"] },
      repoPairs: [pairs[0]],
    }).code, "invalid-routing-config");
  }
  assert.equal(resolveCardRepoRoute({ config: {}, card: { identifier: "SAF-1", labelNames: [] }, repoPairs: [] }).code, "missing-repo");
  assert.equal(resolveCardRepoRoute({
    config: { repos: ["coach"], repoRouting: { byLabel: {} } },
    card: { identifier: "SAF-1", labelNames: ["app:coach"] }, repoPairs: [pairs[0]],
  }).code, "invalid-routing-config");
  assert.equal(resolveCardRepoRoute({
    config: { repos: ["coach"], repoRouting: { byLabel: { "app:coach": "coach" } } },
    card: { identifier: "SAF-1", labelNames: ["app:coach"] }, repoPairs: [],
  }).code, "missing-repo");
});
test("routeCardsByRepo: separates invalid routes and can limit refill to one primary repo", () => {
  const repoPairs = [
    { repoEntry: "coach", sourceRepoPath: "/source/coach", managedRepoPath: "/managed/coach" },
    { repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
  ];
  const config = { repos: ["coach", "guide"], repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } } };
  const result = routeCardsByRepo([
    { identifier: "SAF-1", labelNames: ["app:coach"] },
    { identifier: "SAF-2", labelNames: ["app:guide"] },
    { identifier: "SAF-3", labelNames: [] },
  ], config, repoPairs, { managedRepoPath: "/managed/guide" });
  assert.deepEqual(result.cards.map((card) => card.identifier), ["SAF-2"]);
  assert.deepEqual(result.deferred.map((card) => card.identifier), ["SAF-1"]);
  assert.deepEqual(result.failures.map((failure) => [failure.identifier, failure.code]), [["SAF-3", "missing-route-label"]]);
  assert.equal(result.cards[0].repoRoute.managedRepoPath, "/managed/guide");
});
test("normalizeRegistry: preserves source anchors and adds managed anchor metadata", () => {
  const normalized = normalizeRegistry({
    repos: ["/Users/jarvis/code/zomes_sdr"],
    managedAnchors: {},
  }, {
    now: () => "2026-07-09T00:00:00.000Z",
    homeDir: "/Users/jarvis",
  });

  assert.deepEqual(normalized.repos, ["/Users/jarvis/code/zomes_sdr"]);
  assert.match(
    normalized.managedAnchors["/Users/jarvis/code/zomes_sdr"].managedWorkspaceRoot,
    /^\/Users\/jarvis\/\.local\/share\/linear-board-sweeps\/workspaces\/zomes_sdr-[a-f0-9]{8}$/,
  );
  assert.match(
    normalized.managedAnchors["/Users/jarvis/code/zomes_sdr"].managedAnchorPath,
    /^\/Users\/jarvis\/\.local\/share\/linear-board-sweeps\/workspaces\/zomes_sdr-[a-f0-9]{8}\/zomes_sdr$/,
  );
});
test("normalizeRegistry: managed workspace roots include a path hash to avoid same-basename collisions", () => {
  const normalized = normalizeRegistry({
    repos: ["/teams/a/app", "/teams/b/app"],
  }, {
    now: () => "2026-07-09T00:00:00.000Z",
    homeDir: "/Users/jarvis",
  });

  const roots = normalized.repos.map((repo) => normalized.managedAnchors[repo].managedWorkspaceRoot);
  assert.equal(new Set(roots).size, 2);
  assert.ok(roots.every((root) => /workspaces\/app-[a-f0-9]{8}$/.test(root)), roots.join(", "));
});
test("capacity registry: legacy registries default to exactly ten and configured values clamp to positive integers", () => {
  assert.deepEqual(normalizeRegistry({}).capacity, { maxActiveChildren: 10 });
  assert.equal(DEFAULT_MAX_ACTIVE_CHILDREN, 10);
  assert.equal(normalizeRegistry({ capacity: { maxActiveChildren: 3.9 } }).capacity.maxActiveChildren, 3);
  assert.equal(normalizeRegistry({ capacity: { maxActiveChildren: 0 } }).capacity.maxActiveChildren, 1);
  assert.equal(normalizeRegistry({ capacity: { maxActiveChildren: "invalid" } }).capacity.maxActiveChildren, 10);
  assert.equal(MAX_ACTIVE_CHILDREN, 32);
  assert.equal(normalizeRegistry({ capacity: { maxActiveChildren: 1_000_000 } }).capacity.maxActiveChildren, 32);
});
test("learning registry: legacy output gains disabled defaults and preserves unrelated fields", () => {
  const normalized = normalizeRegistry({ customSetting: { keep: true } });
  assert.deepEqual(normalized.learning, {
    enabled: false,
    runner: false,
    coreSourceAnchor: null,
    maxNewCardsPerRun: 6,
    runtime: null,
  });
  assert.deepEqual(normalized.customSetting, { keep: true });
});
test("registered learning workspaces are resolved before delivery activation and retain named gaps", () => {
  const reads = [];
  const result = resolveRegisteredLearningWorkspaces({ repos: ["/paused", "/active", "/broken"] }, {
    configFn: (anchor) => {
      reads.push(["config", anchor]);
      if (anchor === "/broken") throw new Error("bad config");
      return { projectId: anchor.slice(1), learning: { enabled: anchor === "/paused" } };
    },
    keyFn: (anchor) => {
      reads.push(["key", anchor]);
      return anchor === "/paused" ? null : "key";
    },
    canonicalFn: (anchor) => anchor,
  });
  assert.deepEqual(result.workspaces.map((item) => item.sourceAnchorPath), ["/paused"]);
  assert.equal(result.workspaces[0].apiKey, null);
  assert.ok(result.coverageGaps.some((gap) => gap.source === "/paused" && /LINEAR_API_KEY/.test(gap.reason)));
  assert.ok(result.coverageGaps.some((gap) => gap.source === "/broken" && /bad config/.test(gap.reason)));
  assert.deepEqual(reads.filter(([kind]) => kind === "config").map(([, anchor]) => anchor), ["/paused", "/active", "/broken"]);
  assert.deepEqual(reads.filter(([kind]) => kind === "key").map(([, anchor]) => anchor), ["/paused", "/active"]);
});
test("capacity installation: persists ten without deleting existing registry settings", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/install-watch.sh"), "utf8");
  assert.match(source, /capacity:\s*\{\s*maxActiveChildren:\s*10\s*\}/);
  assert.match(source, /registry\s*=\s*\{\s*\.\.\.registry,\s*capacity:/);
});
test("resolveWorkspaceRepos: managed mode maps relative and absolute repos under the managed workspace", () => {
  const record = workspaceRecordForSourceAnchor("/src/app", {
    repos: ["/src/app"],
    managedAnchors: {
      "/src/app": {
        sourceAnchorPath: "/src/app",
        managedWorkspaceRoot: "/managed/app",
        managedAnchorPath: "/managed/app/app",
        repoMap: {
          "/src/external-api": { managedPath: "/managed/app/external-api" },
        },
      },
    },
  });

  assert.deepEqual(resolveWorkspaceRepos("/src/app", { repos: ["app", "worker"] }, { mode: "source" }).map((r) => r.path), ["/src/app", "/src/worker"]);
  const managedPaths = resolveWorkspaceRepos("/src/app", { repos: ["app", "worker", "/src/external-api"] }, { mode: "managed", workspaceRecord: record }).map((r) => r.path);
  assert.equal(managedPaths[0], "/managed/app/app");
  assert.match(managedPaths[1], /^\/managed\/app\/worker-[a-f0-9]{8}$/);
  assert.equal(managedPaths[2], "/managed/app/external-api");
  assert.deepEqual(managedPaths.filter((p) => p === "/managed/app/external-api" || p === "/managed/app/app"), [
    "/managed/app/app",
    "/managed/app/external-api",
  ]);
});
test("materializeManagedWorkspacePlan: missing source origin is a setup blocker", () => {
  const gitFn = (repo, args) => {
    if (args.join(" ") === "remote get-url origin" && repo === "/src/app") return { status: 1, out: "", err: "No such remote" };
    return { status: 0, out: "", err: "" };
  };
  const plan = materializeManagedWorkspacePlan({
    sourceAnchorPath: "/src/app",
    config: { repos: ["app"] },
    workspaceRecord: {
      sourceAnchorPath: "/src/app",
      managedWorkspaceRoot: "/managed/app",
      managedAnchorPath: "/managed/app/app",
      repoMap: {},
    },
    existsFn: () => false,
    gitFn,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.blockers[0].kind, "missing-origin");
  assert.equal(plan.blockers[0].sourcePath, "/src/app");
});
test("recoveredTargetsForManagedWorkspace: setup failures recover clean managed targets independently", () => {
  const record = {
    sourceAnchorPath: "/src/app",
    managedWorkspaceRoot: "/managed/app",
    managedAnchorPath: "/managed/app/app",
    repoMap: {},
  };
  const managedWorker = resolveWorkspaceRepos("/src/app", { repos: ["app", "worker"] }, { mode: "managed", workspaceRecord: record })[1].path;
  const setupResult = {
    ok: false,
    record,
    blockers: [{ kind: "dirty-checkout", managedPath: managedWorker, stableTarget: `managed-repo:${managedWorker}`, message: "worker dirty" }],
  };
  const gitFn = (repo, args) => {
    if (args.join(" ") === "status --porcelain -uall" && repo === managedWorker) return { status: 0, out: " M package.json", err: "" };
    if (args.join(" ") === "status --porcelain -uall") return { status: 0, out: "", err: "" };
    return { status: 0, out: "", err: "" };
  };

  const targets = recoveredTargetsForManagedWorkspace({
    sourceAnchorPath: "/src/app",
    config: { repos: ["app", "worker"] },
    setupResult,
    reg: { kitPath: "/kit" },
    gitFn,
  });

  assert.equal(targets.has("managed-anchor:/managed/app/app"), true);
  assert.equal(targets.has(`managed-repo:${managedWorker}`), false);
  assert.equal(targets.has("kit:/kit"), true);
});
test("materializeManagedWorkspace: clones missing managed repos and fast-forwards existing clean repos", () => {
  const calls = [];
  const existing = new Set(["/managed/app/worker-8cea2197"]);
  const gitFn = (repo, args) => {
    calls.push([repo, args.join(" ")]);
    if (args.join(" ") === "remote get-url origin") return { status: 0, out: `git@example.com:${path.basename(repo)}.git`, err: "" };
    if (args.join(" ") === "status --porcelain -uall") return { status: 0, out: "", err: "" };
    return { status: 0, out: "", err: "" };
  };

  const result = materializeManagedWorkspace({
    sourceAnchorPath: "/src/app",
    config: { repos: ["app", "worker"] },
    workspaceRecord: {
      sourceAnchorPath: "/src/app",
      managedWorkspaceRoot: "/managed/app",
      managedAnchorPath: "/managed/app/app",
      repoMap: {},
    },
    existsFn: (p) => existing.has(p),
    mkdirFn: (p) => calls.push(["mkdir", p]),
    gitFn,
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some(([repo, cmd]) => repo === "/managed/app" && cmd === "clone git@example.com:app.git /managed/app/app"));
  assert.ok(calls.some(([repo, cmd]) => repo === "/managed/app/worker-8cea2197" && cmd === "fetch origin"));
  assert.ok(calls.some(([repo, cmd]) => repo === "/managed/app/worker-8cea2197" && cmd === "merge --ff-only origin/main"));
});
test("syncAllowedEnvFiles: copies only gitignored env files with restrictive mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linear-env-sync-"));
  const source = path.join(root, "source");
  const managed = path.join(root, "managed");
  fs.mkdirSync(source);
  fs.mkdirSync(managed);
  fs.writeFileSync(path.join(source, ".env"), "LINEAR_API_KEY=test-linear-key\n");
  fs.writeFileSync(path.join(source, ".env.tracked"), "NOPE=1\n");
  const checks = [];
  const gitFn = (repo, args) => {
    checks.push(args.join(" "));
    if (args.join(" ") === "check-ignore -q .env") return { status: 0, out: "", err: "" };
    return { status: 1, out: "", err: "" };
  };

  const copied = syncAllowedEnvFiles(source, managed, { allowed: [".env", ".env.tracked"], gitFn });

  assert.deepEqual(copied, [".env"]);
  assert.equal(fs.existsSync(path.join(managed, ".env")), true);
  assert.equal(fs.existsSync(path.join(managed, ".env.tracked")), false);
  assert.equal((fs.statSync(path.join(managed, ".env")).mode & 0o777), 0o600);
  assert.deepEqual(checks, ["check-ignore -q .env", "check-ignore -q .env.tracked"]);
});
test("worktreePath is deterministic under the repo", () => {
  assert.equal(worktreePath("/ws/repo", "COD-42"), "/ws/repo/.worktrees/COD-42");
});

// ── runtime config ───────────────────────────────────────────────────────────
test("resolveRuntimeExecutable: explicit override wins and is validated", () => {
  const seen = [];
  const resolved = resolveRuntimeExecutable("codex", { CODEX_BIN: "/custom/codex", PATH: "/bin" }, {
    existsFn: (candidate) => { seen.push(candidate); return candidate === "/custom/codex"; },
    whichFn: () => { throw new Error("PATH lookup should not run"); },
  });
  assert.deepEqual(resolved, { ok: true, runtime: "codex", path: "/custom/codex", source: "override" });
  assert.deepEqual(seen, ["/custom/codex"]);
});
test("resolveRuntimeExecutable: PATH lookup returns an absolute executable", () => {
  const resolved = resolveRuntimeExecutable("claude", { PATH: "/opt/bin:/usr/bin" }, {
    existsFn: (candidate) => candidate === "/opt/bin/claude",
    whichFn: (runtime, env) => {
      assert.equal(runtime, "claude");
      assert.equal(env.PATH, "/opt/bin:/usr/bin");
      return "/opt/bin/claude";
    },
  });
  assert.deepEqual(resolved, { ok: true, runtime: "claude", path: "/opt/bin/claude", source: "path" });
});
test("resolveRuntimeExecutable: falls back to ChatGPT.app then Codex.app for codex", () => {
  const chatGpt = resolveRuntimeExecutable("codex", {}, {
    existsFn: (candidate) => candidate === "/Applications/ChatGPT.app/Contents/Resources/codex",
    whichFn: () => null,
  });
  assert.deepEqual(chatGpt, {
    ok: true,
    runtime: "codex",
    path: "/Applications/ChatGPT.app/Contents/Resources/codex",
    source: "application",
  });

  const codexApp = resolveRuntimeExecutable("codex", {}, {
    existsFn: (candidate) => candidate === "/Applications/Codex.app/Contents/Resources/codex",
    whichFn: () => null,
  });
  assert.equal(codexApp.path, "/Applications/Codex.app/Contents/Resources/codex");
  assert.equal(codexApp.source, "application");
});
test("resolveRuntimeExecutable: missing runtime is a typed preflight failure", () => {
  const resolved = resolveRuntimeExecutable("codex", { PATH: "/missing" }, {
    existsFn: () => false,
    whichFn: () => null,
  });
  assert.deepEqual(resolved, {
    ok: false,
    runtime: "codex",
    code: "ENOENT",
    path: null,
    source: null,
  });
});
test("resolveRuntimeExecutable: rejects non-regular and non-executable candidates from overrides and app bundles", () => {
  const accessCalls = [];
  const statFn = (candidate) => ({ isFile: () => candidate !== "/custom/codex" });
  const accessFn = (candidate, mode) => {
    accessCalls.push([candidate, mode]);
    if (candidate.includes("ChatGPT.app")) throw Object.assign(new Error("not executable"), { code: "EACCES" });
  };
  const resolved = resolveRuntimeExecutable("codex", { CODEX_BIN: "/custom/codex", PATH: "/missing" }, {
    whichFn: () => null,
    statFn,
    accessFn,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, "/Applications/Codex.app/Contents/Resources/codex");
  assert.ok(accessCalls.every(([, mode]) => mode === fs.constants.X_OK));

  const none = resolveRuntimeExecutable("codex", { CODEX_BIN: "/custom/codex" }, {
    whichFn: () => null,
    statFn: () => ({ isFile: () => true }),
    accessFn: () => { throw Object.assign(new Error("not executable"), { code: "EACCES" }); },
  });
  assert.equal(none.ok, false);
  assert.equal(none.code, "ENOENT");
});
test("preflightRuntimeCandidates: scopes a missing runtime by anchor/runtime/host and keeps other lanes ready", () => {
  const calls = [];
  const cache = new Map();
  const candidates = [
    { anchorPath: "/managed/app", sweep: "dev", config: { runtimes: { dev: { runtime: "codex" } } } },
    { anchorPath: "/managed/app", sweep: "qa", config: { runtimes: { qa: { runtime: "claude" } } } },
  ];
  const result = preflightRuntimeCandidates(candidates, {
    host: "builder-1",
    cache,
    envForCandidate: () => ({ PATH: "/opt/bin" }),
    resolveFn: (runtime) => {
      calls.push(runtime);
      return runtime === "claude"
        ? { ok: true, runtime, path: "/opt/bin/claude", source: "path" }
        : { ok: false, runtime, code: "ENOENT", path: null, source: null };
    },
  });

  assert.deepEqual(result.ready.map((pick) => [pick.sweep, pick.runtimeExecutable]), [["qa", "/opt/bin/claude"]]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].scope, "runtime:codex:builder-1");
  assert.equal(result.failures[0].stableTarget, JSON.stringify({ sourceAnchorPath: "/managed/app", runtime: "codex", host: "builder-1" }));
  assert.deepEqual(calls, ["codex", "claude"]);

  preflightRuntimeCandidates(candidates, {
    host: "builder-1",
    cache,
    envForCandidate: () => ({}),
    resolveFn: () => { throw new Error("cached lane should not resolve again"); },
  });
});
test("preflightAndSelectDispatchBatch: missing higher-priority runtime does not starve a healthy lane on the same anchor", async () => {
  const candidates = [
    { anchorPath: "/managed/app", sweep: "qa", count: 1, topSortOrder: 10, config: { runtimes: { qa: { runtime: "claude" } } } },
    { anchorPath: "/managed/app", sweep: "dev", count: 1, topSortOrder: 9, config: { runtimes: { dev: { runtime: "codex" } } } },
  ];
  const result = await preflightAndSelectDispatchBatch(candidates, {
    preflightFn: async (all) => preflightRuntimeCandidates(all, {
      host: "builder-1",
      envForCandidate: () => ({}),
      resolveFn: (runtime) => runtime === "codex"
        ? { ok: true, runtime, path: "/opt/bin/codex", source: "path" }
        : { ok: false, runtime, code: "ENOENT", path: null, source: null },
    }),
    selectOptions: { maxNonShipDispatches: 2, rotationSeed: 0 },
  });

  assert.deepEqual(result.selected.map((candidate) => candidate.sweep), ["dev"]);
  assert.deepEqual(result.failures.map((failure) => failure.runtime), ["claude"]);
});
test("preflightAndSelectDispatchBatch: unavailable Ship does not block healthy non-Ship work", async () => {
  const candidates = [
    { anchorPath: "/managed/ship", sweep: "ship", count: 1, config: { runtimes: { ship: { runtime: "claude" } } } },
    { anchorPath: "/managed/dev", sweep: "dev", count: 3, config: { runtimes: { dev: { runtime: "codex" } } } },
  ];
  let claimCalls = 0;
  const result = await preflightAndSelectDispatchBatch(candidates, {
    preflightFn: async (all) => preflightRuntimeCandidates(all, {
      host: "builder-1",
      envForCandidate: () => ({}),
      resolveFn: (runtime) => runtime === "codex"
        ? { ok: true, runtime, path: "/opt/bin/codex", source: "path" }
        : { ok: false, runtime, code: "ENOENT", path: null, source: null },
    }),
    selectOptions: { maxNonShipDispatches: 2 },
  });
  if (result.selected.length) claimCalls += 1;

  assert.deepEqual(result.failures.map((failure) => failure.pick.sweep), ["ship"]);
  assert.deepEqual(result.selected.map((candidate) => candidate.sweep), ["dev"]);
  assert.equal(claimCalls, 1);
});

test("runtimeConfigForSweep: per-sweep runtimes override legacy runtime/models", () => {
  const resolved = runtimeConfigForSweep({
    runtime: "codex",
    models: { ship: { model: "gpt-5.5", effort: "high" } },
    runtimes: { ship: { runtime: "claude", model: "claude-sonnet-5" } },
  }, "ship");
  assert.deepEqual(resolved, { runtime: "claude", model: "claude-sonnet-5", effort: undefined });
});
test("runtimeConfigForSweep: legacy runtime/models preserve old config behavior", () => {
  assert.deepEqual(runtimeConfigForSweep({
    runtime: "codex",
    models: { dev: { model: "gpt-5.5", effort: "high" } },
  }, "dev"), { runtime: "codex", model: "gpt-5.5", effort: "high" });
});
test("runtimeConfigForSweep: defaults to codex with runtime defaults", () => {
  assert.deepEqual(runtimeConfigForSweep({}, "spec"), { runtime: "codex", model: undefined, effort: undefined });
});
test("runtimeConfigForSweep: review is role config only and never scheduled", () => {
  assert.equal(SWEEPS.includes("review"), false);
  assert.deepEqual(runtimeConfigForSweep({
    runtimes: { review: { runtime: "claude", model: "claude-opus-4-8" } },
  }, "dev"), { runtime: "codex", model: undefined, effort: undefined });
});
test("fallbackRuntimeConfigForSweep: accepts only scheduled codex-to-claude fallback", () => {
  const config = { runtimes: {
    dev: {
      runtime: "codex", model: "gpt-5.6-terra", effort: "high",
      fallback: { runtime: "claude", model: "claude-sonnet-5", effort: "high" },
    },
    review: { runtime: "claude", model: "claude-opus-4-8", fallback: { runtime: "codex" } },
  } };
  const original = structuredClone(config);
  assert.deepEqual(fallbackRuntimeConfigForSweep(config, "dev"), {
    runtime: "claude", model: "claude-sonnet-5", effort: "high",
  });
  assert.equal(fallbackRuntimeConfigForSweep(config, "review"), null);
  assert.equal(fallbackRuntimeConfigForSweep({}, "dev"), null);
  assert.deepEqual(config, original);
});
test("fallbackRuntimeConfigForSweep: rejects malformed, unsupported, and incomplete fallbacks", () => {
  const valid = { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5" } };
  const cases = [
    ["malformed fallback", { runtime: "codex", fallback: [] }],
    ["non-Codex primary", { runtime: "claude", fallback: { runtime: "claude", model: "claude-sonnet-5" } }],
    ["non-Claude fallback", { runtime: "codex", fallback: { runtime: "codex", model: "claude-sonnet-5" } }],
    ["missing model", { runtime: "codex", fallback: { runtime: "claude" } }],
    ["blank model", { runtime: "codex", fallback: { runtime: "claude", model: "   " } }],
    ["non-string model", { runtime: "codex", fallback: { runtime: "claude", model: 5 } }],
    ["invalid effort", { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5", effort: "ultra" } }],
  ];
  for (const [name, stage] of cases) {
    assert.equal(fallbackRuntimeConfigForSweep({ runtimes: { dev: stage } }, "dev"), null, name);
  }
  assert.equal(fallbackRuntimeConfigForSweep({ runtimes: { dev: valid } }, "unknown"), null);
  assert.deepEqual(fallbackRuntimeConfigForSweep({ runtimes: { dev: valid } }, "dev"), {
    runtime: "claude", model: "claude-sonnet-5", effort: undefined,
  });
});
test("default configs retain Codex primaries and declare the four Claude usage fallbacks", () => {
  const expected = {
    spec: { runtime: "codex", model: "gpt-5.6-sol", effort: "high" },
    dev: { runtime: "codex", model: "gpt-5.6-terra", effort: "high" },
    qa: { runtime: "codex", model: "gpt-5.6-sol", effort: "medium" },
    ship: { runtime: "codex", model: "gpt-5.6-terra", effort: "medium" },
  };
  const expectedFallbacks = {
    spec: { runtime: "claude", model: "claude-fable-5" },
    dev: { runtime: "claude", model: "claude-sonnet-5", effort: "high" },
    qa: { runtime: "claude", model: "claude-opus-4-8" },
    ship: { runtime: "claude", model: "claude-sonnet-5", effort: "medium" },
  };
  for (const file of ["templates/linear-sweep.json", ".claude/linear-sweep.json"]) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const sweep of SWEEPS) {
      assert.deepEqual(runtimeConfigForSweep(config, sweep), expected[sweep], `${file} ${sweep}`);
      assert.deepEqual({ runtime: config.runtime, ...config.models[sweep] }, expected[sweep], `${file} legacy ${sweep}`);
      assert.deepEqual(config.runtimes[sweep].fallback, expectedFallbacks[sweep], `${file} fallback ${sweep}`);
      assert.deepEqual(fallbackRuntimeConfigForSweep(config, sweep), {
        ...expectedFallbacks[sweep], effort: expectedFallbacks[sweep].effort,
      }, `${file} resolved fallback ${sweep}`);
    }
    assert.deepEqual(config.runtimes.review, { runtime: "claude", model: "claude-opus-4-8" }, `${file} review`);
  }
});

test("operator docs explain Claude usage fallback configuration and limits", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  assert.doesNotMatch(readme, /Claude usage fallback \(planned, COD-144\)/);
  assert.match(readme, /one capacity reservation[^\n]*at most two sequential attempts/i);
  assert.match(readme, /auth, model, network, overload, signal, and transient rate-limit failures[^\n]*fail closed/i);
  assert.match(readme, /normalized run-record `attempts`/i);

  const setup = fs.readFileSync("SETUP.md", "utf8");
  for (const stage of SWEEPS) assert.match(setup, new RegExp(`"${stage}"\\s*:\\s*\\{[^\\n]*"fallback"`), `SETUP ${stage} fallback`);
  assert.match(setup, /claude --version/);
  assert.match(setup, /attended `claude` login verification/i);
  assert.match(setup, /Codex JSONL[^\n]*source\/version compatibility/i);
  assert.match(setup, /remove `fallback`[^\n]*disable/i);
  assert.match(setup, /dry-run[^\n]*cannot synthesize a real exhaustion event/i);
  assert.match(setup, /node --test --test-name-pattern='default configs\|operator docs\|runtime' tests\/linear-watch\.test\.mjs tests\/agents-snippet\.test\.mjs/);
});

test("SWEEP_CFG fetches concise board states", () => {
  assert.deepEqual(SWEEP_CFG.spec.states, ["Spec"]);
  assert.deepEqual(SWEEP_CFG.dev.states, ["Dev"]);
  assert.deepEqual(SWEEP_CFG.qa.states, ["QA"]);
  assert.deepEqual(SWEEP_CFG.ship.states, ["Ship"]);
});

test("SWEEP_CFG.dev fetches Dev only; active dev is the claim label", () => {
  assert.equal(SWEEP_CFG.dev.claim, "dev:in-progress");
});

// ── command builder ──────────────────────────────────────────────────────────
test("buildCommand: codex with model + effort emits both flags before the prompt", () => {
  const { cmd, args } = buildCommand({ runtime: "codex", sweep: "dev", model: "gpt-5.5-codex", effort: "high", anchorPath: "/ws/a" });
  assert.equal(cmd, "codex");
  assert.deepEqual(args.slice(0, 7), ["exec", "--json", "--cd", "/ws/a", "-m", "gpt-5.5-codex", "-c"]);
  assert.equal(args[7], "model_reasoning_effort=high");
  assert.match(args[args.length - 1], /Follow the dev-sweep skill/);
});
test("buildCommand: omitted model/effort emit no flags (runtime default)", () => {
  const { args } = buildCommand({ runtime: "codex", sweep: "spec", anchorPath: "/ws/a" });
  assert.ok(args.includes("--json"));
  assert.ok(!args.includes("-m"));
  assert.ok(!args.includes("-c"));
});
test("buildCommand: single-card dispatch names the issue and forbids other cards", () => {
  const { args } = buildCommand({ runtime: "codex", sweep: "dev", anchorPath: "/ws/a", issueIdentifier: "COD-123" });
  assert.match(args.at(-1), /COD-123 only/);
  assert.match(args.at(-1), /Do not process other cards/);
});
test("buildCommand: claude passes model, effort, and -p prompt", () => {
  const { cmd, args } = buildCommand({ runtime: "claude", sweep: "ship", model: "claude-sonnet-5", effort: "medium", anchorPath: "/ws" });
  assert.equal(cmd, "claude");
  assert.equal(args[0], "-p");
  assert.deepEqual(args.slice(-4), ["--model", "claude-sonnet-5", "--effort", "medium"]);
});
test("buildCommand: claude omits effort when unset", () => {
  const { args } = buildCommand({ runtime: "claude", sweep: "qa", model: "claude-opus-4-8", anchorPath: "/ws/a" });
  assert.ok(!args.includes("--effort"));
  assert.deepEqual(args.slice(-2), ["--model", "claude-opus-4-8"]);
});

// ── PID lock ─────────────────────────────────────────────────────────────────
test("lockIsReclaimable: dead pid reclaimable, live pid not, empty reclaimable", () => {
  assert.equal(lockIsReclaimable({ pid: 123 }, { isAlive: () => false }), true);
  assert.equal(lockIsReclaimable({ pid: 123 }, { isAlive: () => true }), false);
  assert.equal(lockIsReclaimable(null, { isAlive: () => true }), true);
  assert.equal(lockIsReclaimable({}, { isAlive: () => true }), true);
});
test("lockIsReclaimable: a legitimately long-running (alive) tick is never reclaimed by age", () => {
  // The bug the PID lock fixes: age alone must NOT free a live lock.
  assert.equal(lockIsReclaimable({ pid: 999, at: "2000-01-01T00:00:00Z" }, { isAlive: () => true }), false);
});
test("capacity ledger: reserves before work, attaches child PID, and releases idempotently", async () => {
  let stored = null;
  const writes = [];
  const ledger = createCapacityLedger({
    ledgerPath: "/state/capacity.json",
    maxActiveChildren: 10,
    parentPid: 123,
    readJsonFn: () => stored,
    writeJsonFn: (_path, value) => {
      stored = structuredClone(value);
      writes.push(structuredClone(value));
    },
    isAlive: () => true,
    randomUUID: () => "token-1",
    now: () => "2026-07-09T12:00:00.000Z",
  });
  const events = [];
  const queue = createAdmissionQueue({
    ledger,
    executeDemand: async (_demand, reservation) => {
      events.push(["execute", structuredClone(stored)]);
      reservation.attachChildPid(456);
      events.push(["attached", structuredClone(stored)]);
      return "done";
    },
  });

  const result = await admitDemand({
    stage: "dev", trigger: "initial", workspace: "/managed", issueIdentifier: "COD-1",
  }, { queue });

  assert.equal(result, "done");
  assert.equal(events[0][1].entries[0].childPid, null);
  assert.equal(events[1][1].entries[0].childPid, 456);
  assert.deepEqual(stored, { version: 1, entries: [] });
  assert.equal(ledger.release("token-1"), false);
  assert.equal(writes.length, 3);
});
test("capacity ledger: live children survive dead parents while dead child/dead parent entries prune", () => {
  let stored = {
    version: 1,
    entries: [
      { token: "live-child", parentPid: 10, childPid: 20, issueIdentifier: "COD-1", workspace: "/managed", stage: "dev", trigger: "initial", reservedAt: "2026-07-09T00:00:00.000Z" },
      { token: "dead-child", parentPid: 11, childPid: 21, issueIdentifier: "COD-2", workspace: "/managed", stage: "qa", trigger: "handoff", reservedAt: "2026-07-09T00:00:00.000Z" },
      { token: "dead-reservation", parentPid: 12, childPid: null, issueIdentifier: "COD-3", workspace: "/managed", stage: "spec", trigger: "refill", reservedAt: "2026-07-09T00:00:00.000Z" },
    ],
  };
  const ledger = createCapacityLedger({
    readJsonFn: () => stored,
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: (pid) => pid === 20,
  });

  const snapshot = ledger.reconcile();
  assert.deepEqual(snapshot.entries.map((entry) => entry.token), ["live-child"]);
  assert.equal(snapshot.active, 1);
});
test("capacity ledger: malformed or unverifiable entries fail closed and consume capacity", () => {
  const malformed = createCapacityLedger({
    maxActiveChildren: 10,
    readJsonFn: () => ({ version: 1, entries: [{ token: "broken" }] }),
    writeJsonFn: () => assert.fail("malformed ledger must not be rewritten automatically"),
  }).inspect();
  assert.equal(malformed.healthy, false);
  assert.equal(malformed.active, 1);

  const unverifiable = createCapacityLedger({
    maxActiveChildren: 1,
    readJsonFn: () => ({ version: 1, entries: [
      { token: "unknown", parentPid: 10, childPid: 20, issueIdentifier: "COD-1", workspace: "/managed", stage: "dev", trigger: "initial", reservedAt: "2026-07-09T00:00:00.000Z" },
    ] }),
    writeJsonFn: () => assert.fail("unverifiable ledger must not be rewritten automatically"),
    isAlive: () => { throw new Error("permission denied"); },
  });
  assert.equal(unverifiable.reconcile().healthy, false);
  assert.equal(unverifiable.reserve({ stage: "qa", trigger: "initial", workspace: "/managed", issueIdentifier: "COD-2" }), null);
});
test("admission queue: malformed capacity settles demands and idle waiters with a typed failure", async () => {
  const failures = [];
  const queue = createAdmissionQueue({
    ledger: {
      reconcile: () => ({ healthy: false, active: 1, max: 10, entries: [{ token: "broken" }], errors: ["malformed entry broken"] }),
      reserve: () => assert.fail("unhealthy capacity must never reserve"),
    },
    executeDemand: () => assert.fail("unhealthy capacity must never claim or execute"),
    onCapacityFailure: (failure, demands) => failures.push({ failure, demands }),
  });
  const demand = { stage: "qa", trigger: "initial", workspace: "/managed", issueIdentifier: "COD-41" };
  await assert.rejects(queue.admitDemand(demand), (error) => error.code === "CAPACITY_UNAVAILABLE" && /malformed entry/.test(error.message));
  await queue.whenIdle();
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.activeCount, 0);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].demands.map((item) => item.issueIdentifier), ["COD-41"]);
});

test("admission queue: simultaneous completion discoveries coalesce before global priority", async () => {
  let stored = null;
  const ledger = createCapacityLedger({
    maxActiveChildren: 1,
    readJsonFn: () => stored,
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: () => true,
    randomUUID: (() => { let n = 0; return () => `token-${++n}`; })(),
  });
  const order = [];
  const queue = createAdmissionQueue({
    ledger,
    executeDemand: async (demand) => { order.push(demand.stage); return demand.stage; },
  });
  const dev = queue.admitDemand({ stage: "dev", trigger: "refill", workspace: "/dev", issueIdentifier: "COD-1", boardOrder: 10 });
  let qa;
  queueMicrotask(() => {
    qa = queue.admitDemand({ stage: "qa", trigger: "handoff", workspace: "/qa", issueIdentifier: "COD-2", boardOrder: 1 });
  });
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([dev, qa]);
  assert.deepEqual(order, ["qa", "dev"]);
});
test("capacity ledger: read-only inspect reports confirmed stale entries and preserves a live child", () => {
  const entries = [
    { token: "dead-child", parentPid: 10, childPid: 20, issueIdentifier: "COD-1", workspace: "/managed", stage: "dev", trigger: "initial", reservedAt: "2026-07-09T00:00:00.000Z" },
    { token: "dead-reservation", parentPid: 11, childPid: null, issueIdentifier: "COD-2", workspace: "/managed", stage: "qa", trigger: "handoff", reservedAt: "2026-07-09T00:00:00.000Z" },
    { token: "live-child-dead-parent", parentPid: 12, childPid: 22, issueIdentifier: "COD-3", workspace: "/managed", stage: "spec", trigger: "refill", reservedAt: "2026-07-09T00:00:00.000Z" },
  ];
  const state = createCapacityLedger({
    maxActiveChildren: 10,
    readJsonFn: () => ({ version: 1, entries: structuredClone(entries) }),
    writeJsonFn: () => assert.fail("doctor inspect must remain read-only"),
    isAlive: (pid) => pid === 22,
  }).inspect();

  assert.equal(state.healthy, false);
  assert.equal(state.active, 3);
  assert.deepEqual(state.errors, [
    "stale entry dead-child: parent PID 10 and child PID 20 are dead",
    "stale entry dead-reservation: parent PID 11 is dead before child spawn",
  ]);
  assert.deepEqual(state.entries.map((entry) => entry.token), entries.map((entry) => entry.token));
});
test("capacity ledger: parent-alive child-dead settling interval remains healthy and active", () => {
  let stored = { version: 1, entries: [
    { token: "settling-child", parentPid: 50, childPid: 51, issueIdentifier: "COD-50", workspace: "/managed", stage: "dev", trigger: "initial", reservedAt: "2026-07-09T00:00:00.000Z" },
  ] };
  let writes = 0;
  const ledger = createCapacityLedger({
    readJsonFn: () => structuredClone(stored),
    writeJsonFn: (_target, value) => { writes += 1; stored = structuredClone(value); },
    isAlive: (pid) => pid === 50,
  });

  const inspected = ledger.inspect();
  assert.equal(inspected.healthy, true);
  assert.equal(inspected.active, 1);
  assert.deepEqual(inspected.errors, []);
  const reconciled = ledger.reconcile();
  assert.equal(reconciled.healthy, true);
  assert.equal(reconciled.active, 1);
  assert.deepEqual(reconciled.entries.map((entry) => entry.token), ["settling-child"]);
  assert.equal(writes, 0);
});
test("capacity ledger: duplicate tokens are malformed and release never removes corrupt entries", () => {
  const entry = (issueIdentifier) => ({
    token: "duplicate-token", parentPid: 10, childPid: null, issueIdentifier,
    workspace: "/managed", stage: "dev", trigger: "initial", reservedAt: "2026-07-09T00:00:00.000Z",
  });
  const stored = { version: 1, entries: [entry("COD-1"), entry("COD-2")] };
  let writes = 0;
  const ledger = createCapacityLedger({
    readJsonFn: () => structuredClone(stored),
    writeJsonFn: () => { writes += 1; },
    isAlive: () => true,
  });

  const state = ledger.inspect();
  assert.equal(state.healthy, false);
  assert.match(state.errors.join("; "), /duplicate token/i);
  assert.equal(ledger.release("duplicate-token"), false);
  assert.equal(writes, 0);
  assert.equal(stored.entries.length, 2);
});
test("capacity ledger: UUID collision retries without overwriting an existing reservation", () => {
  let stored = { version: 1, entries: [{
    token: "collision", parentPid: 10, childPid: null, issueIdentifier: "COD-1",
    workspace: "/managed", stage: "dev", trigger: "initial", reservedAt: "2026-07-09T00:00:00.000Z",
  }] };
  const uuids = ["collision", "unique"];
  const ledger = createCapacityLedger({
    maxActiveChildren: 1000,
    parentPid: 11,
    readJsonFn: () => structuredClone(stored),
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: () => true,
    randomUUID: () => uuids.shift(),
  });

  const reservation = ledger.reserve({ stage: "qa", trigger: "handoff", workspace: "/managed", issueIdentifier: "COD-2" });
  assert.equal(ledger.maxActiveChildren, 32);
  assert.equal(createCapacityLedger({ maxActiveChildren: null }).maxActiveChildren, 10);
  assert.equal(reservation.token, "unique");
  assert.deepEqual(stored.entries.map((entry) => entry.token), ["collision", "unique"]);
});
test("capacity ledger: cross-process mutation lock defers a concurrent reserve and recovers a dead owner", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-capacity-lock-"));
  const ledgerPath = path.join(dir, "capacity.json");
  const readyPath = path.join(dir, "ready");
  const moduleUrl = new URL("../scripts/linear-watch.mjs", import.meta.url).href;
  const childCode = `
    import fs from "node:fs";
    import { withCapacityLedgerMutationLock } from ${JSON.stringify(moduleUrl)};
    const [ledgerPath, readyPath] = process.argv.slice(1);
    withCapacityLedgerMutationLock(ledgerPath, () => {
      fs.writeFileSync(readyPath, String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    }, { timeoutMs: 100 });
  `;
  const child = spawnProcess(process.execPath, ["--input-type=module", "-e", childCode, ledgerPath, readyPath], { stdio: ["ignore", "pipe", "pipe"] });
  const childExit = new Promise((resolve) => child.once("exit", resolve));
  const deadline = Date.now() + 3_000;
  while (!fs.existsSync(readyPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(readyPath), true, "lock-holder child did not become ready");

  const contended = createCapacityLedger({ ledgerPath, maxActiveChildren: 2, lockTimeoutMs: 20 });
  assert.equal(contended.reserve({ stage: "learning", trigger: "learning-due", workspace: "registry:test", issueIdentifier: "factory-learning:test" }), null);

  child.kill("SIGKILL");
  await childExit;
  const restarted = createCapacityLedger({ ledgerPath, maxActiveChildren: 2 });
  const reservation = restarted.reserve({ stage: "learning", trigger: "learning-due", workspace: "registry:test", issueIdentifier: "factory-learning:test" });
  assert.ok(reservation, "dead lock owner should be reclaimed after restart");
  assert.equal(JSON.parse(fs.readFileSync(ledgerPath, "utf8")).entries.length, 1);
  assert.equal(reservation.release(), true);
});
test("queue observations: first capacity wait survives restart and accumulates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-observations-"));
  const observationPath = path.join(dir, "observations.json");
  let now = Date.parse("2026-07-01T00:00:00.000Z");
  const identity = { sourceWorkspace: "/source/app", sweep: "dev", issueIdentifier: "COD-1" };
  const first = createObservationStore({ observationPath, now: () => now });

  first.sync({
    scannedScopes: [{ sourceWorkspace: "/source/app", sweep: "dev" }],
    observations: [{ ...identity, eligible: true }],
  });
  first.markCapacityDeferred(identity);
  assert.equal(first.get(identity).firstObservedActionableAt, "2026-07-01T00:00:00.000Z");

  now += 10 * 60_000;
  const restarted = createObservationStore({ observationPath, now: () => now });
  restarted.markCapacityDeferred(identity);
  assert.equal(restarted.get(identity).firstObservedActionableAt, "2026-07-01T00:00:00.000Z");
  assert.equal(restarted.get(identity).queueWaitMs, 10 * 60_000);
  assert.equal(JSON.parse(fs.readFileSync(observationPath, "utf8")).version, OBSERVATION_STATE_VERSION);
});
test("queue observations: relation, label, or claim blocking clears persisted waits", () => {
  for (const blockedBy of ["relation", "label", "claim"]) {
    let stored = null;
    const identity = { sourceWorkspace: "/source/app", sweep: "qa", issueIdentifier: `COD-${blockedBy}` };
    const store = createObservationStore({
      observationPath: "/state/observations.json",
      now: () => NOW,
      readJsonFn: () => stored,
      writeJsonFn: (_target, value) => { stored = structuredClone(value); },
    });
    store.markCapacityDeferred(identity);
    store.sync({
      scannedScopes: [{ sourceWorkspace: identity.sourceWorkspace, sweep: identity.sweep }],
      observations: [{ ...identity, eligible: false, blockedBy }],
    });
    assert.equal(store.get(identity), null, blockedBy);
  }
});
test("queue observations: dry-run reads existing waits without writing", () => {
  const existing = {
    version: OBSERVATION_STATE_VERSION,
    entries: {
      '["/source/app","dev","COD-1"]': {
        sourceWorkspace: "/source/app", sweep: "dev", issueIdentifier: "COD-1",
        firstObservedActionableAt: "2026-07-01T00:00:00.000Z", lastSeenAt: "2026-07-01T00:00:00.000Z",
      },
    },
  };
  let writes = 0;
  const store = createObservationStore({
    dryRun: true,
    now: () => Date.parse("2026-07-01T00:10:00.000Z"),
    readJsonFn: () => structuredClone(existing),
    writeJsonFn: () => { writes += 1; },
  });

  store.markCapacityDeferred({ sourceWorkspace: "/source/app", sweep: "dev", issueIdentifier: "COD-2" });
  store.clear({ sourceWorkspace: "/source/app", sweep: "dev", issueIdentifier: "COD-1" });
  assert.equal(store.get({ sourceWorkspace: "/source/app", sweep: "dev", issueIdentifier: "COD-1" }).queueWaitMs, 10 * 60_000);
  assert.equal(writes, 0);
});
test("queue observations: unseen entries prune after seven days", () => {
  let stored = null;
  let now = Date.parse("2026-07-01T00:00:00.000Z");
  const identity = { sourceWorkspace: "/source/app", sweep: "spec", issueIdentifier: "COD-7" };
  const store = createObservationStore({
    now: () => now,
    readJsonFn: () => stored,
    writeJsonFn: (_target, value) => { stored = structuredClone(value); },
  });
  store.markCapacityDeferred(identity);
  now += OBSERVATION_RETENTION_MS + 1;
  store.sync({ observations: [], scannedScopes: [] });
  assert.equal(store.get(identity), null);
});
test("queue observations: reserved demand with no confirmed dispatch clears its persisted wait", async () => {
  let observations = null;
  let ledgerState = null;
  const identity = { sourceWorkspace: "/source/app", workspace: "/managed/app", sweep: "dev", issueIdentifier: "COD-8" };
  const store = createObservationStore({
    now: () => NOW,
    readJsonFn: () => observations,
    writeJsonFn: (_target, value) => { observations = structuredClone(value); },
  });
  store.markCapacityDeferred(identity);
  const ledger = createCapacityLedger({
    maxActiveChildren: 1,
    readJsonFn: () => ledgerState,
    writeJsonFn: (_target, value) => { ledgerState = structuredClone(value); },
    isAlive: () => true,
    randomUUID: () => "claim-rejected-token",
  });
  const queue = createAdmissionQueue({
    ledger,
    executeDemand: async () => null,
    onUnconfirmedDemand: (demand) => store.clear(demand),
  });

  assert.equal(await admitDemand(identity, { queue }), null);
  assert.equal(store.get(identity), null);
  assert.deepEqual(ledgerState, { version: 1, entries: [] });
});
test("queue observations: rejected claim expansion also clears its persisted wait", async () => {
  let observations = null;
  let ledgerState = null;
  const identity = { sourceWorkspace: "/source/app", workspace: "/managed/app", sweep: "qa", issueIdentifier: "COD-9" };
  const store = createObservationStore({
    now: () => NOW,
    readJsonFn: () => observations,
    writeJsonFn: (_target, value) => { observations = structuredClone(value); },
  });
  store.markCapacityDeferred(identity);
  const queue = createAdmissionQueue({
    ledger: createCapacityLedger({
      maxActiveChildren: 1,
      readJsonFn: () => ledgerState,
      writeJsonFn: (_target, value) => { ledgerState = structuredClone(value); },
      isAlive: () => true,
      randomUUID: () => "claim-error-token",
    }),
    executeDemand: async () => { throw new Error("claim confirmation failed"); },
    onUnconfirmedDemand: (demand) => store.clear(demand),
  });

  await assert.rejects(admitDemand(identity, { queue }), /claim confirmation failed/);
  assert.equal(store.get(identity), null);
  assert.deepEqual(ledgerState, { version: 1, entries: [] });
});
test("capacity admission: eleven simultaneous demands never run more than ten", async () => {
  let stored = null;
  let active = 0;
  let peak = 0;
  const releases = [];
  const ledger = createCapacityLedger({
    maxActiveChildren: 10,
    parentPid: 100,
    readJsonFn: () => stored,
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: () => true,
    randomUUID: (() => { let n = 0; return () => `token-${++n}`; })(),
  });
  const queue = createAdmissionQueue({
    ledger,
    executeDemand: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
    },
  });
  const runs = Array.from({ length: 11 }, (_, index) => admitDemand({
    stage: "dev", trigger: "initial", boardOrder: 11 - index, rotationRank: 0,
    issueIdentifier: `COD-${index + 1}`, workspace: "/managed",
  }, { queue }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 10);
  assert.equal(peak, 10);
  assert.equal(stored.entries.length, 10);

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 10);
  assert.equal(peak, 10);
  for (const release of releases.splice(0)) release();
  await Promise.all(runs);
  assert.equal(stored.entries.length, 0);
});
test("capacity admission: Ship runs with other stages but only one Ship per workspace", async () => {
  let stored = null;
  const started = [];
  const releases = new Map();
  const ledger = createCapacityLedger({
    maxActiveChildren: 3,
    readJsonFn: () => stored,
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: () => true,
    randomUUID: (() => { let n = 0; return () => `token-${++n}`; })(),
  });
  const queue = createAdmissionQueue({
    ledger,
    executeDemand: async (demand) => {
      started.push(demand.issueIdentifier);
      await new Promise((resolve) => releases.set(demand.issueIdentifier, resolve));
    },
  });
  const dev = admitDemand({ stage: "dev", trigger: "initial", issueIdentifier: "COD-DEV", workspace: "/source/a", managedWorkspace: "/managed/a" }, { queue });
  const firstShip = admitDemand({ stage: "ship", trigger: "initial", issueIdentifier: "COD-SHIP-A1", workspace: "/source/a", managedWorkspace: "/managed/a" }, { queue });
  const duplicateShip = admitDemand({ stage: "ship", trigger: "initial", issueIdentifier: "COD-SHIP-A2", workspace: "/source/a", managedWorkspace: "/managed/a" }, { queue });
  const otherShip = admitDemand({ stage: "ship", trigger: "initial", issueIdentifier: "COD-SHIP-B", workspace: "/source/b", managedWorkspace: "/managed/b" }, { queue });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["COD-SHIP-A1", "COD-SHIP-B", "COD-DEV"]);
  releases.get("COD-SHIP-A1")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["COD-SHIP-A1", "COD-SHIP-B", "COD-DEV", "COD-SHIP-A2"]);
  for (const identifier of ["COD-SHIP-B", "COD-DEV", "COD-SHIP-A2"]) releases.get(identifier)();
  await Promise.all([dev, firstShip, duplicateShip, otherShip]);
});
test("capacity ledger: Ship reservation is scoped to source or managed workspace identity", () => {
  let stored = null;
  const ledger = createCapacityLedger({
    maxActiveChildren: 10,
    parentPid: 100,
    readJsonFn: () => stored,
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: () => true,
    randomUUID: (() => { let n = 0; return () => `token-${++n}`; })(),
  });
  assert.ok(ledger.reserve({ stage: "dev", trigger: "initial", issueIdentifier: "COD-DEV", workspace: "/source/a", managedWorkspace: "/managed/a" }));
  assert.ok(ledger.reserve({ stage: "ship", trigger: "initial", issueIdentifier: "COD-SHIP-A", workspace: "/source/a", managedWorkspace: "/managed/a" }));
  assert.equal(ledger.reserve({ stage: "ship", trigger: "initial", issueIdentifier: "COD-SHIP-A2", workspace: "/source/a", managedWorkspace: "/managed/a" }), null);
  assert.ok(ledger.reserve({ stage: "ship", trigger: "initial", issueIdentifier: "COD-SHIP-B", workspace: "/source/b", managedWorkspace: "/managed/b" }));

  stored.entries = stored.entries.filter((entry) => entry.stage !== "ship");
  stored.entries.push({
    token: "legacy-ship", parentPid: 100, childPid: null, issueIdentifier: "COD-OLD",
    workspace: "/managed/c", stage: "ship", trigger: "initial", reservedAt: "2026-07-09T00:00:00.000Z",
  });
  assert.equal(ledger.reserve({ stage: "ship", trigger: "initial", issueIdentifier: "COD-SHIP-C", workspace: "/source/c", managedWorkspace: "/managed/c" }), null);
});
test("capacity admission: each completed child is handled before later siblings finish", async () => {
  const resolvers = new Map();
  const handled = [];
  const queue = {
    admitDemand: (demand) => new Promise((resolve) => resolvers.set(demand.issueIdentifier, resolve)),
  };
  const run = runAdmissionDemands([
    { issueIdentifier: "COD-1" },
    { issueIdentifier: "COD-2" },
  ], { queue, onResult: async (result) => handled.push(result.issueIdentifier) });

  resolvers.get("COD-1")({ issueIdentifier: "COD-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handled, ["COD-1"]);
  resolvers.get("COD-2")({ issueIdentifier: "COD-2" });
  assert.deepEqual((await run).map((result) => result.issueIdentifier), ["COD-1", "COD-2"]);
});
test("resource sampler: records free bytes and separately named macOS pressure percentage", () => {
  const loads = [[1.5, 1, 0.5], [3.5, 2, 1], [2.5, 2, 1]];
  const free = [800, 400, 600];
  const pressure = ["System-wide memory free percentage: 42%", "System-wide memory free percentage: 24%", "System-wide memory free percentage: 30%"];
  let sampleAgain;
  const sampler = createResourceSampler({
    osModule: {
      loadavg: () => loads.shift(),
      freemem: () => free.shift(),
      totalmem: () => 1_000,
      platform: () => "darwin",
    },
    memoryPressureFn: () => pressure.shift(),
    setIntervalFn: (fn) => { sampleAgain = fn; return 17; },
    clearIntervalFn: () => {},
  });

  sampler.start();
  sampleAgain();
  sampler.stop();
  assert.deepEqual(sampler.snapshot(), {
    loadAverage1m: { start: 1.5, end: 2.5, max: 3.5 },
    freeMemoryBytes: { start: 800, end: 600, min: 400 },
    totalMemoryBytes: 1_000,
    memoryPressureAvailablePercent: { start: 42, end: 30, min: 24 },
    metricsUnavailable: [],
  });
});
test("resource sampler: failures are recorded and never thrown", () => {
  const sampler = createResourceSampler({
    osModule: {
      loadavg: () => { throw new Error("host metrics denied"); },
      freemem: () => assert.fail("sampling stops after the failed read"),
      totalmem: () => 1_000,
      platform: () => "linux",
    },
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  assert.doesNotThrow(() => sampler.start());
  assert.match(sampler.snapshot().metricsUnavailable.join("; "), /host metrics denied/);
});
test("resource sampler: Darwin pressure spawn, exit, and parse failures name only the optional metric", () => {
  const cases = [
    { result: { status: null, error: new Error("spawn ENOENT") }, detail: /spawn ENOENT/ },
    { result: { status: 2, stdout: "", stderr: "permission denied" }, detail: /exited 2.*permission denied/ },
    { result: { status: 0, stdout: "unexpected output", stderr: "" }, detail: /could not parse/ },
  ];
  for (const { result, detail } of cases) {
    const sampler = createResourceSampler({
      osModule: {
        loadavg: () => [1, 1, 1], freemem: () => 500, totalmem: () => 1_000, platform: () => "darwin",
      },
      memoryPressureSpawnFn: () => result,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    assert.doesNotThrow(() => sampler.start());
    const snapshot = sampler.snapshot();
    assert.deepEqual(snapshot.freeMemoryBytes, { start: 500, end: 500, min: 500 });
    assert.match(snapshot.metricsUnavailable.join("; "), /memoryPressureAvailablePercent/);
    assert.match(snapshot.metricsUnavailable.join("; "), detail);
    assert.equal(snapshot.memoryPressureAvailablePercent, undefined);
  }
});
test("resource sampler: non-Darwin pressure absence is unsupported rather than unavailable", () => {
  const sampler = createResourceSampler({
    osModule: {
      loadavg: () => [1, 1, 1], freemem: () => 500, totalmem: () => 1_000, platform: () => "linux",
    },
    memoryPressureSpawnFn: () => assert.fail("non-Darwin must not spawn memory_pressure"),
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  sampler.start();
  assert.deepEqual(sampler.snapshot().metricsUnavailable, []);
});
test("resource sampler: timer failures remain observational", () => {
  const sampler = createResourceSampler({
    osModule: {
      loadavg: () => [1, 1, 1], freemem: () => 500, totalmem: () => 1_000, platform: () => "linux",
    },
    setIntervalFn: () => { throw new Error("timers unavailable"); },
    clearIntervalFn: () => { throw new Error("timer cleanup unavailable"); },
  });
  assert.doesNotThrow(() => sampler.start());
  assert.doesNotThrow(() => sampler.stop());
  assert.match(sampler.snapshot().metricsUnavailable.join("; "), /timers unavailable/);
});
test("capacity admission: one sampler spans first admitted child through last release", async () => {
  let stored = null;
  const releases = [];
  const lifecycle = [];
  const ledger = createCapacityLedger({
    maxActiveChildren: 2,
    readJsonFn: () => stored,
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: () => true,
    randomUUID: (() => { let n = 0; return () => `sample-token-${++n}`; })(),
  });
  const queue = createAdmissionQueue({
    ledger,
    sampler: { start: () => lifecycle.push("start"), stop: () => lifecycle.push("stop") },
    executeDemand: async () => new Promise((resolve) => releases.push(resolve)),
  });
  const runs = ["COD-1", "COD-2"].map((issueIdentifier) => admitDemand({
    stage: "dev", trigger: "initial", issueIdentifier, workspace: "/managed",
  }, { queue }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle, ["start"]);
  releases.shift()("one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle, ["start"]);
  releases.shift()("two");
  await Promise.all(runs);
  assert.deepEqual(lifecycle, ["start", "stop"]);
});
test("capacity admission: same-stage handoff discovered under the held token runs before queued initial work", async () => {
  let stored = null;
  const order = [];
  const ledger = createCapacityLedger({
    maxActiveChildren: 1,
    readJsonFn: () => stored,
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: () => true,
    randomUUID: (() => { let n = 0; return () => `token-${++n}`; })(),
  });
  const queue = createAdmissionQueue({
    ledger,
    executeDemand: async (demand) => {
      order.push(demand.issueIdentifier);
      return { issueIdentifier: demand.issueIdentifier };
    },
    beforeRelease: async (_result, demand, admission) => {
      if (demand.issueIdentifier === "A") admission.admitDemand({
        stage: "dev", trigger: "handoff", boardOrder: 0, rotationRank: 0,
        issueIdentifier: "H", workspace: "/managed",
      });
    },
  });

  await runAdmissionDemands([
    { stage: "dev", trigger: "initial", boardOrder: 10, rotationRank: 0, issueIdentifier: "A", workspace: "/managed" },
    { stage: "dev", trigger: "initial", boardOrder: 9, rotationRank: 0, issueIdentifier: "B", workspace: "/managed" },
  ], { queue });
  await queue.whenIdle();
  assert.deepEqual(order, ["A", "H", "B"]);
});

// ── version compare ──────────────────────────────────────────────────────────
test("isNewerVersion: different non-empty marker is newer; same or empty is not", () => {
  assert.equal(isNewerVersion("v2", "v1"), true);
  assert.equal(isNewerVersion("v1", "v1"), false);
  assert.equal(isNewerVersion("v2", null), true);
  assert.equal(isNewerVersion(null, "v1"), false);
});

// ── heartbeat ────────────────────────────────────────────────────────────────
test("heartbeatAgeMin: reads newest heartbeat marker, not raw updatedAt", () => {
  const card = {
    updatedAt: minsAgo(200),
    comments: [
      { body: `${HEARTBEAT_TAG} ${minsAgo(120)}]`, createdAt: minsAgo(120) },
      { body: `${HEARTBEAT_TAG} ${minsAgo(3)}]`, createdAt: minsAgo(3) },
    ],
  };
  assert.ok(Math.abs(heartbeatAgeMin(card, NOW) - 3) < 0.5);
});
test("heartbeatAgeMin: falls back to updatedAt when no heartbeat present", () => {
  const card = { updatedAt: minsAgo(45), comments: [{ body: "just a normal comment", createdAt: minsAgo(10) }] };
  assert.ok(Math.abs(heartbeatAgeMin(card, NOW) - 45) < 0.5);
});

test("heartbeatAgeMin: declared claim falls back to declaration time and ignores a delayed old heartbeat", () => {
  const card = {
    updatedAt: minsAgo(1),
    labelNames: ["dev:in-progress"],
    commentsComplete: true,
    comments: [
      { id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "old", declarationId: "old-decl" }), createdAt: minsAgo(300) },
      { id: "c2", body: claimCloseMarker({ claim: "dev:in-progress", declarationId: "old-decl", reason: "released" }), createdAt: minsAgo(250) },
      { id: "c3", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "new", declarationId: "new-decl" }), createdAt: minsAgo(45) },
      { id: "c4", body: claimHeartbeatMarker({ claim: "dev:in-progress", declarationId: "old-decl", at: minsAgo(1) }), createdAt: minsAgo(1) },
    ],
  };
  assert.ok(Math.abs(heartbeatAgeMin(card, NOW, "dev:in-progress") - 45) < 0.5);
});
test("heartbeatAgeMin: stranded closed label ages from its boundary and ignores delayed old heartbeat", () => {
  const card = { updatedAt: minsAgo(1), labelNames: ["qa:in-progress"], commentsComplete: true, comments: [
    { id: "c1", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: minsAgo(300) },
    { id: "c2", body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl", reason: "released" }), createdAt: minsAgo(200) },
    { id: "c3", body: claimHeartbeatMarker({ claim: "qa:in-progress", declarationId: "decl", at: minsAgo(1) }), createdAt: minsAgo(1) },
  ] };
  assert.ok(Math.abs(heartbeatAgeMin(card, NOW, "qa:in-progress") - 200) < 0.5);
});
test("heartbeatAgeMin: delayed duplicate boundary is a no-op for stranded-label age", () => {
  const card = { updatedAt: minsAgo(1), labelNames: ["qa:in-progress"], commentsComplete: true, comments: [
    { id: "c1", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: minsAgo(300) },
    { id: "c2", body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl", reason: "released" }), createdAt: minsAgo(200) },
    { id: "c3", body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl", reason: "failed" }), createdAt: minsAgo(1) },
  ] };
  assert.ok(Math.abs(heartbeatAgeMin(card, NOW, "qa:in-progress") - 200) < 0.5);
});
test("heartbeatAgeMin: ambiguous declared history fails closed as live", () => {
  const card = dependencyReadyCard({ id: "bad", stateName: "Dev", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], commentsComplete: true, comments: [
    { id: "c1", body: "[auto-sweep-claim v1 claim=dev:in-progress broken]", createdAt: minsAgo(300) },
  ] });
  assert.equal(heartbeatAgeMin(card, NOW, "dev:in-progress"), Number.NEGATIVE_INFINITY);
  assert.deepEqual(actionableCards([card], SWEEP_CFG.dev, NOW), []);
});
test("claim migration status reports legacy, orphan, active, and ambiguous claims", () => {
  const at = (n) => `2026-07-11T00:0${n}:00.000Z`;
  const cards = [
    { identifier: "COD-1", labelNames: ["dev:in-progress"], commentsComplete: true, comments: [
      { id: "c1", createdAt: at(1), body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }) },
    ] },
    { identifier: "COD-2", labelNames: ["qa:in-progress"], commentsComplete: true, comments: [] },
    { identifier: "COD-3", labelNames: [], commentsComplete: true, comments: [
      { id: "c3", createdAt: at(3), body: claimDeclarationMarker({ claim: "ship:in-progress", ownerToken: "owner-3", declarationId: "decl-3" }) },
    ] },
    { identifier: "COD-4", labelNames: ["spec:in-progress"], commentsComplete: true, comments: [
      { id: "c4", createdAt: at(4), body: "[auto-sweep-claim v1 claim=spec:in-progress broken]" },
    ] },
  ];
  assert.deepEqual(claimMigrationSummary(cards), {
    active: 1,
    legacyUnowned: 1,
    orphanDeclarations: 1,
    ambiguous: 1,
    ready: false,
  });
});
test("claim migration scan complete-hydrates every project card before selecting claim history", async () => {
  const full = [{ id: "full-1", createdAt: "2026-07-11T00:01:00.000Z", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }) }];
  const hydrated = [];
  const cards = await fetchClaimMigrationCards("key", "COD", "project", {
    gqlFn: async () => ({ issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { id: "i1", identifier: "COD-1", updatedAt: NOW, state: { name: "Dev" }, labels: { pageInfo: { hasNextPage: false }, nodes: [{ id: "l1", name: "dev:in-progress" }] } },
      { id: "i2", identifier: "COD-2", updatedAt: NOW, state: { name: "Dev" }, labels: { pageInfo: { hasNextPage: false }, nodes: [] } },
      { id: "i3", identifier: "COD-3", updatedAt: NOW, state: { name: "Dev" }, labels: { pageInfo: { hasNextPage: false }, nodes: [] } },
    ] } }),
    fetchCompleteClaimCommentsFn: async (_key, id) => {
      hydrated.push(id);
      if (id === "i2") return full;
      if (id === "i3") return [{ id: "old-malformed", createdAt: "2026-01-01T00:00:00.000Z", body: "[auto-sweep-claim v1 broken]" }];
      return [];
    },
  });
  assert.deepEqual(hydrated, ["i1", "i2", "i3"]);
  assert.deepEqual(cards.map((card) => card.identifier), ["COD-1", "COD-2", "COD-3"]);
  assert.ok(cards.every((card) => card.commentsComplete === true));
  assert.equal(claimMigrationSummary(cards).orphanDeclarations, 1);
  assert.equal(claimMigrationSummary(cards).ambiguous, 4);
});

test("claim migration scan rejects incomplete issue-label pages", async () => {
  await assert.rejects(fetchClaimMigrationCards("key", "COD", "project", {
    gqlFn: async () => ({ issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { id: "i1", identifier: "COD-1", updatedAt: NOW, state: { name: "Dev" }, labels: { pageInfo: { hasNextPage: true }, nodes: [] } },
    ] } }),
  }), /labels.*incomplete/i);
});

test("claim migration findings truncate only after a 101st omission and unreadable workspaces count ambiguous", async () => {
  const legacy = (n) => ({ identifier: `COD-${n}`, labelNames: ["dev:in-progress"], commentsComplete: true, comments: [] });
  const report100 = await claimMigrationStatusReport({
    registry: { repos: ["/a"] }, canonicalFn: (v) => v, configFn: () => ({ teamKey: "COD", projectId: "p" }), keyFn: () => "key",
    fetchCardsFn: async () => Array.from({ length: 100 }, (_, i) => legacy(i)),
  });
  assert.equal(report100.findings.length, 100);
  assert.equal(report100.findingsTruncated, false);
  const report101 = await claimMigrationStatusReport({
    registry: { repos: ["/a"] }, canonicalFn: (v) => v, configFn: () => ({ teamKey: "COD", projectId: "p" }), keyFn: () => "key",
    fetchCardsFn: async () => Array.from({ length: 101 }, (_, i) => legacy(i)),
  });
  assert.equal(report101.findings.length, 100);
  assert.equal(report101.findingsTruncated, true);
  const unreadable = await claimMigrationStatusReport({
    registry: { repos: ["/a"] }, canonicalFn: (v) => v, configFn: () => { throw new Error("bad config"); }, keyFn: () => "key",
  });
  assert.equal(unreadable.ambiguous, 1);
  assert.equal(unreadable.findings[0].status, "ambiguous");
});

test("attended claim migration reset proves an exact legacy reset before removing its label", async () => {
  const claim = "dev:in-progress";
  const comments = [];
  const reads = [];
  const card = (labelPresent) => ({ id: "i1", identifier: "COD-1", stateName: "Dev", labelNames: labelPresent ? [claim] : [], labelIds: labelPresent ? { [claim]: "label-id" } : {}, commentsComplete: true, comments: [...comments] });
  let labelPresent = true;
  const result = await resetClaimMigration("key", "COD-1", claim, "legacy", {
    fetchClaimCardFn: async () => { reads.push(labelPresent); return card(labelPresent); },
    addCommentFn: async (_key, _id, body) => comments.push({ id: "reset-id", body, createdAt: "2026-07-11T00:01:00.000Z" }),
    applyLabelEditFn: async (_key, _card, edit) => { assert.deepEqual(edit, { remove: [claim] }); labelPresent = false; },
  });
  assert.equal(result.resetCommentId, "reset-id");
  assert.equal(result.labelRemoved, true);
  assert.deepEqual(reads, [true, true, true, false]);
});

test("attended legacy reset resumes cleanup after a crash without posting a duplicate boundary", async () => {
  const claim = "dev:in-progress";
  const reset = { id: "reset-id", body: claimResetMarker({ claim, target: "legacy", reason: "legacy" }), createdAt: "2026-07-11T00:01:00.000Z" };
  let labelPresent = true;
  let commentsPosted = 0;
  const fetch = async () => ({ id: "i1", identifier: "COD-1", labelNames: labelPresent ? [claim] : [], labelIds: labelPresent ? { [claim]: "label-id" } : {}, commentsComplete: true, comments: [reset] });
  const result = await resetClaimMigration("key", "COD-1", claim, "legacy", {
    fetchClaimCardFn: fetch,
    addCommentFn: async () => { commentsPosted += 1; },
    applyLabelEditFn: async () => { labelPresent = false; },
  });
  assert.equal(commentsPosted, 0);
  assert.equal(result.resetCommentId, "reset-id");
  assert.equal(result.labelRemoved, true);
});

test("attended legacy reset recovers an ambiguous comment-create success and rejects a true write failure", async () => {
  const claim = "dev:in-progress";
  const comments = [];
  let labelPresent = true;
  const fetch = async () => ({ id: "i1", identifier: "COD-1", labelNames: labelPresent ? [claim] : [], labelIds: labelPresent ? { [claim]: "label-id" } : {}, commentsComplete: true, comments: [...comments] });
  const recovered = await resetClaimMigration("key", "COD-1", claim, "legacy", {
    fetchClaimCardFn: fetch,
    addCommentFn: async (_key, _id, body) => {
      comments.push({ id: "reset-after-timeout", body, createdAt: "2026-07-11T00:01:00.000Z" });
      throw new Error("network timeout");
    },
    applyLabelEditFn: async () => { labelPresent = false; },
  });
  assert.equal(recovered.resetCommentId, "reset-after-timeout");

  let removals = 0;
  await assert.rejects(resetClaimMigration("key", "COD-2", claim, "legacy", {
    fetchClaimCardFn: async () => ({ id: "i2", identifier: "COD-2", labelNames: [claim], labelIds: { [claim]: "label-id" }, commentsComplete: true, comments: [] }),
    addCommentFn: async () => { throw new Error("definite write failure"); },
    applyLabelEditFn: async () => { removals += 1; },
  }), /definite write failure/);
  assert.equal(removals, 0);
});

test("attended reset refuses a newer epoch after an old reset and idempotently accepts an exact closed orphan", async () => {
  const claim = "qa:in-progress";
  const legacyReset = { id: "legacy-reset", body: claimResetMarker({ claim, target: "legacy", reason: "legacy" }), createdAt: "2026-07-11T00:00:00.000Z" };
  const newer = { id: "newer", body: claimDeclarationMarker({ claim, ownerToken: "new-owner", declarationId: "new-decl" }), createdAt: "2026-07-11T00:01:00.000Z" };
  let posts = 0;
  await assert.rejects(resetClaimMigration("key", "COD-2", claim, "legacy", {
    fetchClaimCardFn: async () => ({ id: "i2", identifier: "COD-2", labelNames: [claim], labelIds: { [claim]: "label-id" }, commentsComplete: true, comments: [legacyReset, newer] }),
    addCommentFn: async () => { posts += 1; },
  }), /not resettable/i);
  assert.equal(posts, 0);

  const orphanDeclaration = { id: "decl", body: claimDeclarationMarker({ claim, ownerToken: "old-owner", declarationId: "old-decl" }), createdAt: "2026-07-11T00:00:00.000Z" };
  const orphanReset = { id: "orphan-reset", body: claimResetMarker({ claim, target: "old-decl", reason: "orphan-declaration" }), createdAt: "2026-07-11T00:01:00.000Z" };
  const result = await resetClaimMigration("key", "COD-3", claim, "old-decl", {
    fetchClaimCardFn: async () => ({ id: "i3", identifier: "COD-3", labelNames: [], labelIds: {}, commentsComplete: true, comments: [orphanDeclaration, orphanReset] }),
    addCommentFn: async () => { posts += 1; },
  });
  assert.equal(result.resetCommentId, "orphan-reset");
  assert.equal(posts, 0);
});

test("attended migration reader complete-hydrates unlabeled orphan declarations", async () => {
  const comments = [{ id: "old", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: "2026-01-01T00:00:00.000Z" }];
  const card = await fetchCompleteMigrationCard("key", "COD-2", {
    fetchClaimCardFn: async () => ({ id: "i2", identifier: "COD-2", labelNames: [], comments: [], commentsComplete: false }),
    fetchCompleteClaimCommentsFn: async () => comments,
  });
  assert.equal(card.commentsComplete, true);
  assert.deepEqual(card.comments, comments);
});

test("attended claim migration reset accepts only the exact orphan declaration and authoritative reset id", async () => {
  const claim = "qa:in-progress";
  const declaration = { id: "decl-comment", body: claimDeclarationMarker({ claim, ownerToken: "owner", declarationId: "decl-id" }), createdAt: "2026-07-11T00:00:00.000Z" };
  const comments = [declaration];
  const fetch = async () => ({ id: "i2", identifier: "COD-2", stateName: "QA", labelNames: [], labelIds: {}, commentsComplete: true, comments: [...comments] });
  const result = await resetClaimMigration("key", "COD-2", claim, "decl-id", {
    fetchClaimCardFn: fetch,
    addCommentFn: async (_key, _id, body) => comments.push({ id: "our-reset", body, createdAt: "2026-07-11T00:01:00.000Z" }),
  });
  assert.equal(result.resetCommentId, "our-reset");
  await assert.rejects(resetClaimMigration("key", "COD-2", claim, "wrong", { fetchClaimCardFn: async () => ({ ...(await fetch()), comments: [declaration] }) }), /not resettable|target/i);

  const raced = [declaration];
  const converged = await resetClaimMigration("key", "COD-2", claim, "decl-id", {
    fetchClaimCardFn: async () => ({ id: "i2", identifier: "COD-2", stateName: "QA", labelNames: [], labelIds: {}, commentsComplete: true, comments: [...raced] }),
    addCommentFn: async (_key, _id, body) => {
      raced.push({ id: "foreign-reset", body, createdAt: "2026-07-11T00:00:30.000Z" });
      raced.push({ id: "our-reset", body, createdAt: "2026-07-11T00:01:00.000Z" });
    },
  });
  assert.equal(converged.resetCommentId, "foreign-reset");
});

test("attended claim migration reset refuses owned, closed, unclaimed, and ambiguous histories", async () => {
  const claim = "ship:in-progress";
  const declaration = { id: "decl", body: claimDeclarationMarker({ claim, ownerToken: "owner", declarationId: "decl-id" }), createdAt: "2026-07-11T00:00:00.000Z" };
  const close = { id: "close", body: claimCloseMarker({ claim, declarationId: "decl-id", reason: "released" }), createdAt: "2026-07-11T00:01:00.000Z" };
  const cases = [
    { labels: [claim], comments: [declaration], target: "decl-id" },
    { labels: [], comments: [declaration, close], target: "decl-id" },
    { labels: [], comments: [], target: "legacy" },
    { labels: [claim], comments: [{ id: "bad", body: `[auto-sweep-claim v1 claim=${claim} broken]`, createdAt: "2026-07-11T00:00:00.000Z" }], target: "legacy" },
  ];
  for (const value of cases) {
    await assert.rejects(resetClaimMigration("key", "COD-3", claim, value.target, {
      fetchClaimCardFn: async () => ({ id: "i3", identifier: "COD-3", labelNames: value.labels, labelIds: {}, commentsComplete: true, comments: value.comments }),
    }), /not resettable/i);
  }
});
test("countMarkers: only counts markers inside the rolling window", () => {
  const card = { comments: [
    { body: REAPER_TAG, createdAt: hoursAgo(1) },
    { body: REAPER_TAG, createdAt: hoursAgo(10) },
    { body: REAPER_TAG, createdAt: hoursAgo(72) }, // outside 48h
  ] };
  assert.equal(countMarkers(card, REAPER_TAG, NOW), 2);
});

// ── reaper ───────────────────────────────────────────────────────────────────
const claimed = (over, extra = {}) => ({
  id: "i1", identifier: "COD-1", updatedAt: minsAgo(over ? 200 : 2),
  labelNames: ["dev:in-progress", ...(extra.labels || [])],
  commentsComplete: true,
  comments: extra.comments || [],
});
test("reapDecisions: fresh heartbeat is not reaped", () => {
  const card = { id: "i", identifier: "COD-1", updatedAt: minsAgo(2), labelNames: ["dev:in-progress"], commentsComplete: true, comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(2)}]`, createdAt: minsAgo(2) }] };
  assert.deepEqual(reapDecisions([card], SWEEP_CFG.dev, NOW), []);
});
test("reapDecisions: stale claim with no prior reaps is reaped", () => {
  const d = reapDecisions([claimed(true)], SWEEP_CFG.dev, NOW);
  assert.equal(d.length, 1);
  assert.equal(d[0].action, "reap");
});

test("reapDecisions: targets the exact stale declaration and resume protection must match it", () => {
  const card = {
    id: "declared", identifier: "COD-169", updatedAt: minsAgo(1), labelNames: ["dev:in-progress"], commentsComplete: true,
    comments: [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: minsAgo(300) }],
  };
  assert.deepEqual(reapDecisions([card], SWEEP_CFG.dev, NOW, {
    protectedClaim: () => ({ ownerToken: "owner", claimDeclarationId: "other" }),
  })[0].target, "decl");
  assert.equal(reapDecisions([card], SWEEP_CFG.dev, NOW, {
    protectedClaim: () => ({ ownerToken: "owner", claimDeclarationId: "decl" }),
  })[0].action, "protect-resume");
});
test("reapDecisions: escalates to blocked after the 3rd reap within window", () => {
  const card = claimed(true, { comments: [
    { body: REAPER_TAG, createdAt: hoursAgo(2) },
    { body: REAPER_TAG, createdAt: hoursAgo(4) },
  ] });
  const d = reapDecisions([card], SWEEP_CFG.dev, NOW);
  assert.equal(d[0].action, "escalate-crash");
  assert.equal(d[0].count, 3);
});
test("reapDecisions: old reaper markers outside the window do NOT trigger escalation", () => {
  const card = claimed(true, { comments: [
    { body: REAPER_TAG, createdAt: hoursAgo(100) },
    { body: REAPER_TAG, createdAt: hoursAgo(200) },
  ] });
  assert.equal(reapDecisions([card], SWEEP_CFG.dev, NOW)[0].action, "reap");
});
test("reapDecisions: unclaimed card is ignored", () => {
  const card = { id: "i", identifier: "COD-9", updatedAt: minsAgo(500), labelNames: [], comments: [] };
  assert.deepEqual(reapDecisions([card], SWEEP_CFG.dev, NOW), []);
});

// ── bounce loop ──────────────────────────────────────────────────────────────
test("bounceDecisions: escalates after 2 backward bounces in window", () => {
  const card = { id: "i", identifier: "COD-2", labelNames: [], comments: [
    { body: `${BOUNCE_TAG} dev→spec]`, createdAt: hoursAgo(1) },
    { body: `${BOUNCE_TAG} dev→spec]`, createdAt: hoursAgo(5) },
  ] };
  assert.equal(bounceDecisions([card], SWEEP_CFG.dev, NOW)[0].action, "escalate-bounce");
});
test("bounceDecisions: one bounce does not escalate; already-blocked is skipped", () => {
  const one = { id: "a", identifier: "COD-3", labelNames: [], comments: [{ body: `${BOUNCE_TAG} dev→spec]`, createdAt: hoursAgo(1) }] };
  const blocked = { id: "b", identifier: "COD-4", labelNames: ["blocked:needs-user"], comments: [
    { body: `${BOUNCE_TAG} A→B]`, createdAt: hoursAgo(1) }, { body: `${BOUNCE_TAG} A→B]`, createdAt: hoursAgo(2) } ] };
  assert.deepEqual(bounceDecisions([one, blocked], SWEEP_CFG.dev, NOW), []);
});
test("bounceDecisions: two DIFFERENT state-pairs do NOT escalate (only same-pair oscillation does)", () => {
  const card = { id: "c", identifier: "COD-5", labelNames: [], comments: [
    { body: `${BOUNCE_TAG} Dev→Spec]`, createdAt: hoursAgo(1) },
    { body: `${BOUNCE_TAG} QA→Dev]`, createdAt: hoursAgo(2) },
  ] };
  assert.deepEqual(bounceDecisions([card], SWEEP_CFG.dev, NOW), []);
});
test("bouncePairKey: parses <from>→<to> (with spaces) into an unordered pair; A→B == B→A", () => {
  assert.equal(bouncePairKey(`${BOUNCE_TAG} Dev→Spec]`), bouncePairKey(`${BOUNCE_TAG} Spec→Dev]`));
  assert.equal(bouncePairKey("no marker here"), null);
});

// ── actionable count ─────────────────────────────────────────────────────────
test("countActionable: excludes blocked/manual-only and live-claimed, counts released + plain", () => {
  const now = NOW;
  const cards = [
    { id: "plain", updatedAt: minsAgo(1), labelNames: [], comments: [] },
    { id: "blocked", updatedAt: minsAgo(1), labelNames: ["blocked:needs-user"], comments: [] },
    { id: "manual", updatedAt: minsAgo(1), labelNames: ["sweep:manual-only"], comments: [] },
    { id: "live", updatedAt: minsAgo(1), labelNames: ["dev:in-progress"], comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)}]`, createdAt: minsAgo(1) }] },
    { id: "released", updatedAt: minsAgo(1), labelNames: ["dev:in-progress"], comments: [] },
  ].map(dependencyReadyCard);
  // released id is in the released set (its claim was just dropped this tick)
  assert.equal(countActionable(cards, SWEEP_CFG.dev, now, new Set(["released"])), 2); // plain + released
});
test("countActionable: a stale-heartbeat claim that wasn't released still counts (it's not live)", () => {
  const card = dependencyReadyCard({ id: "x", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], comments: [] });
  assert.equal(countActionable([card], SWEEP_CFG.dev, NOW, new Set()), 1);
});
test("actionableCards: live dev claim in Dev is not double-dispatched", () => {
  const card = dependencyReadyCard({
    id: "active",
    state: { name: "Dev" },
    updatedAt: minsAgo(1),
    labelNames: ["dev:in-progress"],
    comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)}]`, createdAt: minsAgo(1) }],
  });
  assert.deepEqual(actionableCards([card], SWEEP_CFG.dev, NOW), []);
});
test("actionableCards: stale dev claim in Dev becomes actionable", () => {
  const card = dependencyReadyCard({ id: "stale", state: { name: "Dev" }, updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], comments: [] });
  assert.deepEqual(actionableCards([card], SWEEP_CFG.dev, NOW).map((c) => c.id), ["stale"]);
});
test("actionableCards: a closed epoch keeps its label reserved until verified cleanup", () => {
  const card = dependencyReadyCard({
    id: "closing",
    state: { name: "Dev" },
    updatedAt: minsAgo(300),
    labelNames: ["dev:in-progress"],
    commentsComplete: true,
    comments: [
      { id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "old", declarationId: "old-decl" }), createdAt: minsAgo(400) },
      { id: "c2", body: claimCloseMarker({ claim: "dev:in-progress", declarationId: "old-decl", reason: "released" }), createdAt: minsAgo(300) },
    ],
  });
  assert.deepEqual(actionableCards([card], SWEEP_CFG.dev, NOW), []);
  assert.deepEqual(actionableCards([card], SWEEP_CFG.dev, NOW, new Set([card.id])).map((item) => item.id), [card.id]);
});

test("retryCooldown requires complete declaration, retry, and close provenance", () => {
  const owner = "owner-1";
  const declarationId = "decl-1";
  const comments = [
    { id: "decl", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: owner, declarationId }), createdAt: minsAgo(3) },
    { id: "retry", body: `${RETRY_TAG} v1 claim=dev:in-progress owner=${owner} declaration=${declarationId}] ${ORPHAN_TAG} terminal failure observed`, createdAt: minsAgo(2) },
    { id: "close", body: claimCloseMarker({ claim: "dev:in-progress", declarationId, reason: "terminal" }), createdAt: minsAgo(1) },
  ];
  const card = dependencyReadyCard({ id: "cooling", updatedAt: minsAgo(1), labelNames: [], commentsComplete: true, comments });
  assert.equal(retryCooldown(card, SWEEP_CFG.dev, NOW).active, true);
  assert.equal(retryCooldown(card, SWEEP_CFG.spec, NOW), null);
  assert.deepEqual(actionableCards([card], SWEEP_CFG.dev, NOW), []);
  assert.equal(retryCooldown({ ...card, commentsComplete: false }, SWEEP_CFG.dev, NOW), null);
});

test("retryCooldown uses Linear comment order when a client heartbeat clock is ahead", () => {
  const owner = "owner-skew";
  const declarationId = "decl-skew";
  const comments = [
    { id: "decl", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: owner, declarationId }), createdAt: minsAgo(4) },
    { id: "beat", body: claimHeartbeatMarker({ claim: "dev:in-progress", declarationId, at: new Date(NOW + 5 * 60_000).toISOString() }), createdAt: minsAgo(3) },
    { id: "retry", body: `${RETRY_TAG} v1 claim=dev:in-progress owner=${owner} declaration=${declarationId}]`, createdAt: minsAgo(2) },
    { id: "close", body: claimCloseMarker({ claim: "dev:in-progress", declarationId, reason: "terminal" }), createdAt: minsAgo(1) },
  ];
  const card = dependencyReadyCard({ id: "clock-skew", labelNames: [], commentsComplete: true, comments });
  assert.equal(retryCooldown(card, SWEEP_CFG.dev, NOW)?.active, true);
});

test("retryCooldown rejects malformed, mismatched, stale, future, and superseded epochs", () => {
  const owner = "owner-1";
  const declarationId = "decl-1";
  const declaration = { id: "decl", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: owner, declarationId }), createdAt: minsAgo(100) };
  const close = { id: "close", body: claimCloseMarker({ claim: "dev:in-progress", declarationId, reason: "terminal" }), createdAt: minsAgo(1) };
  const valid = (id, body, createdAt, extra = []) => dependencyReadyCard({ id, updatedAt: minsAgo(1), labelNames: [], commentsComplete: true, comments: [declaration, { id, body, createdAt }, close, ...extra] });
  const cases = [
    valid("quoted", `>${RETRY_TAG} v1 claim=dev:in-progress owner=${owner} declaration=${declarationId}]`, minsAgo(2)),
    valid("wrong-claim", `${RETRY_TAG} v1 claim=qa:in-progress owner=${owner} declaration=${declarationId}]`, minsAgo(2)),
    valid("wrong-owner", `${RETRY_TAG} v1 claim=dev:in-progress owner=other declaration=${declarationId}]`, minsAgo(2)),
    valid("wrong-declaration", `${RETRY_TAG} v1 claim=dev:in-progress owner=${owner} declaration=other]`, minsAgo(2)),
    valid("future", `${RETRY_TAG} v1 claim=dev:in-progress owner=${owner} declaration=${declarationId}]`, new Date(NOW + 60_000).toISOString()),
    valid("expired", `${RETRY_TAG} v1 claim=dev:in-progress owner=${owner} declaration=${declarationId}]`, minsAgo(91)),
    valid("superseded", `${RETRY_TAG} v1 claim=dev:in-progress owner=${owner} declaration=${declarationId}]`, minsAgo(2), [
      { id: "new", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-2", declarationId: "decl-2" }), createdAt: minsAgo(0.5) },
    ]),
  ];
  for (const card of cases) assert.equal(retryCooldown(card, SWEEP_CFG.dev, NOW), null, card.id);
});

test("retryCooldown uses stable comment-id tie breaking and claim confirmation refuses the cooling epoch", () => {
  const owner = "owner-1";
  const declarationId = "decl-1";
  const createdAt = minsAgo(1);
  const card = dependencyReadyCard({
    id: "tie", stateName: "Dev", labelNames: ["dev:in-progress"], updatedAt: createdAt, commentsComplete: true,
    comments: [
      { id: "decl", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: owner, declarationId }), createdAt: minsAgo(3) },
      { id: "b", body: `${RETRY_TAG} v1 claim=dev:in-progress owner=${owner} declaration=${declarationId}]`, createdAt },
      { id: "a", body: `${RETRY_TAG} v1 claim=dev:in-progress owner=${owner} declaration=${declarationId}]`, createdAt },
      { id: "close", body: claimCloseMarker({ claim: "dev:in-progress", declarationId, reason: "terminal" }), createdAt: new Date(NOW - 30_000).toISOString() },
    ],
  });
  assert.equal(retryCooldown(card, SWEEP_CFG.dev, NOW).commentId, "a");
  assert.equal(claimConfirmed(card, SWEEP_CFG.dev, { ownerToken: owner, declarationId }, ["Dev"], NOW), false);
});
test("actionableCards: excludes cards with live foreign in-progress claims", () => {
  const card = dependencyReadyCard({
    id: "ship",
    updatedAt: minsAgo(1),
    labelNames: ["fast-path:eligible", "dev:in-progress"],
    comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)}]`, createdAt: minsAgo(1) }],
  });
  assert.deepEqual(actionableCards([card], SWEEP_CFG.ship, NOW), []);
});
test("actionableCards: allows cards with stale foreign in-progress claims after reaper release", () => {
  const card = dependencyReadyCard({
    id: "ship",
    updatedAt: minsAgo(300),
    labelNames: ["fast-path:eligible", "dev:in-progress"],
    comments: [],
  });
  assert.deepEqual(actionableCards([card], SWEEP_CFG.ship, NOW).map((c) => c.id), ["ship"]);
});
test("actionableCards excludes unresolved and incomplete dependencies", () => {
  const cfg = SWEEP_CFG.dev;
  const ready = { id: "ready", labelNames: [], comments: [], blockers: [], blockersComplete: true };
  const blocked = { id: "blocked", labelNames: [], comments: [], blockers: [{ identifier: "COD-1", stateName: "Dev" }], blockersComplete: true };
  const partial = { id: "partial", labelNames: [], comments: [], blockers: [], blockersComplete: false };
  assert.deepEqual(actionableCards([ready, blocked, partial], cfg, NOW).map((c) => c.id), ["ready"]);
});
test("actionableCards rejects cards with absent relation metadata", () => {
  const missing = { id: "missing", labelNames: [], comments: [] };
  assert.deepEqual(actionableCards([missing], SWEEP_CFG.dev, NOW), []);
});
test("dependency telemetry: summaries are bounded and contain only stable identity/state fields", () => {
  const blockers = Array.from({ length: MAX_DEPENDENCY_DEFERRED_ISSUES + 5 }, (_, index) => ({
    identifier: `COD-${index}`,
    stateName: "QA",
    title: `secret blocker title ${index}`,
  }));
  const card = { identifier: "COD-99", title: "secret deferred title", comments: [{ body: "secret comment" }] };
  const summary = dependencyDeferredIssue({
    sourceWorkspace: "/source/app",
    sweep: "dev",
    card,
    dependency: { reason: "blocked", unresolved: blockers },
  });

  assert.equal(summary.blockers.length, MAX_DEPENDENCY_DEFERRED_ISSUES);
  assert.deepEqual(summary.blockers[0], { identifier: "COD-0", stateName: "QA" });
  assert.deepEqual(Object.keys(summary), ["sourceWorkspace", "sweep", "issueIdentifier", "reason", "blockers"]);
  assert.doesNotMatch(JSON.stringify(summary), /secret/);
});

test("bounded dependency cycles: self-cycle annotates the card and keeps it ineligible", () => {
  const card = dependencyReadyCard({
    id: "a-id", identifier: "COD-1", labelNames: [], comments: [],
    blockers: [{ id: "a-id", identifier: "COD-1", stateName: "Dev" }],
  });

  const result = annotateBoundedDependencyCycles([card]);

  assert.deepEqual(result.cycles, [{
    kind: "dependency-cycle",
    bounded: true,
    members: ["COD-1"],
    edges: [{ from: "COD-1", to: "COD-1" }],
    stableTarget: "COD-1",
    message: "visible dependency cycle: COD-1 -> COD-1",
  }]);
  assert.equal(result.cards[0].dependencyAnomaly, result.cycles[0]);
  assert.equal(result.cards[0].dependency.eligible, false);
  assert.equal(result.cards[0].dependency.reason, "dependency-cycle");
  assert.deepEqual(actionableCards(result.cards, SWEEP_CFG.dev, NOW), []);
});

test("bounded dependency cycles: two-card cycle annotates every involved card", () => {
  const cards = [
    dependencyReadyCard({
      id: "a-id", identifier: "COD-1", labelNames: [], comments: [],
      blockers: [{ id: "b-id", identifier: "COD-2", stateName: "QA" }],
    }),
    dependencyReadyCard({
      id: "b-id", identifier: "COD-2", labelNames: [], comments: [],
      blockers: [{ id: "a-id", identifier: "COD-1", stateName: "Dev" }],
    }),
  ];

  const result = annotateBoundedDependencyCycles(cards);

  assert.equal(result.cycles.length, 1);
  assert.deepEqual(result.cycles[0].members, ["COD-1", "COD-2"]);
  assert.deepEqual(result.cycles[0].edges, [
    { from: "COD-1", to: "COD-2" },
    { from: "COD-2", to: "COD-1" },
  ]);
  assert.deepEqual(result.cards.map((card) => card.dependencyAnomaly?.stableTarget), ["COD-1,COD-2", "COD-1,COD-2"]);
  assert.deepEqual(actionableCards(result.cards, SWEEP_CFG.dev, NOW), []);
});

test("bounded dependency cycles: an acyclic active-queue chain has no anomaly", () => {
  const cards = [
    dependencyReadyCard({ id: "a-id", identifier: "COD-1", blockers: [{ id: "b-id", identifier: "COD-2", stateName: "QA" }] }),
    dependencyReadyCard({ id: "b-id", identifier: "COD-2", blockers: [{ id: "c-id", identifier: "COD-3", stateName: "Spec" }] }),
    dependencyReadyCard({ id: "c-id", identifier: "COD-3", blockers: [] }),
  ];

  const result = annotateBoundedDependencyCycles(cards);

  assert.deepEqual(result.cycles, []);
  assert.equal(result.cards.some((card) => card.dependencyAnomaly), false);
});
test("applyDecisionsInMemory: a reaped card becomes actionable; an escalated card does NOT", () => {
  // Two stale-claim cards: one plain reap, one hitting the 3rd reap (escalate-crash).
  const reapCard = dependencyReadyCard({ id: "r", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], commentsComplete: true, comments: [] });
  const escCard = dependencyReadyCard({ id: "e", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], commentsComplete: true, comments: [
    { body: REAPER_TAG, createdAt: hoursAgo(2) }, { body: REAPER_TAG, createdAt: hoursAgo(4) } ] });
  const cards = [reapCard, escCard];
  const reaps = reapDecisions(cards, SWEEP_CFG.dev, NOW);
  applyDecisionsInMemory(cards, reaps, []);
  const ids = actionableCards(cards, SWEEP_CFG.dev, NOW).map((c) => c.id);
  assert.deepEqual(ids, ["r"]); // reaped one is actionable; escalated one is now blocked
  assert.ok(escCard.labelNames.includes("blocked:needs-user"));
  assert.ok(!reapCard.labelNames.includes("dev:in-progress"));
});

test("sortByBoardPosition: highest Linear sortOrder is top of column", () => {
  const cards = [
    { id: "low", identifier: "COD-2", sortOrder: -20 },
    { id: "missing", identifier: "COD-3" },
    { id: "high", identifier: "COD-1", sortOrder: 5 },
  ].map(dependencyReadyCard);
  assert.deepEqual(sortByBoardPosition(cards).map((c) => c.id), ["high", "low", "missing"]);
  assert.equal(boardOrderValue(cards[2]), 5);
  assert.equal(boardOrderValue(cards[1]), Number.NEGATIVE_INFINITY);
});

test("sortByBoardPosition: applies after blocked and live-claim filtering", () => {
  const cards = [
    { id: "bottom", identifier: "COD-1", sortOrder: 1, updatedAt: minsAgo(1), labelNames: [], comments: [] },
    { id: "blocked-top", identifier: "COD-2", sortOrder: 100, updatedAt: minsAgo(1), labelNames: ["blocked:needs-user"], comments: [] },
    { id: "live-top", identifier: "COD-3", sortOrder: 90, updatedAt: minsAgo(1), labelNames: ["dev:in-progress"], comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)}]`, createdAt: minsAgo(1) }] },
    { id: "top", identifier: "COD-4", sortOrder: 10, updatedAt: minsAgo(1), labelNames: [], comments: [] },
  ].map(dependencyReadyCard);
  assert.deepEqual(sortByBoardPosition(actionableCards(cards, SWEEP_CFG.dev, NOW)).map((c) => c.id), ["top", "bottom"]);
});

// ── dispatch selection ───────────────────────────────────────────────────────
test("selectDispatch: qa beats dev beats spec", () => {
  const pick = selectDispatch([
    { sweep: "spec", count: 5, topCard: { sortOrder: 1 } },
    { sweep: "qa", count: 1, topCard: { sortOrder: 100 } },
    { sweep: "dev", count: 3, topCard: { sortOrder: 1 } },
  ]);
  assert.equal(pick.sweep, "qa");
});
test("selectDispatch: within a sweep, top board card first; zero-count ignored; none → null", () => {
  const pick = selectDispatch([
    { sweep: "dev", count: 2, topCard: { identifier: "COD-1", sortOrder: 5 } },
    { sweep: "dev", count: 2, topCard: { identifier: "COD-2", sortOrder: 50 } },
  ]);
  assert.equal(pick.topCard.identifier, "COD-2");
  assert.equal(selectDispatch([{ sweep: "dev", count: 0, topCard: { sortOrder: 1 } }]), null);
});
test("admission priority: Ship, stage, same-stage handoff, board, rotation, and identifier form a total order", () => {
  const demands = [
    { stage: "spec", trigger: "handoff", boardOrder: 99, rotationRank: 0, issueIdentifier: "COD-9" },
    { stage: "dev", trigger: "handoff", boardOrder: 1, rotationRank: 0, issueIdentifier: "COD-8" },
    { stage: "qa", trigger: "refill", boardOrder: 90, rotationRank: 0, issueIdentifier: "COD-7" },
    { stage: "qa", trigger: "initial", boardOrder: 100, rotationRank: 1, issueIdentifier: "COD-6" },
    { stage: "qa", trigger: "handoff", boardOrder: 1, rotationRank: 9, issueIdentifier: "COD-5" },
    { stage: "ship", trigger: "initial", boardOrder: 0, rotationRank: 9, issueIdentifier: "COD-4" },
  ];
  assert.deepEqual(demands.sort(compareAdmissionDemand).map((d) => d.issueIdentifier), [
    "COD-4", "COD-5", "COD-6", "COD-7", "COD-8", "COD-9",
  ]);

  const ties = [
    { stage: "dev", trigger: "refill", boardOrder: 5, rotationRank: 1, issueIdentifier: "COD-2" },
    { stage: "dev", trigger: "initial", boardOrder: 5, rotationRank: 0, issueIdentifier: "COD-9" },
    { stage: "dev", trigger: "initial", boardOrder: 5, rotationRank: 0, issueIdentifier: "COD-1" },
  ];
  assert.deepEqual(ties.sort(compareAdmissionDemand).map((d) => d.issueIdentifier), ["COD-1", "COD-9", "COD-2"]);
});
test("admission priority: a lower-stage handoff never leapfrogs a higher stage", () => {
  assert.ok(compareAdmissionDemand(
    { stage: "dev", trigger: "handoff", issueIdentifier: "COD-1" },
    { stage: "qa", trigger: "refill", issueIdentifier: "COD-2" },
  ) > 0);
});
test("learning admission is explicitly lower than Spec and demand identity is registry-scoped", () => {
  const stages = ["learning", "spec", "dev", "qa", "ship"].map((stage) => ({
    stage,
    trigger: stage === "learning" ? "learning-due" : "initial",
    issueIdentifier: stage,
  }));
  assert.deepEqual(stages.sort(compareAdmissionDemand).map((item) => item.stage), ["ship", "qa", "dev", "spec", "learning"]);
  const a = buildLearningDemand({ repos: ["/a"] }, { registryPath: "/state/registry.json", canonicalFn: (value) => value });
  const b = buildLearningDemand({ repos: ["/a", "/b"] }, { registryPath: "/state/registry.json", canonicalFn: (value) => value });
  assert.equal(a.issueIdentifier, b.issueIdentifier);
  assert.deepEqual({ stage: a.stage, trigger: a.trigger }, { stage: "learning", trigger: "learning-due" });
});

test("capacity ledger accepts only the exact learning pair and enforces one live registry singleton", () => {
  let stored = null;
  let id = 0;
  const ledger = createCapacityLedger({
    readJsonFn: () => structuredClone(stored),
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: () => true,
    randomUUID: () => `learning-${++id}`,
  });
  const demand = buildLearningDemand({}, { registryPath: "/state/registry.json", canonicalFn: (value) => value });
  const first = ledger.reserve(demand);
  assert.ok(first);
  assert.equal(ledger.reserve(demand), null);
  assert.throws(() => ledger.reserve({ ...demand, trigger: "initial" }), /invalid trigger|learning/i);
  assert.throws(() => ledger.reserve({ ...demand, stage: "dev" }), /invalid trigger|learning/i);
  first.release();
  assert.ok(ledger.reserve(demand));
});

test("capacity restart keeps a live learning child and prunes a dead singleton", () => {
  const entry = {
    token: "learning-live", parentPid: 10, childPid: 20,
    issueIdentifier: "factory-learning:registry", workspace: "/state/registry.json",
    stage: "learning", trigger: "learning-due", reservedAt: "2026-07-10T00:00:00.000Z",
  };
  let stored = { version: 1, entries: [entry] };
  const live = createCapacityLedger({
    readJsonFn: () => structuredClone(stored),
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: (pid) => pid === 20,
  }).reconcile();
  assert.deepEqual(live.entries, [entry]);
  const dead = createCapacityLedger({
    readJsonFn: () => structuredClone(stored),
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: () => false,
  }).reconcile();
  assert.equal(dead.active, 0);
});

test("learning synthesis commands and child env deny capabilities for Codex and Claude", () => {
  const common = {
    tempDir: "/isolated/tmp", evidencePath: "/isolated/tmp/evidence.json",
    schemaPath: "/isolated/tmp/schema.json", outputPath: "/isolated/tmp/output.json",
  };
  const codex = buildLearningSynthesisCommand({ ...common, runtime: "codex" });
  assert.equal(codex.cwd, common.tempDir);
  for (const pair of [["--cd", common.tempDir], ["--sandbox", "read-only"], ["--output-schema", common.schemaPath], ["--output-last-message", common.outputPath]]) {
    const index = codex.args.indexOf(pair[0]);
    assert.equal(codex.args[index + 1], pair[1]);
  }
  for (const flag of ["--ephemeral", "--ignore-user-config", "--skip-git-repo-check"]) assert.ok(codex.args.includes(flag), flag);
  const claude = buildLearningSynthesisCommand({ ...common, runtime: "claude", emptyMcpPath: "/isolated/tmp/mcp.json" });
  for (const flag of ["--safe-mode", "--bare", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(claude.args.includes(flag), flag);
  assert.equal(claude.args[claude.args.indexOf("--mcp-config") + 1], "/isolated/tmp/mcp.json");
  assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "");
  assert.equal(claude.args[claude.args.indexOf("--json-schema") + 1], common.schemaPath);
  const env = learningChildEnvironment({
    PATH: "/bin", LANG: "en_US.UTF-8", LC_ALL: "C", SSL_CERT_FILE: "/certs.pem",
    LINEAR_API_KEY: "secret", OPENAI_API_KEY: "secret", CUSTOM_TOKEN: "secret", REPO_VALUE: "secret",
  }, { tempDir: common.tempDir });
  assert.deepEqual(env, {
    PATH: "/bin", LANG: "en_US.UTF-8", LC_ALL: "C", SSL_CERT_FILE: "/certs.pem",
    HOME: common.tempDir, TMPDIR: common.tempDir,
  });
});

test("bounded learning index reports malformed and truncated evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-read-index-"));
  fs.writeFileSync(path.join(dir, "20260710.jsonl"), [
    JSON.stringify({ cardRunId: "one", endedAt: "2026-07-10T10:00:00.000Z" }),
    "malformed",
    JSON.stringify({ cardRunId: "two", endedAt: "2026-07-10T11:00:00.000Z" }),
  ].join("\n") + "\n");
  const result = readLearningRunIndex(dir, { maxRecords: 1, maxFiles: 1, maxBytesPerFile: 10_000 });
  assert.equal(result.runRecords.length, 1);
  assert.ok(result.coverageGaps.some((gap) => /malformed/.test(gap.reason)));
  assert.ok(result.coverageGaps.some((gap) => /record count/.test(gap.reason)));
});

test("post-delivery learning reserves directly without same-repo or observation seams and releases in finally", async () => {
  let reserved = 0;
  let released = 0;
  const result = await runPostDeliveryLearning({
    registry: { learning: { enabled: true, runner: true } },
    dueDecisions: { due: true },
    findings: [{ fingerprint: "known", confidence: "medium" }],
    ledger: {
      reserve: (demand) => {
        reserved += 1;
        assert.equal(demand.stage, "learning");
        return { attachChildPid: () => true, release: () => { released += 1; } };
      },
    },
    dispatchFn: async (_input, { onSpawn }) => {
      onSpawn(123);
      throw new Error("model unavailable");
    },
    deterministicFn: (findings, error) => ({ mode: "deterministic", findings, synthesisUnavailable: error.message }),
  });
  assert.equal(reserved, 1);
  assert.equal(released, 1);
  assert.equal(result.mode, "deterministic");
  assert.match(result.synthesisUnavailable, /model unavailable/);
});

test("post-delivery learning skips optional synthesis when unconfigured and applies bounded annotations when enabled", async () => {
  const base = {
    registry: { learning: { enabled: true, runner: true } },
    dueDecisions: { due: true },
    findings: [{ rootFingerprint: "root-a", confidence: "high" }],
    ledger: { reserve: () => ({ attachChildPid: () => true, release: () => {} }) },
  };
  let written;
  const deterministic = await runPostDeliveryLearning({
    ...base,
    dispatchFn: null,
    writerFn: async ({ findings }) => { written = findings; return { confirmed: 0 }; },
  });
  assert.equal(deterministic.mode, "deterministic");
  assert.equal(written[0].synthesisAnnotation, undefined);

  const synthesized = await runPostDeliveryLearning({
    ...base,
    dispatchFn: async () => ({ mode: "synthesized", available: true, annotations: [{ rootFingerprint: "root-a", summary: "Check the shared retry path." }] }),
    writerFn: async ({ findings }) => { written = findings; return { confirmed: 0 }; },
  });
  assert.equal(synthesized.mode, "synthesized");
  assert.equal(written[0].synthesisAnnotation, "Check the shared retry path.");
});

test("learning issue comments paginate past 100 and fail closed on cursor cycles or partial data", async () => {
  const pages = [
    { comments: { nodes: Array.from({ length: 100 }, (_, index) => ({ id: `c${index}`, body: "ordinary" })), pageInfo: { hasNextPage: true, endCursor: "next" } } },
    { comments: { nodes: [{ id: "marker", body: "[factory-learning root=root-a generation=0]\nFresh occurrences: e1" }], pageInfo: { hasNextPage: false, endCursor: null } } },
  ];
  let call = 0;
  const comments = await fetchLearningIssueComments("key", "issue-1", { gqlFn: async () => ({ issue: pages[call++] }) });
  assert.equal(comments.length, 101);
  assert.equal(comments.at(-1).id, "marker");

  await assert.rejects(fetchLearningIssueComments("key", "issue-1", { gqlFn: async () => ({
    issue: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } },
  }) }), /pagination.*incomplete|cursor/i);
  await assert.rejects(fetchLearningIssueComments("key", "issue-1", { gqlFn: async () => ({
    data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    errors: [{ message: "partial" }],
  }) }), /partial GraphQL/i);
});

test("learning recurrence relations paginate and fail closed on incomplete confirmation", async () => {
  let page = 0;
  assert.equal(await learningRelationExists("key", "new", "done", { gqlFn: async () => {
    page += 1;
    return { issue: { inverseRelations: page === 1
      ? { nodes: [{ type: "related", issue: { id: "other" } }], pageInfo: { hasNextPage: true, endCursor: "next" } }
      : { nodes: [{ type: "related", issue: { id: "new" } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
  } }), true);

  await assert.rejects(learningRelationExists("key", "new", "done", { gqlFn: async () => ({
    issue: { inverseRelations: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } },
  }) }), /pagination incomplete|cursor cycle/i);
});

test("learning issue discovery paginates, scans stable markers, and rejects incomplete pages", async () => {
  let page = 0;
  const result = await fetchLearningIssues("key", { teamKey: "COD", projectId: "project-1" }, {
    gqlFn: async (query) => {
      if (query.includes("comments(first:100")) return { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      page += 1;
      return { issues: {
        nodes: page === 1 ? [{ id: "one", identifier: "COD-1", description: "[factory-learning root=root-a generation=0]", state: { name: "Dev" }, labels: { nodes: [] } }] : [],
        pageInfo: page === 1 ? { hasNextPage: true, endCursor: "p2" } : { hasNextPage: false, endCursor: null },
      } };
    },
  });
  assert.equal(result[0].rootFingerprint, "root-a");
  assert.equal(result[0].generation, 0);
  assert.deepEqual(result[0].occurrenceIds, []);
});

test("learning issue discovery restores deterministic evaluation metadata and confirmed outcomes", async () => {
  const description = [
    "## Acceptance metric", JSON.stringify({ name: "failureRate", direction: "decrease", target: 0.2 }),
    "## Baseline", JSON.stringify({ value: 0.8, unit: "ratio" }),
    "## Evaluation window", JSON.stringify({ durationDays: 7 }),
    "[factory-learning root=root-a generation=0]",
  ].join("\n\n");
  const result = await fetchLearningIssues("key", { teamKey: "COD", projectId: "project-1" }, {
    gqlFn: async (query) => query.includes("comments(first:100")
      ? { issue: { comments: { nodes: [{ id: "outcome", body: "[factory-learning outcome root=root-a generation=0 status=verified-improvement]", createdAt: "2026-07-09T00:00:00.000Z" }], pageInfo: { hasNextPage: false, endCursor: null } } } }
      : { issues: { nodes: [{ id: "one", identifier: "COD-1", description, completedAt: "2026-07-01T00:00:00.000Z", state: { name: "Done" }, labels: { nodes: [{ id: "prov", name: "factory:learning-generated" }] } }], pageInfo: { hasNextPage: false, endCursor: null } } },
  });
  assert.deepEqual(result[0].evaluationMetadata, {
    acceptanceMetric: { name: "failureRate", direction: "decrease", target: 0.2 },
    baseline: { value: 0.8, unit: "ratio" },
    evaluationWindow: { durationDays: 7 },
  });
  assert.equal(result[0].completedAt, "2026-07-01T00:00:00.000Z");
  assert.deepEqual(result[0].outcome, { status: "verified-improvement", evaluatedAt: "2026-07-09T00:00:00.000Z" });
  assert.equal(result[0].outcomeStatus, "verified-improvement");
});

test("learning evaluations persist active windows and confirm exactly one terminal outcome after timeout", async () => {
  const ownership = { scope: "workspace", contributors: [{ sourceWorkspace: "/source/app", projectId: "project-1", repoEntry: "app" }] };
  const issue = {
    id: "done", identifier: "COD-1", stateName: "Done", labelNames: ["factory:learning-generated"],
    rootFingerprint: "root-a", generation: 0, completedAt: "2026-07-01T00:00:00.000Z", occurrenceIds: ["e1"], comments: [],
    evaluationMetadata: {
      acceptanceMetric: { name: "failureRate", direction: "decrease", target: 0.2, ownership },
      baseline: { value: 0.8, unit: "ratio" },
      evaluationWindow: { durationDays: 7 },
    },
  };
  const firstState = new Map();
  const firstStore = { setEvaluation: (id, value) => { firstState.set(id, structuredClone(value)); return value; } };
  const early = await executeLearningEvaluations({
    issues: [issue], stateStore: firstStore,
    snapshot: { capturedThrough: "2026-07-05T00:00:00.000Z", observations: [], coverage: { complete: true, gaps: [] } },
  }, { fetchIssuesFn: async () => [issue], addCommentFn: async () => assert.fail("not due must not comment") });
  assert.equal(early.active, 1);
  assert.equal(firstState.get("root-a:0").status, "active");
  assert.equal(firstState.get("root-a:0").windowEndsAt, "2026-07-08T00:00:00.000Z");

  let commentAttempts = 0;
  const dueSnapshot = {
    capturedThrough: "2026-07-09T00:00:00.000Z",
    observations: [{ at: "2026-07-07T12:00:00.000Z", sourceWorkspace: "/source/app", projectId: "project-1", repoEntry: "app", metrics: { failureRate: 0.1 } }],
    qualifiedFindings: [], coverage: { complete: true, gaps: [] },
  };
  const due = await executeLearningEvaluations({ issues: [issue], stateStore: firstStore, snapshot: dueSnapshot }, {
    fetchIssuesFn: async () => [issue],
    addCommentFn: async (_issueId, body) => {
      commentAttempts += 1;
      const status = body.match(/status=([^\]]+)/)[1];
      issue.comments.push({ body, createdAt: dueSnapshot.capturedThrough });
      issue.outcome = { status, evaluatedAt: dueSnapshot.capturedThrough };
      issue.outcomeStatus = status;
      throw new Error("comment timeout after success");
    },
  });
  assert.equal(due.confirmed, 1);
  assert.equal(commentAttempts, 1);
  assert.equal(firstState.get("root-a:0").status, "verified-improvement");

  const restored = new Map();
  const restoredResult = await executeLearningEvaluations({
    issues: [issue], stateStore: { setEvaluation: (id, value) => { restored.set(id, structuredClone(value)); return value; } }, snapshot: dueSnapshot,
  }, { fetchIssuesFn: async () => [issue], addCommentFn: async () => assert.fail("confirmed outcome must not duplicate") });
  assert.equal(restoredResult.restored, 1);
  assert.equal(restored.get("root-a:0").status, "verified-improvement");
  assert.equal(commentAttempts, 1);
});

test("production learning cycle evaluates generated Done cards even when no detector finding remains", async () => {
  const ownership = { scope: "workspace", contributors: [{ sourceWorkspace: "/source/app", projectId: "project-1", repoEntry: "app" }] };
  const issue = {
    id: "done", identifier: "COD-1", stateName: "Done", labelNames: ["factory:learning-generated"],
    rootFingerprint: "fixed-root", generation: 0, completedAt: "2026-07-01T00:00:00.000Z", occurrenceIds: ["old"], comments: [],
    evaluationMetadata: {
      acceptanceMetric: { name: "failureRate", direction: "decrease", target: 0.2, ownership },
      baseline: { value: 0.8 }, evaluationWindow: { durationDays: 7 },
    },
  };
  const evaluations = new Map();
  const stateStore = {
    setEvaluation: (id, value) => { evaluations.set(id, structuredClone(value)); return value; },
    stageWindow: () => assert.fail("no finding means no mutation WAL"),
    confirmMutation: () => assert.fail("no finding means no mutation confirmation"),
    commitLens: () => assert.fail("no finding means no lens commit"),
  };
  let comments = 0;
  const result = await executeLearningCycleWrites({
    findings: [],
    workspaces: [{ sourceAnchorPath: "/source/app", apiKey: "key", config: { teamKey: "COD", projectId: "project-1" } }],
    registry: { learning: { maxNewCardsPerRun: 6 } },
    stateStore,
    capturedThrough: "2026-07-09T00:00:00.000Z",
    snapshot: {
      capturedThrough: "2026-07-09T00:00:00.000Z",
      observations: [{ at: "2026-07-07T00:00:00.000Z", sourceWorkspace: "/source/app", projectId: "project-1", repoEntry: "app", metrics: { failureRate: 0.1 } }],
      qualifiedFindings: [], coverage: { complete: true, gaps: [] },
    },
  }, {
    fetchIssuesFn: async () => [issue],
    addCommentFn: async (_issueId, body) => {
      comments += 1;
      issue.comments.push({ body, createdAt: "2026-07-09T00:00:00.000Z" });
      issue.outcomeStatus = "verified-improvement";
      issue.outcome = { status: "verified-improvement", evaluatedAt: "2026-07-09T00:00:00.000Z" };
    },
  });
  assert.equal(result.evaluations.confirmed, 1);
  assert.equal(result.mutations, 0);
  assert.equal(comments, 1);
  assert.equal(evaluations.get("fixed-root:0").status, "verified-improvement");
});

test("production learning cycle advances a due zero-mutation lens watermark", async () => {
  const calls = [];
  const stateStore = {
    setEvaluation: () => assert.fail("no generated Done issue to evaluate"),
    stageWindow: (lens, window) => calls.push(["stage", lens, window.mutations.length, window.capturedThrough]),
    confirmMutation: () => assert.fail("zero mutations have nothing to confirm"),
    commitLens: (lens) => { calls.push(["commit", lens]); return true; },
  };
  const result = await executeLearningCycleWrites({
    findings: [],
    workspaces: [{ sourceAnchorPath: "/source/app", apiKey: "key", config: { teamKey: "COD", projectId: "project-1" } }],
    registry: { learning: { maxNewCardsPerRun: 6 } }, stateStore,
    capturedThrough: "2026-07-10T12:00:00.000Z",
    snapshot: { capturedThrough: "2026-07-10T12:00:00.000Z", observations: [], coverage: { complete: true, gaps: [] } },
    dueDecisions: { lenses: { quality: { due: true } } },
  }, { fetchIssuesFn: async () => [] });
  assert.equal(result.mutations, 0);
  assert.deepEqual(calls, [
    ["stage", "quality", 0, "2026-07-10T12:00:00.000Z"],
    ["commit", "quality"],
  ]);
});

test("cross-lens learning mutation uses one Linear write and every lens WAL", async () => {
  const calls = [];
  const live = [];
  const stateStore = {
    setEvaluation: () => assert.fail("no generated Done issue to evaluate"),
    stageWindow: (lens, window) => calls.push(["stage", lens, window.mutations.map((mutation) => mutation.mutationId)]),
    confirmMutation: (lens, mutationId) => calls.push(["confirm", lens, mutationId]),
    commitLens: (lens) => { calls.push(["commit", lens]); return true; },
  };
  let creates = 0;
  const result = await executeLearningCycleWrites({
    findings: [learningFindingForWatcher({ lenses: ["quality", "reliability"] })],
    workspaces: [{ sourceAnchorPath: "/source/app", apiKey: "key", config: { teamKey: "COD", projectId: "project-1" } }],
    registry: { learning: { maxNewCardsPerRun: 6 } }, stateStore,
    capturedThrough: "2026-07-10T12:00:00.000Z",
    snapshot: { capturedThrough: "2026-07-10T12:00:00.000Z", observations: [], coverage: { complete: true, gaps: [] } },
  }, {
    fetchIssuesFn: async () => live,
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov" }),
    loadTeamFn: async () => ({ teamId: "team", stateIds: { Spec: "spec" } }),
    fetchSpecCardsFn: async () => live,
    createIssueFn: async (input) => {
      creates += 1;
      const marker = input.description.match(/\[factory-learning root=([^\s\]]+) generation=(\d+)\]/);
      const created = { id: "created", identifier: "COD-2", stateName: "Spec", sortOrder: input.sortOrder, rootFingerprint: marker[1], generation: Number(marker[2]), occurrenceIds: ["e1"], labelNames: ["factory:learning-generated"] };
      live.push(created);
      return created;
    },
  });
  assert.equal(creates, 1);
  assert.equal(result.confirmed, 1);
  assert.deepEqual(calls.filter(([kind]) => kind === "stage").map(([, lens, ids]) => [lens, ids.length]), [["quality", 1], ["reliability", 1]]);
  assert.deepEqual(calls.filter(([kind]) => kind === "confirm").map(([, lens]) => lens), ["quality", "reliability"]);
  assert.deepEqual(calls.filter(([kind]) => kind === "commit").map(([, lens]) => lens), ["quality", "reliability"]);
});

test("live learning dry-run plans exact updates, creates, recurrences, caps, and evaluations without writes", async () => {
  const workspace = {
    sourceAnchorPath: "/source/app", apiKey: "key",
    config: { teamKey: "COD", projectId: "project-1", repoRouting: { byLabel: { "app:main": "app" } } },
  };
  const ownership = { scope: "workspace", contributors: [{ sourceWorkspace: workspace.sourceAnchorPath, projectId: "project-1", repoEntry: "app" }] };
  const metadata = {
    acceptanceMetric: { name: "failureRate", direction: "decrease", target: 0.2, ownership },
    baseline: { value: 0.8 }, evaluationWindow: { durationDays: 7 },
  };
  const done = (rootFingerprint, generation, outcomeStatus = null) => ({
    id: `${rootFingerprint}-${generation}`, identifier: `COD-${generation}`, stateName: "Done",
    labelNames: ["factory:learning-generated"], rootFingerprint, generation,
    completedAt: "2026-07-01T00:00:00.000Z", occurrenceIds: [`old-${rootFingerprint}`], comments: [],
    evaluationMetadata: metadata,
    ...(outcomeStatus ? { outcomeStatus, outcome: { status: outcomeStatus, evaluatedAt: "2026-07-09T00:00:00.000Z" } } : {}),
  });
  const live = [
    { id: "active", identifier: "COD-10", stateName: "Dev", rootFingerprint: "active-root", generation: 0, occurrenceIds: ["old-active"], labelNames: ["factory:learning-generated"] },
    done("recur-root", 0),
    done("verified-root", 0, "verified-improvement"),
    done("cap-root", 3, "regression"),
  ];
  const finding = (rootFingerprint, occurrenceIds) => learningFindingForWatcher({
    rootFingerprint,
    occurrenceIds,
    occurrences: occurrenceIds.map((id) => ({ id, occurredAt: "2026-07-08T00:00:00.000Z" })),
    firstSeenAt: "2026-07-08T00:00:00.000Z",
    lastSeenAt: "2026-07-08T00:00:00.000Z",
    sourceWorkspaces: [workspace.sourceAnchorPath],
  });
  const snapshot = {
    capturedThrough: "2026-07-09T00:00:00.000Z",
    observations: [{ at: "2026-07-07T00:00:00.000Z", sourceWorkspace: workspace.sourceAnchorPath, projectId: "project-1", repoEntry: "app", metrics: { failureRate: 0.7 } }],
    coverage: { complete: true, gaps: [] },
  };
  const result = await buildLiveLearningDryRunPlan({
    findings: [
      finding("active-root", ["old-active", "new-active"]),
      finding("create-root", ["new-create"]),
      finding("recur-root", ["old-recur-root", "new-recur"]),
      finding("verified-root", ["old-verified-root", "new-verified"]),
      finding("cap-root", ["old-cap-root", "new-cap"]),
    ],
    workspaces: [workspace, { sourceAnchorPath: "/missing", apiKey: null, config: { teamKey: "COD", projectId: "missing-project" } }],
    registry: { learning: { maxNewCardsPerRun: 6 } }, snapshot,
  }, { fetchIssuesFn: async (destination) => destination.sourceAnchorPath === workspace.sourceAnchorPath ? live : [] });

  assert.deepEqual(result.mutations.map((mutation) => [mutation.action, mutation.rootFingerprint, mutation.generation]), [
    ["append-evidence", "active-root", 0],
    ["block-generation-cap", "cap-root", 3],
    ["create", "create-root", 0],
    ["create", "recur-root", 1],
  ]);
  assert.ok(result.deferred.some((item) => item.finding?.rootFingerprint === "verified-root" && item.reason === "evaluation-not-recurrence-eligible"));
  assert.deepEqual(result.evaluations.map((evaluation) => [evaluation.rootFingerprint, evaluation.status, evaluation.action]), [
    ["cap-root", "regression", "restore"],
    ["recur-root", "no-measurable-change", "append-outcome"],
    ["verified-root", "verified-improvement", "restore"],
  ]);
  assert.ok(result.coverageGaps.some((gap) => gap.source === "/missing" && /credential/.test(gap.reason)));
});

test("live learning dry-run reports route gaps and manual runs override cadence only when attended", async () => {
  const workspace = {
    sourceAnchorPath: "/source/app", apiKey: "key",
    config: { teamKey: "COD", projectId: "project-1", repoRouting: { byLabel: { "app:main": "app" } } },
  };
  const result = await buildLiveLearningDryRunPlan({
    findings: [learningFindingForWatcher({ repoEntry: "unknown", sourceWorkspaces: [workspace.sourceAnchorPath] })],
    workspaces: [workspace], registry: { learning: { maxNewCardsPerRun: 6 } },
    snapshot: { capturedThrough: "2026-07-10T00:00:00.000Z", observations: [], coverage: { complete: true, gaps: [] } },
  }, { fetchIssuesFn: async () => [] });
  assert.ok(result.coverageGaps.some((gap) => /route/.test(gap.reason)));
  assert.equal(learningRunExecutionDecision({ dryRun: true, automatic: false, due: false }), "dry-run");
  assert.equal(learningRunExecutionDecision({ dryRun: false, automatic: true, due: false }), "idle");
  assert.equal(learningRunExecutionDecision({ dryRun: false, automatic: false, due: false }), "run");
  assert.equal(learningRunExecutionDecision({ dryRun: false, automatic: true, due: true }), "run");
});

test("learning writer fails closed without provenance and confirms retry-safe create at bottom of Spec", async () => {
  const mutation = {
    mutationId: "create:root-a:0", action: "create", rootFingerprint: "root-a", generation: 0,
    routeLabel: "app:main", finding: learningFindingForWatcher(),
  };
  await assert.rejects(executeLearningMutations({ mutations: [mutation] }, {
    loadLabelsFn: async () => ({ "app:main": "route-id" }),
  }), /factory:learning-generated/);

  const calls = [];
  let live = [];
  const stateStore = {
    stageWindow: (_lens, value) => calls.push(["stage", value.mutations.map((item) => item.mutationId)]),
    confirmMutation: (_lens, id) => calls.push(["confirm", id]),
    commitLens: () => true,
  };
  const executed = await executeLearningMutations({
    mutations: [mutation], lens: "reliability", capturedThrough: "2026-07-10T12:00:00.000Z", stateStore,
  }, {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov-id", "app:main": "route-id", "sweep:manual-only": "manual-id" }),
    loadTeamFn: async () => ({ teamId: "team", stateIds: { Spec: "spec-id" } }),
    fetchSpecCardsFn: async () => [{ sortOrder: 5 }, { sortOrder: -2 }],
    fetchIssuesFn: async () => live,
    createIssueFn: async (input) => {
      calls.push(["create", input]);
      live = [{ id: "new", identifier: "COD-10", stateName: "Spec", sortOrder: -3, rootFingerprint: "root-a", generation: 0, occurrenceIds: ["e1"], labelNames: ["factory:learning-generated", "app:main"] }];
      return live[0];
    },
  });
  const input = calls.find(([kind]) => kind === "create")[1];
  assert.equal(input.stateId, "spec-id");
  assert.equal(input.sortOrder, -3);
  assert.deepEqual(input.labelIds.sort(), ["prov-id", "route-id"]);
  assert.equal(input.labelIds.includes("manual-id"), false);
  assert.deepEqual(calls.filter(([kind]) => kind === "confirm").map(([, id]) => id), [mutation.mutationId]);
  assert.equal(executed.confirmed, 1);
});

test("learning writer treats timeout-after-success as confirmed and updates by comments only", async () => {
  const finding = learningFindingForWatcher({ occurrenceIds: ["e1", "e2"] });
  let live = [];
  const create = { mutationId: "m-create", action: "create", rootFingerprint: "root-a", generation: 0, finding };
  const createResult = await executeLearningMutations({ mutations: [create] }, {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov" }),
    loadTeamFn: async () => ({ teamId: "team", stateIds: { Spec: "spec" } }),
    fetchSpecCardsFn: async () => [],
    fetchIssuesFn: async () => live,
    createIssueFn: async () => {
      live = [{ id: "new", stateName: "Spec", sortOrder: 0, rootFingerprint: "root-a", generation: 0, occurrenceIds: ["e1", "e2"], labelNames: ["factory:learning-generated"] }];
      throw new Error("timeout");
    },
  });
  assert.equal(createResult.confirmed, 1);

  const before = { id: "active", identifier: "COD-11", title: "Human title", description: "Human body", stateName: "Ship", labelNames: ["factory:learning-generated", "human"], rootFingerprint: "root-a", generation: 0, occurrenceIds: ["e1"] };
  let current = [structuredClone(before)];
  const calls = [];
  await executeLearningMutations({ mutations: [{ mutationId: "m-update", action: "append-evidence", issueId: "active", rootFingerprint: "root-a", generation: 0, occurrenceIds: ["e2"], finding }] }, {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov" }),
    fetchIssuesFn: async () => current,
    addCommentFn: async (issueId, body) => {
      calls.push({ issueId, body });
      current[0].occurrenceIds.push("e2");
      throw new Error("comment timeout after success");
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual({ title: current[0].title, description: current[0].description, stateName: current[0].stateName, labelNames: current[0].labelNames }, {
    title: before.title, description: before.description, stateName: before.stateName, labelNames: before.labelNames,
  });
});

test("learning writer rejects unproven marker collisions and accepts a human-advanced generated create", async () => {
  const finding = learningFindingForWatcher({ repoEntry: "app" });
  const mutation = { mutationId: "create-root", action: "create", rootFingerprint: finding.rootFingerprint, generation: 0, routeLabel: "app:main", finding };
  const labels = { "factory:learning-generated": "prov", "app:main": "route" };
  await assert.rejects(executeLearningMutations({ mutations: [mutation] }, {
    loadLabelsFn: async () => labels,
    fetchIssuesFn: async () => [{ id: "human", stateName: "Ship", rootFingerprint: finding.rootFingerprint, generation: 0, labelNames: ["app:main"] }],
  }), /provenance collision/i);
  const result = await executeLearningMutations({ mutations: [mutation] }, {
    loadLabelsFn: async () => labels,
    fetchIssuesFn: async () => [{ id: "advanced", stateName: "Dev", rootFingerprint: finding.rootFingerprint, generation: 0, occurrenceIds: finding.occurrenceIds, labelNames: ["factory:learning-generated", "app:main"] }],
  });
  assert.equal(result.confirmed, 1);
});

test("learning create race converges every intended occurrence before WAL confirmation", async () => {
  const finding = learningFindingForWatcher({ occurrenceIds: ["e1", "e2"] });
  const mutation = { mutationId: "create-race", action: "create", rootFingerprint: "root-a", generation: 0, finding };
  const live = [{
    id: "raced", identifier: "COD-12", stateName: "Dev", rootFingerprint: "root-a", generation: 0,
    occurrenceIds: ["e1"], labelNames: ["factory:learning-generated"],
  }];
  const calls = [];
  const stateStore = {
    stageWindow: () => {},
    confirmMutation: (_lens, mutationId) => calls.push(["confirm", mutationId]),
    commitLens: () => true,
  };
  const result = await executeLearningMutations({ mutations: [mutation], stateStore }, {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov" }),
    fetchIssuesFn: async () => live,
    addCommentFn: async (_issueId, body) => {
      calls.push(["comment", body]);
      assert.match(body, /Fresh occurrences:\s*e2/);
      live[0].occurrenceIds.push("e2");
      throw new Error("timeout after comment success");
    },
  });
  assert.equal(result.confirmed, 1);
  assert.deepEqual(live[0].occurrenceIds, ["e1", "e2"]);
  assert.deepEqual(calls.map(([kind]) => kind), ["comment", "confirm"]);
});

test("learning create race does not confirm its WAL when evidence append is a no-op", async () => {
  const finding = learningFindingForWatcher({ occurrenceIds: ["e1", "e2"] });
  const mutation = { mutationId: "create-race-noop", action: "create", rootFingerprint: "root-a", generation: 0, finding };
  const live = [{
    id: "raced", identifier: "COD-12", stateName: "Dev", rootFingerprint: "root-a", generation: 0,
    occurrenceIds: ["e1"], labelNames: ["factory:learning-generated"],
  }];
  const stateStore = {
    stageWindow: () => {},
    confirmMutation: () => assert.fail("unconfirmed create race must not confirm"),
    commitLens: () => assert.fail("unconfirmed create race must not commit"),
  };
  await assert.rejects(executeLearningMutations({ mutations: [mutation], stateStore }, {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov" }),
    fetchIssuesFn: async () => live,
    addCommentFn: async () => {},
  }), /occurrences were not confirmed/);
});

test("automatic learning admits only due contributing lenses while attended learning forces all", () => {
  const findings = [
    learningFindingForWatcher({ rootFingerprint: "quality", lenses: ["quality"] }),
    learningFindingForWatcher({ rootFingerprint: "reliability", lenses: ["reliability"] }),
    learningFindingForWatcher({ rootFingerprint: "cross", lenses: ["quality", "reliability"] }),
  ];
  const due = { lenses: { quality: { due: false }, reliability: { due: true }, throughput: { due: false } } };
  assert.deepEqual(filterLearningFindingsForRun(findings, due, { automatic: true }).map((finding) => [finding.rootFingerprint, finding.lenses]), [["reliability", ["reliability"]]]);
  assert.deepEqual(filterLearningFindingsForRun(findings, due, { automatic: false }).map((finding) => finding.rootFingerprint), ["quality", "reliability", "cross"]);
});

test("automatic due-lens filtering rebuilds every aggregate field from due contributors only", () => {
  const reliability = learningFindingForWatcher({
    rootFingerprint: "cross", fingerprint: "reliability-fingerprint", lenses: ["reliability"],
    detectorId: "stale-claim-pattern", detectorVersion: "r1", occurrenceIds: ["r1"],
    occurrences: [{ id: "r1", occurredAt: "2026-07-08T00:00:00.000Z" }], occurrenceCount: 1,
    evidenceReferences: ["ref:r1"], baseline: { value: 1, unit: "reaps" },
    acceptanceMetric: { name: "staleClaimCount", direction: "decrease", target: 0 },
  });
  const quality = learningFindingForWatcher({
    rootFingerprint: "cross", fingerprint: "quality-fingerprint", lenses: ["quality"],
    detectorId: "repeated-review-finding", detectorVersion: "q1", occurrenceIds: ["q1", "q2"],
    occurrences: [
      { id: "q1", occurredAt: "2026-07-08T00:01:00.000Z" },
      { id: "q2", occurredAt: "2026-07-08T00:02:00.000Z" },
    ], occurrenceCount: 2, evidenceReferences: ["ref:q1", "ref:q2"],
    baseline: { value: 2, unit: "reviews" },
    acceptanceMetric: { name: "reviewFindingCount", direction: "decrease", target: 0 },
  });
  const aggregate = aggregateLearningFindings([reliability, quality])[0];
  const due = { lenses: { quality: { due: false }, reliability: { due: true }, throughput: { due: false } } };
  const [filtered] = filterLearningFindingsForRun([aggregate], due, { automatic: true });
  assert.deepEqual(filtered.lenses, ["reliability"]);
  assert.deepEqual(filtered.occurrenceIds, ["r1"]);
  assert.deepEqual(filtered.occurrences, reliability.occurrences);
  assert.equal(filtered.occurrenceCount, 1);
  assert.deepEqual(filtered.evidenceReferences, ["ref:r1"]);
  assert.deepEqual(filtered.detectorProvenance, ["stale-claim-pattern/r1"]);
  assert.equal(filtered.measurementContracts.length, 1);
  assert.equal(filtered.measurementContracts[0].detector, "stale-claim-pattern/r1");
  assert.equal(filtered.detectorId, "stale-claim-pattern");
  assert.equal(filtered.detectorVersion, "r1");
  assert.deepEqual(filtered.baseline, reliability.baseline);
  assert.deepEqual(filtered.acceptanceMetric, reliability.acceptanceMetric);
  assert.doesNotMatch(JSON.stringify(filtered), /q1|q2|quality-fingerprint|reviewFindingCount/);
});

test("core detector routing selects the anchor repo entry with one label and fails closed when ambiguous", () => {
  const stale = Array.from({ length: 2 }, (_, index) => ({
    evidenceId: `stale-${index}`, signal: "stale-claim", occurredAt: `2026-07-10T11:0${index}:00.000Z`,
    sourceWorkspace: "/source/app", projectId: "app-project", repoEntry: "app", runId: `run-${index}`,
    stage: "dev", subsystem: "launcher", fingerprint: "claim-reaper", metrics: {},
  }));
  const snapshot = { capturedThrough: "2026-07-10T12:00:00.000Z", observations: stale, events: [], runRecords: [], coverage: { complete: true, gaps: [] } };
  const workspace = (byLabel) => ({
    sourceAnchorPath: "/source/core", apiKey: "key", learning: { enabled: true },
    config: { projectId: "core-project", repos: ["core", "worker"], repoRouting: { byLabel } },
  });
  const registry = { learning: { enabled: true, coreSourceAnchor: "/source/core", maxNewCardsPerRun: 6 } };
  const valid = watchModule.buildLearningCyclePreview({
    registry, workspaces: [workspace({ "app:core": "core", "app:worker": "worker" })], state: {}, snapshot,
  });
  assert.equal(valid.findings[0].scope, "core");
  assert.equal(valid.findings[0].projectId, "core-project");
  assert.equal(valid.findings[0].repoEntry, "core");
  assert.equal(valid.findings[0].actionable, true);

  const ambiguous = watchModule.buildLearningCyclePreview({
    registry, workspaces: [workspace({ "app:core": "core", "app:also-core": "core", "app:worker": "worker" })], state: {}, snapshot,
  });
  assert.equal(ambiguous.findings[0].scope, "core");
  assert.equal(ambiguous.findings[0].repoEntry, undefined);
  assert.equal(ambiguous.findings[0].actionable, false);

  const singleRepo = watchModule.buildLearningCyclePreview({
    registry,
    workspaces: [{ sourceAnchorPath: "/source/core", apiKey: "key", learning: { enabled: true }, config: { projectId: "core-project", repos: ["core"] } }],
    state: {}, snapshot,
  });
  assert.equal(singleRepo.coreRoute.error, null);
  assert.equal(singleRepo.coreRoute.repoEntry, "core");
  assert.equal(singleRepo.coreRoute.routeLabel, null);
  assert.equal(singleRepo.findings[0].actionable, true);
});

test("production learning replays persisted pending WAL before staging a new evidence window", async () => {
  const finding = learningFindingForWatcher({ rootFingerprint: "resume-root", lenses: ["quality"] });
  const mutation = {
    mutationId: "resume-create", action: "create", rootFingerprint: "resume-root", generation: 0, finding,
    destination: { sourceAnchorPath: "/source/app", projectId: "project-1", teamKey: "COD" }, lenses: ["quality"], status: "pending",
  };
  const state = { version: 1, lenses: {
    reliability: { accumulated: {}, pending: null },
    quality: { accumulated: {}, pending: { capturedThrough: "2026-07-09T00:00:00.000Z", mutations: { [mutation.mutationId]: mutation } } },
    throughput: { accumulated: {}, pending: null },
  }, evaluations: {} };
  const calls = [];
  const live = [];
  const stateStore = {
    snapshot: () => structuredClone(state),
    setEvaluation: () => {},
    stageWindow: () => assert.fail("recovery must replay before staging a new window"),
    confirmMutation: (lens, id) => { calls.push(["confirm", lens, id]); state.lenses[lens].pending.mutations[id].status = "confirmed"; },
    commitLens: (lens) => { calls.push(["commit", lens]); state.lenses[lens].pending = null; return true; },
    updateAccumulated: () => {},
  };
  const result = await executeLearningCycleWrites({
    findings: [], workspaces: [{ sourceAnchorPath: "/source/app", apiKey: "key", config: { teamKey: "COD", projectId: "project-1" } }],
    registry: { learning: { maxNewCardsPerRun: 6 } }, stateStore, capturedThrough: "2026-07-10T00:00:00.000Z",
  }, {
    fetchIssuesFn: async () => live,
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov" }),
    loadTeamFn: async () => ({ teamId: "team", stateIds: { Spec: "spec" } }), fetchSpecCardsFn: async () => live,
    createIssueFn: async (input) => {
      const created = { id: "created", stateName: "Spec", sortOrder: input.sortOrder, rootFingerprint: "resume-root", generation: 0, occurrenceIds: finding.occurrenceIds, labelNames: ["factory:learning-generated"] };
      live.push(created); return created;
    },
  });
  assert.equal(result.resumed, 1);
  assert.deepEqual(calls, [["confirm", "quality", "resume-create"], ["commit", "quality"]]);
});

test("deferred and low-confidence learning findings accumulate and are not discarded by watermark commits", async () => {
  const accumulated = { reliability: {}, quality: {}, throughput: {} };
  const calls = [];
  const stateStore = {
    snapshot: () => ({ version: 1, lenses: Object.fromEntries(Object.entries(accumulated).map(([lens, values]) => [lens, { accumulated: values, pending: null }])), evaluations: {} }),
    setEvaluation: () => {},
    updateAccumulated: (lens, { upsert = [], remove = [] }) => {
      for (const finding of upsert) accumulated[lens][finding.rootFingerprint] = structuredClone(finding);
      for (const root of remove) delete accumulated[lens][root];
      calls.push(["accumulate", lens, upsert.map((item) => item.rootFingerprint), remove]);
    },
    stageWindow: (lens, window) => calls.push(["stage", lens, window.mutations.length]),
    confirmMutation: () => {}, commitLens: (lens) => { calls.push(["commit", lens]); return true; },
  };
  const low = learningFindingForWatcher({ rootFingerprint: "low-root", lenses: ["quality"], confidence: "low" });
  const missing = learningFindingForWatcher({ rootFingerprint: "missing-root", lenses: ["quality"], projectId: "missing-project" });
  const result = await executeLearningCycleWrites({
    findings: [low, missing], workspaces: [], registry: { learning: { maxNewCardsPerRun: 6 } }, stateStore,
    capturedThrough: "2026-07-10T00:00:00.000Z", dueDecisions: { lenses: { quality: { due: true } } },
  });
  assert.equal(result.confirmed, 0);
  assert.deepEqual(Object.keys(accumulated.quality).sort(), ["low-root", "missing-root"]);
  assert.deepEqual(calls.slice(-2), [["stage", "quality", 0], ["commit", "quality"]]);
});

test("resolved accumulated roots clear only their processed contributing due lens", async () => {
  const root = "shared-root";
  const accumulated = {
    quality: { [root]: learningFindingForWatcher({ rootFingerprint: root, lenses: ["quality"], occurrenceIds: ["known"] }) },
    reliability: { [root]: learningFindingForWatcher({ rootFingerprint: root, lenses: ["reliability"], occurrenceIds: ["deferred-reliability"] }) },
    throughput: {},
  };
  const stateStore = {
    snapshot: () => ({ version: 1, lenses: Object.fromEntries(Object.entries(accumulated).map(([lens, values]) => [lens, { accumulated: values, pending: null }])), evaluations: {} }),
    setEvaluation: () => {},
    updateAccumulated: (lens, { remove = [] }) => { for (const key of remove) delete accumulated[lens][key]; },
    stageWindow: () => {}, confirmMutation: () => {}, commitLens: () => true,
  };
  await executeLearningCycleWrites({
    findings: [],
    workspaces: [{ sourceAnchorPath: "/source/app", apiKey: "key", config: { teamKey: "COD", projectId: "project-1" } }],
    registry: { learning: { maxNewCardsPerRun: 6 } }, stateStore,
    dueDecisions: { lenses: { quality: { due: true }, reliability: { due: false } } },
  }, { fetchIssuesFn: async () => [{
    id: "generated", stateName: "Dev", rootFingerprint: root, generation: 0,
    occurrenceIds: ["known"], labelNames: ["factory:learning-generated"], comments: [],
  }] });
  assert.equal(accumulated.quality[root], undefined);
  assert.ok(accumulated.reliability[root], "unprocessed reliability evidence must remain accumulated");
});

test("comment-only duplicate and generation-cap mutations fail closed when writes are no-ops", async () => {
  const duplicate = { id: "duplicate", stateName: "Dev", rootFingerprint: "root-a", generation: 0, occurrenceIds: [], comments: [], labelNames: ["factory:learning-generated"] };
  const duplicateStore = { stageWindow: () => {}, confirmMutation: () => assert.fail("unconfirmed duplicate must not confirm"), commitLens: () => assert.fail("unconfirmed duplicate must not commit") };
  await assert.rejects(executeLearningMutations({
    mutations: [{ mutationId: "audit", action: "audit-duplicate", issueId: duplicate.id, primaryIssueId: "primary", rootFingerprint: "root-a", generation: 0 }],
    stateStore: duplicateStore,
  }, {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov" }), fetchIssuesFn: async () => [duplicate], addCommentFn: async () => {},
  }), /duplicate.*not confirmed/i);

  const capped = { id: "done", stateName: "Done", rootFingerprint: "root-a", generation: 3, occurrenceIds: ["e1"], comments: [], labelNames: ["factory:learning-generated"], labelIds: { "factory:learning-generated": "prov" } };
  const capStore = { stageWindow: () => {}, confirmMutation: () => assert.fail("unconfirmed cap must not confirm"), commitLens: () => assert.fail("unconfirmed cap must not commit") };
  await assert.rejects(executeLearningMutations({
    mutations: [{ mutationId: "cap", action: "block-generation-cap", issueId: capped.id, rootFingerprint: "root-a", generation: 3, occurrenceIds: ["e2"], finding: learningFindingForWatcher({ generation: 3 }) }],
    stateStore: capStore,
  }, {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov", "blocked:needs-user": "blocked" }),
    fetchIssuesFn: async () => [capped], addCommentFn: async () => {},
    setLabelsFn: async () => { capped.labelNames.push("blocked:needs-user"); },
  }), /generation cap.*not confirmed/i);
});

test("comment-only duplicate and generation-cap mutations reconcile timeout-after-success", async () => {
  const duplicateMarker = "[factory-learning duplicate root=root-a primary=primary]";
  const duplicate = { id: "duplicate", stateName: "Dev", rootFingerprint: "root-a", generation: 0, occurrenceIds: [], comments: [], labelNames: ["factory:learning-generated"] };
  const duplicateResult = await executeLearningMutations({ mutations: [{ mutationId: "audit", action: "audit-duplicate", issueId: duplicate.id, primaryIssueId: "primary", rootFingerprint: "root-a", generation: 0 }] }, {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov" }), fetchIssuesFn: async () => [duplicate],
    addCommentFn: async () => { duplicate.comments.push({ body: duplicateMarker }); throw new Error("timeout"); },
  });
  assert.equal(duplicateResult.confirmed, 1);

  const capped = { id: "done", stateName: "Done", rootFingerprint: "root-a", generation: 3, occurrenceIds: ["e1"], comments: [], labelNames: ["factory:learning-generated"], labelIds: { "factory:learning-generated": "prov" } };
  const capResult = await executeLearningMutations({ mutations: [{ mutationId: "cap", action: "block-generation-cap", issueId: capped.id, rootFingerprint: "root-a", generation: 3, occurrenceIds: ["e2"], finding: learningFindingForWatcher({ generation: 3 }) }] }, {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov", "blocked:needs-user": "blocked" }), fetchIssuesFn: async () => [capped],
    addCommentFn: async (_id, body) => {
      capped.comments.push({ body });
      for (const id of body.match(/Fresh occurrences:\s*([^\n]+)/)?.[1]?.split(",").map((item) => item.trim()) || []) capped.occurrenceIds.push(id);
      throw new Error("timeout");
    },
    setLabelsFn: async () => { capped.labelNames.push("blocked:needs-user"); throw new Error("timeout"); },
  });
  assert.equal(capResult.confirmed, 1);
});

test("learning writer confirms recurrence links and reconciles timeout-after-success", async () => {
  const finding = learningFindingForWatcher();
  const mutation = {
    mutationId: "create:root-a:1", action: "create", rootFingerprint: "root-a", generation: 1,
    relatedIssueId: "done", finding,
  };
  let live = [];
  let linked = false;
  let relationWrites = 0;
  const result = await executeLearningMutations({ mutations: [mutation] }, {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov" }),
    loadTeamFn: async () => ({ teamId: "team", stateIds: { Spec: "spec" } }),
    fetchSpecCardsFn: async () => [],
    fetchIssuesFn: async () => live,
    createIssueFn: async () => {
      live = [{ id: "new", stateName: "Spec", sortOrder: 0, rootFingerprint: "root-a", generation: 1, occurrenceIds: finding.occurrenceIds, labelNames: ["factory:learning-generated"] }];
      return live[0];
    },
    relationExistsFn: async () => linked,
    createRelationFn: async () => {
      relationWrites += 1;
      linked = true;
      throw new Error("timeout");
    },
  });
  assert.equal(result.confirmed, 1);
  assert.equal(relationWrites, 1);
});

test("production learning cycle stages one WAL and globally caps creates across its qualified set", async () => {
  const live = [];
  const wal = [];
  const confirmed = new Set();
  const stateStore = {
    stageWindow: (lens, value) => wal.push(["stage", lens, value.mutations.length]),
    confirmMutation: (lens, mutationId) => { wal.push(["confirm", lens, mutationId]); confirmed.add(mutationId); },
    commitLens: (lens) => { wal.push(["commit", lens]); return true; },
  };
  const findings = Array.from({ length: 8 }, (_, index) => learningFindingForWatcher({
    rootFingerprint: `root-${index}`, occurrenceIds: [`e-${index}`], lenses: ["reliability"],
  }));
  const result = await executeLearningCycleWrites({
    findings,
    workspaces: [{ sourceAnchorPath: "/source/app", apiKey: "key", config: { teamKey: "COD", projectId: "project-1" } }],
    registry: { learning: { maxNewCardsPerRun: 6 } },
    stateStore,
    capturedThrough: "2026-07-10T12:00:00.000Z",
  }, {
    fetchIssuesFn: async () => live,
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov" }),
    loadTeamFn: async () => ({ teamId: "team", stateIds: { Spec: "spec" } }),
    fetchSpecCardsFn: async () => live,
    createIssueFn: async (input) => {
      const marker = input.description.match(/\[factory-learning root=([^\s\]]+) generation=(\d+)\]/);
      const issue = { id: `issue-${live.length}`, identifier: `COD-${live.length}`, stateName: "Spec", sortOrder: input.sortOrder, rootFingerprint: marker[1], generation: Number(marker[2]), occurrenceIds: [`e-${marker[1].slice("root-".length)}`], labelNames: ["factory:learning-generated"] };
      live.push(issue);
      return issue;
    },
  });
  assert.equal(result.confirmed, 6);
  assert.equal(result.deferred.length, 2);
  assert.deepEqual(wal.filter(([kind]) => kind === "stage").map((entry) => entry.slice(1)), [["reliability", 6]]);
  assert.equal(confirmed.size, 6);
  assert.deepEqual(wal.at(-1), ["commit", "reliability"]);
});

test("production learning cycle routes same-project findings to their exact source workspace", async () => {
  const finding = learningFindingForWatcher({ sourceWorkspaces: ["/z-source"] });
  const visited = [];
  const result = await executeLearningCycleWrites({
    findings: [finding],
    registry: { learning: { maxNewCardsPerRun: 0 } },
    workspaces: [
      { sourceAnchorPath: "/a-source", apiKey: "a", config: { teamKey: "COD", projectId: finding.projectId } },
      { sourceAnchorPath: "/z-source", apiKey: "z", config: { teamKey: "COD", projectId: finding.projectId } },
    ],
    stateStore: { stageWindow: () => {}, confirmMutation: () => {}, commitLens: () => true },
  }, {
    fetchIssuesFn: async (destination) => { visited.push(destination.sourceAnchorPath); return []; },
  });
  assert.deepEqual(visited, ["/a-source", "/z-source"], "evaluation discovery scans every registered learning workspace");
  assert.deepEqual(result.plannedDestinations, ["/z-source"]);
});

test("generation cap appends fresh evidence and one blocker audit while preserving Done", async () => {
  const issue = {
    id: "done-3", identifier: "COD-3", stateName: "Done", rootFingerprint: "root-a", generation: 3,
    occurrenceIds: ["e1"], comments: [], labelNames: ["factory:learning-generated"], labelIds: { "factory:learning-generated": "prov" },
  };
  const commentBodies = [];
  const deps = {
    loadLabelsFn: async () => ({ "factory:learning-generated": "prov", "blocked:needs-user": "blocked" }),
    fetchIssuesFn: async () => [issue],
    addCommentFn: async (_issueId, body) => {
      commentBodies.push(body);
      issue.comments.push({ body });
      for (const id of body.match(/Fresh occurrences:\s*([^\n]+)/)?.[1]?.split(",").map((item) => item.trim()) || []) issue.occurrenceIds.push(id);
    },
    setLabelsFn: async (_issueId, ids) => {
      assert.deepEqual(new Set(ids), new Set(["prov", "blocked"]));
      issue.labelIds["blocked:needs-user"] = "blocked";
      issue.labelNames.push("blocked:needs-user");
    },
  };
  const mutation = {
    mutationId: "cap", action: "block-generation-cap", issueId: issue.id,
    rootFingerprint: "root-a", generation: 3, occurrenceIds: ["e2"], finding: learningFindingForWatcher({ generation: 3 }),
  };
  await executeLearningMutations({ mutations: [mutation] }, deps);
  assert.equal(issue.stateName, "Done");
  assert.equal(commentBodies.filter((body) => body.includes("generation-cap")).length, 1);
  assert.equal(commentBodies.filter((body) => body.includes("Fresh occurrences: e2")).length, 1);
  const countAfterFirst = commentBodies.length;
  await executeLearningMutations({ mutations: [mutation] }, deps);
  assert.equal(commentBodies.length, countAfterFirst);
});

function learningFindingForWatcher(overrides = {}) {
  return {
    rootFingerprint: "root-a", generation: 0, occurrenceIds: ["e1"], occurrenceCount: 1,
    occurrences: [{ id: "e1", occurredAt: "2026-07-08T00:00:00.000Z" }],
    firstSeenAt: "2026-07-08T00:00:00.000Z", lastSeenAt: "2026-07-08T00:00:00.000Z",
    confidence: "high", severity: "high", impact: "Repeated failures", actionable: true,
    projectId: "project-1", repoEntry: "app", lenses: ["reliability"], coverage: { complete: true, gaps: [] },
    rootCauseHypothesis: "A factory condition may recur.", desiredOutcome: "Reduce failures.",
    acceptanceMetric: { name: "failureRate", direction: "decrease", target: 0 }, baseline: { value: 2, unit: "occurrences" },
    evaluationWindow: { durationDays: 7 }, exclusions: ["Keep safety gates."], detectorId: "test", detectorVersion: "v1", ...overrides,
  };
}
test("parallelLimit: defaults invalid and missing config to the bounded parallel default", () => {
  assert.equal(DEFAULT_MAX_NON_SHIP_DISPATCHES, 2);
  assert.equal(parallelLimit({}), 2);
  assert.equal(parallelLimit({ parallel: { maxNonShipDispatches: "lots" } }), 2);
  assert.equal(parallelLimit({ parallel: { maxNonShipDispatches: 0 } }), 2);
  assert.equal(parallelLimit({ parallel: { maxNonShipDispatches: 1 } }), 1);
  assert.equal(parallelLimit({ parallel: { maxNonShipDispatches: 2.8 } }), 2);
});
test("drainPassLimit: defaults, clamps, and takes the active-anchor maximum", () => {
  assert.equal(DEFAULT_MAX_DRAIN_PASSES, 5);
  assert.equal(MAX_DRAIN_PASSES, 5);
  assert.equal(drainPassLimit({}), 5);
  assert.equal(drainPassLimit({ parallel: { maxDrainPasses: "many" } }), 5);
  assert.equal(drainPassLimit({ parallel: { maxDrainPasses: 0 } }), 1);
  assert.equal(drainPassLimit({ parallel: { maxDrainPasses: 3.8 } }), 3);
  assert.equal(drainPassLimit({ parallel: { maxDrainPasses: 99 } }), 5);
  assert.equal(drainPassLimit([{ parallel: { maxDrainPasses: 1 } }, { parallel: { maxDrainPasses: 4 } }]), 4);
});
test("maxSameRepoRefillDispatches: defaults, disables, clamps, and takes the active-anchor maximum", () => {
  assert.equal(DEFAULT_MAX_SAME_REPO_REFILL_DISPATCHES, 8);
  assert.equal(MAX_SAME_REPO_REFILL_DISPATCHES, 20);
  assert.equal(maxSameRepoRefillDispatches({}), 8);
  assert.equal(maxSameRepoRefillDispatches({ parallel: { maxSameRepoRefillDispatches: "many" } }), 8);
  assert.equal(maxSameRepoRefillDispatches({ parallel: { maxSameRepoRefillDispatches: 0 } }), 0);
  assert.equal(maxSameRepoRefillDispatches({ parallel: { maxSameRepoRefillDispatches: 3.8 } }), 3);
  assert.equal(maxSameRepoRefillDispatches({ parallel: { maxSameRepoRefillDispatches: 99 } }), 20);
  assert.equal(maxSameRepoRefillDispatches([{ parallel: { maxSameRepoRefillDispatches: 1 } }, { parallel: { maxSameRepoRefillDispatches: 4 } }]), 4);
  assert.equal(maxSameRepoRefillDispatches([{ parallel: { maxSameRepoRefillDispatches: "many" } }, { parallel: { maxSameRepoRefillDispatches: 1 } }]), 8);
});
test("runDrainLoop: rescans until a pass selects no batch", async () => {
  const seen = [];
  const result = await runDrainLoop({
    maxDrainPasses: 5,
    runPass: async (pass) => {
      seen.push(pass);
      return pass < 3 ? { selectedBatch: [{ sweep: "dev" }], dispatched: true } : { selectedBatch: [], dispatched: false };
    },
  });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(result.budgetExhausted, false);
});
test("runDrainLoop: stops at budget and logs exhaustion", async () => {
  const logs = [];
  const result = await runDrainLoop({
    maxDrainPasses: 2,
    log: (line) => logs.push(line),
    runPass: async () => ({ selectedBatch: [{ sweep: "spec" }], dispatched: true }),
  });
  assert.equal(result.passes.length, 2);
  assert.equal(result.budgetExhausted, true);
  assert.match(logs[0], /drain budget exhausted/);
});
test("runDrainLoop: dry-run continues from selected batches, not dispatched status", async () => {
  let calls = 0;
  await runDrainLoop({
    maxDrainPasses: 2,
    runPass: async () => {
      calls += 1;
      return { selectedBatch: [{ sweep: "qa" }], dispatched: false };
    },
  });
  assert.equal(calls, 2);
});
test("runDrainLoop: stops after a selected pass opts out of continued draining", async () => {
  let calls = 0;
  const result = await runDrainLoop({
    maxDrainPasses: 5,
    runPass: async () => {
      calls += 1;
      return { selectedBatch: [{ sweep: "dev" }], dispatched: true, continueDraining: false };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.budgetExhausted, false);
});
test("automatic post-delivery learning waits when the delivery drain budget is exhausted", () => {
  assert.equal(shouldStartPostDeliveryLearning({ budgetExhausted: true }), false);
  assert.equal(shouldStartPostDeliveryLearning({ budgetExhausted: false }), true);
  assert.equal(shouldStartPostDeliveryLearning(null), true);
});
test("sameRepoCardLimit: defaults, invalid values, and forced ship serial limit", () => {
  assert.deepEqual(DEFAULT_SAME_REPO_CARD_LIMITS, { spec: 4, dev: 4, qa: 1, ship: 1 });
  assert.equal(sameRepoCardLimit({}, "spec"), 4);
  assert.equal(sameRepoCardLimit({}, "dev"), 4);
  assert.equal(sameRepoCardLimit({}, "qa"), 1);
  assert.equal(sameRepoCardLimit({ parallel: { sameRepoCardLimits: { dev: 2.9 } } }, "dev"), 2);
  assert.equal(sameRepoCardLimit({ parallel: { sameRepoCardLimits: { dev: 0 } } }, "dev"), 4);
  assert.equal(sameRepoCardLimit({ parallel: { sameRepoCardLimits: { dev: "many" } } }, "dev"), 4);
  assert.equal(sameRepoCardLimit({ parallel: { sameRepoCardLimits: { ship: 9 } } }, "ship"), 1);
});
test("maxHandoffTriggerHops: defaults, disables, and clamps to a small bound", () => {
  assert.equal(maxHandoffTriggerHops({}), 2);
  assert.equal(maxHandoffTriggerHops({ parallel: { maxHandoffTriggerHops: 0 } }), 0);
  assert.equal(maxHandoffTriggerHops({ parallel: { maxHandoffTriggerHops: 2.9 } }), 2);
  assert.equal(maxHandoffTriggerHops({ parallel: { maxHandoffTriggerHops: 99 } }), 3);
  assert.equal(maxHandoffTriggerHops({ parallel: { maxHandoffTriggerHops: -1 } }), 0);
  assert.equal(maxHandoffTriggerHops({ parallel: { maxHandoffTriggerHops: "bad" } }), 2);
});
test("nextSweepForHandoff: triggers only forward non-production handoffs via configured states", () => {
  assert.equal(nextSweepForHandoff({ completedSweep: "spec", currentStateName: "Dev" }), "dev");
  assert.equal(nextSweepForHandoff({ completedSweep: "dev", currentStateName: "QA" }), "qa");
  assert.equal(nextSweepForHandoff({ completedSweep: "qa", currentStateName: "Signoff" }), null);
  assert.equal(nextSweepForHandoff({ completedSweep: "ship", currentStateName: "Done" }), null);
  assert.equal(nextSweepForHandoff({ completedSweep: "dev", currentStateName: "Spec" }), null);
  assert.equal(nextSweepForHandoff({
    completedSweep: "spec",
    currentStateName: "Dev",
    sweepCfg: { ...SWEEP_CFG, dev: { ...SWEEP_CFG.dev, states: ["Dev"] } },
  }), "dev");
});
test("handoffTriggerKey: scopes duplicate suppression by issue and edge", () => {
  assert.equal(handoffTriggerKey("COD-1", "spec", "dev"), "COD-1:spec->dev");
  assert.notEqual(handoffTriggerKey("COD-1", "spec", "dev"), handoffTriggerKey("COD-1", "dev", "qa"));
});
test("handoffDirtyCheckoutFailures: handoff candidates use managed dirty-check failures before dispatch", () => {
  const failures = handoffDirtyCheckoutFailures({
    anchorPath: "/managed/app/app",
    managedRepoPaths: ["/managed/app/app", "/managed/app/worker"],
    issueIdentifier: "COD-22",
    sweep: "qa",
    config: { teamKey: "COD", projectId: "project-1", repos: ["app", "worker"] },
  }, {}, {
    checkoutDispatchBlockersFn: (candidate) => checkoutDispatchBlockers(candidate, {}, {
      gitFn: (repo, args) => {
        if (args.join(" ") === "status --porcelain -uall" && repo === "/managed/app/worker") {
          return { status: 0, out: " M README.md", err: "" };
        }
        return { status: 0, out: "", err: "" };
      },
    }),
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].scope, "qa:dispatch");
  assert.equal(failures[0].kind, "dirty-checkout");
  assert.equal(failures[0].stableTarget, "managed-repo:/managed/app/worker");
  assert.match(failures[0].message, /README\.md/);
});
test("handoffRepoRoutingDecision: preserves a stable route and fails closed when the app label changes", () => {
  const config = { repos: ["coach", "guide"], repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } } };
  const repoPairs = [
    { repoEntry: "coach", sourceRepoPath: "/source/coach", managedRepoPath: "/managed/coach" },
    { repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
  ];
  const repoRoute = resolveCardRepoRoute({ config, card: { identifier: "SAF-1", labelNames: ["app:guide"] }, repoPairs });
  const pick = { issueIdentifier: "SAF-1", config, repoRoute };
  const stable = handoffRepoRoutingDecision(pick, { id: "id", identifier: "SAF-1", labelNames: ["app:guide"] }, repoPairs);
  assert.equal(stable.ok, true);
  assert.equal(stable.card.repoRoute.managedRepoPath, "/managed/guide");
  const changed = handoffRepoRoutingDecision(pick, { id: "id", identifier: "SAF-1", labelNames: ["app:coach"] }, repoPairs);
  assert.equal(changed.ok, false);
  assert.match(changed.message, /changed before handoff/);
});
test("selectCardSlots: chooses top actionable cards and assigns stable slot indexes", () => {
  const cards = [
    { id: "blocked", identifier: "COD-1", sortOrder: 99, updatedAt: minsAgo(1), labelNames: ["blocked:needs-user"], comments: [] },
    { id: "live", identifier: "COD-2", sortOrder: 90, updatedAt: minsAgo(1), labelNames: ["dev:in-progress"], comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)}]`, createdAt: minsAgo(1) }] },
    { id: "second", identifier: "COD-3", sortOrder: 10, updatedAt: minsAgo(1), labelNames: [], comments: [] },
    { id: "first", identifier: "COD-4", sortOrder: 20, updatedAt: minsAgo(1), labelNames: [], comments: [] },
  ].map(dependencyReadyCard);
  const slots = selectCardSlots(cards, SWEEP_CFG.dev, "dev", 2, NOW);
  assert.deepEqual(slots.map((s) => `${s.slotIndex}:${s.identifier}`), ["0:COD-4", "1:COD-3"]);
});
test("claim confirmation requires the exact immutable owner and declaration", () => {
  const owner = ownerToken({ host: "host a", parentRunId: "run", issueIdentifier: "COD-5", slotIndex: 0 });
  assert.equal(owner, "host_a:run:COD-5:0");
  const declarationId = "decl-5";
  const card = dependencyReadyCard({
    id: "c",
    identifier: "COD-5",
    stateName: "Dev",
    labelNames: ["dev:in-progress"],
    commentsComplete: true,
    comments: [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: owner, declarationId }), createdAt: claimIso(1) }],
  });
  const identity = { ownerToken: owner, declarationId };
  assert.equal(claimConfirmed(card, SWEEP_CFG.dev, identity, ["Dev"]), true);
  assert.equal(claimConfirmed(card, SWEEP_CFG.dev, { ...identity, declarationId: "other" }, ["Dev"]), false);
  assert.equal(claimConfirmed({ ...card, stateName: "QA" }, SWEEP_CFG.dev, identity, ["Dev"]), false);
  assert.equal(claimConfirmed({ ...card, labelNames: ["dev:in-progress", "blocked:needs-user"] }, SWEEP_CFG.dev, identity, ["Dev"]), false);
});
test("declarationToken returns the injected immutable identity", () => {
  assert.equal(declarationToken({ randomUUID: () => "decl-id" }), "decl-id");
});
test("claimConfirmed rejects a blocker added after scan", () => {
  const owner = ownerToken({ host: "host a", parentRunId: "run", issueIdentifier: "COD-5", slotIndex: 0 });
  const card = {
    id: "c",
    identifier: "COD-5",
    stateName: "Dev",
    labelNames: ["dev:in-progress"],
    commentsComplete: true,
    comments: [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: owner, declarationId: "decl" }), createdAt: claimIso(1) }],
    blockers: [{ identifier: "COD-1", stateName: "QA" }],
    blockersComplete: true,
  };
  assert.equal(claimConfirmed(card, SWEEP_CFG.dev, { ownerToken: owner, declarationId: "decl" }, ["Dev"]), false);
});
test("claimConfirmed rejects cards with absent relation metadata", () => {
  const owner = ownerToken({ host: "host a", parentRunId: "run", issueIdentifier: "COD-5", slotIndex: 0 });
  const card = {
    id: "c",
    identifier: "COD-5",
    stateName: "Dev",
    labelNames: ["dev:in-progress"],
    comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=${owner} claim=dev:in-progress]`, createdAt: minsAgo(1) }],
  };
  assert.equal(claimConfirmed(card, SWEEP_CFG.dev, { ownerToken: owner, declarationId: "decl" }, ["Dev"]), false);
});

// ── dependency-aware queue snapshots ────────────────────────────────────────
test("coordination comments complete the active window and fail closed on a cursor cycle", async () => {
  const cutoff = NOW - MAX_STALE_MIN * 60_000;
  const seed = {
    pageInfo: { hasPreviousPage: true, startCursor: "page-1" },
    nodes: [{ id: "new", body: "new", createdAt: minsAgo(1) }],
  };
  const calls = [];
  const comments = await completeRecentIssueComments("key", "issue-1", seed, cutoff, {
    gqlFn: async (_query, variables) => {
      calls.push(variables.cursor);
      return { issue: { comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [{ id: "retry", body: "retry", createdAt: minsAgo(120) }] } } };
    },
  });
  assert.deepEqual(calls, ["page-1"]);
  assert.deepEqual(comments.map((comment) => comment.id), ["new", "retry"]);
  await assert.rejects(completeRecentIssueComments("key", "issue-1", seed, cutoff, {
    gqlFn: async () => ({ issue: { comments: { pageInfo: { hasPreviousPage: true, startCursor: "page-1" }, nodes: [{ id: "older", body: "old", createdAt: minsAgo(1) }] } } }),
  }), /cursor cycle/);
});
test("queue snapshot requests all scheduled states once and partitions dependency-normalized cards", async () => {
  const states = SWEEPS.flatMap((sweep) => SWEEP_CFG[sweep].states);
  const calls = [];
  const gqlFn = async (query, variables) => {
    calls.push({ query, variables });
    return {
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            id: "spec-id", identifier: "COD-1", updatedAt: minsAgo(1), sortOrder: 20,
            state: { name: "Spec" }, labels: { nodes: [] }, comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
            inverseRelations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
          {
            id: "dev-id", identifier: "COD-2", updatedAt: minsAgo(1), sortOrder: 10,
            state: { name: "Dev" }, labels: { nodes: [] }, comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
            inverseRelations: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "rel-1", type: "blocks", issue: { id: "done-id", identifier: "COD-0", state: { id: "done-state", name: "Done", type: "completed" } } }],
            },
          },
        ],
      },
    };
  };

  const byState = await fetchScheduledQueueCards("lin", "COD", "project-1", states, { gqlFn });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].variables.states, states);
  assert.match(calls[0].query, /inverseRelations\(first:50\)/);
  assert.deepEqual(byState.get("Spec").map((card) => card.identifier), ["COD-1"]);
  assert.deepEqual(byState.get("Dev").map((card) => card.identifier), ["COD-2"]);
  assert.equal(byState.get("Dev")[0].blockersComplete, true);
  assert.equal(byState.get("Dev")[0].dependency.eligible, true);
});

test("queue snapshot annotates a visible cycle and produces one deduplicated failure event for Todo and doctor", async () => {
  const node = (id, identifier, state, blockerId, blockerIdentifier, blockerState) => ({
    id, identifier, updatedAt: minsAgo(1), sortOrder: 10,
    state: { name: state }, labels: { nodes: [] }, comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
    inverseRelations: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ id: `rel-${id}`, type: "blocks", issue: { id: blockerId, identifier: blockerIdentifier, state: { id: `${blockerId}-state`, name: blockerState, type: "started" } } }],
    },
  });
  const gqlFn = async () => ({
    issues: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        node("a-id", "COD-1", "Dev", "b-id", "COD-2", "QA"),
        node("b-id", "COD-2", "QA", "a-id", "COD-1", "Dev"),
      ],
    },
  });

  const byState = await fetchScheduledQueueCards("lin", "COD", "project-1", ["Dev", "QA"], { gqlFn });
  const cards = [...byState.values()].flat();
  const failures = dependencyCycleFailureEvents(cards, {
    anchorPath: "/managed/app",
    projectId: "project-1",
    seenAt: "2026-07-09T00:00:00.000Z",
  });

  assert.deepEqual(cards.map((card) => card.dependency.reason), ["dependency-cycle", "dependency-cycle"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].scope, "dependency-cycle");
  assert.equal(failures[0].kind, "dependency-cycle");
  assert.equal(failures[0].stableTarget, "COD-1,COD-2");
  assert.match(failures[0].message, /COD-1 -> COD-2; COD-2 -> COD-1/);
  assert.deepEqual(failureTodoDecisions([...failures, ...failures], [], new Set(["dependency-cycle"])).map((decision) => decision.action), ["create"]);

  const report = doctorReport({
    registry: { repos: [], kitPath: null },
    currentTick: { status: "running", pid: 42, failures },
    capacityState: { healthy: true, active: 0, max: 10, errors: [] },
    observationState: { healthy: true, entries: [], errors: [] },
    isAlive: () => true,
  });
  assert.match(formatDoctorReport(report), /current tick failure: dependency-cycle: visible dependency cycle/);
});

test("queue snapshot completes relation overflow before the card becomes eligible", async () => {
  const overflowCalls = [];
  const gqlFn = async () => ({
    issues: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        id: "dev-id", identifier: "COD-2", updatedAt: minsAgo(1), sortOrder: 10,
        state: { name: "Dev" }, labels: { nodes: [] }, comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
        inverseRelations: {
          pageInfo: { hasNextPage: true, endCursor: "relations-1" },
          nodes: [{ id: "rel-1", type: "blocks", issue: { id: "done-id", identifier: "COD-0", state: { id: "done-state", name: "Done", type: "completed" } } }],
        },
      }],
    },
  });
  const fetchIssueDependenciesFn = async (_apiKey, issueId) => {
    overflowCalls.push(issueId);
    return { issue: "COD-2", blockers: [], complete: true };
  };

  const byState = await fetchScheduledQueueCards("lin", "COD", "project-1", ["Dev"], { gqlFn, fetchIssueDependenciesFn });
  const card = byState.get("Dev")[0];

  assert.deepEqual(overflowCalls, ["dev-id"]);
  assert.equal(card.blockersComplete, true);
  assert.equal(card.dependency.eligible, true);
  assert.deepEqual(actionableCards([card], SWEEP_CFG.dev, NOW).map((item) => item.id), ["dev-id"]);
});

test("queue snapshot rejects relation overflow that cannot be completed", async () => {
  const gqlFn = async () => ({
    issues: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        id: "dev-id", identifier: "COD-2", updatedAt: minsAgo(1), sortOrder: 10,
        state: { name: "Dev" }, labels: { nodes: [] }, comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
        inverseRelations: { pageInfo: { hasNextPage: true, endCursor: "relations-1" }, nodes: [] },
      }],
    },
  });

  await assert.rejects(
    fetchScheduledQueueCards("lin", "COD", "project-1", ["Dev"], {
      gqlFn,
      fetchIssueDependenciesFn: async () => ({ issue: "COD-2", blockers: [], complete: false }),
    }),
    /incomplete relation pagination.*COD-2/,
  );
});

test("partial GraphQL queue snapshot fails closed before selecting returned cards", async () => {
  const partial = {
    data: {
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          id: "dev-id", identifier: "COD-2", updatedAt: minsAgo(1), sortOrder: 10,
          state: { name: "Dev" }, labels: { nodes: [] }, comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
          inverseRelations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        }],
      },
    },
    errors: [{ message: "relation field denied" }],
  };

  await assert.rejects(
    fetchScheduledQueueCards("lin", "COD", "project-1", ["Dev"], { gqlFn: async () => partial }),
    /partial GraphQL|relation field denied/,
  );
});

test("scheduled pass falls back to relation-free stale-claim cleanup when dependency admission fails", async () => {
  const cleanupQueries = [];
  const result = await fetchScheduledPassCards("lin", "COD", "project-1", ["Dev"], {
    fetchAdmissionFn: async () => { throw new Error("relation field denied"); },
    fetchCompleteClaimCommentsFn: async () => [],
    cleanupGqlFn: async (query, variables) => {
      cleanupQueries.push({ query, variables });
      return {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: "stale-id",
            identifier: "COD-9",
            updatedAt: minsAgo(300),
            sortOrder: 1,
            state: { name: "Dev" },
            labels: { nodes: [{ id: "claim-id", name: "dev:in-progress" }] },
            comments: { nodes: [] },
          }],
        },
      };
    },
  });

  assert.match(result.admissionError.message, /relation field denied/);
  assert.equal(result.admissionByState, null);
  assert.equal(result.cleanupError, null);
  assert.equal(cleanupQueries.length, 1);
  assert.equal(cleanupQueries[0].query.includes("inverseRelations"), false);
  assert.deepEqual(cleanupQueries[0].variables.states, ["Dev"]);
  const cleanupCard = result.cleanupByState.get("Dev")[0];
  assert.equal(cleanupCard.blockersComplete, false);
  assert.equal(cleanupCard.commentsComplete, true);
  assert.deepEqual(actionableCards([cleanupCard], SWEEP_CFG.dev, NOW), []);
  assert.deepEqual(reapDecisions([cleanupCard], SWEEP_CFG.dev, NOW).map((decision) => decision.identifier), ["COD-9"]);
});

// Synthetic minimal edges derived from the reviewed SafeTaper wave partition.
// This verifies scheduling semantics, not a reconstruction of every historical
// Linear relation. SAF-212 retains the directly verified historical blocker set.
const SAFETAPER_REVIEWED_WAVE_FIXTURE = Object.freeze([
  { identifier: "SAF-207", wave: 0, blockers: [] },
  { identifier: "SAF-209", wave: 1, blockers: ["SAF-207"] },
  { identifier: "SAF-210", wave: 1, blockers: ["SAF-207"] },
  { identifier: "SAF-213", wave: 1, blockers: ["SAF-207"] },
  { identifier: "SAF-220", wave: 1, blockers: ["SAF-207"] },
  { identifier: "SAF-221", wave: 1, blockers: ["SAF-207"] },
  { identifier: "SAF-222", wave: 1, blockers: ["SAF-207"] },
  { identifier: "SAF-211", wave: 2, blockers: ["SAF-209", "SAF-213"] },
  { identifier: "SAF-212", wave: 2, blockers: ["SAF-207", "SAF-209", "SAF-213", "SAF-221"] },
  { identifier: "SAF-217", wave: 2, blockers: ["SAF-210"] },
  { identifier: "SAF-224", wave: 2, blockers: ["SAF-220"] },
  { identifier: "SAF-214", wave: 3, blockers: ["SAF-211"] },
  { identifier: "SAF-215", wave: 3, blockers: ["SAF-212"] },
  { identifier: "SAF-225", wave: 3, blockers: ["SAF-224"], manualOnly: true },
  { identifier: "SAF-216", wave: 4, blockers: ["SAF-214"] },
  { identifier: "SAF-223", wave: 4, blockers: ["SAF-211", "SAF-212", "SAF-215"] },
  { identifier: "SAF-218", wave: 5, blockers: ["SAF-216", "SAF-223"] },
  { identifier: "SAF-219", wave: 6, blockers: ["SAF-218"] },
].map((card) => Object.freeze({ ...card, blockers: Object.freeze(card.blockers) })));

test("SafeTaper reviewed fixture releases the exact seven waves without scheduling later work early", () => {
  const expectedWaves = [
    ["SAF-207"],
    ["SAF-209", "SAF-210", "SAF-213", "SAF-220", "SAF-221", "SAF-222"],
    ["SAF-211", "SAF-212", "SAF-217", "SAF-224"],
    ["SAF-214", "SAF-215", "SAF-225"],
    ["SAF-216", "SAF-223"],
    ["SAF-218"],
    ["SAF-219"],
  ];
  const done = new Set();

  for (const [waveIndex, expected] of expectedWaves.entries()) {
    assert.deepEqual(
      SAFETAPER_REVIEWED_WAVE_FIXTURE.filter((card) => card.wave === waveIndex).map((card) => card.identifier),
      expected,
    );
    const cards = SAFETAPER_REVIEWED_WAVE_FIXTURE
      .filter((fixture) => !done.has(fixture.identifier))
      .map((fixture) => ({
        id: fixture.identifier,
        identifier: fixture.identifier,
        labelNames: fixture.manualOnly ? ["sweep:manual-only"] : [],
        comments: [],
        blockersComplete: true,
        blockers: fixture.blockers.map((identifier) => ({
          identifier,
          stateName: done.has(identifier) ? "Done" : "Dev",
        })),
      }));
    const relationReady = cards
      .filter((card) => dependencyEligibility(card.blockers, card.blockersComplete).eligible)
      .map((card) => card.identifier);

    assert.deepEqual(relationReady, expected);
    assert.deepEqual(
      actionableCards(cards, SWEEP_CFG.dev, NOW).map((card) => card.identifier),
      expected.filter((identifier) => identifier !== "SAF-225"),
    );
    expected.forEach((identifier) => done.add(identifier));
  }

  assert.equal(done.size, SAFETAPER_REVIEWED_WAVE_FIXTURE.length);
});
test("card run paths/env are isolated per issue and slot", () => {
  assert.equal(SAME_REPO_PORT_BASE, 47000);
  assert.equal(cardWorktreePath("/ws/repo", { repos: ["repo"] }, "COD-6"), "/ws/repo/.worktrees/COD-6");
  const globalRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-test-global-runs-"));
  const paths = cardRunPaths("/ws/repo", { repos: ["repo"] }, "dev", { identifier: "COD-6", slotIndex: 1 }, "run-id", 2, { globalRunsDir });
  assert.equal(paths.worktreePath, "/ws/repo/.worktrees/COD-6");
  assert.match(paths.logDir, /linear-board-sweeps\/repo\/dev\/COD-6$/);
  assert.match(paths.tmpDir, /linear-board-sweeps\/run-id\/dev-COD-6-2\/tmp$/);
  assert.equal(paths.portBase, 47020);
  assert.equal(paths.globalRunsDir, globalRunsDir);
  const pick = withCardDispatchEnv({ anchorPath: "/ws/repo", config: { repos: ["repo"] }, sweep: "dev", issueIdentifier: "COD-6", slotIndex: 1, ownerToken: "owner-6", claimDeclarationId: "decl-6" }, "run-id", 2, { globalRunsDir });
  assert.equal(pick.childEnv.AUTO_SWEEP_ISSUE, "COD-6");
  assert.equal(pick.childEnv.AUTO_SWEEP_KIT_PATH, path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  assert.equal(pick.childEnv.AUTO_SWEEP_SOURCE_ANCHOR, "/ws/repo");
  assert.equal(pick.childEnv.AUTO_SWEEP_WORKTREE, "/ws/repo/.worktrees/COD-6");
  assert.equal(pick.childEnv.AUTO_SWEEP_APP_PORT, "47020");
  assert.equal(pick.childEnv.AUTO_SWEEP_OWNER_TOKEN, "owner-6");
  assert.equal(pick.childEnv.AUTO_SWEEP_CLAIM_DECLARATION, "decl-6");
  assert.equal(pick.childEnv.AUTO_SWEEP_CARD_RUN_ID, pick.cardRunId);
  assert.equal(pick.childEnv.AUTO_SWEEP_SWEEP, "dev");
  assert.equal(pick.childEnv.AUTO_SWEEP_LEARNING_EVENTS_PATH, pick.learningEventsPath);
  assert.match(pick.learningEventsPath, /learning-events-[a-f0-9]{16}\.jsonl$/);
  assert.equal(pick.globalRunsDir, globalRunsDir);
  const laterPick = withCardDispatchEnv({ anchorPath: "/ws/repo", config: { repos: ["repo"] }, sweep: "dev", issueIdentifier: "COD-6", slotIndex: 1, ownerToken: "owner-6", claimDeclarationId: "decl-6" }, "later-run-id", 2, { globalRunsDir });
  assert.notEqual(laterPick.learningEventsPath, pick.learningEventsPath);
  for (const key of ["AUTO_SWEEP_LOG_DIR", "AUTO_SWEEP_TMPDIR", "AUTO_SWEEP_SCREENSHOT_DIR", "AUTO_SWEEP_BROWSER_PROFILE_DIR"]) {
    assert.equal(pick.childEnv[key].startsWith("/ws/repo"), false, key);
  }
  assert.equal(pick.sameRepoLimit, 4);
});
test("card dispatch env omits owner token when the pick has none", () => {
  const pick = withCardDispatchEnv({ anchorPath: "/ws/repo", config: { repos: ["repo"] }, sweep: "dev", issueIdentifier: "COD-6" }, "run-id");
  assert.equal(Object.hasOwn(pick.childEnv, "AUTO_SWEEP_OWNER_TOKEN"), false);
  assert.equal(Object.hasOwn(pick.childEnv, "AUTO_SWEEP_CLAIM_DECLARATION"), false);
});
test("card dispatch env rejects partial claim identity", () => {
  const base = { anchorPath: "/ws/repo", config: { repos: ["repo"] }, sweep: "dev", issueIdentifier: "COD-6" };
  assert.throws(() => withCardDispatchEnv({ ...base, ownerToken: "owner" }, "run-id"), /owner and declaration/i);
  assert.throws(() => withCardDispatchEnv({ ...base, claimDeclarationId: "decl" }, "run-id"), /owner and declaration/i);
});

test("dispatch environment excludes stale parent and .env sweep identity", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-dispatch-environment-"));
  const staleKeys = [
    "AUTO_SWEEP_ISSUE",
    "AUTO_SWEEP_REPO_LABEL",
    "AUTO_SWEEP_REPO",
    "AUTO_SWEEP_SOURCE_ANCHOR",
    "AUTO_SWEEP_OWNER_TOKEN",
    "AUTO_SWEEP_CLAIM_DECLARATION",
    "AUTO_SWEEP_CARD_RUN_ID",
    "AUTO_SWEEP_OUTCOME_PATH",
  ];
  const ordinaryKeys = ["PATH", "HTTPS_PROXY", "LINEAR_API_KEY"];
  const original = Object.fromEntries([...staleKeys, ...ordinaryKeys].map((key) => [key, process.env[key]]));
  const parentEnv = {
    AUTO_SWEEP_ISSUE: "COD-parent",
    AUTO_SWEEP_REPO_LABEL: "repo:parent",
    AUTO_SWEEP_REPO: "/parent/repo",
    AUTO_SWEEP_SOURCE_ANCHOR: "/parent/source",
    AUTO_SWEEP_OWNER_TOKEN: "parent-owner",
    AUTO_SWEEP_CLAIM_DECLARATION: "parent-declaration",
    AUTO_SWEEP_CARD_RUN_ID: "parent-run",
    AUTO_SWEEP_OUTCOME_PATH: "/parent/outcome.json",
    PATH: "/parent/bin",
    HTTPS_PROXY: "http://parent-proxy",
    LINEAR_API_KEY: "parent-key",
  };
  fs.writeFileSync(path.join(anchorPath, ".env"), [
    "AUTO_SWEEP_ISSUE=COD-file",
    "AUTO_SWEEP_REPO_LABEL=repo:file",
    "AUTO_SWEEP_REPO=/file/repo",
    "AUTO_SWEEP_SOURCE_ANCHOR=/file/source",
    "AUTO_SWEEP_OWNER_TOKEN=file-owner",
    "AUTO_SWEEP_CLAIM_DECLARATION=file-declaration",
    "AUTO_SWEEP_CARD_RUN_ID=file-run",
    "AUTO_SWEEP_OUTCOME_PATH=/file/outcome.json",
    "PATH=/file/bin",
    "HTTPS_PROXY=http://file-proxy",
    "LINEAR_API_KEY=file-key",
  ].join("\n"));
  Object.assign(process.env, parentEnv);

  try {
    const child = new EventEmitter();
    child.pid = 291;
    let spawnedEnv;
    const run = dispatchAsync(anchorPath, "dev", {}, {
      issueIdentifier: "COD-current",
      logDir: path.join(anchorPath, "logs"),
      runtimeExecutable: "/resolved/codex",
      childEnv: {
        AUTO_SWEEP_ISSUE: "COD-current",
        AUTO_SWEEP_REPO_ENTRY: "current-repo",
        AUTO_SWEEP_OWNER_TOKEN: "current-owner",
      },
    }, {
      spawnFn: (_executable, _args, options) => { spawnedEnv = options.env; return child; },
    });
    child.emit("close", 0, null);
    assert.equal((await run).kind, "success");
    assert.equal(spawnedEnv.AUTO_SWEEP_ISSUE, "COD-current");
    assert.equal(spawnedEnv.AUTO_SWEEP_REPO_ENTRY, "current-repo");
    assert.equal(spawnedEnv.AUTO_SWEEP_OWNER_TOKEN, "current-owner");
    for (const key of staleKeys.filter((key) => !["AUTO_SWEEP_ISSUE", "AUTO_SWEEP_OWNER_TOKEN"].includes(key))) {
      assert.equal(Object.hasOwn(spawnedEnv, key), false, key);
    }
    assert.equal(spawnedEnv.PATH, "/file/bin");
    assert.equal(spawnedEnv.HTTPS_PROXY, "http://file-proxy");
    assert.equal(spawnedEnv.LINEAR_API_KEY, "file-key");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("run records embed structured events and mirror the exact record into the global daily index", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-learning-index-"));
  const logDir = path.join(anchorPath, "logs");
  const globalRunsDir = path.join(anchorPath, "global-runs");
  const learningEventsPath = path.join(logDir, "learning-events.jsonl");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(learningEventsPath, `${JSON.stringify({
    version: 1,
    eventId: "event-1",
    occurredAt: "2026-07-10T12:00:00.000Z",
    kind: "review",
    category: "correctness",
    summary: "Null case",
    metrics: { projectId: "spoofed", repoEntry: "spoofed" },
    identity: { cardRunId: "run-1", issueIdentifier: "COD-143", sweep: "dev", sourceAnchor: fs.realpathSync.native(anchorPath) },
  })}\nmalformed\n`);
  const child = new EventEmitter();
  child.pid = 456;
  const run = dispatchAsync(anchorPath, "dev", {}, {
    issueIdentifier: "COD-143",
    ownerToken: "owner-143",
    claimDeclarationId: "decl-143",
    cardRunId: "run-1",
    sweep: "dev",
    sourceAnchorPath: anchorPath,
    config: { projectId: "project-1", repos: ["app"] },
    repoRoute: { repoEntry: "app" },
    logDir,
    learningEventsPath,
    globalRunsDir,
    runtimeExecutable: "/resolved/codex",
  }, { spawnFn: () => child });
  child.emit("close", 0, null);
  assert.equal((await run).kind, "success");

  const localFile = fs.readdirSync(logDir).find((name) => name.startsWith("run-records-"));
  const globalFile = fs.readdirSync(globalRunsDir).find((name) => name.endsWith(".jsonl"));
  const localRecord = JSON.parse(fs.readFileSync(path.join(logDir, localFile), "utf8").trim());
  const globalRecord = JSON.parse(fs.readFileSync(path.join(globalRunsDir, globalFile), "utf8").trim());
  assert.deepEqual(globalRecord, localRecord);
  assert.equal(localRecord.learningEvents.length, 1);
  assert.equal(localRecord.learningEventCoverageGaps.length, 1);
  assert.equal(localRecord.projectId, "project-1");
  assert.equal(localRecord.repoEntry, "app");
  assert.equal(localRecord.ownerToken, "owner-143");
  assert.equal(localRecord.claimDeclarationId, "decl-143");
});

test("global learning run indexes use the log retention window", () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-learning-retention-"));
  const oldFile = path.join(runsDir, "20260601.jsonl");
  const freshFile = path.join(runsDir, "20260710.jsonl");
  const unrelated = path.join(runsDir, "README.txt");
  fs.writeFileSync(oldFile, "{}\n");
  fs.writeFileSync(freshFile, "{}\n");
  fs.writeFileSync(unrelated, "keep");
  const now = Date.parse("2026-07-10T12:00:00.000Z");
  fs.utimesSync(oldFile, new Date(now - 20 * 86400000), new Date(now - 20 * 86400000));
  fs.utimesSync(freshFile, new Date(now), new Date(now));
  rotateLearningRunIndexes(runsDir, { nowMs: now });
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
  assert.equal(fs.existsSync(unrelated), true);
});

test("unique per-run learning event files use the log retention window", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-learning-event-retention-"));
  const nested = path.join(stateDir, "repo", "dev", "COD-143");
  fs.mkdirSync(nested, { recursive: true });
  const oldFile = path.join(nested, "learning-events-deadbeefdeadbeef.jsonl");
  const freshFile = path.join(nested, "learning-events-cafebabecafebabe.jsonl");
  const runRecord = path.join(nested, "run-records-20260710.jsonl");
  fs.writeFileSync(oldFile, "{}\n");
  fs.writeFileSync(freshFile, "{}\n");
  fs.writeFileSync(runRecord, "{}\n");
  const now = Date.parse("2026-07-10T12:00:00.000Z");
  fs.utimesSync(oldFile, new Date(now - 20 * 86400000), new Date(now - 20 * 86400000));
  fs.utimesSync(freshFile, new Date(now), new Date(now));
  rotateLearningEventFiles(stateDir, { nowMs: now });
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
  assert.equal(fs.existsSync(runRecord), true);
});
test("kit root test expectation decodes spaces in file URLs", () => {
  const encodedTestUrl = new URL("file:///tmp/linear%20board/tests/linear-watch.test.mjs");
  assert.equal(path.resolve(fileURLToPath(new URL("..", encodedTestUrl))), "/tmp/linear board");
});
test("card dispatch env prefers the original source anchor for managed workspaces", () => {
  const pick = withCardDispatchEnv({
    anchorPath: "/managed/repo",
    sourceAnchorPath: "/source/repo",
    config: { repos: ["repo"] },
    sweep: "qa",
    issueIdentifier: "COD-7",
  }, "run-id");
  assert.equal(pick.childEnv.AUTO_SWEEP_SOURCE_ANCHOR, "/source/repo");
  assert.equal(pick.childEnv.AUTO_SWEEP_ANCHOR, "/managed/repo");
});
test("card dispatch env canonicalizes the trusted source workspace identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linear-learning-anchor-"));
  const real = path.join(root, "real");
  const alias = path.join(root, "alias");
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias);
  const pick = withCardDispatchEnv({
    anchorPath: alias,
    sourceAnchorPath: alias,
    config: { repos: [alias] },
    sweep: "dev",
    issueIdentifier: "COD-143",
  }, "run-id");
  assert.equal(pick.childEnv.AUTO_SWEEP_SOURCE_ANCHOR, fs.realpathSync.native(real));
});
test("card dispatch env uses the routed managed sibling for worktrees and exports both repo paths", () => {
  const repoRoute = {
    ok: true,
    label: "app:guide",
    repoEntry: "safetaper-guide",
    sourceRepoPath: "/source/safetaper-guide",
    managedRepoPath: "/managed/ws/source-safetaper-guide-a1b2",
  };
  assert.equal(
    cardWorktreePath("/managed/ws/safetaper-coach", { repos: ["safetaper-coach", "safetaper-guide"] }, "SAF-207", repoRoute),
    "/managed/ws/source-safetaper-guide-a1b2/.worktrees/SAF-207",
  );
  const pick = withCardDispatchEnv({
    anchorPath: "/managed/ws/safetaper-coach",
    sourceAnchorPath: "/source/safetaper-coach",
    config: { repos: ["safetaper-coach", "safetaper-guide"] },
    sweep: "dev",
    issueIdentifier: "SAF-207",
    repoRoute,
  }, "run-id");
  assert.equal(pick.worktreePath, "/managed/ws/source-safetaper-guide-a1b2/.worktrees/SAF-207");
  assert.equal(pick.childEnv.AUTO_SWEEP_REPO, repoRoute.managedRepoPath);
  assert.equal(pick.childEnv.AUTO_SWEEP_SOURCE_REPO, repoRoute.sourceRepoPath);
  assert.equal(pick.childEnv.AUTO_SWEEP_REPO_LABEL, "app:guide");
  assert.equal(pick.childEnv.AUTO_SWEEP_REPO_ENTRY, "safetaper-guide");
});
test("expandDispatchBatch: Ship claims ordinary demand and receives the owner-token env", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-ship-env-"));
  const globalRunsDir = path.join(anchorPath, "global-runs");
  const productionRunsDir = path.join(os.homedir(), ".local", "state", "linear-board-sweeps", "runs");
  const snapshotProductionIndex = () => Object.fromEntries((fs.existsSync(productionRunsDir) ? fs.readdirSync(productionRunsDir) : []).sort().map((name) => {
    const stat = fs.statSync(path.join(productionRunsDir, name));
    return [name, { size: stat.size, mtimeMs: stat.mtimeMs }];
  }));
  const productionBefore = snapshotProductionIndex();
  let claimCalls = 0;
  const shipCard = dependencyReadyCard({ id: "ship-id", identifier: "COD-77", sortOrder: 10 });
  const [pick] = await expandDispatchBatch([{
    anchorPath,
    sourceAnchorPath: "/source/repo",
    globalRunsDir,
    config: { repos: [anchorPath] },
    sweep: "ship",
    count: 1,
    topCard: shipCard,
    cards: [shipCard],
    issueId: "ship-id",
    issueIdentifier: "COD-77",
  }], {
    dryRun: false,
    parentRunId: "ship-run",
    activeByAnchor: new Map([[anchorPath, { apiKey: "key", repoPairs: [] }]]),
    now: NOW,
    labelMap: { "ship:in-progress": "ship-claim-id" },
    claimCardSlotsFn: async (_apiKey, _anchorPath, _config, sweep, cards, options) => {
      claimCalls += 1;
      assert.equal(sweep, "ship");
      assert.equal(options.limit, 1);
      assert.equal(cards[0].identifier, "COD-77");
      return [{ ...cards[0], card: cards[0], slotIndex: 0, ownerToken: "ship-owner", claimDeclarationId: "ship-decl" }];
    },
  });
  assert.equal(claimCalls, 1);
  assert.equal(pick.childEnv.AUTO_SWEEP_KIT_PATH, path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  assert.equal(pick.childEnv.AUTO_SWEEP_ISSUE, "COD-77");
  assert.equal(pick.childEnv.AUTO_SWEEP_OWNER_TOKEN, "ship-owner");
  assert.equal(pick.issueId, "ship-id");
  assert.match(pick.logDir, /ship\/COD-77$/);

  const child = new EventEmitter();
  child.pid = 501;
  let spawnedEnv;
  const run = dispatchAsync(anchorPath, "ship", {}, { ...pick, runtimeExecutable: "/resolved/codex" }, {
    spawnFn: (_executable, _args, options) => { spawnedEnv = options.env; return child; },
  });
  child.emit("close", 0, null);
  assert.equal((await run).kind, "success");
  assert.equal(spawnedEnv.AUTO_SWEEP_ISSUE, "COD-77");
  assert.equal(spawnedEnv.AUTO_SWEEP_OWNER_TOKEN, "ship-owner");
  assert.equal(pick.globalRunsDir, globalRunsDir);
  const recordName = fs.readdirSync(pick.logDir).find((name) => name.startsWith("run-records-"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(pick.logDir, recordName), "utf8")).issueIdentifier, "COD-77");
  assert.equal(fs.readdirSync(globalRunsDir).some((name) => name.endsWith(".jsonl")), true);
  assert.deepEqual(snapshotProductionIndex(), productionBefore);
});
test("expandDispatchBatch: a normal Ship candidate acquires an immutable claim before dispatch", async () => {
  const card = dependencyReadyCard({ id: "ship-id", identifier: "COD-77", stateName: "Ship", sortOrder: 10, labelNames: [] });
  let claimCalls = 0;
  const [pick] = await expandDispatchBatch([{
    anchorPath: "/managed/repo",
    sourceAnchorPath: "/source/repo",
    config: { teamKey: "COD", repos: ["repo"] },
    sweep: "ship",
    count: 1,
    cards: [card],
    topCard: card,
    issueId: card.id,
    issueIdentifier: card.identifier,
  }], {
    dryRun: false,
    parentRunId: "ship-run",
    activeByAnchor: new Map([["/managed/repo", { apiKey: "key", repoPairs: [] }]]),
    now: NOW,
    labelMap: { "ship:in-progress": "ship-label" },
    claimCardSlotsFn: async (_apiKey, _anchorPath, _config, sweep, cards) => {
      claimCalls += 1;
      assert.equal(sweep, "ship");
      assert.deepEqual(cards.map((item) => item.identifier), ["COD-77"]);
      return [{ ...card, card, sweep, slotIndex: 0, ownerToken: "ship-owner", claimDeclarationId: "ship-decl" }];
    },
  });
  assert.equal(claimCalls, 1);
  assert.equal(pick.childEnv.AUTO_SWEEP_OWNER_TOKEN, "ship-owner");
  assert.equal(pick.childEnv.AUTO_SWEEP_CLAIM_DECLARATION, "ship-decl");
});
test("expandDispatchBatch: Ship route-label races fail before child expansion", async () => {
  const config = { repos: ["coach", "guide"], repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } } };
  const repoPairs = [
    { repoEntry: "coach", sourceRepoPath: "/source/coach", managedRepoPath: "/managed/coach" },
    { repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
  ];
  const repoRoute = resolveCardRepoRoute({ config, card: { identifier: "SAF-9", labelNames: ["app:guide"] }, repoPairs });
  const failures = [];
  const children = await expandDispatchBatch([{
    anchorPath: "/managed/coach",
    sourceAnchorPath: "/source/coach",
    config,
    repoPairs,
    sweep: "ship",
    issueId: "issue-id",
    issueIdentifier: "SAF-9",
    repoRoute,
    topCard: { id: "issue-id", identifier: "SAF-9", labelNames: ["app:guide"], repoRoute },
    cards: [{ id: "issue-id", identifier: "SAF-9", labelNames: ["app:guide"], repoRoute }],
  }], {
    dryRun: false,
    parentRunId: "run-id",
    activeByAnchor: new Map([["/managed/coach", { apiKey: "key", repoPairs }]]),
    now: NOW,
    labelMap: { "ship:in-progress": "ship-claim-id" },
    claimCardSlotsFn: async (_apiKey, _anchorPath, _config, _sweep, cards, _options, deps) => {
      deps.onRouteFailure(cards[0], { message: "repository route changed before claim" });
      return [];
    },
    onRouteFailure: (_pick, failure) => failures.push(failure),
  });
  assert.deepEqual(children, []);
  assert.equal(failures.length, 1);
});
test("expandDispatchBatch: a stable Ship route expands the routed production worktree", async () => {
  const config = { repos: ["coach", "guide"], repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } } };
  const repoPairs = [
    { repoEntry: "coach", sourceRepoPath: "/source/coach", managedRepoPath: "/managed/coach" },
    { repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
  ];
  const fresh = { id: "issue-id", identifier: "SAF-9", labelNames: ["app:guide"] };
  const repoRoute = resolveCardRepoRoute({ config, card: fresh, repoPairs });
  const [child] = await expandDispatchBatch([{
    anchorPath: "/managed/coach",
    sourceAnchorPath: "/source/coach",
    config,
    repoPairs,
    sweep: "ship",
    issueId: fresh.id,
    issueIdentifier: fresh.identifier,
    repoRoute,
    topCard: { ...fresh, repoRoute },
    cards: [{ ...fresh, repoRoute }],
  }], {
    dryRun: false,
    parentRunId: "run-id",
    activeByAnchor: new Map([["/managed/coach", { apiKey: "key", repoPairs }]]),
    now: NOW,
    labelMap: { "ship:in-progress": "ship-claim-id" },
    claimCardSlotsFn: async () => [{ ...fresh, card: fresh, repoRoute, slotIndex: 0, ownerToken: "ship-owner", claimDeclarationId: "ship-decl" }],
  });
  assert.equal(child.worktreePath, "/managed/guide/.worktrees/SAF-9");
  assert.equal(child.childEnv.AUTO_SWEEP_REPO, "/managed/guide");
  assert.equal(child.childEnv.AUTO_SWEEP_SOURCE_REPO, "/source/guide");
});
test("expandDispatchBatch: a failed Ship route read creates no child and reports the failure", async () => {
  const config = { repos: ["guide"], repoRouting: { byLabel: { "app:guide": "guide" } } };
  const repoPairs = [{ repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" }];
  const card = { id: "issue-id", identifier: "SAF-9", labelNames: ["app:guide"] };
  const repoRoute = resolveCardRepoRoute({ config, card, repoPairs });
  const failures = [];
  const children = await expandDispatchBatch([{
    anchorPath: "/managed/guide", config, repoPairs, sweep: "ship", issueId: card.id, issueIdentifier: card.identifier, repoRoute, topCard: { ...card, repoRoute }, cards: [{ ...card, repoRoute }],
  }], {
    dryRun: false,
    parentRunId: "run-id",
    activeByAnchor: new Map([["/managed/guide", { apiKey: "key", repoPairs }]]),
    now: NOW,
    labelMap: { "ship:in-progress": "ship-claim-id" },
    claimCardSlotsFn: async () => {
      failures.push({ message: "could not re-read SAF-9 repository route: Linear unavailable" });
      return [];
    },
    onRouteFailure: (_pick, failure) => failures.push(failure),
  });
  assert.deepEqual(children, []);
  assert.match(failures[0].message, /could not re-read SAF-9 repository route/);
});

test("claimCardSlots: a fresh route-label race fails before applying the claim", async () => {
  const repoPairs = [
    { repoEntry: "coach", sourceRepoPath: "/source/coach", managedRepoPath: "/managed/coach" },
    { repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
  ];
  const config = {
    repos: ["coach", "guide"],
    repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } },
  };
  const guideRoute = resolveCardRepoRoute({
    config,
    card: { identifier: "SAF-207", labelNames: ["app:guide"] },
    repoPairs,
  });
  let claimEdits = 0;
  const claimed = await claimCardSlots("key", "/managed/coach", config, "dev", [dependencyReadyCard({
    id: "issue-id",
    identifier: "SAF-207",
    stateName: "Dev",
    labelNames: ["app:guide"],
    comments: [],
    updatedAt: minsAgo(1),
    sortOrder: 1,
    repoRoute: guideRoute,
  })], {
    parentRunId: "run-id",
    limit: 1,
    labelMap: { "dev:in-progress": "claim-id" },
    now: NOW,
    repoPairs,
  }, {
    applyLabelEditFn: async () => { claimEdits += 1; },
    fetchClaimCardFn: async () => dependencyReadyCard({
      id: "issue-id",
      identifier: "SAF-207",
      stateName: "Dev",
      labelNames: ["app:coach"],
      commentsComplete: true,
      comments: [],
    }),
  });
  assert.deepEqual(claimed, []);
  assert.equal(claimEdits, 0);
});
test("claimCardSlots: a failed fresh route read reports a routing failure without claiming", async () => {
  const config = { repos: ["guide"], repoRouting: { byLabel: { "app:guide": "guide" } } };
  const repoPairs = [{ repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" }];
  const card = dependencyReadyCard({ id: "issue-id", identifier: "SAF-207", stateName: "Dev", labelNames: ["app:guide"], comments: [], updatedAt: minsAgo(1), sortOrder: 1 });
  card.repoRoute = resolveCardRepoRoute({ config, card, repoPairs });
  const failures = [];
  let claimEdits = 0;
  const claimed = await claimCardSlots("key", "/managed/guide", config, "dev", [card], {
    parentRunId: "run-id",
    limit: 1,
    labelMap: { "dev:in-progress": "claim-id" },
    now: NOW,
    repoPairs,
  }, {
    fetchClaimCardFn: async () => { throw new Error("Linear unavailable"); },
    applyLabelEditFn: async () => { claimEdits += 1; },
    onRouteFailure: (_card, failure) => failures.push(failure),
  });
  assert.deepEqual(claimed, []);
  assert.equal(claimEdits, 0);
  assert.match(failures[0].message, /could not re-read SAF-207 repository route/);
});
test("claimCardSlots: declaration precedes label and exact declaration reaches the child pick without a compatibility heartbeat", async () => {
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-169", stateName: "Dev", labelNames: [], comments: [], updatedAt: minsAgo(1), sortOrder: 1 });
  const calls = [];
  const comments = [];
  let reads = 0;
  const claimed = await claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run-id", limit: 1, labelMap: { "dev:in-progress": "claim-id" }, now: NOW,
  }, {
    declarationTokenFn: () => "decl-winner",
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    addCommentFn: async (_key, _id, body) => {
      calls.push(body.startsWith("[auto-sweep-claim ") ? "declaration" : "unexpected-comment");
      comments.push({ id: `c${comments.length + 1}`, body, createdAt: claimIso(comments.length + 1) });
    },
    applyLabelEditFn: async () => { calls.push("label"); },
    sleepFn: async () => {},
    fetchCardFn: async () => {
      reads += 1;
      calls.push("winner-read");
      return { ...card, labelNames: ["dev:in-progress"], commentsComplete: true, comments: [...comments] };
    },
  });
  assert.deepEqual(calls, ["declaration", "label", "winner-read"]);
  assert.equal(claimed[0].claimDeclarationId, "decl-winner");
});
test("claimCardSlots: a fresh unlabeled orphan declaration blocks every acquisition write", async () => {
  const orphan = { id: "c0", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "crashed", declarationId: "orphan-decl" }), createdAt: minsAgo(1) };
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-169", stateName: "Dev", labelNames: [], comments: [], updatedAt: minsAgo(1), sortOrder: 1 });
  let declarationWrites = 0;
  let labelWrites = 0;
  const claimed = await claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run-id", limit: 1, labelMap: { "dev:in-progress": "claim-id" }, now: NOW,
  }, {
    fetchClaimCardFn: async () => ({ ...card, commentsComplete: true, comments: [orphan] }),
    addCommentFn: async () => { declarationWrites += 1; },
    applyLabelEditFn: async () => { labelWrites += 1; },
  });
  assert.deepEqual(claimed, []);
  assert.equal(declarationWrites, 0);
  assert.equal(labelWrites, 0);
});
test("claimCardSlots: a stale unlabeled orphan is reset before the next declaration", async () => {
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-169", stateName: "Dev", labelNames: [], comments: [], updatedAt: minsAgo(300), sortOrder: 1 });
  const comments = [
    { id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "crashed", declarationId: "orphan-decl" }), createdAt: minsAgo(300) },
  ];
  const calls = [];
  let labelPresent = false;
  const snapshot = () => ({
    ...card,
    labelNames: labelPresent ? ["dev:in-progress"] : [],
    commentsComplete: true,
    comments: [...comments],
  });
  const claimed = await claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run-id", limit: 1, labelMap: { "dev:in-progress": "claim-id" }, now: NOW,
  }, {
    declarationTokenFn: () => "next-decl",
    fetchClaimCardFn: async () => { calls.push("preflight-read"); return snapshot(); },
    fetchCardFn: async () => { calls.push("winner-read"); return snapshot(); },
    addCommentFn: async (_key, _id, body) => {
      const kind = body.startsWith("[auto-sweep-claim-reset ") ? "reset" : "declaration";
      calls.push(kind);
      comments.push({ id: `c${comments.length + 1}`, body, createdAt: minsAgo(kind === "reset" ? 2 : 1) });
    },
    applyLabelEditFn: async (_key, _card, edit) => {
      if (edit.add) { calls.push("label"); labelPresent = true; }
    },
    sleepFn: async () => {},
  });
  assert.equal(claimed[0].claimDeclarationId, "next-decl");
  assert.ok(calls.indexOf("reset") < calls.indexOf("declaration"));
  assert.ok(calls.indexOf("declaration") < calls.indexOf("label"));
});
test("claimCardSlots: only the first declaration wins and a loser never removes the shared label", async () => {
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-169", stateName: "Dev", labelNames: [], comments: [], updatedAt: minsAgo(1), sortOrder: 1 });
  const removals = [];
  let ourDeclaration;
  let compatibilityHeartbeats = 0;
  const claimed = await claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run-id", limit: 1, labelMap: { "dev:in-progress": "claim-id" }, now: NOW,
  }, {
    declarationTokenFn: () => "decl-loser",
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    addCommentFn: async (_key, _id, body) => {
      if (body.startsWith("[auto-sweep-claim ")) ourDeclaration = body;
      else compatibilityHeartbeats += 1;
    },
    applyLabelEditFn: async (_key, _fresh, edit) => { if (edit.remove) removals.push(edit); },
    sleepFn: async () => {},
    fetchCardFn: async () => ({
      ...card,
      labelNames: ["dev:in-progress"],
      commentsComplete: true,
      comments: [
        { id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "winner", declarationId: "decl-winner" }), createdAt: claimIso(1) },
        { id: "c2", body: ourDeclaration, createdAt: claimIso(2) },
      ],
    }),
  });
  assert.deepEqual(claimed, []);
  assert.deepEqual(removals, []);
  assert.equal(compatibilityHeartbeats, 0);
});
test("claimCardSlots: malformed final history denies dispatch without removing the shared label", async () => {
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-169", stateName: "Dev", labelNames: [], comments: [], updatedAt: minsAgo(1), sortOrder: 1 });
  let removals = 0;
  const safety = [];
  await assert.rejects(claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run-id", limit: 1, labelMap: { "dev:in-progress": "claim-id" }, now: NOW,
  }, {
    declarationTokenFn: () => "decl",
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    addCommentFn: async () => {},
    applyLabelEditFn: async (_key, _fresh, edit) => { if (edit.remove) removals += 1; },
    sleepFn: async () => {},
    fetchCardFn: async () => ({ ...card, labelNames: ["dev:in-progress"], commentsComplete: true, comments: [
      { id: "c1", body: "[auto-sweep-claim v1 claim=dev:in-progress broken]", createdAt: claimIso(1) },
    ] }),
    onSafetyInvariant: (value) => safety.push(value),
  }), (error) => error.code === "CLAIM_CLEANUP_UNVERIFIED");
  assert.equal(removals, 0);
  assert.equal(safety.length, 1);
});
test("claimCardSlots: legacy-unowned reread without the exact close never removes the label", async () => {
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-169", stateName: "Dev", labelNames: [], comments: [], updatedAt: minsAgo(1), sortOrder: 1 });
  const comments = [];
  let reads = 0;
  let removals = 0;
  const safety = [];
  await assert.rejects(claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run-id", limit: 1, labelMap: { "dev:in-progress": "claim-id" }, now: NOW,
  }, {
    declarationTokenFn: () => "decl-missing-close",
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    addCommentFn: async (_key, _id, body) => comments.push({ id: `c${comments.length + 1}`, body, createdAt: claimIso(comments.length + 1) }),
    applyLabelEditFn: async (_key, _fresh, edit) => { if (edit.remove) removals += 1; },
    sleepFn: async () => {},
    fetchCardFn: async () => {
      reads += 1;
      if (reads === 1) return { ...card, labelNames: ["dev:in-progress", "blocked:needs-user"], commentsComplete: true, comments: comments.slice(0, 2) };
      return { ...card, labelNames: ["dev:in-progress"], commentsComplete: true, comments: [] };
    },
    onSafetyInvariant: (value) => safety.push(value),
  }), (error) => error.code === "CLAIM_CLEANUP_UNVERIFIED" && /close/.test(error.message));
  assert.equal(removals, 0);
  assert.equal(safety.length, 1);
});
test("claimCardSlots: a post-claim route race closes then removes only this attempt's owned claim", async () => {
  const repoPairs = [
    { repoEntry: "coach", sourceRepoPath: "/source/coach", managedRepoPath: "/managed/coach" },
    { repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
  ];
  const config = { repos: ["coach", "guide"], repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } } };
  const card = dependencyReadyCard({
    id: "issue-id",
    identifier: "SAF-207",
    stateName: "Dev",
    labelNames: ["app:guide"],
    comments: [],
    updatedAt: minsAgo(1),
    sortOrder: 1,
  });
  card.repoRoute = resolveCardRepoRoute({ config, card, repoPairs });
  const edits = [];
  const comments = [];
  const claimed = await claimCardSlots("key", "/managed/coach", config, "dev", [card], {
    parentRunId: "run-id",
    limit: 1,
    labelMap: { "dev:in-progress": "claim-id" },
    now: NOW,
    repoPairs,
  }, {
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    applyLabelEditFn: async (_key, _card, edit) => edits.push(edit),
    declarationTokenFn: () => "decl-route",
    addCommentFn: async (_key, _id, body) => { comments.push({ id: `c${comments.length + 1}`, body, createdAt: claimIso(comments.length + 1) }); },
    sleepFn: async () => {},
    fetchCardFn: async () => dependencyReadyCard({
      ...card,
      labelNames: ["app:coach", "dev:in-progress"],
      commentsComplete: true,
      comments: [...comments],
    }),
  });
  assert.deepEqual(claimed, []);
  assert.deepEqual(edits, [
    { add: { "dev:in-progress": "claim-id" } },
    { remove: ["dev:in-progress"] },
  ]);
});
test("claimCardSlots: a delayed claimant after close verification preserves the shared label", async () => {
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-169", stateName: "Dev", labelNames: [], comments: [], updatedAt: minsAgo(1), sortOrder: 1 });
  const comments = [];
  let reads = 0;
  let removals = 0;
  const claimed = await claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run-id", limit: 1, labelMap: { "dev:in-progress": "claim-id" }, now: NOW,
  }, {
    declarationTokenFn: () => "our-decl",
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    addCommentFn: async (_key, _id, body) => comments.push({ id: `c${comments.length + 1}`, body, createdAt: claimIso(comments.length + 1) }),
    applyLabelEditFn: async (_key, _fresh, edit) => { if (edit.remove) removals += 1; },
    sleepFn: async () => {},
    fetchCardFn: async () => {
      reads += 1;
      if (reads === 1) return dependencyReadyCard({ ...card, labelNames: ["dev:in-progress", "blocked:needs-user"], commentsComplete: true, comments: [...comments] });
      if (reads === 3) comments.push({ id: "contender", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "new-owner", declarationId: "new-decl" }), createdAt: claimIso(3) });
      return dependencyReadyCard({ ...card, labelNames: ["dev:in-progress"], commentsComplete: true, comments: [...comments] });
    },
  });
  assert.deepEqual(claimed, []);
  assert.equal(reads, 3);
  assert.equal(removals, 0);
});
test("claimCardSlots: a stable routed claim returns the confirmed primary repo", async () => {
  const config = { repos: ["guide"], repoRouting: { byLabel: { "app:guide": "guide" } } };
  const repoPairs = [{ repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" }];
  const card = dependencyReadyCard({ id: "issue-id", identifier: "SAF-207", stateName: "Dev", labelNames: ["app:guide"], comments: [], updatedAt: minsAgo(1), sortOrder: 1 });
  card.repoRoute = resolveCardRepoRoute({ config, card, repoPairs });
  const comments = [];
  const claimed = await claimCardSlots("key", "/managed/guide", config, "dev", [card], {
    parentRunId: "run-id",
    limit: 1,
    labelMap: { "dev:in-progress": "claim-id" },
    now: NOW,
    repoPairs,
  }, {
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    applyLabelEditFn: async () => {},
    declarationTokenFn: () => "decl-stable",
    addCommentFn: async (_key, _id, body) => comments.push({ id: `c${comments.length + 1}`, body, createdAt: claimIso(comments.length + 1) }),
    sleepFn: async () => {},
    fetchCardFn: async () => dependencyReadyCard({
      ...card,
      labelNames: ["app:guide", "dev:in-progress"],
      commentsComplete: true,
      comments: [...comments],
    }),
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].repoRoute.managedRepoPath, "/managed/guide");
  assert.equal(claimed[0].claimDeclarationId, "decl-stable");
});

test("claimCardSlots: an unreadable confirmation records the safety invariant and never removes a label", async () => {
  let removals = 0;
  const safety = [];
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-88", sortOrder: 10, labelNames: [], comments: [] });
  await assert.rejects(claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run", limit: 1, labelMap: { "dev:in-progress": "label-dev" }, now: NOW,
  }, {
    declarationTokenFn: () => "decl-88",
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    applyLabelEditFn: async (_key, _fresh, edit) => { if (edit.remove) removals += 1; },
    addCommentFn: async () => {},
    sleepFn: async () => {},
    fetchCardFn: async () => { throw new Error("confirmation unavailable"); },
    onSafetyInvariant: (value) => safety.push(value),
  }), (error) => error.code === "CLAIM_CLEANUP_UNVERIFIED" && /confirmation unavailable/.test(error.message));
  assert.equal(removals, 0);
  assert.equal(safety.length, 1);
});

test("claimCardSlots: label-write failure closes its orphan declaration without removing a shared label", async () => {
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-89", sortOrder: 10, labelNames: [], comments: [] });
  const comments = [];
  let reads = 0;
  let removals = 0;
  const claimed = await claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run", limit: 1, labelMap: { "dev:in-progress": "label-dev" }, now: NOW,
  }, {
    declarationTokenFn: () => "decl-89",
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    addCommentFn: async (_key, _id, body) => comments.push({ id: `c${comments.length + 1}`, body, createdAt: claimIso(comments.length + 1) }),
    applyLabelEditFn: async (_key, _fresh, edit) => { if (edit.add) throw new Error("label unavailable"); if (edit.remove) removals += 1; },
    fetchCardFn: async () => { reads += 1; return { ...card, commentsComplete: true, comments: [...comments] }; },
  });
  assert.deepEqual(claimed, []);
  assert.equal(reads, 3);
  assert.equal(removals, 0);
  assert.equal(comments.at(-1).body, claimCloseMarker({ claim: "dev:in-progress", declarationId: "decl-89", reason: "failed" }));
});

test("claimCardSlots: a declaration-write failure with no observed declaration never edits the label", async () => {
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-92", sortOrder: 10, labelNames: [], comments: [] });
  let edits = 0;
  const claimed = await claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run", limit: 1, labelMap: { "dev:in-progress": "label-dev" }, now: NOW,
  }, {
    declarationTokenFn: () => "decl-92",
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    addCommentFn: async () => { throw new Error("declaration unavailable"); },
    applyLabelEditFn: async () => { edits += 1; },
    fetchCardFn: async () => ({ ...card, commentsComplete: true, comments: [] }),
  });
  assert.deepEqual(claimed, []);
  assert.equal(edits, 0);
});

test("claimCardSlots: another declaration owner is preserved after an acquisition exception", async () => {
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-93", sortOrder: 10, labelNames: [], comments: [] });
  let removals = 0;
  const claimed = await claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run", limit: 1, labelMap: { "dev:in-progress": "label-dev" }, now: NOW,
  }, {
    declarationTokenFn: () => "decl-loser",
    fetchClaimCardFn: async () => completeUnclaimedCard(card),
    addCommentFn: async () => { throw new Error("declaration response unavailable"); },
    applyLabelEditFn: async (_key, _fresh, edit) => { if (edit.remove) removals += 1; },
    fetchCardFn: async () => ({
      ...card,
      labelNames: ["dev:in-progress"],
      commentsComplete: true,
      comments: [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "winner", declarationId: "decl-winner" }), createdAt: claimIso(1) }],
    }),
  });
  assert.deepEqual(claimed, []);
  assert.equal(removals, 0);
});

test("releaseOwnedDispatchClaim: dependency deferral removes only the matching owned claim", async () => {
  assert.equal(typeof watchModule.releaseOwnedDispatchClaim, "function");
  const edits = [];
  let claimed = true;
  const comments = [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-91", declarationId: "decl-91" }), createdAt: claimIso(1) }];
  const fresh = () => ({
    id: "issue-91", identifier: "COD-91", labelNames: claimed ? ["dev:in-progress"] : [],
    commentsComplete: true, comments: [...comments],
  });
  const released = await watchModule.releaseOwnedDispatchClaim("key", {
    sweep: "dev", issueId: "issue-91", issueIdentifier: "COD-91", ownerToken: "owner-91", claimDeclarationId: "decl-91",
  }, "dependency preflight deferred material work", {
    fetchClaimCardFn: async () => fresh(),
    applyLabelEditFn: async (_key, _card, edit) => { edits.push(edit); claimed = false; },
    addCommentFn: async (_key, _id, body) => comments.push({ id: "c2", body, createdAt: claimIso(2) }),
  });
  assert.equal(released, true);
  assert.deepEqual(edits, [{ remove: ["dev:in-progress"] }]);

  assert.equal(await watchModule.releaseOwnedDispatchClaim("key", {
    sweep: "dev", issueId: "issue-91", issueIdentifier: "COD-91", ownerToken: "other-owner", claimDeclarationId: "other-decl",
  }, "dependency deferred", { fetchClaimCardFn: async () => fresh() }), false);
});

test("releaseOwnedDispatchClaim: closes and verifies the exact epoch before removing the label", async () => {
  const calls = [];
  let claimed = true;
  const comments = [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: claimIso(1) }];
  const card = () => ({ id: "issue", identifier: "COD-169", stateName: "Dev", labelNames: claimed ? ["dev:in-progress"] : [], labelIds: claimed ? { "dev:in-progress": "label" } : {}, commentsComplete: true, comments: [...comments] });
  const released = await watchModule.releaseOwnedDispatchClaim("key", {
    sweep: "dev", issueId: "issue", issueIdentifier: "COD-169", ownerToken: "owner", claimDeclarationId: "decl",
  }, "dependency preflight deferred material work", {
    fetchClaimCardFn: async () => { calls.push("fetch"); return card(); },
    addCommentFn: async (_key, _id, body) => { calls.push("comment-close"); comments.push({ id: "c2", body, createdAt: claimIso(2) }); },
    applyLabelEditFn: async () => { calls.push("label-remove"); claimed = false; },
    addAuditCommentFn: async () => calls.push("comment-audit"),
  });
  assert.equal(released, true);
  assert.deepEqual(calls, ["fetch", "comment-close", "fetch", "fetch", "label-remove", "fetch", "comment-audit"]);
});

test("releaseOwnedDispatchClaim: a stale child cannot release a newer declaration", async () => {
  let removals = 0;
  const fresh = {
    id: "issue", identifier: "COD-169", stateName: "Dev", labelNames: ["dev:in-progress"], commentsComplete: true,
    comments: [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "new", declarationId: "new-decl" }), createdAt: claimIso(1) }],
  };
  assert.equal(await watchModule.releaseOwnedDispatchClaim("key", {
    sweep: "dev", issueId: "issue", issueIdentifier: "COD-169", ownerToken: "old", claimDeclarationId: "old-decl",
  }, "late", { fetchClaimCardFn: async () => fresh, applyLabelEditFn: async () => { removals += 1; } }), false);
  assert.equal(removals, 0);
});

test("closeOwnedClaim: close write and verification failures never mutate the label", async () => {
  const identity = { ownerToken: "owner", claimDeclarationId: "decl" };
  const cfg = SWEEP_CFG.dev;
  const active = { id: "issue", labelNames: [cfg.claim], commentsComplete: true, comments: [
    { id: "c1", body: claimDeclarationMarker({ claim: cfg.claim, ownerToken: "owner", declarationId: "decl" }), createdAt: claimIso(1) },
  ] };
  let edits = 0;
  await assert.rejects(closeOwnedClaim("key", active, cfg, identity, "failed", {
    fetchClaimCardFn: async () => active,
    addCommentFn: async () => { throw new Error("close unavailable"); },
    applyLabelEditFn: async () => { edits += 1; },
  }), /close unavailable/);
  await assert.rejects(closeOwnedClaim("key", active, cfg, identity, "failed", {
    fetchClaimCardFn: async () => active,
    addCommentFn: async () => {},
    applyLabelEditFn: async () => { edits += 1; },
  }), /close unverified/);
  assert.equal(edits, 0);
});
test("closeOwnedClaim: a newer declaration on the final pre-mutation read preserves the label", async () => {
  const cfg = SWEEP_CFG.dev;
  const identity = { ownerToken: "owner", claimDeclarationId: "decl" };
  const comments = [
    { id: "c1", body: claimDeclarationMarker({ claim: cfg.claim, ownerToken: identity.ownerToken, declarationId: identity.claimDeclarationId }), createdAt: claimIso(1) },
  ];
  let reads = 0;
  let edits = 0;
  const snapshot = () => ({ id: "issue", labelNames: [cfg.claim], commentsComplete: true, comments: [...comments] });
  const released = await closeOwnedClaim("key", { id: "issue" }, cfg, identity, "released", {
    fetchClaimCardFn: async () => {
      reads += 1;
      if (reads === 3) comments.push({ id: "c3", body: claimDeclarationMarker({ claim: cfg.claim, ownerToken: "new-owner", declarationId: "new-decl" }), createdAt: claimIso(3) });
      return snapshot();
    },
    addCommentFn: async (_key, _id, body) => comments.push({ id: "c2", body, createdAt: claimIso(2) }),
    applyLabelEditFn: async () => { edits += 1; },
  });
  assert.equal(released, false);
  assert.equal(reads, 3);
  assert.equal(edits, 0);
});

test("administrative reset: exact stale declaration is reset and verified before mutation may continue", async () => {
  assert.equal(typeof watchModule.resetStaleClaimBoundary, "function");
  const calls = [];
  const comments = [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: minsAgo(300) }];
  const card = () => ({ id: "issue", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], commentsComplete: true, comments: [...comments] });
  const reset = await watchModule.resetStaleClaimBoundary("key", card(), "dev:in-progress", "decl", 45, NOW, {
    fetchClaimCardFn: async () => { calls.push("fetch"); return card(); },
    addCommentFn: async (_key, _id, body) => { calls.push("comment-reset"); comments.push({ id: "c2", body, createdAt: minsAgo(1) }); },
  });
  calls.push("mutation-ready");
  assert.ok(reset);
  assert.deepEqual(calls, ["fetch", "comment-reset", "fetch", "mutation-ready"]);
});

test("administrative reset: refreshed, newer, duplicate, and unverified targets fail closed", async () => {
  const old = { id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "old", declarationId: "old-decl" }), createdAt: minsAgo(300) };
  const freshBeat = { id: "c2", body: claimHeartbeatMarker({ claim: "dev:in-progress", declarationId: "old-decl", at: minsAgo(1) }), createdAt: minsAgo(1) };
  let writes = 0;
  assert.equal(await watchModule.resetStaleClaimBoundary("key", { id: "issue" }, "dev:in-progress", "old-decl", 45, NOW, {
    fetchClaimCardFn: async () => ({ id: "issue", labelNames: ["dev:in-progress"], commentsComplete: true, comments: [old, freshBeat] }),
    addCommentFn: async () => { writes += 1; },
  }), null);
  const newer = { id: "c3", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "new", declarationId: "new-decl" }), createdAt: minsAgo(100) };
  const resetOld = { id: "c2", body: claimResetMarker({ claim: "dev:in-progress", target: "old-decl", reason: "orphan-declaration" }), createdAt: minsAgo(200) };
  assert.equal(await watchModule.resetStaleClaimBoundary("key", { id: "issue" }, "dev:in-progress", "old-decl", 45, NOW, {
    fetchClaimCardFn: async () => ({ id: "issue", labelNames: ["dev:in-progress"], commentsComplete: true, comments: [old, resetOld, newer] }),
    addCommentFn: async () => { writes += 1; },
  }), null);
  await assert.rejects(watchModule.resetStaleClaimBoundary("key", { id: "issue" }, "dev:in-progress", "old-decl", 45, NOW, {
    fetchClaimCardFn: async () => ({ id: "issue", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], commentsComplete: true, comments: [old] }),
    addCommentFn: async () => { writes += 1; },
  }), /reset unverified/);
  const priorLegacyReset = { id: "c0", body: claimResetMarker({ claim: "dev:in-progress", target: "legacy", reason: "legacy" }), createdAt: minsAgo(300) };
  await assert.rejects(watchModule.resetStaleClaimBoundary("key", { id: "issue" }, "dev:in-progress", "legacy", 45, NOW, {
    fetchClaimCardFn: async () => ({ id: "issue", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], commentsComplete: true, comments: [priorLegacyReset] }),
    addCommentFn: async () => { writes += 1; },
  }), /reset unverified/);
  assert.equal(writes, 2);
});

test("administrative reset: a stranded label after an exact close is cleaned through a verified legacy boundary", async () => {
  const comments = [
    { id: "c1", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: minsAgo(300) },
    { id: "c2", body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl", reason: "released" }), createdAt: minsAgo(250) },
  ];
  const card = () => ({ id: "issue", updatedAt: minsAgo(240), labelNames: ["qa:in-progress"], commentsComplete: true, comments: [...comments] });
  const reset = await watchModule.resetStaleClaimBoundary("key", card(), "qa:in-progress", "legacy", 120, NOW, {
    fetchClaimCardFn: async () => card(),
    addCommentFn: async (_key, _id, body) => comments.push({ id: "c3", body, createdAt: minsAgo(1) }),
  });
  assert.ok(reset);
  assert.equal(resolveClaimOwnership({ comments: reset.comments, complete: true, claim: "qa:in-progress", labelPresent: true }).status, "legacy-unowned");
});

test("executeReap: synchronizes the scheduler card before a same-tick bounce full-label write", async () => {
  assert.equal(typeof watchModule.executeReap, "function");
  assert.equal(typeof watchModule.executeBounce, "function");
  const comments = [
    { id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: minsAgo(300) },
  ];
  const original = { id: "reap-bounce", identifier: "COD-171", updatedAt: minsAgo(300), labelIds: { "dev:in-progress": "dev-label", feature: "feature-label" }, labelNames: ["dev:in-progress", "feature"], commentsComplete: true, comments: [...comments] };
  const linearLabelWrites = [];
  const applyLabelEditFn = async (_key, card, edit) => {
    for (const claim of edit.remove || []) delete card.labelIds[claim];
    for (const [name, id] of Object.entries(edit.add || {})) card.labelIds[name] = id;
    card.labelNames = Object.keys(card.labelIds);
    linearLabelWrites.push(Object.values(card.labelIds).sort());
  };
  const fetched = () => ({ ...original, labelIds: { "dev:in-progress": "dev-label", feature: "feature-label" }, labelNames: ["dev:in-progress", "feature"], commentsComplete: true, comments: [...comments] });
  assert.equal(await watchModule.executeReap("key", original, {
    action: "reap", releaseClaim: "dev:in-progress", target: "decl", staleMin: 45,
  }, { "blocked:needs-user": "blocked-label" }, "dev", NOW, {
    fetchClaimCardFn: async () => fetched(),
    addCommentFn: async (_key, _id, body) => comments.push({ id: `reset-${comments.length}`, body, createdAt: minsAgo(1) }),
    applyLabelEditFn,
    addAuditCommentFn: async () => {},
  }), true);
  assert.deepEqual(original.labelIds, { feature: "feature-label" });
  assert.deepEqual(original.labelNames, ["feature"]);
  await watchModule.executeBounce("key", original, { "blocked:needs-user": "blocked-label" }, {
    applyLabelEditFn,
    addCommentFn: async () => {},
  });
  assert.deepEqual(linearLabelWrites, [
    ["feature-label"],
    ["blocked-label", "feature-label"],
  ]);
  assert.deepEqual(original.labelIds, { feature: "feature-label", "blocked:needs-user": "blocked-label" });
  assert.deepEqual(original.labelNames, ["feature", "blocked:needs-user"]);
});
test("executeReap: a delayed claimant after reset verification denies the whole label mutation", async () => {
  const claim = "dev:in-progress";
  const comments = [
    { id: "c1", body: claimDeclarationMarker({ claim, ownerToken: "old-owner", declarationId: "old-decl" }), createdAt: minsAgo(300) },
  ];
  const card = dependencyReadyCard({
    id: "issue", identifier: "COD-169", stateName: "Dev", updatedAt: minsAgo(300),
    labelIds: { [claim]: "claim-label" }, labelNames: [claim], commentsComplete: true, comments: [...comments],
  });
  let reads = 0;
  let edits = 0;
  let audits = 0;
  const snapshot = () => ({ ...card, labelIds: { [claim]: "claim-label" }, labelNames: [claim], commentsComplete: true, comments: [...comments] });
  const released = await watchModule.executeReap("key", card, {
    action: "reap", releaseClaim: claim, target: "old-decl", staleMin: 45,
  }, { [claim]: "claim-label" }, "dev", NOW, {
    fetchClaimCardFn: async () => {
      reads += 1;
      if (reads === 3) comments.push({ id: "contender", body: claimDeclarationMarker({ claim, ownerToken: "new-owner", declarationId: "new-decl" }), createdAt: minsAgo(0) });
      return snapshot();
    },
    addCommentFn: async (_key, _id, body) => comments.push({ id: "reset", body, createdAt: minsAgo(1) }),
    applyLabelEditFn: async () => { edits += 1; },
    addAuditCommentFn: async () => { audits += 1; },
  });
  assert.equal(released, false);
  assert.equal(reads, 3);
  assert.equal(edits, 0);
  assert.equal(audits, 0);
});
test("releaseOwnedDispatchClaim: successful completion only releases a claim while the card remains in the completed sweep", async () => {
  const edits = [];
  let claimed = true;
  const comments = [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-141", declarationId: "decl-141" }), createdAt: claimIso(1) }];
  const base = {
    id: "issue-141",
    identifier: "COD-141",
    labelNames: ["dev:in-progress"],
    commentsComplete: true, comments,
  };
  const pick = { sweep: "dev", issueId: "issue-141", issueIdentifier: "COD-141", ownerToken: "owner-141", claimDeclarationId: "decl-141" };

  assert.equal(await watchModule.releaseOwnedDispatchClaim("key", pick, "successful child stopped in Dev", {
    expectedStates: ["Dev"],
    fetchClaimCardFn: async () => ({ ...base, labelNames: claimed ? ["dev:in-progress"] : [], comments: [...comments], stateName: "Dev" }),
    applyLabelEditFn: async (_key, _card, edit) => { edits.push(edit); claimed = false; },
    addCommentFn: async (_key, _id, body) => comments.push({ id: "c2", body, createdAt: claimIso(2) }),
  }), true);
  assert.deepEqual(edits, [{ remove: ["dev:in-progress"] }]);

  assert.equal(await watchModule.releaseOwnedDispatchClaim("key", pick, "successful child advanced", {
    expectedStates: ["Dev"],
    fetchClaimCardFn: async () => ({ ...base, stateName: "QA" }),
    applyLabelEditFn: async () => { throw new Error("advanced claims must be left to the child/holding-state cleanup"); },
    addCommentFn: async () => {},
  }), false);
});
test("releaseOwnedDispatchClaim: same-state release rechecks state with the ownership proof", async () => {
  const comments = [{ id: "c1", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: claimIso(1) }];
  let reads = 0;
  const pick = { sweep: "dev", issueId: "issue", issueIdentifier: "COD-169", ownerToken: "owner", claimDeclarationId: "decl" };
  assert.equal(await watchModule.releaseOwnedDispatchClaim("key", pick, "successful child", {
    expectedStates: ["Dev"],
    fetchClaimCardFn: async () => { reads += 1; return { id: "issue", stateName: "Dev", labelNames: reads === 4 ? [] : ["dev:in-progress"], commentsComplete: true, comments: [...comments] }; },
    addCommentFn: async (_key, _id, body) => comments.push({ id: "c2", body, createdAt: claimIso(2) }),
    addAuditCommentFn: async () => {},
    applyLabelEditFn: async () => {},
  }), true);
  assert.equal(reads, 4);
});

test("releaseFailedDispatchClaim writes retry and close markers before removing and verifies the full label set", async () => {
  const calls = [];
  const pick = { sweep: "dev", issueId: "issue-148", issueIdentifier: "COD-148", ownerToken: "owner-148", claimDeclarationId: "decl-148" };
  const comments = [{ id: "decl", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-148", declarationId: "decl-148" }), createdAt: minsAgo(3) }];
  let labels = ["dev:in-progress", "security"];
  const snapshot = () => ({
    id: "issue-148", identifier: "COD-148", stateName: "Dev",
    labelNames: [...labels], commentsComplete: true, comments: [...comments],
  });
  const released = await watchModule.releaseFailedDispatchClaim("key", pick, { kind: "exit", exitCode: 1 }, "codex / gpt", {
    fetchClaimCardFn: async () => { calls.push("fetch"); return snapshot(); },
    addCommentFn: async (_key, _id, body) => { calls.push(body); comments.push({ id: `c${comments.length}`, body, createdAt: minsAgo(2 - comments.length) }); },
    applyLabelEditFn: async (_key, _card, edit) => { calls.push(edit); labels = ["security"]; },
  });
  assert.equal(released, true);
  assert.equal(calls[0], "fetch");
  assert.match(calls[1], /^\[auto-sweep-retry v1 claim=dev:in-progress owner=owner-148 declaration=decl-148\] \[auto-sweep-orphan\]/);
  assert.equal(calls[2], "fetch");
  assert.match(calls[3], /^\[auto-sweep-claim-close v1 claim=dev:in-progress declaration=decl-148 reason=terminal\]$/);
  assert.deepEqual(calls.at(-2), { remove: ["dev:in-progress"] });
  assert.equal(calls.at(-1), "fetch");
});
test("releaseFailedDispatchClaim leaves the claim when the marker cannot be written", async () => {
  let edits = 0;
  const fresh = {
    id: "issue-148", identifier: "COD-148", labelNames: ["dev:in-progress"], commentsComplete: true,
    comments: [{ id: "decl", body: claimDeclarationMarker({ claim: "dev:in-progress", ownerToken: "owner-148", declarationId: "decl-148" }), createdAt: minsAgo(1) }],
  };
  await assert.rejects(watchModule.releaseFailedDispatchClaim("key", {
    sweep: "dev", issueId: "issue-148", issueIdentifier: "COD-148", ownerToken: "owner-148", claimDeclarationId: "decl-148",
  }, { kind: "signal", signal: "SIGTERM" }, "codex", {
    fetchClaimCardFn: async () => fresh,
    addCommentFn: async () => { throw new Error("comment unavailable"); },
    applyLabelEditFn: async () => { edits += 1; },
  }), /comment unavailable/);
  assert.equal(edits, 0);
});
test("reconcileOwnedDispatchClaim: successful child completion invokes state-scoped owned-claim cleanup", async () => {
  assert.equal(typeof watchModule.reconcileOwnedDispatchClaim, "function");
  const calls = [];
  const result = await watchModule.reconcileOwnedDispatchClaim("key", {
    kind: "success",
    pick: { sweep: "dev", issueId: "issue-141", issueIdentifier: "COD-141", ownerToken: "owner-141" },
  }, "codex / gpt-5.6", {
    releaseOwnedDispatchClaimFn: async (...args) => { calls.push(args); return true; },
  });

  assert.deepEqual(result, { attempted: true, released: true, reasonKind: "successful same-state completion" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "key");
  assert.deepEqual(calls[0][1], { sweep: "dev", issueId: "issue-141", issueIdentifier: "COD-141", ownerToken: "owner-141" });
  assert.match(calls[0][2], /successful child via codex \/ gpt-5\.6 exited/);
  assert.deepEqual(calls[0][3], { expectedStates: ["Dev"] });

  const failureCalls = [];
  assert.deepEqual(await watchModule.reconcileOwnedDispatchClaim("key", {
    kind: "exit",
    pick: { sweep: "dev", issueId: "issue-141", issueIdentifier: "COD-141", ownerToken: "owner-141" },
  }, "codex", {
    releaseFailedDispatchClaimFn: async (...args) => { failureCalls.push(args); return true; },
  }), { attempted: true, released: true, reasonKind: "terminal failure cooldown" });
  assert.equal(failureCalls.length, 1);
});

test("reconcileOwnedDispatchClaim preserves exact claims retained for provider or capacity recovery", async () => {
  let releases = 0;
  const result = await watchModule.reconcileOwnedDispatchClaim("key", {
    kind: "exit",
    pick: { sweep: "dev", issueId: "issue-144", issueIdentifier: "COD-144", ownerToken: "owner-144", claimDeclarationId: "decl-144" },
  }, "codex", {
    preserveTerminalClaim: true,
    releaseFailedDispatchClaimFn: async () => { releases += 1; return true; },
  });
  assert.deepEqual(result, { attempted: true, released: false, reasonKind: "terminal recovery retained" });
  assert.equal(releases, 0);
});
test("expandDispatchBatch: shared child-index allocator prevents refill/handoff path collisions", async () => {
  const childIndexAllocator = createChildIndexAllocator();
  const base = {
    anchorPath: "/ws/repo",
    config: { repos: ["repo"], parallel: { sameRepoCardLimits: { dev: 1, qa: 1 } } },
    count: 1,
  };
  const first = await expandDispatchBatch([{
    ...base,
    sweep: "dev",
    cards: [dependencyReadyCard({ id: "a", identifier: "COD-10", sortOrder: 2, updatedAt: minsAgo(1), labelNames: [], comments: [] })],
  }], { dryRun: true, parentRunId: "run-id", activeByAnchor: new Map(), now: NOW, childIndexAllocator });
  const second = await expandDispatchBatch([{
    ...base,
    sweep: "qa",
    cards: [dependencyReadyCard({ id: "b", identifier: "COD-11", sortOrder: 1, updatedAt: minsAgo(1), labelNames: [], comments: [] })],
  }], { dryRun: true, parentRunId: "run-id", activeByAnchor: new Map(), now: NOW, childIndexAllocator });

  assert.equal(first[0].childEnv.AUTO_SWEEP_APP_PORT, "47000");
  assert.equal(second[0].childEnv.AUTO_SWEEP_APP_PORT, "47010");
  assert.notEqual(first[0].logDir, second[0].logDir);
  assert.notEqual(first[0].tmpDir, second[0].tmpDir);
  assert.notEqual(first[0].cardRunId, second[0].cardRunId);
});
test("expandDispatchBatch: same-card handoff children get unique run paths", async () => {
  const childIndexAllocator = createChildIndexAllocator();
  const base = {
    anchorPath: "/ws/repo",
    config: { repos: ["repo"], parallel: { sameRepoCardLimits: { dev: 1, qa: 1 } } },
    count: 1,
  };
  const dev = await expandDispatchBatch([{
    ...base,
    sweep: "dev",
    cards: [dependencyReadyCard({ id: "a", identifier: "COD-10", sortOrder: 2, updatedAt: minsAgo(1), labelNames: [], comments: [] })],
  }], { dryRun: true, parentRunId: "run-id", activeByAnchor: new Map(), now: NOW, childIndexAllocator });
  const qa = await expandDispatchBatch([{
    ...base,
    sweep: "qa",
    cards: [dependencyReadyCard({ id: "a", identifier: "COD-10", sortOrder: 2, updatedAt: minsAgo(1), labelNames: [], comments: [] })],
  }], { dryRun: true, parentRunId: "run-id", activeByAnchor: new Map(), now: NOW, childIndexAllocator });

  assert.notEqual(dev[0].cardRunId, qa[0].cardRunId);
  assert.notEqual(dev[0].tmpDir, qa[0].tmpDir);
  assert.notEqual(dev[0].browserProfileDir, qa[0].browserProfileDir);
  assert.notEqual(dev[0].childEnv.AUTO_SWEEP_APP_PORT, qa[0].childEnv.AUTO_SWEEP_APP_PORT);
});
test("expandDispatchBatch: child dispatches preserve managed repo metadata for later dirty checks", async () => {
  const children = await expandDispatchBatch([{
    anchorPath: "/managed/app/app",
    sourceAnchorPath: "/source/app",
    managedRepoPaths: ["/managed/app/app", "/managed/app/worker"],
    config: { repos: ["app", "worker"] },
    sweep: "dev",
    count: 1,
    cards: [dependencyReadyCard({ id: "a", identifier: "COD-10", sortOrder: 2, updatedAt: minsAgo(1), labelNames: [], comments: [] })],
  }], { dryRun: true, parentRunId: "run-id", activeByAnchor: new Map(), now: NOW });

  assert.deepEqual(children[0].managedRepoPaths, ["/managed/app/app", "/managed/app/worker"]);
  assert.equal(children[0].sourceAnchorPath, "/source/app");
});
test("same-repo active counts: successful child completion frees exactly one slot", () => {
  const active = createSameRepoActiveCounts();
  const pick = (issueIdentifier) => ({ anchorPath: "/ws/repo", sweep: "dev", issueIdentifier });
  active.increment(pick("COD-1"));
  active.increment(pick("COD-2"));
  active.increment({ anchorPath: "/ws/repo", sweep: "ship", issueIdentifier: "COD-3" });
  assert.equal(active.get("/ws/repo", "dev"), 2);
  assert.equal(active.available("/ws/repo", "dev", 4), 2);
  active.decrement(pick("COD-1"));
  assert.equal(active.get("/ws/repo", "dev"), 1);
  assert.equal(active.available("/ws/repo", "dev", 4), 3);
});
test("same-repo active counts isolate sibling primary repositories in one workspace", () => {
  const active = createSameRepoActiveCounts();
  active.increment({
    anchorPath: "/managed/coach",
    repoRoute: { managedRepoPath: "/managed/guide" },
    sweep: "dev",
    issueIdentifier: "SAF-1",
  });
  assert.equal(active.get("/managed/guide", "dev"), 1);
  assert.equal(active.get("/managed/coach", "dev"), 0);
});
test("same-repo active counts atomically reserve routed follow-up slots", () => {
  const active = createSameRepoActiveCounts();
  const pick = (identifier) => ({ anchorPath: "/managed/coach", repoRoute: { managedRepoPath: "/managed/guide" }, sweep: "qa", issueIdentifier: identifier });
  assert.equal(active.tryAcquire(pick("SAF-1"), 1), true);
  assert.equal(active.tryAcquire(pick("SAF-2"), 1), false);
  active.decrement(pick("SAF-1"));
  assert.equal(active.tryAcquire(pick("SAF-2"), 1), true);
});
test("sameRepoAvailableSlots: live board claims and parent reservations share the same capacity", () => {
  const active = createSameRepoActiveCounts();
  active.increment({ anchorPath: "/ws/repo", sweep: "qa", issueIdentifier: "COD-1" });
  const live = dependencyReadyCard({
    id: "qa-live",
    identifier: "COD-2",
    updatedAt: minsAgo(1),
    labelNames: ["qa:in-progress"],
    comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=other claim=qa:in-progress]`, createdAt: minsAgo(1) }],
  });
  assert.equal(sameRepoAvailableSlots({
    cards: [live],
    cfg: SWEEP_CFG.qa,
    anchorPath: "/ws/repo",
    sweep: "qa",
    activeSameRepo: active,
    limit: 1,
    now: NOW,
  }), 0);
});
test("buildSameRepoRefillDispatches: successful dev completion claims the next top Dev card", async () => {
  const activeSameRepo = createSameRepoActiveCounts();
  for (const id of ["COD-1", "COD-2", "COD-3"]) {
    activeSameRepo.increment({ anchorPath: "/ws/repo", sweep: "dev", issueIdentifier: id });
  }
  const cards = [
    { id: "blocked", identifier: "COD-99", sortOrder: 99, updatedAt: minsAgo(1), labelNames: ["blocked:needs-user"], comments: [] },
    { id: "next", identifier: "COD-5", sortOrder: 10, updatedAt: minsAgo(1), labelNames: [], comments: [] },
    { id: "later", identifier: "COD-6", sortOrder: 1, updatedAt: minsAgo(1), labelNames: [], comments: [] },
  ].map(dependencyReadyCard);
  const logs = [];
  const refillBudget = { remaining: 8 };
  const result = await buildSameRepoRefillDispatches({
    result: {
      success: true,
      issueIdentifier: "COD-4",
      pick: {
        anchorPath: "/ws/repo",
        sweep: "dev",
        issueIdentifier: "COD-4",
        config: { teamKey: "COD", projectId: "project-1", repos: ["repo"], parallel: { sameRepoCardLimits: { dev: 4 } } },
      },
    },
    activeByAnchor: new Map([["/ws/repo", { apiKey: "lin", config: { projectId: "project-1" } }]]),
    activeSameRepo,
    refillBudget,
    parentRunId: "run-id",
    childIndexAllocator: createChildIndexAllocator(4),
    now: NOW,
    deps: {
      labeledProjectIds: async () => new Set(["project-1"]),
      fetchCards: async () => cards,
      teamLabelMap: async () => ({ "dev:in-progress": "label-dev" }),
      claimCardSlots: async (_apiKey, _anchorPath, _config, sweep, candidateCards, { limit }) =>
        selectCardSlots(candidateCards, SWEEP_CFG[sweep], sweep, limit, NOW).map((slot) => ({ ...slot, ownerToken: `owner-${slot.identifier}`, claimDeclarationId: `decl-${slot.identifier}` })),
      checkoutDispatchBlockers: () => [],
      logFor: (_anchorPath, _sweep, line) => logs.push(line),
    },
  });

  assert.deepEqual(result.dispatches.map((d) => d.issueIdentifier), ["COD-5"]);
  assert.equal(result.dispatches[0].triggeredBy.kind, "same-repo-refill");
  assert.equal(result.dispatches[0].triggeredBy.issue, "COD-4");
  assert.equal(result.dispatches[0].childEnv.AUTO_SWEEP_APP_PORT, "47040");
  assert.equal(result.dispatches[0].childEnv.AUTO_SWEEP_OWNER_TOKEN, "owner-COD-5");
  assert.equal(result.dispatches[0].childEnv.AUTO_SWEEP_CLAIM_DECLARATION, "decl-COD-5");
  assert.equal(refillBudget.remaining, 7);
  assert.match(logs.find((line) => line.includes("refill-trigger")), /COD-4: dev 1\/4/);
});
test("buildSameRepoRefillDispatches: refill stays on the completed card's primary repo", async () => {
  const config = {
    teamKey: "SAF",
    projectId: "project-1",
    repos: ["coach", "guide"],
    repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } },
    parallel: { sameRepoCardLimits: { dev: 1 } },
  };
  const repoPairs = [
    { repoEntry: "coach", sourceRepoPath: "/source/coach", managedRepoPath: "/managed/coach" },
    { repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
  ];
  const guideRoute = resolveCardRepoRoute({ config, card: { identifier: "SAF-1", labelNames: ["app:guide"] }, repoPairs });
  const result = await buildSameRepoRefillDispatches({
    result: {
      success: true,
      issueIdentifier: "SAF-1",
      pick: { anchorPath: "/managed/coach", sweep: "dev", issueIdentifier: "SAF-1", config, repoPairs, repoRoute: guideRoute },
    },
    activeByAnchor: new Map([["/managed/coach", { apiKey: "key", repoPairs }]]),
    activeSameRepo: createSameRepoActiveCounts(),
    refillBudget: { remaining: 2 },
    parentRunId: "run-id",
    childIndexAllocator: createChildIndexAllocator(),
    deferClaim: true,
    now: NOW,
    deps: {
      labeledProjectIds: async () => new Set(["project-1"]),
      checkoutDispatchBlockers: () => [],
      fetchCards: async () => [
        dependencyReadyCard({ id: "coach", identifier: "SAF-2", sortOrder: 99, updatedAt: minsAgo(1), labelNames: ["app:coach"], comments: [] }),
        dependencyReadyCard({ id: "guide", identifier: "SAF-3", sortOrder: 1, updatedAt: minsAgo(1), labelNames: ["app:guide"], comments: [] }),
      ],
      logFor: () => {},
    },
  });
  assert.deepEqual(result.dispatches.map((dispatch) => dispatch.issueIdentifier), ["SAF-3"]);
  assert.equal(result.dispatches[0].repoRoute.managedRepoPath, "/managed/guide");
});
test("buildSameRepoRefillDispatches: budget, capacity, and failed child suppress refill", async () => {
  const base = {
    result: {
      success: true,
      issueIdentifier: "COD-4",
      pick: {
        anchorPath: "/ws/repo",
        sweep: "dev",
        issueIdentifier: "COD-4",
        config: { teamKey: "COD", projectId: "project-1", repos: ["repo"], parallel: { sameRepoCardLimits: { dev: 1 } } },
      },
    },
    activeByAnchor: new Map([["/ws/repo", { apiKey: "lin" }]]),
    activeSameRepo: createSameRepoActiveCounts(),
    refillBudget: { remaining: 0 },
    parentRunId: "run-id",
    childIndexAllocator: createChildIndexAllocator(),
    now: NOW,
    deps: { logFor: () => {} },
  };
  assert.equal((await buildSameRepoRefillDispatches(base)).reason, "budget");
  const disabledLogs = [];
  assert.equal((await buildSameRepoRefillDispatches({
    ...base,
    refillBudget: { remaining: 0, disabled: true },
    deps: { logFor: (_anchorPath, _sweep, line) => disabledLogs.push(line) },
  })).reason, "disabled");
  assert.match(disabledLogs[0], /refill-skip dev: disabled/);
  assert.equal((await buildSameRepoRefillDispatches({
    ...base,
    refillBudget: { remaining: 1 },
    result: { ...base.result, success: false },
  })).reason, "ineligible");
  const full = createSameRepoActiveCounts();
  full.increment({ anchorPath: "/ws/repo", sweep: "dev", issueIdentifier: "COD-1" });
  assert.equal((await buildSameRepoRefillDispatches({
    ...base,
    activeSameRepo: full,
    refillBudget: { remaining: 1 },
    deps: {
      ...base.deps,
      labeledProjectIds: async () => new Set(["project-1"]),
      fetchCards: async () => [],
      checkoutDispatchBlockers: () => [],
    },
  })).reason, "no-capacity");
});
test("buildSameRepoRefillDispatches: completed Ship immediately offers the next eligible card in its workspace", async () => {
  const refillBudget = { remaining: 3 };
  const repoPairs = [
    { repoEntry: "coach", sourceRepoPath: "/source/coach", managedRepoPath: "/managed/coach" },
    { repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
  ];
  const config = {
    teamKey: "SAF",
    projectId: "project-safe",
    repos: ["coach", "guide"],
    repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } },
  };
  const result = await buildSameRepoRefillDispatches({
    result: {
      success: true,
      issueIdentifier: "SAF-200",
      pick: {
        anchorPath: "/managed/safe",
        sourceAnchorPath: "/source/safe",
        sweep: "ship",
        issueId: "issue-200",
        issueIdentifier: "SAF-200",
        config,
        repoPairs,
        repoRoute: repoPairs[0],
      },
    },
    activeByAnchor: new Map([["/managed/safe", { apiKey: "lin", repoPairs }]]),
    activeSameRepo: createSameRepoActiveCounts(),
    refillBudget,
    parentRunId: "run-id",
    childIndexAllocator: createChildIndexAllocator(),
    deferClaim: true,
    now: NOW,
    deps: {
      labeledProjectIds: async () => new Set(["project-safe"]),
      checkoutDispatchBlockers: () => [],
      fetchCards: async () => [
        dependencyReadyCard({ id: "issue-200", identifier: "SAF-200", sortOrder: 100, updatedAt: minsAgo(1), labelNames: ["app:coach", "blocked:needs-user"], comments: [] }),
        dependencyReadyCard({ id: "issue-207", identifier: "SAF-207", sortOrder: 50, updatedAt: minsAgo(1), labelNames: ["app:guide"], comments: [] }),
      ],
      logFor: () => {},
    },
  });

  assert.equal(result.reason, "triggered");
  assert.deepEqual(result.dispatches.map((dispatch) => dispatch.issueIdentifier), ["SAF-207"]);
  assert.equal(result.dispatches[0].workspace, "/source/safe");
  assert.equal(result.dispatches[0].stage, "ship");
  assert.equal(result.dispatches[0].trigger, "refill");
  assert.equal(result.dispatches[0].repoRoute.managedRepoPath, "/managed/guide");
  assert.equal(refillBudget.remaining, 2);
});
test("buildSameRepoRefillDispatches: Ship refill claims then atomically exports both identities", async () => {
  const refillBudget = { remaining: 1 };
  const card = dependencyReadyCard({ id: "issue-207", identifier: "SAF-207", stateName: "Ship", sortOrder: 50, updatedAt: minsAgo(1), labelNames: [] });
  let claimCalls = 0;
  const result = await buildSameRepoRefillDispatches({
    result: {
      success: true,
      issueIdentifier: "SAF-200",
      pick: {
        anchorPath: "/managed/safe",
        sourceAnchorPath: "/source/safe",
        sweep: "ship",
        issueIdentifier: "SAF-200",
        config: { teamKey: "SAF", projectId: "project-safe", repos: ["repo"] },
      },
    },
    activeByAnchor: new Map([["/managed/safe", { apiKey: "lin", repoPairs: [] }]]),
    activeSameRepo: createSameRepoActiveCounts(),
    refillBudget,
    parentRunId: "run-id",
    childIndexAllocator: createChildIndexAllocator(),
    now: NOW,
    deps: {
      labeledProjectIds: async () => new Set(["project-safe"]),
      checkoutDispatchBlockers: () => [],
      fetchCards: async () => [card],
      teamLabelMap: async () => ({ "ship:in-progress": "ship-label" }),
      claimCardSlots: async (_key, _anchor, _config, sweep, cards) => {
        claimCalls += 1;
        assert.equal(sweep, "ship");
        return [{ ...cards[0], card: cards[0], sweep, slotIndex: 0, ownerToken: "ship-owner", claimDeclarationId: "ship-decl" }];
      },
      logFor: () => {},
    },
  });
  assert.equal(claimCalls, 1);
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.dispatches[0].childEnv.AUTO_SWEEP_OWNER_TOKEN, "ship-owner");
  assert.equal(result.dispatches[0].childEnv.AUTO_SWEEP_CLAIM_DECLARATION, "ship-decl");
});
test("buildSameRepoRefillDispatches: live board claims count against refill capacity", async () => {
  const activeSameRepo = createSameRepoActiveCounts();
  for (const id of ["COD-1", "COD-2", "COD-3"]) {
    activeSameRepo.increment({ anchorPath: "/ws/repo", sweep: "dev", issueIdentifier: id });
  }
  const liveClaimed = (id) => ({
    id,
    identifier: id,
    sortOrder: 20,
    updatedAt: minsAgo(1),
    labelNames: ["dev:in-progress"],
    comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=other claim=dev:in-progress]`, createdAt: minsAgo(1) }],
  });
  const claimCalls = [];
  const result = await buildSameRepoRefillDispatches({
    result: {
      success: true,
      issueIdentifier: "COD-4",
      pick: {
        anchorPath: "/ws/repo",
        sweep: "dev",
        issueIdentifier: "COD-4",
        config: { teamKey: "COD", projectId: "project-1", repos: ["repo"], parallel: { sameRepoCardLimits: { dev: 4 } } },
      },
    },
    activeByAnchor: new Map([["/ws/repo", { apiKey: "lin" }]]),
    activeSameRepo,
    refillBudget: { remaining: 8 },
    parentRunId: "run-id",
    childIndexAllocator: createChildIndexAllocator(),
    now: NOW,
    deps: {
      labeledProjectIds: async () => new Set(["project-1"]),
      fetchCards: async () => [
        liveClaimed("COD-1"),
        liveClaimed("COD-2"),
        liveClaimed("COD-3"),
        liveClaimed("COD-9"),
        { id: "next", identifier: "COD-5", sortOrder: 10, updatedAt: minsAgo(1), labelNames: [], comments: [] },
      ],
      teamLabelMap: async () => ({ "dev:in-progress": "label-dev" }),
      claimCardSlots: async () => { claimCalls.push("claim"); return []; },
      checkoutDispatchBlockers: () => [],
      logFor: () => {},
    },
  });
  assert.equal(result.reason, "no-capacity");
  assert.deepEqual(claimCalls, []);
});
test("capacity refill admission: deferred mode returns unclaimed demands", async () => {
  const claimCalls = [];
  const result = await buildSameRepoRefillDispatches({
    result: {
      success: true,
      issueIdentifier: "COD-4",
      pick: {
        anchorPath: "/ws/repo",
        sweep: "dev",
        issueIdentifier: "COD-4",
        config: { teamKey: "COD", projectId: "project-1", repos: ["repo"], parallel: { sameRepoCardLimits: { dev: 2 } } },
      },
    },
    activeByAnchor: new Map([["/ws/repo", { apiKey: "lin" }]]),
    activeSameRepo: createSameRepoActiveCounts(),
    refillBudget: { remaining: 2 },
    parentRunId: "run-id",
    childIndexAllocator: createChildIndexAllocator(),
    now: NOW,
    deferClaim: true,
    deps: {
      labeledProjectIds: async () => new Set(["project-1"]),
      fetchCards: async () => [
        dependencyReadyCard({ id: "next-1", identifier: "COD-5", sortOrder: 20, updatedAt: minsAgo(1), labelNames: [], comments: [] }),
        dependencyReadyCard({ id: "next-2", identifier: "COD-6", sortOrder: 10, updatedAt: minsAgo(1), labelNames: [], comments: [] }),
      ],
      claimCardSlots: async () => { claimCalls.push("claim"); return []; },
      checkoutDispatchBlockers: () => [],
      logFor: () => {},
    },
  });

  assert.deepEqual(claimCalls, []);
  assert.deepEqual(result.dispatches.map((d) => [d.issueIdentifier, d.trigger]), [["COD-5", "refill"], ["COD-6", "refill"]]);
  assert.ok(result.dispatches.every((d) => d.cards.length === 1 && d.slotLimit === 1));
});
test("capacity initial admission: candidate expansion produces stable unclaimed demand records", () => {
  const demands = admissionDemandsForCandidates([{
    anchorPath: "/managed/repo",
    sourceAnchorPath: "/source/repo",
    sweep: "qa",
    config: { parallel: { sameRepoCardLimits: { qa: 2 } } },
    cards: [
      dependencyReadyCard({ id: "one", identifier: "COD-1", sortOrder: 20, labelNames: [], comments: [] }),
      dependencyReadyCard({ id: "two", identifier: "COD-2", sortOrder: 10, labelNames: [], comments: [] }),
    ],
  }], { trigger: "initial", now: NOW, rotationRanks: new Map([["/managed/repo", 3]]) });

  assert.deepEqual(demands.map((d) => ({ stage: d.stage, trigger: d.trigger, id: d.issueIdentifier, board: d.boardOrder, rotation: d.rotationRank })), [
    { stage: "qa", trigger: "initial", id: "COD-1", board: 20, rotation: 3 },
    { stage: "qa", trigger: "initial", id: "COD-2", board: 10, rotation: 3 },
  ]);
  assert.ok(demands.every((demand) => demand.workspace === "/source/repo" && demand.managedWorkspace === "/managed/repo"));
});
test("capacity initial admission applies same-repo limits independently to routed siblings", () => {
  const config = {
    repos: ["coach", "guide"],
    repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } },
    parallel: { sameRepoCardLimits: { qa: 1 } },
  };
  const route = (repoEntry) => ({ ok: true, label: `app:${repoEntry}`, repoEntry, sourceRepoPath: `/source/${repoEntry}`, managedRepoPath: `/managed/${repoEntry}` });
  const cards = [
    dependencyReadyCard({ id: "coach-1", identifier: "SAF-1", sortOrder: 30, updatedAt: minsAgo(1), labelNames: ["app:coach"], comments: [], repoRoute: route("coach") }),
    dependencyReadyCard({ id: "coach-2", identifier: "SAF-2", sortOrder: 20, updatedAt: minsAgo(1), labelNames: ["app:coach"], comments: [], repoRoute: route("coach") }),
    dependencyReadyCard({ id: "guide-1", identifier: "SAF-3", sortOrder: 10, updatedAt: minsAgo(1), labelNames: ["app:guide"], comments: [], repoRoute: route("guide") }),
  ];
  const demands = admissionDemandsForCandidates([{
    anchorPath: "/managed/coach",
    config,
    sweep: "qa",
    count: cards.length,
    topCard: cards[0],
    cards,
  }], { now: NOW });
  assert.deepEqual(demands.map((demand) => demand.issueIdentifier), ["SAF-1", "SAF-3"]);
});
test("buildSameRepoRefillDispatches: dirty checks include managed sibling paths from the completed child", async () => {
  const seen = [];
  const result = await buildSameRepoRefillDispatches({
    result: {
      success: true,
      issueIdentifier: "COD-4",
      pick: {
        anchorPath: "/managed/app/app",
        managedRepoPaths: ["/managed/app/app", "/managed/app/worker"],
        sweep: "dev",
        issueIdentifier: "COD-4",
        config: { teamKey: "COD", projectId: "project-1", repos: ["app", "worker"], parallel: { sameRepoCardLimits: { dev: 4 } } },
      },
    },
    activeByAnchor: new Map([["/managed/app/app", { apiKey: "lin" }]]),
    activeSameRepo: createSameRepoActiveCounts(),
    refillBudget: { remaining: 1 },
    parentRunId: "run-id",
    childIndexAllocator: createChildIndexAllocator(),
    now: NOW,
    deps: {
      labeledProjectIds: async () => new Set(["project-1"]),
      checkoutDispatchBlockers: (pick) => {
        seen.push(pick.managedRepoPaths);
        return [{ kind: "dirty-checkout" }];
      },
      logFor: () => {},
    },
  });

  assert.equal(result.reason, "dirty-checkout");
  assert.deepEqual(seen[0], ["/managed/app/app", "/managed/app/worker"]);
});
test("selectDispatchBatch: defaults to bounded parallel non-ship dispatches", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/ws/a", config: { repos: ["a"] }, sweep: "dev", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/b", config: { repos: ["b"] }, sweep: "spec", count: 1, oldestUpdatedAt: 1 },
  ]);
  assert.deepEqual(batch.map((c) => c.anchorPath), ["/ws/a", "/ws/b"]);
});
test("selectDispatchBatch: dispatches disjoint anchors up to the configured non-ship limit", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/ws/a", config: { repos: ["a"] }, sweep: "dev", count: 1, oldestUpdatedAt: 2 },
    { anchorPath: "/ws/b", config: { repos: ["b"] }, sweep: "spec", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/c", config: { repos: ["c"] }, sweep: "spec", count: 1, oldestUpdatedAt: 3 },
  ], { maxNonShipDispatches: 2 });
  assert.deepEqual(batch.map((c) => c.anchorPath), ["/ws/a", "/ws/b"]);
});
test("selectDispatchBatch: rotates non-ship anchors so later workspaces are not always leftovers", () => {
  const candidates = [
    { anchorPath: "/ws/a", config: { repos: ["a"] }, sweep: "dev", count: 1, topCard: { sortOrder: 10 } },
    { anchorPath: "/ws/b", config: { repos: ["b"] }, sweep: "dev", count: 1, topCard: { sortOrder: 10 } },
    { anchorPath: "/ws/c", config: { repos: ["c"] }, sweep: "dev", count: 1, topCard: { sortOrder: 10 } },
  ];
  const first = selectDispatchBatch(candidates, { maxNonShipDispatches: 2, rotationSeed: 0 });
  const rotated = selectDispatchBatch(candidates, { maxNonShipDispatches: 2, rotationSeed: 2 });
  assert.deepEqual(first.map((c) => c.anchorPath), ["/ws/a", "/ws/b"]);
  assert.deepEqual(rotated.map((c) => c.anchorPath), ["/ws/c", "/ws/a"]);
});
test("selectDispatchBatch: stage priority outranks workspace rotation", () => {
  const selected = selectDispatchBatch([
    { anchorPath: "/ws/spec", config: { repos: ["spec"] }, sweep: "spec", count: 1, topCard: { identifier: "COD-1", sortOrder: 100 } },
    { anchorPath: "/ws/qa", config: { repos: ["qa"] }, sweep: "qa", count: 1, topCard: { identifier: "COD-2", sortOrder: 1 } },
  ], { maxNonShipDispatches: 1, rotationSeed: 1 });
  assert.deepEqual(selected.map((candidate) => candidate.sweep), ["qa"]);
});
test("rotateNonShipCandidates: preserves each anchor's internal sweep/card priority", () => {
  const rotated = rotateNonShipCandidates([
    { anchorPath: "/ws/a", sweep: "dev", topCard: { sortOrder: 10 } },
    { anchorPath: "/ws/a", sweep: "spec", topCard: { sortOrder: 100 } },
    { anchorPath: "/ws/b", sweep: "dev", topCard: { sortOrder: 20 } },
  ], 1);
  assert.deepEqual(rotated.map((c) => `${c.anchorPath}:${c.sweep}`), ["/ws/b:dev", "/ws/a:dev", "/ws/a:spec"]);
});
test("selectDispatchBatch: a serial candidate runs alone or waits for another tick", () => {
  const serialFirst = selectDispatchBatch([
    { anchorPath: "/ws/serial", config: { repos: ["serial"], parallel: { maxNonShipDispatches: 1 } }, sweep: "dev", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/default", config: { repos: ["default"] }, sweep: "spec", count: 1, oldestUpdatedAt: 2 },
  ], { maxNonShipDispatches: 2 });
  assert.deepEqual(serialFirst.map((c) => c.anchorPath), ["/ws/serial"]);

  const serialSecond = selectDispatchBatch([
    { anchorPath: "/ws/default-a", config: { repos: ["default-a"] }, sweep: "dev", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/serial", config: { repos: ["serial"], parallel: { maxNonShipDispatches: 1 } }, sweep: "spec", count: 1, oldestUpdatedAt: 2 },
    { anchorPath: "/ws/default-b", config: { repos: ["default-b"] }, sweep: "spec", count: 1, oldestUpdatedAt: 3 },
  ], { maxNonShipDispatches: 2 });
  assert.deepEqual(serialSecond.map((c) => c.anchorPath), ["/ws/default-a", "/ws/default-b"]);
});
test("selectDispatchBatch: dispatches distinct stages from the same anchor", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/ws/a", config: { repos: ["a"], parallel: { maxNonShipDispatches: 4 } }, sweep: "spec", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/a", config: { repos: ["a"], parallel: { maxNonShipDispatches: 4 } }, sweep: "qa", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/a", config: { repos: ["a"], parallel: { maxNonShipDispatches: 4 } }, sweep: "dev", count: 1, oldestUpdatedAt: 1 },
  ], { maxNonShipDispatches: 3 });
  assert.deepEqual(batch.map((c) => `${c.anchorPath}:${c.sweep}`), [
    "/ws/a:qa",
    "/ws/a:dev",
    "/ws/a:spec",
  ]);
});
test("selectDispatchBatch: caps distinct stages from the same anchor", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/ws/a", config: { repos: ["a"], parallel: { maxNonShipDispatches: 4 } }, sweep: "spec", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/a", config: { repos: ["a"], parallel: { maxNonShipDispatches: 4 } }, sweep: "qa", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/a", config: { repos: ["a"], parallel: { maxNonShipDispatches: 4 } }, sweep: "dev", count: 1, oldestUpdatedAt: 1 },
  ], { maxNonShipDispatches: 2 });
  assert.deepEqual(batch.map((c) => c.sweep), ["qa", "dev"]);
});
test("selectDispatchBatch: overlapping resolved repos remain exclusive across anchors", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/ws/a", managedRepoPaths: ["/managed/shared"], config: { repos: ["a"], parallel: { maxNonShipDispatches: 4 } }, sweep: "qa", count: 1 },
    { anchorPath: "/ws/a", managedRepoPaths: ["/managed/shared"], config: { repos: ["a"], parallel: { maxNonShipDispatches: 4 } }, sweep: "dev", count: 1 },
    { anchorPath: "/ws/b", managedRepoPaths: ["/managed/shared"], config: { repos: ["b"], parallel: { maxNonShipDispatches: 4 } }, sweep: "spec", count: 1 },
    { anchorPath: "/ws/c", managedRepoPaths: ["/managed/other"], config: { repos: ["c"], parallel: { maxNonShipDispatches: 4 } }, sweep: "spec", count: 1 },
  ], { maxNonShipDispatches: 4 });
  assert.deepEqual(batch.map((c) => `${c.anchorPath}:${c.sweep}`), [
    "/ws/a:qa",
    "/ws/a:dev",
    "/ws/c:spec",
  ]);
});
test("selectDispatchBatch: registered source anchors remain exclusive when managed anchors collide", () => {
  const batch = selectDispatchBatch([
    { sourceAnchorPath: "/registered/a", anchorPath: "/managed/shared", managedRepoPaths: ["/managed/shared"], config: { parallel: { maxNonShipDispatches: 4 } }, sweep: "qa", count: 1 },
    { sourceAnchorPath: "/registered/b", anchorPath: "/managed/shared", managedRepoPaths: ["/managed/shared"], config: { parallel: { maxNonShipDispatches: 4 } }, sweep: "dev", count: 1 },
  ], { maxNonShipDispatches: 4 });
  assert.deepEqual(batch.map((c) => `${c.sourceAnchorPath}:${c.sweep}`), ["/registered/a:qa"]);
});
test("selectDispatchBatch: duplicate workspace stages consume one batch slot", () => {
  const batch = selectDispatchBatch([
    { sourceAnchorPath: "/registered/a", anchorPath: "/managed/a", config: { repos: ["a"], parallel: { maxNonShipDispatches: 4 } }, sweep: "qa", count: 1 },
    { sourceAnchorPath: "/registered/a", anchorPath: "/managed/a", config: { repos: ["a"], parallel: { maxNonShipDispatches: 4 } }, sweep: "qa", count: 1 },
    { sourceAnchorPath: "/registered/b", anchorPath: "/managed/b", config: { repos: ["b"], parallel: { maxNonShipDispatches: 4 } }, sweep: "spec", count: 1 },
  ], { maxNonShipDispatches: 2 });
  assert.deepEqual(batch.map((c) => `${c.sourceAnchorPath}:${c.sweep}`), [
    "/registered/a:qa",
    "/registered/b:spec",
  ]);
});
test("selectDispatchBatch: dedupes nested repo path overlap", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/ws/a", config: { repos: ["/tmp/shared"] }, sweep: "dev", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/b", config: { repos: ["/tmp/shared/subrepo"] }, sweep: "spec", count: 1, oldestUpdatedAt: 2 },
    { anchorPath: "/ws/c", config: { repos: ["/tmp/other"] }, sweep: "spec", count: 1, oldestUpdatedAt: 3 },
  ], { maxNonShipDispatches: 3 });
  assert.deepEqual(batch.map((c) => c.anchorPath), ["/ws/a", "/ws/c"]);
});
test("selectDispatchBatch: overlap detection uses actual stable-slug managed repo paths", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/managed/a", managedRepoPaths: ["/managed/a", "/managed/sibling-guide-a1b2"], config: { repos: ["a", "guide"] }, sweep: "dev", count: 1 },
    { anchorPath: "/managed/b", managedRepoPaths: ["/managed/sibling-guide-a1b2"], config: { repos: ["b"] }, sweep: "spec", count: 1 },
  ], { maxNonShipDispatches: 2 });
  assert.deepEqual(batch.map((candidate) => candidate.anchorPath), ["/managed/a"]);
});
test("dryRunDispatchMessages: reports every selected dispatch", () => {
  const messages = dryRunDispatchMessages([
    { anchorPath: "/ws/a", sweep: "dev", count: 2, config: { runtimes: { dev: { runtime: "codex", model: "gpt-5.5", effort: "high" } } } },
    { anchorPath: "/ws/b", sweep: "spec", count: 1, config: { runtimes: { spec: { runtime: "claude", model: "claude-opus-4-8" } } } },
  ]);
  assert.deepEqual(messages, [
    { anchorPath: "/ws/a", sweep: "dev", body: "[dry-run] WOULD dispatch codex / gpt-5.5 / effort=high (2 actionable; sameRepoLimit=4)" },
    { anchorPath: "/ws/b", sweep: "spec", body: "[dry-run] WOULD dispatch claude / claude-opus-4-8 (1 actionable; sameRepoLimit=4)" },
  ]);
});
test("dryRunDispatchMessages: reports expanded same-repo card slots when cards are attached", () => {
  const messages = dryRunDispatchMessages([
    {
      anchorPath: "/ws/a",
      sweep: "dev",
      count: 2,
      config: { parallel: { sameRepoCardLimits: { dev: 2 } } },
      topCard: { identifier: "COD-8" },
      cards: [
        { id: "a", identifier: "COD-7", sortOrder: 1, updatedAt: minsAgo(1), labelNames: [], comments: [] },
        { id: "b", identifier: "COD-8", sortOrder: 5, updatedAt: minsAgo(1), labelNames: [], comments: [] },
      ].map(dependencyReadyCard),
    },
  ]);
  assert.deepEqual(messages.map((m) => m.body), [
    "[dry-run] WOULD dispatch codex (2 actionable; top COD-8; sameRepoLimit=2)",
    "[dry-run] slot 1/2 dev COD-8 sortOrder=5",
    "[dry-run] slot 2/2 dev COD-7 sortOrder=1",
  ]);
});
test("dryRunDispatchMessages: names each card's routed primary repo", () => {
  const messages = dryRunDispatchMessages([{
    anchorPath: "/managed/coach",
    sweep: "dev",
    count: 1,
    config: { parallel: { sameRepoCardLimits: { dev: 1 } } },
    cards: [dependencyReadyCard({
      id: "guide",
      identifier: "SAF-207",
      sortOrder: 1,
      updatedAt: minsAgo(1),
      labelNames: ["app:guide"],
      comments: [],
      repoRoute: { ok: true, label: "app:guide", repoEntry: "safetaper-guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" },
    })],
  }]);
  assert.match(messages[1].body, /repo=safetaper-guide/);
});
test("dry-run and child expansion apply limits independently to routed sibling repos", async () => {
  const config = { repos: ["coach", "guide"], repoRouting: { byLabel: { "app:coach": "coach", "app:guide": "guide" } }, parallel: { sameRepoCardLimits: { qa: 1 } } };
  const card = (repoEntry, identifier, sortOrder) => dependencyReadyCard({
    id: identifier,
    identifier,
    sortOrder,
    updatedAt: minsAgo(1),
    labelNames: [`app:${repoEntry}`],
    comments: [],
    repoRoute: { ok: true, label: `app:${repoEntry}`, repoEntry, sourceRepoPath: `/source/${repoEntry}`, managedRepoPath: `/managed/${repoEntry}` },
  });
  const candidate = {
    anchorPath: "/managed/coach",
    config,
    sweep: "qa",
    count: 2,
    cards: [card("coach", "SAF-1", 2), card("guide", "SAF-2", 1)],
    runtimeOverride: { runtime: "claude", model: "claude-sonnet-5" },
    runtimeCooldownProbe: true,
  };
  assert.deepEqual(dryRunDispatchMessages([candidate]).slice(1).map((message) => message.body.match(/repo=([^ ]+)/)?.[1]), ["coach", "guide"]);
  const children = await expandDispatchBatch([candidate], { dryRun: true, parentRunId: "run-id", activeByAnchor: new Map(), now: NOW });
  assert.deepEqual(children.map((child) => child.issueIdentifier), ["SAF-1", "SAF-2"]);
  assert.ok(children.every((child) => child.runtimeOverride.runtime === "claude" && child.runtimeCooldownProbe === true));
});
test("dispatchBatch: dispatches every selected child and returns structured results", async () => {
  const calls = [];
  const results = await dispatchBatch([
    { anchorPath: "/ws/a", sweep: "dev", config: {}, issueIdentifier: "COD-1" },
    { anchorPath: "/ws/b", sweep: "spec", config: {} },
  ], {
    dispatchFn: async (anchorPath, sweep, config, pick) => {
      calls.push({ anchorPath, sweep, config, pick });
      return classifyDispatchOutcome({ type: "close", exitCode: sweep === "dev" ? 0 : 7, path: "/bin/codex", cwd: anchorPath });
    },
  });
  assert.deepEqual(results.map((r) => r.exitCode), [0, 7]);
  assert.deepEqual(results.map((r) => r.success), [true, false]);
  assert.equal(results[0].issueIdentifier, "COD-1");
  assert.equal(results[0].dispatchScope, "dev:COD-1:dispatch");
  assert.equal(results[1].dispatchScope, "spec:dispatch");
  assert.ok(results[0].startedAt);
  assert.ok(results[0].completedAt);
  assert.deepEqual(calls.map((c) => `${c.anchorPath}:${c.sweep}`), ["/ws/a:dev", "/ws/b:spec"]);
});
test("dispatchBatch: reports each child result as soon as that child completes", async () => {
  let releaseSlow;
  const slow = new Promise((resolve) => {
    releaseSlow = () => resolve(classifyDispatchOutcome({ type: "close", exitCode: 7, path: "/bin/codex", cwd: "/ws/slow" }));
  });
  const seen = [];
  const run = dispatchBatch([
    { anchorPath: "/ws/fast", sweep: "dev", config: {}, issueIdentifier: "COD-1" },
    { anchorPath: "/ws/slow", sweep: "spec", config: {}, issueIdentifier: "COD-2" },
  ], {
    dispatchFn: async (anchorPath, sweep) => (sweep === "spec"
      ? slow
      : classifyDispatchOutcome({ type: "close", exitCode: 0, path: "/bin/codex", cwd: anchorPath })),
    onResult: async (result) => { seen.push(`${result.issueIdentifier}:${result.exitCode}`); },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["COD-1:0"]);
  releaseSlow();
  const results = await run;
  assert.deepEqual(seen, ["COD-1:0", "COD-2:7"]);
  assert.deepEqual(results.map((r) => r.exitCode), [0, 7]);
});
test("classifyDispatchOutcome: executable ENOENT and cwd ENOENT are distinct", () => {
  const executable = classifyDispatchOutcome({
    type: "error",
    error: { code: "ENOENT" },
    path: "/resolved/codex",
    cwd: "/workspace",
    cwdExists: true,
    executableExists: false,
  });
  const cwd = classifyDispatchOutcome({
    type: "error",
    error: { code: "ENOENT" },
    path: "/resolved/codex",
    cwd: "/missing-workspace",
    cwdExists: false,
  });
  assert.deepEqual(executable, {
    kind: "executable-enoent", code: "ENOENT", exitCode: null, signal: null,
    path: "/resolved/codex", cwd: "/workspace",
  });
  assert.deepEqual(cwd, {
    kind: "cwd-enoent", code: "ENOENT", exitCode: null, signal: null,
    path: "/resolved/codex", cwd: "/missing-workspace",
  });
});
test("classifyDispatchOutcome: exit 127, signal, interruption, and success remain typed", () => {
  const base = { path: "/resolved/codex", cwd: "/workspace" };
  assert.deepEqual(classifyDispatchOutcome({ ...base, type: "close", exitCode: 127 }), {
    kind: "exit", code: null, exitCode: 127, signal: null, ...base,
  });
  assert.deepEqual(classifyDispatchOutcome({ ...base, type: "close", exitCode: null, signal: "SIGTERM" }), {
    kind: "signal", code: null, exitCode: null, signal: "SIGTERM", ...base,
  });
  assert.deepEqual(classifyDispatchOutcome({ ...base, type: "interruption", signal: "SIGINT" }), {
    kind: "interrupted", code: "INTERRUPTED", exitCode: null, signal: "SIGINT", ...base,
  });
  assert.deepEqual(classifyDispatchOutcome({ ...base, type: "close", exitCode: 0 }), {
    kind: "success", code: null, exitCode: 0, signal: null, ...base,
  });
});

// Envelope: openai/codex bfe31598 exec_events.rs; message family: protocol/error.rs.
const PERSONAL_LIMIT_ERROR = { type: "error", message: "You've hit your usage limit. Try again later." };
const MODEL_LIMIT_FAILURE = { type: "turn.failed", error: { message: "You've hit your usage limit for codex_other. Switch to another model now, or try again later." } };
const TPM_LIMIT = { type: "error", message: "Rate limit reached for gpt-5 on tokens per min. Please try again in 11s." };
const WORKSPACE_CREDITS = { type: "error", message: "Your workspace has run out of credits." };

test("Codex usage evidence: recognizes only source-pinned terminal error envelopes", () => {
  assert.equal(isCodexUsageExhaustedEvent(PERSONAL_LIMIT_ERROR), true);
  assert.equal(isCodexUsageExhaustedEvent(MODEL_LIMIT_FAILURE), true);

  for (const value of [
    { type: "agent.message", message: PERSONAL_LIMIT_ERROR.message },
    { type: "item.completed", item: { message: PERSONAL_LIMIT_ERROR.message } },
    { type: "error", message: "The service is overloaded. Try again later." },
    { type: "error", message: "Context window exceeded." },
    { type: "error", message: "Authentication required." },
    { type: "error", message: "Quota exceeded." },
    TPM_LIMIT,
    WORKSPACE_CREDITS,
    { type: "error", message: "Your workspace spending limit has been reached." },
    { type: "error", message: "Your workspace credit balance is empty." },
    { type: "turn.failed", error: { details: PERSONAL_LIMIT_ERROR.message } },
    { type: "error" },
    { type: "turn.failed" },
    [],
    null,
    "You've hit your usage limit.",
  ]) assert.equal(isCodexUsageExhaustedEvent(value), false);
});

test("Codex usage evidence: streams split stdout JSON and excludes log-only stderr", () => {
  const collector = createCodexUsageEvidenceCollector();
  const encoded = Buffer.from(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
  collector.push(encoded.subarray(0, 17));
  collector.push(encoded.subarray(17));
  collector.finish();
  assert.equal(collector.exhausted(), true);

  const stdoutCollector = createCodexUsageEvidenceCollector();
  const stderrLogOnly = Buffer.from(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
  assert.ok(stderrLogOnly.length > 0);
  stdoutCollector.finish();
  assert.equal(stdoutCollector.exhausted(), false);
});

test("Codex usage evidence: fails closed on oversized, malformed, and bounded candidate streams", () => {
  const oversizedPositive = { ...PERSONAL_LIMIT_ERROR, message: `${PERSONAL_LIMIT_ERROR.message}${"x".repeat(16 * 1024)}` };
  const discarded = createCodexUsageEvidenceCollector();
  discarded.push(Buffer.from(`${JSON.stringify(oversizedPositive)}\n`));
  discarded.finish();
  assert.equal(discarded.exhausted(), false);

  const longLineThenPositive = createCodexUsageEvidenceCollector();
  longLineThenPositive.push(Buffer.from(`${JSON.stringify(oversizedPositive)}\n${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`));
  longLineThenPositive.finish();
  assert.equal(longLineThenPositive.exhausted(), true);

  const malformed = createCodexUsageEvidenceCollector();
  malformed.push(Buffer.from([0x7b, 0x22, 0xff, 0x0a]));
  malformed.push(Buffer.from("{not json}\n"));
  malformed.finish();
  assert.equal(malformed.exhausted(), false);

  const routineTraffic = createCodexUsageEvidenceCollector();
  routineTraffic.push(Buffer.from(`${Array.from({ length: 100 }, () => JSON.stringify({ type: "item.completed" })).join("\n")}\n`));
  routineTraffic.push(Buffer.from(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`));
  routineTraffic.finish();
  assert.equal(routineTraffic.exhausted(), true);

  const candidateOverflow = createCodexUsageEvidenceCollector();
  candidateOverflow.push(Buffer.from(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`));
  candidateOverflow.push(Buffer.from(`${Array.from({ length: 32 }, () => JSON.stringify({ type: "error", message: "ordinary terminal error" })).join("\n")}\n`));
  candidateOverflow.finish();
  assert.equal(candidateOverflow.exhausted(), false);

  const byteOverflow = createCodexUsageEvidenceCollector();
  byteOverflow.push(Buffer.from(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`));
  byteOverflow.push(Buffer.from(`${Array.from({ length: 5 }, () => JSON.stringify({ type: "error", message: "x".repeat(14 * 1024) })).join("\n")}\n`));
  byteOverflow.finish();
  assert.equal(byteOverflow.exhausted(), false);
  assert.equal("events" in byteOverflow, false);
  assert.equal(Object.values(byteOverflow).some(Array.isArray), false);
});

test("Codex usage evidence: rejects a malformed UTF-8 positive error line", () => {
  const collector = createCodexUsageEvidenceCollector();
  collector.push(Buffer.concat([
    Buffer.from('{"type":"error","message":"You\'ve hit your usage limit.'),
    Buffer.from([0xff]),
    Buffer.from('"}\n'),
  ]));
  collector.finish();
  assert.equal(collector.exhausted(), false);
});

test("Codex usage evidence: finish parses a bounded final stdout line", () => {
  const bounded = createCodexUsageEvidenceCollector();
  bounded.push(Buffer.from(JSON.stringify(PERSONAL_LIMIT_ERROR)));
  bounded.finish();
  assert.equal(bounded.exhausted(), true);

  const oversized = createCodexUsageEvidenceCollector();
  oversized.push(Buffer.from("x".repeat(16 * 1024 + 1)));
  oversized.finish();
  assert.equal(oversized.exhausted(), false);
});

test("Claude usage evidence: recognizes only bounded stderr limit lines", () => {
  for (const message of ["You've hit your limit · resets 8pm", "Claude usage limit reached. Try again later."]) {
    const collector = createClaudeUsageEvidenceCollector();
    collector.push(Buffer.from(`${message}\n`));
    collector.finish();
    assert.equal(collector.exhausted(), true);
  }
  for (const message of ["Authentication required", "429 rate limit", "The service is overloaded", "agent said: You've hit your limit"]) {
    const collector = createClaudeUsageEvidenceCollector();
    collector.push(Buffer.from(`${message}\n`));
    collector.finish();
    assert.equal(collector.exhausted(), false);
  }
});

test("dispatchAsync fallback: Codex exhaustion runs one sequential Claude attempt with the same child context", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-fallback-success-"));
  const primary = pipedDispatchChild(801);
  const fallback = pipedDispatchChild(802);
  const calls = [];
  const controller = new AbortController();
  const childEnv = { AUTO_SWEEP_ISSUE: "COD-144", AUTO_SWEEP_WORKTREE: "/worktrees/COD-144", AUTO_SWEEP_LOG_DIR: "/logs/COD-144" };
  const run = dispatchAsync(anchorPath, "dev", {
    runtimes: { dev: { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5", effort: "high" } } },
  }, {
    issueIdentifier: "COD-144", logDir: path.join(anchorPath, "logs"), runtimeExecutable: "/resolved/codex", childEnv,
  }, {
    signal: controller.signal,
    spawnFn: queuedDispatchSpawn([primary, fallback], calls),
    resolveRuntimeExecutableFn: () => ({ ok: true, path: "/resolved/claude" }),
  });
  primary.stdout.end(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
  primary.close(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].executable, "/resolved/codex");
  assert.equal(calls[1].executable, "/resolved/claude");
  assert.equal(calls[1].options.cwd, calls[0].options.cwd);
  assert.equal(calls[1].options.env, calls[0].options.env);
  assert.equal(calls[1].options.env.AUTO_SWEEP_WORKTREE, "/worktrees/COD-144");
  assert.equal(calls[1].options.env.AUTO_SWEEP_LOG_DIR, "/logs/COD-144");
  assert.equal(calls[1].options.signal, controller.signal);
  assert.equal(calls[1].args[1], calls[0].args.at(-1));
  fallback.close(0);
  const outcome = await run;
  assert.equal(outcome.kind, "success");
  assert.equal(outcome.fallbackUsed, true);
  assert.deepEqual(outcome.finalRuntimeConfig, { runtime: "claude", model: "claude-sonnet-5", effort: "high" });
  assert.equal(outcome.finalRuntimeExecutable, "/resolved/claude");
  assert.equal(outcome.attempts.length, 2);
  assert.equal(outcome.attempts[0].usageExhausted, true);
  assert.deepEqual(outcome.attempts.map((attempt) => attempt.runtime), ["codex", "claude"]);
  const recordFile = fs.readdirSync(path.join(anchorPath, "logs")).find((name) => name.startsWith("run-records-"));
  const record = JSON.parse(fs.readFileSync(path.join(anchorPath, "logs", recordFile), "utf8").trim());
  assert.equal(record.runtime, "claude");
  assert.equal(record.model, "claude-sonnet-5");
  assert.equal(record.resolvedRuntimeExecutable, "/resolved/claude");
  assert.equal(record.fallbackUsed, true);
  assert.equal(record.attempts.length, 2);
});

test("dispatchAsync cooldown route: direct Claude exhaustion is normalized without another fallback", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-claude-exhaustion-"));
  const child = pipedDispatchChild(803);
  const run = dispatchAsync(anchorPath, "dev", {
    runtimes: { dev: { runtime: "codex", model: "gpt", fallback: { runtime: "claude", model: "claude-sonnet-5" } } },
  }, {
    issueIdentifier: "COD-144",
    runtimeOverride: { runtime: "claude", model: "claude-sonnet-5" },
    runtimeExecutable: "/resolved/claude",
  }, { spawnFn: queuedDispatchSpawn([child]) });
  child.stderr.write("You've hit your limit · resets 8pm\n");
  child.close(1);
  const result = await run;
  assert.equal(result.finalRuntimeConfig.runtime, "claude");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].usageExhausted, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(isFinalProviderUsageExhaustion(result), true);
});

test("provider usage reconciliation: unresolved Claude is actionable rather than final exhaustion", () => {
  assert.equal(isFinalProviderUsageExhaustion({
    kind: "executable-enoent",
    finalRuntimeConfig: { runtime: "claude" },
    attempts: [{ runtime: "codex", usageExhausted: true, outcome: { kind: "exit", exitCode: 1 } }],
  }), false);
  assert.equal(isFinalProviderUsageExhaustion({
    kind: "exit",
    finalRuntimeConfig: { runtime: "claude" },
    attempts: [
      { runtime: "codex", usageExhausted: true, outcome: { kind: "exit", exitCode: 1 } },
      { runtime: "claude", outcome: { kind: "exit", exitCode: 7 } },
    ],
  }), false);
  assert.equal(shouldClearRuntimeCooldown({ kind: "spawn-error", attempts: [], finalRuntimeConfig: { runtime: "codex" } }, { runtimeCooldownProbe: true }), true);
  assert.equal(shouldClearRuntimeCooldown({ kind: "exit", attempts: [{ runtime: "codex", usageExhausted: true }], finalRuntimeConfig: { runtime: "codex" } }, { runtimeCooldownProbe: true }), false);
});

test("dispatchAsync fallback: stderr usage text is logged but never authorizes Claude", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-fallback-stderr-separation-"));
  const primary = pipedDispatchChild(805);
  const calls = [];
  const run = dispatchAsync(anchorPath, "dev", {
    runtimes: { dev: { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5" } } },
  }, { issueIdentifier: "COD-144", logDir: path.join(anchorPath, "logs"), runtimeExecutable: "/resolved/codex" }, {
    spawnFn: queuedDispatchSpawn([primary], calls),
    resolveRuntimeExecutableFn: () => ({ ok: true, path: "/resolved/claude" }),
  });
  primary.stderr.end(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
  primary.close(1);
  const outcome = await run;
  assert.equal(outcome.kind, "exit");
  assert.equal(calls.length, 1);
  assert.equal(outcome.fallbackUsed, false);
});

test("dispatchAsync fallback: successful, anomalous, ordinary, and interrupted Codex attempts never fall back", async () => {
  const cases = [
    { name: "success", close: [0, null], exhausted: true, kind: "success" },
    { name: "null exit", close: [null, null], exhausted: true, kind: "exit" },
    { name: "ordinary exit", close: [1, null], exhausted: false, kind: "exit" },
    { name: "signal", close: [null, "SIGTERM"], exhausted: true, kind: "signal" },
  ];
  for (const fixture of cases) {
    const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), `linear-fallback-${fixture.name}-`));
    const primary = pipedDispatchChild(810);
    const calls = [];
    const run = dispatchAsync(anchorPath, "dev", {
      runtimes: { dev: { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5" } } },
    }, { issueIdentifier: "COD-144", logDir: path.join(anchorPath, "logs"), runtimeExecutable: "/resolved/codex" }, {
      spawnFn: queuedDispatchSpawn([primary], calls),
      resolveRuntimeExecutableFn: () => ({ ok: true, path: "/resolved/claude" }),
    });
    if (fixture.exhausted) primary.stdout.end(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
    primary.close(...fixture.close);
    const outcome = await run;
    assert.equal(outcome.kind, fixture.kind, fixture.name);
    assert.equal(calls.length, 1, fixture.name);
    assert.equal(outcome.fallbackUsed, false, fixture.name);
    assert.equal(outcome.attempts.length, 1, fixture.name);
  }
});

test("dispatchAsync fallback: absent configuration preserves the exhausted Codex attribution", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-fallback-absent-"));
  const primary = pipedDispatchChild(820);
  const calls = [];
  const run = dispatchAsync(anchorPath, "dev", {}, {
    issueIdentifier: "COD-144", logDir: path.join(anchorPath, "logs"), runtimeExecutable: "/resolved/codex",
  }, { spawnFn: queuedDispatchSpawn([primary], calls) });
  primary.stdout.end(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
  primary.close(1);
  const outcome = await run;
  assert.equal(calls.length, 1);
  assert.equal(outcome.kind, "exit");
  assert.equal(outcome.finalRuntimeConfig.runtime, "codex");
  assert.equal(outcome.fallbackUsed, false);
});

test("dispatchAsync fallback deferral: dependency and repository outcome files outrank a qualifying exhausted failure", async () => {
  for (const fixture of [
    { kind: "dependency-deferred", expected: "dependency-deferred", dependencyExitCode: 3 },
    {
      kind: "repo-routing-deferred",
      expected: "repo-routing-deferred",
      routeExitCode: 3,
      repoRoute: { label: "repo:kit", repoEntry: "." },
      routing: {
        reason: "route-changed",
        expectedLabel: "repo:kit",
        expectedRepoEntry: ".",
        matches: [{ label: "repo:other", repoEntry: "other" }],
      },
    },
  ]) {
    const { expected, repoRoute, ...deferredOutcome } = fixture;
    const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-fallback-deferral-"));
    const outcomePath = path.join(anchorPath, "outcome.json");
    const primary = pipedDispatchChild(830);
    const calls = [];
    const config = {
      runtimes: { dev: { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5" } } },
      repoRouting: { byLabel: { "repo:kit": ".", "repo:other": "other" } },
    };
    const run = dispatchAsync(anchorPath, "dev", config, {
      issueIdentifier: "COD-144", logDir: path.join(anchorPath, "logs"), outcomePath, runtimeExecutable: "/resolved/codex",
      config,
      ...(repoRoute ? { repoRoute } : {}),
    }, { spawnFn: queuedDispatchSpawn([primary], calls) });
    primary.stdout.end(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
    fs.writeFileSync(outcomePath, JSON.stringify({ version: 1, issueIdentifier: "COD-144", ...deferredOutcome }));
    primary.close(1);
    const outcome = await run;
    assert.equal(outcome.kind, expected);
    assert.equal(calls.length, 1);
  }
});

test("dispatchAsync fallback: abort gaps before and after resolution prevent Claude spawn", async () => {
  for (const fixture of ["before resolver", "after resolver"]) {
    const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-fallback-abort-"));
    const primary = pipedDispatchChild(840);
    const calls = [];
    const controller = new AbortController();
    const run = dispatchAsync(anchorPath, "dev", {
      runtimes: { dev: { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5" } } },
    }, { issueIdentifier: "COD-144", logDir: path.join(anchorPath, "logs"), runtimeExecutable: "/resolved/codex" }, {
      signal: controller.signal,
      spawnFn: queuedDispatchSpawn([primary], calls),
      resolveRuntimeExecutableFn: () => {
        if (fixture === "after resolver") controller.abort({ signal: "SIGTERM" });
        return { ok: true, path: "/resolved/claude" };
      },
    });
    primary.stdout.end(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
    primary.close(1);
    if (fixture === "before resolver") controller.abort({ signal: "SIGTERM" });
    const outcome = await run;
    assert.equal(outcome.kind, "interrupted", fixture);
    assert.equal(calls.length, 1, fixture);
  }
});

test("dispatchAsync fallback: records both PIDs and fails closed when Claude is unavailable or fails", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-fallback-final-failure-"));
  const primary = pipedDispatchChild(850);
  const fallback = pipedDispatchChild(851);
  const pids = [];
  const calls = [];
  const run = dispatchAsync(anchorPath, "dev", {
    runtimes: { dev: { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5" } } },
  }, { issueIdentifier: "COD-144", logDir: path.join(anchorPath, "logs"), runtimeExecutable: "/resolved/codex" }, {
    spawnFn: queuedDispatchSpawn([primary, fallback], calls), onSpawn: (pid) => pids.push(pid),
    resolveRuntimeExecutableFn: () => ({ ok: true, path: "/resolved/claude" }),
  });
  primary.stdout.end(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
  primary.close(1);
  await new Promise((resolve) => setImmediate(resolve));
  fallback.close(7);
  const outcome = await run;
  assert.equal(outcome.kind, "exit");
  assert.equal(outcome.exitCode, 7);
  assert.deepEqual(pids, [850, 851]);
  assert.equal(outcome.attempts.length, 2);
  assert.equal(calls.length, 2);

  const missingPrimary = pipedDispatchChild(852);
  const missingCalls = [];
  const missingRun = dispatchAsync(anchorPath, "dev", {
    runtimes: { dev: { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5" } } },
  }, { issueIdentifier: "COD-145", logDir: path.join(anchorPath, "missing-logs"), runtimeExecutable: "/resolved/codex" }, {
    spawnFn: queuedDispatchSpawn([missingPrimary], missingCalls),
    resolveRuntimeExecutableFn: () => ({ ok: false, runtime: "claude", code: "ENOENT", path: null }),
  });
  missingPrimary.stdout.end(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
  missingPrimary.close(1);
  const missing = await missingRun;
  assert.equal(missing.kind, "executable-enoent");
  assert.equal(missing.finalRuntimeConfig.runtime, "claude");
  assert.equal(missing.finalRuntimeExecutable, null);
  assert.equal(missing.finalRuntimeLaneKey.includes("claude"), true);
  assert.equal(missingCalls.length, 1);
});

test("dispatchAsync fallback: Claude resolution failure preserves the exhausted Codex audit path without a second attempt", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-fallback-resolution-failure-"));
  const primary = pipedDispatchChild(855);
  const calls = [];
  const run = dispatchAsync(anchorPath, "dev", {
    runtimes: { dev: { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5" } } },
  }, { issueIdentifier: "COD-146", logDir: path.join(anchorPath, "logs"), runtimeExecutable: "/resolved/codex" }, {
    spawnFn: queuedDispatchSpawn([primary], calls),
    resolveRuntimeExecutableFn: () => ({ ok: false, runtime: "claude", code: "ENOENT", path: null }),
  });
  primary.stdout.end(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
  primary.close(1);
  const outcome = await run;

  assert.equal(outcome.kind, "executable-enoent");
  assert.equal(outcome.finalRuntimeConfig.runtime, "claude");
  assert.equal(outcome.fallbackUsed, true);
  assert.equal(outcome.attempts.length, 1);
  assert.equal(outcome.attempts[0].runtime, "codex");
  assert.equal(isFinalProviderUsageExhaustion(outcome), false);
  assert.equal(calls.length, 1);

  const recordFile = fs.readdirSync(path.join(anchorPath, "logs")).find((name) => name.startsWith("run-records-"));
  const record = JSON.parse(fs.readFileSync(path.join(anchorPath, "logs", recordFile), "utf8").trim());
  assert.equal(record.runtime, "claude");
  assert.equal(record.fallbackUsed, true);
  assert.equal(record.attempts.length, 1);
  assert.equal(record.attempts[0].runtime, "codex");

  assert.equal(typeof watchModule.fallbackFailureAttribution, "function");
  assert.equal(
    watchModule.fallbackFailureAttribution(outcome),
    "after Codex usage exhaustion; Claude fallback executable resolution failed",
  );
});

test("dispatchAsync fallback PID: rejected second attachment kills Claude and waits for close", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-fallback-pid-"));
  const primary = pipedDispatchChild(860);
  const fallback = pipedDispatchChild(861);
  let settled = false;
  const run = dispatchAsync(anchorPath, "dev", {
    runtimes: { dev: { runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5" } } },
  }, { issueIdentifier: "COD-144", logDir: path.join(anchorPath, "logs"), runtimeExecutable: "/resolved/codex" }, {
    spawnFn: queuedDispatchSpawn([primary, fallback]),
    onSpawn: (pid) => pid !== 861,
    resolveRuntimeExecutableFn: () => ({ ok: true, path: "/resolved/claude" }),
  }).then((outcome) => { settled = true; return outcome; });
  primary.stdout.end(`${JSON.stringify(PERSONAL_LIMIT_ERROR)}\n`);
  primary.close(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fallback.killCalls, ["SIGTERM"]);
  assert.equal(settled, false);
  fallback.close(null, "SIGTERM");
  const outcome = await run;
  assert.equal(outcome.code, "CAPACITY_ATTACH_FAILED");
});

test("dispatchAsync fallback: stdout and stderr log write failures kill and await one typed I/O outcome", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), `linear-fallback-${stream}-io-`));
    const primary = pipedDispatchChild(870);
    let writes = 0;
    let settled = false;
    const run = dispatchAsync(anchorPath, "dev", {}, {
      issueIdentifier: "COD-144", logDir: path.join(anchorPath, "logs"), runtimeExecutable: "/resolved/codex",
    }, {
      spawnFn: queuedDispatchSpawn([primary]),
      writeChunkFn: () => { writes += 1; throw new Error(`${stream} write failed`); },
    }).then((outcome) => { settled = true; return outcome; });
    primary[stream].write("provider output must not escape");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 1, stream);
    assert.deepEqual(primary.killCalls, ["SIGTERM"], stream);
    assert.equal(settled, false, stream);
    primary.close(1);
    const outcome = await run;
    assert.equal(outcome.kind, "dispatch-io-error", stream);
    assert.equal(outcome.code, "LOG_WRITE_FAILED", stream);
    assert.equal(outcome.attempts.length, 1, stream);
  }
});

test("dispatchAsync: child dependency outcome channel overrides a superficially successful runtime exit", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-dependency-outcome-"));
  const logDir = path.join(anchorPath, "logs");
  const outcomePath = path.join(anchorPath, "dependency-outcome.json");
  const child = new EventEmitter();
  child.pid = 502;
  const run = dispatchAsync(anchorPath, "dev", {}, {
    issueIdentifier: "COD-90", issueId: "issue-90", ownerToken: "owner-90",
    logDir, outcomePath, runtimeExecutable: "/resolved/codex",
    childEnv: { AUTO_SWEEP_OUTCOME_PATH: outcomePath },
  }, { spawnFn: () => child });
  fs.writeFileSync(outcomePath, JSON.stringify({ version: 1, kind: "dependency-deferred", issueIdentifier: "COD-90", dependencyExitCode: 3 }));
  child.emit("close", 0, null);
  const outcome = await run;
  assert.equal(outcome.kind, "dependency-deferred");
  assert.equal(outcome.code, "DEPENDENCY_BLOCKED");
  assert.equal(outcome.dependencyExitCode, 3);
  const recordName = fs.readdirSync(logDir).find((name) => name.startsWith("run-records-"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(logDir, recordName), "utf8")).outcome.kind, "dependency-deferred");
});
test("child outcome protocol: validates only bounded, trusted routed deferrals", () => {
  const routedPick = {
    issueIdentifier: "COD-291",
    repoRoute: { label: "repo:kit", repoEntry: "." },
    config: { repoRouting: { byLabel: { "repo:kit": ".", "repo:other": "other" } } },
  };
  const route = ({ routeExitCode, reason, matches }) => ({
    version: 1,
    kind: "repo-routing-deferred",
    issueIdentifier: "COD-291",
    routeExitCode,
    routing: {
      reason,
      expectedLabel: "repo:kit",
      expectedRepoEntry: ".",
      matches,
    },
  });
  const valid = [
    route({ routeExitCode: 2, reason: "unreadable", matches: [] }),
    route({ routeExitCode: 2, reason: "scheduled-context-mismatch", matches: [] }),
    route({ routeExitCode: 3, reason: "missing-route-label", matches: [] }),
    route({ routeExitCode: 3, reason: "ambiguous-route-label", matches: [
      { label: "repo:kit", repoEntry: "." }, { label: "repo:other", repoEntry: "other" },
    ] }),
    route({ routeExitCode: 3, reason: "route-changed", matches: [{ label: "repo:other", repoEntry: "other" }] }),
  ];

  assert.equal(typeof watchModule.validateChildDeferredOutcome, "function");
  for (const value of valid) {
    const outcome = watchModule.validateChildDeferredOutcome(value, routedPick);
    assert.equal(outcome.kind, "repo-routing-deferred");
    assert.equal(outcome.code, value.routeExitCode === 2 ? "REPO_ROUTE_UNREADABLE" : "REPO_ROUTE_CHANGED");
    assert.notEqual(outcome.routing, value.routing);
    assert.deepEqual(outcome.routing, value.routing);
  }
  for (const value of [
    { version: 1, kind: "dependency-deferred", issueIdentifier: "COD-291", dependencyExitCode: 3 },
    {
      version: 1, kind: "dependency-deferred", issueIdentifier: "COD-291", dependencyExitCode: 2,
      dependency: { reason: "incomplete-relations", blockers: [{ identifier: "COD-290", stateName: "Dev" }] },
    },
    {
      version: 1, kind: "dependency-deferred", issueIdentifier: "COD-291", dependencyExitCode: 3,
      dependency: { reason: "blocked", blockers: [{ identifier: "COD-290", stateName: "Dev" }] },
    },
  ]) {
    const dependency = watchModule.validateChildDeferredOutcome(value, routedPick);
    assert.equal(dependency.kind, "dependency-deferred");
    assert.equal(dependency.code, value.dependencyExitCode === 3 ? "DEPENDENCY_BLOCKED" : "DEPENDENCY_UNREADABLE");
    if (value.dependency) {
      assert.notEqual(dependency.dependency, value.dependency);
      assert.deepEqual(dependency.dependency, value.dependency);
    }
  }
});

test("child outcome protocol: every present malformed or untrusted route file fails closed", async () => {
  const routedPick = {
    issueIdentifier: "COD-291",
    repoRoute: { label: "repo:kit", repoEntry: "." },
    config: { repoRouting: { byLabel: { "repo:kit": ".", "repo:other": "other" } } },
  };
  const route = ({ routeExitCode = 3, reason = "route-changed", matches = [{ label: "repo:other", repoEntry: "other" }] } = {}) => ({
    version: 1,
    kind: "repo-routing-deferred",
    issueIdentifier: "COD-291",
    routeExitCode,
    routing: { reason, expectedLabel: "repo:kit", expectedRepoEntry: ".", matches },
  });
  const oversized = "x".repeat(65_537);
  const cases = [
    ["invalid JSON", "{\"untrusted-route-secret\":"],
    ["oversized", oversized],
    ["unsupported version", { ...route(), version: 2 }],
    ["unsupported kind", { ...route(), kind: "success" }],
    ["extra top-level field", { ...route(), extra: "untrusted-route-secret" }],
    ["extra routing field", { ...route(), routing: { ...route().routing, extra: "untrusted-route-secret" } }],
    ["missing issue", (() => { const value = route(); delete value.issueIdentifier; return value; })()],
    ["missing route field", (() => { const value = route(); delete value.routing.expectedLabel; return value; })()],
    ["non-routed pick", route(), { issueIdentifier: "COD-291", config: routedPick.config }],
    ["wrong issue", { ...route(), issueIdentifier: "COD-292" }],
    ["wrong tuple", { ...route(), routing: { ...route().routing, expectedRepoEntry: "other" } }],
    ["oversized string", { ...route(), routing: { ...route().routing, expectedLabel: "x".repeat(257) } }],
    ["oversized match string", route({ matches: [{ label: "repo:other", repoEntry: "x".repeat(257) }] })],
    ["duplicate matches", route({ reason: "ambiguous-route-label", matches: [{ label: "repo:kit", repoEntry: "." }, { label: "repo:kit", repoEntry: "." }] })],
    ["unconfigured match", route({ matches: [{ label: "repo:unconfigured", repoEntry: "elsewhere" }] })],
    ["missing route exit", (() => { const value = route(); delete value.routeExitCode; return value; })()],
    ["string route exit", route({ routeExitCode: "3" })],
    ["route exit 1", route({ routeExitCode: 1 })],
    ["route exit 4", route({ routeExitCode: 4 })],
    ["exit 2 with exit 3 reason", route({ routeExitCode: 2 })],
    ["exit 3 with exit 2 reason", route({ reason: "unreadable" })],
    ["unreadable with matches", route({ routeExitCode: 2, reason: "unreadable", matches: [{ label: "repo:other", repoEntry: "other" }] })],
    ["missing with a match", route({ reason: "missing-route-label", matches: [{ label: "repo:other", repoEntry: "other" }] })],
    ["ambiguous with one match", route({ reason: "ambiguous-route-label" })],
    ["changed without a match", route({ matches: [] })],
    ["non-regular path", null, routedPick, (outcomePath) => fs.mkdirSync(outcomePath)],
    ["open failure", null, routedPick, (outcomePath) => {
      fs.writeFileSync(outcomePath, JSON.stringify(route()));
      fs.chmodSync(outcomePath, 0);
    }],
  ];

  for (const [name, value, pick = routedPick, writeOutcome] of cases) {
    const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-untrusted-route-outcome-"));
    const logDir = path.join(anchorPath, "logs");
    const outcomePath = path.join(anchorPath, "outcome.json");
    const child = new EventEmitter();
    child.pid = 503;
    const run = dispatchAsync(anchorPath, "dev", pick.config, {
      ...pick, logDir, outcomePath, runtimeExecutable: "/resolved/codex",
    }, { spawnFn: () => child });
    if (writeOutcome) writeOutcome(outcomePath);
    else fs.writeFileSync(outcomePath, typeof value === "string" ? value : JSON.stringify(value));
    child.emit("close", 0, null);
    const outcome = await run;
    if (name === "open failure") fs.chmodSync(outcomePath, 0o600);
    assert.equal(outcome.kind, "child-outcome-invalid", name);
    assert.equal(outcome.code, "UNTRUSTED_CHILD_OUTCOME", name);
    if (name === "open failure") assert.equal(outcome.reason, "outcome-unreadable");
    assert.notEqual(outcome.kind, "success", name);
    const [batchResult] = await dispatchBatch([{ anchorPath, sweep: "dev", config: pick.config, issueIdentifier: pick.issueIdentifier }], {
      dispatchFn: async () => outcome,
    });
    assert.equal(batchResult.success, false, name);
    const recordName = fs.readdirSync(logDir).find((file) => file.startsWith("run-records-"));
    assert.equal(fs.readFileSync(path.join(logDir, recordName), "utf8").includes("untrusted-route-secret"), false, name);
  }
});

test("child outcome protocol: invalid outcomes cannot enter handoff or same-repo refill predicates", () => {
  const invalidResult = {
    kind: "child-outcome-invalid",
    code: "UNTRUSTED_CHILD_OUTCOME",
    success: true,
    pick: { issueIdentifier: "COD-291" },
  };

  assert.equal(watchModule.isHandoffEligibleResult(invalidResult), false);
  assert.equal(watchModule.isSameRepoRefillEligibleResult(invalidResult), false);
});

test("child outcome protocol: an absent outcome file preserves a successful child exit", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-absent-route-outcome-"));
  const child = new EventEmitter();
  child.pid = 504;
  const run = dispatchAsync(anchorPath, "dev", {}, {
    issueIdentifier: "COD-291",
    logDir: path.join(anchorPath, "logs"),
    outcomePath: path.join(anchorPath, "absent.json"),
    runtimeExecutable: "/resolved/codex",
  }, { spawnFn: () => child, onSpawn: () => true });
  child.emit("close", 0, null);
  const outcome = await run;
  assert.equal(outcome.kind, "success");
});

test("dispatchAsync: child repository outcome prevents a superficially successful handoff", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-route-outcome-"));
  const logDir = path.join(anchorPath, "logs");
  const outcomePath = path.join(anchorPath, "route-outcome.json");
  const child = new EventEmitter();
  child.pid = 503;
  const run = dispatchAsync(anchorPath, "dev", {}, {
    issueIdentifier: "COD-291", issueId: "issue-291", ownerToken: "owner-291",
    logDir, outcomePath, runtimeExecutable: "/resolved/codex",
    childEnv: { AUTO_SWEEP_OUTCOME_PATH: outcomePath },
    repoRoute: { label: "repo:kit", repoEntry: "." },
    config: { repoRouting: { byLabel: { "repo:kit": ".", "repo:other": "other" } } },
  }, { spawnFn: () => child });
  fs.writeFileSync(outcomePath, JSON.stringify({
    version: 1,
    kind: "repo-routing-deferred",
    issueIdentifier: "COD-291",
    routeExitCode: 3,
    routing: { reason: "route-changed", expectedLabel: "repo:kit", expectedRepoEntry: ".", matches: [{ label: "repo:other", repoEntry: "other" }] },
  }));
  child.emit("close", 0, null);
  const outcome = await run;
  assert.equal(outcome.kind, "repo-routing-deferred");
  assert.equal(outcome.code, "REPO_ROUTE_CHANGED");
  assert.equal(outcome.routing.reason, "route-changed");
});
test("runtimeDisabledByOutcome: only executable disappearance disables a runtime lane", () => {
  const base = { path: "/resolved/codex", cwd: "/workspace" };
  const outcomes = [
    classifyDispatchOutcome({ ...base, type: "error", error: { code: "ENOENT" }, cwdExists: true, executableExists: false }),
    classifyDispatchOutcome({ ...base, type: "error", error: { code: "ENOENT" }, cwdExists: false }),
    classifyDispatchOutcome({ ...base, type: "close", exitCode: 127 }),
    classifyDispatchOutcome({ ...base, type: "close", exitCode: null, signal: "SIGTERM" }),
    classifyDispatchOutcome({ ...base, type: "interruption", signal: "SIGINT" }),
    classifyDispatchOutcome({ ...base, type: "close", exitCode: 0 }),
  ];
  assert.deepEqual(outcomes.map(runtimeDisabledByOutcome), [true, false, false, false, false, false]);
});
test("classifyDispatchOutcome: ENOENT with existing executable is a spawn error, not runtime disappearance", () => {
  const outcome = classifyDispatchOutcome({
    type: "error",
    error: { code: "ENOENT" },
    path: "/resolved/script-with-missing-shebang-interpreter",
    cwd: "/workspace",
    cwdExists: true,
    executableExists: true,
  });
  assert.deepEqual(outcome, {
    kind: "spawn-error",
    code: "ENOENT",
    exitCode: null,
    signal: null,
    path: "/resolved/script-with-missing-shebang-interpreter",
    cwd: "/workspace",
  });
  assert.equal(runtimeDisabledByOutcome(outcome), false);
});

// ── ship sweep: config + dispatch priority ───────────────────────────────────
test("dispatch abort context: SIGTERM interrupts active child once and records the typed outcome", async () => {
  const processLike = new EventEmitter();
  const context = createDispatchAbortContext({ processLike });
  assert.equal(processLike.listenerCount("SIGINT"), 1);
  assert.equal(processLike.listenerCount("SIGTERM"), 1);
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-dispatch-abort-"));
  const logDir = path.join(anchorPath, "logs");
  const spawnFn = (executable, args, options) => {
    assert.equal(executable, "/resolved/codex");
    assert.equal(options.signal, context.signal);
    const child = new EventEmitter();
    options.signal.addEventListener("abort", () => {
      setImmediate(() => {
        const error = new Error("The operation was aborted");
        error.code = "ABORT_ERR";
        child.emit("error", error);
        child.emit("close", null, "SIGTERM");
      });
    }, { once: true });
    return child;
  };
  const run = dispatchBatch([{
    anchorPath,
    sweep: "dev",
    config: {},
    issueIdentifier: "COD-9",
    logDir,
    runtimeExecutable: "/resolved/codex",
  }], {
    dispatchFn: dispatchAsync,
    signal: context.signal,
    dispatchOptions: { spawnFn },
  });

  processLike.emit("SIGTERM");
  const [result] = await run;
  assert.equal(result.kind, "interrupted");
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.success, false);
  const recordFile = fs.readdirSync(logDir).find((name) => name.startsWith("run-records-"));
  const recordLines = fs.readFileSync(path.join(logDir, recordFile), "utf8").trim().split("\n");
  assert.equal(recordLines.length, 1);
  const record = JSON.parse(recordLines[0]);
  assert.equal(record.outcome.kind, "interrupted");
  assert.equal(record.outcome.signal, "SIGTERM");

  context.dispose();
  assert.equal(processLike.listenerCount("SIGINT"), 0);
  assert.equal(processLike.listenerCount("SIGTERM"), 0);
});
test("capacity ledger: dispatch attaches the live child PID immediately after spawn", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-dispatch-pid-"));
  const attached = [];
  const child = new EventEmitter();
  child.pid = 456;
  const run = dispatchAsync(anchorPath, "dev", {}, {
    issueIdentifier: "COD-10",
    logDir: path.join(anchorPath, "logs"),
    runtimeExecutable: "/resolved/codex",
  }, {
    spawnFn: () => child,
    onSpawn: (pid) => attached.push(pid),
  });
  assert.deepEqual(attached, [456]);
  child.emit("close", 0, null);
  assert.equal((await run).kind, "success");
});
test("run records: optional queue, capacity, trigger, runtime, and host metrics are additive", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-dispatch-telemetry-"));
  const logDir = path.join(anchorPath, "logs");
  const child = new EventEmitter();
  child.pid = 456;
  const run = dispatchAsync(anchorPath, "dev", {}, {
    issueIdentifier: "COD-12",
    logDir,
    runtimeExecutable: "/resolved/codex",
    trigger: "handoff",
    telemetry: {
      firstObservedActionableAt: "2026-07-09T11:59:00.000Z",
      claimAt: "2026-07-09T12:00:00.000Z",
      queueWaitMs: 60_000,
      capacitySlot: 3,
      capacityHighWater: 7,
    },
    dependencyDeferredCount: 2,
    dependencyDeferredIssues: [{
      sourceWorkspace: "/source/app",
      sweep: "spec",
      issueIdentifier: "COD-90",
      reason: "blocked",
      blockers: [{ identifier: "COD-80", stateName: "QA" }],
    }],
    resourceSampler: {
      snapshot: () => ({
        loadAverage1m: { start: 1, end: 2, max: 4 },
        freeMemoryBytes: { start: 800, end: 600, min: 400 },
        totalMemoryBytes: 1_000,
        memoryPressureAvailablePercent: { start: 50, end: 40, min: 30 },
        metricsUnavailable: [],
      }),
    },
  }, { spawnFn: () => child });
  child.emit("close", 0, null);
  assert.equal((await run).kind, "success");

  const recordFile = fs.readdirSync(logDir).find((name) => name.startsWith("run-records-"));
  const record = JSON.parse(fs.readFileSync(path.join(logDir, recordFile), "utf8").trim());
  assert.equal(record.firstObservedActionableAt, "2026-07-09T11:59:00.000Z");
  assert.equal(record.queueWaitMs, 60_000);
  assert.equal(record.capacityHighWater, 7);
  assert.equal(record.trigger, "handoff");
  assert.equal(record.resolvedRuntimeExecutable, "/resolved/codex");
  assert.deepEqual(record.freeMemoryBytes, { start: 800, end: 600, min: 400 });
  assert.deepEqual(record.memoryPressureAvailablePercent, { start: 50, end: 40, min: 30 });
  assert.deepEqual(record.metricsUnavailable, []);
  assert.equal(record.dependencyDeferredCount, 2);
  assert.deepEqual(record.dependencyDeferredIssues, [{
    sourceWorkspace: "/source/app",
    sweep: "spec",
    issueIdentifier: "COD-90",
    reason: "blocked",
    blockers: [{ identifier: "COD-80", stateName: "QA" }],
  }]);
  assert.equal(Object.hasOwn(record, "dependencyBlockers"), false);
});
test("run records: sampler failure does not change child success", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-dispatch-metrics-gap-"));
  const logDir = path.join(anchorPath, "logs");
  const child = new EventEmitter();
  let completionSamples = 0;
  const run = dispatchAsync(anchorPath, "qa", {}, {
    issueIdentifier: "COD-13", logDir, runtimeExecutable: "/resolved/codex",
    resourceSampler: {
      sample: () => { completionSamples += 1; },
      snapshot: () => ({ metricsUnavailable: ["host metrics denied"] }),
    },
  }, { spawnFn: () => child });
  child.emit("close", 0, null);
  assert.equal((await run).kind, "success");
  const recordFile = fs.readdirSync(logDir).find((name) => name.startsWith("run-records-"));
  const record = JSON.parse(fs.readFileSync(path.join(logDir, recordFile), "utf8").trim());
  assert.deepEqual(record.metricsUnavailable, ["host metrics denied"]);
  assert.equal(record.outcome.kind, "success");
  assert.equal(completionSamples, 1);
});
test("capacity ledger: PID attachment failure terminates child and retains token until close", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-dispatch-attach-failure-"));
  let stored = null;
  const child = new EventEmitter();
  child.pid = 789;
  child.killCalls = [];
  child.kill = (signal) => { child.killCalls.push(signal); return true; };
  const ledger = createCapacityLedger({
    maxActiveChildren: 1,
    readJsonFn: () => stored,
    writeJsonFn: (_path, value) => { stored = structuredClone(value); },
    isAlive: () => true,
    randomUUID: () => "attach-token",
  });
  const queue = createAdmissionQueue({
    ledger,
    executeDemand: async (_demand, reservation) => dispatchAsync(anchorPath, "dev", {}, {
      issueIdentifier: "COD-11", logDir: path.join(anchorPath, "logs"), runtimeExecutable: "/resolved/codex",
    }, {
      spawnFn: () => child,
      onSpawn: () => { throw new Error("ledger write failed"); },
    }),
  });

  let settled = false;
  const run = admitDemand({ stage: "dev", trigger: "initial", issueIdentifier: "COD-11", workspace: "/managed" }, { queue })
    .then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.equal(settled, false);
  assert.equal(stored.entries.length, 1);

  child.emit("close", null, "SIGTERM");
  const result = await run;
  assert.equal(result.kind, "spawn-error");
  assert.equal(result.code, "CAPACITY_ATTACH_FAILED");
  assert.deepEqual(stored, { version: 1, entries: [] });
});

test("SWEEP_CFG.ship exists and the derived lists include it", () => {
  assert.deepEqual(SWEEP_CFG.ship.states, ["Ship"]);
  assert.equal(SWEEP_CFG.ship.claim, "ship:in-progress");
  assert.ok(SWEEP_CFG.ship.blocked.includes("blocked:needs-user")); // parked cards aren't re-dispatched
  assert.equal(SWEEP_CFG.ship.staleMin, 120);
  assert.ok(SWEEPS.includes("ship"));
  assert.ok(SKILL_DIRS.includes("ship-sweep")); // auto-updater propagates the new skill
});
test("SWEEP_CFG: every scheduled sweep treats manual-only cards as blocked", () => {
  for (const sweep of SWEEPS) assert.ok(SWEEP_CFG[sweep].blocked.includes("sweep:manual-only"), `${sweep} missing manual-only blocker`);
});
test("manual operator skills propagate but are never scheduled", () => {
  assert.deepEqual(MANUAL_SKILL_DIRS, ["unblock-sweep", "manual-sweep"]);
  assert.ok(PROPAGATED_SKILL_DIRS.includes("unblock-sweep"));
  assert.ok(!SWEEPS.includes("unblock"));
  assert.ok(!SKILL_DIRS.includes("unblock-sweep"));
});
test("selectDispatch: ship is dispatched before qa/dev/spec (most-downstream first)", () => {
  const pick = selectDispatch([
    { sweep: "spec", count: 5, topCard: { sortOrder: 1 } },
    { sweep: "qa", count: 4, topCard: { sortOrder: 1 } },
    { sweep: "ship", count: 1, topCard: { sortOrder: -999 } }, // lowest rank, fewest — still wins on stage
    { sweep: "dev", count: 3, topCard: { sortOrder: 1 } },
  ]);
  assert.equal(pick.sweep, "ship");
  assert.equal(SWEEP_ORDER[0], "ship");
});
test("selectDispatchBatch: ship coexists with non-ship stages and does not consume their limit", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/ws/a", config: { repos: ["a"] }, sweep: "dev", count: 5, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/a", config: { repos: ["a"] }, sweep: "ship", count: 1, oldestUpdatedAt: 999 },
    { anchorPath: "/ws/b", config: { repos: ["b"] }, sweep: "ship", count: 1, oldestUpdatedAt: 999 },
    { anchorPath: "/ws/c", config: { repos: ["c"] }, sweep: "qa", count: 5, oldestUpdatedAt: 1 },
  ], { maxNonShipDispatches: 2 });
  assert.deepEqual(batch.map((candidate) => `${candidate.anchorPath}:${candidate.sweep}`), [
    "/ws/a:ship",
    "/ws/b:ship",
    "/ws/c:qa",
    "/ws/a:dev",
  ]);
});
test("selectDispatchBatch: selects at most one Ship per registered source workspace", () => {
  const batch = selectDispatchBatch([
    { sourceAnchorPath: "/registered/a", anchorPath: "/managed/a", config: { repos: ["a"] }, sweep: "ship", count: 1 },
    { sourceAnchorPath: "/registered/a", anchorPath: "/managed/a", config: { repos: ["a"] }, sweep: "ship", count: 1 },
    { sourceAnchorPath: "/registered/b", anchorPath: "/managed/b", config: { repos: ["b"] }, sweep: "ship", count: 1 },
  ], { maxNonShipDispatches: 1 });
  assert.deepEqual(batch.map((candidate) => candidate.sourceAnchorPath), [
    "/registered/a",
    "/registered/b",
  ]);
});
test("selectDispatchBatch: Ship preserves cross-workspace repository collision safety", () => {
  const batch = selectDispatchBatch([
    { sourceAnchorPath: "/registered/a", anchorPath: "/managed/a", managedRepoPaths: ["/managed/shared"], config: {}, sweep: "ship", count: 1 },
    { sourceAnchorPath: "/registered/b", anchorPath: "/managed/b", managedRepoPaths: ["/managed/shared"], config: {}, sweep: "dev", count: 1 },
    { sourceAnchorPath: "/registered/c", anchorPath: "/managed/c", managedRepoPaths: ["/managed/other"], config: {}, sweep: "spec", count: 1 },
  ], { maxNonShipDispatches: 2 });
  assert.deepEqual(batch.map((candidate) => `${candidate.sourceAnchorPath}:${candidate.sweep}`), [
    "/registered/a:ship",
    "/registered/c:spec",
  ]);
});

// ── foreign / orphaned-claim reaper ──────────────────────────────────────────
test("foreignClaimReleases: releases a stale orphaned claim; a fresh heartbeat is spared", () => {
  const stale = { id: "s", identifier: "COD-7", updatedAt: minsAgo(300), labelNames: ["qa:in-progress"], commentsComplete: true, comments: [] };
  const fresh = { id: "f", identifier: "COD-8", updatedAt: minsAgo(1), labelNames: ["qa:in-progress"],
    commentsComplete: true,
    comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)}]`, createdAt: minsAgo(1) }] };
  const d = foreignClaimReleases([stale, fresh], NOW);
  assert.equal(d.length, 1);
  assert.equal(d[0].id, "s");
  assert.deepEqual(d[0].releaseClaims, ["qa:in-progress"]);
  assert.equal(d[0].action, "reap-orphan");
});
test("foreignClaimReleases: batches TWO stale claims on one card into a single decision (no clobber)", () => {
  // The bug the batching fixes: releasing per-claim with full-set overwrites
  // re-added an earlier removal. One decision → one write → both cleared.
  const card = { id: "m", identifier: "COD-10", updatedAt: minsAgo(300), labelNames: ["qa:in-progress", "ship:in-progress"], commentsComplete: true, comments: [] };
  const d = foreignClaimReleases([card], NOW);
  assert.equal(d.length, 1);
  assert.deepEqual([...d[0].releaseClaims].sort(), ["qa:in-progress", "ship:in-progress"]);
});
test("foreignClaimReleases: excludes ownClaim so the sweep's own reaper (with escalation) handles it", () => {
  const card = { id: "o", identifier: "COD-11", updatedAt: minsAgo(300), labelNames: ["qa:in-progress", "ship:in-progress"], commentsComplete: true, comments: [] };
  const d = foreignClaimReleases([card], NOW, "qa:in-progress"); // processing the qa sweep's QA cards
  assert.deepEqual(d[0].releaseClaims, ["ship:in-progress"]); // only the foreign ship claim, not qa's own
});
test("foreignClaimReleases: an unclaimed card is ignored; holding-state constants sane", () => {
  const card = { id: "u", identifier: "COD-9", updatedAt: minsAgo(300), labelNames: [], commentsComplete: true, comments: [] };
  assert.deepEqual(foreignClaimReleases([card], NOW), []);
  assert.deepEqual(HOLDING_STATES, ["Signoff"]); // the state qa lands in but no sweep fetches
  assert.deepEqual(LEGACY_CLEANUP_STATES, ["In Progress"]); // retired dev state still gets orphan cleanup
  assert.deepEqual(CLAIM_CLEANUP_STATES, ["Signoff", "In Progress"]);
  assert.equal(MAX_STALE_MIN, 120);
});
test("foreignClaimReleases: stale dev claim in legacy In Progress is released by cleanup pass", () => {
  const card = { id: "legacy", identifier: "COD-99", state: { name: "In Progress" }, updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], commentsComplete: true, comments: [] };
  const d = foreignClaimReleases([card], NOW);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].releaseClaims, ["dev:in-progress"]);
});

test("foreignClaimReleases: a stale stranded label after an exact close is cleanup-ready", () => {
  const card = { id: "closed", identifier: "COD-169", updatedAt: minsAgo(1), labelNames: ["qa:in-progress"], commentsComplete: true, comments: [
    { id: "c1", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "owner", declarationId: "decl" }), createdAt: minsAgo(300) },
    { id: "c2", body: claimCloseMarker({ claim: "qa:in-progress", declarationId: "decl", reason: "released" }), createdAt: minsAgo(200) },
  ] };
  const [decision] = foreignClaimReleases([card], NOW);
  assert.deepEqual(decision.releases, [{ claim: "qa:in-progress", target: "legacy", staleMin: 120 }]);
});

test("executeOrphanReap: a newer declaration during a multi-claim reset removes no labels", async () => {
  assert.equal(typeof watchModule.executeOrphanReap, "function");
  const comments = [
    { id: "c1", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "qa-old", declarationId: "qa-old-decl" }), createdAt: minsAgo(300) },
    { id: "c2", body: claimDeclarationMarker({ claim: "ship:in-progress", ownerToken: "ship-old", declarationId: "ship-old-decl" }), createdAt: minsAgo(300) },
  ];
  const original = { id: "race", identifier: "COD-169", updatedAt: minsAgo(300), labelIds: { "qa:in-progress": "qa-label", "ship:in-progress": "ship-label" }, labelNames: ["qa:in-progress", "ship:in-progress"], commentsComplete: true, comments: [...comments] };
  let reads = 0;
  let removals = 0;
  const fetched = () => ({ ...original, labelIds: { ...original.labelIds }, labelNames: [...original.labelNames], commentsComplete: true, comments: [...comments] });
  const released = await watchModule.executeOrphanReap("key", original, {
    releaseClaims: ["qa:in-progress", "ship:in-progress"],
    releases: [
      { claim: "qa:in-progress", target: "qa-old-decl", staleMin: 120 },
      { claim: "ship:in-progress", target: "ship-old-decl", staleMin: 120 },
    ],
  }, NOW, {
    fetchClaimCardFn: async () => {
      reads += 1;
      if (reads === 5) comments.push({ id: "c-new", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "qa-new", declarationId: "qa-new-decl" }), createdAt: minsAgo(0) });
      return fetched();
    },
    addCommentFn: async (_key, _id, body) => comments.push({ id: `reset-${comments.length}`, body, createdAt: minsAgo(1) }),
    applyLabelEditFn: async () => { removals += 1; },
    addAuditCommentFn: async () => {},
  });
  assert.equal(released, false);
  assert.equal(removals, 0);
  assert.deepEqual(original.labelNames, ["qa:in-progress", "ship:in-progress"]);
});

test("executeOrphanReap: confirmed cleanup synchronizes the scheduler card before same-tick claim admission", async () => {
  const comments = [
    { id: "c1", body: claimDeclarationMarker({ claim: "qa:in-progress", ownerToken: "qa-old", declarationId: "qa-old-decl" }), createdAt: minsAgo(300) },
  ];
  const original = dependencyReadyCard({ id: "sync", identifier: "COD-170", stateName: "Dev", updatedAt: minsAgo(300), sortOrder: 1, labelIds: { "qa:in-progress": "qa-label", "feature": "feature-label" }, labelNames: ["qa:in-progress", "feature"], commentsComplete: true, comments: [...comments] });
  const fetched = () => ({ ...original, labelIds: { "qa:in-progress": "qa-label", "feature": "feature-label" }, labelNames: ["qa:in-progress", "feature"], commentsComplete: true, comments: [...comments] });
  const released = await watchModule.executeOrphanReap("key", original, {
    releaseClaims: ["qa:in-progress"], releases: [{ claim: "qa:in-progress", target: "qa-old-decl", staleMin: 120 }],
  }, NOW, {
    fetchClaimCardFn: async () => fetched(),
    addCommentFn: async (_key, _id, body) => comments.push({ id: `reset-${comments.length}`, body, createdAt: minsAgo(1) }),
    applyLabelEditFn: async (_key, card, edit) => {
      for (const claim of edit.remove) delete card.labelIds[claim];
      card.labelNames = Object.keys(card.labelIds);
    },
    addAuditCommentFn: async () => {},
  });
  assert.equal(released, true);
  assert.deepEqual(original.labelIds, { feature: "feature-label" });
  assert.deepEqual(original.labelNames, ["feature"]);
  let claimedLabelIds = [];
  const claimed = await claimCardSlots("key", "/managed", {}, "dev", [original], {
    parentRunId: "same-tick", limit: 1, labelMap: { "dev:in-progress": "dev-label" }, now: NOW,
  }, {
    declarationTokenFn: () => "dev-decl",
    fetchClaimCardFn: async () => ({ ...original, labelIds: { ...original.labelIds }, labelNames: [...original.labelNames], commentsComplete: true, comments: [...comments] }),
    addCommentFn: async (_key, _id, body) => comments.push({ id: `claim-${comments.length}`, body, createdAt: minsAgo(0) }),
    applyLabelEditFn: async (_key, card, edit) => {
      for (const claim of edit.remove || []) delete card.labelIds[claim];
      for (const [name, id] of Object.entries(edit.add || {})) card.labelIds[name] = id;
      card.labelNames = Object.keys(card.labelIds);
      original.labelIds = { ...card.labelIds };
      original.labelNames = [...card.labelNames];
      if (edit.add) claimedLabelIds = Object.values(card.labelIds).sort();
    },
    sleepFn: async () => {},
    fetchCardFn: async () => ({ ...original, labelIds: { ...original.labelIds }, labelNames: [...original.labelNames], commentsComplete: true, comments: [...comments] }),
  });
  assert.equal(claimed.length, 1);
  assert.deepEqual(claimedLabelIds, ["dev-label", "feature-label"]);
});

// ── env parsing ──────────────────────────────────────────────────────────────
test("parseEnv: strips quotes, ignores comments/blanks", () => {
  const e = parseEnv('# c\nLINEAR_API_KEY="lin_api_x"\nFOO=bar\n\n');
  assert.equal(e.LINEAR_API_KEY, "lin_api_x");
  assert.equal(e.FOO, "bar");
});

// ── manual unblock workflow helpers ─────────────────────────────────────────
test("orderUnblockCards: keeps pipeline states downstream-first and oldest-first within a state", () => {
  const cards = [
    { identifier: "SPEC", state: "Spec", updatedAt: "2026-07-01T00:00:00Z" },
    { identifier: "BACKLOG", state: "Backlog", updatedAt: "2026-06-01T00:00:00Z" },
    { identifier: "SIGNOFF-NEW", state: "Signoff", updatedAt: "2026-07-04T00:00:00Z" },
    { identifier: "DEV", state: "Dev", updatedAt: "2026-07-02T00:00:00Z" },
    { identifier: "QA", state: "QA", updatedAt: "2026-07-03T00:00:00Z" },
    { identifier: "SIGNOFF-OLD", state: "Signoff", updatedAt: "2026-07-01T00:00:00Z" },
    { identifier: "SHIP", state: "Ship", updatedAt: "2026-05-01T00:00:00Z" },
    { identifier: "UNKNOWN", state: "Custom", updatedAt: "2026-04-01T00:00:00Z" },
  ];

  assert.deepEqual(UNBLOCK_STATE_ORDER, ["Signoff", "QA", "Dev", "Spec"]);
  assert.deepEqual(
    orderUnblockCards(cards).map((card) => card.identifier),
    ["SIGNOFF-OLD", "SIGNOFF-NEW", "QA", "DEV", "SPEC"],
  );
  assert.deepEqual(cards.map((card) => card.identifier), [
    "SPEC", "BACKLOG", "SIGNOFF-NEW", "DEV", "QA", "SIGNOFF-OLD", "SHIP", "UNKNOWN",
  ]);
});
test("unblock ordering includes only capped generated Done cards after normal states", () => {
  const cards = [
    { identifier: "DONE-GENERATED", state: "Done", updatedAt: "2026-07-01T00:00:00Z", labelNames: ["factory:learning-generated", "blocked:needs-user"] },
    { identifier: "DONE-PLAIN", state: "Done", updatedAt: "2026-07-01T00:00:00Z", labelNames: ["blocked:needs-user"] },
    { identifier: "SPEC", state: "Spec", updatedAt: "2026-07-01T00:00:00Z", labelNames: ["blocked:needs-user"] },
  ];
  assert.deepEqual(orderUnblockCards(cards).map((card) => card.identifier), ["SPEC", "DONE-GENERATED"]);
});
test("blockingLabelsForIssue: detects only unblockable blocking labels", () => {
  assert.deepEqual(BLOCKING_LABELS, ["blocked:open-questions", "blocked:needs-user", "qa:needs-changes", "sweep:manual-only"]);
  const labels = ["Feature", "blocked:needs-user", "qa:passed", "qa:needs-changes", "sweep:manual-only"];
  assert.deepEqual(blockingLabelsForIssue(labels), ["blocked:needs-user", "qa:needs-changes", "sweep:manual-only"]);
});
test("normalizeBlockedIssue: captures anchor, active state, issue context, and newest blocking comment", () => {
  const issue = {
    id: "issue-id",
    identifier: "COD-9",
    title: "Blocked card",
    url: "https://linear.app/x/COD-9",
    updatedAt: "2026-07-08T10:00:00Z",
    state: { name: "Dev" },
    labels: { nodes: [{ id: "l1", name: "blocked:open-questions" }, { id: "l2", name: "cli" }] },
    comments: { nodes: [
      { body: "older note", createdAt: "2026-07-08T09:00:00Z", user: { name: "A" } },
      { body: "Need API key before continuing", createdAt: "2026-07-08T10:01:00Z", user: { name: "B" } },
    ] },
  };
  const normalized = normalizeBlockedIssue("/repo", { project: "Linear Sweep", projectId: "p1" }, issue, { active: false });
  assert.equal(normalized.anchorPath, "/repo");
  assert.equal(normalized.project, "Linear Sweep");
  assert.equal(normalized.projectActive, false);
  assert.equal(normalized.identifier, "COD-9");
  assert.deepEqual(normalized.blockingLabels, ["blocked:open-questions"]);
  assert.equal(normalized.newestBlockingComment.body, "Need API key before continuing");
  assert.deepEqual(Object.keys(normalized.labelIds).sort(), ["blocked:open-questions", "cli"]);
});
test("labelIdsAfterRemoving: removes selected blockers and preserves unrelated labels", () => {
  const next = labelIdsAfterRemoving(
    { "blocked:needs-user": "blocked-id", "qa:needs-changes": "qa-id", cli: "cli-id" },
    ["blocked:needs-user"]
  );
  assert.deepEqual(next, ["qa-id", "cli-id"]);
});
test("buildUnblockAuditComment: records resolution and selected labels without leaking secrets", () => {
  const body = buildUnblockAuditComment({
    labels: ["blocked:needs-user"],
    resolution: "User confirmed the token was provisioned in the dashboard.",
  });
  assert.match(body, /unblock-sweep resolution/);
  assert.match(body, /blocked:needs-user/);
  assert.match(body, /token was provisioned/);
  assert.doesNotMatch(body, /lin_api_/);
});
test("resolutionTextFromArgs: supports stdin so resolution text is not shell-interpreted", () => {
  assert.equal(resolutionTextFromArgs(["--stdin"], "Resolved with `quoted`; text"), "Resolved with `quoted`; text");
  assert.equal(resolutionTextFromArgs(["plain", "text"], ""), "plain text");
});
test("resolveBlockedIssue: comments first, removes selected blockers, and preserves other labels", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.query.includes("issue(id:$id)")) {
      return { json: async () => ({ data: { issue: {
        id: "issue-id",
        identifier: "COD-1",
        team: { key: "COD" },
        project: { id: "project-id" },
        labels: { nodes: [
          { id: "blocked-id", name: "blocked:needs-user" },
          { id: "qa-id", name: "qa:needs-changes" },
          { id: "cli-id", name: "cli" },
        ] },
      } } }) };
    }
    if (body.query.includes("commentCreate")) return { json: async () => ({ data: { commentCreate: { success: true } } }) };
    if (body.query.includes("issueUpdate")) return { json: async () => ({ data: { issueUpdate: { success: true } } }) };
    throw new Error(`unexpected query: ${body.query}`);
  };
  try {
    const result = await resolveBlockedIssue("lin_api_test", "COD-1", ["blocked:needs-user"], "Token provisioned", { teamKey: "COD", projectId: "project-id" });
    assert.deepEqual(result, { identifier: "COD-1", removedLabels: ["blocked:needs-user"] });
    assert.ok(calls[1].query.includes("commentCreate"));
    assert.ok(calls[2].query.includes("issueUpdate"));
    assert.deepEqual(calls[2].variables.ids, ["qa-id", "cli-id"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("resolveBlockedIssue: rejects issues outside the anchor team/project before mutating", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return { json: async () => ({ data: { issue: {
      id: "issue-id",
      identifier: "OTHER-1",
      team: { key: "OTHER" },
      project: { id: "other-project" },
      labels: { nodes: [{ id: "blocked-id", name: "blocked:needs-user" }] },
    } } }) };
  };
  try {
    await assert.rejects(
      resolveBlockedIssue("lin_api_test", "OTHER-1", ["blocked:needs-user"], "Done", { teamKey: "COD", projectId: "project-id" }),
      /outside configured anchor/
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── scheduled failure Todo reconciliation ───────────────────────────────────
const failureEvent = (over = {}) => ({
  anchorPath: "/ws/linear-board-sweeps",
  anchorSlug: "linear-board-sweeps",
  projectId: "project-1",
  scope: "dev",
  kind: "dispatch-start",
  stableTarget: "codex",
  message: `spawn codex ENOENT ${["lin", "api", "secret"].join("_")}`,
  seenAt: "2026-07-08T12:00:00Z",
  ...over,
});
const existingFailureTodo = (fingerprint, over = {}) => ({
  id: over.id || "todo-1",
  identifier: over.identifier || "COD-100",
  updatedAt: over.updatedAt || hoursAgo(2),
  scope: over.scope || "dev",
  lastMessage: over.lastMessage || "spawn codex ENOENT [REDACTED]",
  description: `${FAILURE_TODO_TAG} ${fingerprint}]`,
  comments: over.comments || [],
  ...over,
});

test("failureFingerprint: stable same input, different target differs", () => {
  const a = failureFingerprint(failureEvent());
  const b = failureFingerprint(failureEvent({ message: "different volatile error" }));
  const c = failureFingerprint(failureEvent({ stableTarget: "claude" }));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{16}$/);
});
test("sanitizeFailureMessage: strips credentials embedded in Git remote URLs", () => {
  const githubSecret = ["ghp", "supersecret"].join("_");
  const credentialedHttpUrl = "https://oauth2" + ":" + githubSecret + "@" + "github.com/acme/repo.git";
  const credentialedSshUrl = "ssh://token" + "@" + "host/repo";
  const sanitized = sanitizeFailureMessage(`fetch ${credentialedHttpUrl} failed; ${credentialedSshUrl}`);
  assert.equal(sanitized.includes(githubSecret), false);
  assert.equal(sanitized.includes("oauth2:"), false);
  assert.equal(sanitized.includes("token@"), false);
  assert.match(sanitized, /https:\/\/\[REDACTED\]@github\.com/);
});

test("update failures attach by source anchor and only healthy anchors recover update scope", () => {
  assert.equal(typeof watchModule.attachUpdateFailuresToAnchors, "function");
  const a = { anchorPath: "/managed/a", sourceAnchorPath: "/source/a", config: { projectId: "p" }, failures: [], checkedScopes: new Set() };
  const b = { anchorPath: "/managed/b", sourceAnchorPath: "/source/b", config: { projectId: "p" }, failures: [], checkedScopes: new Set() };
  const local = [];
  watchModule.attachUpdateFailuresToAnchors([a, b], [{ anchorPath: "/source/a", scope: "update", kind: "skills-refresh", stableTarget: "v2", message: "push failed" }], {
    eventFor: (active, failure) => ({ ...failure, anchorPath: active.anchorPath, projectId: active.config.projectId }),
    onUnmapped: (failure) => local.push(failure),
    markRecovered: true,
  });
  assert.equal(a.failures.length, 1);
  assert.equal(a.failures[0].anchorPath, "/managed/a");
  assert.equal(a.checkedScopes.has("update"), false);
  assert.equal(b.checkedScopes.has("update"), true);
  assert.deepEqual(local, []);
});
test("a global updater failure prevents every anchor from claiming update recovery", () => {
  const anchors = ["a", "b"].map((name) => ({
    anchorPath: `/managed/${name}`, sourceAnchorPath: `/source/${name}`, config: {}, failures: [], checkedScopes: new Set(),
  }));
  const unmapped = [];
  watchModule.attachUpdateFailuresToAnchors(anchors, [{ anchorPath: null, scope: "update", kind: "kit-fetch", stableTarget: "/kit", message: "fetch failed" }], {
    eventFor: () => assert.fail("global update failure has no single anchor"),
    onUnmapped: (failure) => unmapped.push(failure),
    markRecovered: true,
  });
  assert.equal(anchors.some((active) => active.checkedScopes.has("update")), false);
  assert.equal(unmapped.length, 1);
});

test("dependency read anomalies become one dependent-scoped diagnostic instead of four sweep failures", () => {
  assert.equal(typeof watchModule.dependencyReadFailureEvents, "function");
  const error = Object.assign(new Error("inverseRelations pageInfo missing for COD-42"), {
    code: "DEPENDENCY_READ_UNAVAILABLE",
    issueIdentifier: "COD-42",
    relationId: "inverseRelations",
  });
  const events = watchModule.dependencyReadFailureEvents(error, {
    anchorPath: "/managed/app", projectId: "p", seenAt: "2026-07-09T00:00:00.000Z",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].scope, "dependency:COD-42");
  assert.equal(events[0].stableTarget, "COD-42:inverseRelations");
  assert.equal(events[0].kind, "dependency-read");
});
test("runtime recovery targets: a healthy anchor cannot close another anchor's shared-project Todo", () => {
  const ready = preflightRuntimeCandidates([
    { sourceAnchorPath: "/src/a/app", anchorPath: "/managed/a/app", sweep: "dev", config: { projectId: "shared" } },
    { sourceAnchorPath: "/src/b/app", anchorPath: "/managed/b/app", sweep: "dev", config: { projectId: "shared" } },
  ], {
    host: "builder-1",
    envForCandidate: () => ({}),
    resolveFn: (runtime) => ({ ok: true, runtime, path: "/opt/bin/codex", source: "path" }),
  }).ready;
  assert.equal(ready[0].runtimeStableTarget, JSON.stringify({ sourceAnchorPath: "/src/a/app", runtime: "codex", host: "builder-1" }));
  assert.equal(ready[1].runtimeStableTarget, JSON.stringify({ sourceAnchorPath: "/src/b/app", runtime: "codex", host: "builder-1" }));

  const todos = ready.map((pick, index) => {
    const event = failureEvent({
      anchorPath: pick.anchorPath,
      anchorSlug: "app",
      projectId: "shared",
      scope: pick.runtimeScope,
      kind: "runtime-missing",
      stableTarget: pick.runtimeStableTarget,
    });
    const fingerprint = failureFingerprint(event);
    return existingFailureTodo(fingerprint, {
      id: `todo-${index}`,
      scope: pick.runtimeScope,
      description: failureTodoBody(event, fingerprint),
    });
  });
  const decisions = failureTodoDecisions([], todos, new Set(), NOW, {
    recoveredTargets: new Set([ready[0].runtimeStableTarget]),
  });
  assert.deepEqual(decisions.map((decision) => decision.todo.id), ["todo-0"]);
});
test("sanitizeFailureMessage: redacts Linear keys, common tokens, and supplied env values", () => {
  const linearSecret = ["lin", "api", "abc123"].join("_");
  const githubSecret = ["ghp", "deadbeef"].join("_");
  const msg = `LINEAR_API_KEY=${linearSecret} token ${githubSecret} password shh path /tmp`;
  const clean = sanitizeFailureMessage(msg, ["shh"]);
  assert.equal(clean.includes(linearSecret), false);
  assert.equal(clean.includes(githubSecret), false);
  assert.equal(clean.includes("shh"), false);
  assert.match(clean, /\[REDACTED\]/);
});
test("failure Todo helpers include action, recovery condition, marker, and sanitized message", () => {
  const event = failureEvent();
  const fp = failureFingerprint(event);
  assert.equal(failureTodoTitle(event), "Scheduled sweep failure: linear-board-sweeps / dev / dispatch-start");
  const envSecret = "local-test-secret";
  const body = failureTodoBody(event, fp, { envValues: [envSecret] });
  assert.match(body, /What failed:/);
  assert.match(body, /How to clear:/);
  assert.match(body, /Recovery condition:/);
  assert.match(body, new RegExp(`\\${FAILURE_TODO_TAG} ${fp}\\]`));
  assert.equal(body.includes(envSecret), false);
  assert.match(failureTodoBody(event, fp, { firstSeen: "2026-07-08T00:00:00Z" }), /First seen: 2026-07-08T00:00:00Z/);
});
test("failureTodoDecisions: creates a missing Todo and suppresses duplicate creates", () => {
  const event = failureEvent();
  const fp = failureFingerprint(event);
  const first = failureTodoDecisions([event], [], new Set(["dev"]), NOW);
  assert.equal(first.length, 1);
  assert.equal(first[0].action, "create");
  assert.equal(first[0].fingerprint, fp);

  const second = failureTodoDecisions([event], [existingFailureTodo(fp)], new Set(["dev"]), NOW);
  assert.deepEqual(second, []);
});
test("failureTodoDecisions: updates changed messages and throttles unchanged messages", () => {
  const event = failureEvent({ message: "new failure text" });
  const fp = failureFingerprint(event);
  const changed = failureTodoDecisions([event], [existingFailureTodo(fp, { lastMessage: "old failure text", updatedAt: minsAgo(10) })], new Set(["dev"]), NOW);
  assert.equal(changed[0].action, "update");

  const unchangedSoon = failureTodoDecisions([event], [existingFailureTodo(fp, { lastMessage: "new failure text", updatedAt: minsAgo(10) })], new Set(["dev"]), NOW);
  assert.deepEqual(unchangedSoon, []);

  const unchangedOld = failureTodoDecisions([event], [existingFailureTodo(fp, { lastMessage: "new failure text", updatedAt: hoursAgo(26) })], new Set(["dev"]), NOW);
  assert.equal(unchangedOld[0].action, "update");
});
test("failureTodoDecisions: unchanged multiline messages are throttled", () => {
  const event = failureEvent({ message: "first line\nsecond line" });
  const fp = failureFingerprint(event);
  const todo = existingFailureTodo(fp, {
    lastMessage: undefined,
    updatedAt: minsAgo(10),
    description: failureTodoBody(event, fp),
  });
  assert.deepEqual(failureTodoDecisions([event], [todo], new Set(["dev"]), NOW), []);
});
test("failureTodoDecisions: only closes recovered Todos for checked scopes", () => {
  const fp = failureFingerprint(failureEvent());
  const unchecked = failureTodoDecisions([], [existingFailureTodo(fp, { scope: "dev" })], new Set(["qa"]), NOW);
  assert.deepEqual(unchecked, []);

  const checked = failureTodoDecisions([], [existingFailureTodo(fp, { scope: "dev" })], new Set(["dev"]), NOW);
  assert.equal(checked[0].action, "close");
});
test("failureTodoDecisions: repository routing failures dedupe and self-close on the matching stage scope", () => {
  const event = failureEvent({ scope: "qa:routing", kind: "repo-routing", stableTarget: "SAF-200", message: "SAF-200 expected exactly one of app:admin" });
  const fp = failureFingerprint(event);
  assert.deepEqual(failureTodoDecisions([event, event], [], new Set(["qa:routing"]), NOW).map((decision) => decision.action), ["create"]);
  const todo = existingFailureTodo(fp, { scope: "qa:routing", description: failureTodoBody(event, fp) });
  assert.deepEqual(failureTodoDecisions([], [todo], new Set(["dev:routing"]), NOW), []);
  assert.equal(failureTodoDecisions([], [todo], new Set(["qa:routing"]), NOW)[0].action, "close");
});
test("failureTodoDecisions: dispatch failures recover only after dispatch succeeds", () => {
  const event = failureEvent({ scope: "dev:dispatch" });
  const fp = failureFingerprint(event);
  const cheapCheck = failureTodoDecisions([], [existingFailureTodo(fp, { scope: "dev:dispatch" })], new Set(["dev"]), NOW);
  assert.deepEqual(cheapCheck, []);

  const dispatchCheck = failureTodoDecisions([], [existingFailureTodo(fp, { scope: "dev:dispatch" })], new Set(["dev:dispatch"]), NOW);
  assert.equal(dispatchCheck[0].action, "close");
});
test("failureTodoDecisions: dirty-checkout Todos recover when the stable target is clean even if dispatch scope was not selected", () => {
  const event = failureEvent({ scope: "dev:dispatch", kind: "dirty-checkout", stableTarget: "managed-anchor:/managed/app" });
  const fp = failureFingerprint(event);
  const todo = existingFailureTodo(fp, { scope: "dev:dispatch", description: failureTodoBody(event, fp) });

  assert.deepEqual(failureTodoDecisions([], [todo], new Set(["dev"]), NOW), []);
  const decisions = failureTodoDecisions([], [todo], new Set(["dev"]), NOW, { recoveredTargets: new Set(["managed-anchor:/managed/app"]) });
  assert.equal(decisions[0].action, "close");
});
test("failure Todo recovery emits open-after-healthy only after a fresh read proves the exact healthy card remains Todo", async () => {
  const event = failureEvent({ scope: "dev:dispatch", kind: "dirty-checkout", stableTarget: "managed-anchor:/managed/app" });
  const fingerprint = failureFingerprint(event);
  const todo = existingFailureTodo(fingerprint, {
    scope: "dev:dispatch",
    description: failureTodoBody(event, fingerprint),
  });
  const emitted = [];
  let freshReads = 0;
  await assert.rejects(reconcileFailureTodos("key", { teamKey: "COD", projectId: "project-1" }, "/managed/app", [], new Set(), [], {
    recoveredTargets: new Set(["managed-anchor:/managed/app"]),
    fetchFailureTodosFn: async () => [todo],
    teamMetaFn: async () => ({ stateIds: { Done: "done" } }),
    closeFailureTodoFn: async () => {},
    fetchClaimCardFn: async () => {
      freshReads += 1;
      return { ...todo, stateName: "Todo", labelNames: [] };
    },
    onLauncherEvidence: (evidence) => emitted.push(evidence),
  }), /remained Todo/);
  assert.equal(freshReads, 1);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].evidence.state, "open-after-healthy");
  assert.equal(emitted[0].evidence.reason, "recovered-target:managed-anchor:/managed/app");
});
test("failure Todo recovery does not fabricate open-after-healthy for an unchecked scope", async () => {
  const event = failureEvent({ scope: "dev:dispatch", stableTarget: null });
  const fingerprint = failureFingerprint(event);
  const todo = existingFailureTodo(fingerprint, { scope: "dev:dispatch", description: failureTodoBody(event, fingerprint) });
  const emitted = [];
  let freshReads = 0;
  const decisions = await reconcileFailureTodos("key", { teamKey: "COD", projectId: "project-1" }, "/managed/app", [], new Set(["qa:dispatch"]), [], {
    fetchFailureTodosFn: async () => [todo],
    fetchClaimCardFn: async () => { freshReads += 1; return { ...todo, stateName: "Todo" }; },
    onLauncherEvidence: (evidence) => emitted.push(evidence),
  });
  assert.deepEqual(decisions, []);
  assert.equal(freshReads, 0);
  assert.deepEqual(emitted, []);
});
test("failureTodoDecisions: holding-state failures use the holding recovery scope", () => {
  const event = failureEvent({ scope: "holding", kind: "holding-state-fetch" });
  const fp = failureFingerprint(event);
  const checked = failureTodoDecisions([], [existingFailureTodo(fp, { scope: "holding" })], new Set(["holding"]), NOW);
  assert.equal(checked[0].action, "close");
});
test("failureTodoDecisions: update failures recover when update is checked", () => {
  const event = failureEvent({ scope: "update", kind: "skills-refresh" });
  const fp = failureFingerprint(event);
  assert.deepEqual(failureTodoDecisions([], [existingFailureTodo(fp, { scope: "update" })], new Set(["dev"]), NOW), []);
  assert.equal(failureTodoDecisions([], [existingFailureTodo(fp, { scope: "update" })], new Set(["update"]), NOW)[0].action, "close");
});
test("failureTodoDecisions: duplicate matching Todos are commented deterministically", () => {
  const event = failureEvent();
  const fp = failureFingerprint(event);
  const decisions = failureTodoDecisions([event], [
    existingFailureTodo(fp, { id: "older", identifier: "COD-101", updatedAt: hoursAgo(3) }),
    existingFailureTodo(fp, { id: "newer", identifier: "COD-102", updatedAt: hoursAgo(1) }),
  ], new Set(["dev"]), NOW);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "duplicate");
  assert.equal(decisions[0].todo.id, "older");
  assert.equal(decisions[0].primary.identifier, "COD-102");
});
test("failureTodoDecisions: duplicate comments are throttled", () => {
  const event = failureEvent();
  const fp = failureFingerprint(event);
  const duplicate = existingFailureTodo(fp, {
    id: "older",
    identifier: "COD-101",
    updatedAt: hoursAgo(3),
    comments: [{ body: "Duplicate auto-sweep failure Todo for `abc`.", createdAt: minsAgo(20) }],
  });
  const primary = existingFailureTodo(fp, { id: "newer", identifier: "COD-102", updatedAt: hoursAgo(1) });
  assert.deepEqual(failureTodoDecisions([event], [duplicate, primary], new Set(["dev"]), NOW), []);

  duplicate.comments = [{ body: "Duplicate auto-sweep failure Todo for `abc`.", createdAt: hoursAgo(26) }];
  assert.equal(failureTodoDecisions([event], [duplicate, primary], new Set(["dev"]), NOW)[0].action, "duplicate");
});
test("healthStatus: config/key failures make health non-zero even after recent tick", () => {
  assert.equal(healthStatus({ lastTick: { at: new Date(NOW).toISOString(), failures: [{ kind: "missing-key" }] }, now: NOW, intervalS: 600 }).ok, false);
  assert.equal(healthStatus({ lastTick: { at: new Date(NOW).toISOString(), failures: [] }, now: NOW, intervalS: 600 }).ok, true);
  assert.equal(healthStatus({ lastTick: { at: hoursAgo(1) }, now: NOW, intervalS: 600 }).ok, false);
});

// ── push discipline ──────────────────────────────────────────────────────────
test("healthStatus: live current tick remains unhealthy after a systemic failure", () => {
  const failed = healthStatus({
    currentTick: { status: "running", pid: 42, at: new Date(NOW).toISOString(), failures: [{ kind: "runtime-missing" }] },
    lastTick: { at: new Date(NOW).toISOString(), failures: [] },
    isAlive: (pid) => pid === 42,
    now: NOW,
  });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /current tick has 1 systemic failure/);

  const healthy = healthStatus({
    currentTick: { status: "running", pid: 42, at: new Date(NOW).toISOString(), failures: [] },
    isAlive: () => true,
    now: NOW,
  });
  assert.deepEqual(healthy, { ok: true, reason: "tick in progress (pid 42)" });
});
test("finalizeTickState: writes versioned last-tick before removing current-tick", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-current-tick-"));
  const currentPath = path.join(dir, "current-tick.json");
  const lastTickPath = path.join(dir, "last-tick");
  const order = [];
  atomicWriteJson(currentPath, { version: 1, status: "running", pid: 42, failures: [] });
  const completed = finalizeTickState({
    version: 1,
    status: "running",
    pid: 42,
    startedAt: "2026-07-09T12:00:00.000Z",
    at: "2026-07-09T12:00:00.000Z",
    failures: [],
  }, {
    currentPath,
    lastTickPath,
    now: () => "2026-07-09T12:03:00.000Z",
    writeJsonFn: (target, value) => { order.push(`write:${path.basename(target)}`); atomicWriteJson(target, value); },
    removeFn: (target) => { order.push(`remove:${path.basename(target)}`); fs.rmSync(target, { force: true }); },
  });

  assert.equal(completed.version, 1);
  assert.equal(completed.status, "complete");
  assert.equal(completed.endedAt, "2026-07-09T12:03:00.000Z");
  assert.equal(fs.existsSync(currentPath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(lastTickPath, "utf8")), completed);
  assert.deepEqual(fs.readdirSync(dir), ["last-tick"]);
  assert.deepEqual(order, ["write:last-tick", "remove:current-tick.json"]);
});
test("finalizeTickState: failed last-tick write preserves a red current-tick", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-current-tick-failure-"));
  const currentPath = path.join(dir, "current-tick.json");
  const lastTickPath = path.join(dir, "last-tick");
  const state = { version: 1, status: "running", pid: 42, at: "2026-07-09T12:00:00.000Z", failures: [] };
  atomicWriteJson(currentPath, state);

  assert.throws(() => finalizeTickState(state, {
    currentPath,
    lastTickPath,
    now: () => "2026-07-09T12:03:00.000Z",
    writeJsonFn: (target, value) => {
      if (target === lastTickPath) throw new Error("disk full");
      atomicWriteJson(target, value);
    },
  }), /disk full/);

  const preserved = JSON.parse(fs.readFileSync(currentPath, "utf8"));
  assert.equal(preserved.version, 1);
  assert.equal(preserved.status, "running");
  assert.equal(preserved.failures.at(-1).kind, "last-tick-write");
  assert.match(preserved.failures.at(-1).message, /disk full/);
  assert.equal(fs.existsSync(lastTickPath), false);
});
test("doctorReport: a running current tick owned by a dead PID is stale", () => {
  const report = doctorReport({
    registry: { repos: [], kitPath: null },
    currentTick: { status: "running", pid: 404, at: new Date(NOW).toISOString(), failures: [] },
    lastTick: { at: new Date(NOW).toISOString(), failures: [] },
    isAlive: () => false,
    now: NOW,
  });
  assert.equal(report.ok, false);
  assert.equal(report.tick.ok, false);
  assert.match(report.tick.reason, /STALE.*dead pid 404/i);
  assert.match(formatDoctorReport(report), /tick: +STALE.*dead pid 404/i);
});
test("capacity doctor: malformed ledger is unhealthy and reports active/max", () => {
  const report = doctorReport({
    registry: { repos: [], kitPath: null, capacity: { maxActiveChildren: 10 } },
    capacityState: { healthy: false, active: 1, max: 10, errors: ["entry broken"] },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.capacity, { healthy: false, active: 1, max: 10, errors: ["entry broken"] });
  assert.match(formatDoctorReport(report), /capacity: 1\/10 BLOCKED/);
  assert.match(formatDoctorReport(report), /entry broken/);
});
test("capacity doctor: real ledger inspection surfaces stale entries without mutation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-doctor-ledger-"));
  const ledgerPath = path.join(dir, "capacity-ledger.json");
  const ledger = {
    version: 1,
    entries: [
      { token: "stale-child", parentPid: 30, childPid: 31, issueIdentifier: "COD-30", workspace: "/managed", stage: "dev", trigger: "initial", reservedAt: "2026-07-09T00:00:00.000Z" },
      { token: "live-child", parentPid: 40, childPid: 41, issueIdentifier: "COD-40", workspace: "/managed", stage: "qa", trigger: "handoff", reservedAt: "2026-07-09T00:00:00.000Z" },
    ],
  };
  atomicWriteJson(ledgerPath, ledger);
  const before = fs.readFileSync(ledgerPath, "utf8");
  const report = doctorReport({
    registry: { repos: [], kitPath: null, capacity: { maxActiveChildren: 10 } },
    capacityLedgerPath: ledgerPath,
    observationState: { healthy: true, errors: [], entries: [] },
    isAlive: (pid) => pid === 41,
  });

  assert.equal(report.ok, false);
  assert.equal(report.capacity.active, 2);
  assert.deepEqual(report.capacity.errors, ["stale entry stale-child: parent PID 30 and child PID 31 are dead"]);
  assert.match(formatDoctorReport(report), /capacity error: stale entry stale-child: parent PID 30 and child PID 31 are dead/);
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), before);
});
test("doctor telemetry: JSON and human summaries expose scheduler health and tuning evidence", () => {
  const source = "/source/app";
  const currentTick = {
    status: "running",
    pid: 42,
    at: new Date(NOW).toISOString(),
    failures: [{ kind: "runtime-missing", message: "claude unavailable" }],
    telemetry: {
      capacityHighWater: 8,
      dependencyDeferredCount: 12,
      capacityDeferredCount: 3,
      loadAverage1m: { start: 1.5, end: 4.2, max: 8.7 },
      freeMemoryBytes: { start: 6_100_000_000, end: 5_000_000_000, min: 3_800_000_000 },
      totalMemoryBytes: 16_000_000_000,
      memoryPressureAvailablePercent: { start: 38, end: 31, min: 24 },
      metricsUnavailable: ["memory_pressure unavailable"],
    },
  };
  const report = doctorReport({
    registry: { repos: [source], kitPath: null, capacity: { maxActiveChildren: 10 } },
    configsBySource: new Map([[source, { runtimes: { dev: { runtime: "codex" } } }]]),
    existsFn: () => true,
    gitFn: () => ({ status: 0, out: "", err: "" }),
    resolveRuntimeFn: (runtime) => ({ ok: true, runtime, path: `/opt/bin/${runtime}`, source: "path" }),
    currentTick,
    capacityState: { healthy: false, active: 7, max: 10, errors: ["malformed entry token-x", "stale entry token-y"] },
    observationState: {
      healthy: true,
      errors: [],
      entries: [60_000, 180_000, 840_000].map((queueWaitMs, index) => ({ issueIdentifier: `COD-${index}`, queueWaitMs })),
    },
    isAlive: () => true,
    now: NOW,
  });

  assert.equal(report.capacity.highWater, 8);
  assert.deepEqual(report.queue, { observed: 3, p50Ms: 180_000, p90Ms: 840_000 });
  assert.deepEqual(report.deferred, { dependency: 12, capacity: 3 });
  assert.equal(report.resources.freeMemoryBytes.min, 3_800_000_000);
  assert.equal(report.resources.memoryPressureAvailablePercent.min, 24);
  assert.deepEqual(report.metricsUnavailable, ["memory_pressure unavailable"]);
  assert.deepEqual(report.currentTickFailures, currentTick.failures);
  assert.deepEqual(report.anchors[0].runtimes.dev, {
    ok: true, runtime: "codex", path: "/opt/bin/codex", source: "path",
  });

  const human = formatDoctorReport(report);
  assert.match(human, /capacity: 7\/10, high-water 8 BLOCKED/);
  assert.match(human, /malformed entry token-x/);
  assert.match(human, /stale entry token-y/);
  assert.match(human, /current tick failure: runtime-missing: claude unavailable/);
  assert.match(human, /runtime dev: codex \/opt\/bin\/codex \(path\)/);
  assert.match(human, /load: current=4\.2 peak=8\.7/);
  assert.match(human, /memory: free=5000000000 minimum=3800000000 pressure-available=31% minimum=24%/);
  assert.match(human, /queue: p50=3m p90=14m/);
  assert.match(human, /dependency deferred=12/);
  assert.match(human, /capacity deferred=3/);
  assert.match(human, /metrics unavailable: memory_pressure unavailable/);
});
test("doctor telemetry: malformed observations surface as a metrics gap without hiding ledger health", () => {
  const report = doctorReport({
    registry: { repos: [], kitPath: null },
    capacityState: { healthy: true, active: 0, max: 10, errors: [] },
    observationState: { healthy: false, entries: [], errors: ["observation schema is malformed"] },
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.metricsUnavailable, ["observation schema is malformed"]);
  assert.match(formatDoctorReport(report), /metrics unavailable: observation schema is malformed/);
});
test("doctor learning diagnostics expose due lenses, WAL, evaluations, coverage, and synthesis independently", () => {
  const now = "2026-07-10T12:00:00.000Z";
  const state = {
    version: 1,
    lenses: {
      reliability: { lastSuccessfulCapturedThrough: "2026-07-09T00:00:00.000Z", pending: null, error: "detector timeout" },
      quality: { lastSuccessfulCapturedThrough: "2026-07-08T00:00:00.000Z", pending: { mutations: { a: {}, b: {} } } },
      throughput: { lastSuccessfulCapturedThrough: "2026-07-01T00:00:00.000Z", pending: null },
    },
    evaluations: {
      due: { status: "active", evaluateAfter: "2026-07-10T11:00:00.000Z" },
      later: { status: "active", evaluateAfter: "2026-07-11T11:00:00.000Z" },
      done: { status: "verified-improvement", evaluateAfter: "2026-07-01T00:00:00.000Z" },
    },
  };
  const snapshot = {
    capturedThrough: now,
    events: [{ occurredAt: "2026-07-10T10:00:00.000Z", kind: "terminal", category: "failed" }],
    observations: [],
    runRecords: Array.from({ length: 20 }, (_, index) => ({ endedAt: `2026-07-10T10:${String(index).padStart(2, "0")}:00.000Z` })),
    coverage: { complete: false, gaps: [{ source: "runs", reason: "one malformed line" }] },
  };
  const report = doctorReport({
    registry: { repos: [], kitPath: null, learning: { enabled: true, runner: true } },
    capacityState: { healthy: true, active: 1, max: 10, errors: [], entries: [{ stage: "learning", trigger: "learning-due" }] },
    observationState: { healthy: true, entries: [], errors: [] },
    learningState: state,
    learningSnapshot: snapshot,
    learningWorkspaces: [{ learning: { enabled: true, lenses: { reliability: true, quality: true, throughput: true } } }],
    learningSynthesisState: { runtime: "codex", available: false, reason: "runtime missing" },
    now: Date.parse(now),
  });

  assert.equal(report.ok, true, "learning red must not flip ordinary doctor health");
  assert.deepEqual({ enabled: report.learning.enabled, runner: report.learning.runner, active: report.learning.active, healthy: report.learning.healthy }, {
    enabled: true, runner: true, active: true, healthy: false,
  });
  assert.deepEqual(report.learning.lenses.reliability, {
    lastSuccess: "2026-07-09T00:00:00.000Z", due: true, reason: "cadence-and-evidence", sampleCount: 1, pending: 0, error: "detector timeout",
  });
  assert.equal(report.learning.lenses.quality.pending, 2);
  assert.equal(report.learning.lenses.quality.due, true);
  assert.equal(report.learning.lenses.throughput.sampleCount, 20);
  assert.deepEqual(report.learning.evaluations, { active: 2, due: 1, dueRoots: ["due"] });
  assert.deepEqual(report.learning.coverage.gaps, [{ source: "runs", reason: "one malformed line" }]);
  assert.deepEqual(report.learning.synthesis, { runtime: "codex", available: false, reason: "runtime missing" });

  const human = formatDoctorReport(report);
  assert.match(human, /learning: enabled, runner, active, RED/);
  assert.match(human, /reliability: due=yes last=2026-07-09T00:00:00.000Z samples=1 pending=0 error=detector timeout/);
  assert.match(human, /quality: due=yes .*pending=2/);
  assert.match(human, /evaluations: active=2 due=1/);
  assert.match(human, /coverage gap: runs: one malformed line/);
  assert.match(human, /synthesis: codex unavailable \(runtime missing\)/);
});

test("doctor learning diagnostics default disabled without affecting ordinary health", () => {
  const report = doctorReport({
    registry: { repos: [], kitPath: null },
    capacityState: { healthy: true, active: 0, max: 10, errors: [], entries: [] },
    observationState: { healthy: true, entries: [], errors: [] },
    learningState: { version: 1, lenses: {}, evaluations: {} },
    learningSnapshot: { capturedThrough: "2026-07-10T12:00:00.000Z", events: [], observations: [], runRecords: [], coverage: { complete: true, gaps: [] } },
    learningWorkspaces: [],
    learningSynthesisState: { runtime: null, available: null, reason: "disabled" },
  });
  assert.equal(report.ok, true);
  assert.equal(report.learning.enabled, false);
  assert.equal(report.learning.healthy, true);
  assert.equal(Object.values(report.learning.lenses).some((lens) => lens.due), false);
  assert.match(formatDoctorReport(report), /learning: disabled, non-runner, idle, OK/);
});

test("doctor reports optional synthesis as not configured without making learning red", () => {
  const report = doctorReport({
    registry: { repos: [], kitPath: null, learning: { enabled: true, runner: true, runtime: null } },
    capacityState: { healthy: true, active: 0, max: 10, errors: [], entries: [] },
    observationState: { healthy: true, entries: [], errors: [] },
    learningState: { version: 1, lenses: {}, evaluations: {} },
    learningSnapshot: { capturedThrough: "2026-07-10T12:00:00.000Z", events: [], observations: [], runRecords: [], coverage: { complete: true, gaps: [] } },
    learningWorkspaces: [],
  });
  assert.deepEqual(report.learning.synthesis, { runtime: null, available: null, reason: "not-configured" });
  assert.equal(report.learning.healthy, true);
});
test("doctor preserves exact dependency-cycle evidence after the tick completes", () => {
  const lastTick = {
    at: new Date(NOW).toISOString(),
    failures: [{ kind: "dependency-cycle", message: "visible dependency cycle: COD-1 -> COD-2; COD-2 -> COD-1" }],
  };
  const report = doctorReport({
    registry: { repos: [], kitPath: null },
    lastTick,
    capacityState: { healthy: true, active: 0, max: 10, errors: [] },
    observationState: { healthy: true, entries: [], errors: [] },
    now: NOW,
  });

  assert.deepEqual(report.lastTickFailures, lastTick.failures);
  assert.match(formatDoctorReport(report), /latest tick failure: dependency-cycle: visible dependency cycle: COD-1 -> COD-2; COD-2 -> COD-1/);
});

test("pushWithRetry: succeeds on first attempt", () => {
  const calls = [];
  const gitFn = (repo, args) => { calls.push(args[0]); return { status: 0 }; };
  const r = pushWithRetry("/r", "main", { gitFn });
  assert.deepEqual(r, { ok: true, attempts: 1 });
  assert.deepEqual(calls, ["push"]);
});
test("pushWithRetry: retries via fetch+rebase then succeeds; never force-pushes", () => {
  const seq = [{ status: 1 }, { status: 0 }]; // push fails, then succeeds
  const calls = [];
  const gitFn = (repo, args) => { calls.push(args.join(" ")); return args[0] === "push" ? seq.shift() : { status: 0 }; };
  const r = pushWithRetry("/r", "COD-1", { gitFn });
  assert.equal(r.ok, true);
  assert.ok(calls.includes("fetch origin COD-1"));
  assert.ok(calls.includes("rebase origin/COD-1"));
  assert.ok(!calls.some((c) => c.includes("--force")));
});
test("pushWithRetry: gives up after maxRetries without forcing", () => {
  const calls = [];
  const gitFn = (repo, args) => { calls.push(args[0]); return { status: 1 }; };
  const r = pushWithRetry("/r", "main", { maxRetries: 2, gitFn });
  assert.equal(r.ok, false);
  assert.equal(calls.filter((c) => c === "push").length, 3); // initial + 2 retries
  assert.ok(!calls.some((c) => c === "--force"));
});
test("dirtyCheckoutEvent: reports exact dirty path samples with overflow", () => {
  const paths = Array.from({ length: 30 }, (_, i) => `?? file-${i}.png`).join("\n");
  const event = dirtyCheckoutEvent(
    { sweep: "dev" },
    { role: "managed-anchor", path: "/managed/app" },
    { gitFn: () => ({ status: 0, out: paths, err: "" }) },
  );

  assert.equal(event.kind, "dirty-checkout");
  assert.match(event.message, /30 uncommitted path/);
  assert.match(event.message, /paths:\n  \?\? file-0\.png/);
  assert.match(event.message, /\.\.\. and 5 more path/);
});
test("dirtyCheckoutEvent: a removed card worktree is clean after a successful child", () => {
  let gitCalls = 0;
  const event = dirtyCheckoutEvent(
    { sweep: "spec" },
    { role: "worktree", path: "/managed/app/.worktrees/COD-117" },
    {
      existsFn: () => false,
      gitFn: () => {
        gitCalls += 1;
        return { status: 1, out: "", err: "No such file or directory" };
      },
    },
  );

  assert.equal(event, null);
  assert.equal(gitCalls, 1);
});
test("dirtyCheckoutEvent: an inaccessible worktree still fails closed", () => {
  const event = dirtyCheckoutEvent(
    { sweep: "qa" },
    { role: "worktree", path: "/managed/app/.worktrees/COD-118" },
    {
      existsFn: () => false,
      gitFn: () => ({ status: 1, out: "", err: "Permission denied" }),
    },
  );

  assert.equal(event.kind, "checkout-status");
  assert.match(event.message, /Permission denied/);
});
test("checkoutDispatchBlockers: dirty source anchor is advisory when managed checkouts are present", () => {
  const calls = [];
  const gitFn = (repo, args) => {
    calls.push([repo, args.join(" ")]);
    return { status: 0, out: repo === "/source" ? " M local-note.md" : "", err: "" };
  };
  const blockers = checkoutDispatchBlockers({
    anchorPath: "/managed/app",
    sourceAnchorPath: "/source",
    managedRepoPaths: ["/managed/app"],
    issueIdentifier: "COD-10",
    config: { repos: ["app"] },
    sweep: "ship",
  }, { kitPath: "/kit" }, { gitFn });
  assert.equal(blockers.length, 0);
  assert.deepEqual(calls, [
    ["/managed/app/.worktrees/COD-10", "status --porcelain -uall"],
    ["/managed/app", "status --porcelain -uall"],
    ["/kit", "status --porcelain -uall"],
  ]);
});
test("checkoutDispatchBlockers: dirty ignored card worktree blocks dispatch", () => {
  const gitFn = (repo) => ({ status: 0, out: repo === "/managed/app/.worktrees/COD-10" ? " M src/change.js" : "", err: "" });
  const blockers = checkoutDispatchBlockers({
    anchorPath: "/managed/app",
    managedRepoPaths: ["/managed/app"],
    issueIdentifier: "COD-10",
    config: { repos: ["app"] },
    sweep: "qa",
  }, {}, { gitFn });

  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].scope, "qa:dispatch");
  assert.equal(blockers[0].kind, "dirty-checkout");
  assert.equal(blockers[0].stableTarget, "worktree:/managed/app/.worktrees/COD-10");
  assert.match(blockers[0].message, /src\/change\.js/);
});
test("checkoutDispatchBlockers: dirty managed repo and kit clone block dispatch", () => {
  const gitFn = (repo) => ({ status: 0, out: repo === "/managed/sibling" || repo === "/kit" ? " M README.md" : "", err: "" });
  const blockers = checkoutDispatchBlockers({
    anchorPath: "/managed/anchor",
    managedRepoPaths: ["/managed/anchor", "/managed/sibling"],
    sweep: "dev",
  }, { kitPath: "/kit" }, { gitFn });
  assert.equal(blockers.length, 2);
  assert.deepEqual(blockers.map((b) => b.stableTarget), ["managed-repo:/managed/sibling", "kit:/kit"]);
});
test("checkoutDispatchBlockers: legacy source-anchor dispatch still blocks dirty anchor", () => {
  const gitFn = (repo) => ({ status: 0, out: repo === "/anchor" ? " M README.md" : "", err: "" });
  const blockers = checkoutDispatchBlockers({ anchorPath: "/anchor", sweep: "dev" }, { kitPath: "/anchor" }, { gitFn });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].scope, "dev:dispatch");
  assert.equal(blockers[0].kind, "dirty-checkout");
  assert.equal(blockers[0].stableTarget, "anchor:/anchor");
});

test("launcher evidence records are deterministically routed and durably appended", () => {
  const input = {
    sourceAnchorPath: "/source/app",
    config: { projectId: "project-1", repos: ["app"] },
    repoPairs: [{ repoEntry: "app", sourceRepoPath: "/source/app", managedRepoPath: "/managed/app" }],
    card: { id: "issue-1", identifier: "COD-1", labelNames: [] },
    sweep: "dev",
    occurredAt: "2026-07-10T12:00:00.000Z",
    evidence: { type: "stale-claim", key: "dev:dev:in-progress" },
  };
  const first = buildLauncherEvidenceRunRecord(input);
  const second = buildLauncherEvidenceRunRecord(input);
  assert.equal(first.cardRunId, second.cardRunId);
  assert.equal(first.sourceWorkspace, "/source/app");
  assert.equal(first.projectId, "project-1");
  assert.equal(first.repoEntry, "app");
  assert.equal(first.issueIdentifier, "COD-1");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-evidence-"));
  appendLauncherEvidenceRun(input, { runsDir: dir });
  const [persisted] = fs.readFileSync(path.join(dir, "20260710.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(persisted, first);

  appendLauncherEvidenceRun({
    ...input,
    config: { ...input.config, repos: ["app", "worker"], repoRouting: { byLabel: { "app:main": "app", "app:worker": "worker" } } },
    card: { ...input.card, identifier: "COD-2", labelNames: [] },
  }, { runsDir: dir });
  const indexed = readLearningRunIndex(dir, { capturedThrough: "2026-07-11T00:00:00.000Z" });
  assert.ok(indexed.coverageGaps.some((gap) => /trusted identity and routing fields/.test(gap.reason)));
});

test("launcher reap evidence is emitted only after the Linear mutation is confirmed", async () => {
  const base = {
    apiKey: "key",
    sourceAnchorPath: "/source/app",
    config: { projectId: "project-1", repos: ["app"] },
    repoPairs: [{ repoEntry: "app", sourceRepoPath: "/source/app", managedRepoPath: "/managed/app" }],
    card: { id: "issue-1", identifier: "COD-1", labelNames: ["dev:in-progress"] },
    decision: { action: "reap", releaseClaim: "dev:in-progress" },
    sweep: "dev",
  };
  const emitted = [];
  await assert.rejects(recordConfirmedReapEvidence(base, {
    fetchClaimCardFn: async () => base.card,
    appendEvidenceFn: (value) => emitted.push(value),
  }), /still carries/);
  assert.equal(emitted.length, 0);

  await recordConfirmedReapEvidence(base, {
    fetchClaimCardFn: async () => ({ ...base.card, labelNames: [] }),
    appendEvidenceFn: (value) => emitted.push(value),
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].evidence.type, "stale-claim");
});

test("launcher poison-card evidence requires every orphaned claim to be absent", async () => {
  const base = {
    apiKey: "key",
    sourceAnchorPath: "/source/app",
    config: { projectId: "project-1", repos: ["app"] },
    repoPairs: [{ repoEntry: "app", sourceRepoPath: "/source/app", managedRepoPath: "/managed/app" }],
    card: { id: "issue-1", identifier: "COD-1", labelNames: ["qa:in-progress"] },
    decision: { releaseClaims: ["qa:in-progress", "dev:in-progress"] },
    sweep: "qa",
  };
  const emitted = [];
  await assert.rejects(recordConfirmedOrphanEvidence(base, {
    fetchClaimCardFn: async () => base.card,
    appendEvidenceFn: (value) => emitted.push(value),
  }), /still carries/);
  assert.equal(emitted.length, 0);

  await recordConfirmedOrphanEvidence(base, {
    fetchClaimCardFn: async () => ({ ...base.card, labelNames: [] }),
    appendEvidenceFn: (value) => emitted.push(value),
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].evidence.type, "machine-correctable-poison-card");
});

test("route-less failure Todo recovery uses the launcher's trusted anchor repo in routed workspaces", () => {
  const sourceAnchorPath = "/source/app";
  const config = {
    projectId: "project-1",
    repos: ["app", "worker"],
    repoRouting: { byLabel: { "app:main": "app", "app:worker": "worker" } },
  };
  const repoPairs = [
    { repoEntry: "app", sourceRepoPath: sourceAnchorPath, managedRepoPath: "/managed/app" },
    { repoEntry: "worker", sourceRepoPath: "/source/worker", managedRepoPath: "/managed/worker" },
  ];
  const repoEntry = trustedLauncherSourceRepoEntry(sourceAnchorPath, config, repoPairs);
  assert.equal(repoEntry, "app");
  assert.equal(trustedLauncherSourceRepoEntry("/source/unknown", config, repoPairs), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routed-recovery-evidence-"));
  appendLauncherEvidenceRun({
    sourceAnchorPath,
    config,
    repoPairs,
    repoEntry,
    card: { id: "todo-1", identifier: "COD-50", labelNames: [] },
    sweep: "launcher",
    occurredAt: "2026-07-10T12:00:00.000Z",
    evidence: {
      type: "recovery-transition",
      state: "open-after-healthy",
      key: "failure-fingerprint",
      occurredAt: "2026-07-10T12:00:00.000Z",
    },
  }, { runsDir: dir });
  const indexed = readLearningRunIndex(dir, { capturedThrough: "2026-07-11T00:00:00.000Z" });
  const snapshot = buildLearningEvidenceSnapshot({
    capturedThrough: "2026-07-11T00:00:00.000Z",
    runRecords: indexed.runRecords,
    coverageGaps: indexed.coverageGaps,
  });
  assert.equal(snapshot.coverage.complete, true);
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].signal, "failure-recovery");
  assert.equal(snapshot.observations[0].repoEntry, "app");
  assert.equal(snapshot.observations[0].recoveryState, "open-after-healthy");
});

test("doctorReport: distinguishes source advisory dirtiness from managed blocking dirtiness", () => {
  const registry = normalizeRegistry({
    kitPath: "/kit",
    shipRunner: true,
    repos: ["/src/app"],
    managedAnchors: {
      "/src/app": {
        sourceAnchorPath: "/src/app",
        managedWorkspaceRoot: "/managed/app",
        managedAnchorPath: "/managed/app/app",
        repoMap: {},
      },
    },
  });
  const gitFn = (repo) => ({ status: 0, out: repo === "/src/app" || repo === "/managed/app/app" ? "?? screenshot.png" : "", err: "" });
  const report = doctorReport({
    registry,
    configsBySource: new Map([["/src/app", { repos: ["app"] }]]),
    existsFn: (p) => p === "/kit" || p === "/src/app" || p === "/managed/app/app",
    gitFn,
  });

  assert.equal(report.ok, false);
  assert.equal(report.anchors[0].sourceDirty.kind, "source-advisory");
  assert.equal(report.anchors[0].managedBlockers[0].stableTarget, "managed-anchor:/managed/app/app");
  assert.match(formatDoctorReport(report), /source advisory dirty/);
  assert.match(formatDoctorReport(report), /dispatch: BLOCKED/);
});

function runIsolatedWatcherCli(args, { registry = null, prepare = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linear-watcher-cli-"));
  const preparedRegistry = prepare ? prepare(home) : registry;
  if (preparedRegistry) {
    const configDir = path.join(home, ".config", "linear-board-sweeps");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "registry.json"), `${JSON.stringify(preparedRegistry)}\n`);
  }
  const script = fileURLToPath(new URL("../scripts/linear-watch.mjs", import.meta.url));
  const result = spawnProcessSync(process.execPath, [script, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return { ...result, home };
}

function prepareCredentiallessLearningWorkspace(home) {
  const anchor = path.join(home, "app");
  fs.mkdirSync(path.join(anchor, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(anchor, ".claude", "linear-sweep.json"), JSON.stringify({
    team: "Codex", teamKey: "COD", project: "Linear Sweep", projectId: "project-1",
    repos: ["app"], learning: { enabled: true },
  }));
  return {
    repos: [anchor], capacity: { maxActiveChildren: 10 },
    learning: { enabled: true, runner: true, coreSourceAnchor: anchor, maxNewCardsPerRun: 6, runtime: null },
  };
}

test("learning CLI status and dry-run operate without credentials in an isolated empty registry", () => {
  const status = runIsolatedWatcherCli(["learning-status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.equal(report.enabled, false);
  assert.deepEqual(report.workspaces, []);
  assert.equal(report.coverage.complete, true);
  assert.equal(report.due.due, false);

  const dryRun = runIsolatedWatcherCli(["learning-run", "--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout);
  assert.equal(plan.mode, "dry-run");
  assert.deepEqual(plan.mutations, []);
  assert.deepEqual(plan.evaluations, []);
});

test("learning CLI reports registered workspace credential gaps without attempting Linear writes", () => {
  const status = runIsolatedWatcherCli(["learning-status", "--json"], { prepare: prepareCredentiallessLearningWorkspace });
  assert.equal(status.status, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.equal(report.workspaces.length, 1);
  assert.equal(report.workspaces[0].hasApiKey, false);
  assert.equal(report.coverage.complete, false);
  assert.ok(report.coverage.gaps.some((gap) => /LINEAR_API_KEY missing/.test(gap.reason)));

  const dryRun = runIsolatedWatcherCli(["learning-run", "--dry-run"], { prepare: prepareCredentiallessLearningWorkspace });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout);
  assert.ok(plan.coverageGaps.some((gap) => /destination credential is missing/.test(gap.reason)));
  assert.deepEqual(plan.mutations, []);
});

test("learning CLI refuses attended writes when this host is not the configured runner", () => {
  const result = runIsolatedWatcherCli(["learning-run"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /learning runner is not enabled on this host/);
});

test("attended learning CLI uses the deterministic writer under the runner singleton", () => {
  const registry = {
    repos: [],
    capacity: { maxActiveChildren: 10 },
    learning: { enabled: true, runner: true, coreSourceAnchor: null, maxNewCardsPerRun: 6, runtime: null },
  };
  const result = runIsolatedWatcherCli(["learning-run"], { registry });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "deterministic");
  assert.deepEqual(report.findings, []);
  assert.equal(report.writes.mutations, 0);
  assert.deepEqual(report.writes.plannedDestinations, []);
  assert.equal(fs.existsSync(path.join(result.home, ".local", "state", "linear-board-sweeps", "capacity-ledger.json")), true);
});

test("learning synthesis subprocess accepts only known bounded annotations and cleans temporary evidence", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "learning-synthesis-"));
  let spawnedPid = null;
  const result = await dispatchLearningAsync({
    findings: [{ rootFingerprint: "known-root", impact: "bounded" }],
    runtimeConfig: { runtime: "codex" },
    tempRoot,
  }, {
    resolveExecutableFn: () => "/fake/codex",
    onSpawn: (pid) => { spawnedPid = pid; },
    spawnFn: (_executable, args) => {
      const child = new EventEmitter();
      child.pid = 4321;
      const outputPath = args.find((value) => String(value).endsWith("output.json"));
      queueMicrotask(() => {
        fs.writeFileSync(outputPath, JSON.stringify({ annotations: [
          { rootFingerprint: "known-root", summary: "useful\u0000annotation" },
          { rootFingerprint: "unknown-root", summary: "must be ignored" },
        ] }));
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  assert.equal(spawnedPid, 4321);
  assert.deepEqual(result, {
    mode: "synthesized",
    available: true,
    annotations: [{ rootFingerprint: "known-root", summary: "useful annotation" }],
  });
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test("learning synthesis subprocess fails closed on spawn errors and still removes temporary files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "learning-synthesis-failure-"));
  const result = await dispatchLearningAsync({
    findings: [{ rootFingerprint: "root" }],
    runtimeConfig: { runtime: "codex" },
    tempRoot,
  }, {
    resolveExecutableFn: () => "/fake/codex",
    spawnFn: () => { throw new Error("spawn unavailable"); },
  });
  assert.equal(result.mode, "deterministic");
  assert.equal(result.available, false);
  assert.match(result.reason, /spawn unavailable/);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test("scheduled dry-run traverses delivery and learning orchestration without mutating an empty registry", () => {
  const result = runIsolatedWatcherCli(["tick", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no actionable work/);
  assert.match(result.stderr, /\[dry-run\] learning due=false admitted=0 deferred=0/);
  assert.equal(fs.existsSync(path.join(result.home, ".local", "state", "linear-board-sweeps", "last-tick")), false);
});

test("scheduled dry-run isolates a registered workspace with missing credentials and still previews learning", () => {
  const result = runIsolatedWatcherCli(["tick", "--dry-run"], { prepare: prepareCredentiallessLearningWorkspace });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /FATAL no LINEAR_API_KEY/);
  assert.match(result.stderr, /no actionable work/);
  assert.match(result.stderr, /\[dry-run\] learning due=false admitted=0 deferred=0/);
});

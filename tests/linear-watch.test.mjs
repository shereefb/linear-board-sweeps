// Unit tests for the auto-sweep launcher's pure decision logic (node:test, zero-dep).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRepos, worktreePath, runtimeConfigForSweep, buildCommand, lockIsReclaimable, isNewerVersion,
  heartbeatAgeMin, countMarkers, reapDecisions, bounceDecisions, bouncePairKey,
  countActionable, actionableCards, applyDecisionsInMemory,
  boardOrderValue, sortByBoardPosition, selectDispatch, selectDispatchBatch,
  parallelLimit, sameRepoCardLimit, selectCardSlots, ownerToken, heartbeatOwner,
  latestHeartbeatOwner, claimConfirmed, cardWorktreePath, cardRunPaths, withCardDispatchEnv,
  dryRunDispatchMessages, dispatchBatch, parseEnv, pushWithRetry,
  SWEEP_CFG, DEFAULT_MAX_NON_SHIP_DISPATCHES, DEFAULT_SAME_REPO_CARD_LIMITS, SAME_REPO_PORT_BASE,
  foreignClaimReleases, SWEEPS, SWEEP_ORDER, SKILL_DIRS, HOLDING_STATES, MAX_STALE_MIN,
  REAPER_TAG, BOUNCE_TAG, HEARTBEAT_TAG,
  BLOCKING_LABELS, MANUAL_SKILL_DIRS, PROPAGATED_SKILL_DIRS,
  blockingLabelsForIssue, normalizeBlockedIssue, labelIdsAfterRemoving,
  buildUnblockAuditComment, resolutionTextFromArgs, resolveBlockedIssue,
  FAILURE_TODO_TAG, failureFingerprint, sanitizeFailureMessage,
  failureTodoTitle, failureTodoBody, failureTodoDecisions, healthStatus,
} from "../scripts/linear-watch.mjs";

const NOW = Date.parse("2026-07-08T12:00:00Z");
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

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
test("worktreePath is deterministic under the repo", () => {
  assert.equal(worktreePath("/ws/repo", "COD-42"), "/ws/repo/.worktrees/COD-42");
});

// ── runtime config ───────────────────────────────────────────────────────────
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

// ── command builder ──────────────────────────────────────────────────────────
test("buildCommand: codex with model + effort emits both flags before the prompt", () => {
  const { cmd, args } = buildCommand({ runtime: "codex", sweep: "dev", model: "gpt-5.5-codex", effort: "high", anchorPath: "/ws/a" });
  assert.equal(cmd, "codex");
  assert.deepEqual(args.slice(0, 6), ["exec", "--cd", "/ws/a", "-m", "gpt-5.5-codex", "-c"]);
  assert.equal(args[6], "model_reasoning_effort=high");
  assert.match(args[args.length - 1], /Follow the dev-sweep skill/);
});
test("buildCommand: omitted model/effort emit no flags (runtime default)", () => {
  const { args } = buildCommand({ runtime: "codex", sweep: "spec", anchorPath: "/ws/a" });
  assert.ok(!args.includes("-m"));
  assert.ok(!args.includes("-c"));
});
test("buildCommand: single-card dispatch names the issue and forbids other cards", () => {
  const { args } = buildCommand({ runtime: "codex", sweep: "dev", anchorPath: "/ws/a", issueIdentifier: "COD-123" });
  assert.match(args.at(-1), /COD-123 only/);
  assert.match(args.at(-1), /Do not process other cards/);
});
test("buildCommand: claude passes --model and -p prompt", () => {
  const { cmd, args } = buildCommand({ runtime: "claude", sweep: "qa", model: "claude-opus-4-8", anchorPath: "/ws/a" });
  assert.equal(cmd, "claude");
  assert.equal(args[0], "-p");
  assert.deepEqual(args.slice(2), ["--model", "claude-opus-4-8"]);
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
  comments: extra.comments || [],
});
test("reapDecisions: fresh heartbeat is not reaped", () => {
  const card = { id: "i", identifier: "COD-1", updatedAt: minsAgo(2), labelNames: ["dev:in-progress"], comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(2)}]`, createdAt: minsAgo(2) }] };
  assert.deepEqual(reapDecisions([card], SWEEP_CFG.dev, NOW), []);
});
test("reapDecisions: stale claim with no prior reaps is reaped", () => {
  const d = reapDecisions([claimed(true)], SWEEP_CFG.dev, NOW);
  assert.equal(d.length, 1);
  assert.equal(d[0].action, "reap");
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
    { body: `${BOUNCE_TAG} Ready for Dev→Needs Spec]`, createdAt: hoursAgo(1) },
    { body: `${BOUNCE_TAG} In Review→Ready for Dev]`, createdAt: hoursAgo(2) },
  ] };
  assert.deepEqual(bounceDecisions([card], SWEEP_CFG.dev, NOW), []);
});
test("bouncePairKey: parses <from>→<to> (with spaces) into an unordered pair; A→B == B→A", () => {
  assert.equal(bouncePairKey(`${BOUNCE_TAG} Ready for Dev→Needs Spec]`), bouncePairKey(`${BOUNCE_TAG} Needs Spec→Ready for Dev]`));
  assert.equal(bouncePairKey("no marker here"), null);
});

// ── actionable count ─────────────────────────────────────────────────────────
test("countActionable: excludes blocked and live-claimed, counts released + plain", () => {
  const now = NOW;
  const cards = [
    { id: "plain", updatedAt: minsAgo(1), labelNames: [], comments: [] },
    { id: "blocked", updatedAt: minsAgo(1), labelNames: ["blocked:needs-user"], comments: [] },
    { id: "live", updatedAt: minsAgo(1), labelNames: ["dev:in-progress"], comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)}]`, createdAt: minsAgo(1) }] },
    { id: "released", updatedAt: minsAgo(1), labelNames: ["dev:in-progress"], comments: [] },
  ];
  // released id is in the released set (its claim was just dropped this tick)
  assert.equal(countActionable(cards, SWEEP_CFG.dev, now, new Set(["released"])), 2); // plain + released
});
test("countActionable: a stale-heartbeat claim that wasn't released still counts (it's not live)", () => {
  const card = { id: "x", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], comments: [] };
  assert.equal(countActionable([card], SWEEP_CFG.dev, NOW, new Set()), 1);
});
test("actionableCards: excludes cards with live foreign in-progress claims", () => {
  const card = {
    id: "ship",
    updatedAt: minsAgo(1),
    labelNames: ["fast-path:eligible", "dev:in-progress"],
    comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)}]`, createdAt: minsAgo(1) }],
  };
  assert.deepEqual(actionableCards([card], SWEEP_CFG.ship, NOW), []);
});
test("actionableCards: allows cards with stale foreign in-progress claims after reaper release", () => {
  const card = {
    id: "ship",
    updatedAt: minsAgo(300),
    labelNames: ["fast-path:eligible", "dev:in-progress"],
    comments: [],
  };
  assert.deepEqual(actionableCards([card], SWEEP_CFG.ship, NOW).map((c) => c.id), ["ship"]);
});
test("applyDecisionsInMemory: a reaped card becomes actionable; an escalated card does NOT", () => {
  // Two stale-claim cards: one plain reap, one hitting the 3rd reap (escalate-crash).
  const reapCard = { id: "r", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], comments: [] };
  const escCard = { id: "e", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], comments: [
    { body: REAPER_TAG, createdAt: hoursAgo(2) }, { body: REAPER_TAG, createdAt: hoursAgo(4) } ] };
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
  ];
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
  ];
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
test("parallelLimit: defaults invalid and missing config to the bounded parallel default", () => {
  assert.equal(DEFAULT_MAX_NON_SHIP_DISPATCHES, 2);
  assert.equal(parallelLimit({}), 2);
  assert.equal(parallelLimit({ parallel: { maxNonShipDispatches: "lots" } }), 2);
  assert.equal(parallelLimit({ parallel: { maxNonShipDispatches: 0 } }), 2);
  assert.equal(parallelLimit({ parallel: { maxNonShipDispatches: 1 } }), 1);
  assert.equal(parallelLimit({ parallel: { maxNonShipDispatches: 2.8 } }), 2);
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
test("selectCardSlots: chooses top actionable cards and assigns stable slot indexes", () => {
  const cards = [
    { id: "blocked", identifier: "COD-1", sortOrder: 99, updatedAt: minsAgo(1), labelNames: ["blocked:needs-user"], comments: [] },
    { id: "live", identifier: "COD-2", sortOrder: 90, updatedAt: minsAgo(1), labelNames: ["dev:in-progress"], comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)}]`, createdAt: minsAgo(1) }] },
    { id: "second", identifier: "COD-3", sortOrder: 10, updatedAt: minsAgo(1), labelNames: [], comments: [] },
    { id: "first", identifier: "COD-4", sortOrder: 20, updatedAt: minsAgo(1), labelNames: [], comments: [] },
  ];
  const slots = selectCardSlots(cards, SWEEP_CFG.dev, "dev", 2, NOW);
  assert.deepEqual(slots.map((s) => `${s.slotIndex}:${s.identifier}`), ["0:COD-4", "1:COD-3"]);
});
test("owner-token claim confirmation uses latest matching heartbeat owner", () => {
  const owner = ownerToken({ host: "host a", parentRunId: "run", issueIdentifier: "COD-5", slotIndex: 0 });
  assert.equal(owner, "host_a:run:COD-5:0");
  assert.equal(heartbeatOwner(`${HEARTBEAT_TAG} ${minsAgo(1)} owner=${owner}]`), owner);
  const card = {
    id: "c",
    identifier: "COD-5",
    stateName: "Ready for Dev",
    labelNames: ["dev:in-progress"],
    comments: [
      { body: `${HEARTBEAT_TAG} ${minsAgo(3)} owner=other] dev:in-progress`, createdAt: minsAgo(3) },
      { body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=${owner}] dev:in-progress`, createdAt: minsAgo(1) },
    ],
  };
  assert.equal(latestHeartbeatOwner(card, "dev:in-progress"), owner);
  assert.equal(claimConfirmed(card, SWEEP_CFG.dev, owner, ["Ready for Dev"]), true);
  assert.equal(claimConfirmed({ ...card, stateName: "In Review" }, SWEEP_CFG.dev, owner, ["Ready for Dev"]), false);
  assert.equal(claimConfirmed({ ...card, labelNames: ["dev:in-progress", "blocked:needs-user"] }, SWEEP_CFG.dev, owner, ["Ready for Dev"]), false);
});
test("card run paths/env are isolated per issue and slot", () => {
  assert.equal(SAME_REPO_PORT_BASE, 47000);
  assert.equal(cardWorktreePath("/ws/repo", { repos: ["repo"] }, "COD-6"), "/ws/repo/.worktrees/COD-6");
  const paths = cardRunPaths("/ws/repo", { repos: ["repo"] }, "dev", { identifier: "COD-6", slotIndex: 1 }, "run-id", 2);
  assert.equal(paths.worktreePath, "/ws/repo/.worktrees/COD-6");
  assert.match(paths.logDir, /linear-board-sweeps\/repo\/dev\/COD-6$/);
  assert.match(paths.tmpDir, /linear-board-sweeps\/run-id\/COD-6\/tmp$/);
  assert.equal(paths.portBase, 47020);
  const pick = withCardDispatchEnv({ anchorPath: "/ws/repo", config: { repos: ["repo"] }, sweep: "dev", issueIdentifier: "COD-6", slotIndex: 1 }, "run-id", 2);
  assert.equal(pick.childEnv.AUTO_SWEEP_ISSUE, "COD-6");
  assert.equal(pick.childEnv.AUTO_SWEEP_WORKTREE, "/ws/repo/.worktrees/COD-6");
  assert.equal(pick.childEnv.AUTO_SWEEP_APP_PORT, "47020");
  assert.equal(pick.sameRepoLimit, 4);
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
test("selectDispatchBatch: dedupes same anchor and overlapping resolved repos", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/ws/a", config: { repos: ["a"] }, sweep: "dev", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/a", config: { repos: ["a"] }, sweep: "spec", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/b", config: { repos: ["/ws/a"] }, sweep: "spec", count: 1, oldestUpdatedAt: 2 },
    { anchorPath: "/ws/c", config: { repos: ["c"] }, sweep: "spec", count: 1, oldestUpdatedAt: 3 },
  ], { maxNonShipDispatches: 3 });
  assert.deepEqual(batch.map((c) => c.anchorPath), ["/ws/a", "/ws/c"]);
});
test("selectDispatchBatch: dedupes nested repo path overlap", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/ws/a", config: { repos: ["/tmp/shared"] }, sweep: "dev", count: 1, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/b", config: { repos: ["/tmp/shared/subrepo"] }, sweep: "spec", count: 1, oldestUpdatedAt: 2 },
    { anchorPath: "/ws/c", config: { repos: ["/tmp/other"] }, sweep: "spec", count: 1, oldestUpdatedAt: 3 },
  ], { maxNonShipDispatches: 3 });
  assert.deepEqual(batch.map((c) => c.anchorPath), ["/ws/a", "/ws/c"]);
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
      ],
    },
  ]);
  assert.deepEqual(messages.map((m) => m.body), [
    "[dry-run] WOULD dispatch codex (2 actionable; top COD-8; sameRepoLimit=2)",
    "[dry-run] slot 1/2 dev COD-8 sortOrder=5",
    "[dry-run] slot 2/2 dev COD-7 sortOrder=1",
  ]);
});
test("dispatchBatch: dispatches every selected child and returns exit codes", async () => {
  const calls = [];
  const statuses = await dispatchBatch([
    { anchorPath: "/ws/a", sweep: "dev", config: {} },
    { anchorPath: "/ws/b", sweep: "spec", config: {} },
  ], {
    dispatchFn: async (anchorPath, sweep, config) => {
      calls.push({ anchorPath, sweep, config });
      return sweep === "dev" ? 0 : 7;
    },
  });
  assert.deepEqual(statuses, [0, 7]);
  assert.deepEqual(calls.map((c) => `${c.anchorPath}:${c.sweep}`), ["/ws/a:dev", "/ws/b:spec"]);
});

// ── ship sweep: config + dispatch priority ───────────────────────────────────
test("SWEEP_CFG.ship exists and the derived lists include it", () => {
  assert.deepEqual(SWEEP_CFG.ship.states, ["Ready to Ship"]);
  assert.equal(SWEEP_CFG.ship.claim, "ship:in-progress");
  assert.ok(SWEEP_CFG.ship.blocked.includes("blocked:needs-user")); // parked cards aren't re-dispatched
  assert.equal(SWEEP_CFG.ship.staleMin, 120);
  assert.ok(SWEEPS.includes("ship"));
  assert.ok(SKILL_DIRS.includes("ship-sweep")); // auto-updater propagates the new skill
});
test("manual unblock skill propagates but is never scheduled", () => {
  assert.deepEqual(MANUAL_SKILL_DIRS, ["unblock-sweep"]);
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
test("selectDispatchBatch: ship suppresses all non-ship dispatch", () => {
  const batch = selectDispatchBatch([
    { anchorPath: "/ws/a", config: { repos: ["a"] }, sweep: "dev", count: 5, oldestUpdatedAt: 1 },
    { anchorPath: "/ws/b", config: { repos: ["b"] }, sweep: "ship", count: 1, oldestUpdatedAt: 999 },
    { anchorPath: "/ws/c", config: { repos: ["c"] }, sweep: "qa", count: 5, oldestUpdatedAt: 1 },
  ], { maxNonShipDispatches: 3 });
  assert.equal(batch.length, 1);
  assert.equal(batch[0].sweep, "ship");
});

// ── foreign / orphaned-claim reaper ──────────────────────────────────────────
test("foreignClaimReleases: releases a stale orphaned claim; a fresh heartbeat is spared", () => {
  const stale = { id: "s", identifier: "COD-7", updatedAt: minsAgo(300), labelNames: ["qa:in-progress"], comments: [] };
  const fresh = { id: "f", identifier: "COD-8", updatedAt: minsAgo(1), labelNames: ["qa:in-progress"],
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
  const card = { id: "m", identifier: "COD-10", updatedAt: minsAgo(300), labelNames: ["qa:in-progress", "ship:in-progress"], comments: [] };
  const d = foreignClaimReleases([card], NOW);
  assert.equal(d.length, 1);
  assert.deepEqual([...d[0].releaseClaims].sort(), ["qa:in-progress", "ship:in-progress"]);
});
test("foreignClaimReleases: excludes ownClaim so the sweep's own reaper (with escalation) handles it", () => {
  const card = { id: "o", identifier: "COD-11", updatedAt: minsAgo(300), labelNames: ["qa:in-progress", "ship:in-progress"], comments: [] };
  const d = foreignClaimReleases([card], NOW, "qa:in-progress"); // processing the qa sweep's In Review cards
  assert.deepEqual(d[0].releaseClaims, ["ship:in-progress"]); // only the foreign ship claim, not qa's own
});
test("foreignClaimReleases: an unclaimed card is ignored; holding-state constants sane", () => {
  const card = { id: "u", identifier: "COD-9", updatedAt: minsAgo(300), labelNames: [], comments: [] };
  assert.deepEqual(foreignClaimReleases([card], NOW), []);
  assert.deepEqual(HOLDING_STATES, ["QA Passed"]); // the state qa lands in but no sweep fetches
  assert.equal(MAX_STALE_MIN, 120);
});

// ── env parsing ──────────────────────────────────────────────────────────────
test("parseEnv: strips quotes, ignores comments/blanks", () => {
  const e = parseEnv('# c\nLINEAR_API_KEY="lin_api_x"\nFOO=bar\n\n');
  assert.equal(e.LINEAR_API_KEY, "lin_api_x");
  assert.equal(e.FOO, "bar");
});

// ── manual unblock workflow helpers ─────────────────────────────────────────
test("blockingLabelsForIssue: detects only unblockable blocking labels", () => {
  assert.deepEqual(BLOCKING_LABELS, ["blocked:open-questions", "blocked:needs-user", "qa:needs-changes"]);
  const labels = ["Feature", "blocked:needs-user", "qa:passed", "qa:needs-changes"];
  assert.deepEqual(blockingLabelsForIssue(labels), ["blocked:needs-user", "qa:needs-changes"]);
});
test("normalizeBlockedIssue: captures anchor, active state, issue context, and newest blocking comment", () => {
  const issue = {
    id: "issue-id",
    identifier: "COD-9",
    title: "Blocked card",
    url: "https://linear.app/x/COD-9",
    updatedAt: "2026-07-08T10:00:00Z",
    state: { name: "Ready for Dev" },
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
  message: "spawn codex ENOENT lin_api_secret",
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
test("sanitizeFailureMessage: redacts Linear keys, common tokens, and supplied env values", () => {
  const msg = "LINEAR_API_KEY=lin_api_abc123 token ghp_deadbeef password shh path /tmp";
  const clean = sanitizeFailureMessage(msg, ["shh"]);
  assert.equal(clean.includes("lin_api_abc123"), false);
  assert.equal(clean.includes("ghp_deadbeef"), false);
  assert.equal(clean.includes("shh"), false);
  assert.match(clean, /\[REDACTED\]/);
});
test("failure Todo helpers include action, recovery condition, marker, and sanitized message", () => {
  const event = failureEvent();
  const fp = failureFingerprint(event);
  assert.equal(failureTodoTitle(event), "Scheduled sweep failure: linear-board-sweeps / dev / dispatch-start");
  const body = failureTodoBody(event, fp, { envValues: ["lin_api_secret"] });
  assert.match(body, /What failed:/);
  assert.match(body, /How to clear:/);
  assert.match(body, /Recovery condition:/);
  assert.match(body, new RegExp(`\\${FAILURE_TODO_TAG} ${fp}\\]`));
  assert.equal(body.includes("lin_api_secret"), false);
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
test("failureTodoDecisions: dispatch failures recover only after dispatch succeeds", () => {
  const event = failureEvent({ scope: "dev:dispatch" });
  const fp = failureFingerprint(event);
  const cheapCheck = failureTodoDecisions([], [existingFailureTodo(fp, { scope: "dev:dispatch" })], new Set(["dev"]), NOW);
  assert.deepEqual(cheapCheck, []);

  const dispatchCheck = failureTodoDecisions([], [existingFailureTodo(fp, { scope: "dev:dispatch" })], new Set(["dev:dispatch"]), NOW);
  assert.equal(dispatchCheck[0].action, "close");
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

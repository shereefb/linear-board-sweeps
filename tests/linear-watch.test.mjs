// Unit tests for the auto-sweep launcher's pure decision logic (node:test, zero-dep).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dependencyEligibility } from "../scripts/linear.mjs";
import {
  resolveRepos, resolveWorkspaceRepos, managedWorkspaceRootFor, workspaceRecordForSourceAnchor,
  normalizeRegistry, materializeManagedWorkspacePlan, materializeManagedWorkspace, syncAllowedEnvFiles,
  recoveredTargetsForManagedWorkspace, handoffDirtyCheckoutFailures,
  dirtyCheckoutEvent, doctorReport, formatDoctorReport,
  worktreePath, runtimeConfigForSweep, buildCommand, lockIsReclaimable, isNewerVersion,
  heartbeatAgeMin, countMarkers, reapDecisions, bounceDecisions, bouncePairKey,
  countActionable, actionableCards, applyDecisionsInMemory,
  boardOrderValue, sortByBoardPosition, selectDispatch, selectDispatchBatch, rotateNonShipCandidates,
  parallelLimit, sameRepoCardLimit, selectCardSlots, ownerToken, heartbeatOwner,
  drainPassLimit, runDrainLoop, maxSameRepoRefillDispatches, maxHandoffTriggerHops, nextSweepForHandoff, handoffTriggerKey,
  latestHeartbeatOwner, claimConfirmed, cardWorktreePath, cardRunPaths, withCardDispatchEnv,
  dryRunDispatchMessages, createChildIndexAllocator, createSameRepoActiveCounts,
  sameRepoAvailableSlots, expandDispatchBatch, buildSameRepoRefillDispatches, dispatchBatch, parseEnv, pushWithRetry, checkoutDispatchBlockers,
  fetchScheduledPassCards, fetchScheduledQueueCards,
  SWEEP_CFG, DEFAULT_MAX_NON_SHIP_DISPATCHES, DEFAULT_MAX_DRAIN_PASSES, MAX_DRAIN_PASSES,
  DEFAULT_MAX_SAME_REPO_REFILL_DISPATCHES, MAX_SAME_REPO_REFILL_DISPATCHES,
  DEFAULT_SAME_REPO_CARD_LIMITS, SAME_REPO_PORT_BASE,
  foreignClaimReleases, SWEEPS, SWEEP_ORDER, SKILL_DIRS, HOLDING_STATES,
  LEGACY_CLEANUP_STATES, CLAIM_CLEANUP_STATES, MAX_STALE_MIN,
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
const dependencyReadyCard = (card = {}) => ({ blockers: [], blockersComplete: true, ...card });

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
  fs.writeFileSync(path.join(source, ".env"), "LINEAR_API_KEY=lin_api_secret\n");
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
test("default configs use the stage-specific GPT-5.6 models", () => {
  const expected = {
    spec: { runtime: "codex", model: "gpt-5.6-sol", effort: "high" },
    dev: { runtime: "codex", model: "gpt-5.6-terra", effort: "high" },
    qa: { runtime: "codex", model: "gpt-5.6-sol", effort: "medium" },
    ship: { runtime: "codex", model: "gpt-5.6-terra", effort: "medium" },
  };
  for (const file of ["templates/linear-sweep.json", ".claude/linear-sweep.json"]) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const sweep of SWEEPS) {
      assert.deepEqual(runtimeConfigForSweep(config, sweep), expected[sweep], `${file} ${sweep}`);
      assert.deepEqual({ runtime: config.runtime, ...config.models[sweep] }, expected[sweep], `${file} legacy ${sweep}`);
    }
    assert.deepEqual(config.runtimes.review, { runtime: "claude", model: "claude-opus-4-8" }, `${file} review`);
  }
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
test("applyDecisionsInMemory: a reaped card becomes actionable; an escalated card does NOT", () => {
  // Two stale-claim cards: one plain reap, one hitting the 3rd reap (escalate-crash).
  const reapCard = dependencyReadyCard({ id: "r", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], comments: [] });
  const escCard = dependencyReadyCard({ id: "e", updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], comments: [
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
test("owner-token claim confirmation uses latest matching heartbeat owner", () => {
  const owner = ownerToken({ host: "host a", parentRunId: "run", issueIdentifier: "COD-5", slotIndex: 0 });
  assert.equal(owner, "host_a:run:COD-5:0");
  assert.equal(heartbeatOwner(`${HEARTBEAT_TAG} ${minsAgo(1)} owner=${owner}]`), owner);
  const card = dependencyReadyCard({
    id: "c",
    identifier: "COD-5",
    stateName: "Dev",
    labelNames: ["dev:in-progress"],
    comments: [
      { body: `${HEARTBEAT_TAG} ${minsAgo(3)} owner=other] dev:in-progress`, createdAt: minsAgo(3) },
      { body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=${owner}] dev:in-progress`, createdAt: minsAgo(1) },
    ],
  });
  assert.equal(latestHeartbeatOwner(card, "dev:in-progress"), owner);
  assert.equal(claimConfirmed(card, SWEEP_CFG.dev, owner, ["Dev"]), true);
  assert.equal(claimConfirmed({ ...card, stateName: "QA" }, SWEEP_CFG.dev, owner, ["Dev"]), false);
  assert.equal(claimConfirmed({ ...card, labelNames: ["dev:in-progress", "blocked:needs-user"] }, SWEEP_CFG.dev, owner, ["Dev"]), false);
});
test("claimConfirmed rejects a blocker added after scan", () => {
  const owner = ownerToken({ host: "host a", parentRunId: "run", issueIdentifier: "COD-5", slotIndex: 0 });
  const card = {
    id: "c",
    identifier: "COD-5",
    stateName: "Dev",
    labelNames: ["dev:in-progress"],
    comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=${owner} claim=dev:in-progress]`, createdAt: minsAgo(1) }],
    blockers: [{ identifier: "COD-1", stateName: "QA" }],
    blockersComplete: true,
  };
  assert.equal(claimConfirmed(card, SWEEP_CFG.dev, owner, ["Dev"]), false);
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
  assert.equal(claimConfirmed(card, SWEEP_CFG.dev, owner, ["Dev"]), false);
});

// ── dependency-aware queue snapshots ────────────────────────────────────────
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
            state: { name: "Spec" }, labels: { nodes: [] }, comments: { nodes: [] },
            inverseRelations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
          {
            id: "dev-id", identifier: "COD-2", updatedAt: minsAgo(1), sortOrder: 10,
            state: { name: "Dev" }, labels: { nodes: [] }, comments: { nodes: [] },
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

test("queue snapshot completes relation overflow before the card becomes eligible", async () => {
  const overflowCalls = [];
  const gqlFn = async () => ({
    issues: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        id: "dev-id", identifier: "COD-2", updatedAt: minsAgo(1), sortOrder: 10,
        state: { name: "Dev" }, labels: { nodes: [] }, comments: { nodes: [] },
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
        state: { name: "Dev" }, labels: { nodes: [] }, comments: { nodes: [] },
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
          state: { name: "Dev" }, labels: { nodes: [] }, comments: { nodes: [] },
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
  const paths = cardRunPaths("/ws/repo", { repos: ["repo"] }, "dev", { identifier: "COD-6", slotIndex: 1 }, "run-id", 2);
  assert.equal(paths.worktreePath, "/ws/repo/.worktrees/COD-6");
  assert.match(paths.logDir, /linear-board-sweeps\/repo\/dev\/COD-6$/);
  assert.match(paths.tmpDir, /linear-board-sweeps\/run-id\/dev-COD-6-2\/tmp$/);
  assert.equal(paths.portBase, 47020);
  const pick = withCardDispatchEnv({ anchorPath: "/ws/repo", config: { repos: ["repo"] }, sweep: "dev", issueIdentifier: "COD-6", slotIndex: 1 }, "run-id", 2);
  assert.equal(pick.childEnv.AUTO_SWEEP_ISSUE, "COD-6");
  assert.equal(pick.childEnv.AUTO_SWEEP_WORKTREE, "/ws/repo/.worktrees/COD-6");
  assert.equal(pick.childEnv.AUTO_SWEEP_APP_PORT, "47020");
  for (const key of ["AUTO_SWEEP_LOG_DIR", "AUTO_SWEEP_TMPDIR", "AUTO_SWEEP_SCREENSHOT_DIR", "AUTO_SWEEP_BROWSER_PROFILE_DIR"]) {
    assert.equal(pick.childEnv[key].startsWith("/ws/repo"), false, key);
  }
  assert.equal(pick.sameRepoLimit, 4);
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
        selectCardSlots(candidateCards, SWEEP_CFG[sweep], sweep, limit, NOW).map((slot) => ({ ...slot, ownerToken: `owner-${slot.identifier}` })),
      checkoutDispatchBlockers: () => [],
      logFor: (_anchorPath, _sweep, line) => logs.push(line),
    },
  });

  assert.deepEqual(result.dispatches.map((d) => d.issueIdentifier), ["COD-5"]);
  assert.equal(result.dispatches[0].triggeredBy.kind, "same-repo-refill");
  assert.equal(result.dispatches[0].triggeredBy.issue, "COD-4");
  assert.equal(result.dispatches[0].childEnv.AUTO_SWEEP_APP_PORT, "47040");
  assert.equal(refillBudget.remaining, 7);
  assert.match(logs.find((line) => line.includes("refill-trigger")), /COD-4: dev 1\/4/);
});
test("buildSameRepoRefillDispatches: budget, capacity, failed child, and ship suppress refill", async () => {
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
  assert.equal((await buildSameRepoRefillDispatches({
    ...base,
    refillBudget: { remaining: 1 },
    result: { ...base.result, pick: { ...base.result.pick, sweep: "ship" } },
  })).reason, "ship");

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
    { anchorPath: "/ws/a", config: { repos: ["a"] }, sweep: "qa", count: 1, topCard: { sortOrder: 30 } },
    { anchorPath: "/ws/b", config: { repos: ["b"] }, sweep: "dev", count: 1, topCard: { sortOrder: 20 } },
    { anchorPath: "/ws/c", config: { repos: ["c"] }, sweep: "dev", count: 1, topCard: { sortOrder: 10 } },
  ];
  const first = selectDispatchBatch(candidates, { maxNonShipDispatches: 2, rotationSeed: 0 });
  const rotated = selectDispatchBatch(candidates, { maxNonShipDispatches: 2, rotationSeed: 2 });
  assert.deepEqual(first.map((c) => c.anchorPath), ["/ws/a", "/ws/b"]);
  assert.deepEqual(rotated.map((c) => c.anchorPath), ["/ws/c", "/ws/a"]);
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
      ].map(dependencyReadyCard),
    },
  ]);
  assert.deepEqual(messages.map((m) => m.body), [
    "[dry-run] WOULD dispatch codex (2 actionable; top COD-8; sameRepoLimit=2)",
    "[dry-run] slot 1/2 dev COD-8 sortOrder=5",
    "[dry-run] slot 2/2 dev COD-7 sortOrder=1",
  ]);
});
test("dispatchBatch: dispatches every selected child and returns structured results", async () => {
  const calls = [];
  const results = await dispatchBatch([
    { anchorPath: "/ws/a", sweep: "dev", config: {}, issueIdentifier: "COD-1" },
    { anchorPath: "/ws/b", sweep: "spec", config: {} },
  ], {
    dispatchFn: async (anchorPath, sweep, config, pick) => {
      calls.push({ anchorPath, sweep, config, pick });
      return sweep === "dev" ? 0 : 7;
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
  const slow = new Promise((resolve) => { releaseSlow = () => resolve(7); });
  const seen = [];
  const run = dispatchBatch([
    { anchorPath: "/ws/fast", sweep: "dev", config: {}, issueIdentifier: "COD-1" },
    { anchorPath: "/ws/slow", sweep: "spec", config: {}, issueIdentifier: "COD-2" },
  ], {
    dispatchFn: async (anchorPath, sweep) => (sweep === "spec" ? slow : 0),
    onResult: async (result) => { seen.push(`${result.issueIdentifier}:${result.exitCode}`); },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["COD-1:0"]);
  releaseSlow();
  const results = await run;
  assert.deepEqual(seen, ["COD-1:0", "COD-2:7"]);
  assert.deepEqual(results.map((r) => r.exitCode), [0, 7]);
});

// ── ship sweep: config + dispatch priority ───────────────────────────────────
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
  const d = foreignClaimReleases([card], NOW, "qa:in-progress"); // processing the qa sweep's QA cards
  assert.deepEqual(d[0].releaseClaims, ["ship:in-progress"]); // only the foreign ship claim, not qa's own
});
test("foreignClaimReleases: an unclaimed card is ignored; holding-state constants sane", () => {
  const card = { id: "u", identifier: "COD-9", updatedAt: minsAgo(300), labelNames: [], comments: [] };
  assert.deepEqual(foreignClaimReleases([card], NOW), []);
  assert.deepEqual(HOLDING_STATES, ["Signoff"]); // the state qa lands in but no sweep fetches
  assert.deepEqual(LEGACY_CLEANUP_STATES, ["In Progress"]); // retired dev state still gets orphan cleanup
  assert.deepEqual(CLAIM_CLEANUP_STATES, ["Signoff", "In Progress"]);
  assert.equal(MAX_STALE_MIN, 120);
});
test("foreignClaimReleases: stale dev claim in legacy In Progress is released by cleanup pass", () => {
  const card = { id: "legacy", identifier: "COD-99", state: { name: "In Progress" }, updatedAt: minsAgo(300), labelNames: ["dev:in-progress"], comments: [] };
  const d = foreignClaimReleases([card], NOW);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].releaseClaims, ["dev:in-progress"]);
});

// ── env parsing ──────────────────────────────────────────────────────────────
test("parseEnv: strips quotes, ignores comments/blanks", () => {
  const e = parseEnv('# c\nLINEAR_API_KEY="lin_api_x"\nFOO=bar\n\n');
  assert.equal(e.LINEAR_API_KEY, "lin_api_x");
  assert.equal(e.FOO, "bar");
});

// ── manual unblock workflow helpers ─────────────────────────────────────────
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
test("failureTodoDecisions: dirty-checkout Todos recover when the stable target is clean even if dispatch scope was not selected", () => {
  const event = failureEvent({ scope: "dev:dispatch", kind: "dirty-checkout", stableTarget: "managed-anchor:/managed/app" });
  const fp = failureFingerprint(event);
  const todo = existingFailureTodo(fp, { scope: "dev:dispatch", description: failureTodoBody(event, fp) });

  assert.deepEqual(failureTodoDecisions([], [todo], new Set(["dev"]), NOW), []);
  const decisions = failureTodoDecisions([], [todo], new Set(["dev"]), NOW, { recoveredTargets: new Set(["managed-anchor:/managed/app"]) });
  assert.equal(decisions[0].action, "close");
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

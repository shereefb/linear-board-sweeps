// Unit tests for the auto-sweep launcher's pure decision logic (node:test, zero-dep).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dependencyEligibility } from "../scripts/linear.mjs";
import * as watchModule from "../scripts/linear-watch.mjs";
import {
  resolveRepos, resolveWorkspaceRepos, workspaceRepoPairs, resolveCardRepoRoute, routeCardsByRepo, managedWorkspaceRootFor, workspaceRecordForSourceAnchor,
  normalizeRegistry, materializeManagedWorkspacePlan, materializeManagedWorkspace, syncAllowedEnvFiles,
  recoveredTargetsForManagedWorkspace, handoffDirtyCheckoutFailures, handoffRepoRoutingDecision,
  dirtyCheckoutEvent, doctorReport, formatDoctorReport,
  worktreePath, runtimeConfigForSweep, resolveRuntimeExecutable, preflightRuntimeCandidates, buildCommand, lockIsReclaimable, isNewerVersion,
  heartbeatAgeMin, countMarkers, reapDecisions, bounceDecisions, bouncePairKey,
  countActionable, actionableCards, applyDecisionsInMemory,
  annotateBoundedDependencyCycles, dependencyCycleFailureEvents,
  boardOrderValue, sortByBoardPosition, selectDispatch, selectDispatchBatch, preflightAndSelectDispatchBatch, rotateNonShipCandidates,
  compareAdmissionDemand, createCapacityLedger, createAdmissionQueue, createObservationStore, createResourceSampler, dependencyDeferredIssue, admitDemand,
  runAdmissionDemands,
  parallelLimit, sameRepoCardLimit, selectCardSlots, ownerToken, heartbeatOwner,
  drainPassLimit, runDrainLoop, maxSameRepoRefillDispatches, maxHandoffTriggerHops, nextSweepForHandoff, handoffTriggerKey,
  latestHeartbeatOwner, claimConfirmed, cardWorktreePath, cardRunPaths, withCardDispatchEnv,
  dryRunDispatchMessages, createChildIndexAllocator, createSameRepoActiveCounts,
  sameRepoAvailableSlots, claimCardSlots, expandDispatchBatch, buildSameRepoRefillDispatches, classifyDispatchOutcome, runtimeDisabledByOutcome, createDispatchAbortContext, dispatchAsync, dispatchBatch, parseEnv, pushWithRetry, checkoutDispatchBlockers,
  admissionDemandsForCandidates,
  fetchScheduledPassCards, fetchScheduledQueueCards,
  SWEEP_CFG, DEFAULT_MAX_NON_SHIP_DISPATCHES, DEFAULT_MAX_DRAIN_PASSES, MAX_DRAIN_PASSES,
  DEFAULT_MAX_ACTIVE_CHILDREN, MAX_ACTIVE_CHILDREN,
  OBSERVATION_STATE_VERSION, OBSERVATION_RETENTION_MS, MAX_DEPENDENCY_DEFERRED_ISSUES,
  DEFAULT_MAX_SAME_REPO_REFILL_DISPATCHES, MAX_SAME_REPO_REFILL_DISPATCHES,
  DEFAULT_SAME_REPO_CARD_LIMITS, SAME_REPO_PORT_BASE,
  foreignClaimReleases, SWEEPS, SWEEP_ORDER, SKILL_DIRS, HOLDING_STATES,
  LEGACY_CLEANUP_STATES, CLAIM_CLEANUP_STATES, MAX_STALE_MIN,
  REAPER_TAG, BOUNCE_TAG, HEARTBEAT_TAG,
  BLOCKING_LABELS, MANUAL_SKILL_DIRS, PROPAGATED_SKILL_DIRS,
  UNBLOCK_STATE_ORDER, orderUnblockCards,
  blockingLabelsForIssue, normalizeBlockedIssue, labelIdsAfterRemoving,
  buildUnblockAuditComment, resolutionTextFromArgs, resolveBlockedIssue,
  FAILURE_TODO_TAG, failureFingerprint, sanitizeFailureMessage,
  failureTodoTitle, failureTodoBody, failureTodoDecisions, healthStatus, atomicWriteJson, finalizeTickState,
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

test("queue snapshot annotates a visible cycle and produces one deduplicated failure event for Todo and doctor", async () => {
  const node = (id, identifier, state, blockerId, blockerIdentifier, blockerState) => ({
    id, identifier, updatedAt: minsAgo(1), sortOrder: 10,
    state: { name: state }, labels: { nodes: [] }, comments: { nodes: [] },
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
  assert.equal(pick.childEnv.AUTO_SWEEP_KIT_PATH, path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  assert.equal(pick.childEnv.AUTO_SWEEP_SOURCE_ANCHOR, "/ws/repo");
  assert.equal(pick.childEnv.AUTO_SWEEP_WORKTREE, "/ws/repo/.worktrees/COD-6");
  assert.equal(pick.childEnv.AUTO_SWEEP_APP_PORT, "47020");
  for (const key of ["AUTO_SWEEP_LOG_DIR", "AUTO_SWEEP_TMPDIR", "AUTO_SWEEP_SCREENSHOT_DIR", "AUTO_SWEEP_BROWSER_PROFILE_DIR"]) {
    assert.equal(pick.childEnv[key].startsWith("/ws/repo"), false, key);
  }
  assert.equal(pick.sameRepoLimit, 4);
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
test("expandDispatchBatch: Ship receives the same card env and run-record paths as other stages", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-ship-env-"));
  const [pick] = await expandDispatchBatch([{
    anchorPath,
    sourceAnchorPath: "/source/repo",
    config: { repos: [anchorPath] },
    sweep: "ship",
    count: 1,
    topCard: dependencyReadyCard({ id: "ship-id", identifier: "COD-77", sortOrder: 10 }),
    issueId: "ship-id",
    issueIdentifier: "COD-77",
    ownerToken: "ship-owner",
  }], { dryRun: false, parentRunId: "ship-run", activeByAnchor: new Map(), now: NOW });
  assert.equal(pick.childEnv.AUTO_SWEEP_KIT_PATH, path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  assert.equal(pick.childEnv.AUTO_SWEEP_ISSUE, "COD-77");
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
  const recordName = fs.readdirSync(pick.logDir).find((name) => name.startsWith("run-records-"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(pick.logDir, recordName), "utf8")).issueIdentifier, "COD-77");
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
  }], {
    dryRun: false,
    parentRunId: "run-id",
    activeByAnchor: new Map([["/managed/coach", { apiKey: "key", repoPairs }]]),
    now: NOW,
    fetchRouteCardFn: async () => ({ id: "issue-id", identifier: "SAF-9", labelNames: ["app:coach"] }),
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
  }], {
    dryRun: false,
    parentRunId: "run-id",
    activeByAnchor: new Map([["/managed/coach", { apiKey: "key", repoPairs }]]),
    now: NOW,
    fetchRouteCardFn: async () => fresh,
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
    anchorPath: "/managed/guide", config, repoPairs, sweep: "ship", issueId: card.id, issueIdentifier: card.identifier, repoRoute, topCard: { ...card, repoRoute },
  }], {
    dryRun: false,
    parentRunId: "run-id",
    activeByAnchor: new Map([["/managed/guide", { apiKey: "key", repoPairs }]]),
    now: NOW,
    fetchRouteCardFn: async () => { throw new Error("Linear unavailable"); },
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
test("claimCardSlots: a post-claim route race removes only this attempt's owned claim", async () => {
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
  let heartbeatBody = "";
  const claimed = await claimCardSlots("key", "/managed/coach", config, "dev", [card], {
    parentRunId: "run-id",
    limit: 1,
    labelMap: { "dev:in-progress": "claim-id" },
    now: NOW,
    repoPairs,
  }, {
    fetchClaimCardFn: async () => ({ ...card }),
    applyLabelEditFn: async (_key, _card, edit) => edits.push(edit),
    addCommentFn: async (_key, _id, body) => { heartbeatBody = body; },
    sleepFn: async () => {},
    fetchCardFn: async () => dependencyReadyCard({
      ...card,
      labelNames: ["app:coach", "dev:in-progress"],
      comments: [{ body: heartbeatBody, createdAt: new Date(NOW).toISOString() }],
    }),
  });
  assert.deepEqual(claimed, []);
  assert.deepEqual(edits, [
    { add: { "dev:in-progress": "claim-id" } },
    { remove: ["dev:in-progress"] },
  ]);
});
test("claimCardSlots: a stable routed claim returns the confirmed primary repo", async () => {
  const config = { repos: ["guide"], repoRouting: { byLabel: { "app:guide": "guide" } } };
  const repoPairs = [{ repoEntry: "guide", sourceRepoPath: "/source/guide", managedRepoPath: "/managed/guide" }];
  const card = dependencyReadyCard({ id: "issue-id", identifier: "SAF-207", stateName: "Dev", labelNames: ["app:guide"], comments: [], updatedAt: minsAgo(1), sortOrder: 1 });
  card.repoRoute = resolveCardRepoRoute({ config, card, repoPairs });
  let heartbeatBody = "";
  const claimed = await claimCardSlots("key", "/managed/guide", config, "dev", [card], {
    parentRunId: "run-id",
    limit: 1,
    labelMap: { "dev:in-progress": "claim-id" },
    now: NOW,
    repoPairs,
  }, {
    fetchClaimCardFn: async () => ({ ...card }),
    applyLabelEditFn: async () => {},
    addCommentFn: async (_key, _id, body) => { heartbeatBody = body; },
    sleepFn: async () => {},
    fetchCardFn: async () => dependencyReadyCard({
      ...card,
      labelNames: ["app:guide", "dev:in-progress"],
      comments: [{ body: heartbeatBody, createdAt: new Date(NOW).toISOString() }],
    }),
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].repoRoute.managedRepoPath, "/managed/guide");
});

test("claimCardSlots: confirmation exceptions clean up only the claim owned by this attempt", async () => {
  assert.equal(typeof watchModule.claimCardSlots, "function");
  const edits = [];
  let reads = 0;
  let owner;
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-88", sortOrder: 10, labelNames: [], comments: [] });
  const result = await watchModule.claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run", limit: 1, labelMap: { "dev:in-progress": "label-dev" }, now: NOW,
  }, {
    applyLabelEditFn: async (_key, fresh, edit) => edits.push({ fresh, edit }),
    addCommentFn: async (_key, _id, body) => { owner = body.match(/owner=([^ ]+)/)?.[1]; },
    sleepFn: async () => {},
    fetchCardFn: async () => { reads += 1; throw new Error("confirmation unavailable"); },
    fetchClaimCardFn: async () => { reads += 1; return {
      ...card,
      labelNames: ["dev:in-progress"],
      comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=${owner} claim=dev:in-progress]`, createdAt: minsAgo(1) }],
    }; },
  });
  assert.deepEqual(result, []);
  assert.equal(reads, 2);
  assert.deepEqual(edits.at(-1).edit, { remove: ["dev:in-progress"] });
});

test("claimCardSlots: cleanup read/write failures remain truthful and never remove an unverified claim", async () => {
  assert.equal(typeof watchModule.claimCardSlots, "function");
  let removalAttempts = 0;
  let owner;
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-89", sortOrder: 10, labelNames: [], comments: [] });
  await assert.rejects(watchModule.claimCardSlots("key", "/managed", {}, "dev", [card], {
      parentRunId: "run", limit: 1, labelMap: { "dev:in-progress": "label-dev" }, now: NOW,
    }, {
      applyLabelEditFn: async (_key, _fresh, edit) => {
        if (edit.remove) { removalAttempts += 1; throw new Error("cleanup write unavailable"); }
      },
      addCommentFn: async (_key, _id, body) => { owner = body.match(/owner=([^ ]+)/)?.[1]; }, sleepFn: async () => {},
      fetchCardFn: async () => { throw new Error("confirmation unavailable"); },
      fetchClaimCardFn: async () => ({
        ...card,
        labelNames: ["dev:in-progress"],
        comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=${owner} claim=dev:in-progress]`, createdAt: minsAgo(1) }],
      }),
    }), (error) => error.code === "CLAIM_CLEANUP_UNVERIFIED" && /cleanup write unavailable/.test(error.message));
  assert.equal(removalAttempts, 1);
});

test("claimCardSlots: heartbeat creation failure surfaces an unprovable applied claim", async () => {
  let removals = 0;
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-92", sortOrder: 10, labelNames: [], comments: [] });
  await assert.rejects(watchModule.claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run", limit: 1, labelMap: { "dev:in-progress": "label-dev" }, now: NOW,
  }, {
    applyLabelEditFn: async (_key, _fresh, edit) => { if (edit.remove) removals += 1; },
    addCommentFn: async () => { throw new Error("heartbeat comment unavailable"); },
    sleepFn: async () => {},
    fetchClaimCardFn: async () => ({ ...card, labelNames: ["dev:in-progress"], comments: [] }),
  }), (error) => error.code === "CLAIM_CLEANUP_UNVERIFIED" && /ownership is not provable/.test(error.message));
  assert.equal(removals, 0);
});

test("claimCardSlots: another worker's latest owner is preserved and this attempt fails truthfully", async () => {
  let removals = 0;
  const card = dependencyReadyCard({ id: "issue-id", identifier: "COD-93", sortOrder: 10, labelNames: [], comments: [] });
  await assert.rejects(watchModule.claimCardSlots("key", "/managed", {}, "dev", [card], {
    parentRunId: "run", limit: 1, labelMap: { "dev:in-progress": "label-dev" }, now: NOW,
  }, {
    applyLabelEditFn: async (_key, _fresh, edit) => { if (edit.remove) removals += 1; },
    addCommentFn: async () => { throw new Error("heartbeat comment unavailable"); },
    sleepFn: async () => {},
    fetchClaimCardFn: async () => ({
      ...card,
      labelNames: ["dev:in-progress"],
      comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=other-worker claim=dev:in-progress]`, createdAt: minsAgo(1) }],
    }),
  }), (error) => error.code === "CLAIM_CLEANUP_UNVERIFIED" && /latest owner is other-worker/.test(error.message));
  assert.equal(removals, 0);
});

test("releaseOwnedDispatchClaim: dependency deferral removes only the matching owned claim", async () => {
  assert.equal(typeof watchModule.releaseOwnedDispatchClaim, "function");
  const edits = [];
  const fresh = {
    id: "issue-91", identifier: "COD-91", labelNames: ["dev:in-progress"],
    comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=owner-91 claim=dev:in-progress]`, createdAt: minsAgo(1) }],
  };
  const released = await watchModule.releaseOwnedDispatchClaim("key", {
    sweep: "dev", issueId: "issue-91", issueIdentifier: "COD-91", ownerToken: "owner-91",
  }, "dependency preflight deferred material work", {
    fetchClaimCardFn: async () => fresh,
    applyLabelEditFn: async (_key, _card, edit) => edits.push(edit),
    addCommentFn: async () => {},
  });
  assert.equal(released, true);
  assert.deepEqual(edits, [{ remove: ["dev:in-progress"] }]);

  assert.equal(await watchModule.releaseOwnedDispatchClaim("key", {
    sweep: "dev", issueId: "issue-91", issueIdentifier: "COD-91", ownerToken: "other-owner",
  }, "dependency deferred", { fetchClaimCardFn: async () => fresh }), false);
});
test("releaseOwnedDispatchClaim: successful completion only releases a claim while the card remains in the completed sweep", async () => {
  const edits = [];
  const base = {
    id: "issue-141",
    identifier: "COD-141",
    labelNames: ["dev:in-progress"],
    comments: [{ body: `${HEARTBEAT_TAG} ${minsAgo(1)} owner=owner-141 claim=dev:in-progress]`, createdAt: minsAgo(1) }],
  };
  const pick = { sweep: "dev", issueId: "issue-141", issueIdentifier: "COD-141", ownerToken: "owner-141" };

  assert.equal(await watchModule.releaseOwnedDispatchClaim("key", pick, "successful child stopped in Dev", {
    expectedStates: ["Dev"],
    fetchClaimCardFn: async () => ({ ...base, stateName: "Dev" }),
    applyLabelEditFn: async (_key, _card, edit) => edits.push(edit),
    addCommentFn: async () => {},
  }), true);
  assert.deepEqual(edits, [{ remove: ["dev:in-progress"] }]);

  assert.equal(await watchModule.releaseOwnedDispatchClaim("key", pick, "successful child advanced", {
    expectedStates: ["Dev"],
    fetchClaimCardFn: async () => ({ ...base, stateName: "QA" }),
    applyLabelEditFn: async () => { throw new Error("advanced claims must be left to the child/holding-state cleanup"); },
    addCommentFn: async () => {},
  }), false);
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

  assert.deepEqual(await watchModule.reconcileOwnedDispatchClaim("key", {
    kind: "exit",
    pick: { sweep: "dev", issueId: "issue-141", issueIdentifier: "COD-141", ownerToken: "owner-141" },
  }, "codex", {
    releaseOwnedDispatchClaimFn: async () => { throw new Error("ordinary child failures keep their claim for stale-run handling"); },
  }), { attempted: false, released: false, reasonKind: null });
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
  };
  assert.deepEqual(dryRunDispatchMessages([candidate]).slice(1).map((message) => message.body.match(/repo=([^ ]+)/)?.[1]), ["coach", "guide"]);
  const children = await expandDispatchBatch([candidate], { dryRun: true, parentRunId: "run-id", activeByAnchor: new Map(), now: NOW });
  assert.deepEqual(children.map((child) => child.issueIdentifier), ["SAF-1", "SAF-2"]);
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
test("dispatchAsync: child repository outcome prevents a superficially successful handoff", async () => {
  const anchorPath = fs.mkdtempSync(path.join(os.tmpdir(), "linear-route-outcome-"));
  const logDir = path.join(anchorPath, "logs");
  const outcomePath = path.join(anchorPath, "route-outcome.json");
  const child = new EventEmitter();
  child.pid = 503;
  const run = dispatchAsync(anchorPath, "dev", {}, {
    issueIdentifier: "SAF-207", issueId: "issue-207", ownerToken: "owner-207",
    logDir, outcomePath, runtimeExecutable: "/resolved/codex",
    childEnv: { AUTO_SWEEP_OUTCOME_PATH: outcomePath },
  }, { spawnFn: () => child });
  fs.writeFileSync(outcomePath, JSON.stringify({
    version: 1,
    kind: "repo-routing-deferred",
    issueIdentifier: "SAF-207",
    routeExitCode: 3,
    routing: { reason: "route-changed", expectedLabel: "app:guide", expectedRepoEntry: "guide", matches: [{ label: "app:coach", repoEntry: "coach" }] },
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

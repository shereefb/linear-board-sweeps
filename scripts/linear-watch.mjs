#!/usr/bin/env node
// Auto-sweep launcher for the linear-board-sweeps kit. Zero-dependency (Node 18+).
// See docs/superpowers/specs/2026-07-08-auto-sweep-launcher-design.md.
//
// Commands:
//   node linear-watch.mjs register <anchor-repo-path>     # add a workspace anchor
//   node linear-watch.mjs unregister <anchor-repo-path>
//   node linear-watch.mjs list                            # anchors + projectId + auto-sweep?
//   node linear-watch.mjs ship-runner [on|off]            # pin ship-sweep dispatch to THIS host
//   node linear-watch.mjs tick [--dry-run]                # one scheduled pass (launchd calls this)
//   node linear-watch.mjs health                          # last-tick age; non-zero exit if stale
//
// Design: an idle tick is a few cheap Linear API calls + a ff-only git pull and
// spends ZERO LLM tokens. Heavyweight agent passes are dispatched only when queues
// hold genuinely actionable work, capped to a bounded non-ship batch. Pure
// decision functions (reap/count/build/lock) are separated from IO so they can be
// unit-tested without Linear or git.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  dependencyEligibility,
  fetchIssueDependencies,
  gql,
  normalizeBlockingRelations,
  WORKFLOW_STATES,
} from "./linear.mjs";

// The kit root = two levels up from this script (KIT/scripts/linear-watch.mjs).
const KIT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── Paths & constants ────────────────────────────────────────────────────────

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".config", "linear-board-sweeps");
const REGISTRY_PATH = path.join(CONFIG_DIR, "registry.json");
const STATE_DIR = path.join(HOME, ".local", "state", "linear-board-sweeps");
const CACHE_DIR = path.join(HOME, ".cache", "linear-board-sweeps");
const TICK_LOCK = path.join(STATE_DIR, "tick.lock");
const CURRENT_TICK = path.join(STATE_DIR, "current-tick.json");
const LAST_TICK = path.join(STATE_DIR, "last-tick");
const CAPACITY_LEDGER = path.join(STATE_DIR, "capacity-ledger.json");
const OBSERVATIONS = path.join(STATE_DIR, "observations.json");
export const TICK_STATE_VERSION = 1;
export const CAPACITY_LEDGER_VERSION = 1;
export const OBSERVATION_STATE_VERSION = 1;
export const OBSERVATION_RETENTION_MS = 7 * 24 * 3600000;
export const MAX_DEPENDENCY_DEFERRED_ISSUES = 50;

export const INTERVAL_S = 600;
export const HEARTBEAT_TAG = "[auto-sweep-heartbeat";
export const REAPER_TAG = "[auto-sweep-reaper]"; // crash-reap audit marker — COUNTED by the escalate-crash counter
export const ORPHAN_TAG = "[auto-sweep-orphan]"; // foreign/orphan claim release — distinct so it doesn't inflate the crash count
export const PARK_TAG = "[auto-sweep-parked]"; // bounce-escalation park — distinct from REAPER_TAG and BOUNCE_TAG
export const BOUNCE_TAG = "[auto-sweep-bounce";
export const FAILURE_TODO_TAG = "[auto-sweep-tick-failure";
export const FAILURE_RECOVERED_TAG = "[auto-sweep-tick-recovered";
export const FAILURE_DUPLICATE_NOTE = "Duplicate auto-sweep failure Todo";
export const MANUAL_ONLY_LABEL = "sweep:manual-only";
export const CRASH_ESCALATE_AFTER = 3; // reaps within the window before blocking
export const BOUNCE_ESCALATE_AFTER = 2; // backward bounces within the window before blocking
export const ESCALATE_WINDOW_H = 48;
export const HEARTBEAT_MIN = 5;
export const LOG_RETENTION_DAYS = 14;
export const FAILURE_TODO_THROTTLE_MS = 24 * 3600000;
export const DEFAULT_MAX_NON_SHIP_DISPATCHES = 2;
export const DEFAULT_MAX_ACTIVE_CHILDREN = 10;
export const MAX_ACTIVE_CHILDREN = 32;
export const DEFAULT_MAX_DRAIN_PASSES = 5;
export const MAX_DRAIN_PASSES = 5;
export const DEFAULT_MAX_SAME_REPO_REFILL_DISPATCHES = 8;
export const MAX_SAME_REPO_REFILL_DISPATCHES = 20;
export const DEFAULT_SAME_REPO_CARD_LIMITS = { spec: 4, dev: 4, qa: 1, ship: 1 };
export const DEFAULT_MAX_HANDOFF_TRIGGER_HOPS = 2;
export const SAME_REPO_PORT_BASE = 47000;
export const CLAIM_CONFIRM_DELAY_MS = 1500;

// Per-sweep config. staleMin is the heartbeat-age backstop; it must exceed the
// longest NORMAL single-card run for that sweep. ship = merge + deploy + canary
// bake + docs, so it gets the same generous window as qa.
export const SWEEP_CFG = {
  spec: { states: [WORKFLOW_STATES.spec], claim: "spec:in-progress", blocked: ["blocked:open-questions", MANUAL_ONLY_LABEL], staleMin: 45 },
  dev: { states: [WORKFLOW_STATES.dev], claim: "dev:in-progress", blocked: ["blocked:needs-user", MANUAL_ONLY_LABEL], staleMin: 90 },
  qa: { states: [WORKFLOW_STATES.qa], claim: "qa:in-progress", blocked: ["qa:needs-changes", "blocked:needs-user", MANUAL_ONLY_LABEL], staleMin: 120 },
  ship: { states: [WORKFLOW_STATES.ship], claim: "ship:in-progress", blocked: ["blocked:needs-user", MANUAL_ONLY_LABEL], staleMin: 120 },
};
// Every list below derives from SWEEP_CFG so adding a sweep is a one-line change.
export const SWEEPS = Object.keys(SWEEP_CFG); // spec, dev, qa, ship — iteration order
// Dispatch priority: push the MOST-downstream work first (ship a blessed card
// before starting new QA, etc.). Explicit so it doesn't rely on indexOf(-1) luck.
export const SWEEP_ORDER = ["ship", "qa", "dev", "spec"];
// The kit skill directories the auto-updater propagates to anchors — one per sweep.
export const SKILL_DIRS = SWEEPS.map((s) => `${s}-sweep`);
// Human-invoked skills copied to anchors but never included in scheduled dispatch.
export const MANUAL_SKILL_DIRS = ["unblock-sweep"];
export const PROPAGATED_SKILL_DIRS = [...SKILL_DIRS, ...MANUAL_SKILL_DIRS];
// Holding states can carry a stale claim but are fetched by NO sweep (a sweep's
// own states are reaped in the main loop). qa moves a card to "Signoff" and
// then drops qa:in-progress; a crash between those strands the claim here.
export const HOLDING_STATES = [WORKFLOW_STATES.signoff];
// Legacy workflow states no sweep fetches after retirement, but which may still
// carry old claim labels from previous runs or manual board moves.
export const LEGACY_CLEANUP_STATES = [WORKFLOW_STATES.legacyInProgress];
export const CLAIM_CLEANUP_STATES = [...HOLDING_STATES, ...LEGACY_CLEANUP_STATES];
export const ALL_CLAIMS = SWEEPS.map((s) => SWEEP_CFG[s].claim);
export const MAX_STALE_MIN = Math.max(...SWEEPS.map((s) => SWEEP_CFG[s].staleMin));

const AUTO_SWEEP_LABEL = "auto-sweep";

function unattendedPrompt(sweep, issueIdentifier = null) {
  if (issueIdentifier) {
    return `Unattended scheduled run. Follow the ${sweep}-sweep skill exactly for ${issueIdentifier} only. Do not process other cards. Do not ask questions — route them to card comments per the skill.`;
  }
  return `Unattended scheduled run. Follow the ${sweep}-sweep skill exactly, perform ONE pass, then stop. Do not ask questions — route them to card comments per the skill.`;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

function stablePathSlug(p) {
  const resolved = path.resolve(p || ".");
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, "-") || "workspace";
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

export function managedWorkspaceRootFor(sourceAnchorPath, { homeDir = HOME } = {}) {
  return path.join(homeDir, ".local", "share", "linear-board-sweeps", "workspaces", stablePathSlug(sourceAnchorPath));
}

function defaultRegistry() {
  return { autoUpdate: true, kitPath: null, kitRef: "main", kitRemote: null, shipRunner: false, capacity: { maxActiveChildren: DEFAULT_MAX_ACTIVE_CHILDREN }, repos: [], managedAnchors: {} };
}

export function normalizeRegistry(reg = {}, { now = () => new Date().toISOString(), homeDir = HOME } = {}) {
  const out = { ...defaultRegistry(), ...(reg || {}) };
  out.repos = Array.isArray(out.repos) ? [...out.repos] : [];
  out.kitRef = out.kitRef || "main";
  out.shipRunner = out.shipRunner === true;
  const rawCapacity = out.capacity?.maxActiveChildren;
  const configuredCapacity = rawCapacity === null || rawCapacity === "" ? Number.NaN : Number(rawCapacity);
  out.capacity = {
    ...(out.capacity && typeof out.capacity === "object" ? out.capacity : {}),
    maxActiveChildren: Number.isFinite(configuredCapacity)
      ? Math.min(MAX_ACTIVE_CHILDREN, Math.max(1, Math.floor(configuredCapacity)))
      : DEFAULT_MAX_ACTIVE_CHILDREN,
  };
  out.managedAnchors = { ...(out.managedAnchors || {}) };
  for (const sourceAnchorPath of out.repos) {
    const existing = out.managedAnchors[sourceAnchorPath] || {};
    const managedWorkspaceRoot = existing.managedWorkspaceRoot || managedWorkspaceRootFor(sourceAnchorPath, { homeDir });
    const stamp = now();
    out.managedAnchors[sourceAnchorPath] = {
      sourceAnchorPath,
      managedWorkspaceRoot,
      managedAnchorPath: existing.managedAnchorPath || path.join(managedWorkspaceRoot, path.basename(sourceAnchorPath)),
      repoMap: existing.repoMap || {},
      createdAt: existing.createdAt || stamp,
      updatedAt: existing.updatedAt || stamp,
    };
  }
  for (const key of Object.keys(out.managedAnchors)) {
    if (!out.repos.includes(key)) delete out.managedAnchors[key];
  }
  return out;
}

export function workspaceRecordForSourceAnchor(sourceAnchorPath, reg = {}) {
  return normalizeRegistry(reg).managedAnchors?.[sourceAnchorPath] || null;
}

// Resolve config.repos to absolute paths. Folder names resolve under the
// workspace root (the anchor's parent); absolute or ./ ../ entries are used as-is.
export function resolveRepos(anchorPath, config) {
  return resolveWorkspaceRepos(anchorPath, config, { mode: "source" });
}

export function resolveWorkspaceRepos(anchorPath, config, { mode = "source", workspaceRecord = null } = {}) {
  const workspaceRoot = path.dirname(anchorPath);
  const entries = Array.isArray(config?.repos) && config.repos.length ? config.repos : [path.basename(anchorPath)];
  return entries.map((entry) => {
    let sourcePath;
    if (path.isAbsolute(entry)) sourcePath = entry;
    else if (entry.startsWith("./") || entry.startsWith("../")) sourcePath = path.resolve(anchorPath, entry);
    else sourcePath = path.join(workspaceRoot, entry);
    if (mode !== "managed") return { name: path.basename(sourcePath), path: sourcePath, sourcePath };

    if (!workspaceRecord) throw new Error("managed workspace resolution requires workspaceRecord");
    const mapped = workspaceRecord.repoMap?.[sourcePath]?.managedPath;
    const managedPath = mapped
      || (path.resolve(sourcePath) === path.resolve(workspaceRecord.sourceAnchorPath)
        ? workspaceRecord.managedAnchorPath
        : path.join(workspaceRecord.managedWorkspaceRoot, stablePathSlug(sourcePath)));
    return { name: path.basename(managedPath), path: managedPath, sourcePath };
  });
}

export function materializeManagedWorkspacePlan({
  sourceAnchorPath,
  config,
  workspaceRecord,
  existsFn = fs.existsSync,
  gitFn = git,
} = {}) {
  const record = workspaceRecord || { sourceAnchorPath, managedWorkspaceRoot: managedWorkspaceRootFor(sourceAnchorPath), managedAnchorPath: path.join(managedWorkspaceRootFor(sourceAnchorPath), path.basename(sourceAnchorPath)), repoMap: {} };
  const sourceRepos = resolveWorkspaceRepos(sourceAnchorPath, config, { mode: "source" });
  const managedRepos = resolveWorkspaceRepos(sourceAnchorPath, config, { mode: "managed", workspaceRecord: record });
  const nextRecord = { ...record, repoMap: { ...(record.repoMap || {}) }, updatedAt: new Date().toISOString() };
  const operations = [];
  const blockers = [];

  for (let i = 0; i < sourceRepos.length; i += 1) {
    const source = sourceRepos[i];
    const managed = managedRepos[i];
    const remote = gitFn(source.path, ["remote", "get-url", "origin"], { allowFail: true });
    nextRecord.repoMap[source.path] = { sourcePath: source.path, managedPath: managed.path, remote: remote.out || record.repoMap?.[source.path]?.remote || null };
    if (remote.status !== 0 || !remote.out) {
      blockers.push({ kind: "missing-origin", sourcePath: source.path, managedPath: managed.path, message: `source repo ${source.path} has no origin remote` });
      continue;
    }
    if (!existsFn(managed.path)) {
      operations.push({ action: "clone", sourcePath: source.path, managedPath: managed.path, remote: remote.out });
      continue;
    }
    const role = path.resolve(managed.path) === path.resolve(record.managedAnchorPath) ? "managed-anchor" : "managed-repo";
    const dirty = dirtyCheckoutEvent({ sweep: "setup" }, { role, path: managed.path }, { gitFn });
    if (dirty) {
      blockers.push({ kind: dirty.kind, sourcePath: source.path, managedPath: managed.path, stableTarget: `${role}:${managed.path}`, message: dirty.message });
      continue;
    }
    operations.push({ action: "fast-forward", sourcePath: source.path, managedPath: managed.path, remote: remote.out });
  }

  return { ok: blockers.length === 0, record: nextRecord, operations, blockers };
}

export function syncAllowedEnvFiles(sourceRepo, managedRepo, {
  allowed = [".env"],
  gitFn = git,
  copyFn = fs.copyFileSync,
  chmodFn = fs.chmodSync,
  existsFn = fs.existsSync,
} = {}) {
  const copied = [];
  for (const file of allowed) {
    const source = path.join(sourceRepo, file);
    if (!existsFn(source)) continue;
    const ignored = gitFn(sourceRepo, ["check-ignore", "-q", file], { allowFail: true });
    if (ignored.status !== 0) continue;
    const dest = path.join(managedRepo, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyFn(source, dest);
    chmodFn(dest, 0o600);
    copied.push(file);
  }
  return copied;
}

export function materializeManagedWorkspace({
  sourceAnchorPath,
  config,
  workspaceRecord,
  existsFn = fs.existsSync,
  mkdirFn = (p) => fs.mkdirSync(p, { recursive: true }),
  gitFn = git,
  syncEnvFn = syncAllowedEnvFiles,
} = {}) {
  const plan = materializeManagedWorkspacePlan({ sourceAnchorPath, config, workspaceRecord, existsFn, gitFn });
  if (!plan.ok) return plan;

  mkdirFn(plan.record.managedWorkspaceRoot);
  for (const op of plan.operations) {
    if (op.action === "clone") {
      mkdirFn(path.dirname(op.managedPath));
      const clone = gitFn(path.dirname(op.managedPath), ["clone", op.remote, op.managedPath], { allowFail: true });
      if (clone.status !== 0) {
        return { ...plan, ok: false, blockers: [{ kind: "clone-failed", sourcePath: op.sourcePath, managedPath: op.managedPath, message: clone.err || `clone exited ${clone.status}` }] };
      }
    } else if (op.action === "fast-forward") {
      const fetch = gitFn(op.managedPath, ["fetch", "origin"], { allowFail: true });
      if (fetch.status !== 0) {
        return { ...plan, ok: false, blockers: [{ kind: "fetch-failed", sourcePath: op.sourcePath, managedPath: op.managedPath, message: fetch.err || `fetch exited ${fetch.status}` }] };
      }
      const branch = gitFn(op.managedPath, ["symbolic-ref", "--short", "HEAD"], { allowFail: true }).out || "main";
      const merge = gitFn(op.managedPath, ["merge", "--ff-only", `origin/${branch}`], { allowFail: true });
      if (merge.status !== 0) {
        return { ...plan, ok: false, blockers: [{ kind: "fast-forward-failed", sourcePath: op.sourcePath, managedPath: op.managedPath, message: merge.err || `merge exited ${merge.status}` }] };
      }
    }
    syncEnvFn(op.sourcePath, op.managedPath);
  }

  return plan;
}

// Deterministic worktree path so any machine rebuilds the same tree from a card.
export function worktreePath(repoPath, branch) {
  return path.join(repoPath, ".worktrees", branch);
}

export function runtimeConfigForSweep(config = {}, sweep) {
  const stageCfg = config?.runtimes && config.runtimes[sweep];
  if (stageCfg && typeof stageCfg === "object") {
    return {
      runtime: stageCfg.runtime || config.runtime || "codex",
      model: stageCfg.model,
      effort: stageCfg.effort,
    };
  }
  const modelCfg = (config?.models && config.models[sweep]) || {};
  return {
    runtime: config?.runtime || "codex",
    model: modelCfg.model,
    effort: modelCfg.effort,
  };
}

function whichRuntime(runtime, env) {
  const result = spawnSync("/usr/bin/which", [runtime], { env, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function resolveRuntimeExecutable(runtime, env = process.env, {
  existsFn = fs.existsSync,
  whichFn = whichRuntime,
} = {}) {
  const name = runtime || "codex";
  const override = env?.[`${name.toUpperCase()}_BIN`];
  if (override) {
    const candidate = path.resolve(override);
    if (existsFn(candidate)) return { ok: true, runtime: name, path: candidate, source: "override" };
  }

  const fromPath = whichFn(name, env || {});
  if (fromPath) return { ok: true, runtime: name, path: path.resolve(fromPath), source: "path" };

  if (name === "codex") {
    for (const candidate of [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ]) {
      if (existsFn(candidate)) return { ok: true, runtime: name, path: candidate, source: "application" };
    }
  }

  return { ok: false, runtime: name, code: "ENOENT", path: null, source: null };
}

function runtimeLaneKey(anchorPath, runtime, host) {
  return `${path.resolve(anchorPath || ".")}\0${runtime}\0${host}`;
}

export function preflightRuntimeCandidates(candidates, {
  host = os.hostname(),
  cache = new Map(),
  envForCandidate = () => process.env,
  resolveFn = resolveRuntimeExecutable,
} = {}) {
  const ready = [];
  const failures = [];
  for (const pick of candidates || []) {
    const runtime = runtimeConfigForSweep(pick.config || {}, pick.sweep).runtime || "codex";
    const sourceAnchorPath = pick.sourceAnchorPath || pick.anchorPath;
    const key = runtimeLaneKey(sourceAnchorPath, runtime, host);
    let resolution = cache.get(key);
    if (!resolution) {
      resolution = resolveFn(runtime, envForCandidate(pick));
      cache.set(key, resolution);
    }
    const scope = `runtime:${runtime}:${host}`;
    const stableTarget = JSON.stringify({ sourceAnchorPath, runtime, host });
    if (resolution.ok) ready.push({
      ...pick,
      runtimeExecutable: resolution.path,
      runtimeLaneKey: key,
      runtimeScope: scope,
      runtimeStableTarget: stableTarget,
    });
    else failures.push({ pick, runtime, host, key, scope, stableTarget, resolution });
  }
  return { ready, failures, cache };
}

export function runtimeSummary({ runtime, model, effort } = {}) {
  const parts = [runtime || "codex"];
  if (model) parts.push(model);
  if (effort) parts.push(`effort=${effort}`);
  return parts.join(" / ");
}

// Build the runtime command for one unattended pass. Omitted model/effort ⇒ no
// flag emitted (fall back to the runtime's own default).
export function buildCommand({ runtime, sweep, model, effort, anchorPath, issueIdentifier = null }) {
  const prompt = unattendedPrompt(sweep, issueIdentifier);
  if (runtime === "claude") {
    const args = ["-p", prompt];
    if (model) args.push("--model", model);
    // NOTE: Claude Code reasoning-effort flag to be confirmed against the CLI;
    // effort is currently not emitted for claude (codex is the primary runtime).
    return { cmd: "claude", args, cwd: anchorPath };
  }
  // default: codex
  const args = ["exec", "--cd", anchorPath];
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
  args.push(prompt);
  return { cmd: "codex", args, cwd: anchorPath };
}

// True when a lock held by `lockData.pid` may be reclaimed: no pid, or the pid is
// provably dead. A live (or unknown-but-present) pid is NOT reclaimable.
export function lockIsReclaimable(lockData, { isAlive }) {
  if (!lockData || !lockData.pid) return true;
  return !isAlive(lockData.pid);
}

export function isAlivePid(pid) {
  try {
    process.kill(pid, 0);
    return true; // signal delivered ⇒ alive
  } catch (e) {
    if (e.code === "EPERM") return true; // exists but owned by another user
    return false; // ESRCH ⇒ no such process
  }
}

// Kit newer than installed? Markers are opaque strings (VERSION or a git SHA);
// "newer" == "different and non-empty kit marker".
export function isNewerVersion(kitMarker, installedMarker) {
  if (!kitMarker) return false;
  return kitMarker !== installedMarker;
}

// Heartbeat age in minutes: newest [auto-sweep-heartbeat <ISO>] comment, else
// fall back to the card's updatedAt (the claim label bumped it).
export function heartbeatAgeMin(card, now) {
  const beats = (card.comments || [])
    .map((c) => {
      const i = (c.body || "").indexOf(HEARTBEAT_TAG);
      if (i < 0) return null;
      const iso = (c.body.slice(i + HEARTBEAT_TAG.length).match(/\s*([0-9TZ:+\-.]+)/) || [])[1];
      const t = iso ? Date.parse(iso) : Date.parse(c.createdAt);
      return Number.isNaN(t) ? null : t;
    })
    .filter((t) => t !== null);
  const latest = beats.length ? Math.max(...beats) : Date.parse(card.updatedAt);
  return (now - latest) / 60000;
}

// Count marker comments containing `tag` created within the rolling window.
export function countMarkers(card, tag, now, windowH = ESCALATE_WINDOW_H) {
  const cutoff = now - windowH * 3600000;
  return (card.comments || []).filter((c) => (c.body || "").includes(tag) && Date.parse(c.createdAt) >= cutoff).length;
}

const hasLabel = (card, name) => (card.labelNames || []).includes(name);

function liveClaimLabel(card, now, releasedIds = new Set()) {
  if (releasedIds.has(card.id)) return null;
  return ALL_CLAIMS.find((claim) => {
    if (!hasLabel(card, claim)) return false;
    const owner = SWEEPS.find((s) => SWEEP_CFG[s].claim === claim);
    const staleMin = owner ? SWEEP_CFG[owner].staleMin : MAX_STALE_MIN;
    return heartbeatAgeMin(card, now) <= staleMin;
  }) || null;
}

// Decide reaping/escalation for one (workspace, sweep). Pure: returns actions;
// the caller executes them against Linear.
export function reapDecisions(cards, cfg, now) {
  const out = [];
  for (const card of cards) {
    if (!hasLabel(card, cfg.claim)) continue;
    if (heartbeatAgeMin(card, now) <= cfg.staleMin) continue; // fresh/alive
    const priorReaps = countMarkers(card, REAPER_TAG, now);
    if (priorReaps + 1 >= CRASH_ESCALATE_AFTER) {
      out.push({ id: card.id, identifier: card.identifier, action: "escalate-crash", releaseClaim: cfg.claim, count: priorReaps + 1 });
    } else {
      out.push({ id: card.id, identifier: card.identifier, action: "reap", releaseClaim: cfg.claim });
    }
  }
  return out;
}

// Release stale claims that no per-sweep reaper will handle: a claim stranded in
// a HOLDING state (no sweep fetches it — e.g. qa:in-progress left in "Signoff"),
// or a FOREIGN claim in a sweep's state (a sweep reaps only its OWN cfg.claim, so
// e.g. a ship:in-progress dragged into "QA" is invisible to qa's reaper).
// Batches ALL of a card's releasable claims into ONE decision so a single write
// clears them together — releasing per-claim with full-set overwrites would
// re-add earlier removals. `ownClaim` (a sweep's cfg.claim, or null in a holding
// state) is left to that sweep's own reaper (which also escalates). Uses
// MAX_STALE_MIN: a live run of the owning sweep can't be sitting in this state,
// so the conservative threshold never false-releases a live claim. Pure.
export function foreignClaimReleases(cards, now, ownClaim = null, claims = ALL_CLAIMS, staleMin = MAX_STALE_MIN) {
  const out = [];
  for (const card of cards) {
    if (heartbeatAgeMin(card, now) <= staleMin) continue; // a live run may be mid-transition
    const releaseClaims = claims.filter((c) => c !== ownClaim && hasLabel(card, c));
    if (releaseClaims.length) out.push({ id: card.id, identifier: card.identifier, action: "reap-orphan", releaseClaims });
  }
  return out;
}

// Extract the unordered state-pair from a `[auto-sweep-bounce <from>→<to>]`
// marker body (null if not a bounce marker). Unordered so A→B and B→A count as
// the same oscillating pair.
export function bouncePairKey(body) {
  const i = (body || "").indexOf(BOUNCE_TAG);
  if (i < 0) return null;
  const m = body.slice(i + BOUNCE_TAG.length).match(/\s*(.+?)→(.+?)\]/);
  if (!m) return null;
  return [m[1].trim(), m[2].trim()].sort().join(" ⇄ ");
}

// Backward-bounce escalation (SKILLs write [auto-sweep-bounce <from>→<to>] on a
// backward move). Escalate only when the SAME state-pair oscillates ≥ threshold
// times in the window — two unrelated backward moves (dev→spec once, qa→dev once)
// must NOT trip it.
export function bounceDecisions(cards, cfg, now, windowH = ESCALATE_WINDOW_H) {
  const out = [];
  const cutoff = now - windowH * 3600000;
  for (const card of cards) {
    if (hasLabel(card, "blocked:needs-user")) continue; // already parked
    const perPair = new Map();
    for (const c of card.comments || []) {
      if (Date.parse(c.createdAt) < cutoff) continue;
      const key = bouncePairKey(c.body || "");
      if (key) perPair.set(key, (perPair.get(key) || 0) + 1);
    }
    if ([...perPair.values()].some((n) => n >= BOUNCE_ESCALATE_AFTER)) {
      out.push({ id: card.id, identifier: card.identifier, action: "escalate-bounce" });
    }
  }
  return out;
}

// The actionable subset: not blocked, and not owned by a live run. releasedIds =
// cards whose claim was just released this tick (they become actionable again).
export function actionableCards(cards, cfg, now, releasedIds = new Set()) {
  return cards.filter((card) => {
    if ((cfg.blocked || []).some((b) => hasLabel(card, b))) return false; // blocked
    if (!dependencyEligibility(card.blockers, card.blockersComplete === true).eligible) return false;
    const liveClaim = liveClaimLabel(card, now, releasedIds);
    return !liveClaim; // exclude cards owned by a live run
  });
}
export function countActionable(cards, cfg, now, releasedIds = new Set()) {
  return actionableCards(cards, cfg, now, releasedIds).length;
}

export function dependencyDeferredIssue({ sourceWorkspace, sweep, card = {}, dependency = {} } = {}) {
  return {
    sourceWorkspace,
    sweep,
    issueIdentifier: card.identifier,
    reason: dependency.reason,
    blockers: (dependency.unresolved || []).slice(0, MAX_DEPENDENCY_DEFERRED_ISSUES).map((blocker) => ({
      identifier: blocker.identifier || blocker.id || "unknown",
      stateName: blocker.stateName || "unknown",
    })),
  };
}

// Linear's Issue.sortOrder is the board-rank field for a card within its
// workflow state. Higher values render closer to the top of the column.
export function boardOrderValue(card) {
  return Number.isFinite(card?.sortOrder) ? card.sortOrder : Number.NEGATIVE_INFINITY;
}

export function sortByBoardPosition(cards) {
  return [...cards].sort((a, b) => {
    const d = boardOrderValue(b) - boardOrderValue(a);
    if (d !== 0) return d;
    return String(a.identifier || a.id || "").localeCompare(String(b.identifier || b.id || ""));
  });
}

const ADMISSION_STAGE_ORDER = new Map(SWEEP_ORDER.map((stage, index) => [stage, index]));

export function compareAdmissionDemand(a = {}, b = {}) {
  const aStage = a.stage || a.sweep || "";
  const bStage = b.stage || b.sweep || "";
  const stageOrder = (ADMISSION_STAGE_ORDER.get(aStage) ?? SWEEP_ORDER.length)
    - (ADMISSION_STAGE_ORDER.get(bStage) ?? SWEEP_ORDER.length);
  if (stageOrder !== 0) return stageOrder;

  const handoffOrder = Number((b.trigger || "initial") === "handoff")
    - Number((a.trigger || "initial") === "handoff");
  if (handoffOrder !== 0) return handoffOrder;

  const boardOrder = boardOrderValue({ sortOrder: b.boardOrder ?? b.topSortOrder ?? b.topCard?.sortOrder })
    - boardOrderValue({ sortOrder: a.boardOrder ?? a.topSortOrder ?? a.topCard?.sortOrder });
  if (boardOrder !== 0) return boardOrder;

  const rotationOrder = (Number.isFinite(Number(a.rotationRank)) ? Number(a.rotationRank) : Number.MAX_SAFE_INTEGER)
    - (Number.isFinite(Number(b.rotationRank)) ? Number(b.rotationRank) : Number.MAX_SAFE_INTEGER);
  if (rotationOrder !== 0) return rotationOrder;
  return String(a.issueIdentifier || a.topCard?.identifier || "")
    .localeCompare(String(b.issueIdentifier || b.topCard?.identifier || ""));
}

// Reflect this tick's reap/bounce decisions on the in-memory cards so the
// actionable count is correct: a reaped card loses its claim (actionable again);
// an escalated card (crash or bounce) gains blocked:needs-user (not actionable).
export function applyDecisionsInMemory(cards, reaps, bounces) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const d of reaps) {
    const card = byId.get(d.id);
    if (!card) continue;
    card.labelNames = (card.labelNames || []).filter((n) => n !== d.releaseClaim);
    if (d.action === "escalate-crash" && !card.labelNames.includes("blocked:needs-user")) card.labelNames.push("blocked:needs-user");
  }
  for (const d of bounces) {
    const card = byId.get(d.id);
    if (card && !(card.labelNames || []).includes("blocked:needs-user")) card.labelNames = [...(card.labelNames || []), "blocked:needs-user"];
  }
}

function rankedDispatchCandidates(candidates) {
  return candidates
    .filter((c) => c.count > 0)
    .sort((a, b) => {
      const so = SWEEP_ORDER.indexOf(a.sweep) - SWEEP_ORDER.indexOf(b.sweep);
      if (so !== 0) return so;
      return boardOrderValue(b.topCard || { sortOrder: b.topSortOrder }) - boardOrderValue(a.topCard || { sortOrder: a.topSortOrder });
    });
}

export function parallelLimit(config) {
  const raw = config?.parallel?.maxNonShipDispatches;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_NON_SHIP_DISPATCHES;
}

export function sameRepoCardLimit(config, sweep) {
  if (sweep === "ship") return 1;
  const defaults = DEFAULT_SAME_REPO_CARD_LIMITS;
  const fallback = defaults[sweep] || 1;
  const raw = config?.parallel?.sameRepoCardLimits?.[sweep];
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function maxHandoffTriggerHops(config) {
  const raw = config?.parallel?.maxHandoffTriggerHops;
  if (raw === undefined || raw === null) return DEFAULT_MAX_HANDOFF_TRIGGER_HOPS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_MAX_HANDOFF_TRIGGER_HOPS;
  return Math.max(0, Math.min(3, n));
}

export function drainPassLimit(configs = []) {
  const values = (Array.isArray(configs) ? configs : [configs])
    .map((config) => config?.parallel?.maxDrainPasses)
    .filter((value) => value !== undefined)
    .map((value) => Number(value))
    .filter(Number.isFinite);
  if (!values.length) return DEFAULT_MAX_DRAIN_PASSES;
  const n = Math.floor(Math.max(...values));
  return Math.min(MAX_DRAIN_PASSES, Math.max(1, n));
}

export function maxSameRepoRefillDispatches(configs = []) {
  const values = (Array.isArray(configs) ? configs : [configs])
    .map((config) => config?.parallel?.maxSameRepoRefillDispatches)
    .filter((value) => value !== undefined)
    .map((value) => {
      if (value === null) return DEFAULT_MAX_SAME_REPO_REFILL_DISPATCHES;
      const n = Number(value);
      return Number.isFinite(n) ? n : DEFAULT_MAX_SAME_REPO_REFILL_DISPATCHES;
    });
  if (!values.length) return DEFAULT_MAX_SAME_REPO_REFILL_DISPATCHES;
  const n = Math.floor(Math.max(...values));
  return Math.min(MAX_SAME_REPO_REFILL_DISPATCHES, Math.max(0, n));
}

export async function runDrainLoop({ maxDrainPasses = DEFAULT_MAX_DRAIN_PASSES, runPass, log = () => {} } = {}) {
  const limit = drainPassLimit({ parallel: { maxDrainPasses } });
  const passes = [];
  for (let pass = 1; pass <= limit; pass += 1) {
    const result = await runPass(pass);
    passes.push(result);
    const selectedCount = result?.selectedBatch?.length || 0;
    if (!selectedCount) return { passes, budgetExhausted: false };
    if (result?.continueDraining === false) return { passes, budgetExhausted: false };
    if (pass === limit) {
      log(`drain budget exhausted after ${limit} pass(es); ${selectedCount} selected dispatch(es) in the final pass`);
      return { passes, budgetExhausted: true };
    }
  }
  return { passes, budgetExhausted: false };
}

export function nextSweepForHandoff({ completedSweep, currentStateName, sweepCfg = SWEEP_CFG } = {}) {
  if (completedSweep === "spec" && (sweepCfg.dev?.states || []).includes(currentStateName)) return "dev";
  if (completedSweep === "dev" && (sweepCfg.qa?.states || []).includes(currentStateName)) return "qa";
  return null;
}

export function handoffTriggerKey(issueIdentifier, fromSweep, toSweep) {
  return `${issueIdentifier || "_"}:${fromSweep || "_"}->${toSweep || "_"}`;
}

export function selectCardSlots(cards, cfg, sweep, limit, now) {
  const n = Math.max(1, Math.floor(Number(limit)) || 1);
  return sortByBoardPosition(actionableCards(cards || [], cfg, now))
    .slice(0, n)
    .map((card, slotIndex) => ({
      id: card.id,
      identifier: card.identifier,
      sortOrder: card.sortOrder,
      sweep,
      slotIndex,
      card,
    }));
}

export function ownerToken({ host = os.hostname(), parentRunId, issueIdentifier, slotIndex }) {
  return [host, parentRunId, issueIdentifier, slotIndex].map((p) => String(p ?? "").replace(/\s+/g, "_")).join(":");
}

export function heartbeatOwner(body) {
  return ((body || "").match(/\bowner=([^\]\s]+)/) || [])[1] || null;
}

export function latestHeartbeatOwner(card, claim = null) {
  const beats = (card?.comments || [])
    .map((c) => {
      const body = c.body || "";
      if (!body.includes(HEARTBEAT_TAG)) return null;
      if (claim && !body.includes(claim)) return null;
      const owner = heartbeatOwner(body);
      const t = Date.parse(c.createdAt);
      return owner && !Number.isNaN(t) ? { owner, t } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.t - a.t);
  return beats[0]?.owner || null;
}

export function claimConfirmed(card, cfg, owner, expectedStates = []) {
  if (!card || !hasLabel(card, cfg.claim)) return false;
  if (expectedStates.length && !expectedStates.includes(card.stateName)) return false;
  if ((cfg.blocked || []).some((b) => hasLabel(card, b))) return false;
  if (!dependencyEligibility(card.blockers, card.blockersComplete === true).eligible) return false;
  return latestHeartbeatOwner(card, cfg.claim) === owner;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cardWorktreePath(anchorPath, config, issueIdentifier) {
  const repo = resolveRepos(anchorPath, config)[0]?.path || anchorPath;
  return worktreePath(repo, issueIdentifier);
}

export function cardRunPaths(anchorPath, config, sweep, slot, parentRunId, childIndex = slot.slotIndex || 0) {
  const issueIdentifier = slot.identifier;
  const logDir = path.join(STATE_DIR, anchorSlug(anchorPath), sweep, issueIdentifier);
  const childRunKey = `${sweep}-${issueIdentifier}-${childIndex}`;
  const tmpDir = path.join(CACHE_DIR, parentRunId, childRunKey, "tmp");
  const portBase = SAME_REPO_PORT_BASE + childIndex * 10;
  return {
    worktreePath: cardWorktreePath(anchorPath, config, issueIdentifier),
    logDir,
    tmpDir,
    portBase,
    appPort: portBase,
    screenshotDir: path.join(logDir, "screenshots"),
    browserProfileDir: path.join(CACHE_DIR, parentRunId, childRunKey, "browser"),
  };
}

export function withCardDispatchEnv(pick, parentRunId, childIndex = 0) {
  if (!pick.issueIdentifier) return pick;
  const paths = cardRunPaths(pick.anchorPath, pick.config, pick.sweep, {
    identifier: pick.issueIdentifier,
    slotIndex: pick.slotIndex || 0,
  }, parentRunId, childIndex);
  return {
    ...pick,
    cardRunId: `${parentRunId}:${pick.sweep}:${pick.issueIdentifier}:${pick.slotIndex || 0}:${childIndex}`,
    sameRepoLimit: sameRepoCardLimit(pick.config, pick.sweep),
    ...paths,
    childEnv: {
      AUTO_SWEEP_ISSUE: pick.issueIdentifier,
      AUTO_SWEEP_KIT_PATH: KIT_ROOT,
      AUTO_SWEEP_SOURCE_ANCHOR: pick.sourceAnchorPath || pick.anchorPath,
      AUTO_SWEEP_SLOT_INDEX: String(pick.slotIndex || 0),
      AUTO_SWEEP_WORKTREE: paths.worktreePath,
      AUTO_SWEEP_LOG_DIR: paths.logDir,
      AUTO_SWEEP_TMPDIR: paths.tmpDir,
      AUTO_SWEEP_PORT_BASE: String(paths.portBase),
      AUTO_SWEEP_APP_PORT: String(paths.appPort),
      AUTO_SWEEP_SCREENSHOT_DIR: paths.screenshotDir,
      AUTO_SWEEP_BROWSER_PROFILE_DIR: paths.browserProfileDir,
    },
  };
}

export function createChildIndexAllocator(start = 0) {
  let next = Math.max(0, Math.floor(Number(start)) || 0);
  return {
    next() {
      const current = next;
      next += 1;
      return current;
    },
    get value() {
      return next;
    },
  };
}

function sameRepoActiveKey(anchorPath, sweep) {
  return `${path.resolve(anchorPath || "")}\0${sweep || ""}`;
}

export function createSameRepoActiveCounts() {
  const counts = new Map();
  const adjust = (pick, delta) => {
    if (!pick?.anchorPath || !pick?.sweep || !pick?.issueIdentifier || pick.sweep === "ship") return 0;
    const key = sameRepoActiveKey(pick.anchorPath, pick.sweep);
    const next = Math.max(0, (counts.get(key) || 0) + delta);
    if (next) counts.set(key, next);
    else counts.delete(key);
    return next;
  };
  return {
    increment(pick) {
      return adjust(pick, 1);
    },
    decrement(pick) {
      return adjust(pick, -1);
    },
    get(anchorPath, sweep) {
      return counts.get(sameRepoActiveKey(anchorPath, sweep)) || 0;
    },
    available(anchorPath, sweep, limit) {
      return Math.max(0, Math.floor(Number(limit)) - this.get(anchorPath, sweep));
    },
  };
}

export function sameRepoAvailableSlots({ cards = [], cfg, anchorPath, sweep, activeSameRepo, limit, now = Date.now() } = {}) {
  const claim = cfg?.claim;
  const boardActiveClaims = claim ? (cards || []).filter((card) => (
    hasLabel(card, claim) && liveClaimLabel(card, now) === claim
  )).length : 0;
  const parentActive = activeSameRepo?.get(anchorPath, sweep) || 0;
  return Math.max(0, Math.floor(Number(limit)) - Math.max(parentActive, boardActiveClaims));
}

export function admissionDemandsForCandidates(candidates, {
  trigger = "initial",
  now = Date.now(),
  rotationRanks = new Map(),
} = {}) {
  const demands = [];
  for (const candidate of candidates || []) {
    const stage = candidate.sweep;
    const rotationRank = rotationRanks.get(candidate.anchorPath) ?? candidate.rotationRank ?? 0;
    const cards = stage === "ship"
      ? [candidate.topCard || candidate.cards?.[0]].filter(Boolean)
      : selectCardSlots(
        candidate.cards || [],
        SWEEP_CFG[stage],
        stage,
        candidate.slotLimit ?? sameRepoCardLimit(candidate.config || {}, stage),
        now,
      ).map((slot) => slot.card);
    for (const card of cards) {
      demands.push({
        ...candidate,
        stage,
        trigger,
        workspace: candidate.anchorPath,
        issueIdentifier: card.identifier,
        boardOrder: boardOrderValue(card),
        rotationRank,
        topCard: card,
        topSortOrder: card.sortOrder,
        cards: [card],
        count: 1,
        slotLimit: 1,
      });
    }
  }
  return demands;
}

function repoSet(candidate) {
  return new Set(resolveRepos(candidate.anchorPath, candidate.config).map((r) => path.resolve(r.path)));
}

function pathsOverlap(a, b) {
  const relAB = path.relative(a, b);
  const relBA = path.relative(b, a);
  return relAB === "" || relBA === "" || (!relAB.startsWith("..") && !path.isAbsolute(relAB)) || (!relBA.startsWith("..") && !path.isAbsolute(relBA));
}

function overlapsAny(paths, usedPaths) {
  for (const p of paths) {
    for (const used of usedPaths) if (pathsOverlap(p, used)) return true;
  }
  return false;
}

export function selectDispatchBatch(candidates, { maxNonShipDispatches = DEFAULT_MAX_NON_SHIP_DISPATCHES, rotationSeed = 0 } = {}) {
  const ranked = rankedDispatchCandidates(candidates);
  const ship = ranked.find((c) => c.sweep === "ship");
  if (ship) return [ship];

  let limit = Math.max(1, Math.floor(Number(maxNonShipDispatches)) || 1);
  const rotated = rotateNonShipCandidates(ranked.filter((candidate) => candidate.sweep !== "ship"), rotationSeed);
  const picked = [];
  const usedAnchors = new Set();
  const usedRepos = new Set();
  for (const c of rotated) {
    if (picked.length >= limit) break;
    const candidateLimit = parallelLimit(c.config);
    if (picked.length + 1 > Math.min(limit, candidateLimit)) continue;
    if (usedAnchors.has(c.anchorPath)) continue;
    const repos = repoSet(c);
    if (overlapsAny(repos, usedRepos)) continue;
    picked.push(c);
    limit = Math.min(limit, candidateLimit);
    usedAnchors.add(c.anchorPath);
    for (const repo of repos) usedRepos.add(repo);
  }
  return picked;
}

export async function preflightAndSelectDispatchBatch(candidates, {
  preflightFn,
  selectOptions = {},
} = {}) {
  const shipCandidates = candidates.filter((candidate) => candidate.sweep === "ship");
  const checked = await preflightFn(shipCandidates.length ? shipCandidates : candidates);
  return { ...checked, selected: selectDispatchBatch(checked.ready, selectOptions) };
}

export function rotateNonShipCandidates(candidates, seed = 0) {
  const ranked = candidates.filter((candidate) => candidate.sweep !== "ship");
  const anchors = [];
  const seen = new Set();
  for (const candidate of ranked) {
    if (seen.has(candidate.anchorPath)) continue;
    seen.add(candidate.anchorPath);
    anchors.push(candidate.anchorPath);
  }
  if (anchors.length <= 1) return ranked;
  const offset = Math.abs(Math.floor(Number(seed)) || 0) % anchors.length;
  const rotatedAnchors = [...anchors.slice(offset), ...anchors.slice(0, offset)];
  const anchorRank = new Map(rotatedAnchors.map((anchor, index) => [anchor, index]));
  return [...ranked].sort((a, b) => {
    const ao = anchorRank.get(a.anchorPath) ?? Number.MAX_SAFE_INTEGER;
    const bo = anchorRank.get(b.anchorPath) ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return ranked.indexOf(a) - ranked.indexOf(b);
  });
}

export function dryRunDispatchMessages(batch) {
  const out = [];
  for (const pick of batch) {
    const limit = sameRepoCardLimit(pick.config || {}, pick.sweep);
    out.push({
      anchorPath: pick.anchorPath,
      sweep: pick.sweep,
      body: `[dry-run] WOULD dispatch ${runtimeSummary(runtimeConfigForSweep(pick.config || {}, pick.sweep))} (${pick.count} actionable${pick.topCard?.identifier ? `; top ${pick.topCard.identifier}` : ""}; sameRepoLimit=${limit})`,
    });
    if (pick.cards) {
      for (const slot of selectCardSlots(pick.cards, SWEEP_CFG[pick.sweep], pick.sweep, limit, Date.now())) {
        out.push({
          anchorPath: pick.anchorPath,
          sweep: pick.sweep,
          body: `[dry-run] slot ${slot.slotIndex + 1}/${limit} ${pick.sweep} ${slot.identifier} sortOrder=${slot.sortOrder}`,
        });
      }
    }
  }
  return out;
}

// Compatibility wrapper for older tests/callers that expect one dispatch.
export function selectDispatch(candidates) {
  const ranked = rankedDispatchCandidates(candidates);
  return ranked[0] || null;
}

// Parse a KEY=VALUE .env (strips surrounding quotes). Missing file ⇒ {}.
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export const BLOCKING_LABELS = ["blocked:open-questions", "blocked:needs-user", "qa:needs-changes", MANUAL_ONLY_LABEL];

export function blockingLabelsForIssue(labelNames) {
  return BLOCKING_LABELS.filter((name) => (labelNames || []).includes(name));
}

export function labelIdsAfterRemoving(labelIdsByName, removeNames) {
  const remove = new Set(removeNames || []);
  return Object.entries(labelIdsByName || [])
    .filter(([name]) => !remove.has(name))
    .map(([, id]) => id);
}

function redactSecrets(text) {
  return String(text || "").replace(/lin_api_[A-Za-z0-9._-]+/g, "[redacted-linear-api-key]");
}

export function buildUnblockAuditComment({ labels, resolution }) {
  const labelList = (labels || []).map((l) => `\`${l}\``).join(", ");
  return [
    "[unblock-sweep resolution]",
    `Resolution for blocker label(s): ${labelList || "(none)"}`,
    "",
    "Operator resolution:",
    redactSecrets(resolution || "").trim() || "(no resolution text provided)",
  ].join("\n");
}

export function resolutionTextFromArgs(args, stdinText = "") {
  if ((args || [])[0] === "--stdin") return String(stdinText || "").trim();
  return (args || []).join(" ").trim();
}

function recentHumanComments(comments) {
  return [...(comments || [])]
    .filter((c) => {
      const body = c.body || "";
      return !body.includes(HEARTBEAT_TAG) && !body.includes(REAPER_TAG) && !body.includes(ORPHAN_TAG);
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function normalizeBlockedIssue(anchorPath, config, issue, { active = null } = {}) {
  const labelNodes = issue.labels?.nodes || [];
  const labelNames = labelNodes.map((l) => l.name);
  const comments = issue.comments?.nodes || [];
  const recentComments = recentHumanComments(comments).slice(0, 5);
  return {
    anchorPath,
    project: config.project,
    projectId: config.projectId,
    projectActive: active,
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name || null,
    updatedAt: issue.updatedAt,
    labels: labelNames,
    labelIds: Object.fromEntries(labelNodes.map((l) => [l.name, l.id])),
    blockingLabels: blockingLabelsForIssue(labelNames),
    recentComments,
    newestBlockingComment: recentComments[0] || null,
  };
}

// FailureEvent shape:
// {
//   anchorPath, anchorSlug, projectId,
//   scope, kind, stableTarget,
//   message, seenAt
// }
export function failureFingerprint(event) {
  const input = [
    event.anchorSlug || anchorSlug(event.anchorPath || "_"),
    event.scope || "_",
    event.kind || "_",
    event.stableTarget || "_",
  ].join("|");
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeFailureMessage(message, envValues = []) {
  let out = String(message || "");
  out = out.replace(/lin_api_[A-Za-z0-9_-]+/g, "[REDACTED]");
  out = out.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[REDACTED]");
  out = out.replace(/\b(?:xox[baprs]-|sk-[A-Za-z0-9_-]{12,})[A-Za-z0-9_-]*/g, "[REDACTED]");
  for (const value of envValues || []) {
    if (!value || String(value).length < 3) continue;
    out = out.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED]");
  }
  return out.length > 2000 ? `${out.slice(0, 2000)}...` : out;
}

export function failureTodoTitle(event) {
  const anchor = event.anchorSlug || anchorSlug(event.anchorPath || "_");
  return `Scheduled sweep failure: ${anchor} / ${event.scope || "_"} / ${event.kind || "unknown"}`;
}

export function failureTodoBody(event, fingerprint, { envValues = [], firstSeen = null } = {}) {
  const seenAt = event.seenAt || new Date().toISOString();
  const message = sanitizeFailureMessage(event.message, envValues);
  return [
    `What failed: scheduled sweep tick reported \`${event.kind || "unknown"}\` for \`${event.scope || "_"}\`.`,
    `Anchor: \`${event.anchorSlug || anchorSlug(event.anchorPath || "_")}\``,
    `Project: \`${event.projectId || "unknown"}\``,
    `Target: \`${event.stableTarget || "_"}\``,
    `First seen: ${firstSeen || seenAt}`,
    `Last seen: ${seenAt}`,
    `Last error: ${message}`,
    "",
    "How to clear: fix the reported launcher/runtime/config issue, then let the scheduled tick run again.",
    "Recovery condition: a later tick checks this same scope without observing this failure fingerprint; the launcher then comments recovery and moves this Todo to Done.",
    "",
    `${FAILURE_TODO_TAG} ${fingerprint}]`,
  ].join("\n");
}

function markerFingerprint(text) {
  const m = String(text || "").match(/\[auto-sweep-tick-failure\s+([a-f0-9-]+)\]/i);
  return m ? m[1] : null;
}

function failureTodoFingerprint(todo) {
  return todo.fingerprint || markerFingerprint(todo.description) || markerFingerprint((todo.comments || []).map((c) => c.body).join("\n"));
}

function failureTodoScope(todo) {
  if (todo.scope) return todo.scope;
  const m = String(todo.description || "").match(/What failed:.*?for `([^`]+)`/);
  return m ? m[1] : "_";
}

function failureTodoStableTarget(todo) {
  if (todo.stableTarget) return todo.stableTarget;
  const m = String(todo.description || "").match(/Target:\s*`([^`]+)`/);
  return m ? m[1] : null;
}

function failureTodoLastMessage(todo) {
  if (todo.lastMessage !== undefined) return String(todo.lastMessage);
  const matches = [...String(todo.description || "").matchAll(/Last error:\s*([\s\S]*?)(?:\n\nHow to clear:|$)/g)];
  return matches.length ? matches[matches.length - 1][1].trim() : "";
}

function failureTodoFirstSeen(todo) {
  const m = String(todo.description || "").match(/First seen:\s*(.*)/);
  return m ? m[1].trim() : null;
}

function newestFirst(a, b) {
  return Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0);
}

function shouldCommentDuplicate(todo, now) {
  const last = (todo.comments || [])
    .filter((c) => String(c.body || "").includes(FAILURE_DUPLICATE_NOTE))
    .map((c) => Date.parse(c.createdAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];
  return !last || now - last >= FAILURE_TODO_THROTTLE_MS;
}

export function failureTodoDecisions(currentFailures, existingTodos, checkedScopes, now = Date.now(), { envValues = [], recoveredTargets = new Set() } = {}) {
  const decisions = [];
  const byFingerprint = new Map();
  for (const todo of existingTodos || []) {
    const fp = failureTodoFingerprint(todo);
    if (!fp) continue;
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
    byFingerprint.get(fp).push(todo);
  }
  for (const todos of byFingerprint.values()) todos.sort(newestFirst);

  const current = new Map();
  for (const event of currentFailures || []) {
    const fp = failureFingerprint(event);
    if (!current.has(fp)) current.set(fp, { event, fingerprint: fp, message: sanitizeFailureMessage(event.message, envValues) });
  }

  for (const currentFailure of current.values()) {
    const todos = byFingerprint.get(currentFailure.fingerprint) || [];
    const primary = todos[0];
    if (!primary) {
      decisions.push({ action: "create", ...currentFailure });
      continue;
    }
    for (const duplicate of todos.slice(1)) {
      if (shouldCommentDuplicate(duplicate, now)) decisions.push({ action: "duplicate", fingerprint: currentFailure.fingerprint, todo: duplicate, primary });
    }
    const previousMessage = failureTodoLastMessage(primary);
    const age = now - Date.parse(primary.updatedAt || primary.createdAt || 0);
    if (previousMessage !== currentFailure.message || age >= FAILURE_TODO_THROTTLE_MS) {
      decisions.push({ action: "update", todo: primary, ...currentFailure });
    }
  }

  for (const [fp, todos] of byFingerprint.entries()) {
    if (current.has(fp)) continue;
    const primary = todos[0];
    const scope = failureTodoScope(primary);
    const stableTarget = failureTodoStableTarget(primary);
    if ((checkedScopes && checkedScopes.has(scope)) || (stableTarget && recoveredTargets?.has?.(stableTarget))) {
      decisions.push({ action: "close", fingerprint: fp, todo: primary });
    }
  }

  return decisions;
}

export function healthStatus({ currentTick = null, lastTick, lockPid = null, isAlive = isAlivePid, now = Date.now(), intervalS = INTERVAL_S } = {}) {
  if (currentTick?.status === "running") {
    if (!currentTick.pid || !isAlive(currentTick.pid)) {
      return { ok: false, reason: `STALE current tick: dead pid ${currentTick.pid || "unknown"}` };
    }
    const failures = Array.isArray(currentTick.failures) ? currentTick.failures : [];
    if (failures.length) return { ok: false, reason: `current tick has ${failures.length} systemic failure(s) (pid ${currentTick.pid})` };
    return { ok: true, reason: `tick in progress (pid ${currentTick.pid})` };
  }
  if (lockPid && isAlive(lockPid)) return { ok: true, reason: `tick in progress (pid ${lockPid})` };
  if (!lastTick) return { ok: false, reason: "no successful tick recorded" };
  if (Array.isArray(lastTick.failures) && lastTick.failures.length) return { ok: false, reason: `latest tick had ${lastTick.failures.length} local failure(s)` };
  const ageS = (now - Date.parse(lastTick.at)) / 1000;
  if (!Number.isFinite(ageS)) return { ok: false, reason: "last tick timestamp unreadable" };
  if (ageS > 3 * intervalS) return { ok: false, reason: `STALE: > 3× interval (${3 * intervalS}s)`, ageS };
  return { ok: true, reason: `last tick ${lastTick.at} (${Math.round(ageS)}s ago)`, ageS };
}

export function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value) + "\n");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore cleanup failure */ }
    throw error;
  }
}

function observationIdentity(value = {}) {
  return {
    sourceWorkspace: value.sourceWorkspace || value.sourceAnchorPath || value.workspace || value.anchorPath,
    sweep: value.sweep || value.stage,
    issueIdentifier: value.issueIdentifier || value.topCard?.identifier,
  };
}

function observationKey(value) {
  const identity = observationIdentity(value);
  return JSON.stringify([identity.sourceWorkspace || "", identity.sweep || "", identity.issueIdentifier || ""]);
}

export function createObservationStore({
  observationPath = OBSERVATIONS,
  dryRun = false,
  now = Date.now,
  readJsonFn = (target) => {
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, "utf8"));
  },
  writeJsonFn = atomicWriteJson,
} = {}) {
  const read = () => {
    try {
      const raw = readJsonFn(observationPath);
      if (raw === null || raw === undefined) return { version: OBSERVATION_STATE_VERSION, entries: {}, healthy: true, errors: [] };
      if (!raw || raw.version !== OBSERVATION_STATE_VERSION || !raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) {
        return { version: OBSERVATION_STATE_VERSION, entries: {}, healthy: false, errors: ["observation schema is malformed"] };
      }
      return { version: OBSERVATION_STATE_VERSION, entries: structuredClone(raw.entries), healthy: true, errors: [] };
    } catch (error) {
      return { version: OBSERVATION_STATE_VERSION, entries: {}, healthy: false, errors: [`observations unreadable: ${error.message}`] };
    }
  };
  const persist = (state) => {
    if (!dryRun) writeJsonFn(observationPath, { version: OBSERVATION_STATE_VERSION, entries: state.entries });
  };
  const markCapacityDeferred = (value) => {
    const identity = observationIdentity(value);
    if (!identity.sourceWorkspace || !identity.sweep || !identity.issueIdentifier) return null;
    const state = read();
    if (!state.healthy) return null;
    const key = observationKey(identity);
    const timestamp = new Date(now()).toISOString();
    state.entries[key] = {
      ...identity,
      firstObservedActionableAt: state.entries[key]?.firstObservedActionableAt || timestamp,
      lastSeenAt: timestamp,
    };
    persist(state);
    return { ...state.entries[key], queueWaitMs: Math.max(0, now() - Date.parse(state.entries[key].firstObservedActionableAt)) };
  };
  const clear = (value) => {
    const state = read();
    if (!state.healthy) return false;
    const key = observationKey(value);
    if (!Object.hasOwn(state.entries, key)) return false;
    delete state.entries[key];
    persist(state);
    return true;
  };
  const sync = ({ observations = [], scannedScopes = [] } = {}) => {
    const state = read();
    if (!state.healthy) return state;
    const timestamp = new Date(now()).toISOString();
    const seen = new Map(observations.map((entry) => [observationKey(entry), entry]));
    const scopes = new Set(scannedScopes.map((scope) => JSON.stringify([
      scope.sourceWorkspace || scope.sourceAnchorPath || scope.workspace || scope.anchorPath || "",
      scope.sweep || scope.stage || "",
    ])));
    let changed = false;
    for (const [key, entry] of Object.entries(state.entries)) {
      const scopeKey = JSON.stringify([entry.sourceWorkspace || "", entry.sweep || ""]);
      const observed = seen.get(key);
      if (scopes.has(scopeKey) && (!observed || observed.eligible === false)) {
        delete state.entries[key];
        changed = true;
        continue;
      }
      if (observed?.eligible !== false && observed && entry.lastSeenAt !== timestamp) {
        entry.lastSeenAt = timestamp;
        changed = true;
      }
      const lastSeen = Date.parse(entry.lastSeenAt || entry.firstObservedActionableAt);
      if (Number.isFinite(lastSeen) && now() - lastSeen > OBSERVATION_RETENTION_MS) {
        delete state.entries[key];
        changed = true;
      }
    }
    if (changed) persist(state);
    return state;
  };
  const get = (value) => {
    const state = read();
    const entry = state.healthy ? state.entries[observationKey(value)] : null;
    if (!entry) return null;
    return { ...entry, queueWaitMs: Math.max(0, now() - Date.parse(entry.firstObservedActionableAt)) };
  };
  const snapshot = () => {
    const state = read();
    return {
      ...state,
      entries: Object.values(state.entries).map((entry) => ({
        ...entry,
        queueWaitMs: Math.max(0, now() - Date.parse(entry.firstObservedActionableAt)),
      })),
    };
  };
  return { observationPath, sync, markCapacityDeferred, clear, get, snapshot };
}

function defaultMemoryPressureSample(spawnFn = spawnSync) {
  const result = spawnFn("/usr/bin/memory_pressure", [], { encoding: "utf8" });
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = String(result?.stderr || "").trim();
    throw new Error(`memory_pressure exited ${result?.status ?? "unknown"}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function memoryPressureAvailablePercent(output) {
  const match = String(output || "").match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i);
  return match ? Number(match[1]) : null;
}

export function createResourceSampler({
  osModule = os,
  memoryPressureSpawnFn = spawnSync,
  memoryPressureFn = () => defaultMemoryPressureSample(memoryPressureSpawnFn),
  intervalMs = 30_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let timer = null;
  let running = false;
  let first = null;
  let latest = null;
  let maxLoad = null;
  let minFree = null;
  let minPressure = null;
  let capacityHighWater = 0;
  const metricsUnavailable = new Set();
  const sample = () => {
    let loadAverage1m;
    let freeMemoryBytes;
    let totalMemoryBytes;
    try {
      loadAverage1m = Number(osModule.loadavg()[0]);
      freeMemoryBytes = Number(osModule.freemem());
      totalMemoryBytes = Number(osModule.totalmem());
    } catch (error) {
      metricsUnavailable.add(String(error?.message || error));
      return;
    }
    let memoryPressure = null;
    if (osModule.platform() === "darwin") {
      try {
        memoryPressure = memoryPressureAvailablePercent(memoryPressureFn());
        if (memoryPressure === null) throw new Error("could not parse memory_pressure output");
      } catch (error) {
        metricsUnavailable.add(`memoryPressureAvailablePercent: ${String(error?.message || error)}`);
      }
    }
    const point = { loadAverage1m, freeMemoryBytes, totalMemoryBytes, memoryPressure };
    if (!first) first = point;
    latest = point;
    maxLoad = maxLoad === null ? loadAverage1m : Math.max(maxLoad, loadAverage1m);
    minFree = minFree === null ? freeMemoryBytes : Math.min(minFree, freeMemoryBytes);
    if (memoryPressure !== null) minPressure = minPressure === null ? memoryPressure : Math.min(minPressure, memoryPressure);
  };
  const start = () => {
    if (running) return;
    running = true;
    sample();
    try {
      timer = setIntervalFn(sample, intervalMs);
      timer?.unref?.();
    } catch (error) {
      metricsUnavailable.add(String(error?.message || error));
      timer = null;
    }
  };
  const stop = () => {
    if (!running) return;
    sample();
    running = false;
    if (timer !== null) {
      try { clearIntervalFn(timer); } catch (error) { metricsUnavailable.add(String(error?.message || error)); }
    }
    timer = null;
  };
  const observeCapacity = (active) => {
    const value = Math.max(0, Math.floor(Number(active)) || 0);
    capacityHighWater = Math.max(capacityHighWater, value);
  };
  const snapshot = () => ({
    ...(first && latest ? {
      loadAverage1m: { start: first.loadAverage1m, end: latest.loadAverage1m, max: maxLoad },
      freeMemoryBytes: { start: first.freeMemoryBytes, end: latest.freeMemoryBytes, min: minFree },
      totalMemoryBytes: latest.totalMemoryBytes,
      ...(first.memoryPressure !== null || latest.memoryPressure !== null ? {
        memoryPressureAvailablePercent: { start: first.memoryPressure, end: latest.memoryPressure, min: minPressure },
      } : {}),
    } : {}),
    ...(capacityHighWater > 0 ? { capacityHighWater } : {}),
    metricsUnavailable: [...metricsUnavailable],
  });
  return { start, stop, sample, observeCapacity, snapshot };
}

function capacityEntryError(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "entry is not an object";
  if (typeof entry.token !== "string" || !entry.token) return "token is missing";
  if (!Number.isInteger(entry.parentPid) || entry.parentPid <= 0) return `entry ${entry.token} has invalid parentPid`;
  if (entry.childPid !== null && (!Number.isInteger(entry.childPid) || entry.childPid <= 0)) return `entry ${entry.token} has invalid childPid`;
  if (typeof entry.issueIdentifier !== "string" || !entry.issueIdentifier) return `entry ${entry.token} has invalid issueIdentifier`;
  if (typeof entry.workspace !== "string" || !entry.workspace) return `entry ${entry.token} has invalid workspace`;
  if (!SWEEPS.includes(entry.stage)) return `entry ${entry.token} has invalid stage`;
  if (!["initial", "refill", "handoff"].includes(entry.trigger)) return `entry ${entry.token} has invalid trigger`;
  if (typeof entry.reservedAt !== "string" || Number.isNaN(Date.parse(entry.reservedAt))) return `entry ${entry.token} has invalid reservedAt`;
  return null;
}

function capacityStaleError(entry, parentAlive, childAlive) {
  if (entry.childPid === null && parentAlive === false) {
    return `stale entry ${entry.token}: parent PID ${entry.parentPid} is dead before child spawn`;
  }
  if (entry.childPid !== null && childAlive === false) {
    return `stale entry ${entry.token}: child PID ${entry.childPid} is dead`;
  }
  return null;
}

export function createCapacityLedger({
  ledgerPath = CAPACITY_LEDGER,
  maxActiveChildren = DEFAULT_MAX_ACTIVE_CHILDREN,
  parentPid = process.pid,
  isAlive = isAlivePid,
  now = () => new Date().toISOString(),
  randomUUID = () => crypto.randomUUID(),
  readJsonFn = (target) => {
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, "utf8"));
  },
  writeJsonFn = atomicWriteJson,
} = {}) {
  const configuredMax = maxActiveChildren === null || maxActiveChildren === "" ? Number.NaN : Number(maxActiveChildren);
  const max = Number.isFinite(configuredMax)
    ? Math.min(MAX_ACTIVE_CHILDREN, Math.max(1, Math.floor(configuredMax)))
    : DEFAULT_MAX_ACTIVE_CHILDREN;
  const released = new Set();

  const read = ({ checkLiveness = false } = {}) => {
    let raw;
    try {
      raw = readJsonFn(ledgerPath);
    } catch (error) {
      return { version: CAPACITY_LEDGER_VERSION, entries: [], active: max, max, healthy: false, errors: [`ledger unreadable: ${error.message}`], opaque: true };
    }
    if (raw === null || raw === undefined) return { version: CAPACITY_LEDGER_VERSION, entries: [], active: 0, max, healthy: true, errors: [], opaque: false };
    if (!raw || raw.version !== CAPACITY_LEDGER_VERSION || !Array.isArray(raw.entries)) {
      return { version: CAPACITY_LEDGER_VERSION, entries: [], active: max, max, healthy: false, errors: ["ledger schema is malformed"], opaque: true };
    }
    const entries = raw.entries.map((entry) => ({ ...entry }));
    const errors = entries.map(capacityEntryError).filter(Boolean);
    const tokens = new Set();
    for (const entry of entries) {
      if (typeof entry.token !== "string" || !entry.token) continue;
      if (tokens.has(entry.token)) errors.push(`duplicate token ${entry.token}`);
      tokens.add(entry.token);
    }
    if (checkLiveness && !errors.length) {
      for (const entry of entries) {
        let parentAlive;
        let childAlive = null;
        for (const [kind, pid] of [["parent", entry.parentPid], ["child", entry.childPid]]) {
          if (kind === "child" && pid === null) continue;
          try {
            const live = isAlive(pid);
            if (typeof live !== "boolean") errors.push(`entry ${entry.token} ${kind} PID ${pid} is unverifiable`);
            else if (kind === "parent") parentAlive = live;
            else childAlive = live;
          } catch (error) {
            errors.push(`entry ${entry.token} ${kind} PID ${pid} is unverifiable: ${error.message}`);
          }
        }
        const staleError = capacityStaleError(entry, parentAlive, childAlive);
        if (staleError) errors.push(staleError);
      }
    }
    return { version: CAPACITY_LEDGER_VERSION, entries, active: entries.length, max, healthy: errors.length === 0, errors, opaque: false };
  };

  const inspect = () => read({ checkLiveness: true });
  const reconcile = () => {
    const state = read();
    if (!state.healthy || state.opaque) return state;
    const kept = [];
    const errors = [];
    for (const entry of state.entries) {
      let parentAlive;
      let childAlive = null;
      try {
        parentAlive = isAlive(entry.parentPid);
        if (typeof parentAlive !== "boolean") throw new Error("non-boolean liveness result");
        if (entry.childPid !== null) {
          childAlive = isAlive(entry.childPid);
          if (typeof childAlive !== "boolean") throw new Error("non-boolean liveness result");
        }
      } catch (error) {
        errors.push(`entry ${entry.token} PID is unverifiable: ${error.message}`);
        kept.push(entry);
        continue;
      }
      const stale = entry.childPid === null ? !parentAlive : !childAlive;
      if (!stale) kept.push(entry);
    }
    if (errors.length) return { ...state, entries: kept, active: kept.length, healthy: false, errors };
    if (kept.length !== state.entries.length) writeJsonFn(ledgerPath, { version: CAPACITY_LEDGER_VERSION, entries: kept });
    return { ...state, entries: kept, active: kept.length, healthy: true, errors: [] };
  };

  const release = (token) => {
    if (!token || released.has(token)) return false;
    const state = read();
    if (!state.healthy || state.opaque) return false;
    const entries = state.entries.filter((entry) => entry.token !== token);
    if (entries.length === state.entries.length) {
      released.add(token);
      return false;
    }
    writeJsonFn(ledgerPath, { version: CAPACITY_LEDGER_VERSION, entries });
    released.add(token);
    return true;
  };

  const attachChildPid = (token, childPid) => {
    if (!Number.isInteger(childPid) || childPid <= 0) throw new Error(`invalid child PID ${childPid}`);
    const state = read();
    if (!state.healthy || state.opaque) throw new Error(`capacity ledger unhealthy: ${state.errors.join("; ")}`);
    const entry = state.entries.find((candidate) => candidate.token === token);
    if (!entry) return false;
    entry.childPid = childPid;
    writeJsonFn(ledgerPath, { version: CAPACITY_LEDGER_VERSION, entries: state.entries });
    return true;
  };

  const reserve = (demand = {}) => {
    const state = reconcile();
    if (!state.healthy || state.active >= max) return null;
    const stage = demand.stage || demand.sweep;
    if (stage === "ship" ? state.active > 0 : state.entries.some((entry) => entry.stage === "ship")) return null;
    const existingTokens = new Set(state.entries.map((entry) => entry.token));
    let token = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = randomUUID();
      if (typeof candidate === "string" && candidate && !existingTokens.has(candidate)) {
        token = candidate;
        break;
      }
    }
    if (!token) throw new Error("could not allocate a unique capacity token");
    const entry = {
      token,
      parentPid,
      childPid: null,
      issueIdentifier: demand.issueIdentifier || demand.topCard?.identifier,
      workspace: demand.workspace || demand.anchorPath,
      stage,
      trigger: demand.trigger || "initial",
      reservedAt: now(),
    };
    const error = capacityEntryError(entry);
    if (error) throw new Error(error);
    writeJsonFn(ledgerPath, { version: CAPACITY_LEDGER_VERSION, entries: [...state.entries, entry] });
    return {
      token,
      entry,
      attachChildPid: (pid) => attachChildPid(token, pid),
      release: () => release(token),
    };
  };

  return { ledgerPath, maxActiveChildren: max, inspect, reconcile, reserve, attachChildPid, release };
}

export function createAdmissionQueue({ ledger, executeDemand, beforeRelease = null, sampler = null, onCapacityDeferred = null, onUnconfirmedDemand = null } = {}) {
  if (!ledger || typeof ledger.reserve !== "function") throw new Error("capacity ledger is required");
  if (typeof executeDemand !== "function") throw new Error("executeDemand is required");
  const pending = [];
  const byKey = new Map();
  let localActive = 0;
  let drainScheduled = false;
  let draining = false;
  let capacityHighWater = 0;
  const idleWaiters = [];

  const demandKey = (demand) => [demand.workspace || demand.anchorPath || "", demand.stage || demand.sweep || "", demand.issueIdentifier || demand.topCard?.identifier || ""].join("\0");
  const scheduleDrain = () => {
    if (drainScheduled) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      drainAdmissionQueue();
    });
  };
  const notifyIdle = () => {
    if (pending.length || localActive || drainScheduled || draining) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };
  const settleRun = (item, reservation) => {
    localActive += 1;
    const capacityState = ledger.reconcile();
    capacityHighWater = Math.max(capacityHighWater, capacityState.active);
    item.demand.telemetry = {
      ...(item.demand.telemetry || {}),
      admittedAt: new Date().toISOString(),
      capacitySlot: capacityState.active,
      capacityHighWater,
    };
    sampler?.observeCapacity?.(capacityState.active);
    if (localActive === 1) sampler?.start?.();
    (async () => {
      let confirmed = false;
      try {
        const result = await executeDemand(item.demand, reservation);
        confirmed = Boolean(result);
        if (result && beforeRelease) await beforeRelease(result, item.demand, { admitDemand: enqueue });
        return result;
      } finally {
        if (!confirmed && onUnconfirmedDemand) {
          try { await onUnconfirmedDemand(item.demand); } catch { /* telemetry cleanup must not change admission outcome */ }
        }
        reservation.release();
      }
    })().then(item.resolve, item.reject).finally(() => {
      localActive -= 1;
      if (localActive === 0) sampler?.stop?.();
      byKey.delete(item.key);
      scheduleDrain();
      notifyIdle();
    });
  };
  const drainAdmissionQueue = () => {
    if (draining) return;
    draining = true;
    try {
      pending.sort((a, b) => compareAdmissionDemand(a.demand, b.demand));
      while (pending.length) {
        const state = ledger.reconcile();
        if (!state.healthy) break;
        if (state.active >= state.max) {
          for (const item of pending) onCapacityDeferred?.(item.demand, state);
          if (localActive === 0) {
            for (const item of pending.splice(0)) {
              byKey.delete(item.key);
              item.resolve(null);
            }
          }
          break;
        }
        const shipIndex = pending.findIndex((item) => (item.demand.stage || item.demand.sweep) === "ship");
        if (shipIndex >= 0 && state.active > 0) {
          for (const item of pending) onCapacityDeferred?.(item.demand, state);
          if (localActive === 0) {
            for (const item of pending.splice(0)) {
              byKey.delete(item.key);
              item.resolve(null);
            }
          }
          break;
        }
        if (shipIndex < 0 && state.entries.some((entry) => entry.stage === "ship")) {
          for (const item of pending) onCapacityDeferred?.(item.demand, state);
          if (localActive === 0) {
            for (const item of pending.splice(0)) {
              byKey.delete(item.key);
              item.resolve(null);
            }
          }
          break;
        }
        const item = pending.splice(shipIndex >= 0 ? shipIndex : 0, 1)[0];
        const reservation = ledger.reserve(item.demand);
        if (!reservation) {
          pending.unshift(item);
          break;
        }
        settleRun(item, reservation);
        if ((item.demand.stage || item.demand.sweep) === "ship") break;
      }
    } finally {
      draining = false;
      notifyIdle();
    }
  };
  const enqueue = (demand) => {
    const key = demandKey(demand);
    const existing = byKey.get(key);
    if (existing) return existing.promise;
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    const item = { demand, key, promise, resolve, reject };
    byKey.set(key, item);
    pending.push(item);
    scheduleDrain();
    return promise;
  };
  return {
    admitDemand: enqueue,
    drainAdmissionQueue,
    whenIdle: () => {
      if (!pending.length && !localActive && !drainScheduled && !draining) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    get pendingCount() { return pending.length; },
    get activeCount() { return localActive; },
  };
}

export function admitDemand(demand, { queue } = {}) {
  if (!queue || typeof queue.admitDemand !== "function") throw new Error("admission queue is required");
  return queue.admitDemand(demand);
}

export async function runAdmissionDemands(demands, { queue, onResult } = {}) {
  const results = await Promise.all((demands || []).map(async (demand) => {
    const result = await admitDemand(demand, { queue });
    if (result && onResult) await onResult(result);
    return result;
  }));
  return results.filter(Boolean);
}

export function finalizeTickState(state, {
  currentPath = CURRENT_TICK,
  lastTickPath = LAST_TICK,
  now = () => new Date().toISOString(),
  writeJsonFn = atomicWriteJson,
  removeFn = (target) => fs.rmSync(target, { force: true }),
} = {}) {
  const endedAt = now();
  const completed = { ...state, version: TICK_STATE_VERSION, status: "complete", at: endedAt, endedAt };
  try {
    writeJsonFn(lastTickPath, completed);
    removeFn(currentPath);
    return completed;
  } catch (error) {
    const failure = {
      kind: "last-tick-write",
      message: String(error?.message || error),
      seenAt: endedAt,
    };
    const preserved = {
      ...state,
      version: TICK_STATE_VERSION,
      status: "running",
      at: endedAt,
      failures: [...(state?.failures || []), failure],
    };
    try { writeJsonFn(currentPath, preserved); } catch { /* preserve original finalization error */ }
    throw error;
  }
}

// ── IO: filesystem / registry ────────────────────────────────────────────────

function readRegistry() {
  // shipRunner (default false): only a host whose registry sets it true may
  // DISPATCH ship-sweep — the single-runner pin that closes the cross-host
  // double-deploy race. Set it on exactly one machine.
  if (!fs.existsSync(REGISTRY_PATH)) return normalizeRegistry(defaultRegistry());
  const r = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  return normalizeRegistry(r);
}

function writeRegistry(r) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(normalizeRegistry(r), null, 2) + "\n");
}

function anchorConfig(anchorPath) {
  const p = path.join(anchorPath, ".claude", "linear-sweep.json");
  if (!fs.existsSync(p)) throw new Error(`no .claude/linear-sweep.json at ${anchorPath}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function anchorKey(anchorPath) {
  const envPath = path.join(anchorPath, ".env");
  if (!fs.existsSync(envPath)) return null;
  return parseEnv(fs.readFileSync(envPath, "utf8")).LINEAR_API_KEY || null;
}

function anchorEnvValues(anchorPath) {
  const envPath = path.join(anchorPath, ".env");
  if (!fs.existsSync(envPath)) return [];
  return Object.values(parseEnv(fs.readFileSync(envPath, "utf8"))).filter((v) => v && String(v).length >= 3);
}

function anchorSlug(anchorPath) {
  return path.basename(anchorPath).replace(/[^a-zA-Z0-9._-]/g, "-");
}

// One log writer. slug "_" = launcher-wide lines; otherwise a workspace slug.
function writeLogAt(stateDir, slug, sweep, msg) {
  const dir = path.join(stateDir, slug, sweep);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString();
  fs.appendFileSync(path.join(dir, `${stamp.slice(0, 10).replace(/-/g, "")}.log`), `[${stamp}] ${msg}\n`);
  process.stderr.write(`[${stamp}] ${slug === "_" ? "" : slug + "/"}${sweep} ${msg}\n`);
}
function writeLog(slug, sweep, msg) {
  writeLogAt(STATE_DIR, slug, sweep, msg);
}
const log = (msg) => writeLog("_", "_", msg);
const logFor = (anchorPath, sweep, msg) => writeLog(anchorSlug(anchorPath), sweep, msg);

function rotateLogs() {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
  const walk = (dir) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".log") && fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    }
  };
  walk(STATE_DIR);
}

// ── IO: tick lock (PID liveness) ─────────────────────────────────────────────

function acquireTickLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(TICK_LOCK, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let lockData = null;
      try { lockData = JSON.parse(fs.readFileSync(TICK_LOCK, "utf8")); } catch { lockData = null; }
      if (lockIsReclaimable(lockData, { isAlive: isAlivePid })) {
        fs.rmSync(TICK_LOCK, { force: true });
        continue; // retry the exclusive create
      }
      return false; // a live tick holds it
    }
  }
  return false;
}

function releaseTickLock() {
  try { fs.rmSync(TICK_LOCK, { force: true }); } catch { /* ignore */ }
}

// ── IO: git ──────────────────────────────────────────────────────────────────

function git(repo, args, { allowFail = false } = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} in ${repo}: ${(r.stderr || "").trim()}`);
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// Push with the shared discipline: fetch/rebase/retry up to maxRetries, then give
// up (caller logs + comments). Never force-pushes.
export function pushWithRetry(repo, ref, { maxRetries = 2, gitFn = git } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const push = gitFn(repo, ["push", "origin", ref], { allowFail: true });
    if (push.status === 0) return { ok: true, attempts: attempt + 1 };
    if (attempt === maxRetries) return { ok: false, attempts: attempt + 1, err: push.err };
    gitFn(repo, ["fetch", "origin", ref], { allowFail: true });
    gitFn(repo, ["rebase", `origin/${ref}`], { allowFail: true });
  }
  return { ok: false, attempts: maxRetries + 1 };
}

// ── IO: Linear ───────────────────────────────────────────────────────────────

async function labeledProjectIds(apiKey) {
  const ids = new Set();
  let cursor = null;
  do {
    const d = await gql(
      `query($c:String){ projects(first:100, after:$c, filter:{ labels:{ name:{ eq:"${AUTO_SWEEP_LABEL}" } } }){ pageInfo{ hasNextPage endCursor } nodes{ id } } }`,
      { c: cursor },
      apiKey
    );
    d.projects.nodes.forEach((n) => ids.add(n.id));
    cursor = d.projects.pageInfo.hasNextPage ? d.projects.pageInfo.endCursor : null;
  } while (cursor);
  return ids;
}

function unwrapGraphQlData(result, context) {
  if (Array.isArray(result?.errors) && result.errors.length) {
    throw new Error(`${context} returned partial GraphQL data: ${result.errors.map((error) => error.message || String(error)).join("; ")}`);
  }
  return result?.data || result;
}

function normalizeCardFields(node) {
  return {
    id: node.id,
    identifier: node.identifier,
    stateName: node.state?.name,
    updatedAt: node.updatedAt,
    sortOrder: node.sortOrder,
    labelNames: node.labels.nodes.map((label) => label.name),
    labelIds: Object.fromEntries(node.labels.nodes.map((label) => [label.name, label.id])),
    comments: node.comments.nodes,
  };
}

function normalizeRelationUnknownCard(node) {
  const blockers = [];
  const blockersComplete = false;
  return {
    ...normalizeCardFields(node),
    blockers,
    blockersComplete,
    dependency: dependencyEligibility(blockers, blockersComplete),
  };
}

async function normalizeQueueCard(node, apiKey, { gqlFn, fetchIssueDependenciesFn }) {
  const connection = node?.inverseRelations;
  const pageInfo = connection?.pageInfo;
  if (typeof pageInfo?.hasNextPage !== "boolean") {
    throw new Error(`inverseRelations pageInfo missing for ${node?.identifier || node?.id || "unknown issue"}`);
  }

  let blockers = normalizeBlockingRelations(connection);
  let blockersComplete = !pageInfo.hasNextPage;
  if (!blockersComplete) {
    const resolved = await fetchIssueDependenciesFn(apiKey, node.id, { gqlFn });
    blockers = resolved?.blockers || [];
    blockersComplete = resolved?.complete === true;
    if (!blockersComplete) throw new Error(`incomplete relation pagination for ${node.identifier || node.id}`);
  }

  return {
    ...normalizeCardFields(node),
    blockers,
    blockersComplete,
    dependency: dependencyEligibility(blockers, blockersComplete),
  };
}

export async function fetchScheduledQueueCards(apiKey, teamKey, projectId, states, {
  gqlFn = gql,
  fetchIssueDependenciesFn = fetchIssueDependencies,
} = {}) {
  const requestedStates = [...new Set(states || [])];
  const byState = new Map(requestedStates.map((state) => [state, []]));
  const seenCursors = new Set();
  let cursor = null;
  while (true) {
    const result = await gqlFn(
      `query($c:String,$states:[String!],$teamKey:String!,$pid:ID){ issues(first:100, after:$c, filter:{
         team:{ key:{ eq:$teamKey } }, project:{ id:{ eq:$pid } }, state:{ name:{ in:$states } } }){
         pageInfo{ hasNextPage endCursor }
         nodes{ id identifier updatedAt sortOrder
           state{ name }
           labels{ nodes{ id name } }
           comments(last:100){ nodes{ body createdAt } }
           inverseRelations(first:50){
             pageInfo{ hasNextPage endCursor }
             nodes{ id type issue{ id identifier state{ id name type } } }
           } } } }`,
      { c: cursor, states: requestedStates, teamKey, pid: projectId },
      apiKey
    );
    const data = unwrapGraphQlData(result, "scheduled queue snapshot");
    const connection = data?.issues;
    if (!Array.isArray(connection?.nodes) || typeof connection?.pageInfo?.hasNextPage !== "boolean") {
      throw new Error("scheduled queue snapshot is missing issues data or pageInfo");
    }
    for (const node of connection.nodes) {
      const card = await normalizeQueueCard(node, apiKey, { gqlFn, fetchIssueDependenciesFn });
      if (!byState.has(card.stateName)) byState.set(card.stateName, []);
      byState.get(card.stateName).push(card);
    }
    if (!connection.pageInfo.hasNextPage) return byState;
    const nextCursor = connection.pageInfo.endCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) throw new Error("scheduled queue snapshot pagination is incomplete");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function fetchScheduledCleanupCards(apiKey, teamKey, projectId, states, { gqlFn = gql } = {}) {
  const requestedStates = [...new Set(states || [])];
  const byState = new Map(requestedStates.map((state) => [state, []]));
  const seenCursors = new Set();
  let cursor = null;
  while (true) {
    const result = await gqlFn(
      `query($c:String,$states:[String!],$teamKey:String!,$pid:ID){ issues(first:100, after:$c, filter:{
         team:{ key:{ eq:$teamKey } }, project:{ id:{ eq:$pid } }, state:{ name:{ in:$states } } }){
         pageInfo{ hasNextPage endCursor }
         nodes{ id identifier updatedAt sortOrder state{ name }
           labels{ nodes{ id name } }
           comments(last:100){ nodes{ body createdAt } } } } }`,
      { c: cursor, states: requestedStates, teamKey, pid: projectId },
      apiKey,
    );
    const data = unwrapGraphQlData(result, "scheduled cleanup snapshot");
    const connection = data?.issues;
    if (!Array.isArray(connection?.nodes) || typeof connection?.pageInfo?.hasNextPage !== "boolean") {
      throw new Error("scheduled cleanup snapshot is missing issues data or pageInfo");
    }
    for (const node of connection.nodes) {
      const card = normalizeRelationUnknownCard(node);
      if (!byState.has(card.stateName)) byState.set(card.stateName, []);
      byState.get(card.stateName).push(card);
    }
    if (!connection.pageInfo.hasNextPage) return byState;
    const nextCursor = connection.pageInfo.endCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) throw new Error("scheduled cleanup snapshot pagination is incomplete");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function fetchScheduledPassCards(apiKey, teamKey, projectId, states, {
  fetchAdmissionFn = fetchScheduledQueueCards,
  fetchCleanupFn = fetchScheduledCleanupCards,
  admissionGqlFn = gql,
  cleanupGqlFn = gql,
  fetchIssueDependenciesFn = fetchIssueDependencies,
} = {}) {
  try {
    const admissionByState = await fetchAdmissionFn(apiKey, teamKey, projectId, states, {
      gqlFn: admissionGqlFn,
      fetchIssueDependenciesFn,
    });
    return { admissionByState, cleanupByState: admissionByState, admissionError: null, cleanupError: null };
  } catch (admissionError) {
    try {
      const cleanupByState = await fetchCleanupFn(apiKey, teamKey, projectId, states, { gqlFn: cleanupGqlFn });
      return { admissionByState: null, cleanupByState, admissionError, cleanupError: null };
    } catch (cleanupError) {
      return { admissionByState: null, cleanupByState: null, admissionError, cleanupError };
    }
  }
}

async function fetchCards(apiKey, teamKey, projectId, states) {
  const byState = await fetchScheduledQueueCards(apiKey, teamKey, projectId, states);
  return [...new Set(states || [])].flatMap((state) => byState.get(state) || []);
}

async function fetchClaimCleanupCards(apiKey, teamKey, projectId, states) {
  const byState = await fetchScheduledCleanupCards(apiKey, teamKey, projectId, states);
  return [...new Set(states || [])].flatMap((state) => byState.get(state) || []);
}

async function fetchCard(apiKey, issueId) {
  const d = await gql(
    `query($id:String!){ issue(id:$id){ id identifier updatedAt sortOrder state{ name }
       labels{ nodes{ id name } }
       comments(last:100){ nodes{ body createdAt } }
       inverseRelations(first:50){
         pageInfo{ hasNextPage endCursor }
         nodes{ id type issue{ id identifier state{ id name type } } }
       } } }`,
    { id: issueId },
    apiKey
  );
  const n = d.issue;
  if (!n) throw new Error(`issue not found: ${issueId}`);
  return normalizeQueueCard(n, apiKey, { gqlFn: gql, fetchIssueDependenciesFn: fetchIssueDependencies });
}

async function fetchClaimCard(apiKey, issueId) {
  const d = await gql(
    `query($id:String!){ issue(id:$id){ id identifier updatedAt sortOrder state{ name }
       labels{ nodes{ id name } }
       comments(last:100){ nodes{ body createdAt } } } }`,
    { id: issueId },
    apiKey,
  );
  if (!d.issue) throw new Error(`issue not found: ${issueId}`);
  return normalizeRelationUnknownCard(d.issue);
}

async function fetchBlockedIssues(apiKey, teamKey, projectId) {
  const issues = [];
  let cursor = null;
  do {
    const d = await gql(
      `query($c:String,$labels:[String!],$teamKey:String!,$pid:ID){ issues(first:100, after:$c, filter:{
         team:{ key:{ eq:$teamKey } }, project:{ id:{ eq:$pid } }, labels:{ name:{ in:$labels } } }){
         pageInfo{ hasNextPage endCursor }
         nodes{ id identifier title url updatedAt
           state{ name }
           labels{ nodes{ id name } }
           comments(last:20){ nodes{ body createdAt user{ name } } } } } }`,
      { c: cursor, labels: BLOCKING_LABELS, teamKey, pid: projectId },
      apiKey
    );
    for (const issue of d.issues.nodes) {
      const labelNames = issue.labels.nodes.map((l) => l.name);
      if (blockingLabelsForIssue(labelNames).length) issues.push(issue);
    }
    cursor = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (cursor);
  return issues;
}

export async function scanBlockedIssues({ registry = readRegistry(), isProjectActive = labeledProjectIds } = {}) {
  const cards = [];
  const warnings = [];
  const activeByKey = new Map();
  for (const anchorPath of registry.repos || []) {
    let config;
    try { config = anchorConfig(anchorPath); } catch (e) { warnings.push({ anchorPath, message: e.message }); continue; }
    const apiKey = anchorKey(anchorPath);
    if (!apiKey) { warnings.push({ anchorPath, message: "missing LINEAR_API_KEY in .env" }); continue; }
    let active = null;
    try {
      if (!activeByKey.has(apiKey)) activeByKey.set(apiKey, await isProjectActive(apiKey));
      active = activeByKey.get(apiKey).has(config.projectId);
    } catch (e) {
      warnings.push({ anchorPath, message: `project activation lookup failed: ${e.message}` });
    }
    try {
      const issues = await fetchBlockedIssues(apiKey, config.teamKey, config.projectId);
      cards.push(...issues.map((issue) => normalizeBlockedIssue(anchorPath, config, issue, { active })));
    } catch (e) {
      warnings.push({ anchorPath, message: `blocked issue query failed: ${e.message}` });
    }
  }
  cards.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  return { cards, warnings };
}

// Project-label activation (the auto-sweep on/off switch). find-or-create the
// workspace's `auto-sweep` project label, then add/remove it from the project.
async function findOrCreateAutoSweepLabel(apiKey) {
  const q = await gql(`query{ projectLabels(filter:{ name:{ eq:"${AUTO_SWEEP_LABEL}" } }){ nodes{ id name } } }`, {}, apiKey);
  const existing = q.projectLabels.nodes.find((n) => n.name === AUTO_SWEEP_LABEL);
  if (existing) return existing.id;
  const r = await gql(`mutation($n:String!){ projectLabelCreate(input:{ name:$n }){ success projectLabel{ id } } }`, { n: AUTO_SWEEP_LABEL }, apiKey);
  return r.projectLabelCreate.projectLabel.id;
}
async function projectLabelIds(apiKey, projectId) {
  const d = await gql(`query($id:String!){ project(id:$id){ labels{ nodes{ id } } } }`, { id: projectId }, apiKey);
  return d.project.labels.nodes.map((n) => n.id);
}
async function setProjectLabels(apiKey, projectId, ids) {
  await gql(`mutation($id:String!,$ids:[String!]){ projectUpdate(id:$id, input:{ labelIds:$ids }){ success } }`, { id: projectId, ids: [...new Set(ids)] }, apiKey);
}

async function teamLabelMap(apiKey, teamKey) {
  const labels = [];
  let after = null;
  do {
    const d = await gql(
      `query($k:String!,$after:String){ teams(filter:{ key:{ eq:$k } }){ nodes{ labels(first:50, after:$after){ nodes{ id name } pageInfo{ hasNextPage endCursor } } } } }`,
      { k: teamKey, after },
      apiKey
    );
    const team = d.teams.nodes[0];
    if (!team) return {};
    labels.push(...team.labels.nodes);
    after = team.labels.pageInfo.hasNextPage ? team.labels.pageInfo.endCursor : null;
  } while (after);
  return Object.fromEntries(labels.map((l) => [l.name, l.id]));
}

async function teamMeta(apiKey, teamKey) {
  const d = await gql(
    `query($k:String!){ teams(filter:{ key:{ eq:$k } }){ nodes{ id states(first:100){ nodes{ id name } } } } }`,
    { k: teamKey },
    apiKey
  );
  const team = d.teams.nodes[0];
  if (!team) throw new Error(`team ${teamKey} not found`);
  return {
    teamId: team.id,
    stateIds: Object.fromEntries(team.states.nodes.map((s) => [s.name, s.id])),
  };
}

async function setIssueLabels(apiKey, issueId, labelIds) {
  await gql(`mutation($id:String!,$ids:[String!]){ issueUpdate(id:$id, input:{ labelIds:$ids }){ success } }`, { id: issueId, ids: [...new Set(labelIds)] }, apiKey);
}

async function addComment(apiKey, issueId, body) {
  await gql(`mutation($id:String!,$b:String!){ commentCreate(input:{ issueId:$id, body:$b }){ success } }`, { id: issueId, b: body }, apiKey);
}

async function fetchIssueLabels(apiKey, issueId) {
  const d = await gql(
    `query($id:String!){ issue(id:$id){ id identifier team{ key } project{ id } labels{ nodes{ id name } } } }`,
    { id: issueId },
    apiKey
  );
  if (!d.issue) throw new Error(`issue not found: ${issueId}`);
  return {
    id: d.issue.id,
    identifier: d.issue.identifier,
    teamKey: d.issue.team?.key || null,
    projectId: d.issue.project?.id || null,
    labelIds: Object.fromEntries(d.issue.labels.nodes.map((l) => [l.name, l.id])),
  };
}

export async function resolveBlockedIssue(apiKey, issueId, labels, resolution, scope = {}) {
  const issue = await fetchIssueLabels(apiKey, issueId);
  if ((scope.teamKey && issue.teamKey !== scope.teamKey) || (scope.projectId && issue.projectId !== scope.projectId)) {
    throw new Error(`${issue.identifier} is outside configured anchor project/team; refusing to mutate`);
  }
  const selected = blockingLabelsForIssue(labels || []).filter((label) => issue.labelIds[label]);
  if (!selected.length) throw new Error(`no selected blocking labels are present on ${issue.identifier}`);
  await addComment(apiKey, issue.id, buildUnblockAuditComment({ labels: selected, resolution }));
  await setIssueLabels(apiKey, issue.id, labelIdsAfterRemoving(issue.labelIds, selected));
  return { identifier: issue.identifier, removedLabels: selected };
}

async function fetchFailureTodos(apiKey, teamKey, projectId) {
  const todos = [];
  let cursor = null;
  do {
    const d = await gql(
      `query($c:String,$teamKey:String!,$pid:ID){ issues(first:100, after:$c, filter:{
         team:{ key:{ eq:$teamKey } }, project:{ id:{ eq:$pid } }, state:{ name:{ eq:"Todo" } } }){
         pageInfo{ hasNextPage endCursor }
         nodes{ id identifier title description updatedAt createdAt
           comments(last:100){ nodes{ body createdAt } } } } }`,
      { c: cursor, teamKey, pid: projectId },
      apiKey
    );
    for (const n of d.issues.nodes) {
      const commentText = n.comments.nodes.map((c) => c.body).join("\n");
      if (!markerFingerprint(n.description) && !markerFingerprint(commentText)) continue;
      todos.push({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        description: n.description || "",
        updatedAt: n.updatedAt,
        createdAt: n.createdAt,
        comments: n.comments.nodes,
      });
    }
    cursor = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (cursor);
  return todos;
}

async function createFailureTodo(apiKey, meta, projectId, event, fingerprint, envValues) {
  const stateId = meta.stateIds.Todo;
  if (!stateId) throw new Error("Todo state not found on team");
  const r = await gql(
    `mutation($i:IssueCreateInput!){ issueCreate(input:$i){ success issue{ id identifier } } }`,
    { i: { teamId: meta.teamId, projectId, stateId, title: failureTodoTitle(event), description: failureTodoBody(event, fingerprint, { envValues }) } },
    apiKey
  );
  return r.issueCreate.issue;
}

async function updateFailureTodo(apiKey, todo, event, fingerprint, envValues) {
  await gql(
    `mutation($id:String!,$description:String!){ issueUpdate(id:$id, input:{ description:$description }){ success } }`,
    { id: todo.id, description: failureTodoBody(event, fingerprint, { envValues, firstSeen: failureTodoFirstSeen(todo) }) },
    apiKey
  );
  await addComment(apiKey, todo.id, `Failure still active for \`${event.scope || "_"}\` at ${event.seenAt || new Date().toISOString()}.\n\nLast error: ${sanitizeFailureMessage(event.message, envValues)}\n\n${FAILURE_TODO_TAG} ${fingerprint}]`);
}

async function closeFailureTodo(apiKey, meta, decision) {
  const doneId = meta.stateIds.Done;
  if (!doneId) throw new Error("Done state not found on team");
  const iso = new Date().toISOString();
  await addComment(apiKey, decision.todo.id, `${FAILURE_RECOVERED_TAG} ${decision.fingerprint} ${iso}] Later tick checked \`${failureTodoScope(decision.todo)}\` without seeing this failure. Moving to Done.`);
  await gql(`mutation($id:String!,$stateId:String!){ issueUpdate(id:$id, input:{ stateId:$stateId }){ success } }`, { id: decision.todo.id, stateId: doneId }, apiKey);
}

async function commentDuplicateFailureTodo(apiKey, decision) {
  await addComment(apiKey, decision.todo.id, `${FAILURE_DUPLICATE_NOTE} for \`${decision.fingerprint}\`. Keeping ${decision.primary.identifier} as the primary tracking card; this duplicate can be closed after manual review.`);
}

async function reconcileFailureTodos(apiKey, config, anchorPath, currentFailures, checkedScopes, envValues, { dryRun = false, recoveredTargets = new Set() } = {}) {
  const existing = await fetchFailureTodos(apiKey, config.teamKey, config.projectId);
  const decisions = failureTodoDecisions(currentFailures, existing, checkedScopes, Date.now(), { envValues, recoveredTargets });
  if (dryRun) return decisions;
  if (!decisions.length) return decisions;
  const meta = await teamMeta(apiKey, config.teamKey);
  for (const d of decisions) {
    if (d.action === "create") {
      const issue = await createFailureTodo(apiKey, meta, config.projectId, d.event, d.fingerprint, envValues);
      logFor(anchorPath, "_", `failure-todo create ${issue.identifier} ${d.fingerprint}`);
    } else if (d.action === "update") {
      await updateFailureTodo(apiKey, d.todo, d.event, d.fingerprint, envValues);
      logFor(anchorPath, "_", `failure-todo update ${d.todo.identifier} ${d.fingerprint}`);
    } else if (d.action === "close") {
      await closeFailureTodo(apiKey, meta, d);
      logFor(anchorPath, "_", `failure-todo recovered ${d.todo.identifier} ${d.fingerprint}`);
    } else if (d.action === "duplicate") {
      await commentDuplicateFailureTodo(apiKey, d);
      logFor(anchorPath, "_", `failure-todo duplicate ${d.todo.identifier} -> ${d.primary.identifier}`);
    }
  }
  return decisions;
}

// Drop one or more claim labels (+ optionally add labels) in a SINGLE write, and
// keep the in-memory card.labelIds in sync so a later executor on the same card
// computes from current state, not the pre-write snapshot (otherwise a full-set
// overwrite re-adds what an earlier write removed). Returns nothing.
async function applyLabelEdit(apiKey, card, { remove = [], add = {} }) {
  for (const name of remove) delete card.labelIds[name];
  for (const [name, id] of Object.entries(add)) card.labelIds[name] = id; // add after remove: add wins on a name collision
  card.labelNames = Object.keys(card.labelIds);
  await setIssueLabels(apiKey, card.id, Object.values(card.labelIds));
}

// Execute a reap/escalate decision: drop the claim label (+ optionally add
// blocked:needs-user) and post the audit comment.
async function executeReap(apiKey, card, decision, labelMap, sweep) {
  if (decision.action === "escalate-crash" && labelMap["blocked:needs-user"]) {
    await applyLabelEdit(apiKey, card, { remove: [decision.releaseClaim], add: { "blocked:needs-user": labelMap["blocked:needs-user"] } });
    await addComment(apiKey, card.id, `${REAPER_TAG} Auto-released stale \`${decision.releaseClaim}\` and set **blocked:needs-user** — the ${sweep} sweep has stranded this card ${decision.count}× (the runtime likely keeps dying on it). Needs a human before it retries.`);
  } else {
    await applyLabelEdit(apiKey, card, { remove: [decision.releaseClaim] });
    await addComment(apiKey, card.id, `${REAPER_TAG} Auto-released stale \`${decision.releaseClaim}\` claim (heartbeat idle > ${SWEEP_CFG[sweep].staleMin}m; the prior run likely froze or failed). Will retry.`);
  }
}

export function dirtyCheckoutEvent(pick, checkout, { gitFn = git } = {}) {
  if (!checkout?.path) return null;
  const status = gitFn(checkout.path, ["status", "--porcelain", "-uall"], { allowFail: true });
  const scope = `${pick.sweep}:dispatch`;
  const stableTarget = `${checkout.role}:${checkout.path}`;
  if (status.status !== 0) {
    return {
      scope,
      kind: "checkout-status",
      stableTarget,
      message: `${checkout.role} checkout status failed before dispatch: ${status.err || `exit ${status.status}`}`,
    };
  }
  if (!status.out) return null;
  const paths = status.out.split("\n").filter(Boolean);
  const changed = paths.length;
  const sample = paths.slice(0, 25).map((line) => `  ${line}`).join("\n");
  const overflow = changed > 25 ? `\n  ... and ${changed - 25} more path(s)` : "";
  return {
    scope,
    kind: "dirty-checkout",
    stableTarget,
    message: [
      `${checkout.role} checkout has ${changed} uncommitted path(s); refusing unattended ${pick.sweep}-sweep dispatch until committed, stashed, or reverted`,
      "paths:",
      `${sample}${overflow}`,
    ].join("\n"),
  };
}

export function checkoutDispatchBlockers(pick, reg = {}, { gitFn = git } = {}) {
  const checkouts = [];
  const managedRepoPaths = [...new Set((pick.managedRepoPaths || []).map((p) => path.resolve(p)))];
  if (pick.issueIdentifier && pick.config) {
    const worktree = pick.worktreePath || cardWorktreePath(pick.anchorPath, pick.config, pick.issueIdentifier);
    checkouts.push({ role: "worktree", path: worktree });
  }
  if (managedRepoPaths.length) {
    for (const repoPath of managedRepoPaths) {
      checkouts.push({ role: path.resolve(repoPath) === path.resolve(pick.anchorPath) ? "managed-anchor" : "managed-repo", path: repoPath });
    }
  } else {
    checkouts.push({ role: "anchor", path: pick.anchorPath });
  }
  if (reg.kitPath && !checkouts.some((c) => path.resolve(c.path) === path.resolve(reg.kitPath))) {
    checkouts.push({ role: "kit", path: reg.kitPath });
  }
  return checkouts
    .map((checkout) => dirtyCheckoutEvent(pick, checkout, { gitFn }))
    .filter(Boolean);
}

function cleanManagedCheckoutTargets(pick, reg = {}, { gitFn = git } = {}) {
  const targets = new Set();
  const checkouts = [];
  for (const repoPath of [...new Set((pick.managedRepoPaths || []).map((p) => path.resolve(p)))]) {
    checkouts.push({ role: path.resolve(repoPath) === path.resolve(pick.anchorPath) ? "managed-anchor" : "managed-repo", path: repoPath });
  }
  if (reg.kitPath && !checkouts.some((c) => path.resolve(c.path) === path.resolve(reg.kitPath))) {
    checkouts.push({ role: "kit", path: reg.kitPath });
  }
  for (const checkout of checkouts) {
    if (!dirtyCheckoutEvent({ sweep: "doctor" }, checkout, { gitFn })) targets.add(`${checkout.role}:${checkout.path}`);
  }
  return targets;
}

export function recoveredTargetsForManagedWorkspace({ sourceAnchorPath, config, setupResult, reg = {}, gitFn = git } = {}) {
  const record = setupResult?.record;
  if (!sourceAnchorPath || !config || !record) return new Set();
  let managedRepoPaths = [];
  try {
    managedRepoPaths = resolveWorkspaceRepos(sourceAnchorPath, config, { mode: "managed", workspaceRecord: record }).map((r) => r.path);
  } catch {
    managedRepoPaths = Object.values(record.repoMap || {}).map((entry) => entry?.managedPath).filter(Boolean);
  }
  return cleanManagedCheckoutTargets({ anchorPath: record.managedAnchorPath, managedRepoPaths }, reg, { gitFn });
}

export function handoffDirtyCheckoutFailures(candidate, reg = {}, { checkoutDispatchBlockersFn = checkoutDispatchBlockers } = {}) {
  return checkoutDispatchBlockersFn(candidate, reg)
    .map((b) => ({ ...b, anchorPath: candidate.anchorPath, config: candidate.config }));
}

function advisoryDirty(sourcePath, { gitFn = git } = {}) {
  const event = dirtyCheckoutEvent({ sweep: "doctor" }, { role: "source-advisory", path: sourcePath }, { gitFn });
  return event ? { ...event, kind: "source-advisory" } : null;
}

export function doctorReport({
  registry = readRegistry(),
  configsBySource = null,
  existsFn = fs.existsSync,
  gitFn = git,
  registryPath = REGISTRY_PATH,
  currentTick = null,
  lastTick = null,
  capacityState = null,
  capacityLedgerPath = CAPACITY_LEDGER,
  observationState = null,
  observationPath = OBSERVATIONS,
  resolveRuntimeFn = resolveRuntimeExecutable,
  runtimeEnvBySource = null,
  isAlive = isAlivePid,
  now = Date.now(),
} = {}) {
  const reg = normalizeRegistry(registry);
  const kitDirty = reg.kitPath && existsFn(reg.kitPath)
    ? dirtyCheckoutEvent({ sweep: "doctor" }, { role: "kit", path: reg.kitPath }, { gitFn })
    : null;
  const report = {
    ok: !kitDirty,
    registryPath,
    host: os.hostname(),
    user: os.userInfo().username,
    shipRunner: reg.shipRunner,
    kit: {
      path: reg.kitPath,
      remote: reg.kitRemote || null,
      ref: reg.kitRef || "main",
      exists: reg.kitPath ? existsFn(reg.kitPath) : false,
      dirty: kitDirty,
    },
    anchors: [],
  };
  report.capacity = capacityState || createCapacityLedger({
    ledgerPath: capacityLedgerPath,
    maxActiveChildren: reg.capacity.maxActiveChildren,
    isAlive,
  }).inspect();
  const telemetry = currentTick?.telemetry || lastTick?.telemetry || {};
  if (telemetry.capacityHighWater !== undefined) {
    report.capacity = { ...report.capacity, highWater: telemetry.capacityHighWater };
  }
  if (!report.capacity.healthy) report.ok = false;
  if (currentTick || lastTick) {
    report.tick = healthStatus({ currentTick, lastTick, isAlive, now });
    if (!report.tick.ok) report.ok = false;
  }
  if (currentTick) report.currentTickFailures = Array.isArray(currentTick.failures) ? currentTick.failures : [];
  const observations = observationState || createObservationStore({ observationPath, now: () => now }).snapshot();
  const waits = (observations.entries || [])
    .map((entry) => Number(entry.queueWaitMs))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const percentile = (fraction) => waits.length ? waits[Math.max(0, Math.ceil(fraction * waits.length) - 1)] : null;
  report.queue = { observed: waits.length, p50Ms: percentile(0.5), p90Ms: percentile(0.9) };
  report.deferred = {
    dependency: telemetry.dependencyDeferredCount || 0,
    capacity: telemetry.capacityDeferredCount ?? waits.length,
  };
  report.resources = {
    loadAverage1m: telemetry.loadAverage1m,
    freeMemoryBytes: telemetry.freeMemoryBytes,
    totalMemoryBytes: telemetry.totalMemoryBytes,
    memoryPressureAvailablePercent: telemetry.memoryPressureAvailablePercent,
  };
  report.metricsUnavailable = [...new Set([
    ...(telemetry.metricsUnavailable || []),
    ...(observations.healthy === false ? observations.errors || ["observations unavailable"] : []),
  ])];

  for (const sourceAnchorPath of reg.repos || []) {
    const record = workspaceRecordForSourceAnchor(sourceAnchorPath, reg);
    let config = configsBySource instanceof Map ? configsBySource.get(sourceAnchorPath) : null;
    if (!config && existsFn(sourceAnchorPath)) {
      try { config = anchorConfig(sourceAnchorPath); } catch { config = null; }
    }
    const managedRepoPaths = record && config
      ? resolveWorkspaceRepos(sourceAnchorPath, config, { mode: "managed", workspaceRecord: record }).map((r) => r.path)
      : (record ? [record.managedAnchorPath] : []);
    const sourceDirty = existsFn(sourceAnchorPath) ? advisoryDirty(sourceAnchorPath, { gitFn }) : null;
    const managedBlockers = record
      ? checkoutDispatchBlockers({ anchorPath: record.managedAnchorPath, managedRepoPaths, sweep: "doctor" }, { kitPath: null }, { gitFn })
      : [];
    const envPath = record ? path.join(record.managedAnchorPath, ".env") : null;
    const anchor = {
      sourceAnchorPath,
      sourceExists: existsFn(sourceAnchorPath),
      sourceDirty,
      managedWorkspaceRoot: record?.managedWorkspaceRoot || null,
      managedAnchorPath: record?.managedAnchorPath || null,
      managedExists: record ? existsFn(record.managedAnchorPath) : false,
      managedRepoPaths,
      managedBlockers,
      env: envPath ? { path: envPath, exists: existsFn(envPath) } : null,
    };
    if (config) {
      const runtimeEnv = runtimeEnvBySource instanceof Map
        ? (runtimeEnvBySource.get(sourceAnchorPath) || process.env)
        : (record?.managedAnchorPath ? dispatchEnvironment(record.managedAnchorPath) : process.env);
      anchor.runtimes = Object.fromEntries(SWEEPS.map((sweep) => {
        const runtime = runtimeConfigForSweep(config, sweep).runtime || "codex";
        return [sweep, resolveRuntimeFn(runtime, runtimeEnv)];
      }));
      if (Object.values(anchor.runtimes).some((resolution) => !resolution.ok)) report.ok = false;
    }
    if (managedBlockers.length) report.ok = false;
    report.anchors.push(anchor);
  }
  return report;
}

export function formatDoctorReport(report) {
  const highWater = report.capacity.highWater === undefined ? "" : `, high-water ${report.capacity.highWater}`;
  const lines = [
    `registry: ${report.registryPath}`,
    `host: ${report.host} user: ${report.user}`,
    `ship-runner: ${report.shipRunner ? "ON" : "off"}`,
    `kit: ${report.kit.path || "(unset)"}${report.kit.exists ? "" : " (missing)"}`,
    `capacity: ${report.capacity.active}/${report.capacity.max}${highWater}${report.capacity.healthy ? "" : " BLOCKED"}`,
  ];
  if (!report.capacity.healthy) {
    for (const error of report.capacity.errors || []) lines.push(`  capacity error: ${error}`);
  }
  if (report.tick) lines.push(`tick: ${report.tick.reason}`);
  for (const failure of report.currentTickFailures || []) {
    lines.push(`current tick failure: ${failure.kind || "unknown"}: ${failure.message || "(no detail)"}`);
  }
  const load = report.resources?.loadAverage1m;
  if (load) lines.push(`load: current=${load.end} peak=${load.max}`);
  const memory = report.resources?.freeMemoryBytes;
  const pressure = report.resources?.memoryPressureAvailablePercent;
  if (memory) {
    lines.push(`memory: free=${memory.end} minimum=${memory.min}${pressure ? ` pressure-available=${pressure.end}% minimum=${pressure.min}%` : ""}`);
  }
  const minutes = (milliseconds) => milliseconds === null ? "n/a" : `${Math.round(milliseconds / 60000)}m`;
  if (report.queue) lines.push(`queue: p50=${minutes(report.queue.p50Ms)} p90=${minutes(report.queue.p90Ms)}`);
  if (report.deferred) {
    lines.push(`dependency deferred=${report.deferred.dependency}`);
    lines.push(`capacity deferred=${report.deferred.capacity}`);
  }
  for (const gap of report.metricsUnavailable || []) lines.push(`metrics unavailable: ${gap}`);
  if (report.kit.dirty) lines.push(`  kit dirty: ${report.kit.dirty.message.replace(/\n/g, "\n  ")}`);
  for (const anchor of report.anchors) {
    lines.push("");
    lines.push(path.basename(anchor.sourceAnchorPath));
    lines.push(`  source:  ${anchor.sourceAnchorPath}${anchor.sourceExists ? "" : " (missing)"}`);
    if (anchor.sourceDirty) lines.push(`  source advisory dirty: ${anchor.sourceDirty.message.replace(/\n/g, "\n    ")}`);
    lines.push(`  managed: ${anchor.managedAnchorPath || "(missing metadata)"}${anchor.managedExists ? "" : " (missing)"}`);
    if (anchor.env) lines.push(`  env:     ${anchor.env.path}${anchor.env.exists ? "" : " (missing)"}`);
    for (const [sweep, runtime] of Object.entries(anchor.runtimes || {})) {
      lines.push(`  runtime ${sweep}: ${runtime.runtime} ${runtime.ok ? `${runtime.path} (${runtime.source})` : "MISSING"}`);
    }
    if (anchor.managedBlockers.length) {
      lines.push("  dispatch: BLOCKED");
      for (const blocker of anchor.managedBlockers) lines.push(`    ${blocker.message.replace(/\n/g, "\n    ")}`);
    } else {
      lines.push("  dispatch: OK");
    }
  }
  return lines.join("\n");
}

// Release orphaned/foreign claims (all of a card's, in one write) — no escalation;
// the card advanced and the owning sweep just crashed before dropping its claim.
// Uses ORPHAN_TAG (not REAPER_TAG) so it does not inflate the crash-escalation count.
async function executeOrphanReap(apiKey, card, decision) {
  await applyLabelEdit(apiKey, card, { remove: decision.releaseClaims });
  const list = decision.releaseClaims.map((c) => `\`${c}\``).join(", ");
  await addComment(apiKey, card.id, `${ORPHAN_TAG} Auto-released orphaned claim(s) ${list} — stale heartbeat in a state their owning sweep does not run; the prior run likely crashed after advancing the card but before dropping its claim.`);
}

async function executeBounce(apiKey, card, labelMap) {
  if (!labelMap["blocked:needs-user"]) return;
  await applyLabelEdit(apiKey, card, { add: { "blocked:needs-user": labelMap["blocked:needs-user"] } });
  await addComment(apiKey, card.id, `${PARK_TAG} Set **blocked:needs-user** — this card has bounced backward ${BOUNCE_ESCALATE_AFTER}+ times; two sweeps can't agree on it. Needs a human decision.`);
}

async function claimCardSlots(apiKey, anchorPath, config, sweep, cards, { parentRunId, limit, labelMap, now }) {
  const cfg = SWEEP_CFG[sweep];
  const claimId = labelMap[cfg.claim];
  if (!claimId) throw new Error(`missing team label ${cfg.claim}`);
  const claimed = [];
  const candidates = sortByBoardPosition(actionableCards(cards, cfg, now));
  for (const card of candidates) {
    if (claimed.length >= limit) break;
    const slotIndex = claimed.length;
    const owner = ownerToken({ parentRunId, issueIdentifier: card.identifier, slotIndex });
    try {
      await applyLabelEdit(apiKey, card, { add: { [cfg.claim]: claimId } });
      await addComment(apiKey, card.id, `${HEARTBEAT_TAG} ${new Date().toISOString()} owner=${owner} claim=${cfg.claim}] Claimed for same-repo parallel ${sweep} slot ${slotIndex + 1}/${limit}.`);
      await sleep(CLAIM_CONFIRM_DELAY_MS);
      const fresh = await fetchCard(apiKey, card.id);
      if (!claimConfirmed(fresh, cfg, owner, cfg.states)) {
        if (hasLabel(fresh, cfg.claim) && latestHeartbeatOwner(fresh, cfg.claim) === owner) {
          await applyLabelEdit(apiKey, fresh, { remove: [cfg.claim] });
        }
        logFor(anchorPath, sweep, `claim-skip ${card.identifier}: owner confirmation failed`);
        continue;
      }
      claimed.push({
        ...fresh,
        card: fresh,
        id: fresh.id,
        identifier: fresh.identifier,
        sweep,
        slotIndex,
        ownerToken: owner,
        sortOrder: fresh.sortOrder,
      });
    } catch (e) {
      logFor(anchorPath, sweep, `claim-skip ${card.identifier}: ${e.message}`);
    }
  }
  return claimed;
}

async function releaseOwnedDispatchClaim(apiKey, pick, reason) {
  const cfg = SWEEP_CFG[pick.sweep];
  if (!cfg || !pick.issueId || !pick.ownerToken) return false;
  const fresh = await fetchClaimCard(apiKey, pick.issueId);
  if (!hasLabel(fresh, cfg.claim)) return false;
  if (latestHeartbeatOwner(fresh, cfg.claim) !== pick.ownerToken) return false;
  await applyLabelEdit(apiKey, fresh, { remove: [cfg.claim] });
  await addComment(apiKey, fresh.id, `${ORPHAN_TAG} Released launch pre-claim \`${cfg.claim}\` for ${pick.issueIdentifier} — ${reason}. Will retry on a later tick.`);
  return true;
}

export async function expandDispatchBatch(batch, {
  dryRun,
  parentRunId,
  activeByAnchor,
  now,
  childIndexAllocator = createChildIndexAllocator(),
  claimCardSlotsFn = claimCardSlots,
  labelMap: providedLabelMap = null,
} = {}) {
  const expanded = [];
  for (const pick of batch) {
    if (pick.sweep === "ship") {
      expanded.push(pick);
      continue;
    }
    const rawSlotLimit = pick.slotLimit;
    const limit = rawSlotLimit === undefined
      ? sameRepoCardLimit(pick.config, pick.sweep)
      : Math.max(0, Math.floor(Number(rawSlotLimit)) || 0);
    let slots = [];
    if (limit <= 0) {
      logFor(pick.anchorPath, pick.sweep, `same-repo slots 0/0 selected under workspace candidate (${pick.count} actionable)`);
      continue;
    }
    if (dryRun) {
      slots = selectCardSlots(pick.cards || [], SWEEP_CFG[pick.sweep], pick.sweep, limit, now);
    } else {
      const active = activeByAnchor.get(pick.anchorPath);
      if (!active) continue;
      let labelMap;
      try {
        labelMap = providedLabelMap || await teamLabelMap(active.apiKey, pick.config.teamKey);
      } catch (e) {
        logFor(pick.anchorPath, pick.sweep, `claim label map error: ${e.message}`);
        continue;
      }
      slots = await claimCardSlotsFn(active.apiKey, pick.anchorPath, pick.config, pick.sweep, pick.cards || [], {
        parentRunId,
        limit,
        labelMap,
        now,
      });
    }
    logFor(pick.anchorPath, pick.sweep, `same-repo slots ${slots.length}/${limit} selected under workspace candidate (${pick.count} actionable)`);
    for (const slot of slots) {
      expanded.push(withCardDispatchEnv({
        anchorPath: pick.anchorPath,
        sourceAnchorPath: pick.sourceAnchorPath,
        managedRepoPaths: pick.managedRepoPaths,
        config: pick.config,
        sweep: pick.sweep,
        count: 1,
        topCard: slot.card,
        issueId: slot.id,
        issueIdentifier: slot.identifier,
        slotIndex: slot.slotIndex,
        ownerToken: slot.ownerToken,
        parentRunId,
        triggeredBy: pick.triggeredBy,
        trigger: pick.trigger,
        rotationRank: pick.rotationRank,
        handoffHops: pick.handoffHops,
        runtimeExecutable: pick.runtimeExecutable,
        runtimeLaneKey: pick.runtimeLaneKey,
        runtimeScope: pick.runtimeScope,
        runtimeStableTarget: pick.runtimeStableTarget,
        telemetry: pick.telemetry,
        resourceSampler: pick.resourceSampler,
        dependencyDeferredCount: pick.dependencyDeferredCount,
        dependencyDeferredIssues: pick.dependencyDeferredIssues,
      }, parentRunId, childIndexAllocator.next()));
    }
  }
  return expanded;
}

export async function buildSameRepoRefillDispatches({
  result,
  activeByAnchor,
  activeSameRepo,
  refillBudget,
  parentRunId,
  childIndexAllocator,
  reg = {},
  now = Date.now(),
  deferClaim = false,
  deps = {},
} = {}) {
  const pick = result?.pick || {};
  const sweep = pick.sweep;
  const logFn = deps.logFor || logFor;
  const empty = (reason) => ({ dispatches: [], reason });
  if (!result?.success || !pick.issueIdentifier) return empty("ineligible");
  if (sweep === "ship") {
    logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: ship`);
    return empty("ship");
  }
  if (refillBudget?.disabled) {
    logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: disabled`);
    return empty("disabled");
  }
  if (!refillBudget || refillBudget.remaining <= 0) {
    logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: budget`);
    return empty("budget");
  }
  const limit = sameRepoCardLimit(pick.config, sweep);
  const active = activeByAnchor?.get(pick.anchorPath);
  if (!active) return empty("inactive-anchor");

  let activeProjects;
  try {
    activeProjects = await (deps.labeledProjectIds || labeledProjectIds)(active.apiKey);
  } catch (e) {
    logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: activation-query ${e.message}`);
    return empty("activation-query");
  }
  if (!activeProjects.has(pick.config.projectId)) {
    logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: inactive-project`);
    return empty("inactive-project");
  }

  const blockers = (deps.checkoutDispatchBlockers || checkoutDispatchBlockers)(pick, reg);
  if (blockers.length) {
    logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: dirty-checkout`);
    return { dispatches: [], reason: "dirty-checkout", blockers };
  }

  let cards;
  try {
    cards = await (deps.fetchCards || fetchCards)(active.apiKey, pick.config.teamKey, pick.config.projectId, SWEEP_CFG[sweep].states);
  } catch (e) {
    logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: fetch ${e.message}`);
    return empty("fetch");
  }
  const availableByCapacity = sameRepoAvailableSlots({
    cards,
    cfg: SWEEP_CFG[sweep],
    anchorPath: pick.anchorPath,
    sweep,
    activeSameRepo,
    limit,
    now,
  });
  const availableSlots = Math.min(availableByCapacity, refillBudget.remaining);
  if (availableSlots <= 0) {
    logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: no-capacity`);
    return empty("no-capacity");
  }
  const actionable = sortByBoardPosition(actionableCards(cards, SWEEP_CFG[sweep], now));
  if (!actionable.length) {
    logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: no-actionable`);
    return empty("no-actionable");
  }

  const batch = [{
    anchorPath: pick.anchorPath,
    sourceAnchorPath: pick.sourceAnchorPath,
    managedRepoPaths: pick.managedRepoPaths,
    config: pick.config,
    sweep,
    count: actionable.length,
    topCard: actionable[0],
    topSortOrder: actionable[0].sortOrder,
    cards: actionable,
    slotLimit: availableSlots,
    triggeredBy: { issue: result.issueIdentifier, sweep, kind: "same-repo-refill" },
    runtimeExecutable: pick.runtimeExecutable,
    runtimeLaneKey: pick.runtimeLaneKey,
    runtimeScope: pick.runtimeScope,
    runtimeStableTarget: pick.runtimeStableTarget,
  }];
  let dispatches;
  if (deferClaim) {
    dispatches = admissionDemandsForCandidates(batch, { trigger: "refill", now });
  } else {
    let labelMap;
    try {
      labelMap = await (deps.teamLabelMap || teamLabelMap)(active.apiKey, pick.config.teamKey);
    } catch (e) {
      logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: label-map`);
      return empty("label-map");
    }
    dispatches = await expandDispatchBatch(batch, {
      dryRun: false,
      parentRunId,
      activeByAnchor,
      now,
      childIndexAllocator,
      claimCardSlotsFn: deps.claimCardSlots,
      labelMap,
    });
  }
  if (!dispatches.length) {
    logFn(pick.anchorPath, sweep, `refill-skip ${sweep}: no-actionable`);
    return empty("no-actionable");
  }
  refillBudget.remaining = Math.max(0, refillBudget.remaining - dispatches.length);
  logFn(pick.anchorPath, sweep, `refill-trigger ${result.issueIdentifier}: ${sweep} ${dispatches.length}/${limit}`);
  return { dispatches, reason: "triggered" };
}

// ── IO: auto-update ──────────────────────────────────────────────────────────

function kitMarker(kitPath) {
  const vf = path.join(kitPath, "VERSION");
  if (fs.existsSync(vf)) return fs.readFileSync(vf, "utf8").trim();
  return git(kitPath, ["rev-parse", "HEAD"], { allowFail: true }).out || null;
}

// Copy scheduled sweep skills plus manual operator skills into a checkout root.
// Scheduled dirs stay derived from SWEEP_CFG; manual dirs are explicit so they
// propagate to anchors without becoming eligible for unattended dispatch.
function copySkillsInto(root, kit, marker) {
  for (const s of PROPAGATED_SKILL_DIRS) {
    fs.cpSync(path.join(kit, "skills", s), path.join(root, ".claude", "skills", s), { recursive: true });
  }
  fs.writeFileSync(path.join(root, ".claude", "skills", ".sweep-version"), marker + "\n");
}

// Refresh an anchor's committed skills, ALWAYS landing the commit on `main`.
// If `main` is checked out clean in the primary tree, commit there; otherwise use
// a dedicated throwaway worktree checked out on `main`, so a stray feature branch
// in the primary tree never receives the skills commit.
export function refreshAnchorSkills(anchor, kit, marker) {
  const head = git(anchor, ["symbolic-ref", "--short", "HEAD"], { allowFail: true }).out;
  if (head === "main") {
    if (git(anchor, ["status", "--porcelain"], { allowFail: true }).out) return { ok: false, reason: "main dirty — skipped" };
    copySkillsInto(anchor, kit, marker);
    git(anchor, ["add", ".claude/skills"], { allowFail: true });
    git(anchor, ["commit", "-m", `chore(sweeps): update skills to ${marker}`], { allowFail: true });
    const p = pushWithRetry(anchor, "main");
    return { ok: p.ok, reason: p.ok ? "committed on main" : "push failed" };
  }
  // Primary tree is elsewhere — commit to main via a dedicated worktree.
  const wt = path.join(anchor, ".worktrees", ".skills-update");
  git(anchor, ["worktree", "remove", "--force", wt], { allowFail: true }); // clear any leftover
  const add = git(anchor, ["worktree", "add", wt, "main"], { allowFail: true });
  if (add.status !== 0) return { ok: false, reason: `cannot check out main in a worktree (already checked out elsewhere?): ${add.err}` };
  try {
    copySkillsInto(wt, kit, marker);
    git(wt, ["add", ".claude/skills"], { allowFail: true });
    git(wt, ["commit", "-m", `chore(sweeps): update skills to ${marker}`], { allowFail: true });
    const p = pushWithRetry(wt, "main");
    return { ok: p.ok, reason: p.ok ? "committed on main via worktree" : "push failed" };
  } finally {
    git(anchor, ["worktree", "remove", "--force", wt], { allowFail: true });
  }
}

export function runUpdate(reg, onFailure = () => {}, { stateDir = STATE_DIR } = {}) {
  if (!reg.autoUpdate || !reg.kitPath) return;
  const updateLog = (msg) => writeLogAt(stateDir, "_", "_", msg);
  const kit = reg.kitPath;
  if (reg.kitRemote) {
    const url = git(kit, ["remote", "get-url", "origin"], { allowFail: true }).out;
    if (url !== reg.kitRemote) {
      const msg = `kit remote ${url} != expected ${reg.kitRemote} — skipping self-update`;
      updateLog(`update: ${msg}`);
      onFailure(null, "update", "kit-remote", kit, msg);
      return;
    }
  }
  const before = git(kit, ["rev-parse", "HEAD"], { allowFail: true }).out;
  const fetchResult = git(kit, ["fetch", "origin", reg.kitRef], { allowFail: true });
  if (fetchResult.status !== 0) {
    const msg = `kit fetch failed for origin/${reg.kitRef}: ${fetchResult.err}`;
    updateLog(`update: ${msg}`);
    onFailure(null, "update", "kit-fetch", kit, msg);
    return;
  }
  const merge = git(kit, ["merge", "--ff-only", `origin/${reg.kitRef}`], { allowFail: true });
  if (merge.status !== 0) {
    const msg = `kit clone not fast-forwardable (diverged/dirty) — left alone: ${merge.err}`;
    updateLog(`update: ${msg}`);
    onFailure(null, "update", "kit-fast-forward", kit, msg);
    return;
  }
  const after = git(kit, ["rev-parse", "HEAD"], { allowFail: true }).out;
  if (before !== after) {
    const diff = git(kit, ["log", "--oneline", `${before}..${after}`], { allowFail: true }).out;
    updateLog(`update: kit ${before?.slice(0, 8)}..${after?.slice(0, 8)}\n${diff}`);
  }
  const marker = kitMarker(kit);
  for (const anchor of reg.repos) {
    try {
      // Compare against what MAIN carries (via git show), not the primary working
      // tree — which may be on a lagging feature branch and would loop-update.
      const installed = git(anchor, ["show", "main:.claude/skills/.sweep-version"], { allowFail: true }).out || null;
      if (!isNewerVersion(marker, installed)) continue;
      const res = refreshAnchorSkills(anchor, kit, marker);
      updateLog(`update: ${anchorSlug(anchor)} skills → ${marker} (${res.reason})`);
      if (!res.ok) onFailure(anchor, "update", "skills-refresh", marker, res.reason);
    } catch (e) {
      updateLog(`update: ${anchorSlug(anchor)} failed: ${e.message}`);
      onFailure(anchor, "update", "skills-refresh", marker, e.message);
    }
  }
}

// ── IO: dispatch ─────────────────────────────────────────────────────────────

export function classifyDispatchOutcome(event = {}) {
  const base = {
    code: null,
    exitCode: event.exitCode ?? null,
    signal: event.signal ?? null,
    path: event.path ?? null,
    cwd: event.cwd ?? null,
  };
  if (event.type === "interruption") return { kind: "interrupted", ...base, code: "INTERRUPTED" };
  if (event.type === "error") {
    const code = event.error?.code || event.code || "SPAWN_ERROR";
    if (code === "ENOENT") {
      if (event.cwdExists === false) return { kind: "cwd-enoent", ...base, code };
      if (event.executableExists === false) return { kind: "executable-enoent", ...base, code };
    }
    return { kind: "spawn-error", ...base, code };
  }
  if (base.signal) return { kind: "signal", ...base };
  if (base.exitCode === 0) return { kind: "success", ...base };
  return { kind: "exit", ...base };
}

export function runtimeDisabledByOutcome(outcome) {
  return outcome?.kind === "executable-enoent";
}

export function createDispatchAbortContext({ processLike = process } = {}) {
  const controller = new AbortController();
  let interruptedSignal = null;
  const handlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => {
    if (controller.signal.aborted) return;
    interruptedSignal = signal;
    controller.abort({ signal });
  }]));
  for (const [signal, handler] of handlers) processLike.on(signal, handler);
  return {
    controller,
    signal: controller.signal,
    get interruptedSignal() { return interruptedSignal; },
    dispose() {
      for (const [signal, handler] of handlers) processLike.off(signal, handler);
    },
  };
}

function interruptedSignalFor(signal, fallback = null) {
  const reason = signal?.reason;
  if (reason && typeof reason === "object" && reason.signal) return reason.signal;
  return typeof reason === "string" ? reason : fallback;
}

function writeRunRecord({ pick = {}, runtimeCfg = {}, logFile, outcome, startedAt, endedAt }) {
  if (!pick.issueIdentifier || !pick.logDir) return;
  let metrics = {};
  try {
    pick.resourceSampler?.sample?.();
    metrics = pick.resourceSampler?.snapshot?.() || {};
  } catch (error) {
    metrics = { metricsUnavailable: [String(error?.message || error)] };
  }
  const telemetry = pick.telemetry || {};
  const record = {
    parentRunId: pick.parentRunId,
    cardRunId: pick.cardRunId,
    issueIdentifier: pick.issueIdentifier,
    sweep: pick.sweep,
    slotIndex: pick.slotIndex || 0,
    sameRepoLimit: pick.sameRepoLimit,
    worktreePath: pick.worktreePath,
    logPath: logFile,
    ports: pick.appPort ? { base: pick.portBase, app: pick.appPort } : undefined,
    runtime: runtimeCfg.runtime || "codex",
    model: runtimeCfg.model,
    effort: runtimeCfg.effort,
    triggeredBy: pick.triggeredBy,
    trigger: pick.trigger,
    firstObservedActionableAt: telemetry.firstObservedActionableAt,
    claimAt: telemetry.claimAt,
    dispatchAt: startedAt,
    queueWaitMs: telemetry.queueWaitMs,
    resolvedRuntimeExecutable: pick.runtimeExecutable,
    capacitySlot: telemetry.capacitySlot,
    capacityHighWater: Math.max(telemetry.capacityHighWater || 0, metrics.capacityHighWater || 0) || undefined,
    loadAverage1m: metrics.loadAverage1m,
    freeMemoryBytes: metrics.freeMemoryBytes,
    totalMemoryBytes: metrics.totalMemoryBytes,
    memoryPressureAvailablePercent: metrics.memoryPressureAvailablePercent,
    metricsUnavailable: metrics.metricsUnavailable,
    dependencyDeferredCount: pick.dependencyDeferredCount,
    dependencyDeferredIssues: pick.dependencyDeferredIssues,
    outcome,
    exitCode: outcome?.exitCode ?? null,
    startedAt,
    endedAt,
  };
  fs.mkdirSync(pick.logDir, { recursive: true });
  const f = path.join(pick.logDir, `run-records-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`);
  fs.appendFileSync(f, JSON.stringify(record) + "\n");
}

function dispatchEnvironment(anchorPath, pick = {}) {
  const envFile = path.join(anchorPath, ".env");
  return {
    ...process.env,
    ...parseEnv(fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : ""),
    ...(pick.childEnv || {}),
  };
}

function dispatch(anchorPath, sweep, config, pick = {}) {
  const runtimeCfg = runtimeConfigForSweep(config, sweep);
  const { cmd, args, cwd } = buildCommand({ ...runtimeCfg, sweep, anchorPath, issueIdentifier: pick.issueIdentifier });
  const executable = pick.runtimeExecutable || cmd;
  const env = dispatchEnvironment(anchorPath, pick);
  const dir = pick.logDir || path.join(STATE_DIR, anchorSlug(anchorPath), sweep);
  fs.mkdirSync(dir, { recursive: true });
  if (pick.tmpDir) fs.mkdirSync(pick.tmpDir, { recursive: true });
  if (pick.screenshotDir) fs.mkdirSync(pick.screenshotDir, { recursive: true });
  if (pick.browserProfileDir) fs.mkdirSync(pick.browserProfileDir, { recursive: true });
  const logFile = path.join(dir, `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`);
  const fd = fs.openSync(logFile, "a");
  const startedAt = new Date().toISOString();
  logFor(anchorPath, sweep, `dispatch${pick.issueIdentifier ? ` ${pick.issueIdentifier}` : ""}: ${runtimeSummary(runtimeCfg)} → ${executable} ${args.slice(0, 3).join(" ")} …`);
  const r = spawnSync(executable, args, { cwd, env, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  const outcome = r.error
    ? classifyDispatchOutcome({ type: "error", error: r.error, path: executable, cwd, cwdExists: fs.existsSync(cwd), executableExists: fs.existsSync(executable) })
    : classifyDispatchOutcome({ type: "close", exitCode: r.status, signal: r.signal, path: executable, cwd });
  if (r.error) logFor(anchorPath, sweep, `FATAL dispatch could not start ${executable}: ${r.error.message}`);
  logFor(anchorPath, sweep, `dispatch${pick.issueIdentifier ? ` ${pick.issueIdentifier}` : ""} end (${outcome.kind}${outcome.exitCode === null ? "" : ` ${outcome.exitCode}`}${outcome.signal ? ` ${outcome.signal}` : ""})`);
  writeRunRecord({ pick, runtimeCfg, logFile, outcome, startedAt, endedAt: new Date().toISOString() });
  return outcome;
}

export function dispatchAsync(anchorPath, sweep, config, pick = {}, { spawnFn = spawn, signal = null, onSpawn = null } = {}) {
  const runtimeCfg = runtimeConfigForSweep(config, sweep);
  const { cmd, args, cwd } = buildCommand({ ...runtimeCfg, sweep, anchorPath, issueIdentifier: pick.issueIdentifier });
  const executable = pick.runtimeExecutable || cmd;
  const env = dispatchEnvironment(anchorPath, pick);
  const dir = pick.logDir || path.join(STATE_DIR, anchorSlug(anchorPath), sweep);
  fs.mkdirSync(dir, { recursive: true });
  if (pick.tmpDir) fs.mkdirSync(pick.tmpDir, { recursive: true });
  if (pick.screenshotDir) fs.mkdirSync(pick.screenshotDir, { recursive: true });
  if (pick.browserProfileDir) fs.mkdirSync(pick.browserProfileDir, { recursive: true });
  const logFile = path.join(dir, `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`);
  const fd = fs.openSync(logFile, "a");
  const startedAt = new Date().toISOString();
  logFor(anchorPath, sweep, `dispatch${pick.issueIdentifier ? ` ${pick.issueIdentifier}` : ""}: ${runtimeSummary(runtimeCfg)} → ${executable} ${args.slice(0, 3).join(" ")} …`);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      fs.closeSync(fd);
      logFor(anchorPath, sweep, `dispatch${pick.issueIdentifier ? ` ${pick.issueIdentifier}` : ""} end (${outcome.kind}${outcome.exitCode === null ? "" : ` ${outcome.exitCode}`}${outcome.signal ? ` ${outcome.signal}` : ""})`);
      writeRunRecord({ pick, runtimeCfg, logFile, outcome, startedAt, endedAt: new Date().toISOString() });
      resolve(outcome);
    };
    let child;
    try {
      child = spawnFn(executable, args, { cwd, env, stdio: ["ignore", fd, fd], signal: signal || undefined });
    } catch (e) {
      finish(classifyDispatchOutcome({ type: "error", error: e, path: executable, cwd, cwdExists: fs.existsSync(cwd), executableExists: fs.existsSync(executable) }));
      return;
    }
    if (onSpawn) {
      try {
        if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("spawned child has no verifiable PID");
        if (onSpawn(child.pid, child) === false) throw new Error("capacity ledger rejected child PID");
      } catch (error) {
        const attachError = new Error(`capacity PID attachment failed: ${error.message}`);
        attachError.code = "CAPACITY_ATTACH_FAILED";
        logFor(anchorPath, sweep, `FATAL ${attachError.message}; terminating child ${child?.pid || "unknown"}`);
        child.on("error", (childError) => {
          logFor(anchorPath, sweep, `child error while awaiting capacity-safe termination: ${childError.message}`);
        });
        child.once("close", () => finish(classifyDispatchOutcome({
          type: "error",
          error: attachError,
          path: executable,
          cwd,
          cwdExists: fs.existsSync(cwd),
          executableExists: fs.existsSync(executable),
        })));
        try { child.kill?.("SIGTERM"); } catch (killError) {
          logFor(anchorPath, sweep, `could not terminate child after PID attachment failure: ${killError.message}`);
        }
        return;
      }
    }
    child.on("error", (e) => {
      logFor(anchorPath, sweep, `FATAL dispatch could not start ${executable}: ${e.message}`);
      const interrupted = e.code === "ABORT_ERR" || signal?.aborted;
      finish(classifyDispatchOutcome(interrupted
        ? { type: "interruption", signal: interruptedSignalFor(signal), path: executable, cwd }
        : { type: "error", error: e, path: executable, cwd, cwdExists: fs.existsSync(cwd), executableExists: fs.existsSync(executable) }));
    });
    child.on("close", (exitCode, childSignal) => finish(classifyDispatchOutcome(signal?.aborted
      ? { type: "interruption", signal: interruptedSignalFor(signal, childSignal), path: executable, cwd }
      : { type: "close", exitCode, signal: childSignal, path: executable, cwd })));
  });
}

export async function dispatchBatch(batch, { dispatchFn = dispatchAsync, onResult, signal = null, dispatchOptions = {} } = {}) {
  return Promise.all(batch.map(async (c) => {
    const startedAt = new Date().toISOString();
    const outcome = await dispatchFn(c.anchorPath, c.sweep, c.config, c, { ...dispatchOptions, signal });
    const completedAt = new Date().toISOString();
    const result = {
      anchorPath: c.anchorPath,
      sweep: c.sweep,
      issueIdentifier: c.issueIdentifier,
      dispatchScope: c.issueIdentifier ? `${c.sweep}:${c.issueIdentifier}:dispatch` : `${c.sweep}:dispatch`,
      ...outcome,
      outcome,
      success: outcome.kind === "success",
      startedAt,
      completedAt,
      pick: c,
    };
    if (onResult) await onResult(result);
    return result;
  }));
}

// ── tick orchestration ───────────────────────────────────────────────────────

async function tick({ dryRun = false } = {}) {
  const reg = readRegistry();
  const parentRunId = `${os.hostname()}-${process.pid}-${Date.now().toString(36)}`;
  const localFailures = [];
  let tickState = null;
  let dispatchAbortContext = null;
  if (!dryRun) {
    if (!acquireTickLock()) { log("another tick holds the lock — exit"); return; }
    const startedAt = new Date().toISOString();
    tickState = { version: TICK_STATE_VERSION, status: "running", pid: process.pid, parentRunId, startedAt, at: startedAt, kit: null, failures: [] };
  }
  try {
    if (!dryRun) {
      atomicWriteJson(CURRENT_TICK, tickState);
      dispatchAbortContext = createDispatchAbortContext();
    }
    const updateFailures = [];
    const activeByAnchor = new Map();
    const runtimeCache = new Map();
    const reportedRuntimeFailures = new Set();
    const activeSameRepo = createSameRepoActiveCounts();
    const childIndexAllocator = createChildIndexAllocator();
    const capacityLedger = createCapacityLedger({ maxActiveChildren: reg.capacity.maxActiveChildren });
    const observationStore = createObservationStore({ dryRun });
    const resourceSampler = createResourceSampler();
    const dependencyDeferredKeys = new Set();
    const dependencyDeferredIssues = new Map();
    const capacityDeferredKeys = new Set();
    const refillBudget = { remaining: 0 };
    observationStore.sync();
    const failureEventFor = (anchorPath, config, scope, kind, stableTarget, message) => ({
      anchorPath,
      anchorSlug: anchorSlug(anchorPath),
      projectId: config?.projectId || "unknown",
      scope,
      kind,
      stableTarget,
      message: String(message || ""),
      seenAt: new Date().toISOString(),
    });
    const reconcileDispatchResult = async (result) => {
      const pick = result.pick;
      const active = activeByAnchor.get(pick.anchorPath);
      if (!active) return null;
      const runtimeCfg = runtimeConfigForSweep(pick.config, pick.sweep);
      const runtime = runtimeSummary(runtimeCfg);
      const dispatchScope = result.dispatchScope;
      const stableTarget = pick.issueIdentifier ? JSON.stringify({
        runtime,
        issueIdentifier: pick.issueIdentifier,
        worktreePath: pick.worktreePath,
        logDir: pick.logDir,
      }) : runtime;
      const startFailure = ["executable-enoent", "cwd-enoent", "spawn-error"].includes(result.kind);
      const releaseClaim = startFailure || result.kind === "interrupted";
      const detail = result.signal || result.code || result.exitCode;
      const failures = result.kind === "success" ? [] : [
        failureEventFor(pick.anchorPath, pick.config, dispatchScope, startFailure ? "dispatch-start" : "dispatch-exit", stableTarget, `${pick.sweep}-sweep${pick.issueIdentifier ? ` for ${pick.issueIdentifier}` : ""} via ${runtime} ended ${result.kind}${detail === null ? "" : ` (${detail})`}`),
      ];
      if (runtimeDisabledByOutcome(result)) {
        const runtimeName = runtimeCfg.runtime || "codex";
        const key = pick.runtimeLaneKey || runtimeLaneKey(pick.anchorPath, runtimeName, os.hostname());
        runtimeCache.set(key, { ok: false, runtime: runtimeName, code: "ENOENT", path: null, source: null });
        if (!reportedRuntimeFailures.has(key)) {
          reportedRuntimeFailures.add(key);
          localFailures.push(failureEventFor(
            pick.anchorPath,
            pick.config,
            pick.runtimeScope || `runtime:${runtimeName}:${os.hostname()}`,
            "runtime-disappeared",
            pick.runtimeStableTarget || JSON.stringify({ sourceAnchorPath: pick.sourceAnchorPath || pick.anchorPath, runtime: runtimeName, host: os.hostname() }),
            `${runtimeName} executable disappeared after preflight on ${os.hostname()}`,
          ));
          writeCurrentTick();
        }
      }
      if (releaseClaim && pick.issueIdentifier) {
        try {
          const released = await releaseOwnedDispatchClaim(active.apiKey, pick, `dispatcher via ${runtime} could not start`);
          if (released) logFor(pick.anchorPath, pick.sweep, `released pre-claim after dispatch-start failure ${pick.issueIdentifier}`);
        } catch (e) {
          logFor(pick.anchorPath, pick.sweep, `pre-claim release failed ${pick.issueIdentifier}: ${e.message}`);
          recordLocalFailure(pick.anchorPath, pick.config, dispatchScope, "claim-release", stableTarget, e.message);
          writeCurrentTick();
        }
      }
      try {
        await reconcileFailureTodos(active.apiKey, pick.config, pick.anchorPath, failures, new Set([dispatchScope]), active.envValues, { dryRun: false });
      } catch (e) {
        const kind = result.kind === "success" ? "failure-todo-recovery" : "failure-todo";
        logFor(pick.anchorPath, "_", `FATAL failure-todo post-dispatch reconciliation failed: ${e.message}`);
        recordLocalFailure(pick.anchorPath, pick.config, dispatchScope, kind, runtime, e.message);
        writeCurrentTick();
      }
      observationStore.clear(pick);
      capacityDeferredKeys.delete(observationKey(pick));
      return active;
    };
    const runHandoffTriggers = async (current, firedHandoffs, handoffBudget) => {
      const completedHops = current.pick.handoffHops || 0;
      const maxHops = maxHandoffTriggerHops(current.pick.config);
      if (maxHops <= 0) {
        logFor(current.pick.anchorPath, current.pick.sweep, `handoff-skip ${current.pick.issueIdentifier}: disabled`);
        return [];
      }
      if (completedHops >= maxHops) {
        logFor(current.pick.anchorPath, current.pick.sweep, `handoff-skip ${current.pick.issueIdentifier}: hop-limit`);
        return [];
      }
      if (current?.success && current.pick?.issueIdentifier) {
        const pick = current.pick;
        const active = activeByAnchor.get(pick.anchorPath);
        if (!active) return;
        let issue;
        try {
          issue = await fetchCard(active.apiKey, pick.issueId || pick.issueIdentifier);
        } catch (e) {
          logFor(pick.anchorPath, pick.sweep, `handoff-skip ${pick.issueIdentifier}: issue-fetch ${e.message}`);
          return;
        }
        const nextSweep = nextSweepForHandoff({
          completedSweep: pick.sweep,
          currentStateName: issue.stateName,
          sweepCfg: SWEEP_CFG,
        });
        if (!nextSweep) {
          if (pick.sweep === "qa") logFor(pick.anchorPath, pick.sweep, `handoff-skip ${issue.identifier}: ship-gate`);
          else logFor(pick.anchorPath, pick.sweep, `handoff-skip ${issue.identifier}: not-forward state=${issue.stateName}`);
          return;
        }
        const key = handoffTriggerKey(issue.identifier, pick.sweep, nextSweep);
        if (firedHandoffs.has(key)) {
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: duplicate ${key}`);
          return;
        }
        let activeProjects;
        try {
          activeProjects = await labeledProjectIds(active.apiKey);
        } catch (e) {
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: activation-query ${e.message}`);
          return;
        }
        if (!activeProjects.has(pick.config.projectId)) {
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: inactive-project`);
          return;
        }
        if (BLOCKING_LABELS.some((name) => hasLabel(issue, name))) {
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: blocked`);
          return;
        }
        const nextCfg = SWEEP_CFG[nextSweep];
        if (hasLabel(issue, nextCfg.claim) && liveClaimLabel(issue, Date.now()) === nextCfg.claim) {
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: live-claim`);
          return;
        }
        if (!handoffBudget || handoffBudget.remaining <= 0) {
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: capacity`);
          return;
        }
        let targetCards;
        try {
          targetCards = await fetchCards(active.apiKey, pick.config.teamKey, pick.config.projectId, nextCfg.states);
        } catch (e) {
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: fetch ${e.message}`);
          return;
        }
        const targetLimit = sameRepoCardLimit(pick.config, nextSweep);
        const availableSlots = sameRepoAvailableSlots({
          cards: targetCards,
          cfg: nextCfg,
          anchorPath: pick.anchorPath,
          sweep: nextSweep,
          activeSameRepo,
          limit: targetLimit,
          now: Date.now(),
        });
        if (availableSlots <= 0) {
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: capacity`);
          return;
        }

        const candidate = {
          anchorPath: pick.anchorPath,
          sourceAnchorPath: pick.sourceAnchorPath,
          managedRepoPaths: pick.managedRepoPaths,
          config: pick.config,
          sweep: nextSweep,
          count: 1,
          topCard: issue,
          topSortOrder: issue.sortOrder,
          cards: [issue],
          handoffHops: completedHops + 1,
          triggeredBy: { issue: issue.identifier, sweep: pick.sweep },
        };
        const dirtyFailures = handoffDirtyCheckoutFailures(candidate, reg)
          .map((b) => failureEventFor(candidate.anchorPath, candidate.config, b.scope, b.kind, b.stableTarget, b.message));
        if (dirtyFailures.length) {
          active.failures.push(...dirtyFailures);
          for (const failure of dirtyFailures) logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: dirty-checkout ${failure.message}`);
          try {
            await reconcileFailureTodos(active.apiKey, candidate.config, candidate.anchorPath, dirtyFailures, new Set(), active.envValues, { dryRun: false });
          } catch (e) {
            logFor(candidate.anchorPath, "_", `FATAL failure-todo handoff dirty-checkout reconciliation failed: ${e.message}`);
            recordLocalFailure(candidate.anchorPath, candidate.config, `${candidate.sweep}:dispatch`, "failure-todo", candidate.anchorPath, e.message);
            writeCurrentTick();
          }
          return;
        }
        const batch = selectDispatchBatch([candidate], { maxNonShipDispatches: 1 });
        if (!batch.length) {
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: capacity`);
          return;
        }
        const [runtimeReadyCandidate] = (await preflightCandidatesForTick(batch)).ready;
        if (!runtimeReadyCandidate) {
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: runtime-preflight`);
          return;
        }
        handoffBudget.remaining -= 1;
        firedHandoffs.add(key);
        logFor(pick.anchorPath, nextSweep, `handoff-trigger ${issue.identifier}: ${pick.sweep}->${nextSweep}`);
        const downstream = admissionDemandsForCandidates([runtimeReadyCandidate], {
          trigger: "handoff",
          now: Date.now(),
        }).map((d) => ({ ...d, triggeredBy: { issue: issue.identifier, sweep: pick.sweep } }));
        if (!downstream.length) {
          handoffBudget.remaining += 1;
          logFor(pick.anchorPath, nextSweep, `handoff-skip ${issue.identifier}: capacity`);
          return [];
        }
        return downstream;
      }
      return [];
    };
    const recordLocalFailure = (anchorPath, config, scope, kind, stableTarget, message) => {
      localFailures.push(failureEventFor(anchorPath, config, scope, kind, stableTarget, message));
      writeCurrentTick();
    };
    const writeCurrentTick = () => {
      if (dryRun) return;
      const resourceMetrics = resourceSampler.snapshot();
      tickState = {
        ...tickState,
        status: "running",
        at: new Date().toISOString(),
        kit: reg.kitPath ? kitMarker(reg.kitPath) : null,
        failures: [...localFailures],
        telemetry: {
          ...resourceMetrics,
          capacityHighWater: resourceMetrics.capacityHighWater || 0,
          dependencyDeferredCount: dependencyDeferredKeys.size,
          dependencyDeferredIssues: [...dependencyDeferredIssues.values()].slice(0, MAX_DEPENDENCY_DEFERRED_ISSUES),
          capacityDeferredCount: capacityDeferredKeys.size,
        },
      };
      atomicWriteJson(CURRENT_TICK, tickState);
    };
    const preflightCandidatesForTick = async (candidates) => {
      const checked = preflightRuntimeCandidates(candidates, {
        host: os.hostname(),
        cache: runtimeCache,
        envForCandidate: (pick) => dispatchEnvironment(pick.anchorPath, pick),
      });
      for (const failure of checked.failures) {
        const active = activeByAnchor.get(failure.pick.anchorPath);
        if (!active) continue;
        const event = failureEventFor(
          failure.pick.anchorPath,
          failure.pick.config,
          failure.scope,
          "runtime-missing",
          failure.stableTarget,
          `${failure.runtime} executable unavailable on ${failure.host}`,
        );
        active.failures.push(event);
        if (!reportedRuntimeFailures.has(failure.key)) {
          reportedRuntimeFailures.add(failure.key);
          localFailures.push(event);
          logFor(failure.pick.anchorPath, failure.pick.sweep, `dispatch blocked: ${event.message}`);
          writeCurrentTick();
        }
        try {
          await reconcileFailureTodos(active.apiKey, failure.pick.config, failure.pick.anchorPath, [event], new Set(), active.envValues, { dryRun: false });
        } catch (error) {
          logFor(failure.pick.anchorPath, "_", `FATAL failure-todo runtime reconciliation failed: ${error.message}`);
          recordLocalFailure(failure.pick.anchorPath, failure.pick.config, failure.scope, "failure-todo", failure.stableTarget, error.message);
          writeCurrentTick();
        }
      }
      for (const pick of checked.ready) {
        const active = activeByAnchor.get(pick.anchorPath);
        if (!active) continue;
        try {
          await reconcileFailureTodos(active.apiKey, pick.config, pick.anchorPath, [], new Set(), active.envValues, {
            dryRun: false,
            recoveredTargets: new Set([pick.runtimeStableTarget]),
          });
        } catch (error) {
          logFor(pick.anchorPath, "_", `FATAL failure-todo runtime recovery failed: ${error.message}`);
          recordLocalFailure(pick.anchorPath, pick.config, pick.runtimeScope, "failure-todo-recovery", pick.runtimeStableTarget, error.message);
          writeCurrentTick();
        }
      }
      return checked;
    };
    const initialCapacity = capacityLedger.reconcile();
    resourceSampler.observeCapacity(initialCapacity.active);
    if (!initialCapacity.healthy) {
      localFailures.push(failureEventFor("_", null, "capacity", "capacity-ledger", CAPACITY_LEDGER, initialCapacity.errors.join("; ")));
      writeCurrentTick();
    }
    let completionDiscovery = async () => {};
    const admissionQueue = createAdmissionQueue({
      ledger: capacityLedger,
      sampler: resourceSampler,
      onCapacityDeferred: (demand) => {
        try {
          const observation = observationStore.markCapacityDeferred(demand);
          capacityDeferredKeys.add(observationKey(demand));
          if (observation) demand.telemetry = { ...(demand.telemetry || {}), ...observation };
        } catch (error) {
          logFor(demand.anchorPath, demand.sweep, `queue observation error: ${error.message}`);
        }
        writeCurrentTick();
      },
      onUnconfirmedDemand: (demand) => {
        observationStore.clear(demand);
        capacityDeferredKeys.delete(observationKey(demand));
      },
      executeDemand: async (demand, reservation) => {
        activeSameRepo.increment(demand);
        try {
          const observation = observationStore.get(demand);
          if (observation) demand.telemetry = { ...(demand.telemetry || {}), ...observation };
          demand.resourceSampler = resourceSampler;
          demand.dependencyDeferredCount = dependencyDeferredKeys.size;
          demand.dependencyDeferredIssues = [...dependencyDeferredIssues.values()].slice(0, MAX_DEPENDENCY_DEFERRED_ISSUES);
          const [pick] = await expandDispatchBatch([demand], {
            dryRun: false,
            parentRunId,
            activeByAnchor,
            now: Date.now(),
            childIndexAllocator,
          });
          if (!pick) return null;
          pick.telemetry = { ...(pick.telemetry || {}), claimAt: new Date().toISOString() };
          const [result] = await dispatchBatch([pick], {
            signal: dispatchAbortContext?.signal,
            dispatchOptions: { onSpawn: (pid) => reservation.attachChildPid(pid) },
          });
          await reconcileDispatchResult(result);
          return result;
        } finally {
          activeSameRepo.decrement(demand);
        }
      },
      beforeRelease: (result) => completionDiscovery(result),
    });
    const recordUpdateFailure = (anchorPath, scope, kind, stableTarget, message) => {
      updateFailures.push({ anchorPath, scope, kind, stableTarget, message });
    };
    if (!dryRun) runUpdate(reg, recordUpdateFailure);
    rotateLogs();

    // Resolve active anchors: registered ∩ auto-sweep-labeled. One workspace's
    // API error must never abort the whole tick — skip it and carry on.
    const labeledByKey = new Map();
    const anchors = [];
    for (const sourceAnchorPath of reg.repos) {
      let config, apiKey, envValues;
      try { config = anchorConfig(sourceAnchorPath); apiKey = anchorKey(sourceAnchorPath); envValues = anchorEnvValues(sourceAnchorPath); } catch (e) { log(`FATAL config ${sourceAnchorPath}: ${e.message}`); recordLocalFailure(sourceAnchorPath, null, "config", "config", sourceAnchorPath, e.message); continue; }
      if (!apiKey) { log(`FATAL no LINEAR_API_KEY for ${anchorSlug(sourceAnchorPath)} (.env) — skipping`); recordLocalFailure(sourceAnchorPath, config, "config", "missing-env", path.join(sourceAnchorPath, ".env"), "LINEAR_API_KEY missing"); continue; }
      try {
        if (!labeledByKey.has(apiKey)) labeledByKey.set(apiKey, await labeledProjectIds(apiKey));
      } catch (e) {
        logFor(sourceAnchorPath, "_", `label query error — skipping this tick: ${e.message}`);
        const event = failureEventFor(sourceAnchorPath, config, "activation", "label-query", config.projectId, e.message);
        try {
          const decisions = await reconcileFailureTodos(apiKey, config, sourceAnchorPath, [event], new Set(), envValues, { dryRun });
          if (dryRun && decisions.length) logFor(sourceAnchorPath, "_", `[dry-run] would reconcile ${decisions.length} activation failure Todo decision(s)`);
        } catch (reconcileError) {
          logFor(sourceAnchorPath, "_", `FATAL failure-todo activation reconciliation failed: ${reconcileError.message}`);
          recordLocalFailure(sourceAnchorPath, config, "activation", "label-query", config.projectId, e.message);
        }
        continue;
      }
      if (!labeledByKey.get(apiKey).has(config.projectId)) {
        logFor(sourceAnchorPath, "_", `paused (project not labeled ${AUTO_SWEEP_LABEL})`);
        continue;
      }
      const workspaceRecord = workspaceRecordForSourceAnchor(sourceAnchorPath, reg);
      const setupResult = dryRun
        ? materializeManagedWorkspacePlan({ sourceAnchorPath, config, workspaceRecord })
        : materializeManagedWorkspace({ sourceAnchorPath, config, workspaceRecord });
      if (!setupResult.ok) {
        const failures = setupResult.blockers.map((b) => failureEventFor(sourceAnchorPath, config, "setup", b.kind, b.stableTarget || b.managedPath || b.sourcePath || sourceAnchorPath, b.message));
        const recoveredTargets = recoveredTargetsForManagedWorkspace({ sourceAnchorPath, config, setupResult, reg });
        for (const failure of failures) logFor(sourceAnchorPath, "_", `managed workspace blocked: ${failure.message}`);
        try {
          const decisions = await reconcileFailureTodos(apiKey, config, sourceAnchorPath, failures, new Set(["activation"]), envValues, { dryRun, recoveredTargets });
          if (dryRun && decisions.length) logFor(sourceAnchorPath, "_", `[dry-run] would reconcile ${decisions.length} setup failure Todo decision(s)`);
        } catch (e) {
          logFor(sourceAnchorPath, "_", `FATAL failure-todo managed workspace reconciliation failed: ${e.message}`);
          recordLocalFailure(sourceAnchorPath, config, "setup", "failure-todo", config.projectId, e.message);
        }
        continue;
      }
      if (!dryRun) {
        reg.managedAnchors[sourceAnchorPath] = setupResult.record;
        writeRegistry(reg);
      }
      const managedAnchorPath = setupResult.record.managedAnchorPath;
      const managedRepoPaths = resolveWorkspaceRepos(sourceAnchorPath, config, { mode: "managed", workspaceRecord: setupResult.record }).map((r) => r.path);
      const recoveredTargets = cleanManagedCheckoutTargets({ anchorPath: managedAnchorPath, managedRepoPaths }, reg);
      const active = { anchorPath: managedAnchorPath, sourceAnchorPath, managedRepoPaths, workspaceRecord: setupResult.record, config, apiKey, envValues, failures: [], checkedScopes: new Set(), recoveredTargets };
      active.checkedScopes.add("activation");
      active.checkedScopes.add("setup");
      anchors.push(active);
      activeByAnchor.set(managedAnchorPath, active);
    }
    for (const f of updateFailures) {
      const active = f.anchorPath ? activeByAnchor.get(f.anchorPath) : null;
      if (active) active.failures.push(failureEventFor(f.anchorPath, active.config, f.scope, f.kind, f.stableTarget, f.message));
      else recordLocalFailure(f.anchorPath || "_", null, f.scope, f.kind, f.stableTarget, f.message);
    }
    if (!dryRun && reg.autoUpdate && !updateFailures.some((f) => !f.anchorPath)) {
      for (const active of anchors) active.checkedScopes.add("update");
    }
    refillBudget.remaining = maxSameRepoRefillDispatches(anchors.map((a) => a.config));
    refillBudget.disabled = refillBudget.remaining === 0;

    const runSweepPass = async (pass) => {
      if (pass > 1) log(`drain pass ${pass}: rescanning queues`);
      // Reap + count across every active (workspace, sweep). Cheap; always runs.
      const now = Date.now();
      const candidates = [];
      for (const active of anchors) {
        const { anchorPath, config, apiKey, envValues } = active;
        const recordFailure = (scope, kind, stableTarget, message) => active.failures.push(failureEventFor(anchorPath, config, scope, kind, stableTarget, message));
        const scheduledStates = [...new Set(SWEEPS.flatMap((sweep) => SWEEP_CFG[sweep].states))];
        const scheduledPass = await fetchScheduledPassCards(apiKey, config.teamKey, config.projectId, scheduledStates);
        const scheduledCardsByState = scheduledPass.admissionByState;
        const cleanupCardsByState = scheduledPass.cleanupByState;
        if (!scheduledPass.admissionError) {
          for (const sweep of SWEEPS) active.checkedScopes.add(sweep);
        } else {
          for (const sweep of SWEEPS) {
            logFor(anchorPath, sweep, `fetch error: ${scheduledPass.admissionError.message}`);
            recordFailure(sweep, "fetch", scheduledStates.join(","), scheduledPass.admissionError.message);
          }
        }
        if (scheduledPass.cleanupError) {
          for (const sweep of SWEEPS) {
            logFor(anchorPath, sweep, `cleanup fetch error: ${scheduledPass.cleanupError.message}`);
            recordFailure(sweep, "cleanup-fetch", scheduledStates.join(","), scheduledPass.cleanupError.message);
          }
        }
        // teamLabelMap is only needed to execute a reap/bounce — fetch it lazily so
        // an idle workspace never pays for it (keeps the idle path cheap).
        let _labelMap = null;
        const getLabelMap = async () => (_labelMap ??= await teamLabelMap(apiKey, config.teamKey));
        for (const sweep of SWEEPS) {
          const cfg = SWEEP_CFG[sweep];
          if (!cleanupCardsByState) continue;
          const cards = cfg.states.flatMap((state) => cleanupCardsByState.get(state) || []);
          const reaps = reapDecisions(cards, cfg, now);
          // Bounce-escalation is a backward-oscillation guard for the earlier stages.
          // Skip it for ship: a card in "Ship" was human-approved, and its
          // historical bounce markers (from earlier dev/qa churn) must not re-block it.
          const bounces = sweep === "ship" ? [] : bounceDecisions(cards, cfg, now);
          if (!dryRun && (reaps.length || bounces.length)) {
            let labelMap;
            try { labelMap = await getLabelMap(); } catch (e) { logFor(anchorPath, sweep, `label map error — deferring reaps: ${e.message}`); recordFailure(sweep, "label-map", config.teamKey, e.message); labelMap = null; }
            if (labelMap) {
              for (const d of reaps) { try { await executeReap(apiKey, cards.find((c) => c.id === d.id), d, labelMap, sweep); logFor(anchorPath, sweep, `${d.action} ${d.identifier}`); } catch (e) { logFor(anchorPath, sweep, `reap error ${d.identifier}: ${e.message}`); recordFailure(sweep, "reap", d.identifier, e.message); } }
              for (const d of bounces) { try { await executeBounce(apiKey, cards.find((c) => c.id === d.id), labelMap); logFor(anchorPath, sweep, `escalate-bounce ${d.identifier}`); } catch (e) { logFor(anchorPath, sweep, `bounce error ${d.identifier}: ${e.message}`); recordFailure(sweep, "bounce", d.identifier, e.message); } }
            }
          } else if (dryRun && (reaps.length || bounces.length)) {
            logFor(anchorPath, sweep, `[dry-run] would reap ${reaps.length}, escalate-bounce ${bounces.length}`);
          }
          // Reflect the decisions in memory so the count is correct: a reaped card
          // becomes actionable, an escalated (crash or bounce) card is now blocked.
          applyDecisionsInMemory(cards, reaps, bounces);
          // Release FOREIGN stale claims stranded in this sweep's states — a sweep's
          // own reaper handles only its cfg.claim, so e.g. a ship:in-progress dragged
          // into "QA" would otherwise leak forever. Reuses the fetched cards
          // (no extra query). Runs on every host (cleanup, not dispatch).
          const foreign = foreignClaimReleases(cards, now, cfg.claim);
          if (!dryRun && foreign.length) {
            for (const d of foreign) { try { await executeOrphanReap(apiKey, cards.find((c) => c.id === d.id), d); logFor(anchorPath, sweep, `reap-orphan ${d.releaseClaims.join(",")} ${d.identifier}`); } catch (e) { logFor(anchorPath, sweep, `orphan reap error ${d.identifier}: ${e.message}`); recordFailure(sweep, "orphan-reap", d.identifier, e.message); } }
          } else if (dryRun && foreign.length) {
            logFor(anchorPath, sweep, `[dry-run] would release ${foreign.length} foreign claim(s)`);
          }
          if (!scheduledCardsByState) {
            logFor(anchorPath, sweep, "0 actionable; dependency admission unavailable");
            continue;
          }
          const actionable = sortByBoardPosition(actionableCards(cards, cfg, now));
          const actionableIds = new Set(actionable.map((card) => card.identifier));
          const scopeKey = JSON.stringify([active.sourceAnchorPath, sweep]);
          for (const key of [...dependencyDeferredKeys]) {
            const [sourceWorkspace, deferredSweep] = JSON.parse(key);
            if (JSON.stringify([sourceWorkspace, deferredSweep]) === scopeKey) {
              dependencyDeferredKeys.delete(key);
              dependencyDeferredIssues.delete(key);
            }
          }
          for (const card of cards) {
            const dependency = dependencyEligibility(card.blockers, card.blockersComplete === true);
            if (!dependency.eligible) {
              const key = observationKey({ sourceWorkspace: active.sourceAnchorPath, sweep, issueIdentifier: card.identifier });
              dependencyDeferredKeys.add(key);
              if (dependencyDeferredIssues.has(key) || dependencyDeferredIssues.size < MAX_DEPENDENCY_DEFERRED_ISSUES) {
                dependencyDeferredIssues.set(key, dependencyDeferredIssue({
                  sourceWorkspace: active.sourceAnchorPath,
                  sweep,
                  card,
                  dependency,
                }));
              }
            }
          }
          observationStore.sync({
            scannedScopes: [{ sourceWorkspace: active.sourceAnchorPath, sweep }],
            observations: cards.map((card) => ({
              sourceWorkspace: active.sourceAnchorPath,
              sweep,
              issueIdentifier: card.identifier,
              eligible: actionableIds.has(card.identifier),
            })),
          });
          const topCard = actionable[0] || null;
          logFor(anchorPath, sweep, `${actionable.length} actionable${topCard ? `; top ${topCard.identifier} sortOrder=${topCard.sortOrder}` : ""}`);
          // ship merges + deploys to prod. Only the single designated runner may
          // DISPATCH it (closes the cross-host double-deploy race — the claim label
          // alone is a check-then-set with no atomicity). Reaping above still runs
          // on every host, so a stale ship claim is released regardless of runner.
          if (sweep === "ship" && !reg.shipRunner) {
            if (actionable.length > 0) logFor(anchorPath, sweep, `${actionable.length} actionable — not shipRunner, skipping dispatch`);
            continue;
          }
          if (actionable.length > 0) candidates.push({ anchorPath, sourceAnchorPath: active.sourceAnchorPath, managedRepoPaths: active.managedRepoPaths, config, sweep, count: actionable.length, topCard, topSortOrder: topCard.sortOrder, cards: actionable });
        }

        // Holding/legacy-state reaper: release claims stranded in states no sweep fetches
        // (e.g. qa:in-progress left on a "Signoff" card by a crash between the
        // status move and the claim drop, or old dev claims left in retired
        // "In Progress"). ownClaim=null → any stale claim here is orphaned.
        // Cheap; runs after the per-sweep loop. executeOrphanReap needs no
        // teamLabelMap (it removes by id from the card), so it is not gated on one.
        try {
          const held = await fetchClaimCleanupCards(apiKey, config.teamKey, config.projectId, CLAIM_CLEANUP_STATES);
          active.checkedScopes.add("holding");
          const orphans = foreignClaimReleases(held, now);
          if (!dryRun) {
            for (const d of orphans) { try { await executeOrphanReap(apiKey, held.find((c) => c.id === d.id), d); logFor(anchorPath, "_", `reap-orphan ${d.releaseClaims.join(",")} ${d.identifier}`); } catch (e) { logFor(anchorPath, "_", `orphan reap error ${d.identifier}: ${e.message}`); recordFailure("holding", "orphan-reap", d.identifier, e.message); } }
          } else if (orphans.length) {
            logFor(anchorPath, "_", `[dry-run] would release ${orphans.length} orphaned claim(s) in holding/legacy states`);
          }
        } catch (e) { logFor(anchorPath, "_", `holding-state reap error: ${e.message}`); recordFailure("holding", "holding-state-fetch", CLAIM_CLEANUP_STATES.join(","), e.message); }

        try {
          const decisions = await reconcileFailureTodos(apiKey, config, anchorPath, active.failures, active.checkedScopes, envValues, { dryRun, recoveredTargets: active.recoveredTargets });
          if (dryRun && decisions.length) logFor(anchorPath, "_", `[dry-run] would reconcile ${decisions.length} failure Todo decision(s)`);
        } catch (e) {
          logFor(anchorPath, "_", `FATAL failure-todo reconciliation failed: ${e.message}`);
          recordLocalFailure(anchorPath, config, "_", "failure-todo", config.projectId, e.message);
        }
      }

      // Cheap phase done — stamp liveness BEFORE the (possibly long) foreground
      // dispatch, so `health` doesn't read STALE during a legitimately long run.
      writeCurrentTick();

      const maxNonShipDispatches = Math.max(1, ...candidates.map((c) => parallelLimit(c.config)));
      const rotationSeed = Math.floor(Date.now() / 600000);
      const selectOptions = { maxNonShipDispatches, rotationSeed };
      const batch = dryRun
        ? selectDispatchBatch(candidates, selectOptions)
        : (await preflightAndSelectDispatchBatch(candidates, { preflightFn: preflightCandidatesForTick, selectOptions })).selected;
      if (!batch.length) {
        log(pass === 1 ? "no actionable work — cheap tick" : `drain pass ${pass}: no actionable work — stop`);
        return { candidates, selectedBatch: [], dispatched: false };
      }
      if (dryRun) {
        for (const m of dryRunDispatchMessages(batch)) logFor(m.anchorPath, m.sweep, m.body);
        return { candidates, selectedBatch: batch, dispatched: false };
      }
      if (dispatchAbortContext?.signal.aborted) {
        log(`tick interrupted by ${dispatchAbortContext.interruptedSignal} before dispatch`);
        return { candidates, selectedBatch: [], dispatched: false };
      }

      const cleanBatch = [];
      for (const pick of batch) {
        const active = activeByAnchor.get(pick.anchorPath);
        const blockers = checkoutDispatchBlockers(pick, reg);
        if (!active || !blockers.length) {
          cleanBatch.push(pick);
          continue;
        }
        const failures = blockers.map((b) => failureEventFor(pick.anchorPath, pick.config, b.scope, b.kind, b.stableTarget, b.message));
        active.failures.push(...failures);
        for (const failure of failures) logFor(pick.anchorPath, pick.sweep, `dispatch blocked: ${failure.message}`);
        try {
          await reconcileFailureTodos(active.apiKey, pick.config, pick.anchorPath, failures, new Set(), active.envValues, { dryRun: false });
        } catch (e) {
          logFor(pick.anchorPath, "_", `FATAL failure-todo dirty-checkout reconciliation failed: ${e.message}`);
          recordLocalFailure(pick.anchorPath, pick.config, `${pick.sweep}:dispatch`, "failure-todo", pick.anchorPath, e.message);
          writeCurrentTick();
        }
      }
      if (!cleanBatch.length) {
        log("dispatch blocked by dirty checkout(s)");
        return { candidates, selectedBatch: [], dispatched: false };
      }
      const rotationRanks = new Map(cleanBatch.map((pick, index) => [pick.anchorPath, index]));
      const dispatches = admissionDemandsForCandidates(cleanBatch, { trigger: "initial", now, rotationRanks });
      if (!dispatches.length) {
        log("no confirmed card slots — cheap tick");
        return { candidates, selectedBatch: [], dispatched: false };
      }
      const firedHandoffs = new Set();
      const handoffBudget = { remaining: maxNonShipDispatches };
      const handleDispatchResult = async (result) => {
        const [handoffs, refill] = await Promise.all([
          runHandoffTriggers(result, firedHandoffs, handoffBudget),
          (async () => {
            if (result.pick.runtimeLaneKey && runtimeCache.get(result.pick.runtimeLaneKey)?.ok === false) {
              logFor(result.pick.anchorPath, result.pick.sweep, `refill-skip ${result.pick.sweep}: runtime-disabled`);
              return { dispatches: [] };
            }
            const refill = await buildSameRepoRefillDispatches({
              result,
              activeByAnchor,
              activeSameRepo,
              refillBudget,
              parentRunId,
              childIndexAllocator,
              reg,
              now: Date.now(),
              deferClaim: true,
            });
            if (refill.blockers?.length) {
              const active = activeByAnchor.get(result.pick.anchorPath);
              if (active) {
                const failures = refill.blockers.map((b) => failureEventFor(result.pick.anchorPath, result.pick.config, b.scope, b.kind, b.stableTarget, b.message));
                active.failures.push(...failures);
                try {
                  await reconcileFailureTodos(active.apiKey, result.pick.config, result.pick.anchorPath, failures, new Set(), active.envValues, { dryRun: false });
                } catch (e) {
                  logFor(result.pick.anchorPath, "_", `FATAL failure-todo refill dirty-checkout reconciliation failed: ${e.message}`);
                  recordLocalFailure(result.pick.anchorPath, result.pick.config, `${result.pick.sweep}:dispatch`, "failure-todo", result.pick.anchorPath, e.message);
                  writeCurrentTick();
                }
              }
            }
            return refill;
          })(),
        ]);
        for (const demand of [...(handoffs || []), ...(refill?.dispatches || [])]) {
          admitDemand(demand, { queue: admissionQueue }).catch((error) => {
            recordLocalFailure(demand.anchorPath, demand.config, `${demand.sweep}:dispatch`, "admission", demand.issueIdentifier, error.message);
          });
        }
      };
      completionDiscovery = handleDispatchResult;
      let dispatchChildren;
      dispatchChildren = async (children) => {
        const results = await runAdmissionDemands(children, { queue: admissionQueue });
        await admissionQueue.whenIdle();
        return results;
      };
      const results = await dispatchChildren(dispatches);
      return {
        candidates,
        selectedBatch: dispatches,
        dispatched: true,
        continueDraining: results.every((result) => result.success),
      };
    };

    await runDrainLoop({ maxDrainPasses: drainPassLimit(anchors.map((a) => a.config)), runPass: runSweepPass, log });
    writeCurrentTick();
  } catch (error) {
    if (!dryRun) {
      localFailures.push({
        anchorPath: "_",
        anchorSlug: "_",
        projectId: "unknown",
        scope: "tick",
        kind: "tick-exception",
        stableTarget: os.hostname(),
        message: String(error?.message || error),
        seenAt: new Date().toISOString(),
      });
      tickState = { ...tickState, at: new Date().toISOString(), failures: [...localFailures] };
      atomicWriteJson(CURRENT_TICK, tickState);
    }
    throw error;
  } finally {
    if (!dryRun) {
      try {
        dispatchAbortContext?.dispose();
        if (dispatchAbortContext?.interruptedSignal) {
          process.exitCode = dispatchAbortContext.interruptedSignal === "SIGINT" ? 130 : 143;
        }
        finalizeTickState({ ...tickState, failures: [...localFailures] });
      } finally {
        releaseTickLock();
      }
    }
  }
}

// ── registry commands ────────────────────────────────────────────────────────

function cmdRegister(anchorPath) {
  const abs = path.resolve(anchorPath);
  const config = anchorConfig(abs); // throws if no .claude/linear-sweep.json
  const reg = readRegistry();
  if (!reg.repos.includes(abs)) reg.repos.push(abs);
  const normalized = normalizeRegistry(reg);
  // Auto-wire the kit clone for auto-update on first register (don't override a
  // value the user already set) so setup needs no hand-editing of the registry.
  if (!normalized.kitPath) { normalized.kitPath = KIT_ROOT; console.log(`kitPath → ${KIT_ROOT}`); }
  if (!normalized.kitRemote) {
    const url = git(KIT_ROOT, ["remote", "get-url", "origin"], { allowFail: true }).out;
    if (url) { normalized.kitRemote = url; console.log(`kitRemote → ${url}`); }
  }
  const record = normalized.managedAnchors[abs];
  if (record) {
    const setup = materializeManagedWorkspace({ sourceAnchorPath: abs, config, workspaceRecord: record });
    if (!setup.ok) {
      console.error(`managed workspace setup failed for ${abs}`);
      for (const blocker of setup.blockers) console.error(`- ${blocker.kind}: ${blocker.message}`);
      process.exit(1);
    }
    normalized.managedAnchors[abs] = setup.record;
  }
  writeRegistry(normalized);
  console.log(`registered ${abs}`);
  if (normalized.managedAnchors[abs]) {
    console.log(`managedWorkspace → ${normalized.managedAnchors[abs].managedWorkspaceRoot}`);
    console.log(`managedAnchor → ${normalized.managedAnchors[abs].managedAnchorPath}`);
  }
}

function cmdUnregister(anchorPath) {
  const abs = path.resolve(anchorPath);
  const reg = readRegistry();
  reg.repos = reg.repos.filter((p) => p !== abs);
  writeRegistry(reg);
  console.log(`unregistered ${abs}`);
}

async function cmdActivate(anchorPath, on) {
  const abs = path.resolve(anchorPath);
  const config = anchorConfig(abs);
  const apiKey = anchorKey(abs);
  if (!apiKey) throw new Error(`no LINEAR_API_KEY in ${abs}/.env`);
  const labelId = await findOrCreateAutoSweepLabel(apiKey);
  const cur = await projectLabelIds(apiKey, config.projectId);
  const next = on ? [...cur, labelId] : cur.filter((id) => id !== labelId);
  await setProjectLabels(apiKey, config.projectId, next);
  console.log(`${on ? "activated" : "deactivated"} auto-sweep on project ${config.projectId} (${path.basename(abs)})`);
}

// Toggle this host's ship-runner pin (only a shipRunner host dispatches ship-sweep).
function cmdShipRunner(arg) {
  const reg = readRegistry();
  if (arg === "on" || arg === "off") { reg.shipRunner = arg === "on"; writeRegistry(reg); }
  else if (arg) { console.error(`usage: ship-runner [on|off]`); process.exit(1); }
  console.log(`shipRunner: ${reg.shipRunner ? "ON — this host may dispatch ship-sweep (merge + deploy to prod)" : "off — this host will NOT dispatch ship-sweep"}`);
}

async function cmdList() {
  const reg = readRegistry();
  console.log(`ship-runner: ${reg.shipRunner ? "ON (this host)" : "off"}`);
  if (!reg.repos.length) { console.log("(no anchors registered)"); return; }
  const labeledByKey = new Map();
  for (const anchorPath of reg.repos) {
    let line = anchorPath;
    try {
      const config = anchorConfig(anchorPath);
      const apiKey = anchorKey(anchorPath);
      line += `  project=${config.projectId}`;
      const record = workspaceRecordForSourceAnchor(anchorPath, reg);
      if (record) line += `  managed=${record.managedAnchorPath}`;
      if (apiKey) {
        if (!labeledByKey.has(apiKey)) labeledByKey.set(apiKey, await labeledProjectIds(apiKey));
        line += labeledByKey.get(apiKey).has(config.projectId) ? "  [auto-sweep: ON]" : "  [auto-sweep: off]";
      } else line += "  [no .env key]";
    } catch (e) { line += `  [error: ${e.message}]`; }
    console.log(line);
  }
}

async function cmdUnblockList({ json = false } = {}) {
  const result = await scanBlockedIssues();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const w of result.warnings) console.log(`[warning] ${w.anchorPath}: ${w.message}`);
  if (!result.cards.length) { console.log("No blocked cards found across registered anchors."); return; }
  for (const card of result.cards) {
    const status = card.projectActive === null ? "active unknown" : card.projectActive ? "active" : "paused";
    console.log(`${card.identifier} [${card.state}] ${card.title}`);
    console.log(`  ${card.url}`);
    console.log(`  anchor=${card.anchorPath} project=${card.project} (${status})`);
    console.log(`  blockers=${card.blockingLabels.join(", ")}`);
    if (card.newestBlockingComment) console.log(`  latest=${card.newestBlockingComment.body.replace(/\s+/g, " ").slice(0, 220)}`);
  }
}

async function cmdUnblockResolve(args) {
  const [anchorPath, issueId, labelsCsv, ...resolutionParts] = args;
  if (!anchorPath || !issueId || !labelsCsv || !resolutionParts.length) {
    throw new Error("usage: unblock-resolve <anchor> <issueId> <labelsCsv> (--stdin | <resolution>)");
  }
  const abs = path.resolve(anchorPath);
  const config = anchorConfig(abs);
  const apiKey = anchorKey(abs);
  if (!apiKey) throw new Error(`no LINEAR_API_KEY in ${abs}/.env`);
  const labels = labelsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const stdinText = resolutionParts[0] === "--stdin" ? fs.readFileSync(0, "utf8") : "";
  const resolution = resolutionTextFromArgs(resolutionParts, stdinText);
  if (!resolution) throw new Error("resolution text is required");
  const r = await resolveBlockedIssue(apiKey, issueId, labels, resolution, { teamKey: config.teamKey, projectId: config.projectId });
  console.log(`${r.identifier}: removed ${r.removedLabels.join(", ")}`);
}

function cmdHealth() {
  let lockPid = null;
  try { lockPid = JSON.parse(fs.readFileSync(TICK_LOCK, "utf8")).pid; } catch { lockPid = null; }
  let currentTick = null;
  try { currentTick = JSON.parse(fs.readFileSync(CURRENT_TICK, "utf8")); } catch { currentTick = null; }
  let lastTick = null;
  try { lastTick = JSON.parse(fs.readFileSync(LAST_TICK, "utf8")); } catch { lastTick = null; }
  const status = healthStatus({ currentTick, lastTick, lockPid });
  console.log(status.reason);
  if (!status.ok) process.exit(1);
}

function cmdDoctor(args = []) {
  const json = args.includes("--json");
  const anchorArg = args.find((a) => a !== "--json");
  let reg = readRegistry();
  if (anchorArg) {
    const wanted = path.resolve(anchorArg);
    reg = { ...reg, repos: reg.repos.filter((p) => path.resolve(p) === wanted) };
  }
  let currentTick = null;
  try { currentTick = JSON.parse(fs.readFileSync(CURRENT_TICK, "utf8")); } catch { currentTick = null; }
  let lastTick = null;
  try { lastTick = JSON.parse(fs.readFileSync(LAST_TICK, "utf8")); } catch { lastTick = null; }
  const report = doctorReport({ registry: reg, currentTick, lastTick });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctorReport(report));
  if (!report.ok) process.exit(1);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "register": return cmdRegister(args[0]);
    case "unregister": return cmdUnregister(args[0]);
    case "activate": return cmdActivate(args[0] || ".", true);
    case "deactivate": return cmdActivate(args[0] || ".", false);
    case "list": return cmdList();
    case "unblock-list": return cmdUnblockList({ json: args.includes("--json") });
    case "unblock-resolve": return cmdUnblockResolve(args);
    case "ship-runner": return cmdShipRunner(args[0]);
    case "tick": return tick({ dryRun: args.includes("--dry-run") });
    case "health": return cmdHealth();
    case "doctor": return cmdDoctor(args);
    default:
      console.error("Commands: register <anchor> | unregister <anchor> | activate [anchor] | deactivate [anchor] | ship-runner [on|off] | list | unblock-list [--json] | unblock-resolve <anchor> <issueId> <labelsCsv> (--stdin | <resolution>) | tick [--dry-run] | health | doctor [--json] [anchor]");
      process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}

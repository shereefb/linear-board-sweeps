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
// spends ZERO LLM tokens. A heavyweight agent pass is dispatched only when a queue
// holds genuinely actionable work. Pure decision functions (reap/count/build/lock)
// are separated from IO so they can be unit-tested without Linear or git.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { gql } from "./linear.mjs";

// The kit root = two levels up from this script (KIT/scripts/linear-watch.mjs).
const KIT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── Paths & constants ────────────────────────────────────────────────────────

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".config", "linear-board-sweeps");
const REGISTRY_PATH = path.join(CONFIG_DIR, "registry.json");
const STATE_DIR = path.join(HOME, ".local", "state", "linear-board-sweeps");
const TICK_LOCK = path.join(STATE_DIR, "tick.lock");
const LAST_TICK = path.join(STATE_DIR, "last-tick");

export const INTERVAL_S = 600;
export const HEARTBEAT_TAG = "[auto-sweep-heartbeat";
export const REAPER_TAG = "[auto-sweep-reaper]"; // crash-reap audit marker — COUNTED by the escalate-crash counter
export const ORPHAN_TAG = "[auto-sweep-orphan]"; // foreign/orphan claim release — distinct so it doesn't inflate the crash count
export const PARK_TAG = "[auto-sweep-parked]"; // bounce-escalation park — distinct from REAPER_TAG and BOUNCE_TAG
export const BOUNCE_TAG = "[auto-sweep-bounce";
export const FAILURE_TODO_TAG = "[auto-sweep-tick-failure";
export const FAILURE_RECOVERED_TAG = "[auto-sweep-tick-recovered";
export const CRASH_ESCALATE_AFTER = 3; // reaps within the window before blocking
export const BOUNCE_ESCALATE_AFTER = 2; // backward bounces within the window before blocking
export const ESCALATE_WINDOW_H = 48;
export const HEARTBEAT_MIN = 5;
export const LOG_RETENTION_DAYS = 14;
export const FAILURE_TODO_THROTTLE_MS = 24 * 3600000;

// Per-sweep config. staleMin is the heartbeat-age backstop; it must exceed the
// longest NORMAL single-card run for that sweep. ship = merge + deploy + canary
// bake + docs, so it gets the same generous window as qa.
export const SWEEP_CFG = {
  spec: { states: ["Needs Spec"], claim: "spec:in-progress", blocked: ["blocked:open-questions"], staleMin: 45 },
  dev: { states: ["Ready for Dev", "In Progress"], claim: "dev:in-progress", blocked: ["blocked:needs-user"], staleMin: 90 },
  qa: { states: ["In Review"], claim: "qa:in-progress", blocked: ["qa:needs-changes", "blocked:needs-user"], staleMin: 120 },
  ship: { states: ["Ready to Ship"], claim: "ship:in-progress", blocked: ["blocked:needs-user"], staleMin: 120 },
};
// Every list below derives from SWEEP_CFG so adding a sweep is a one-line change.
export const SWEEPS = Object.keys(SWEEP_CFG); // spec, dev, qa, ship — iteration order
// Dispatch priority: push the MOST-downstream work first (ship a blessed card
// before starting new QA, etc.). Explicit so it doesn't rely on indexOf(-1) luck.
export const SWEEP_ORDER = ["ship", "qa", "dev", "spec"];
// The kit skill directories the auto-updater propagates to anchors — one per sweep.
export const SKILL_DIRS = SWEEPS.map((s) => `${s}-sweep`);
// Holding states can carry a stale claim but are fetched by NO sweep (a sweep's
// own states are reaped in the main loop). qa moves a card to "QA Passed" and
// then drops qa:in-progress; a crash between those strands the claim here.
export const HOLDING_STATES = ["QA Passed"];
export const ALL_CLAIMS = SWEEPS.map((s) => SWEEP_CFG[s].claim);
export const MAX_STALE_MIN = Math.max(...SWEEPS.map((s) => SWEEP_CFG[s].staleMin));

const AUTO_SWEEP_LABEL = "auto-sweep";

function unattendedPrompt(sweep) {
  return `Unattended scheduled run. Follow the ${sweep}-sweep skill exactly, perform ONE pass, then stop. Do not ask questions — route them to card comments per the skill.`;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

// Resolve config.repos to absolute paths. Folder names resolve under the
// workspace root (the anchor's parent); absolute or ./ ../ entries are used as-is.
export function resolveRepos(anchorPath, config) {
  const workspaceRoot = path.dirname(anchorPath);
  const entries = Array.isArray(config?.repos) && config.repos.length ? config.repos : [path.basename(anchorPath)];
  return entries.map((entry) => {
    let repoPath;
    if (path.isAbsolute(entry)) repoPath = entry;
    else if (entry.startsWith("./") || entry.startsWith("../")) repoPath = path.resolve(anchorPath, entry);
    else repoPath = path.join(workspaceRoot, entry);
    return { name: path.basename(repoPath), path: repoPath };
  });
}

// Deterministic worktree path so any machine rebuilds the same tree from a card.
export function worktreePath(repoPath, branch) {
  return path.join(repoPath, ".worktrees", branch);
}

// Build the runtime command for one unattended pass. Omitted model/effort ⇒ no
// flag emitted (fall back to the runtime's own default).
export function buildCommand({ runtime, sweep, model, effort, anchorPath }) {
  const prompt = unattendedPrompt(sweep);
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
// a HOLDING state (no sweep fetches it — e.g. qa:in-progress left in "QA Passed"),
// or a FOREIGN claim in a sweep's state (a sweep reaps only its OWN cfg.claim, so
// e.g. a ship:in-progress dragged into "In Review" is invisible to qa's reaper).
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
    const liveClaim = hasLabel(card, cfg.claim) && !releasedIds.has(card.id) && heartbeatAgeMin(card, now) <= cfg.staleMin;
    return !liveClaim; // exclude cards owned by a live run
  });
}
export function countActionable(cards, cfg, now, releasedIds = new Set()) {
  return actionableCards(cards, cfg, now, releasedIds).length;
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

// Pick one dispatch across all actionable (workspace,sweep) candidates:
// qa → dev → spec, then oldest card first.
export function selectDispatch(candidates) {
  const ranked = candidates
    .filter((c) => c.count > 0)
    .sort((a, b) => {
      const so = SWEEP_ORDER.indexOf(a.sweep) - SWEEP_ORDER.indexOf(b.sweep);
      if (so !== 0) return so;
      return (a.oldestUpdatedAt || 0) - (b.oldestUpdatedAt || 0);
    });
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

function failureTodoLastMessage(todo) {
  if (todo.lastMessage !== undefined) return String(todo.lastMessage);
  const matches = [...String(todo.description || "").matchAll(/Last error:\s*(.*)/g)];
  return matches.length ? matches[matches.length - 1][1].trim() : "";
}

function failureTodoFirstSeen(todo) {
  const m = String(todo.description || "").match(/First seen:\s*(.*)/);
  return m ? m[1].trim() : null;
}

function newestFirst(a, b) {
  return Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0);
}

export function failureTodoDecisions(currentFailures, existingTodos, checkedScopes, now = Date.now(), { envValues = [] } = {}) {
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
      decisions.push({ action: "duplicate", fingerprint: currentFailure.fingerprint, todo: duplicate, primary });
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
    if (checkedScopes && checkedScopes.has(scope)) decisions.push({ action: "close", fingerprint: fp, todo: primary });
  }

  return decisions;
}

export function healthStatus({ lastTick, lockPid = null, isAlive = isAlivePid, now = Date.now(), intervalS = INTERVAL_S } = {}) {
  if (lockPid && isAlive(lockPid)) return { ok: true, reason: `tick in progress (pid ${lockPid})` };
  if (!lastTick) return { ok: false, reason: "no successful tick recorded" };
  if (Array.isArray(lastTick.failures) && lastTick.failures.length) return { ok: false, reason: `latest tick had ${lastTick.failures.length} local failure(s)` };
  const ageS = (now - Date.parse(lastTick.at)) / 1000;
  if (!Number.isFinite(ageS)) return { ok: false, reason: "last tick timestamp unreadable" };
  if (ageS > 3 * intervalS) return { ok: false, reason: `STALE: > 3× interval (${3 * intervalS}s)`, ageS };
  return { ok: true, reason: `last tick ${lastTick.at} (${Math.round(ageS)}s ago)`, ageS };
}

// ── IO: filesystem / registry ────────────────────────────────────────────────

function readRegistry() {
  // shipRunner (default false): only a host whose registry sets it true may
  // DISPATCH ship-sweep — the single-runner pin that closes the cross-host
  // double-deploy race. Set it on exactly one machine.
  if (!fs.existsSync(REGISTRY_PATH)) return { autoUpdate: true, kitPath: null, kitRef: "main", kitRemote: null, shipRunner: false, repos: [] };
  const r = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  r.repos = r.repos || [];
  r.kitRef = r.kitRef || "main";
  r.shipRunner = r.shipRunner === true;
  return r;
}

function writeRegistry(r) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2) + "\n");
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
function writeLog(slug, sweep, msg) {
  const dir = path.join(STATE_DIR, slug, sweep);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString();
  fs.appendFileSync(path.join(dir, `${stamp.slice(0, 10).replace(/-/g, "")}.log`), `[${stamp}] ${msg}\n`);
  process.stderr.write(`[${stamp}] ${slug === "_" ? "" : slug + "/"}${sweep} ${msg}\n`);
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

async function fetchCards(apiKey, teamKey, projectId, states) {
  const cards = [];
  let cursor = null;
  do {
    const d = await gql(
      `query($c:String,$states:[String!],$teamKey:String!,$pid:ID){ issues(first:100, after:$c, filter:{
         team:{ key:{ eq:$teamKey } }, project:{ id:{ eq:$pid } }, state:{ name:{ in:$states } } }){
         pageInfo{ hasNextPage endCursor }
         nodes{ id identifier updatedAt
           labels{ nodes{ id name } }
           comments(last:100){ nodes{ body createdAt } } } } }`,
      { c: cursor, states, teamKey, pid: projectId },
      apiKey
    );
    for (const n of d.issues.nodes) {
      cards.push({
        id: n.id,
        identifier: n.identifier,
        updatedAt: n.updatedAt,
        labelNames: n.labels.nodes.map((l) => l.name),
        labelIds: Object.fromEntries(n.labels.nodes.map((l) => [l.name, l.id])),
        comments: n.comments.nodes,
      });
    }
    cursor = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (cursor);
  return cards;
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
  const d = await gql(`query($k:String!){ teams(filter:{ key:{ eq:$k } }){ nodes{ labels(first:250){ nodes{ id name } } } } }`, { k: teamKey }, apiKey);
  const team = d.teams.nodes[0];
  return team ? Object.fromEntries(team.labels.nodes.map((l) => [l.name, l.id])) : {};
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
  await addComment(apiKey, decision.todo.id, `Duplicate auto-sweep failure Todo for \`${decision.fingerprint}\`. Keeping ${decision.primary.identifier} as the primary tracking card; this duplicate can be closed after manual review.`);
}

async function reconcileFailureTodos(apiKey, config, anchorPath, currentFailures, checkedScopes, envValues, { dryRun = false } = {}) {
  const existing = await fetchFailureTodos(apiKey, config.teamKey, config.projectId);
  const decisions = failureTodoDecisions(currentFailures, existing, checkedScopes, Date.now(), { envValues });
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

// ── IO: auto-update ──────────────────────────────────────────────────────────

function kitMarker(kitPath) {
  const vf = path.join(kitPath, "VERSION");
  if (fs.existsSync(vf)) return fs.readFileSync(vf, "utf8").trim();
  return git(kitPath, ["rev-parse", "HEAD"], { allowFail: true }).out || null;
}

// Copy every sweep skill dir + version stamp into a checkout root. Derived from
// SKILL_DIRS (= SWEEP_CFG keys) so a new sweep propagates to anchors with no edit
// here — miss this and the new skill never reaches the machines that run it.
function copySkillsInto(root, kit, marker) {
  for (const s of SKILL_DIRS) {
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

function runUpdate(reg) {
  if (!reg.autoUpdate || !reg.kitPath) return;
  const kit = reg.kitPath;
  if (reg.kitRemote) {
    const url = git(kit, ["remote", "get-url", "origin"], { allowFail: true }).out;
    if (url !== reg.kitRemote) { log(`update: kit remote ${url} != expected ${reg.kitRemote} — skipping self-update`); return; }
  }
  const before = git(kit, ["rev-parse", "HEAD"], { allowFail: true }).out;
  git(kit, ["fetch", "origin", reg.kitRef], { allowFail: true });
  const merge = git(kit, ["merge", "--ff-only", `origin/${reg.kitRef}`], { allowFail: true });
  if (merge.status !== 0) { log(`update: kit clone not fast-forwardable (diverged/dirty) — left alone: ${merge.err}`); return; }
  const after = git(kit, ["rev-parse", "HEAD"], { allowFail: true }).out;
  if (before !== after) {
    const diff = git(kit, ["log", "--oneline", `${before}..${after}`], { allowFail: true }).out;
    log(`update: kit ${before?.slice(0, 8)}..${after?.slice(0, 8)}\n${diff}`);
  }
  const marker = kitMarker(kit);
  for (const anchor of reg.repos) {
    try {
      // Compare against what MAIN carries (via git show), not the primary working
      // tree — which may be on a lagging feature branch and would loop-update.
      const installed = git(anchor, ["show", "main:.claude/skills/.sweep-version"], { allowFail: true }).out || null;
      if (!isNewerVersion(marker, installed)) continue;
      const res = refreshAnchorSkills(anchor, kit, marker);
      log(`update: ${anchorSlug(anchor)} skills → ${marker} (${res.reason})`);
    } catch (e) {
      log(`update: ${anchorSlug(anchor)} failed: ${e.message}`);
    }
  }
}

// ── IO: dispatch ─────────────────────────────────────────────────────────────

function dispatch(anchorPath, sweep, config) {
  const modelCfg = (config.models && config.models[sweep]) || {};
  const { cmd, args, cwd } = buildCommand({ runtime: config.runtime || "codex", sweep, model: modelCfg.model, effort: modelCfg.effort, anchorPath });
  const env = { ...process.env, ...parseEnv(fs.existsSync(path.join(anchorPath, ".env")) ? fs.readFileSync(path.join(anchorPath, ".env"), "utf8") : "") };
  const dir = path.join(STATE_DIR, anchorSlug(anchorPath), sweep);
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`);
  const fd = fs.openSync(logFile, "a");
  logFor(anchorPath, sweep, `dispatch: ${cmd} ${args.slice(0, 3).join(" ")} …`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  // A missing runtime binary (ENOENT) sets r.error and leaves r.status null — that
  // is NOT a successful no-op. Surface it loudly so `health` / logs show the launcher
  // is dispatching nothing rather than silently "succeeding".
  if (r.error) { logFor(anchorPath, sweep, `FATAL dispatch could not start ${cmd}: ${r.error.message}`); return 127; }
  logFor(anchorPath, sweep, `dispatch end (exit ${r.status})`);
  return r.status;
}

// ── tick orchestration ───────────────────────────────────────────────────────

async function tick({ dryRun = false } = {}) {
  const reg = readRegistry();
  if (!dryRun) {
    if (!acquireTickLock()) { log("another tick holds the lock — exit"); return; }
  }
  try {
    if (!dryRun) runUpdate(reg);
    rotateLogs();
    const localFailures = [];
    const activeByAnchor = new Map();
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
    const recordLocalFailure = (anchorPath, config, scope, kind, stableTarget, message) => {
      localFailures.push(failureEventFor(anchorPath, config, scope, kind, stableTarget, message));
    };

    // Resolve active anchors: registered ∩ auto-sweep-labeled. One workspace's
    // API error must never abort the whole tick — skip it and carry on.
    const labeledByKey = new Map();
    const anchors = [];
    for (const anchorPath of reg.repos) {
      let config, apiKey, envValues;
      try { config = anchorConfig(anchorPath); apiKey = anchorKey(anchorPath); envValues = anchorEnvValues(anchorPath); } catch (e) { log(`FATAL config ${anchorPath}: ${e.message}`); recordLocalFailure(anchorPath, null, "config", "config", anchorPath, e.message); continue; }
      if (!apiKey) { log(`FATAL no LINEAR_API_KEY for ${anchorSlug(anchorPath)} (.env) — skipping`); recordLocalFailure(anchorPath, config, "config", "missing-env", path.join(anchorPath, ".env"), "LINEAR_API_KEY missing"); continue; }
      try {
        if (!labeledByKey.has(apiKey)) labeledByKey.set(apiKey, await labeledProjectIds(apiKey));
      } catch (e) { logFor(anchorPath, "_", `label query error — skipping this tick: ${e.message}`); recordLocalFailure(anchorPath, config, "_", "label-query", config.projectId, e.message); continue; }
      if (!labeledByKey.get(apiKey).has(config.projectId)) { logFor(anchorPath, "_", `paused (project not labeled ${AUTO_SWEEP_LABEL})`); continue; }
      const active = { anchorPath, config, apiKey, envValues, failures: [], checkedScopes: new Set() };
      anchors.push(active);
      activeByAnchor.set(anchorPath, active);
    }

    // Reap + count across every active (workspace, sweep). Cheap; always runs.
    const now = Date.now();
    const candidates = [];
    for (const active of anchors) {
      const { anchorPath, config, apiKey, envValues } = active;
      const recordFailure = (scope, kind, stableTarget, message) => active.failures.push(failureEventFor(anchorPath, config, scope, kind, stableTarget, message));
      // teamLabelMap is only needed to execute a reap/bounce — fetch it lazily so
      // an idle workspace never pays for it (keeps the idle path cheap).
      let _labelMap = null;
      const getLabelMap = async () => (_labelMap ??= await teamLabelMap(apiKey, config.teamKey));
      for (const sweep of SWEEPS) {
        const cfg = SWEEP_CFG[sweep];
        let cards;
        try { cards = await fetchCards(apiKey, config.teamKey, config.projectId, cfg.states); active.checkedScopes.add(sweep); } catch (e) { logFor(anchorPath, sweep, `fetch error: ${e.message}`); recordFailure(sweep, "fetch", cfg.states.join(","), e.message); continue; }
        const reaps = reapDecisions(cards, cfg, now);
        // Bounce-escalation is a backward-oscillation guard for the earlier stages.
        // Skip it for ship: a card in "Ready to Ship" was human-approved, and its
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
        // into "In Review" would otherwise leak forever. Reuses the fetched cards
        // (no extra query). Runs on every host (cleanup, not dispatch).
        const foreign = foreignClaimReleases(cards, now, cfg.claim);
        if (!dryRun && foreign.length) {
          for (const d of foreign) { try { await executeOrphanReap(apiKey, cards.find((c) => c.id === d.id), d); logFor(anchorPath, sweep, `reap-orphan ${d.releaseClaims.join(",")} ${d.identifier}`); } catch (e) { logFor(anchorPath, sweep, `orphan reap error ${d.identifier}: ${e.message}`); recordFailure(sweep, "orphan-reap", d.identifier, e.message); } }
        } else if (dryRun && foreign.length) {
          logFor(anchorPath, sweep, `[dry-run] would release ${foreign.length} foreign claim(s)`);
        }
        const actionable = actionableCards(cards, cfg, now);
        const oldest = actionable.length ? Math.min(...actionable.map((c) => Date.parse(c.updatedAt))) : 0;
        logFor(anchorPath, sweep, `${actionable.length} actionable`);
        // ship merges + deploys to prod. Only the single designated runner may
        // DISPATCH it (closes the cross-host double-deploy race — the claim label
        // alone is a check-then-set with no atomicity). Reaping above still runs
        // on every host, so a stale ship claim is released regardless of runner.
        if (sweep === "ship" && !reg.shipRunner) {
          if (actionable.length > 0) logFor(anchorPath, sweep, `${actionable.length} actionable — not shipRunner, skipping dispatch`);
          continue;
        }
        if (actionable.length > 0) candidates.push({ anchorPath, config, sweep, count: actionable.length, oldestUpdatedAt: oldest });
      }

      // Holding-state reaper: release claims stranded in states no sweep fetches
      // (e.g. qa:in-progress left on a "QA Passed" card by a crash between the
      // status move and the claim drop). ownClaim=null → any stale claim here is
      // orphaned. Cheap; runs after the per-sweep loop. executeOrphanReap needs no
      // teamLabelMap (it removes by id from the card), so it is not gated on one.
      try {
        const held = await fetchCards(apiKey, config.teamKey, config.projectId, HOLDING_STATES);
        active.checkedScopes.add("holding");
        const orphans = foreignClaimReleases(held, now);
        if (!dryRun) {
          for (const d of orphans) { try { await executeOrphanReap(apiKey, held.find((c) => c.id === d.id), d); logFor(anchorPath, "_", `reap-orphan ${d.releaseClaims.join(",")} ${d.identifier}`); } catch (e) { logFor(anchorPath, "_", `orphan reap error ${d.identifier}: ${e.message}`); recordFailure("_", "orphan-reap", d.identifier, e.message); } }
        } else if (orphans.length) {
          logFor(anchorPath, "_", `[dry-run] would release ${orphans.length} orphaned claim(s) in holding states`);
        }
      } catch (e) { logFor(anchorPath, "_", `holding-state reap error: ${e.message}`); recordFailure("_", "holding-state-fetch", HOLDING_STATES.join(","), e.message); }

      try {
        const decisions = await reconcileFailureTodos(apiKey, config, anchorPath, active.failures, active.checkedScopes, envValues, { dryRun });
        if (dryRun && decisions.length) logFor(anchorPath, "_", `[dry-run] would reconcile ${decisions.length} failure Todo decision(s)`);
      } catch (e) {
        logFor(anchorPath, "_", `FATAL failure-todo reconciliation failed: ${e.message}`);
        recordLocalFailure(anchorPath, config, "_", "failure-todo", config.projectId, e.message);
      }
    }

    // Cheap phase done — stamp liveness BEFORE the (possibly long) foreground
    // dispatch, so `health` doesn't read STALE during a legitimately long run.
    if (!dryRun) fs.writeFileSync(LAST_TICK, JSON.stringify({ at: new Date().toISOString(), kit: reg.kitPath ? kitMarker(reg.kitPath) : null, failures: localFailures }) + "\n");

    // Dispatch at most one agent pass.
    const pick = selectDispatch(candidates);
    if (!pick) log("no actionable work — cheap tick");
    else if (dryRun) logFor(pick.anchorPath, pick.sweep, `[dry-run] WOULD dispatch (${pick.count} actionable)`);
    else {
      const exitCode = dispatch(pick.anchorPath, pick.sweep, pick.config);
      if (exitCode !== 0) {
        const active = activeByAnchor.get(pick.anchorPath);
        const runtime = pick.config.runtime || "codex";
        const event = failureEventFor(pick.anchorPath, pick.config, pick.sweep, exitCode === 127 ? "dispatch-start" : "dispatch-exit", runtime, `${runtime} ${pick.sweep}-sweep exited ${exitCode}`);
        if (active) {
          try {
            await reconcileFailureTodos(active.apiKey, pick.config, pick.anchorPath, [event], new Set([pick.sweep]), active.envValues, { dryRun: false });
          } catch (e) {
            logFor(pick.anchorPath, "_", `FATAL failure-todo post-dispatch reconciliation failed: ${e.message}`);
          }
        }
      }
    }
  } finally {
    if (!dryRun) releaseTickLock();
  }
}

// ── registry commands ────────────────────────────────────────────────────────

function cmdRegister(anchorPath) {
  const abs = path.resolve(anchorPath);
  anchorConfig(abs); // throws if no .claude/linear-sweep.json
  const reg = readRegistry();
  if (!reg.repos.includes(abs)) reg.repos.push(abs);
  // Auto-wire the kit clone for auto-update on first register (don't override a
  // value the user already set) so setup needs no hand-editing of the registry.
  if (!reg.kitPath) { reg.kitPath = KIT_ROOT; console.log(`kitPath → ${KIT_ROOT}`); }
  if (!reg.kitRemote) {
    const url = git(KIT_ROOT, ["remote", "get-url", "origin"], { allowFail: true }).out;
    if (url) { reg.kitRemote = url; console.log(`kitRemote → ${url}`); }
  }
  writeRegistry(reg);
  console.log(`registered ${abs}`);
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
      if (apiKey) {
        if (!labeledByKey.has(apiKey)) labeledByKey.set(apiKey, await labeledProjectIds(apiKey));
        line += labeledByKey.get(apiKey).has(config.projectId) ? "  [auto-sweep: ON]" : "  [auto-sweep: off]";
      } else line += "  [no .env key]";
    } catch (e) { line += `  [error: ${e.message}]`; }
    console.log(line);
  }
}

function cmdHealth() {
  // A dispatch runs foreground and can legitimately exceed 3× interval, so a live
  // tick lock (held by a running PID) counts as healthy even if the stamp is old.
  let lockPid = null;
  try { lockPid = JSON.parse(fs.readFileSync(TICK_LOCK, "utf8")).pid; } catch { lockPid = null; }
  let lastTick = null;
  try { lastTick = JSON.parse(fs.readFileSync(LAST_TICK, "utf8")); } catch { lastTick = null; }
  const status = healthStatus({ lastTick, lockPid });
  console.log(status.reason);
  if (!status.ok) process.exit(1);
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
    case "ship-runner": return cmdShipRunner(args[0]);
    case "tick": return tick({ dryRun: args.includes("--dry-run") });
    case "health": return cmdHealth();
    default:
      console.error("Commands: register <anchor> | unregister <anchor> | activate [anchor] | deactivate [anchor] | ship-runner [on|off] | list | tick [--dry-run] | health");
      process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}

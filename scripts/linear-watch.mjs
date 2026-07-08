#!/usr/bin/env node
// Auto-sweep launcher for the linear-board-sweeps kit. Zero-dependency (Node 18+).
// See docs/superpowers/specs/2026-07-08-auto-sweep-launcher-design.md.
//
// Commands:
//   node linear-watch.mjs register <anchor-repo-path>     # add a workspace anchor
//   node linear-watch.mjs unregister <anchor-repo-path>
//   node linear-watch.mjs list                            # anchors + projectId + auto-sweep?
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
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { gql } from "./linear.mjs";

// ── Paths & constants ────────────────────────────────────────────────────────

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".config", "linear-board-sweeps");
const REGISTRY_PATH = path.join(CONFIG_DIR, "registry.json");
const STATE_DIR = path.join(HOME, ".local", "state", "linear-board-sweeps");
const TICK_LOCK = path.join(STATE_DIR, "tick.lock");
const LAST_TICK = path.join(STATE_DIR, "last-tick");

export const INTERVAL_S = 600;
export const HEARTBEAT_TAG = "[auto-sweep-heartbeat";
export const REAPER_TAG = "[auto-sweep-reaper]";
export const BOUNCE_TAG = "[auto-sweep-bounce";
export const CRASH_ESCALATE_AFTER = 3; // reaps within the window before blocking
export const BOUNCE_ESCALATE_AFTER = 2; // backward bounces within the window before blocking
export const ESCALATE_WINDOW_H = 48;
export const HEARTBEAT_MIN = 5;
export const LOG_RETENTION_DAYS = 14;

// Per-sweep config. staleMin is the heartbeat-age backstop; it must exceed the
// longest NORMAL single-card run for that sweep.
export const SWEEP_CFG = {
  spec: { states: ["Needs Spec"], claim: "spec:in-progress", blocked: ["blocked:open-questions"], staleMin: 30 },
  dev: { states: ["Ready for Dev", "In Progress"], claim: "dev:in-progress", blocked: ["blocked:needs-user"], staleMin: 90 },
  qa: { states: ["In Review"], claim: "qa:in-progress", blocked: ["qa:needs-changes", "blocked:needs-user"], staleMin: 120 },
};
// Selection order: push work toward Done first.
export const SWEEP_ORDER = ["qa", "dev", "spec"];

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

// ── IO: filesystem / registry ────────────────────────────────────────────────

function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return { autoUpdate: true, kitPath: null, kitRef: "main", kitRemote: null, repos: [] };
  const r = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  r.repos = r.repos || [];
  r.kitRef = r.kitRef || "main";
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

async function teamLabelMap(apiKey, teamKey) {
  const d = await gql(`query($k:String!){ teams(filter:{ key:{ eq:$k } }){ nodes{ labels(first:250){ nodes{ id name } } } } }`, { k: teamKey }, apiKey);
  const team = d.teams.nodes[0];
  return team ? Object.fromEntries(team.labels.nodes.map((l) => [l.name, l.id])) : {};
}

async function setIssueLabels(apiKey, issueId, labelIds) {
  await gql(`mutation($id:String!,$ids:[String!]){ issueUpdate(id:$id, input:{ labelIds:$ids }){ success } }`, { id: issueId, ids: [...new Set(labelIds)] }, apiKey);
}

async function addComment(apiKey, issueId, body) {
  await gql(`mutation($id:String!,$b:String!){ commentCreate(input:{ issueId:$id, body:$b }){ success } }`, { id: issueId, b: body }, apiKey);
}

// Execute a reap/escalate decision: drop the claim label (+ optionally add
// blocked:needs-user) and post the audit comment.
async function executeReap(apiKey, card, decision, labelMap, sweep) {
  const keep = Object.entries(card.labelIds).filter(([name]) => name !== decision.releaseClaim).map(([, id]) => id);
  if (decision.action === "escalate-crash" && labelMap["blocked:needs-user"]) {
    await setIssueLabels(apiKey, card.id, [...keep, labelMap["blocked:needs-user"]]);
    await addComment(apiKey, card.id, `${REAPER_TAG} Auto-released stale \`${decision.releaseClaim}\` and set **blocked:needs-user** — the ${sweep} sweep has stranded this card ${decision.count}× (the runtime likely keeps dying on it). Needs a human before it retries.`);
  } else {
    await setIssueLabels(apiKey, card.id, keep);
    await addComment(apiKey, card.id, `${REAPER_TAG} Auto-released stale \`${decision.releaseClaim}\` claim (heartbeat idle > ${SWEEP_CFG[sweep].staleMin}m; the prior run likely froze or failed). Will retry.`);
  }
}

async function executeBounce(apiKey, card, labelMap) {
  if (!labelMap["blocked:needs-user"]) return;
  const ids = [...Object.values(card.labelIds), labelMap["blocked:needs-user"]];
  await setIssueLabels(apiKey, card.id, ids);
  await addComment(apiKey, card.id, `${REAPER_TAG} Set **blocked:needs-user** — this card has bounced backward ${BOUNCE_ESCALATE_AFTER}+ times; two sweeps can't agree on it. Needs a human decision.`);
}

// ── IO: auto-update ──────────────────────────────────────────────────────────

function kitMarker(kitPath) {
  const vf = path.join(kitPath, "VERSION");
  if (fs.existsSync(vf)) return fs.readFileSync(vf, "utf8").trim();
  return git(kitPath, ["rev-parse", "HEAD"], { allowFail: true }).out || null;
}

// Copy the three skill dirs + version stamp into a checkout root.
function copySkillsInto(root, kit, marker) {
  for (const s of ["spec-sweep", "dev-sweep", "qa-sweep"]) {
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

    // Resolve active anchors: registered ∩ auto-sweep-labeled. One workspace's
    // API error must never abort the whole tick — skip it and carry on.
    const labeledByKey = new Map();
    const anchors = [];
    for (const anchorPath of reg.repos) {
      let config, apiKey;
      try { config = anchorConfig(anchorPath); apiKey = anchorKey(anchorPath); } catch (e) { log(`FATAL config ${anchorPath}: ${e.message}`); continue; }
      if (!apiKey) { log(`FATAL no LINEAR_API_KEY for ${anchorSlug(anchorPath)} (.env) — skipping`); continue; }
      try {
        if (!labeledByKey.has(apiKey)) labeledByKey.set(apiKey, await labeledProjectIds(apiKey));
      } catch (e) { logFor(anchorPath, "_", `label query error — skipping this tick: ${e.message}`); continue; }
      if (!labeledByKey.get(apiKey).has(config.projectId)) { logFor(anchorPath, "_", `paused (project not labeled ${AUTO_SWEEP_LABEL})`); continue; }
      anchors.push({ anchorPath, config, apiKey });
    }

    // Reap + count across every active (workspace, sweep). Cheap; always runs.
    const now = Date.now();
    const candidates = [];
    for (const { anchorPath, config, apiKey } of anchors) {
      // teamLabelMap is only needed to execute a reap/bounce — fetch it lazily so
      // an idle workspace never pays for it (keeps the idle path cheap).
      let _labelMap = null;
      const getLabelMap = async () => (_labelMap ??= await teamLabelMap(apiKey, config.teamKey));
      for (const sweep of ["spec", "dev", "qa"]) {
        const cfg = SWEEP_CFG[sweep];
        let cards;
        try { cards = await fetchCards(apiKey, config.teamKey, config.projectId, cfg.states); } catch (e) { logFor(anchorPath, sweep, `fetch error: ${e.message}`); continue; }
        const reaps = reapDecisions(cards, cfg, now);
        const bounces = bounceDecisions(cards, cfg, now);
        if (!dryRun && (reaps.length || bounces.length)) {
          let labelMap;
          try { labelMap = await getLabelMap(); } catch (e) { logFor(anchorPath, sweep, `label map error — deferring reaps: ${e.message}`); labelMap = null; }
          if (labelMap) {
            for (const d of reaps) { try { await executeReap(apiKey, cards.find((c) => c.id === d.id), d, labelMap, sweep); logFor(anchorPath, sweep, `${d.action} ${d.identifier}`); } catch (e) { logFor(anchorPath, sweep, `reap error ${d.identifier}: ${e.message}`); } }
            for (const d of bounces) { try { await executeBounce(apiKey, cards.find((c) => c.id === d.id), labelMap); logFor(anchorPath, sweep, `escalate-bounce ${d.identifier}`); } catch (e) { logFor(anchorPath, sweep, `bounce error ${d.identifier}: ${e.message}`); } }
          }
        } else if (dryRun && (reaps.length || bounces.length)) {
          logFor(anchorPath, sweep, `[dry-run] would reap ${reaps.length}, escalate-bounce ${bounces.length}`);
        }
        // Reflect the decisions in memory so the count is correct: a reaped card
        // becomes actionable, an escalated (crash or bounce) card is now blocked.
        applyDecisionsInMemory(cards, reaps, bounces);
        const actionable = actionableCards(cards, cfg, now);
        const oldest = actionable.length ? Math.min(...actionable.map((c) => Date.parse(c.updatedAt))) : 0;
        logFor(anchorPath, sweep, `${actionable.length} actionable`);
        if (actionable.length > 0) candidates.push({ anchorPath, config, sweep, count: actionable.length, oldestUpdatedAt: oldest });
      }
    }

    // Cheap phase done — stamp liveness BEFORE the (possibly long) foreground
    // dispatch, so `health` doesn't read STALE during a legitimately long run.
    if (!dryRun) fs.writeFileSync(LAST_TICK, JSON.stringify({ at: new Date().toISOString(), kit: reg.kitPath ? kitMarker(reg.kitPath) : null }) + "\n");

    // Dispatch at most one agent pass.
    const pick = selectDispatch(candidates);
    if (!pick) log("no actionable work — cheap tick");
    else if (dryRun) logFor(pick.anchorPath, pick.sweep, `[dry-run] WOULD dispatch (${pick.count} actionable)`);
    else dispatch(pick.anchorPath, pick.sweep, pick.config);
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

async function cmdList() {
  const reg = readRegistry();
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
  if (lockPid && isAlivePid(lockPid)) { console.log(`tick in progress (pid ${lockPid})`); return; }
  if (!fs.existsSync(LAST_TICK)) { console.log("no successful tick recorded"); process.exit(1); }
  const { at } = JSON.parse(fs.readFileSync(LAST_TICK, "utf8"));
  const ageS = (Date.now() - Date.parse(at)) / 1000;
  console.log(`last tick ${at} (${Math.round(ageS)}s ago)`);
  if (ageS > 3 * INTERVAL_S) { console.error(`STALE: > 3× interval (${3 * INTERVAL_S}s)`); process.exit(1); }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "register": return cmdRegister(args[0]);
    case "unregister": return cmdUnregister(args[0]);
    case "list": return cmdList();
    case "tick": return tick({ dryRun: args.includes("--dry-run") });
    case "health": return cmdHealth();
    default:
      console.error("Commands: register <anchor> | unregister <anchor> | list | tick [--dry-run] | health");
      process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}

// Unit tests for the auto-sweep launcher's pure decision logic (node:test, zero-dep).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRepos, worktreePath, buildCommand, lockIsReclaimable, isNewerVersion,
  heartbeatAgeMin, countMarkers, reapDecisions, bounceDecisions, bouncePairKey,
  countActionable, actionableCards, applyDecisionsInMemory,
  selectDispatch, parseEnv, pushWithRetry, SWEEP_CFG,
  REAPER_TAG, BOUNCE_TAG, HEARTBEAT_TAG,
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

// ── dispatch selection ───────────────────────────────────────────────────────
test("selectDispatch: qa beats dev beats spec", () => {
  const pick = selectDispatch([
    { sweep: "spec", count: 5, oldestUpdatedAt: 1 },
    { sweep: "qa", count: 1, oldestUpdatedAt: 100 },
    { sweep: "dev", count: 3, oldestUpdatedAt: 1 },
  ]);
  assert.equal(pick.sweep, "qa");
});
test("selectDispatch: within a sweep, oldest card first; zero-count ignored; none → null", () => {
  const pick = selectDispatch([
    { sweep: "dev", count: 2, oldestUpdatedAt: 500 },
    { sweep: "dev", count: 2, oldestUpdatedAt: 100 },
  ]);
  assert.equal(pick.oldestUpdatedAt, 100);
  assert.equal(selectDispatch([{ sweep: "dev", count: 0, oldestUpdatedAt: 1 }]), null);
});

// ── env parsing ──────────────────────────────────────────────────────────────
test("parseEnv: strips quotes, ignores comments/blanks", () => {
  const e = parseEnv('# c\nLINEAR_API_KEY="lin_api_x"\nFOO=bar\n\n');
  assert.equal(e.LINEAR_API_KEY, "lin_api_x");
  assert.equal(e.FOO, "bar");
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

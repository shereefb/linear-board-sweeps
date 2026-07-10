#!/usr/bin/env node
// Portable Linear engine for the board-sweeps workflow. No dependencies (Node 18+ global fetch).
// Auth: LINEAR_API_KEY in the environment (load from a gitignored .env: `set -a && . ./.env && set +a`).

import fs from "node:fs";
import path from "node:path";
//
// Usage:
//   node linear.mjs whoami
//   node linear.mjs setup-team "<Team name or key>"        # create missing sweep statuses + labels (idempotent)
//   node linear.mjs ensure-project "<Team>" "<Project>"    # find or create a project; prints its id
//   node linear.mjs create-card "<projectId>" "<State>" "<Title>" "<Description>" "Label1,Label2"
//   node linear.mjs retire-state "<projectId>" "In Progress" "Dev"
//   node linear.mjs rename-states "<projectId>"            # rename legacy board states in place
//   node linear.mjs dependency-status "<Issue>"             # JSON; exits 0 ready, 3 blocked, 2 unreadable
//   node linear.mjs repo-status "<Issue>" "<Label>" "<Repo>" # JSON; exits 0 ready, 3 changed, 2 unreadable
//   node linear.mjs query '{ viewer { name } }'            # raw GraphQL
//
export const WORKFLOW_STATE_RENAMES = [
  { from: "Needs Spec", to: "Spec" },
  { from: "Ready for Dev", to: "Dev" },
  { from: "In Review", to: "QA" },
  { from: "QA Passed", to: "Signoff" },
  { from: "Ready to Ship", to: "Ship" },
];

export const WORKFLOW_STATES = Object.freeze({
  spec: "Spec",
  dev: "Dev",
  qa: "QA",
  signoff: "Signoff",
  ship: "Ship",
  done: "Done",
  legacyInProgress: "In Progress",
});

export function normalizeBlockingRelations(connection) {
  const nodes = connection?.nodes;
  if (!Array.isArray(nodes)) throw new Error("inverseRelations nodes missing");
  return nodes.filter((relation) => relation.type === "blocks").map((relation) => {
    if (!relation.issue?.id || !relation.issue?.state?.name) {
      throw new Error(`blocking relation ${relation.id || "unknown"} has no readable issue`);
    }
    return {
      relationId: relation.id,
      id: relation.issue.id,
      identifier: relation.issue.identifier,
      stateId: relation.issue.state.id,
      stateName: relation.issue.state.name,
      stateType: relation.issue.state.type,
    };
  });
}

export function dependencyEligibility(blockers, complete = true) {
  if (!complete) return { eligible: false, reason: "incomplete-relations", unresolved: blockers || [] };
  const unresolved = (blockers || []).filter((blocker) => blocker.stateName !== WORKFLOW_STATES.done);
  return { eligible: unresolved.length === 0, reason: unresolved.length ? "blocked" : "ready", unresolved };
}

export function repoRouteEligibility(labelNames, byLabel, expectedLabel, expectedRepoEntry) {
  if (!byLabel || typeof byLabel !== "object" || Array.isArray(byLabel) || Object.keys(byLabel).length === 0) {
    throw new Error("repoRouting.byLabel is empty or invalid");
  }
  if (!expectedLabel || !expectedRepoEntry) throw new Error("expected route label and repo entry are required");
  if (byLabel[expectedLabel] !== expectedRepoEntry) {
    throw new Error(`expected route ${expectedLabel} -> ${expectedRepoEntry} is not present in repoRouting.byLabel`);
  }
  const labels = new Set(labelNames || []);
  const matches = Object.entries(byLabel)
    .filter(([label]) => labels.has(label))
    .map(([label, repoEntry]) => ({ label, repoEntry }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (matches.length === 0) return { eligible: false, reason: "missing-route-label", matches };
  if (matches.length > 1) return { eligible: false, reason: "ambiguous-route-label", matches };
  const [match] = matches;
  if (match.label !== expectedLabel || match.repoEntry !== expectedRepoEntry) {
    return { eligible: false, reason: "route-changed", matches };
  }
  return { eligible: true, reason: "ready", matches };
}

// The canonical board definition the sweeps depend on:
export const REQUIRED_STATES = [
  { name: WORKFLOW_STATES.spec, type: "unstarted", color: "#9b59b6" },
  { name: WORKFLOW_STATES.dev, type: "unstarted", color: "#4ea7fc" },
  { name: WORKFLOW_STATES.qa, type: "started", color: "#27ae60", after: WORKFLOW_STATES.dev },
  // The review/ship split adds two `started` columns BETWEEN QA and Done.
  // `after` names the state they should follow; setup-team computes a board
  // position so they render in pipeline order (Linear appends without one).
  // Order matters: Signoff is created before Ship, which follows it.
  { name: WORKFLOW_STATES.signoff, type: "started", color: "#f2c94c", after: WORKFLOW_STATES.qa },
  { name: WORKFLOW_STATES.ship, type: "started", color: "#5e6ad2", after: WORKFLOW_STATES.signoff },
  { name: "Archived", type: "completed", color: "#95a2b3" },
  // Backlog / Todo / Done / Canceled / Duplicate are Linear defaults —
  // In Progress is a legacy default state; COD-99 stops using it for active dev.
  // setup-team only creates the ones above if missing.
];
export const REQUIRED_LABELS = [
  { name: "spec:in-progress", color: "#4cb782" },
  { name: "dev:in-progress", color: "#4cb782" },
  { name: "qa:in-progress", color: "#4cb782" },
  { name: "qa:needs-changes", color: "#f2994a" },
  { name: "qa:passed", color: "#4cb782" },
  { name: "ship:in-progress", color: "#4cb782" },
  { name: "ship:approved", color: "#4cb782" },
  { name: "fast-path:eligible", color: "#5e6ad2" },
  { name: "blocked:open-questions", color: "#eb5757" },
  { name: "blocked:needs-user", color: "#eb5757" },
  { name: "sweep:manual-only", color: "#95a2b3" },
];

// Compute a board position that slots a new state directly after `afterName`:
// the midpoint between the anchor and its next-higher neighbor, or anchor+1 if
// the anchor is last. Returns undefined when the anchor is absent/positionless
// (caller then creates without a position and Linear appends). Pure/testable.
export function positionAfter(states, afterName) {
  const anchor = states.find((s) => s.name === afterName);
  if (!anchor || typeof anchor.position !== "number") return undefined;
  const higher = states.filter((s) => typeof s.position === "number" && s.position > anchor.position);
  if (!higher.length) return anchor.position + 1;
  return (anchor.position + Math.min(...higher.map((s) => s.position))) / 2;
}

// Collect the distinct domain-label names a project's reviewLenses config
// references, so setup-team can pre-create them (a label must exist as a team
// label before a sweep can apply its id). Missing/empty config ⇒ []. Pure.
export function reviewLensLabels(config) {
  const lenses = config && config.reviewLenses;
  if (!lenses || typeof lenses !== "object") return [];
  const names = new Set();
  for (const lens of Object.values(lenses)) {
    for (const name of (lens && Array.isArray(lens.labels) ? lens.labels : [])) names.add(name);
  }
  return [...names];
}

// Linear renders larger Issue.sortOrder values closer to the top of a workflow
// state column. To place an issue at the bottom, choose a value below the
// current minimum in the destination state.
export function bottomSortOrder(cards, gap = 1) {
  const values = (cards || []).map((c) => c.sortOrder).filter(Number.isFinite);
  return values.length ? Math.min(...values) - Math.abs(gap) : 0;
}

export function issueUpdateToStateBottomInput(stateId, destinationCards) {
  return { stateId, sortOrder: bottomSortOrder(destinationCards) };
}

export function retireStateAuditComment(sourceState, destinationState) {
  return [
    `Retiring legacy workflow state \`${sourceState}\`: moved this card to \`${destinationState}\`.`,
    "",
    "Existing labels were preserved as-is; no new claim label was added.",
  ].join("\n");
}

export function retireStateIssueUpdateInput(destinationStateId, destinationCards) {
  return issueUpdateToStateBottomInput(destinationStateId, destinationCards);
}

export function planWorkflowStateRenames(states, renames = WORKFLOW_STATE_RENAMES) {
  const byName = new Map((states || []).map((s) => [s.name, s]));
  const presentSources = renames.filter((r) => byName.has(r.from));
  const presentTargets = renames.filter((r) => byName.has(r.to));

  if (presentSources.length === renames.length && presentTargets.length === 0) {
    return renames.map((r) => ({ id: byName.get(r.from).id, from: r.from, to: r.to }));
  }
  if (presentSources.length === 0 && presentTargets.length === renames.length) return [];

  const details = renames.map((r) => {
    const source = byName.has(r.from) ? "source-present" : "source-missing";
    const target = byName.has(r.to) ? "target-present" : "target-missing";
    return `${r.from} -> ${r.to}: ${source}, ${target}`;
  }).join("; ");
  throw new Error(`Cannot safely rename workflow states from a partial or colliding board state: ${details}`);
}

export function shouldDeferRequiredStateForRename(targetName, haveStates, renames = WORKFLOW_STATE_RENAMES) {
  const names = haveStates instanceof Set ? haveStates : new Set(haveStates || []);
  const rename = renames.find((r) => r.to === targetName);
  if (!rename || !names.has(rename.from)) return false;
  // Fresh Linear teams have a default "In Review" state. Only defer target-state
  // creation when this looks like an installed pre-COD-102 board, not a fresh team.
  return renames.some((r) => r.from !== "In Review" && names.has(r.from));
}

export const API = "https://api.linear.app/graphql";
const KEY = process.env.LINEAR_API_KEY;

// Shared Linear client. `apiKey` defaults to the process env so this file's own
// commands keep working; linear-watch.mjs passes a per-anchor key (each workspace
// loads its own .env), so one gql() serves many keys without a module-global.
export async function gql(query, variables, apiKey = process.env.LINEAR_API_KEY) {
  if (!apiKey) throw new Error("LINEAR_API_KEY not set. Load it from your gitignored .env: `set -a && . ./.env && set +a`.");
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error("Linear API error: " + JSON.stringify(json.errors));
  return json.data;
}

export async function fetchIssueDependencies(apiKey, issueId, { gqlFn = gql } = {}) {
  if (!issueId) throw new Error("usage: dependency-status <issueId>");
  const blockers = [];
  const seenCursors = new Set();
  let cursor = null;
  let issue = issueId;

  while (true) {
    const d = await gqlFn(
      `query($issueId:String!,$cursor:String){ issue(id:$issueId){ identifier inverseRelations(first:50, after:$cursor){ pageInfo { hasNextPage endCursor } nodes { id type issue { id identifier state { id name type } } } } } }`,
      { issueId, cursor },
      apiKey,
    );
    if (!d?.issue) throw new Error(`Issue "${issueId}" not found or unreadable.`);
    issue = d.issue.identifier || issue;
    const connection = d.issue.inverseRelations;
    blockers.push(...normalizeBlockingRelations(connection));
    const pageInfo = connection?.pageInfo;
    if (typeof pageInfo?.hasNextPage !== "boolean") throw new Error("inverseRelations pageInfo missing");
    if (!pageInfo.hasNextPage) return { issue, blockers, complete: true };
    if (!pageInfo.endCursor || seenCursors.has(pageInfo.endCursor)) return { issue, blockers, complete: false };
    seenCursors.add(pageInfo.endCursor);
    cursor = pageInfo.endCursor;
  }
}

export async function fetchIssueLabels(apiKey, issueId, { gqlFn = gql } = {}) {
  if (!issueId) throw new Error("usage: repo-status <issueId> <expectedLabel> <expectedRepoEntry>");
  const d = await gqlFn(
    `query($issueId:String!){ issue(id:$issueId){ identifier labels{ nodes{ name } } } }`,
    { issueId },
    apiKey,
  );
  if (!d?.issue || !Array.isArray(d.issue.labels?.nodes)) throw new Error(`Issue "${issueId}" not found or labels unreadable.`);
  return { issue: d.issue.identifier || issueId, labelNames: d.issue.labels.nodes.map((label) => label.name) };
}

function writeAutoSweepOutcome(value) {
  const outcomePath = process.env.AUTO_SWEEP_OUTCOME_PATH;
  if (!outcomePath) return false;
  fs.mkdirSync(path.dirname(outcomePath), { recursive: true });
  try {
    fs.writeFileSync(outcomePath, JSON.stringify(value), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

async function findTeam(nameOrKey) {
  const d = await gql(`{ teams(first:250){ nodes { id name key } } }`);
  const q = nameOrKey.toLowerCase();
  const t = d.teams.nodes.find((n) => n.name.toLowerCase() === q || n.key.toLowerCase() === q);
  if (!t) throw new Error(`Team "${nameOrKey}" not found. Available: ${d.teams.nodes.map((n) => `${n.name} (${n.key})`).join(", ")}`);
  return t;
}

async function whoami() {
  const d = await gql(`{ viewer { name email } teams(first:250){ nodes { name key } } }`);
  console.log(`viewer: ${d.viewer.name} <${d.viewer.email}>`);
  console.log("teams:");
  d.viewer && d.teams.nodes.forEach((t) => console.log(`  ${t.name} (${t.key})`));
}

async function setupTeam(nameOrKey) {
  const team = await findTeam(nameOrKey);
  const d = await gql(
    `query($id:String!){ team(id:$id){ states(first:100){nodes{name position}} labels(first:250){nodes{name}} } }`,
    { id: team.id }
  );
  const haveStates = new Set(d.team.states.nodes.map((s) => s.name));
  const haveLabels = new Set(d.team.labels.nodes.map((l) => l.name));
  // Live, ordered view of the board so `after`-positioned states slot in
  // correctly — and so later new states see earlier ones once added this run.
  const stateList = d.team.states.nodes.map((s) => ({ name: s.name, position: s.position }));

  for (const s of REQUIRED_STATES) {
    if (haveStates.has(s.name)) { console.log(`state "${s.name}": exists`); continue; }
    if (shouldDeferRequiredStateForRename(s.name, haveStates)) {
      const legacyName = WORKFLOW_STATE_RENAMES.find((r) => r.to === s.name).from;
      console.log(`state "${s.name}": pending rename from "${legacyName}"`);
      continue;
    }
    const position = s.after ? positionAfter(stateList, s.after) : undefined;
    const input = { teamId: team.id, name: s.name, type: s.type, color: s.color };
    if (typeof position === "number") input.position = position;
    const r = await gql(
      `mutation($i:WorkflowStateCreateInput!){ workflowStateCreate(input:$i){ success } }`,
      { i: input }
    );
    console.log(`state "${s.name}": ${r.workflowStateCreate.success ? "CREATED" : "FAILED"}${s.after ? ` (after ${s.after})` : ""}`);
    // Reflect the new state so a later `after` referencing it computes correctly.
    stateList.push({ name: s.name, position: typeof position === "number" ? position : Number.MAX_SAFE_INTEGER });
  }

  // Base workflow labels, plus any domain labels this project's reviewLenses
  // config references — they must exist as team labels before a sweep can
  // apply their ids (generate-if-missing gating depends on this).
  const cfg = readLocalSweepConfig();
  const lensLabels = reviewLensLabels(cfg).map((name) => ({ name, color: "#bec2c8" }));
  for (const l of [...REQUIRED_LABELS, ...lensLabels]) {
    if (haveLabels.has(l.name)) { console.log(`label "${l.name}": exists`); continue; }
    const r = await gql(
      `mutation($i:IssueLabelCreateInput!){ issueLabelCreate(input:$i){ success } }`,
      { i: { teamId: team.id, name: l.name, color: l.color } }
    );
    haveLabels.add(l.name); // avoid a duplicate create if a lens repeats a base name
    console.log(`label "${l.name}": ${r.issueLabelCreate.success ? "CREATED" : "FAILED"}`);
  }
  console.log(`\nTeam "${team.name}" (${team.key}) ready. teamId=${team.id}`);
}

// Best-effort read of the workspace-anchor sweep config (for reviewLenses labels).
// Scheduled children receive the managed anchor explicitly; direct setup-team
// runs fall back to the target repo root, and kit-level runs without a config
// just create the base taxonomy.
function readLocalSweepConfig() {
  try {
    const p = path.join(process.env.AUTO_SWEEP_ANCHOR || process.cwd(), ".claude", "linear-sweep.json");
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } catch { return null; }
}

async function ensureProject(teamNameOrKey, projectName) {
  const team = await findTeam(teamNameOrKey);
  const d = await gql(
    `query($id:String!){ team(id:$id){ projects(first:250){ nodes { id name } } } }`,
    { id: team.id }
  );
  const existing = d.team.projects.nodes.find((p) => p.name.toLowerCase() === projectName.toLowerCase());
  if (existing) { console.log(`project "${projectName}" exists: ${existing.id}`); return existing.id; }
  const r = await gql(
    `mutation($i:ProjectCreateInput!){ projectCreate(input:$i){ success project { id name } } }`,
    { i: { name: projectName, teamIds: [team.id] } }
  );
  console.log(`project "${projectName}" CREATED: ${r.projectCreate.project.id}`);
  return r.projectCreate.project.id;
}

async function createCard(projectId, stateName, title, description, labelsCsv) {
  // Resolve the project's team, then map state + label names to ids.
  const pd = await gql(`query($id:String!){ project(id:$id){ teams(first:1){nodes{id}} } }`, { id: projectId });
  const teamId = pd.project.teams.nodes[0].id;
  const meta = await gql(
    `query($id:String!){ team(id:$id){ states(first:100){nodes{id name}} labels(first:250){nodes{id name}} } }`,
    { id: teamId }
  );
  const stateId = meta.team.states.nodes.find((s) => s.name === stateName)?.id;
  if (!stateId) throw new Error(`State "${stateName}" not found on the team. Run setup-team first.`);
  const labelNames = (labelsCsv || "").split(",").map((s) => s.trim()).filter(Boolean);
  const labelIds = labelNames
    .map((n) => meta.team.labels.nodes.find((l) => l.name === n)?.id)
    .filter(Boolean);
  const r = await gql(
    `mutation($i:IssueCreateInput!){ issueCreate(input:$i){ success issue { identifier url } } }`,
    { i: { teamId, projectId, title, description, stateId, labelIds } }
  );
  const iss = r.issueCreate.issue;
  console.log(`${iss.identifier} [${stateName}] ${title}\n  ${iss.url}`);
  return iss;
}

async function destinationCards(projectId, stateName) {
  return destinationCardsWith(gql, projectId, stateName);
}

async function destinationCardsWith(gqlFn, projectId, stateName) {
  const cards = [];
  let cursor = null;
  do {
    const d = await gqlFn(
      `query($projectId:ID!,$state:String!,$cursor:String){ issues(first:100, after:$cursor, filter:{ project:{ id:{ eq:$projectId } }, state:{ name:{ eq:$state } } }){ pageInfo{ hasNextPage endCursor } nodes { id sortOrder } } }`,
      { projectId, state: stateName, cursor }
    );
    cards.push(...d.issues.nodes);
    cursor = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (cursor);
  return cards;
}

async function moveCardBottom(issueIdentifier, stateName) {
  const cur = await gql(
    `query($id:String!){ issue(id:$id){ id identifier project { id } team { states(first:100){ nodes { id name } } } } }`,
    { id: issueIdentifier }
  );
  const issue = cur.issue;
  if (!issue) throw new Error(`Issue "${issueIdentifier}" not found.`);
  const stateId = issue.team.states.nodes.find((s) => s.name === stateName)?.id;
  if (!stateId) throw new Error(`State "${stateName}" not found on the issue's team.`);
  const cards = (await destinationCards(issue.project.id, stateName)).filter((n) => n.id !== issue.id);
  const input = issueUpdateToStateBottomInput(stateId, cards);
  const r = await gql(
    `mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success issue { identifier state { name } sortOrder url } } }`,
    { id: issue.id, input }
  );
  const moved = r.issueUpdate.issue;
  console.log(`${moved.identifier} -> ${moved.state.name} bottom (sortOrder=${moved.sortOrder})\n  ${moved.url}`);
  return moved;
}

async function projectStateIds(projectId) {
  return projectStateIdsWith(gql, projectId);
}

async function projectStateIdsWith(gqlFn, projectId) {
  const d = await gqlFn(
    `query($id:String!){ project(id:$id){ teams(first:1){ nodes{ states(first:100){ nodes{ id name } } } } } }`,
    { id: projectId }
  );
  const states = d.project?.teams?.nodes?.[0]?.states?.nodes || [];
  return Object.fromEntries(states.map((s) => [s.name, s.id]));
}

async function projectStatesWith(gqlFn, projectId) {
  const d = await gqlFn(
    `query($id:String!){ project(id:$id){ teams(first:1){ nodes{ states(first:100){ nodes{ id name } } } } } }`,
    { id: projectId }
  );
  return d.project?.teams?.nodes?.[0]?.states?.nodes || [];
}

export async function renameWorkflowStates(projectId, { gqlFn = gql, log = console.log } = {}) {
  if (!projectId) throw new Error("usage: rename-states <projectId>");
  const states = await projectStatesWith(gqlFn, projectId);
  const operations = planWorkflowStateRenames(states);
  if (!operations.length) {
    log("Workflow state rename already complete.");
    return [];
  }

  const renamed = [];
  for (const op of operations) {
    const r = await gqlFn(
      `mutation($id:String!,$input:WorkflowStateUpdateInput!){ workflowStateUpdate(id:$id,input:$input){ success workflowState { id name } } }`,
      { id: op.id, input: { name: op.to } }
    );
    const state = r.workflowStateUpdate.workflowState;
    renamed.push({ ...op, result: state });
    log(`${op.from} -> ${state.name}`);
  }
  log(`Renamed ${renamed.length} workflow state(s).`);
  return renamed;
}

async function cardsInState(projectId, stateName) {
  return cardsInStateWith(gql, projectId, stateName);
}

async function cardsInStateWith(gqlFn, projectId, stateName) {
  const cards = [];
  let cursor = null;
  do {
    const d = await gqlFn(
      `query($projectId:ID!,$state:String!,$cursor:String){ issues(first:100, after:$cursor, filter:{ project:{ id:{ eq:$projectId } }, state:{ name:{ eq:$state } } }){ pageInfo{ hasNextPage endCursor } nodes { id identifier title sortOrder url } } }`,
      { projectId, state: stateName, cursor }
    );
    cards.push(...d.issues.nodes);
    cursor = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (cursor);
  return cards;
}

async function commentIssue(issueId, body) {
  await commentIssueWith(gql, issueId, body);
}

async function commentIssueWith(gqlFn, issueId, body) {
  await gqlFn(`mutation($id:String!,$b:String!){ commentCreate(input:{ issueId:$id, body:$b }){ success } }`, { id: issueId, b: body });
}

export async function retireState(projectId, sourceState, destinationState, { gqlFn = gql, log = console.log } = {}) {
  if (!projectId || !sourceState || !destinationState) throw new Error("usage: retire-state <projectId> <sourceState> <destinationState>");
  if (sourceState === destinationState) throw new Error("source and destination states must differ");
  const stateIds = await projectStateIdsWith(gqlFn, projectId);
  const destinationStateId = stateIds[destinationState];
  if (!destinationStateId) throw new Error(`State "${destinationState}" not found on the project team.`);
  if (!stateIds[sourceState]) throw new Error(`State "${sourceState}" not found on the project team.`);

  const sourceCards = await cardsInStateWith(gqlFn, projectId, sourceState);
  if (!sourceCards.length) {
    log(`No cards in "${sourceState}" to move.`);
    return [];
  }

  const moved = [];
  for (const card of sourceCards) {
    const destination = (await destinationCardsWith(gqlFn, projectId, destinationState)).filter((n) => n.id !== card.id);
    const input = retireStateIssueUpdateInput(destinationStateId, destination);
    const r = await gqlFn(
      `mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success issue { identifier state { name } sortOrder url } } }`,
      { id: card.id, input }
    );
    await commentIssueWith(gqlFn, card.id, retireStateAuditComment(sourceState, destinationState));
    moved.push(r.issueUpdate.issue);
    log(`${r.issueUpdate.issue.identifier} -> ${destinationState} bottom (sortOrder=${r.issueUpdate.issue.sortOrder})`);
  }
  log(`Moved ${moved.length} card(s) from "${sourceState}" to "${destinationState}".`);
  return moved;
}

// CLI dispatch — only when run directly (`node linear.mjs …`), NOT when another
// module imports gql/findTeam. Without this guard, importing linear.mjs would
// execute a command based on the importer's argv.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = {
    whoami: () => whoami(),
    "setup-team": () => setupTeam(args[0]),
    "ensure-project": () => ensureProject(args[0], args[1]),
    "create-card": () => createCard(args[0], args[1], args[2], args[3], args[4]),
    "move-card-bottom": () => moveCardBottom(args[0], args[1]),
    "retire-state": () => retireState(args[0], args[1], args[2]),
    "rename-states": () => renameWorkflowStates(args[0]),
    "repo-status": async () => {
      const [issueId, expectedLabel, expectedRepoEntry] = args;
      try {
        const configPath = path.join(process.env.AUTO_SWEEP_ANCHOR || process.cwd(), ".claude", "linear-sweep.json");
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const result = await fetchIssueLabels(KEY, issueId);
        const eligibility = repoRouteEligibility(result.labelNames, config.repoRouting?.byLabel, expectedLabel, expectedRepoEntry);
        const routing = {
          reason: eligibility.reason,
          expectedLabel,
          expectedRepoEntry,
          matches: eligibility.matches,
        };
        console.log(JSON.stringify({ issue: result.issue, eligible: eligibility.eligible, ...routing }));
        process.exitCode = eligibility.eligible ? 0 : 3;
        if (process.exitCode !== 0) {
          writeAutoSweepOutcome({
            version: 1,
            kind: "repo-routing-deferred",
            issueIdentifier: result.issue,
            routeExitCode: process.exitCode,
            routing,
          });
        }
      } catch (error) {
        console.error(String(error.message || error));
        process.exitCode = 2;
        if (process.env.AUTO_SWEEP_OUTCOME_PATH) {
          writeAutoSweepOutcome({
            version: 1,
            kind: "repo-routing-deferred",
            issueIdentifier: issueId,
            routeExitCode: 2,
            routing: { reason: "unreadable", expectedLabel, expectedRepoEntry, matches: [] },
          });
        }
      }
    },
    "dependency-status": async () => {
      try {
        const result = await fetchIssueDependencies(KEY, args[0]);
        const eligibility = dependencyEligibility(result.blockers, result.complete);
        console.log(JSON.stringify({
          issue: result.issue,
          eligible: eligibility.eligible,
          reason: eligibility.reason,
          blockers: eligibility.unresolved.map(({ identifier, stateName }) => ({ identifier, stateName })),
        }));
        process.exitCode = eligibility.eligible ? 0 : eligibility.reason === "blocked" ? 3 : 2;
        if (process.exitCode !== 0) {
          writeAutoSweepOutcome({
            version: 1,
            kind: "dependency-deferred",
            issueIdentifier: result.issue,
            dependencyExitCode: process.exitCode,
            dependency: {
              reason: eligibility.reason,
              blockers: eligibility.unresolved.map(({ identifier, stateName }) => ({ identifier, stateName })),
            },
          });
        }
      } catch (error) {
        console.error(String(error.message || error));
        process.exitCode = 2;
        if (process.env.AUTO_SWEEP_OUTCOME_PATH) {
          writeAutoSweepOutcome({
            version: 1,
            kind: "dependency-deferred",
            issueIdentifier: args[0],
            dependencyExitCode: 2,
            dependency: { reason: "unreadable", blockers: [] },
          });
        }
      }
    },
    query: () => gql(args[0]).then((d) => console.log(JSON.stringify(d, null, 2))),
  };
  if (!run[cmd]) {
    console.error("Commands: whoami | setup-team <team> | ensure-project <team> <project> | create-card <projectId> <state> <title> <desc> [labels] | move-card-bottom <Issue> <State> | retire-state <projectId> <FromState> <ToState> | rename-states <projectId> | repo-status <Issue> <Label> <Repo> | dependency-status <Issue> | query <graphql>");
    process.exit(1);
  }
  run[cmd]().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}

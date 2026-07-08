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
//   node linear.mjs query '{ viewer { name } }'            # raw GraphQL
//
// The canonical board definition the sweeps depend on:
export const REQUIRED_STATES = [
  { name: "Needs Spec", type: "unstarted", color: "#9b59b6" },
  { name: "Ready for Dev", type: "unstarted", color: "#4ea7fc" },
  // The review/ship split adds two `started` columns BETWEEN In Review and Done.
  // `after` names the state they should follow; setup-team computes a board
  // position so they render in pipeline order (Linear appends without one).
  // Order matters: QA Passed is created before Ready to Ship, which follows it.
  { name: "QA Passed", type: "started", color: "#f2c94c", after: "In Review" },
  { name: "Ready to Ship", type: "started", color: "#5e6ad2", after: "QA Passed" },
  { name: "Archived", type: "completed", color: "#95a2b3" },
  // Backlog / Todo / In Progress / In Review / Done / Canceled / Duplicate are Linear defaults —
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
  // correctly — and so a second new state (Ready to Ship) sees the first
  // (QA Passed) once it's been added this run.
  const stateList = d.team.states.nodes.map((s) => ({ name: s.name, position: s.position }));

  for (const s of REQUIRED_STATES) {
    if (haveStates.has(s.name)) { console.log(`state "${s.name}": exists`); continue; }
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

// Best-effort read of the repo-local sweep config (for reviewLenses labels).
// setup-team runs from a target repo's root; a kit-level run without a config
// just creates the base taxonomy.
function readLocalSweepConfig() {
  try {
    const p = path.join(process.cwd(), ".claude", "linear-sweep.json");
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
    query: () => gql(args[0]).then((d) => console.log(JSON.stringify(d, null, 2))),
  };
  if (!run[cmd]) {
    console.error("Commands: whoami | setup-team <team> | ensure-project <team> <project> | create-card <projectId> <state> <title> <desc> [labels] | query <graphql>");
    process.exit(1);
  }
  run[cmd]().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}

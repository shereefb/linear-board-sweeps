// Regression tests for the commit-bound QA handoff contract.
// Run: node --test tests/qa-sweep-doc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sweepPairs = ["dev", "qa", "ship"].map((sweep) => ({
  canonical: `.claude/skills/${sweep}-sweep/SKILL.md`,
  distributed: `skills/${sweep}-sweep/SKILL.md`,
}));

const operatorDocs = ["AGENTS.md", "README.md", "SETUP.md", "docs/linear-rules.md", "templates/AGENTS.snippet.md"];
const configPaths = [".claude/linear-sweep.json", "templates/linear-sweep.json"];
const claimOwningSweeps = ["spec", "dev", "qa", "ship"];

test("all claim-owning sweeps separate declarations from liveness", () => {
  for (const sweep of claimOwningSweeps) {
    for (const root of ["skills", ".claude/skills"]) {
      const path = `${root}/${sweep}-sweep/SKILL.md`;
      const body = fs.readFileSync(path, "utf8");
      assert.match(body, /AUTO_SWEEP_CLAIM_DECLARATION/, path);
      assert.match(body, /auto-sweep-claim v1/, path);
      assert.match(body, /heartbeats?[^\n]*liveness only/i, path);
      assert.match(body, /auto-sweep-claim-close v1/, path);
      assert.doesNotMatch(body, /latest exact-claim heartbeat owner|missing or changed latest owner/i, path);
    }
  }
});

test("sweep distributions document the commit-bound QA handoff", () => {
  for (const { canonical, distributed } of sweepPairs) {
    assert.equal(
      fs.readFileSync(canonical, "utf8"),
      fs.readFileSync(distributed, "utf8"),
      `${canonical} and ${distributed} must match byte-for-byte`,
    );
  }

  const dev = fs.readFileSync(sweepPairs[0].canonical, "utf8");
  const qa = fs.readFileSync(sweepPairs[1].canonical, "utf8");
  const ship = fs.readFileSync(sweepPairs[2].canonical, "utf8");

  assert.match(dev, /\[auto-sweep-fast-path <KEY> head=<full-git-sha>\]/);
  assert.match(dev, /only after[^\n]*push/i);
  assert.match(qa, /\[auto-sweep-auto-ship <KEY> head=<full-git-sha>\]/);
  assert.match(qa, /`fast-path:eligible`/);
  assert.match(qa, /`qa:passed`/);
  assert.match(qa, /`fastPathEnabled: config\.fastPath\?\.enabled`/);
  assert.doesNotMatch(qa, /fastPathEnabled: config\.fastPath(?:\?|)\.enabled !== false/);
  assert.match(qa, /`requireShipApproval: config\.requireShipApproval`/);
  assert.doesNotMatch(qa, /`requireShipApproval: config\.requireShipApproval === false`/);
  assert.match(qa, /final origin[^\n]*SHA[^\n]*reviewed SHA/i);
  assert.match(qa, /remove `fast-path:eligible`[^\n]*stale/i);
  assert.match(qa, /policy denial[^\n]*not a QA failure/i);
  assert.match(qa, /move-card-bottom-if-current <PREFIX-###> "QA" "Ship" "qa:in-progress"/);
  assert.match(qa, /move-card-bottom-if-current <PREFIX-###> "QA" "Signoff" "qa:in-progress"/);
  assert.match(qa, /AUTO_SWEEP_OWNER_TOKEN/);
  assert.match(qa, /claim=qa:in-progress owner=<owner> declaration=<declaration>/);
  assert.match(qa, /manual QA[^\n]*separate random owner and declaration tokens/i);
  assert.match(qa, /move-card-bottom-if-current <PREFIX-###> "QA" "Ship" "qa:in-progress" "\$AUTO_SWEEP_OWNER_TOKEN" "\$AUTO_SWEEP_CLAIM_DECLARATION"/);
  assert.match(qa, /`removedLabelIds`/);
  assert.doesNotMatch(qa, /full `labelIds` replacement/i);
  assert.match(qa, /one `issueUpdate` mutation/i);
  assert.match(qa, /no compare-and-swap/i);
  assert.match(qa, /immediately before[^\n]*handoff[^\n]*fetch origin[^\n]*rerun the full[^\n]*policy/i);
  assert.match(ship, /automatically promoted by qa-sweep/i);
  assert.match(ship, /only sweep that merges and deploys/i);
  assert.match(ship, /latest[^\n]*issue-specific[^\n]*\[auto-sweep-auto-ship <KEY> head=<full-git-sha>\]/i);
  assert.match(ship, /current origin branch SHA[^\n]*exact/i);
  assert.match(ship, /re-fetch[^\n]*immediately before[^\n]*merge/i);
  assert.match(ship, /origin[^\n]*(?:advanced|changed|mismatch)[^\n]*block/i);
  for (const label of ["blocked:open-questions", "blocked:needs-user", "qa:needs-changes", "sweep:manual-only"]) {
    assert.match(ship, new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*before merge`, "i"));
  }
  assert.match(dev, /malformed[^\n]*fastPath\.enabled[^\n]*fail[^\n]*closed/i);
});

test("approved COD-142 artifacts preserve raw config and commit binding through Ship", () => {
  for (const path of [
    "docs/superpowers/specs/2026-07-10-COD-142-auto-ship-qa-fast-path-design.md",
    "docs/superpowers/plans/2026-07-10-COD-142-auto-ship-qa-fast-path-implementation.md",
  ]) {
    const body = fs.readFileSync(path, "utf8");
    assert.match(body, /fastPathEnabled: config\.fastPath\?\.enabled/, `${path}: raw config mapping missing`);
    assert.match(body, /move-card-bottom-if-current/, `${path}: guarded terminal helper missing`);
    assert.match(body, /one `issueUpdate` mutation/i, `${path}: one-mutation boundary missing`);
    assert.match(body, /re-fetch[^\n]*immediately before[^\n]*merge/i, `${path}: pre-merge origin recheck missing`);
    assert.match(body, /origin[^\n]*(?:advanced|changed|mismatch)[^\n]*block/i, `${path}: post-QA origin advancement denial missing`);
    assert.match(body, /AUTO_SWEEP_OWNER_TOKEN/, `${path}: owner-token propagation missing`);
    assert.match(body, /removedLabelIds/, `${path}: delta label removal missing`);
    assert.match(body, /destination[^\n]*(?:pagination|rank)[^\n]*final[^\n]*(?:read|guard)/i, `${path}: final-read ordering missing`);
  }
});

test("operator claim docs preserve declaration handoff semantics", () => {
  for (const path of ["AGENTS.md", "templates/AGENTS.snippet.md"]) {
    const body = fs.readFileSync(path, "utf8");
    assert.match(body, /AUTO_SWEEP_OWNER_TOKEN/, `${path}: owner token environment missing`);
    assert.match(body, /AUTO_SWEEP_CLAIM_DECLARATION/, `${path}: declaration environment missing`);
    assert.match(body, /first-declaration-wins/i, `${path}: claim epoch rule missing`);
    assert.match(body, /complete[^\n]*comment history/i, `${path}: complete-history rule missing`);
  }
});

test("operator claim migration docs distinguish exact resets from ambiguous-history correction", () => {
  for (const path of ["AGENTS.md", "README.md", "SETUP.md", "docs/linear-rules.md", "templates/AGENTS.snippet.md"]) {
    const body = fs.readFileSync(path, "utf8");
    assert.match(body, /claim-migration-reset/, `${path}: attended exact reset command missing`);
    assert.match(body, /legacy-unowned[^\n]*target[^\n]*legacy/i, `${path}: legacy target contract missing`);
    assert.match(body, /orphan-declaration[^\n]*exact[^\n]*declaration/i, `${path}: orphan target contract missing`);
    assert.match(body, /ambiguous[^\n]*(?:inspect|inspection)[^\n]*(?:malformed|conflicting)[^\n]*marker/i, `${path}: ambiguous history correction missing`);
    assert.match(body, /rerun[^\n]*claim-migration-status/i, `${path}: rerun gate missing`);
  }
  for (const path of [".claude/linear-sweep.json", "templates/linear-sweep.json"]) {
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    assert.match(config.$comment_claims, /claim-migration-reset/);
    assert.match(config.$comment_claims, /ambiguous[^.]*malformed|conflicting/i);
  }
});

test("operator docs explain automatic commit-bound routing without expanding QA production scope", () => {
  for (const path of operatorDocs) {
    const body = fs.readFileSync(path, "utf8");
    assert.match(body, /commit-bound[^\n]*QA[^\n]*Ship/i, `${path}: missing commit-bound QA-to-Ship routing`);
    assert.match(body, /requireShipApproval[^\n]*true[^\n]*Signoff/i, `${path}: missing explicit-approval Signoff behavior`);
    assert.match(body, /qa-sweep[^\n]*never merges[^\n]*(?:or|and) deploys/i, `${path}: missing non-production QA boundary`);
  }
});

test("fast-path config comments describe automatic unchanged-SHA routing", () => {
  for (const path of configPaths) {
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    assert.match(config.$comment_fastPath, /commit-bound/i, `${path}: missing commit-bound policy`);
    assert.match(config.$comment_fastPath, /QA[^.]*Ship[^.]*automatic/i, `${path}: missing automatic QA-to-Ship routing`);
    assert.match(config.$comment_fastPath, /requireShipApproval[^.]*true[^.]*Signoff/i, `${path}: missing explicit approval behavior`);
    assert.match(config.$comment_fastPath, /full[^.]*SHA/i, `${path}: missing full-SHA binding`);
  }
});

test("Factory Learning cards never use the automatic QA-to-Ship marker path", () => {
  for (const path of [".claude/skills/qa-sweep/SKILL.md", "skills/qa-sweep/SKILL.md"]) {
    const body = fs.readFileSync(path, "utf8");
    assert.match(body, /factory:learning-generated[^\n]*Signoff/i, `${path}: generated cards must route to Signoff`);
    assert.match(body, /factory:learning-generated[^\n]*never[^\n]*\[auto-sweep-auto-ship/i, `${path}: generated cards must never post the auto-ship marker`);
  }
  for (const path of configPaths) {
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    assert.match(config.$comment_fastPath, /factory:learning-generated[^.]*never[^.]*auto-ship marker/i, `${path}: generated-card marker exclusion missing`);
  }
});

test("operator docs preserve the Factory Learning human Ship gate", () => {
  for (const path of operatorDocs) {
    const body = fs.readFileSync(path, "utf8");
    assert.match(body, /factory:learning-generated[^\n]*(?:never auto-ships|never uses the auto-ship marker)[^\n]*human[^\n]*Ship/i, `${path}: generated-card human Ship contract missing`);
  }
});

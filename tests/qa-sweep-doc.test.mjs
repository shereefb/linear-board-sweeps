// Regression tests for the commit-bound QA handoff contract.
// Run: node --test tests/qa-sweep-doc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sweepPairs = ["dev", "qa", "ship"].map((sweep) => ({
  canonical: `.claude/skills/${sweep}-sweep/SKILL.md`,
  distributed: `skills/${sweep}-sweep/SKILL.md`,
}));

const operatorDocs = ["AGENTS.md", "README.md", "SETUP.md", "docs/linear-rules.md"];
const configPaths = [".claude/linear-sweep.json", "templates/linear-sweep.json"];

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
  assert.match(qa, /`fastPathEnabled: config\.fastPath\.enabled !== false`/);
  assert.match(qa, /`requireShipApproval: config\.requireShipApproval`/);
  assert.doesNotMatch(qa, /`requireShipApproval: config\.requireShipApproval === false`/);
  assert.match(qa, /final origin[^\n]*SHA[^\n]*reviewed SHA/i);
  assert.match(qa, /remove `fast-path:eligible`[^\n]*stale/i);
  assert.match(qa, /policy denial[^\n]*not a QA failure/i);
  assert.match(qa, /move-card-bottom <PREFIX-###> "Ship"/);
  assert.match(qa, /move-card-bottom <PREFIX-###> "Signoff"/);
  assert.match(ship, /automatically promoted by qa-sweep/i);
  assert.match(ship, /only sweep that merges and deploys/i);
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

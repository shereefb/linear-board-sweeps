import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));

test("install-watch uses a managed clean kit clone for launchd runtime", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linear-watch-home-"));
  const managedKit = path.join(home, ".local", "share", "linear-board-sweeps", "kit");
  const result = spawnSync("zsh", [path.join(repoRoot, "scripts", "install-watch.sh")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      LINEAR_SWEEP_RUNTIME_KIT: managedKit,
      LINEAR_SWEEP_KIT_REMOTE: repoRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const linkTarget = fs.readlinkSync(path.join(home, ".local", "bin", "linear-watch.sh"));
  assert.equal(linkTarget, path.join(managedKit, "scripts", "linear-watch.sh"));

  const registry = JSON.parse(fs.readFileSync(path.join(home, ".config", "linear-board-sweeps", "registry.json"), "utf8"));
  assert.equal(registry.kitPath, managedKit);
  assert.equal(registry.kitRemote, repoRoot);
});

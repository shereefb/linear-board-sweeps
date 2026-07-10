import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));

test("launchd wrapper exposes ChatGPT and legacy Codex app bundles", () => {
  const wrapper = fs.readFileSync(path.join(repoRoot, "scripts", "linear-watch.sh"), "utf8");
  const pathExport = wrapper.match(/^export PATH="([^"]+)"$/m)?.[1].split(":") ?? [];

  assert.ok(pathExport.includes("/Applications/ChatGPT.app/Contents/Resources"));
  assert.ok(pathExport.includes("/Applications/Codex.app/Contents/Resources"));
});

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
  const wrapper = fs.readFileSync(linkTarget, "utf8");
  assert.match(wrapper, /\/Applications\/ChatGPT\.app\/Contents\/Resources/);
  assert.match(wrapper, /\/Applications\/Codex\.app\/Contents\/Resources/);

  const registry = JSON.parse(fs.readFileSync(path.join(home, ".config", "linear-board-sweeps", "registry.json"), "utf8"));
  assert.equal(registry.kitPath, managedKit);
  assert.equal(registry.kitRemote, repoRoot);
  assert.deepEqual(registry.capacity, { maxActiveChildren: 10 });
});

test("install-watch migrates a legacy registry to the default capacity without dropping fields", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linear-watch-legacy-capacity-home-"));
  const configDir = path.join(home, ".config", "linear-board-sweeps");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "registry.json"), JSON.stringify({
    autoUpdate: false,
    customSetting: "preserved",
    repos: ["/source/app"],
  }));
  const result = spawnSync("zsh", [path.join(repoRoot, "scripts", "install-watch.sh")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      LINEAR_SWEEP_RUNTIME_KIT: repoRoot,
      LINEAR_SWEEP_KIT_REMOTE: repoRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const registry = JSON.parse(fs.readFileSync(path.join(configDir, "registry.json"), "utf8"));
  assert.deepEqual(registry.capacity, { maxActiveChildren: 10 });
  assert.equal(registry.customSetting, "preserved");
  assert.deepEqual(registry.repos, ["/source/app"]);
  assert.equal(registry.autoUpdate, false);
});

test("install-watch clamps huge capacity to 32 and preserves existing settings", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linear-watch-capacity-home-"));
  const configDir = path.join(home, ".config", "linear-board-sweeps");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "registry.json"), JSON.stringify({
    autoUpdate: false,
    customSetting: "preserved",
    capacity: { maxActiveChildren: 1_000_000, customCapacity: true },
  }));
  const result = spawnSync("zsh", [path.join(repoRoot, "scripts", "install-watch.sh")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      LINEAR_SWEEP_RUNTIME_KIT: repoRoot,
      LINEAR_SWEEP_KIT_REMOTE: repoRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const registry = JSON.parse(fs.readFileSync(path.join(configDir, "registry.json"), "utf8"));
  assert.equal(registry.capacity.maxActiveChildren, 32);
  assert.equal(registry.capacity.customCapacity, true);
  assert.equal(registry.customSetting, "preserved");
  assert.equal(registry.autoUpdate, false);
});

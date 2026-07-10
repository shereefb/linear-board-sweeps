import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEARNING_EVENT_TAXONOMY,
  LEARNING_LENSES,
  LEARNING_STAGE,
  LEARNING_STATE_VERSION,
  LEARNING_TRIGGER,
  canonicalAnchorIdentity,
  createLearningStateStore,
  normalizeLearningRegistry,
  normalizeWorkspaceLearning,
} from "../scripts/learning.mjs";

function memoryLearningStore(initial = null) {
  let stored = initial;
  const writes = [];
  const store = createLearningStateStore({
    statePath: "/state/learning-state.json",
    readJsonFn: () => structuredClone(stored),
    writeJsonFn: (_target, value) => {
      stored = structuredClone(value);
      writes.push(structuredClone(value));
    },
    now: () => "2026-07-10T12:00:00.000Z",
  });
  return { store, writes, stored: () => structuredClone(stored) };
}

test("learning contracts expose stable stage, trigger, lenses, and taxonomy", () => {
  assert.equal(LEARNING_STATE_VERSION, 1);
  assert.equal(LEARNING_STAGE, "learning");
  assert.equal(LEARNING_TRIGGER, "learning-due");
  assert.deepEqual(LEARNING_LENSES, ["reliability", "quality", "throughput"]);
  assert.deepEqual(LEARNING_EVENT_TAXONOMY, {
    review: ["correctness", "security", "error-handling", "test-gap", "scope-gap", "performance", "design"],
    qa: ["environment-start", "functional-failure", "console-error", "network-error", "accessibility", "visual", "build"],
    question: ["config", "credential", "product-decision", "asset", "deploy"],
    bounce: ["missing-acceptance", "missing-design", "missing-repo-scope", "implementation-incomplete"],
    canary: ["red"],
    terminal: ["advanced", "blocked", "failed"],
  });
});

test("learning config defaults disabled and clamps the create budget", () => {
  assert.deepEqual(normalizeWorkspaceLearning({}), {
    enabled: false,
    lenses: { reliability: true, quality: true, throughput: true },
  });
  const reg = normalizeLearningRegistry({
    repos: ["/repo"],
    learning: { enabled: true, runner: true, coreSourceAnchor: "/repo", maxNewCardsPerRun: 999 },
  }, { realpathFn: (p) => p });
  assert.equal(reg.learning.maxNewCardsPerRun, 6);
  assert.equal(reg.learning.coreSourceAnchor, "/repo");
});

test("workspace learning accepts boolean and object lens enablement without mutating input", () => {
  const config = {
    learning: {
      enabled: true,
      lenses: {
        reliability: false,
        quality: { enabled: false },
        throughput: { enabled: true },
      },
    },
  };
  assert.deepEqual(normalizeWorkspaceLearning(config), {
    enabled: true,
    lenses: { reliability: false, quality: false, throughput: true },
  });
  assert.equal(config.learning.lenses.quality.enabled, false);
});

test("canonical anchor identity uses realpath and falls back only for missing paths", () => {
  assert.equal(canonicalAnchorIdentity("/alias", { realpathFn: () => "/canonical" }), "/canonical");
  assert.equal(canonicalAnchorIdentity("relative/repo", {
    realpathFn: () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
    resolveFn: (p) => `/resolved/${p}`,
  }), "/resolved/relative/repo");
  assert.throws(() => canonicalAnchorIdentity("/denied", {
    realpathFn: () => { const error = new Error("denied"); error.code = "EACCES"; throw error; },
  }), /denied/);
});

test("canonical anchor aliases are rejected", () => {
  assert.throws(() => normalizeLearningRegistry({ repos: ["/a", "/alias"] }, {
    realpathFn: () => "/same",
  }), /duplicate canonical anchor/);
});

test("learning state write-ahead window survives an unconfirmed Linear write", () => {
  const { store, stored } = memoryLearningStore();
  store.stageWindow("quality", {
    from: "2026-07-01T00:00:00.000Z",
    capturedThrough: "2026-07-08T00:00:00.000Z",
    mutations: [{ mutationId: "m1", action: "create" }],
  });
  assert.equal(store.snapshot().lenses.quality.pending.mutations.m1.status, "pending");
  assert.equal(store.snapshot().lenses.quality.lastSuccessfulCapturedThrough, null);
  assert.equal(stored().version, LEARNING_STATE_VERSION);
});

test("learning state advances a lens watermark only after every mutation is confirmed", () => {
  const { store } = memoryLearningStore();
  store.stageWindow("reliability", {
    from: null,
    capturedThrough: "2026-07-10T00:00:00.000Z",
    mutations: [
      { mutationId: "m1", action: "create" },
      { mutationId: "m2", action: "update" },
    ],
  });
  store.confirmMutation("reliability", "m1");
  assert.equal(store.commitLens("reliability"), false);
  assert.equal(store.snapshot().lenses.reliability.lastSuccessfulCapturedThrough, null);
  store.confirmMutation("reliability", "m2");
  assert.equal(store.commitLens("reliability"), true);
  assert.equal(store.snapshot().lenses.reliability.lastSuccessfulCapturedThrough, "2026-07-10T00:00:00.000Z");
  assert.equal(store.snapshot().lenses.reliability.pending, null);
});

test("learning state validates lens and mutation identities before writing", () => {
  const { store, writes } = memoryLearningStore();
  assert.throws(() => store.stageWindow("unknown", { capturedThrough: "2026-07-10T00:00:00.000Z", mutations: [] }), /unknown learning lens/);
  store.stageWindow("throughput", { capturedThrough: "2026-07-10T00:00:00.000Z", mutations: [] });
  assert.throws(() => store.confirmMutation("throughput", "missing"), /unknown learning mutation/);
  assert.equal(writes.length, 1);
});

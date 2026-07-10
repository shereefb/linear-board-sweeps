import fs from "node:fs";
import path from "node:path";

export const LEARNING_STATE_VERSION = 1;
export const LEARNING_STAGE = "learning";
export const LEARNING_TRIGGER = "learning-due";
export const LEARNING_LENSES = Object.freeze(["reliability", "quality", "throughput"]);
export const MAX_NEW_LEARNING_CARDS_PER_RUN = 6;

export const LEARNING_EVENT_TAXONOMY = Object.freeze({
  review: Object.freeze(["correctness", "security", "error-handling", "test-gap", "scope-gap", "performance", "design"]),
  qa: Object.freeze(["environment-start", "functional-failure", "console-error", "network-error", "accessibility", "visual", "build"]),
  question: Object.freeze(["config", "credential", "product-decision", "asset", "deploy"]),
  bounce: Object.freeze(["missing-acceptance", "missing-design", "missing-repo-scope", "implementation-incomplete"]),
  canary: Object.freeze(["red"]),
  terminal: Object.freeze(["advanced", "blocked", "failed"]),
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function booleanSetting(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && typeof value.enabled === "boolean") return value.enabled;
  return fallback;
}

export function canonicalAnchorIdentity(anchorPath, {
  realpathFn = fs.realpathSync.native,
  resolveFn = path.resolve,
} = {}) {
  const resolved = resolveFn(anchorPath || ".");
  try {
    return resolveFn(realpathFn(resolved));
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    throw error;
  }
}

export function normalizeWorkspaceLearning(config = {}) {
  const raw = config?.learning && typeof config.learning === "object" ? config.learning : {};
  const rawLenses = raw.lenses && typeof raw.lenses === "object" ? raw.lenses : {};
  return {
    enabled: raw.enabled === true,
    lenses: Object.fromEntries(LEARNING_LENSES.map((lens) => [lens, booleanSetting(rawLenses[lens], true)])),
  };
}

export function normalizeLearningRegistry(registry = {}, deps = {}) {
  const out = { ...(registry || {}) };
  const repos = Array.isArray(out.repos) ? [...out.repos] : [];
  const identityToSource = new Map();
  for (const source of repos) {
    const identity = canonicalAnchorIdentity(source, deps);
    if (identityToSource.has(identity)) {
      throw new Error(`duplicate canonical anchor identity: ${identityToSource.get(identity)} and ${source}`);
    }
    identityToSource.set(identity, source);
  }

  const raw = out.learning && typeof out.learning === "object" ? out.learning : {};
  const configuredBudget = Number(raw.maxNewCardsPerRun);
  const maxNewCardsPerRun = Number.isFinite(configuredBudget) && configuredBudget > 0
    ? Math.min(MAX_NEW_LEARNING_CARDS_PER_RUN, Math.floor(configuredBudget))
    : MAX_NEW_LEARNING_CARDS_PER_RUN;
  const coreSourceAnchor = raw.coreSourceAnchor
    ? canonicalAnchorIdentity(raw.coreSourceAnchor, deps)
    : null;

  out.learning = {
    enabled: raw.enabled === true,
    runner: raw.runner === true,
    coreSourceAnchor,
    maxNewCardsPerRun,
    runtime: raw.runtime && typeof raw.runtime === "object" ? clone(raw.runtime) : null,
  };
  return out;
}

function emptyLensState() {
  return {
    lastSuccessfulCapturedThrough: null,
    detectorVersions: {},
    accumulated: {},
    pending: null,
  };
}

export function emptyLearningState() {
  return {
    version: LEARNING_STATE_VERSION,
    lenses: Object.fromEntries(LEARNING_LENSES.map((lens) => [lens, emptyLensState()])),
    baselines: {},
    evaluations: {},
  };
}

function normalizeLearningState(value) {
  if (!value) return emptyLearningState();
  if (value.version !== LEARNING_STATE_VERSION) {
    throw new Error(`unsupported learning state version: ${value.version ?? "missing"}`);
  }
  const state = emptyLearningState();
  for (const lens of LEARNING_LENSES) {
    const raw = value.lenses?.[lens];
    if (!raw || typeof raw !== "object") continue;
    state.lenses[lens] = {
      ...state.lenses[lens],
      ...clone(raw),
      detectorVersions: clone(raw.detectorVersions || {}),
      accumulated: clone(raw.accumulated || {}),
      pending: raw.pending ? clone(raw.pending) : null,
    };
  }
  state.baselines = clone(value.baselines || {});
  state.evaluations = clone(value.evaluations || {});
  return state;
}

function requireLens(lens) {
  if (!LEARNING_LENSES.includes(lens)) throw new Error(`unknown learning lens: ${lens}`);
}

export function createLearningStateStore({
  statePath,
  readJsonFn,
  writeJsonFn,
  now = () => new Date().toISOString(),
} = {}) {
  if (!statePath) throw new Error("learning state path is required");
  if (typeof readJsonFn !== "function") throw new Error("learning state readJsonFn is required");
  if (typeof writeJsonFn !== "function") throw new Error("learning state writeJsonFn is required");
  let state = normalizeLearningState(readJsonFn(statePath));

  const persist = () => writeJsonFn(statePath, clone(state));

  return {
    snapshot() {
      return clone(state);
    },

    stageWindow(lens, { from = null, capturedThrough, mutations = [] } = {}) {
      requireLens(lens);
      if (!capturedThrough || Number.isNaN(Date.parse(capturedThrough))) {
        throw new Error("learning capturedThrough must be an ISO timestamp");
      }
      const mutationMap = {};
      for (const mutation of mutations) {
        const mutationId = String(mutation?.mutationId || "").trim();
        if (!mutationId) throw new Error("learning mutationId is required");
        if (mutationMap[mutationId]) throw new Error(`duplicate learning mutation: ${mutationId}`);
        mutationMap[mutationId] = { ...clone(mutation), mutationId, status: "pending" };
      }
      state.lenses[lens].pending = {
        from,
        capturedThrough,
        stagedAt: now(),
        mutations: mutationMap,
      };
      persist();
      return clone(state.lenses[lens].pending);
    },

    confirmMutation(lens, mutationId) {
      requireLens(lens);
      const pending = state.lenses[lens].pending;
      const mutation = pending?.mutations?.[mutationId];
      if (!mutation) throw new Error(`unknown learning mutation: ${mutationId}`);
      mutation.status = "confirmed";
      mutation.confirmedAt = now();
      persist();
      return clone(mutation);
    },

    commitLens(lens) {
      requireLens(lens);
      const pending = state.lenses[lens].pending;
      if (!pending) return false;
      if (Object.values(pending.mutations || {}).some((mutation) => mutation.status !== "confirmed")) return false;
      state.lenses[lens].lastSuccessfulCapturedThrough = pending.capturedThrough;
      state.lenses[lens].pending = null;
      persist();
      return true;
    },
  };
}

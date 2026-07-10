import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LEARNING_STATE_VERSION = 1;
export const LEARNING_STAGE = "learning";
export const LEARNING_TRIGGER = "learning-due";
export const LEARNING_LENSES = Object.freeze(["reliability", "quality", "throughput"]);
export const MAX_NEW_LEARNING_CARDS_PER_RUN = 6;
export const LEARNING_EVENT_VERSION = 1;
export const MAX_LEARNING_EVENT_SUMMARY_CHARS = 1_000;
export const MAX_LEARNING_EVENT_METRICS = 32;
export const MAX_LEARNING_EVENT_METRIC_STRING_CHARS = 500;
export const MAX_LEARNING_SNAPSHOT_RUNS = 5_000;
export const MAX_LEARNING_SNAPSHOT_EVENTS = 10_000;
export const MAX_LEARNING_SNAPSHOT_OBSERVATIONS = 5_000;

export const LEARNING_EVENT_TAXONOMY = Object.freeze({
  review: Object.freeze(["correctness", "security", "error-handling", "test-gap", "scope-gap", "performance", "design"]),
  qa: Object.freeze(["environment-start", "functional-failure", "console-error", "network-error", "accessibility", "visual", "build"]),
  question: Object.freeze(["config", "credential", "product-decision", "asset", "deploy"]),
  bounce: Object.freeze(["missing-acceptance", "missing-design", "missing-repo-scope", "implementation-incomplete"]),
  canary: Object.freeze(["red"]),
  terminal: Object.freeze(["advanced", "blocked", "failed"]),
});

const SECRET_PATTERNS = [
  /lin_api_[A-Za-z0-9_-]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
  /([a-z][a-z0-9+.-]*:\/\/[^\s/:]+:)[^@\s]+@/gi,
];

function sanitizeLearningText(value, maxChars) {
  let text = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix) => prefix && match.includes("://") ? `${prefix}[REDACTED]@` : "[REDACTED]");
  }
  return text.trim().slice(0, maxChars);
}

function sanitizeMetrics(metrics) {
  if (metrics === undefined || metrics === null) return {};
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error("learning event metrics must be a JSON object");
  }
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(metrics).slice(0, MAX_LEARNING_EVENT_METRICS)) {
    const key = sanitizeLearningText(rawKey, 100);
    if (!key) continue;
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) out[key] = rawValue;
    else if (typeof rawValue === "boolean" || rawValue === null) out[key] = rawValue;
    else out[key] = sanitizeLearningText(typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue), MAX_LEARNING_EVENT_METRIC_STRING_CHARS);
  }
  return out;
}

function trustedLearningIdentity(env = {}) {
  const identity = {
    cardRunId: String(env.AUTO_SWEEP_CARD_RUN_ID || "").trim(),
    issueIdentifier: String(env.AUTO_SWEEP_ISSUE || "").trim(),
    sweep: String(env.AUTO_SWEEP_SWEEP || "").trim(),
    sourceAnchor: String(env.AUTO_SWEEP_SOURCE_ANCHOR || "").trim(),
  };
  if (Object.values(identity).some((value) => !value)) {
    throw new Error("trusted AUTO_SWEEP event identity is incomplete");
  }
  return identity;
}

function requireEventPair(kind, category) {
  if (!LEARNING_EVENT_TAXONOMY[kind]?.includes(category)) {
    throw new Error(`unknown learning event: ${kind || "missing"}/${category || "missing"}`);
  }
}

function learningEventId({ occurredAt, kind, category, summary, metrics, identity }) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ occurredAt, kind, category, summary, metrics, identity }))
    .digest("hex");
}

export function buildLearningEvent(input = {}, trustedEnv = {}, { now = () => new Date().toISOString() } = {}) {
  const kind = String(input.kind || "").trim();
  const category = String(input.category || "").trim();
  requireEventPair(kind, category);
  const summary = sanitizeLearningText(input.summary, MAX_LEARNING_EVENT_SUMMARY_CHARS);
  if (!summary) throw new Error("learning event summary is required");
  const occurredAt = now();
  if (Number.isNaN(Date.parse(occurredAt))) throw new Error("learning event timestamp must be ISO formatted");
  const identity = trustedLearningIdentity(trustedEnv);
  const metrics = sanitizeMetrics(input.metrics);
  const eventId = learningEventId({ occurredAt, kind, category, summary, metrics, identity });
  return { version: LEARNING_EVENT_VERSION, eventId, occurredAt, kind, category, summary, metrics, identity };
}

export function appendLearningEvent(eventPath, event, { appendFileFn = fs.appendFileSync, mkdirFn = fs.mkdirSync } = {}) {
  if (!eventPath) throw new Error("learning event path is required");
  requireEventPair(event?.kind, event?.category);
  mkdirFn(path.dirname(eventPath), { recursive: true });
  appendFileFn(eventPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  return event;
}

function sanitizeStoredEvent(event) {
  requireEventPair(event?.kind, event?.category);
  if (event.version !== LEARNING_EVENT_VERSION || !event.eventId || Number.isNaN(Date.parse(event.occurredAt)) || !event.identity) {
    throw new Error("invalid event shape");
  }
  const identity = Object.fromEntries(["cardRunId", "issueIdentifier", "sweep", "sourceAnchor"].map((key) => [
    key,
    sanitizeLearningText(event.identity[key], key === "sourceAnchor" ? 1_000 : 300),
  ]));
  if (Object.values(identity).some((value) => !value)) throw new Error("invalid event identity");
  const sanitized = {
    version: LEARNING_EVENT_VERSION,
    occurredAt: event.occurredAt,
    kind: event.kind,
    category: event.category,
    summary: sanitizeLearningText(event.summary, MAX_LEARNING_EVENT_SUMMARY_CHARS),
    metrics: sanitizeMetrics(event.metrics),
    identity,
  };
  return { ...sanitized, eventId: learningEventId(sanitized) };
}

export function readLearningEvents(eventPath, { maxBytes = 1024 * 1024, maxEvents = 1_000, expectedIdentity = null } = {}) {
  const result = { events: [], coverageGaps: [] };
  if (!eventPath || !fs.existsSync(eventPath)) return result;
  let text;
  try {
    const size = fs.statSync(eventPath).size;
    if (size > maxBytes) result.coverageGaps.push({ source: eventPath, reason: `event file exceeded ${maxBytes} bytes; oldest bytes omitted` });
    const fd = fs.openSync(eventPath, "r");
    try {
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, Math.max(0, size - length));
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    result.coverageGaps.push({ source: eventPath, reason: `unreadable event file: ${sanitizeLearningText(error?.message, 300)}` });
    return result;
  }
  const lines = text.split("\n").filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    try {
      const event = sanitizeStoredEvent(JSON.parse(lines[i]));
      if (expectedIdentity && Object.entries(expectedIdentity).some(([key, value]) => event.identity[key] !== value)) {
        result.coverageGaps.push({ source: eventPath, reason: `learning event identity mismatch on line ${i + 1}` });
        continue;
      }
      if (result.events.length < maxEvents) result.events.push(event);
      else if (!result.coverageGaps.some((gap) => gap.reason.includes("event count"))) {
        result.coverageGaps.push({ source: eventPath, reason: `event count exceeded ${maxEvents}; remainder omitted` });
      }
    } catch {
      result.coverageGaps.push({ source: eventPath, reason: `malformed learning event JSONL line ${i + 1}` });
    }
  }
  return result;
}

function inEvidenceWindow(timestamp, fromMs, capturedThroughMs) {
  const time = Date.parse(timestamp || "");
  return !Number.isNaN(time) && (fromMs === null || time > fromMs) && time <= capturedThroughMs;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactObject(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function normalizeSnapshotRun(record) {
  if (!record || typeof record !== "object" || Number.isNaN(Date.parse(record.endedAt || ""))) throw new Error("invalid run record");
  const outcome = record.outcome && typeof record.outcome === "object" ? compactObject([
    ["kind", sanitizeLearningText(record.outcome.kind, 100)],
    ["exitCode", finiteNumber(record.outcome.exitCode)],
    ["signal", sanitizeLearningText(record.outcome.signal, 50)],
    ["success", typeof record.outcome.success === "boolean" ? record.outcome.success : undefined],
  ]) : undefined;
  return compactObject([
    ["parentRunId", sanitizeLearningText(record.parentRunId, 300)],
    ["cardRunId", sanitizeLearningText(record.cardRunId, 300)],
    ["issueIdentifier", sanitizeLearningText(record.issueIdentifier, 100)],
    ["sourceWorkspace", sanitizeLearningText(record.sourceWorkspace, 1_000)],
    ["repoEntry", sanitizeLearningText(record.repoEntry, 300)],
    ["sweep", sanitizeLearningText(record.sweep, 50)],
    ["runtime", sanitizeLearningText(record.runtime, 100)],
    ["model", sanitizeLearningText(record.model, 200)],
    ["effort", sanitizeLearningText(record.effort, 50)],
    ["trigger", sanitizeLearningText(record.trigger, 100)],
    ["queueWaitMs", finiteNumber(record.queueWaitMs)],
    ["capacityHighWater", finiteNumber(record.capacityHighWater)],
    ["dependencyDeferredCount", finiteNumber(record.dependencyDeferredCount)],
    ["exitCode", finiteNumber(record.exitCode)],
    ["outcome", outcome],
    ["startedAt", Number.isNaN(Date.parse(record.startedAt || "")) ? undefined : record.startedAt],
    ["endedAt", record.endedAt],
  ]);
}

function normalizeSnapshotObservation(observation) {
  if (!observation || typeof observation !== "object") throw new Error("invalid observation");
  const at = observation.at || observation.observedAt;
  if (Number.isNaN(Date.parse(at || ""))) throw new Error("invalid observation timestamp");
  return compactObject([
    ["at", at],
    ["kind", sanitizeLearningText(observation.kind, 100)],
    ["sourceWorkspace", sanitizeLearningText(observation.sourceWorkspace, 1_000)],
    ["issueIdentifier", sanitizeLearningText(observation.issueIdentifier, 100)],
    ["stage", sanitizeLearningText(observation.stage, 50)],
    ["sweep", sanitizeLearningText(observation.sweep, 50)],
    ["reason", sanitizeLearningText(observation.reason, 500)],
    ["summary", sanitizeLearningText(observation.summary, MAX_LEARNING_EVENT_SUMMARY_CHARS)],
    ["waitMs", finiteNumber(observation.waitMs)],
    ["queueWaitMs", finiteNumber(observation.queueWaitMs)],
    ["durationMs", finiteNumber(observation.durationMs)],
    ["count", finiteNumber(observation.count)],
    ["metrics", observation.metrics === undefined ? undefined : sanitizeMetrics(observation.metrics)],
  ]);
}

function boundedLimit(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, fallback) : fallback;
}

export function buildLearningEvidenceSnapshot({
  from = null,
  capturedThrough,
  runRecords = [],
  events = [],
  observations = [],
  coverageGaps = [],
  limits = {},
} = {}) {
  const capturedThroughMs = Date.parse(capturedThrough || "");
  const fromMs = from === null ? null : Date.parse(from);
  if (Number.isNaN(capturedThroughMs) || (fromMs !== null && Number.isNaN(fromMs))) {
    throw new Error("learning evidence window requires valid ISO timestamps");
  }
  const bounded = {
    runRecords: boundedLimit(limits.runRecords, MAX_LEARNING_SNAPSHOT_RUNS),
    events: boundedLimit(limits.events, MAX_LEARNING_SNAPSHOT_EVENTS),
    observations: boundedLimit(limits.observations, MAX_LEARNING_SNAPSHOT_OBSERVATIONS),
  };
  const gaps = [];
  const gapKeys = new Set();
  const pushGap = (source, reason) => {
    const gap = { source: sanitizeLearningText(source || "unknown", 500), reason: sanitizeLearningText(reason || "unspecified coverage gap", 500) };
    const key = `${gap.source}\0${gap.reason}`;
    if (gapKeys.has(key) || gaps.length >= 100) return;
    gapKeys.add(key);
    gaps.push(gap);
  };
  for (const gap of coverageGaps.slice(0, 100)) pushGap(gap?.source, gap?.reason);
  if (coverageGaps.length > 100) pushGap("snapshot", "coverage gaps truncated at 100");
  const selectedRuns = [];
  const selectedRawRuns = [];
  const runInspectionLimit = Math.max(4, bounded.runRecords * 4);
  let inspectedRuns = 0;
  for (const record of Array.isArray(runRecords) ? runRecords : []) {
    if (inspectedRuns >= runInspectionLimit) {
      pushGap("runRecords", `run record inspection truncated at ${runInspectionLimit}`);
      break;
    }
    inspectedRuns += 1;
    if (!inEvidenceWindow(record?.endedAt, fromMs, capturedThroughMs)) continue;
    if (selectedRuns.length >= bounded.runRecords) {
      pushGap("runRecords", `run records truncated at ${bounded.runRecords}`);
      continue;
    }
    try {
      selectedRuns.push(normalizeSnapshotRun(record));
      selectedRawRuns.push(record);
    } catch {
      pushGap("runRecords", "malformed run record omitted");
    }
  }
  const eventById = new Map();
  const eventInspectionLimit = Math.max(4, bounded.events * 4);
  let inspectedEvents = 0;
  const addEvent = (candidate) => {
    if (inspectedEvents >= eventInspectionLimit) {
      pushGap("events", `event inspection truncated at ${eventInspectionLimit}`);
      return false;
    }
    inspectedEvents += 1;
    if (!inEvidenceWindow(candidate?.occurredAt, fromMs, capturedThroughMs)) return true;
    try {
      const event = sanitizeStoredEvent(candidate);
      if (eventById.has(event.eventId)) return true;
      if (eventById.size >= bounded.events) {
        pushGap("events", `events truncated at ${bounded.events}`);
        return true;
      }
      eventById.set(event.eventId, event);
    } catch {
      pushGap("events", "malformed learning event omitted");
    }
    return true;
  };
  for (const event of Array.isArray(events) ? events : []) if (!addEvent(event)) break;
  for (const record of selectedRawRuns) {
    for (const event of Array.isArray(record.learningEvents) ? record.learningEvents : []) if (!addEvent(event)) break;
    if (inspectedEvents >= eventInspectionLimit) break;
  }
  const selectedObservations = [];
  const observationInspectionLimit = Math.max(4, bounded.observations * 4);
  let inspectedObservations = 0;
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (inspectedObservations >= observationInspectionLimit) {
      pushGap("observations", `observation inspection truncated at ${observationInspectionLimit}`);
      break;
    }
    inspectedObservations += 1;
    if (!inEvidenceWindow(observation?.at || observation?.observedAt, fromMs, capturedThroughMs)) continue;
    if (selectedObservations.length >= bounded.observations) {
      pushGap("observations", `observations truncated at ${bounded.observations}`);
      continue;
    }
    try { selectedObservations.push(normalizeSnapshotObservation(observation)); }
    catch { pushGap("observations", "malformed observation omitted"); }
  }
  return {
    from,
    capturedThrough,
    runRecords: clone(selectedRuns),
    events: clone([...eventById.values()]),
    observations: clone(selectedObservations),
    coverage: {
      complete: gaps.length === 0,
      gaps,
      counts: { runRecords: selectedRuns.length, events: eventById.size, observations: selectedObservations.length },
    },
  };
}

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
  try {
    return realpathFn(anchorPath || ".");
  } catch (error) {
    if (error?.code === "ENOENT") return resolveFn(anchorPath || ".");
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

  const persistCandidate = (candidate) => {
    writeJsonFn(statePath, clone(candidate));
    state = candidate;
  };

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
      const existing = state.lenses[lens].pending;
      if (existing) {
        const existingMutations = Object.fromEntries(Object.entries(existing.mutations || {}).map(([id, mutation]) => [id, {
          ...clone(mutation),
          status: "pending",
          confirmedAt: undefined,
        }]));
        const sameWindow = existing.from === from
          && existing.capturedThrough === capturedThrough
          && JSON.stringify(existingMutations) === JSON.stringify(mutationMap);
        if (sameWindow) return clone(existing);
        throw new Error(`pending learning window already exists for ${lens}`);
      }
      const candidate = clone(state);
      candidate.lenses[lens].pending = {
        from,
        capturedThrough,
        stagedAt: now(),
        mutations: mutationMap,
      };
      persistCandidate(candidate);
      return clone(candidate.lenses[lens].pending);
    },

    confirmMutation(lens, mutationId) {
      requireLens(lens);
      const pending = state.lenses[lens].pending;
      const mutation = pending?.mutations?.[mutationId];
      if (!mutation) throw new Error(`unknown learning mutation: ${mutationId}`);
      const candidate = clone(state);
      const candidateMutation = candidate.lenses[lens].pending.mutations[mutationId];
      candidateMutation.status = "confirmed";
      candidateMutation.confirmedAt = now();
      persistCandidate(candidate);
      return clone(candidateMutation);
    },

    commitLens(lens) {
      requireLens(lens);
      const pending = state.lenses[lens].pending;
      if (!pending) return false;
      if (Object.values(pending.mutations || {}).some((mutation) => mutation.status !== "confirmed")) return false;
      const candidate = clone(state);
      candidate.lenses[lens].lastSuccessfulCapturedThrough = pending.capturedThrough;
      candidate.lenses[lens].pending = null;
      persistCandidate(candidate);
      return true;
    },
  };
}

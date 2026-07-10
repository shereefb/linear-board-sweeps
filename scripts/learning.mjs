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
  const at = observation.occurredAt || observation.at || observation.observedAt;
  if (Number.isNaN(Date.parse(at || ""))) throw new Error("invalid observation timestamp");
  return compactObject([
    ["at", at],
    ["occurredAt", at],
    ["evidenceId", sanitizeLearningText(observation.evidenceId, 300)],
    ["signal", sanitizeLearningText(observation.signal, 100)],
    ["kind", sanitizeLearningText(observation.kind, 100)],
    ["sourceWorkspace", sanitizeLearningText(observation.sourceWorkspace, 1_000)],
    ["projectId", sanitizeLearningText(observation.projectId, 300)],
    ["repoEntry", sanitizeLearningText(observation.repoEntry, 500)],
    ["issueIdentifier", sanitizeLearningText(observation.issueIdentifier, 100)],
    ["cardId", sanitizeLearningText(observation.cardId, 100)],
    ["runId", sanitizeLearningText(observation.runId, 300)],
    ["fingerprint", sanitizeLearningText(observation.fingerprint, 300)],
    ["rootCauseKey", sanitizeLearningText(observation.rootCauseKey, 300)],
    ["stage", sanitizeLearningText(observation.stage, 50)],
    ["sweep", sanitizeLearningText(observation.sweep, 50)],
    ["subsystem", sanitizeLearningText(observation.subsystem, 100)],
    ["category", sanitizeLearningText(observation.category, 100)],
    ["relatedKey", sanitizeLearningText(observation.relatedKey, 300)],
    ["window", sanitizeLearningText(observation.window, 100)],
    ["riskClass", sanitizeLearningText(observation.riskClass, 100)],
    ["recoveryState", sanitizeLearningText(observation.recoveryState, 100)],
    ["result", sanitizeLearningText(observation.result, 100)],
    ["reason", sanitizeLearningText(observation.reason, 500)],
    ["summary", sanitizeLearningText(observation.summary, MAX_LEARNING_EVENT_SUMMARY_CHARS)],
    ["references", Array.isArray(observation.references) ? observation.references.slice(0, 50).map((value) => sanitizeLearningText(value, 500)) : undefined],
    ["proven", typeof observation.proven === "boolean" ? observation.proven : undefined],
    ["machineCorrectable", typeof observation.machineCorrectable === "boolean" ? observation.machineCorrectable : undefined],
    ["seriousMissingGate", typeof observation.seriousMissingGate === "boolean" ? observation.seriousMissingGate : undefined],
    ["success", typeof observation.success === "boolean" ? observation.success : undefined],
    ["productive", typeof observation.productive === "boolean" ? observation.productive : undefined],
    ["deferred", typeof observation.deferred === "boolean" ? observation.deferred : undefined],
    ["safetyFloorSatisfied", typeof observation.safetyFloorSatisfied === "boolean" ? observation.safetyFloorSatisfied : undefined],
    ["baselineRate", finiteNumber(observation.baselineRate)],
    ["findingCount", finiteNumber(observation.findingCount)],
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
  if (inspectedEvents >= eventInspectionLimit && selectedRawRuns.some((record) => Array.isArray(record.learningEvents) && record.learningEvents.length > 0)) {
    pushGap("events", `event inspection truncated at ${eventInspectionLimit}`);
  }
  for (const record of selectedRawRuns) {
    for (const event of Array.isArray(record.learningEvents) ? record.learningEvents : []) if (!addEvent(event)) break;
    if (inspectedEvents >= eventInspectionLimit) {
      pushGap("events", `event inspection truncated at ${eventInspectionLimit}`);
      break;
    }
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
    if (!inEvidenceWindow(observation?.occurredAt || observation?.at || observation?.observedAt, fromMs, capturedThroughMs)) continue;
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

export function readLearningRunIndex(runsDir, {
  from = null,
  capturedThrough = new Date().toISOString(),
  maxBytes = 5 * 1024 * 1024,
  maxRecords = MAX_LEARNING_SNAPSHOT_RUNS,
} = {}) {
  const records = [];
  const gaps = [];
  let bytes = 0;
  const files = (fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [])
    .filter((name) => /^\d{8}\.jsonl$/.test(name))
    .sort()
    .slice(-LOGICAL_INDEX_RETENTION_DAYS);
  outer: for (const name of files) {
    const target = path.join(runsDir, name);
    let text;
    try {
      const size = fs.statSync(target).size;
      if (bytes + size > maxBytes) {
        gaps.push({ source: target, reason: `run index bytes truncated at ${maxBytes}` });
        break;
      }
      text = fs.readFileSync(target, "utf8");
      bytes += size;
    } catch {
      gaps.push({ source: target, reason: "run index unreadable" });
      continue;
    }
    for (const [index, line] of text.split("\n").entries()) {
      if (!line) continue;
      if (records.length >= maxRecords) {
        gaps.push({ source: runsDir, reason: `run records truncated at ${maxRecords}` });
        break outer;
      }
      try { records.push(JSON.parse(line)); }
      catch { gaps.push({ source: target, reason: `malformed run index JSONL line ${index + 1}` }); }
    }
  }
  const snapshot = buildLearningEvidenceSnapshot({ from, capturedThrough, runRecords: records, coverageGaps: gaps });
  return { snapshot, filesRead: files.length, bytesRead: bytes };
}

const LOGICAL_INDEX_RETENTION_DAYS = 14;

function elapsedMs(last, nowMs) {
  const parsed = Date.parse(last || "");
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - parsed);
}

export function learningDueDecisions({ state = emptyLearningState(), snapshot = {}, workspaces = [], now = new Date().toISOString() } = {}) {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new Error("learning due check requires an ISO now timestamp");
  const enabled = Object.fromEntries(LEARNING_LENSES.map((lens) => [lens, workspaces.length === 0 || workspaces.some((workspace) => {
    const learning = workspace.learning || workspace.config?.learning || {};
    const lenses = learning.lenses || {};
    const value = lenses[lens];
    return learning.enabled !== false && (value === true || value?.enabled === true);
  })]));
  const events = snapshot.events || [];
  const observations = snapshot.observations || [];
  const runRecords = snapshot.runRecords || [];
  const lensDecisions = LEARNING_LENSES.map((lens) => {
    const lensState = state.lenses?.[lens] || emptyLensState();
    if (!enabled[lens]) return { lens, due: false, reason: "disabled", sampleCount: 0 };
    if (lensState.pending) return { lens, due: true, reason: "pending-window", sampleCount: Object.keys(lensState.pending.mutations || {}).length };
    const since = Date.parse(lensState.lastSuccessfulCapturedThrough || "");
    const afterCursor = (timestamp) => Number.isNaN(since) || Date.parse(timestamp || "") > since;
    if (lens === "reliability") {
      const evidence = [
        ...events.filter((event) => afterCursor(event.occurredAt) && (event.kind === "canary" || (event.kind === "terminal" && event.category === "failed"))),
        ...observations.filter((item) => afterCursor(item.occurredAt || item.at) && ["dispatch-failure", "stale-claim", "failure-recovery", "safety-invariant", "poison-card"].includes(item.signal)),
      ];
      const due = evidence.length > 0 && elapsedMs(lensState.lastSuccessfulCapturedThrough, nowMs) >= 24 * 3600000;
      return { lens, due, reason: due ? "cadence-and-evidence" : evidence.length ? "cadence" : "no-new-evidence", sampleCount: evidence.length };
    }
    if (lens === "quality") {
      const evidence = [
        ...events.filter((event) => afterCursor(event.occurredAt) && (["review", "qa", "question", "bounce"].includes(event.kind) || event.kind === "terminal")),
        ...observations.filter((item) => afterCursor(item.occurredAt || item.at) && ["review-finding", "qa-result", "spec-bounce", "human-question", "red-canary"].includes(item.signal)),
      ];
      const distinctCards = new Set(evidence.map((item) => item.cardId || item.identity?.issueIdentifier || item.issueIdentifier).filter(Boolean)).size;
      const sampleCount = distinctCards || evidence.length;
      const due = sampleCount >= 5 || (evidence.length > 0 && elapsedMs(lensState.lastSuccessfulCapturedThrough, nowMs) >= 7 * 86400000);
      return { lens, due, reason: due ? sampleCount >= 5 ? "volume-threshold" : "cadence-and-evidence" : evidence.length ? "cadence" : "no-new-evidence", sampleCount };
    }
    const evidence = runRecords.filter((record) => afterCursor(record.endedAt));
    const due = evidence.length >= 20 && elapsedMs(lensState.lastSuccessfulCapturedThrough, nowMs) >= 7 * 86400000;
    return { lens, due, reason: due ? "sample-floor-and-cadence" : evidence.length ? "sample-or-cadence" : "no-new-evidence", sampleCount: evidence.length };
  });
  const evaluationDue = Object.entries(state.evaluations || {}).filter(([, evaluation]) => evaluation?.status === "active" && Date.parse(evaluation.windowEndsAt || evaluation.evaluateAfter || "") <= nowMs)
    .map(([rootFingerprint]) => rootFingerprint);
  const lenses = Object.fromEntries(lensDecisions.map((item) => [item.lens, item]));
  const due = lensDecisions.some((item) => item.due) || evaluationDue.length > 0;
  return { capturedThrough: snapshot.capturedThrough || now, lenses, evaluations: { due: evaluationDue }, due, anyDue: due };
}

const detectorDefinitions = [
  ["repeated-dispatch-failure", "reliability", "dispatch-failure", 2, "runId"],
  ["stale-claim-pattern", "reliability", "stale-claim", 2, "runId"],
  ["failed-recovery", "reliability", "failure-recovery", 2, "runId"],
  ["safety-invariant-violation", "reliability", "safety-invariant", 1, "evidenceId"],
  ["poison-card-cluster", "reliability", "poison-card", 2, "cardId"],
  ["repeated-review-finding", "quality", "review-finding", 3, "cardId"],
  ["qa-rework-regression", "quality", "qa-result", 8, "cardId"],
  ["spec-quality-failure", "quality", "spec-bounce", 2, "cardId"],
  ["recurring-human-question", "quality", "human-question", 3, "cardId"],
  ["red-canary-pattern", "quality", "red-canary", 2, "runId"],
  ["queue-delay-regression", "throughput", "queue-run", 20, "runId"],
  ["stage-duration-regression", "throughput", "stage-run", 20, "runId"],
  ["nonproductive-run", "throughput", "productive-run", 20, "runId"],
  ["capacity-saturation", "throughput", "capacity-run", 20, "runId"],
  ["review-overprocessing", "throughput", "review-run", 20, "runId"],
];

function detectorQualifies(id, observations, config = {}) {
  const thresholds = config.thresholds || {};
  if (id === "repeated-dispatch-failure") {
    const cutoff24h = Date.parse(observations.at(-1)?.occurredAt || "") - 24 * 3600000;
    return observations.filter((item) => Date.parse(item.occurredAt) >= cutoff24h).length >= 2 || observations.length >= 3;
  }
  if (id === "failed-recovery") {
    const ordered = [...observations].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    let recoveredAt = null;
    for (const item of ordered) {
      if (item.recoveryState === "recovered") recoveredAt = Date.parse(item.occurredAt);
      if (item.recoveryState === "recurred" && recoveredAt !== null && Date.parse(item.occurredAt) > recoveredAt) return true;
      if (item.recoveryState === "open-after-healthy") return true;
    }
    return false;
  }
  if (id === "safety-invariant-violation") return observations.some((item) => item.proven === true);
  if (id === "poison-card-cluster") return observations.filter((item) => item.machineCorrectable === true).length >= 2;
  if (id === "qa-rework-regression") {
    const needsChanges = observations.filter((item) => item.result === "needs-changes").length;
    const currentRate = observations.length ? needsChanges / observations.length : 0;
    const baselineRate = Number(observations.find((item) => Number.isFinite(item.baselineRate))?.baselineRate || 0);
    return observations.length >= 8 && currentRate - baselineRate >= Number(thresholds.qaReworkAbsoluteDelta ?? 0.15);
  }
  if (id === "red-canary-pattern") return observations.some((item) => item.seriousMissingGate === true) || observations.length >= 2;
  if (id === "queue-delay-regression") {
    const byWindow = groupBy(observations.filter((item) => item.window), (item) => item.window);
    const windows = [...byWindow.keys()].sort().slice(-2);
    return observations.length >= 20 && windows.length === 2 && consecutiveWindows(windows[0], windows[1]) && windows.every((window) => {
      const group = byWindow.get(window);
      const value = percentile(group.map((item) => Number(item.metrics?.waitMs)), 0.9);
      const baseline = percentile(group.map((item) => Number(item.metrics?.baselineP90Ms)), 0.9);
      return value >= Number(thresholds.queueDelayFloorMs ?? 60_000) && baseline > 0 && value / baseline >= Number(thresholds.relativeRegression ?? 1.25);
    });
  }
  if (id === "stage-duration-regression") return observations.length >= 20 && (() => {
    const value = percentile(observations.map((item) => Number(item.metrics?.durationMs)), 0.9);
    const baseline = percentile(observations.map((item) => Number(item.metrics?.baselineP90Ms)), 0.9);
    return value >= Number(thresholds.stageDurationFloorMs ?? 300_000) && baseline > 0 && value / baseline >= Number(thresholds.relativeRegression ?? 1.25);
  })();
  if (id === "nonproductive-run") {
    const current = observations.filter((item) => item.success === true && item.productive === false).length / observations.length;
    const baseline = Number(observations.find((item) => Number.isFinite(item.baselineRate))?.baselineRate || 0);
    return observations.length >= 20 && current >= Number(thresholds.nonproductiveRateFloor ?? 0.1) && (baseline === 0 ? current > 0 : current / baseline >= Number(thresholds.relativeRegression ?? 1.25));
  }
  if (id === "capacity-saturation") {
    const current = observations.filter((item) => item.deferred === true).length / observations.length;
    const baselineRate = Number(observations.find((item) => Number.isFinite(item.baselineRate))?.baselineRate || 0);
    const delay = percentile(observations.map((item) => Number(item.metrics?.waitMs)), 0.9);
    const delayBaseline = percentile(observations.map((item) => Number(item.metrics?.baselineP90Ms)), 0.9);
    return observations.length >= 20
      && current >= Number(thresholds.capacityDeferralRate ?? 0.2)
      && (baselineRate === 0 ? current > 0 : current / baselineRate >= Number(thresholds.relativeRegression ?? 1.25))
      && delay >= Number(thresholds.queueDelayFloorMs ?? 60_000)
      && delayBaseline > 0
      && delay / delayBaseline >= Number(thresholds.relativeRegression ?? 1.25);
  }
  if (id === "review-overprocessing") {
    const relevant = observations.filter((item) => item.riskClass === "low" && item.safetyFloorSatisfied === true);
    const costly = relevant.filter((item) => item.findingCount === 0);
    const duration = percentile(costly.map((item) => Number(item.metrics?.reviewDurationMs)), 0.9);
    const baseline = percentile(costly.map((item) => Number(item.metrics?.baselineReviewDurationMs)), 0.9);
    return observations.length >= 20 && costly.length / observations.length >= Number(thresholds.reviewOverprocessingRateFloor ?? 0.5)
      && duration >= Number(thresholds.reviewCostFloorMs ?? 300_000) && baseline > 0 && duration / baseline >= Number(thresholds.relativeRegression ?? 1.25);
  }
  return true;
}

function consecutiveWindows(left, right) {
  const parse = (value) => {
    const week = String(value).match(/^(\d{4})-W(\d{1,2})$/i);
    if (week) return Number(week[1]) * 53 + Number(week[2]);
    const trailing = String(value).match(/(\d+)$/);
    return trailing ? Number(trailing[1]) : null;
  };
  const a = parse(left);
  const b = parse(right);
  return a !== null && b !== null && b - a === 1;
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

export const LEARNING_DETECTORS = Object.freeze(detectorDefinitions.map(([id, lens, signal, minimumSample, distinctBy]) => Object.freeze({
  id,
  version: "v1",
  lens,
  signal,
  minimumSample,
  distinctBy,
  qualify: (observations, config) => detectorQualifies(id, observations, config),
  fingerprintParts: (observations) => [...new Set(observations.map((item) => item.rootCauseKey || item.fingerprint || item.category || item.relatedKey || signal))].sort(),
  metric: Object.freeze({ name: lens === "throughput" ? "p90" : "occurrenceCount", direction: "decrease" }),
  evaluationWindow: Object.freeze({ durationDays: lens === "reliability" ? 7 : 14 }),
})));

const severityOrder = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });
const confidenceOrder = Object.freeze({ high: 3, medium: 2, low: 1 });

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function detectorEvidence(snapshot, detector) {
  return (snapshot?.observations || []).filter((item) => item?.signal === detector.signal);
}

function distinctEvidence(observations, key) {
  const seen = new Set();
  return observations.filter((item) => {
    const identity = item?.[key];
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function detectorWindowDays(detectorId) {
  if (detectorId === "repeated-dispatch-failure") return 7;
  if (["repeated-review-finding", "qa-rework-regression", "spec-quality-failure", "recurring-human-question", "red-canary-pattern"].includes(detectorId)) return 14;
  return detectorId.startsWith("queue-") || detectorId.includes("duration") || detectorId.includes("run") || detectorId.includes("capacity") || detectorId.includes("overprocessing") ? 14 : 7;
}

function detectorClusterKey(detector, item) {
  if (detector.id === "stale-claim-pattern") return [item.stage, item.subsystem].join("|");
  if (["repeated-review-finding", "spec-quality-failure", "recurring-human-question"].includes(detector.id)) return item.category || "unknown-category";
  if (detector.id === "red-canary-pattern") return item.relatedKey || item.rootCauseKey || item.fingerprint || "unrelated";
  if (detector.id === "qa-rework-regression") return [item.sourceWorkspace, item.repoEntry, item.stage].join("|");
  if (detector.id === "stage-duration-regression" || detector.id === "review-overprocessing") return item.riskClass || "unknown-risk";
  if (["queue-delay-regression", "nonproductive-run", "capacity-saturation"].includes(detector.id)) return [item.sourceWorkspace, item.stage].join("|");
  return item.fingerprint || item.rootCauseKey || item.reason || detector.signal;
}

function detectorFinding(detector, observations, snapshot, config) {
  const sourceWorkspaces = [...new Set(observations.map((item) => item.sourceWorkspace).filter(Boolean))].sort();
  const localProjects = [...new Set(observations.map((item) => item.projectId).filter(Boolean))];
  const localRepos = [...new Set(observations.map((item) => item.repoEntry).filter(Boolean))];
  const local = sourceWorkspaces.length === 1 && localProjects.length === 1 && localRepos.length === 1;
  const scope = local ? "workspace" : "core";
  const projectId = local ? localProjects[0] : config.coreProjectId;
  const repoEntry = local ? localRepos[0] : config.coreRepoEntry;
  const parts = detector.fingerprintParts(observations);
  const rootFingerprint = stableHash({ scope, source: local ? sourceWorkspaces[0] : "shared-core", parts });
  const detectorVersion = config.detectorVersions?.[detector.id] || detector.version;
  const occurrenceIds = [...new Set(observations.map((item) => item.evidenceId || item.eventId || item.runId || item.cardId).filter(Boolean))].sort();
  const timestamps = observations.map((item) => item.occurredAt).filter((value) => !Number.isNaN(Date.parse(value))).sort();
  const complete = snapshot?.coverage?.complete !== false;
  const severe = detector.id === "safety-invariant-violation" || observations.some((item) => item.seriousMissingGate === true);
  const baseConfidence = severe || detector.lens === "reliability" ? "high" : "medium";
  const confidence = complete ? baseConfidence : baseConfidence === "high" ? "medium" : "low";
  const category = observations.find((item) => item.category)?.category || detector.signal;
  const metricName = detector.lens === "throughput" ? detector.metric.name : `${detector.id}Rate`;
  return {
    schemaVersion: 1,
    detectorId: detector.id,
    detectorVersion,
    lenses: [detector.lens],
    scope,
    sourceWorkspaces,
    projectId,
    repoEntry,
    fingerprint: stableHash({ detectorId: detector.id, detectorVersion, rootFingerprint, occurrenceIds }),
    rootFingerprint,
    generation: 0,
    firstSeenAt: timestamps[0] || snapshot.from || snapshot.capturedThrough,
    lastSeenAt: timestamps.at(-1) || snapshot.capturedThrough,
    occurrenceIds,
    occurrences: observations.map((item) => ({ id: item.evidenceId || item.eventId || item.runId || item.cardId, occurredAt: item.occurredAt })).filter((item) => item.id && !Number.isNaN(Date.parse(item.occurredAt))).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)),
    occurrenceCount: occurrenceIds.length,
    trend: "recurrent",
    baseline: { value: observations.length, unit: detector.lens === "throughput" ? "runs" : "occurrences" },
    impact: `Repeated ${category} evidence affects factory ${detector.lens}.`,
    severity: severe ? "critical" : detector.lens === "throughput" ? "medium" : "high",
    confidence,
    coverage: { complete, gaps: clone(snapshot?.coverage?.gaps || []) },
    evidenceReferences: [...new Set(observations.flatMap((item) => item.references || []).filter(Boolean))].sort(),
    rootCauseHypothesis: `A shared ${category} factory condition may be causing the observed pattern.`,
    desiredOutcome: `Reduce repeated ${category} evidence without weakening safety gates.`,
    acceptanceMetric: { name: metricName, direction: "decrease", target: 0 },
    evaluationWindow: clone(detector.evaluationWindow),
    exclusions: ["Do not bypass review, QA, Signoff, or the human Ship gate."],
    actionable: Boolean(projectId && repoEntry),
  };
}

export function runLearningDetectors(snapshot = {}, config = {}) {
  const enabled = config.enabledDetectors ? new Set(config.enabledDetectors) : null;
  const findings = [];
  for (const detector of LEARNING_DETECTORS) {
    if (enabled && !enabled.has(detector.id)) continue;
    const capturedThroughMs = Date.parse(snapshot.capturedThrough || new Date().toISOString());
    const cutoff = capturedThroughMs - detectorWindowDays(detector.id) * 86400000;
    const windowed = detectorEvidence(snapshot, detector).filter((item) => {
      const time = Date.parse(item.occurredAt || item.at || "");
      return !Number.isNaN(time) && time > cutoff && time <= capturedThroughMs;
    });
    const clusters = groupBy(windowed, (item) => detectorClusterKey(detector, item));
    for (const cluster of clusters.values()) {
      let observations = distinctEvidence(cluster, detector.distinctBy);
      if (observations.length < detector.minimumSample) {
        if (!(detector.id === "red-canary-pattern" && observations.some((item) => item.seriousMissingGate === true))) continue;
      }
      observations = observations.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || String(a.evidenceId || "").localeCompare(String(b.evidenceId || "")));
      if (!detector.qualify(observations, config)) continue;
      findings.push(detectorFinding(detector, observations, snapshot, config));
    }
  }
  return findings.sort((a, b) => a.rootFingerprint.localeCompare(b.rootFingerprint) || a.detectorId.localeCompare(b.detectorId));
}

export function aggregateLearningFindings(findings = []) {
  const grouped = new Map();
  for (const finding of findings) {
    const key = [finding.rootFingerprint, finding.generation || 0, finding.scope, finding.projectId, finding.repoEntry].join("\0");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(finding);
  }
  return [...grouped.values()].map((group) => {
    const sorted = [...group].sort((a, b) => a.detectorId.localeCompare(b.detectorId));
    const base = clone(sorted[0]);
    base.lenses = [...new Set(sorted.flatMap((item) => item.lenses || []))].sort();
    base.occurrenceIds = [...new Set(sorted.flatMap((item) => item.occurrenceIds || []))].sort();
    base.occurrenceCount = base.occurrenceIds.length;
    base.occurrences = [...new Map(sorted.flatMap((item) => item.occurrences || []).map((item) => [item.id, clone(item)])).values()]
      .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || String(a.id).localeCompare(String(b.id)));
    base.evidenceReferences = [...new Set(sorted.flatMap((item) => item.evidenceReferences || []))].sort();
    base.sourceWorkspaces = [...new Set(sorted.flatMap((item) => item.sourceWorkspaces || []))].sort();
    base.detectorProvenance = [...new Set(sorted.map((item) => `${item.detectorId}/${item.detectorVersion}`))].sort();
    base.firstSeenAt = sorted.map((item) => item.firstSeenAt).sort()[0];
    base.lastSeenAt = sorted.map((item) => item.lastSeenAt).sort().at(-1);
    base.severity = sorted.map((item) => item.severity).sort((a, b) => (severityOrder[b] || 0) - (severityOrder[a] || 0))[0];
    base.confidence = sorted.map((item) => item.confidence).sort((a, b) => (confidenceOrder[b] || 0) - (confidenceOrder[a] || 0))[0];
    const coverageGaps = [...new Map(sorted.flatMap((item) => item.coverage?.gaps || []).map((gap) => [`${gap.source}\0${gap.reason}`, clone(gap)])).values()];
    base.coverage = { complete: sorted.every((item) => item.coverage?.complete !== false), gaps: coverageGaps };
    base.measurementContracts = sorted.map((item) => ({
      detector: `${item.detectorId}/${item.detectorVersion}`,
      baseline: clone(item.baseline),
      acceptanceMetric: clone(item.acceptanceMetric),
      evaluationWindow: clone(item.evaluationWindow),
      coverage: clone(item.coverage),
    }));
    base.contributingFindings = sorted.map((item) => ({ detectorId: item.detectorId, detectorVersion: item.detectorVersion, fingerprint: item.fingerprint }));
    return base;
  }).sort((a, b) => a.rootFingerprint.localeCompare(b.rootFingerprint) || a.scope.localeCompare(b.scope));
}

function rankFinding(a, b) {
  return (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0)
    || (confidenceOrder[b.confidence] || 0) - (confidenceOrder[a.confidence] || 0)
    || (b.sourceWorkspaces?.length || 0) - (a.sourceWorkspaces?.length || 0)
    || (b.occurrenceCount || 0) - (a.occurrenceCount || 0)
    || String(a.firstSeenAt || "").localeCompare(String(b.firstSeenAt || ""))
    || String(a.rootFingerprint || "").localeCompare(String(b.rootFingerprint || ""));
}

export function rankQualifiedFindings(findings = [], maxNewCards = MAX_NEW_LEARNING_CARDS_PER_RUN) {
  const qualified = [...findings].filter((item) => item.actionable !== false && ["medium", "high"].includes(item.confidence)).sort(rankFinding);
  const updates = qualified.filter((item) => item.existingCardId);
  const creates = qualified.filter((item) => !item.existingCardId);
  const createLimit = Math.min(MAX_NEW_LEARNING_CARDS_PER_RUN, Math.max(0, Math.floor(Number(maxNewCards)) || 0));
  const admittedCreates = creates.slice(0, createLimit);
  const admittedSet = new Set([...updates, ...admittedCreates]);
  return { admitted: [...updates, ...admittedCreates], deferred: findings.filter((item) => !admittedSet.has(item)) };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function renderFindingCard(finding) {
  const safe = (value, max = 1_000) => sanitizeLearningText(value, max);
  const marker = `[factory-learning root=${safe(finding.rootFingerprint, 128)} generation=${Math.max(0, Math.floor(Number(finding.generation)) || 0)}]`;
  const impact = safe(finding.impact);
  const references = (finding.evidenceReferences || []).slice(0, 100).map((value) => safe(value, 500));
  const provenance = (finding.detectorProvenance || [`${finding.detectorId}/${finding.detectorVersion}`]).slice(0, 50).map((value) => safe(value, 200)).join(", ");
  const mandatorySuffix = [
    `## Detector provenance\n${provenance}`,
    `## Measurement contracts\n${safe(stableJson(finding.measurementContracts || [{ detector: provenance, baseline: finding.baseline, acceptanceMetric: finding.acceptanceMetric, evaluationWindow: finding.evaluationWindow }]), 3_000)}`,
    marker,
  ].join("\n\n");
  const body = [
    `# Factory improvement: ${impact}`,
    "",
    `## Observed pattern\n${impact}`,
    `## Evidence window\n${safe(finding.firstSeenAt, 100)} through ${safe(finding.lastSeenAt, 100)}`,
    `## Affected workspaces\n${(finding.sourceWorkspaces || []).slice(0, 50).map((value) => safe(value, 500)).join("\n")}`,
    `## Occurrences\n${Math.max(0, Math.floor(Number(finding.occurrenceCount)) || 0)}: ${(finding.occurrenceIds || []).slice(0, 200).map((value) => safe(value, 300)).join(", ")}`,
    `## Evidence\n${references.join("\n")}`,
    `## Confidence\n${safe(finding.confidence, 20)}`,
    `## Severity\n${safe(finding.severity, 20)}`,
    `## Contributing lenses\n${(finding.lenses || []).slice(0, 10).map((value) => safe(value, 50)).join(", ")}`,
    `## Coverage\n${finding.coverage?.complete ? "complete" : `partial: ${(finding.coverage?.gaps || []).slice(0, 100).map((gap) => `${safe(gap.source, 300)}: ${safe(gap.reason, 500)}`).join("; ")}`}`,
    `## Root-cause hypothesis\n${safe(finding.rootCauseHypothesis, 2_000)}`,
    `## Desired outcome\n${safe(finding.desiredOutcome, 2_000)}`,
    `## Acceptance metric\n${safe(stableJson(finding.acceptanceMetric), 2_000)}`,
    `## Baseline\n${safe(stableJson(finding.baseline), 2_000)}`,
    `## Evaluation window\n${safe(stableJson(finding.evaluationWindow), 2_000)}`,
    `## Exclusions\n${(finding.exclusions || []).slice(0, 50).map((value) => safe(value, 500)).join("\n")}`,
  ].join("\n\n");
  const reserved = mandatorySuffix.length + 2;
  const boundedBody = sanitizeLearningText(body, Math.max(0, 20_000 - reserved));
  return `${boundedBody}\n\n${mandatorySuffix}`.slice(0, 20_000);
}

export function renderEvidenceDelta(finding, occurrenceIds = []) {
  const known = new Set(finding?.occurrenceIds || []);
  const fresh = [...new Set(occurrenceIds)].filter((id) => !known.has(id)).sort();
  return sanitizeLearningText(`[factory-learning evidence-delta root=${finding.rootFingerprint}]\nFresh occurrences: ${fresh.join(", ") || "none"}`, 5_000);
}

export function evaluateLearningOutcome(evaluation = {}, snapshot = {}) {
  const coverageComplete = snapshot?.coverage?.complete !== false;
  const capturedThroughMs = Date.parse(snapshot.capturedThrough || "");
  const windowEndsAtMs = Date.parse(evaluation.windowEndsAt || "");
  const windowReady = !Number.isNaN(capturedThroughMs) && !Number.isNaN(windowEndsAtMs) && capturedThroughMs >= windowEndsAtMs;
  const observations = (snapshot.observations || []).filter((item) => {
    const time = Date.parse(item.occurredAt || item.at || "");
    return time > Date.parse(evaluation.completedAt || "") && time <= windowEndsAtMs;
  }).sort((a, b) => Date.parse(a.occurredAt || a.at) - Date.parse(b.occurredAt || b.at));
  const values = observations.map((item) => Number(item.metrics?.[evaluation.metric])).filter(Number.isFinite);
  let status = windowReady ? "inconclusive-evidence" : "not-due";
  if (windowReady && coverageComplete && values.length) {
    const value = evaluation.aggregation === "p90" ? percentile(values, 0.9) : values.at(-1);
    const baseline = Number(evaluation.baseline);
    const change = Number(evaluation.minimumChange || 0);
    const improved = evaluation.expectedDirection === "increase" ? value - baseline >= change : baseline - value >= change;
    const regressed = evaluation.expectedDirection === "increase" ? value < baseline : value > baseline;
    status = improved ? "verified-improvement" : regressed ? "regression" : "no-measurable-change";
  }
  const recurrence = { action: "none", generation: evaluation.generation || 0, rootFingerprint: evaluation.rootFingerprint };
  if (["no-measurable-change", "regression"].includes(status) && evaluation.activeGeneration == null) {
    const prior = new Set(evaluation.priorEvidenceIds || []);
    const fresh = (snapshot.qualifiedFindings || []).find((finding) => finding.rootFingerprint === evaluation.rootFingerprint
      && (finding.occurrences || []).some((occurrence) => !prior.has(occurrence.id)
        && Date.parse(occurrence.occurredAt || "") > Date.parse(evaluation.completedAt || "")
        && Date.parse(occurrence.occurredAt || "") <= capturedThroughMs));
    if (fresh) {
      if ((evaluation.generation || 0) >= 3) Object.assign(recurrence, { action: "block-needs-user", generation: 3 });
      else Object.assign(recurrence, { action: "create", generation: (evaluation.generation || 0) + 1 });
    }
  }
  return { status, terminal: status !== "not-due", evaluatedAt: snapshot.capturedThrough, recurrence };
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

const MAX_STATUS_ENTRIES = 100;
const DEFAULT_KEY = 'system';
const STATE_PRIORITY = new Map([
  ['unknown', 0],
  ['compatible', 1],
  ['degraded', 2],
  ['error', 3],
  ['incompatible', 4],
]);

const statuses = new Map();

function nowIso() {
  return new Date().toISOString();
}

function emptyStatus(key, meta = {}) {
  return {
    key,
    ownerId: meta.ownerId ?? null,
    accountId: meta.accountId ?? null,
    username: meta.username ?? null,
    jobKey: meta.jobKey ?? null,
    mode: meta.mode ?? null,
    lifecycle: meta.lifecycle ?? 'idle',
    lastCheckAt: null,
    lastSuccessfulCheckAt: null,
    state: 'unknown',
    questCount: 0,
    excludedCount: 0,
    enrollmentBlockedUntil: null,
    supportedCount: 0,
    unknownEvents: [],
    schemaIssues: [],
    lastVerifiedProgressAt: null,
    lastVerifiedCompletionAt: null,
    lastVerifiedClaimAt: null,
    questListPath: null,
    lastError: null,
    updatedAt: nowIso(),
  };
}

function clone(status) {
  return {
    ...status,
    unknownEvents: [...status.unknownEvents],
    schemaIssues: [...status.schemaIssues],
  };
}

function prune() {
  if (statuses.size <= MAX_STATUS_ENTRIES) return;
  const entries = [...statuses.entries()]
    .filter(([, status]) => !['running', 'stopping'].includes(status.lifecycle))
    .sort(([, left], [, right]) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
  while (statuses.size > MAX_STATUS_ENTRIES && entries.length) {
    statuses.delete(entries.shift()[0]);
  }
}

function ensure(key = DEFAULT_KEY, meta = {}) {
  const normalizedKey = key || DEFAULT_KEY;
  const existing = statuses.get(normalizedKey);
  if (existing) {
    Object.assign(existing, {
      ownerId: meta.ownerId ?? existing.ownerId,
      accountId: meta.accountId ?? existing.accountId,
      username: meta.username ?? existing.username,
      jobKey: meta.jobKey ?? existing.jobKey,
      mode: meta.mode ?? existing.mode,
      lifecycle: meta.lifecycle ?? existing.lifecycle,
      updatedAt: nowIso(),
    });
    return existing;
  }
  const created = emptyStatus(normalizedKey, meta);
  statuses.set(normalizedKey, created);
  prune();
  return created;
}

function latestIso(values) {
  return values
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function selectQuestListPath(paths) {
  if (paths.length === 1) return paths[0];
  if (paths.length > 1) return 'multiple';
  return null;
}

function aggregate(items) {
  const activeItems = items.filter((item) => ['running', 'stopping'].includes(item.lifecycle));
  if (!activeItems.length) return emptyStatus('aggregate', { lifecycle: 'idle' });
  items = activeItems;
  const latestError = [...items]
    .filter((item) => item.lastError)
    .sort((left, right) => Date.parse(right.lastCheckAt) - Date.parse(left.lastCheckAt))[0];
  const selectedState = items.reduce((current, item) => (
    (STATE_PRIORITY.get(item.state) ?? 0) > (STATE_PRIORITY.get(current) ?? 0)
      ? item.state
      : current
  ), 'unknown');
  const paths = [...new Set(items.map((item) => item.questListPath).filter(Boolean))];
  return {
    key: 'aggregate',
    ownerId: null,
    accountId: null,
    username: null,
    jobKey: null,
    mode: null,
    lifecycle: items.some((item) => item.lifecycle === 'running') ? 'running' : 'idle',
    accountCount: new Set(items.map((item) => item.accountId).filter(Boolean)).size,
    lastCheckAt: latestIso(items.map((item) => item.lastCheckAt)),
    lastSuccessfulCheckAt: latestIso(items.map((item) => item.lastSuccessfulCheckAt)),
    state: selectedState,
    questCount: items.reduce((sum, item) => sum + item.questCount, 0),
    excludedCount: items.reduce((sum, item) => sum + item.excludedCount, 0),
    enrollmentBlockedUntil: latestIso(items.map((item) => item.enrollmentBlockedUntil)),
    supportedCount: items.reduce((sum, item) => sum + item.supportedCount, 0),
    unknownEvents: [...new Set(items.flatMap((item) => item.unknownEvents))],
    schemaIssues: [...new Set(items.flatMap((item) => item.schemaIssues))],
    lastVerifiedProgressAt: latestIso(items.map((item) => item.lastVerifiedProgressAt)),
    lastVerifiedCompletionAt: latestIso(items.map((item) => item.lastVerifiedCompletionAt)),
    lastVerifiedClaimAt: latestIso(items.map((item) => item.lastVerifiedClaimAt)),
    questListPath: selectQuestListPath(paths),
    lastError: latestError?.lastError ?? null,
    updatedAt: latestIso(items.map((item) => item.updatedAt)),
  };
}

export function setQuestStatusLifecycle(key, lifecycle, meta = {}) {
  const status = ensure(key, { ...meta, lifecycle });
  status.lifecycle = lifecycle;
  status.updatedAt = nowIso();
}

export function recordQuestAttempt(key, meta = {}) {
  const status = ensure(key, meta);
  status.lastCheckAt = nowIso();
  status.updatedAt = status.lastCheckAt;
}

export function recordQuestSuccess(key, values, meta = {}) {
  const status = ensure(key, meta);
  Object.assign(status, values, {
    lastCheckAt: values.lastCheckAt ?? nowIso(),
    lastSuccessfulCheckAt: values.lastSuccessfulCheckAt ?? nowIso(),
    lastError: null,
    updatedAt: nowIso(),
  });
}

export function recordQuestFailure(key, error, incompatible = false, meta = {}) {
  const status = ensure(key, meta);
  status.lastCheckAt = nowIso();
  status.state = incompatible ? 'incompatible' : 'error';
  status.lastError = error?.message ?? String(error);
  status.updatedAt = status.lastCheckAt;
}

export function recordQuestVerification(key, kind, meta = {}) {
  const status = ensure(key, meta);
  const field = {
    progress: 'lastVerifiedProgressAt',
    completion: 'lastVerifiedCompletionAt',
    claim: 'lastVerifiedClaimAt',
  }[kind];
  if (!field) throw new Error(`Unknown Quest verification kind: ${kind}`);
  status[field] = nowIso();
  status.updatedAt = status[field];
}

export function getQuestStatus(key = null) {
  if (key) return clone(statuses.get(key) ?? emptyStatus(key));
  return aggregate([...statuses.values()].map(clone));
}

export function listQuestStatuses({ ownerId = null } = {}) {
  return [...statuses.values()]
    .filter((status) => !ownerId || status.ownerId === ownerId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(clone);
}

export function clearQuestStatuses() {
  statuses.clear();
}

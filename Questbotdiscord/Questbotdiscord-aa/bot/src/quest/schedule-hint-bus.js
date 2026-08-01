const listeners = new Map();
const hintsByAccount = new Map();
const effectiveHints = new Map();
const URGENT_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_SCHEDULE_HINT_PRUNE_INTERVAL_MS = 60_000;
let lastGlobalPruneAt = 0;

function notifyListener(listener, hint) {
  try {
    listener(hint ? { ...hint } : null);
  } catch (error) {
    console.warn(`[QuestScheduler] schedule hint listener failed: ${error?.message ?? 'unknown error'}`);
  }
}

function timestamp(value) {
  const time = value == null ? Number.NaN : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function sourceForHint(hint) {
  if (hint?.source) return String(hint.source);
  const prefix = String(hint?.reason ?? 'runner').split(':', 1)[0];
  return prefix || 'runner';
}

function sameHint(left, right) {
  return Boolean(
    left
    && right
    && left.nextActionAt === right.nextActionAt
    && left.reason === right.reason
    && Number(left.priority ?? 0) === Number(right.priority ?? 0)
    && (left.expiresAt ?? null) === (right.expiresAt ?? null)
    && left.source === right.source,
  );
}

function validHints(accountKey, now = Date.now()) {
  const hints = hintsByAccount.get(accountKey);
  if (!hints) return [];
  for (const [source, hint] of hints) {
    const expiresAt = timestamp(hint.expiresAt);
    if (expiresAt != null && expiresAt <= now) hints.delete(source);
  }
  if (hints.size === 0) hintsByAccount.delete(accountKey);
  return [...hints.values()].filter((hint) => timestamp(hint.nextActionAt) != null);
}

function compareUrgentHints(left, right) {
  return Number(right.priority ?? 0) - Number(left.priority ?? 0)
    || timestamp(left.nextActionAt) - timestamp(right.nextActionAt)
    || Number(right.publishedAtMs ?? 0) - Number(left.publishedAtMs ?? 0);
}

function compareNextHints(left, right) {
  return timestamp(left.nextActionAt) - timestamp(right.nextActionAt)
    || Number(right.priority ?? 0) - Number(left.priority ?? 0)
    || Number(right.publishedAtMs ?? 0) - Number(left.publishedAtMs ?? 0);
}

export function selectEffectiveScheduleHint(accountKey, now = Date.now()) {
  const hints = validHints(accountKey, now);
  if (!hints.length) return null;
  const urgent = hints
    .filter((hint) => timestamp(hint.nextActionAt) <= now + URGENT_WINDOW_MS)
    .toSorted(compareUrgentHints);
  const selected = urgent[0] ?? hints.toSorted(compareNextHints)[0];
  return selected ? { ...selected } : null;
}

function publishEffectiveChange(accountKey, previous, now = Date.now()) {
  const selected = selectEffectiveScheduleHint(accountKey, now);
  if (sameHint(previous, selected)) return false;
  if (selected) effectiveHints.set(accountKey, selected);
  else effectiveHints.delete(accountKey);
  for (const listener of listeners.get(accountKey) ?? []) notifyListener(listener, selected);
  return true;
}

export function pruneExpiredScheduleHints(now = Date.now(), { force = false } = {}) {
  if (
    !force
    && lastGlobalPruneAt > 0
    && now - lastGlobalPruneAt < DEFAULT_SCHEDULE_HINT_PRUNE_INTERVAL_MS
  ) {
    return { skipped: true, removedHints: 0, removedAccounts: 0 };
  }

  lastGlobalPruneAt = now;
  let removedHints = 0;
  let removedAccounts = 0;
  const accounts = new Set([...hintsByAccount.keys(), ...effectiveHints.keys()]);

  for (const accountKey of accounts) {
    const previous = effectiveHints.get(accountKey) ?? null;
    const hints = hintsByAccount.get(accountKey);
    const beforeSize = hints?.size ?? 0;
    validHints(accountKey, now);
    const afterSize = hintsByAccount.get(accountKey)?.size ?? 0;
    removedHints += Math.max(0, beforeSize - afterSize);
    if (beforeSize > 0 && afterSize === 0) removedAccounts++;
    publishEffectiveChange(accountKey, previous, now);
  }

  return { skipped: false, removedHints, removedAccounts };
}

export function publishScheduleHint(accountKey, hint) {
  const now = Date.now();
  pruneExpiredScheduleHints(now);
  if (!accountKey || !hint?.nextActionAt || timestamp(hint.nextActionAt) == null) return false;
  const expiresAt = timestamp(hint.expiresAt);
  if (expiresAt != null && expiresAt <= now) return false;
  const source = sourceForHint(hint);
  const normalized = {
    ...hint,
    source,
    priority: Number.isFinite(Number(hint.priority)) ? Number(hint.priority) : 0,
    publishedAtMs: now,
  };
  const previousEffective = effectiveHints.get(accountKey) ?? selectEffectiveScheduleHint(accountKey, now);
  if (!hintsByAccount.has(accountKey)) hintsByAccount.set(accountKey, new Map());
  const hints = hintsByAccount.get(accountKey);
  const previousSource = hints.get(source);
  if (sameHint(previousSource, normalized)) return false;
  hints.set(source, normalized);
  publishEffectiveChange(accountKey, previousEffective, now);
  return true;
}

export function clearScheduleHint(accountKey, source) {
  const hints = hintsByAccount.get(accountKey);
  if (!hints?.has(source)) return false;
  const previousEffective = effectiveHints.get(accountKey) ?? selectEffectiveScheduleHint(accountKey);
  hints.delete(source);
  if (hints.size === 0) hintsByAccount.delete(accountKey);
  publishEffectiveChange(accountKey, previousEffective);
  return true;
}

export function subscribeScheduleHints(accountKey, listener) {
  pruneExpiredScheduleHints();
  if (!listeners.has(accountKey)) listeners.set(accountKey, new Set());
  listeners.get(accountKey).add(listener);
  queueMicrotask(() => {
    if (!listeners.get(accountKey)?.has(listener)) return;
    const latest = selectEffectiveScheduleHint(accountKey);
    if (latest) notifyListener(listener, latest);
  });
  return () => {
    const accountListeners = listeners.get(accountKey);
    accountListeners?.delete(listener);
    if (accountListeners?.size === 0) listeners.delete(accountKey);
  };
}

export function getLatestScheduleHint(accountKey) {
  pruneExpiredScheduleHints();
  const hint = selectEffectiveScheduleHint(accountKey);
  return hint ? { ...hint } : null;
}

export function listScheduleHints(accountKey) {
  pruneExpiredScheduleHints();
  return validHints(accountKey).map((hint) => ({ ...hint }));
}

export function scheduleHintMemorySnapshot({ prune = true } = {}) {
  if (prune) pruneExpiredScheduleHints();
  return {
    listenerAccounts: listeners.size,
    hintAccounts: hintsByAccount.size,
    effectiveAccounts: effectiveHints.size,
    hints: [...hintsByAccount.values()].reduce((total, hints) => total + hints.size, 0),
    lastPruneAt: lastGlobalPruneAt || null,
  };
}

export function clearScheduleHintsForTests() {
  listeners.clear();
  hintsByAccount.clear();
  effectiveHints.clear();
  lastGlobalPruneAt = 0;
}

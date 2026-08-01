const DEFAULT_IDLE_INTERVAL_MS = 8 * 60 * 60 * 1000;
const MINIMUM_DELAY_MS = 5_000;
const DEADLINE_URGENCY_MS = 30 * 60 * 1000;

function timestamp(value) {
  const time = value == null ? Number.NaN : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function candidate(at, reason, priority, source = reason.split(':', 1)[0]) {
  return at == null ? null : { at, reason, priority, source };
}

function questCandidates(quest, now) {
  const items = [];
  const expiresAt = timestamp(quest.expiresAt);
  const startsAt = timestamp(quest.startsAt);
  const enrollmentBlockedUntil = timestamp(quest.enrollmentBlockedUntil);

  if (quest.completed && !quest.claimed) {
    items.push(candidate(now, `claim:${quest.id}`, 100, 'quest-list'));
  }
  if (
    !quest.completed
    && expiresAt != null
    && expiresAt > now
    && expiresAt - now <= DEADLINE_URGENCY_MS
  ) {
    items.push(candidate(now, `deadline:${quest.id}`, 95, 'quest-list'));
  }
  if (!quest.completed && startsAt != null && startsAt > now) {
    items.push(candidate(startsAt, `starts:${quest.id}`, 60, 'quest-list'));
  }
  if (!quest.enrolled && enrollmentBlockedUntil != null && enrollmentBlockedUntil > now) {
    items.push(candidate(enrollmentBlockedUntil, `enrollment:${quest.id}`, 70, 'quest-list'));
  }
  return items.filter(Boolean);
}

function addTimedCandidate(candidates, value, reason, priority, source = reason) {
  const at = timestamp(value);
  if (at != null) candidates.push(candidate(at, reason, priority, source));
}

function compareCandidatePriority(left, right) {
  return right.priority - left.priority || left.at - right.at;
}

function compareCandidateTime(left, right) {
  return left.at - right.at;
}

export function chooseNextQuestAction({
  quests = [],
  now = new Date(),
  rateLimitAt = null,
  circuitRetryAt = null,
  claimRetryAt = null,
  progressStallAt = null,
  retryAt = null,
  verificationAt = null,
  recoveryAt = null,
  fallbackAt = null,
} = {}) {
  const nowMs = now.getTime();
  const candidates = quests.flatMap((quest) => questCandidates(quest, nowMs));
  const fallback = timestamp(fallbackAt) ?? nowMs + DEFAULT_IDLE_INTERVAL_MS;

  addTimedCandidate(candidates, recoveryAt, 'recovery', 99, 'recovery');
  addTimedCandidate(candidates, rateLimitAt, 'rate-limit', 98, 'rate-limit');
  addTimedCandidate(candidates, claimRetryAt, 'claim-retry', 96, 'claim-retry');
  addTimedCandidate(candidates, circuitRetryAt, 'circuit-breaker', 92, 'circuit-breaker');
  addTimedCandidate(candidates, progressStallAt, 'progress-stall', 91, 'progress-stall');
  addTimedCandidate(candidates, verificationAt, 'verification', 90, 'verification');
  addTimedCandidate(candidates, retryAt, 'retry', 85, 'runner-retry');
  candidates.push(candidate(fallback, 'baseline', 10, 'baseline'));

  const normalized = candidates
    .filter(Boolean)
    .map((item) => ({
      ...item,
      at: Math.max(nowMs + MINIMUM_DELAY_MS, item.at),
    }))
    .toSorted(compareCandidatePriority);

  const urgent = normalized.find((item) => item.at <= nowMs + DEADLINE_URGENCY_MS);
  const selected = urgent ?? normalized.toSorted(compareCandidateTime)[0];
  return {
    nextActionAt: new Date(selected.at).toISOString(),
    reason: selected.reason,
    priority: selected.priority,
    source: selected.source,
  };
}

export function stateScheduleReason(state) {
  return {
    WAITING_RATE_LIMIT: 'rate-limit',
    WAITING_ENROLLMENT: 'enrollment',
    WAITING_RETRY: 'retry',
    WAITING_SCHEDULE: 'baseline',
    VERIFYING_ENROLLMENT: 'verification',
    VERIFYING_PROGRESS: 'verification',
    VERIFYING_COMPLETION: 'verification',
    VERIFYING_CLAIM: 'verification',
    RECOVERING: 'recovery',
  }[state] ?? 'runner';
}

import { defineQuestExecutor } from './contract.js';

const VIDEO_EVENTS = new Set(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);
const VIDEO_SUBMISSION_INTERVAL_SECS = 10;
const VIDEO_ALLOWANCE_WAIT_LIMIT = 120;
const VIDEO_UNCHANGED_CHECK_LIMIT = 8;

export function matchesVideoQuest(value) {
  const eventName = typeof value === 'string' ? value : value?.eventName;
  return VIDEO_EVENTS.has(eventName);
}

export function nextVideoTimestamp(current, target, enrolledAtMs, now = Date.now()) {
  const maxAllowed = Number.isFinite(enrolledAtMs)
    ? Math.floor((now - enrolledAtMs) / 1000) + VIDEO_SUBMISSION_INTERVAL_SECS
    : current + 1;
  return Math.min(
    target,
    current + VIDEO_SUBMISSION_INTERVAL_SECS,
    maxAllowed,
  );
}

function requireRuntime(context, name) {
  if (typeof context?.[name] !== 'function') {
    throw new TypeError(`Video executor requires context.${name}()`);
  }
  return context[name];
}

async function waitForTimestampAllowance(waitCount, context) {
  const nextWaitCount = waitCount + 1;
  if (nextWaitCount >= VIDEO_ALLOWANCE_WAIT_LIMIT) {
    throw new Error('รอ video timestamp allowance จาก Discord เกิน 2 นาที');
  }
  await requireRuntime(context, 'sleep')(1000, context.signal);
  return nextWaitCount;
}

function nextUnchangedChecks(fresh, current, unchangedChecks) {
  return fresh.progressSecs > current || fresh.completed
    ? 0
    : unchangedChecks + 1;
}

function assertProgress(unchangedChecks) {
  if (unchangedChecks >= VIDEO_UNCHANGED_CHECK_LIMIT) {
    throw new Error('Discord ไม่ยืนยัน video progress หลังตรวจ 8 ครั้ง');
  }
}

async function submitProgress(context, quest, timestamp) {
  const mutation = await requireRuntime(context, 'sendVideoProgress')(
    quest.id,
    timestamp,
    context.signal,
  );
  if (!mutation?.verifiedAfterFailure) context.onMutationAccepted?.();
  await requireRuntime(context, 'sleep')(1000, context.signal);
  const fresh = await requireRuntime(context, 'fetchFreshQuest')(quest.id, context.signal);
  await context.onServerProgress?.(fresh);
  return fresh;
}

export async function executeVideoQuest(context) {
  const quest = context.quest;
  let fresh = quest;
  let current = Number(fresh.progressSecs ?? 0);
  const target = Number(fresh.secondsNeeded ?? 0);
  const enrolledAtMs = Date.parse(fresh.enrolledAt);
  let unchangedChecks = 0;
  let allowanceWaits = 0;

  while (!fresh.completed && current < target) {
    if (context.signal?.aborted) throw new Error('aborted');
    const timestamp = nextVideoTimestamp(
      current,
      target,
      enrolledAtMs,
      context.now?.() ?? Date.now(),
    );
    if (timestamp <= current) {
      allowanceWaits = await waitForTimestampAllowance(allowanceWaits, context);
      continue;
    }

    allowanceWaits = 0;
    fresh = await submitProgress(context, quest, timestamp);
    unchangedChecks = nextUnchangedChecks(fresh, current, unchangedChecks);
    assertProgress(unchangedChecks);
    current = Math.max(current, Number(fresh.progressSecs ?? 0));

    if (!fresh.completed && current < target) {
      await requireRuntime(context, 'sleep')(
        (VIDEO_SUBMISSION_INTERVAL_SECS - 1) * 1000,
        context.signal,
      );
    }
  }
  return fresh;
}

export const videoQuestExecutor = defineQuestExecutor({
  id: 'video',
  supportsAutomaticProgress: true,
  mutation: 'video-progress',
  matches: matchesVideoQuest,
  validate(quest) {
    const issues = [];
    if (!quest?.id) issues.push('video Quest is missing id');
    if (!Number.isFinite(Number(quest?.secondsNeeded)) || Number(quest.secondsNeeded) <= 0) {
      issues.push('video Quest has an invalid target');
    }
    return { ok: issues.length === 0, issues };
  },
  estimateDuration(quest) {
    const remaining = Math.max(
      0,
      Number(quest?.secondsNeeded ?? 0) - Number(quest?.progressSecs ?? 0),
    );
    return remaining * 1000;
  },
  execute: executeVideoQuest,
  verify(_context, result) {
    return Boolean(result?.completed);
  },
  describeUnsupportedReason() {
    return null;
  },
});
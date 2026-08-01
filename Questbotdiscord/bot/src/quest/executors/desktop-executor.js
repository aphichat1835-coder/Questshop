import { defineQuestExecutor } from './contract.js';

const DESKTOP_EVENTS = new Set(['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']);
const DESKTOP_UNCHANGED_CHECK_LIMIT = 5;

export function matchesDesktopQuest(value) {
  const eventName = typeof value === 'string' ? value : value?.eventName;
  return DESKTOP_EVENTS.has(eventName);
}

function requireRuntime(context, name) {
  if (typeof context?.[name] !== 'function') {
    throw new TypeError(`Desktop executor requires context.${name}()`);
  }
  return context[name];
}

function nextProgressState(fresh, current, unchangedChecks, forceApplicationPayload) {
  if (fresh.progressSecs > current || fresh.completed) {
    return { unchangedChecks: 0, forceApplicationPayload };
  }
  return {
    unchangedChecks: unchangedChecks + 1,
    forceApplicationPayload: forceApplicationPayload || Boolean(fresh.applicationId),
  };
}

function assertProgress(unchangedChecks) {
  if (unchangedChecks >= DESKTOP_UNCHANGED_CHECK_LIMIT) {
    throw new Error('Discord ไม่ยืนยัน game progress หลัง heartbeat 5 ครั้ง');
  }
}

async function sendHeartbeatStep(context, quest, terminal, useApplicationPayload) {
  const mutation = await requireRuntime(context, 'sendHeartbeat')(
    quest,
    terminal,
    useApplicationPayload,
    context.signal,
  );
  if (!mutation?.verifiedAfterFailure) context.onMutationAccepted?.();
  await requireRuntime(context, 'sleep')(1000, context.signal);
  const fresh = await requireRuntime(context, 'fetchFreshQuest')(quest.id, context.signal);
  await context.onServerProgress?.(fresh);
  return fresh;
}

export async function executeDesktopQuest(context) {
  let fresh = context.quest;
  let current = Number(fresh.progressSecs ?? 0);
  const intervalSecs = Math.max(1, Number(context.heartbeatInterval) || 30);
  let unchangedChecks = 0;
  let forceApplicationPayload = false;

  while (!fresh.completed && current < Number(fresh.secondsNeeded ?? 0)) {
    if (context.signal?.aborted) throw new Error('aborted');
    fresh = await sendHeartbeatStep(
      context,
      fresh,
      false,
      forceApplicationPayload,
    );

    const progressState = nextProgressState(
      fresh,
      current,
      unchangedChecks,
      forceApplicationPayload,
    );
    unchangedChecks = progressState.unchangedChecks;
    forceApplicationPayload = progressState.forceApplicationPayload;
    assertProgress(unchangedChecks);
    current = Math.max(current, Number(fresh.progressSecs ?? 0));

    if (!fresh.completed && current < Number(fresh.secondsNeeded ?? 0)) {
      await requireRuntime(context, 'sleep')(
        Math.max(0, intervalSecs - 1) * 1000,
        context.signal,
      );
    }
  }

  if (fresh.completed) return fresh;
  return sendHeartbeatStep(
    context,
    fresh,
    true,
    forceApplicationPayload,
  );
}

export const desktopQuestExecutor = defineQuestExecutor({
  id: 'desktop',
  supportsAutomaticProgress: true,
  mutation: 'heartbeat',
  matches: matchesDesktopQuest,
  validate(quest) {
    const issues = [];
    if (!quest?.id) issues.push('desktop Quest is missing id');
    if (!Number.isFinite(Number(quest?.secondsNeeded)) || Number(quest.secondsNeeded) <= 0) {
      issues.push('desktop Quest has an invalid target');
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
  execute: executeDesktopQuest,
  verify(_context, result) {
    return Boolean(result?.completed);
  },
  describeUnsupportedReason() {
    return null;
  },
});
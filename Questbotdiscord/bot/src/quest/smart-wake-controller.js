import * as legacyRunner from '../discord-runner.js';
import { getScheduledRunner } from '../scheduled-runner-store.js';
import { authorizationFingerprint } from './authorization-fingerprint.js';
import { subscribeScheduleHints } from './schedule-hint-bus.js';
import {
  getRunnerState,
  RUNNER_MUTATION_KIND,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';

export const MAX_SMART_WAKE_TIMER_MS = 24 * 60 * 60 * 1000;

const SLEEPING_RUNNER_STATES = new Set([
  RUNNER_STATE.WAITING_SCHEDULE,
  RUNNER_STATE.WAITING_RETRY,
  RUNNER_STATE.WAITING_RATE_LIMIT,
  RUNNER_STATE.WAITING_ENROLLMENT,
]);

const smartWakeups = new Map();
const restartingJobs = new Set();
let restartRunner = null;
let readActiveJob = legacyRunner.getJob;
let stopActiveJob = legacyRunner.stopJob;
let readScheduledRunner = getScheduledRunner;

function hintState(rawReason) {
  const reason = String(rawReason ?? '');
  if (reason.startsWith('claim:')) return RUNNER_STATE.CLAIMING;
  if (reason === 'claim-retry') return RUNNER_STATE.WAITING_RETRY;
  if (reason.startsWith('enrollment:')) return RUNNER_STATE.WAITING_ENROLLMENT;
  if (reason === 'rate-limit') return RUNNER_STATE.WAITING_RATE_LIMIT;
  if (reason === 'retry' || reason === 'circuit-breaker') return RUNNER_STATE.WAITING_RETRY;
  if (reason === 'progress-stall') return RUNNER_STATE.VERIFYING_PROGRESS;
  if (reason === 'verification') return RUNNER_STATE.VERIFYING_COMPLETION;
  if (reason === 'recovery') return RUNNER_STATE.RECOVERING;
  return RUNNER_STATE.WAITING_SCHEDULE;
}

function runnerIsSleeping(jobKey, wasSleepingBeforeHint = false) {
  const state = getRunnerState(jobKey);
  if (SLEEPING_RUNNER_STATES.has(state?.state)) return true;
  if (String(state?.state_source ?? '').startsWith('schedule-hint:')) {
    return wasSleepingBeforeHint;
  }
  return false;
}

function durableClaimRetryAt(state) {
  const metadataAt = Date.parse(state?.metadata?.claimRetryAt);
  if (Number.isFinite(metadataAt)) return metadataAt;
  if (
    state?.state === RUNNER_STATE.WAITING_RETRY
    && state?.mutation_kind === RUNNER_MUTATION_KIND.CLAIM
  ) {
    const stateAt = Date.parse(state.next_action_at);
    return Number.isFinite(stateAt) ? stateAt : null;
  }
  return null;
}

function respectClaimCooldown(jobKey, hint, now = Date.now()) {
  if (!String(hint?.reason ?? '').startsWith('claim:')) return hint;
  const retryAt = durableClaimRetryAt(getRunnerState(jobKey));
  const hintedAt = Date.parse(hint.nextActionAt);
  if (!Number.isFinite(retryAt) || retryAt <= now || retryAt <= hintedAt) return hint;
  return {
    ...hint,
    nextActionAt: new Date(retryAt).toISOString(),
    reason: 'claim-retry',
    priority: 96,
    source: 'claim-retry',
  };
}

function recordWakeFailure(jobKey, error) {
  clearWakeTimer(jobKey);
  const current = getRunnerState(jobKey);
  if (!current) return;
  transitionRunnerState(jobKey, RUNNER_STATE.FAILED, {
    lastError: error?.message ?? String(error),
    metadata: { stage: 'smart-wakeup' },
    stateSource: 'smart-wakeup-failure',
  });
}

export function smartWakeTimerDelay(nextActionAt, now = Date.now()) {
  const at = Date.parse(nextActionAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(MAX_SMART_WAKE_TIMER_MS, at - now));
}

async function restartSleepingRunner(args, wasSleepingBeforeHint) {
  if (typeof restartRunner !== 'function') {
    throw new TypeError('Smart wake restart handler is not configured');
  }
  const active = readActiveJob(args.jobKey);
  if (!active || !runnerIsSleeping(args.jobKey, wasSleepingBeforeHint)) {
    clearWakeTimer(args.jobKey);
    return false;
  }
  if (!readScheduledRunner(args.scheduleId)) {
    clearSmartWake(args.jobKey);
    return false;
  }

  restartingJobs.add(args.jobKey);
  try {
    const completion = active.done;
    const stopped = stopActiveJob(args.ownerId, args.jobKey, { removeSchedule: false });
    if (!stopped) {
      clearWakeTimer(args.jobKey);
      return false;
    }

    transitionRunnerState(args.jobKey, RUNNER_STATE.RECOVERING, {
      nextActionAt: new Date().toISOString(),
      metadata: { reason: 'smart-wakeup' },
      stateSource: 'smart-wakeup',
    });
    await Promise.resolve(completion).catch(() => undefined);

    const replacement = readActiveJob(args.jobKey);
    if (replacement && replacement !== active) {
      clearWakeTimer(args.jobKey);
      return false;
    }
    if (!readScheduledRunner(args.scheduleId)) {
      clearSmartWake(args.jobKey);
      return false;
    }
    await restartRunner({ ...args, initialNextCheckAt: null });
    return true;
  } finally {
    restartingJobs.delete(args.jobKey);
  }
}

function clearWakeTimer(jobKey) {
  const entry = smartWakeups.get(jobKey);
  if (!entry) return false;
  if (entry.timer) clearTimeout(entry.timer);
  smartWakeups.set(jobKey, { ...entry, timer: null, hint: null });
  return true;
}

function installWakeTimer(args, hint, existing) {
  const delay = smartWakeTimerDelay(hint.nextActionAt);
  if (delay == null) return false;

  const timer = setTimeout(() => {
    const entry = smartWakeups.get(args.jobKey);
    if (!entry || entry.hint !== hint) return;
    entry.timer = null;

    const remaining = Date.parse(hint.nextActionAt) - Date.now();
    if (remaining > 0) {
      installWakeTimer(args, hint, entry);
      return;
    }

    void restartSleepingRunner(args, entry.wasSleepingBeforeHint)
      .catch((error) => recordWakeFailure(args.jobKey, error));
  }, delay);
  timer.unref?.();
  smartWakeups.set(args.jobKey, { ...existing, timer, args, hint });
  return true;
}

function scheduleSmartWake(args, incomingHint) {
  if (args.mode !== 'scheduled') return;
  const hint = respectClaimCooldown(args.jobKey, incomingHint);
  if (!hint || hint.reason === 'baseline') {
    clearWakeTimer(args.jobKey);
    return;
  }
  const at = Date.parse(hint.nextActionAt);
  if (!Number.isFinite(at)) {
    clearWakeTimer(args.jobKey);
    return;
  }

  const now = Date.now();
  const active = readActiveJob(args.jobKey);
  const currentNextAt = Date.parse(active?.summary?.().nextCheckAt);
  if (Number.isFinite(currentNextAt) && currentNextAt > now && currentNextAt <= at) {
    clearWakeTimer(args.jobKey);
    return;
  }

  const existing = smartWakeups.get(args.jobKey);
  const wasSleepingBeforeHint = runnerIsSleeping(
    args.jobKey,
    existing?.wasSleepingBeforeHint ?? false,
  ) || (Number.isFinite(currentNextAt) && currentNextAt > now);
  if (at <= now && active && !wasSleepingBeforeHint) {
    clearWakeTimer(args.jobKey);
    return;
  }

  if (existing?.timer) clearTimeout(existing.timer);
  if (!active || wasSleepingBeforeHint) {
    transitionRunnerState(args.jobKey, hintState(hint.reason), {
      nextActionAt: hint.nextActionAt,
      metadata: {
        ...getRunnerState(args.jobKey)?.metadata,
        reason: hint.reason,
        priority: hint.priority,
      },
      stateSource: `schedule-hint:${hint.source ?? 'runner'}`,
    });
  }
  installWakeTimer(args, hint, { ...existing, wasSleepingBeforeHint });
}

export function configureSmartWakeController(handler, {
  getJob = legacyRunner.getJob,
  stopJob = legacyRunner.stopJob,
  getScheduled = getScheduledRunner,
} = {}) {
  restartRunner = handler;
  readActiveJob = getJob;
  stopActiveJob = stopJob;
  readScheduledRunner = getScheduled;
}

export function registerSmartWake(args) {
  if (args.mode !== 'scheduled') return false;
  const existing = smartWakeups.get(args.jobKey);
  existing?.unsubscribe?.();
  const account = authorizationFingerprint(args.userToken);
  const unsubscribe = subscribeScheduleHints(account, (hint) => scheduleSmartWake(args, hint));
  smartWakeups.set(args.jobKey, { ...existing, args, unsubscribe });
  return true;
}

export function clearSmartWake(jobKey) {
  const entry = smartWakeups.get(jobKey);
  if (!entry) return false;
  clearWakeTimer(jobKey);
  entry.unsubscribe?.();
  smartWakeups.delete(jobKey);
  return true;
}

export function isSmartWakeRestarting(jobKey) {
  return restartingJobs.has(jobKey);
}

export function clearAllSmartWakes() {
  for (const jobKey of smartWakeups.keys()) clearSmartWake(jobKey);
}

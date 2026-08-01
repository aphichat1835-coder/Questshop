import { listJobs } from '../discord-runner.js';
import {
  beginRunnerState,
  getRunnerState,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';
import { resolveRunnerExecutionContext } from './runner-execution-context.js';
import { assertRunnerMutationOwnership } from './runner-ownership-guard.js';
import { stateScheduleReason } from './smart-scheduler.js';

const OBSERVER_INTERVAL_MS = 1000;
const PROGRESS_PATTERN = /\b(\d{1,3})%/;
const OBSERVED_WAITING_STATES = new Set([
  RUNNER_STATE.WAITING_RETRY,
  RUNNER_STATE.WAITING_SCHEDULE,
]);
const HIGH_PRIORITY_WAITING_STATES = new Set([
  RUNNER_STATE.WAITING_ENROLLMENT,
  RUNNER_STATE.WAITING_RATE_LIMIT,
]);
const ACTIVE_MUTATION_STATUSES = new Set([
  RUNNER_MUTATION_STATUS.PREPARED,
  RUNNER_MUTATION_STATUS.IN_FLIGHT,
  RUNNER_MUTATION_STATUS.ACCEPTED,
  RUNNER_MUTATION_STATUS.UNCERTAIN,
]);
const CONTROLLED_STATES = new Set([
  RUNNER_STATE.STOPPING,
  RUNNER_STATE.STOPPED,
  RUNNER_STATE.COMPLETED,
  RUNNER_STATE.FAILED,
]);
let observerTimer = null;

function stateFromStatus(job) {
  const status = String(job.status ?? '');
  if (job.lifecycle === 'stopping') return RUNNER_STATE.STOPPING;
  if (/TOKEN INVALID/.test(status)) return RUNNER_STATE.FAILED;
  if (/STOPPED BY USER/.test(status)) return RUNNER_STATE.STOPPED;
  if (/NETWORK RETRY/.test(status)) return RUNNER_STATE.WAITING_RETRY;
  if (/NEXT CHECK|AUTO DAILY ACTIVE/.test(status)) return RUNNER_STATE.WAITING_SCHEDULE;
  if (/VERIFY/.test(status)) return RUNNER_STATE.VERIFYING_COMPLETION;
  if (status.includes('กำลังเตรียมทำ')) return RUNNER_STATE.ENROLLING;
  if (status.includes('กำลังทำ') || PROGRESS_PATTERN.test(status)) {
    return RUNNER_STATE.RUNNING_PROGRESS;
  }
  if (/LOGIN/.test(status)) return RUNNER_STATE.AUTHENTICATING;
  return RUNNER_STATE.RUNNING;
}

function progressMatch(status) {
  PROGRESS_PATTERN.lastIndex = 0;
  return PROGRESS_PATTERN.exec(String(status ?? ''));
}

function progressFromStatus(status) {
  const match = progressMatch(status);
  if (!match) return null;
  return Math.min(100, Math.max(0, Number(match[1])));
}

function runningQuestName(value) {
  for (const marker of ['กำลังเตรียมทำ', 'กำลังทำ']) {
    const markerIndex = value.indexOf(marker);
    if (markerIndex < 0) continue;
    const start = markerIndex + marker.length;
    const progress = progressMatch(value);
    const end = progress && progress.index > start ? progress.index : value.length;
    const name = value
      .slice(start, end)
      .trim()
      .replace(/[:\-–—]\s*$/, '')
      .trim();
    if (name) return name.slice(0, 160);
  }
  return null;
}

function progressQuestName(value) {
  const match = progressMatch(value);
  if (!match) return null;
  const prefix = value.slice(0, match.index).trim();
  if (!prefix) return null;
  const colonIndex = prefix.indexOf(':');
  const name = (colonIndex >= 0 ? prefix.slice(colonIndex + 1) : prefix).trim();
  return name ? name.slice(0, 160) : null;
}

function questNameFromStatus(status) {
  const value = String(status ?? '');
  return runningQuestName(value) ?? progressQuestName(value);
}

function hasActiveMutationCheckpoint(current) {
  return ACTIVE_MUTATION_STATUSES.has(current?.mutation_status);
}

function hasAuthoritativeDirectState(current, observedState) {
  if (!current) return false;
  if (CONTROLLED_STATES.has(observedState) && !CONTROLLED_STATES.has(current.state)) return false;
  if (CONTROLLED_STATES.has(current.state)) return true;
  if (HIGH_PRIORITY_WAITING_STATES.has(current.state)) return true;
  if (String(current.state_source ?? '').startsWith('schedule-hint:')) return true;
  if (hasActiveMutationCheckpoint(current)) return true;
  if (OBSERVED_WAITING_STATES.has(observedState)) return false;
  return Boolean(current.state_source && current.state_source !== 'legacy-observer');
}

function observedMetadata(job, current, preserve, state) {
  const metadata = {
    ...(preserve ? current.metadata : null),
    lifecycle: job.lifecycle,
    status: String(job.status ?? '').slice(0, 500),
  };
  if (!preserve) metadata.scheduleReason = stateScheduleReason(state);
  return metadata;
}

function observedLastError(job, current, preserve, state) {
  if (preserve) return current.last_error;
  if (state === RUNNER_STATE.FAILED) return String(job.status ?? '').slice(0, 500);
  return null;
}

function observedValues(job, current, preserve, state) {
  const questName = questNameFromStatus(job.status);
  const progress = progressFromStatus(job.status);
  return {
    ...(job.accountId != null ? { accountId: job.accountId } : {}),
    ...(job.username != null ? { username: job.username } : {}),
    ...(!preserve && questName != null ? { questName } : {}),
    ...(!preserve && progress != null ? { progress } : {}),
    nextActionAt: preserve ? current.next_action_at : job.nextCheckAt,
    lastError: observedLastError(job, current, preserve, state),
    metadata: observedMetadata(job, current, preserve, state),
    stateSource: preserve ? current.state_source : 'legacy-observer',
  };
}

function observedTransition(job, current, observedState) {
  const preserve = hasAuthoritativeDirectState(current, observedState);
  const state = preserve ? current.state : observedState;
  return {
    state,
    values: observedValues(job, current, preserve, state),
  };
}

export function syncRunnerState(job) {
  const executionContext = resolveRunnerExecutionContext(job.key);
  if (executionContext?.workerHolder) assertRunnerMutationOwnership(job.key);
  let current = getRunnerState(job.key);
  if (!current && (!job.ownerId || !job.mode)) return null;
  if (!current) {
    current = beginRunnerState({
      jobKey: job.key,
      ownerId: job.ownerId,
      accountId: job.accountId,
      username: job.username,
      mode: job.mode,
      scheduleId: job.scheduleId,
      state: RUNNER_STATE.RUNNING,
      nextActionAt: job.nextCheckAt,
      metadata: { source: 'observer' },
      stateSource: 'legacy-observer',
    });
  }

  const transition = observedTransition(job, current, stateFromStatus(job));
  return transitionRunnerState(job.key, transition.state, transition.values);
}

export function syncRunnerStates(jobs, sync = syncRunnerState, log = console.error) {
  return jobs.flatMap((job) => {
    try {
      const result = sync(job);
      return result ? [result] : [];
    } catch (error) {
      log(
        `[RunnerState:${String(job.key).slice(0, 100)}] sync failed — ${error?.message ?? 'unknown error'}`,
      );
      return [];
    }
  });
}

export function syncAllRunnerStates() {
  return syncRunnerStates(listJobs());
}

export function startRunnerStateObserver() {
  if (observerTimer) return false;
  syncAllRunnerStates();
  observerTimer = setInterval(syncAllRunnerStates, OBSERVER_INTERVAL_MS);
  observerTimer.unref?.();
  return true;
}

export function stopRunnerStateObserver() {
  if (!observerTimer) return false;
  clearInterval(observerTimer);
  observerTimer = null;
  return true;
}

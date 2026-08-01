import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationFingerprint } from '../src/quest/rate-limit-coordinator.js';
import {
  clearScheduleHintsForTests,
  publishScheduleHint,
} from '../src/quest/schedule-hint-bus.js';
import {
  clearAllSmartWakes,
  clearSmartWake,
  configureSmartWakeController,
  isSmartWakeRestarting,
  MAX_SMART_WAKE_TIMER_MS,
  registerSmartWake,
  smartWakeTimerDelay,
} from '../src/quest/smart-wake-controller.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
  transitionRunnerState,
} from '../src/quest/runner-state-store.js';

const ENROLLMENT_JOB_KEY = 'scheduled:smart-wake-enrollment';
const ENROLLMENT_TOKEN = 'smart-wake-enrollment-token';
const BASELINE_JOB_KEY = 'scheduled:smart-wake-baseline';
const BASELINE_TOKEN = 'smart-wake-baseline-token';

function scheduledArgs(jobKey, token, scheduleId) {
  return {
    jobKey,
    ownerId: 'owner-1',
    userToken: token,
    channelId: 'channel-1',
    client: {},
    mode: 'scheduled',
    scheduleId,
    accountId: `account-${scheduleId}`,
    username: 'runner',
  };
}

function beginScheduled(jobKey, scheduleId) {
  beginRunnerState({
    jobKey,
    ownerId: 'owner-1',
    accountId: `account-${scheduleId}`,
    username: 'runner',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.RUNNING,
  });
}

function markSleeping(jobKey) {
  transitionRunnerState(jobKey, RUNNER_STATE.WAITING_SCHEDULE, {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    stateSource: 'test-sleep',
  });
}

async function waitFor(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test.beforeEach(() => {
  clearAllSmartWakes();
  clearScheduleHintsForTests();
  clearRunnerStatesForTests();
  configureSmartWakeController(null);
});

test.after(() => {
  clearAllSmartWakes();
  clearScheduleHintsForTests();
  clearRunnerStatesForTests();
  configureSmartWakeController(null);
});

test('enrollment hints persist an earlier durable wake-up state', () => {
  beginScheduled(ENROLLMENT_JOB_KEY, 1);
  assert.equal(registerSmartWake(scheduledArgs(ENROLLMENT_JOB_KEY, ENROLLMENT_TOKEN, 1)), true);

  const nextActionAt = new Date(Date.now() + 60_000).toISOString();
  publishScheduleHint(authorizationFingerprint(ENROLLMENT_TOKEN), {
    nextActionAt,
    reason: 'enrollment:quest-1',
    priority: 70,
  });

  const state = getRunnerState(ENROLLMENT_JOB_KEY);
  assert.equal(state.state, RUNNER_STATE.WAITING_ENROLLMENT);
  assert.equal(state.next_action_at, nextActionAt);
  assert.deepEqual(state.metadata, { reason: 'enrollment:quest-1', priority: 70 });
});

test('smart wake maps every non-baseline hint to its durable lifecycle state', () => {
  const cases = [
    ['claim:quest-1', RUNNER_STATE.CLAIMING],
    ['claim-retry', RUNNER_STATE.WAITING_RETRY],
    ['rate-limit', RUNNER_STATE.WAITING_RATE_LIMIT],
    ['retry', RUNNER_STATE.WAITING_RETRY],
    ['circuit-breaker', RUNNER_STATE.WAITING_RETRY],
    ['progress-stall', RUNNER_STATE.VERIFYING_PROGRESS],
    ['verification', RUNNER_STATE.VERIFYING_COMPLETION],
    ['recovery', RUNNER_STATE.RECOVERING],
    ['scheduled-check', RUNNER_STATE.WAITING_SCHEDULE],
  ];

  cases.forEach(([reason, expectedState], index) => {
    const scheduleId = 100 + index;
    const jobKey = `scheduled:smart-wake-reason-${index}`;
    const token = `smart-wake-reason-token-${index}`;
    beginScheduled(jobKey, scheduleId);
    assert.equal(registerSmartWake(scheduledArgs(jobKey, token, scheduleId)), true);

    const nextActionAt = new Date(Date.now() + 120_000 + index).toISOString();
    publishScheduleHint(authorizationFingerprint(token), {
      nextActionAt,
      reason,
      priority: 80 - index,
      source: 'test-source',
    });

    const state = getRunnerState(jobKey);
    assert.equal(state.state, expectedState, reason);
    assert.equal(state.next_action_at, nextActionAt, reason);
    assert.equal(state.state_source, 'schedule-hint:test-source', reason);
    assert.deepEqual(state.metadata, { reason, priority: 80 - index }, reason);
  });
});

test('baseline and invalid hints do not replace the runner state', () => {
  beginScheduled(BASELINE_JOB_KEY, 2);
  assert.equal(registerSmartWake(scheduledArgs(BASELINE_JOB_KEY, BASELINE_TOKEN, 2)), true);

  publishScheduleHint(authorizationFingerprint(BASELINE_TOKEN), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'baseline',
    priority: 10,
  });
  assert.equal(getRunnerState(BASELINE_JOB_KEY).state, RUNNER_STATE.RUNNING);

  publishScheduleHint(authorizationFingerprint(BASELINE_TOKEN), {
    nextActionAt: 'not-a-date',
    reason: 'verification',
    priority: 90,
  });
  assert.equal(getRunnerState(BASELINE_JOB_KEY).state, RUNNER_STATE.RUNNING);
});

test('one-shot jobs are rejected and clearing a wake unsubscribes its hints', () => {
  assert.equal(registerSmartWake({
    ...scheduledArgs('oneshot:smart-wake', 'oneshot-smart-wake-token', 3),
    mode: 'oneshot',
  }), false);
  assert.equal(clearSmartWake('missing-smart-wake'), false);

  const jobKey = 'scheduled:smart-wake-clear';
  const token = 'smart-wake-clear-token';
  beginScheduled(jobKey, 4);
  assert.equal(registerSmartWake(scheduledArgs(jobKey, token, 4)), true);
  assert.equal(clearSmartWake(jobKey), true);
  assert.equal(clearSmartWake(jobKey), false);

  publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'verification',
    priority: 90,
  });
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.RUNNING);
  assert.equal(isSmartWakeRestarting(jobKey), false);
});

test('registering the same job again replaces the previous subscription', () => {
  const jobKey = 'scheduled:smart-wake-reregister';
  const oldToken = 'smart-wake-old-token';
  const newToken = 'smart-wake-new-token';
  beginScheduled(jobKey, 5);

  assert.equal(registerSmartWake(scheduledArgs(jobKey, oldToken, 5)), true);
  assert.equal(registerSmartWake(scheduledArgs(jobKey, newToken, 5)), true);

  publishScheduleHint(authorizationFingerprint(oldToken), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'rate-limit',
    priority: 98,
  });
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.RUNNING);

  publishScheduleHint(authorizationFingerprint(newToken), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'rate-limit',
    priority: 98,
  });
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.WAITING_RATE_LIMIT);
});

test('a due wake stops a sleeping job, waits for cleanup and restarts without a stale schedule', async () => {
  const jobKey = 'scheduled:smart-wake-restart';
  const token = 'smart-wake-restart-token';
  const args = scheduledArgs(jobKey, token, 6);
  beginScheduled(jobKey, 6);
  markSleeping(jobKey);

  const stops = [];
  let restartedWith = null;
  const active = {
    done: Promise.resolve(),
    summary: () => ({
      status: 'NEXT CHECK: later',
      nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  };
  configureSmartWakeController(async (restartArgs) => {
    restartedWith = restartArgs;
  }, {
    getJob: () => active,
    stopJob: (...stopArgs) => {
      stops.push(stopArgs);
      return true;
    },
    getScheduled: () => ({ id: 6 }),
  });

  registerSmartWake(args);
  publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt: new Date(Date.now() - 1).toISOString(),
    reason: 'recovery',
    priority: 99,
  });

  await waitFor(() => restartedWith !== null, 'sleeping runner was not restarted');
  assert.deepEqual(stops, [['owner-1', jobKey, { removeSchedule: false }]]);
  assert.equal(restartedWith.jobKey, jobKey);
  assert.equal(restartedWith.initialNextCheckAt, null);
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.RECOVERING);
  assert.equal(isSmartWakeRestarting(jobKey), false);
});

test('a due hint does not interrupt an active runner', async () => {
  const jobKey = 'scheduled:smart-wake-active';
  const token = 'smart-wake-active-token';
  beginScheduled(jobKey, 61);
  let stopped = false;
  let restarted = false;
  configureSmartWakeController(async () => { restarted = true; }, {
    getJob: () => ({
      done: Promise.resolve(),
      summary: () => ({ status: 'RUNNING', nextCheckAt: null }),
    }),
    stopJob: () => {
      stopped = true;
      return true;
    },
    getScheduled: () => ({ id: 61 }),
  });

  registerSmartWake(scheduledArgs(jobKey, token, 61));
  publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt: new Date(Date.now() - 1).toISOString(),
    reason: 'recovery',
    priority: 99,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(stopped, false);
  assert.equal(restarted, false);
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.RUNNING);
});

test('a fixed schedule earlier than the hint prevents an unnecessary restart', async () => {
  const jobKey = 'scheduled:smart-wake-fixed-earlier';
  const token = 'smart-wake-fixed-earlier-token';
  beginScheduled(jobKey, 7);
  let restarted = false;
  configureSmartWakeController(async () => { restarted = true; }, {
    getJob: () => ({
      done: Promise.resolve(),
      summary: () => ({
        status: 'NEXT CHECK: soon',
        nextCheckAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    }),
    stopJob: () => true,
    getScheduled: () => ({ id: 7 }),
  });

  registerSmartWake(scheduledArgs(jobKey, token, 7));
  publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'verification',
    priority: 90,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(restarted, false);
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.RUNNING);
});

test('a stale past nextCheckAt no longer suppresses a future smart hint', () => {
  const jobKey = 'scheduled:smart-wake-stale-past';
  const token = 'smart-wake-stale-past-token';
  beginScheduled(jobKey, 71);
  configureSmartWakeController(async () => {}, {
    getJob: () => ({
      done: Promise.resolve(),
      summary: () => ({
        status: 'RUNNING',
        nextCheckAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    }),
    stopJob: () => true,
    getScheduled: () => ({ id: 71 }),
  });

  registerSmartWake(scheduledArgs(jobKey, token, 71));
  publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'verification',
    priority: 90,
    source: 'test-source',
  });

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.RUNNING);
  assert.equal(state.state_source, 'runner-service');
});

test('a deleted scheduled row cancels the due wake before stopping the job', async () => {
  const jobKey = 'scheduled:smart-wake-row-deleted';
  const token = 'smart-wake-row-deleted-token';
  beginScheduled(jobKey, 8);
  markSleeping(jobKey);
  let stopped = false;
  let restarted = false;
  configureSmartWakeController(async () => { restarted = true; }, {
    getJob: () => ({
      done: Promise.resolve(),
      summary: () => ({ status: 'AUTO DAILY ACTIVE', nextCheckAt: null }),
    }),
    stopJob: () => {
      stopped = true;
      return true;
    },
    getScheduled: () => null,
  });

  registerSmartWake(scheduledArgs(jobKey, token, 8));
  publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt: new Date(Date.now() - 1).toISOString(),
    reason: 'verification',
    priority: 90,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(stopped, false);
  assert.equal(restarted, false);
  assert.equal(clearSmartWake(jobKey), false);
});

test('restart failure becomes a durable FAILED state after rejected cleanup is settled', async () => {
  const jobKey = 'scheduled:smart-wake-restart-failure';
  const token = 'smart-wake-restart-failure-token';
  beginScheduled(jobKey, 9);
  markSleeping(jobKey);
  let rejectCleanup;
  const cleanup = new Promise((_, reject) => { rejectCleanup = reject; });
  const active = {
    done: cleanup,
    summary: () => ({ status: 'NEXT CHECK: later', nextCheckAt: null }),
  };
  configureSmartWakeController(async () => {
    throw new Error('restart failed');
  }, {
    getJob: () => active,
    stopJob: () => {
      rejectCleanup(new Error('cleanup failed'));
      return true;
    },
    getScheduled: () => ({ id: 9 }),
  });

  registerSmartWake(scheduledArgs(jobKey, token, 9));
  publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt: new Date(Date.now() - 1).toISOString(),
    reason: 'recovery',
    priority: 99,
  });

  await waitFor(
    () => getRunnerState(jobKey)?.state === RUNNER_STATE.FAILED,
    'restart failure was not persisted',
  );
  const state = getRunnerState(jobKey);
  assert.equal(state.last_error, 'restart failed');
  assert.deepEqual(state.metadata, { stage: 'smart-wakeup' });
  assert.equal(state.state_source, 'smart-wakeup-failure');
  assert.equal(isSmartWakeRestarting(jobKey), false);
});

test('far-future smart wake uses bounded timer chunks instead of overflowing setTimeout', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const farFuture = '2030-03-01T00:00:00.000Z';

  assert.equal(smartWakeTimerDelay(farFuture, now), MAX_SMART_WAKE_TIMER_MS);
  assert.equal(MAX_SMART_WAKE_TIMER_MS, 24 * 60 * 60 * 1000);
});

test('due and invalid smart wake timestamps are normalized safely', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  assert.equal(smartWakeTimerDelay('2029-12-31T23:59:59.000Z', now), 0);
  assert.equal(smartWakeTimerDelay('not-a-date', now), null);
});

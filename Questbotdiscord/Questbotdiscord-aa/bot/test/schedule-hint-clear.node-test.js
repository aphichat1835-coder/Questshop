import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationFingerprint } from '../src/quest/authorization-fingerprint.js';
import {
  clearScheduleHint,
  clearScheduleHintsForTests,
  publishScheduleHint,
  subscribeScheduleHints,
} from '../src/quest/schedule-hint-bus.js';
import {
  clearAllSmartWakes,
  configureSmartWakeController,
  registerSmartWake,
} from '../src/quest/smart-wake-controller.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

function smartWakeArgs(jobKey, token, scheduleId) {
  return {
    jobKey,
    ownerId: 'hint-owner',
    userToken: token,
    channelId: 'hint-channel',
    client: {},
    mode: 'scheduled',
    scheduleId,
    accountId: 'hint-account',
    username: 'hint-user',
  };
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

test('clearing the active urgent source publishes the remaining baseline hint', () => {
  const account = 'hint-clear-account';
  const seen = [];
  const unsubscribe = subscribeScheduleHints(account, (hint) => seen.push(hint));

  publishScheduleHint(account, {
    nextActionAt: '2030-01-01T08:00:00.000Z',
    reason: 'baseline',
    source: 'baseline',
    priority: 10,
  });
  publishScheduleHint(account, {
    nextActionAt: '2030-01-01T00:00:00.000Z',
    reason: 'recovery',
    source: 'recovery',
    priority: 99,
  });
  assert.equal(clearScheduleHint(account, 'recovery'), true);

  assert.equal(seen.at(-1).reason, 'baseline');
  assert.equal(seen.at(-1).source, 'baseline');
  unsubscribe();
});

test('clearing the only hint publishes null', () => {
  const account = 'hint-clear-only-account';
  const seen = [];
  const unsubscribe = subscribeScheduleHints(account, (hint) => seen.push(hint));

  publishScheduleHint(account, {
    nextActionAt: '2030-01-01T00:00:00.000Z',
    reason: 'recovery',
    source: 'recovery',
    priority: 99,
  });
  assert.equal(clearScheduleHint(account, 'recovery'), true);
  assert.equal(seen.at(-1), null);
  unsubscribe();
});

test('clearing a missing source remains a no-op', () => {
  const account = 'hint-clear-missing-account';
  publishScheduleHint(account, {
    nextActionAt: '2030-01-01T00:00:00.000Z',
    reason: 'baseline',
    source: 'baseline',
    priority: 10,
  });
  assert.equal(clearScheduleHint(account, 'missing'), false);
});

test('clearing a due hint cancels its stale smart wake timer', async () => {
  const jobKey = 'scheduled:hint-clear-timer';
  const token = 'hint-clear-timer-token';
  const account = authorizationFingerprint(token);
  beginRunnerState({
    jobKey,
    ownerId: 'hint-owner',
    accountId: 'hint-account',
    mode: 'scheduled',
    scheduleId: 9901,
    state: RUNNER_STATE.RUNNING,
  });

  let restarts = 0;
  configureSmartWakeController(async () => { restarts++; }, {
    getJob: () => ({
      done: Promise.resolve(),
      summary: () => ({ status: 'AUTO DAILY ACTIVE', nextCheckAt: null }),
    }),
    stopJob: () => true,
    getScheduled: () => ({ id: 9901 }),
  });
  assert.equal(registerSmartWake(smartWakeArgs(jobKey, token, 9901)), true);

  assert.equal(publishScheduleHint(account, {
    nextActionAt: new Date(Date.now() - 1).toISOString(),
    reason: 'recovery',
    source: 'recovery',
    priority: 99,
  }), true);
  assert.equal(clearScheduleHint(account, 'recovery'), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(restarts, 0);
});

test('falling back from an urgent hint to baseline removes the urgent wake instead of scheduling baseline', async () => {
  const jobKey = 'scheduled:hint-baseline-fallback';
  const token = 'hint-baseline-fallback-token';
  const account = authorizationFingerprint(token);
  const scheduleId = 9903;
  beginRunnerState({
    jobKey,
    ownerId: 'hint-owner',
    accountId: 'hint-account',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.WAITING_SCHEDULE,
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    stateSource: 'test-sleep',
  });

  let restarts = 0;
  configureSmartWakeController(async () => { restarts++; }, {
    getJob: () => ({
      done: Promise.resolve(),
      summary: () => ({ status: 'AUTO DAILY ACTIVE', nextCheckAt: null }),
    }),
    stopJob: () => true,
    getScheduled: () => ({ id: scheduleId }),
  });
  assert.equal(registerSmartWake(smartWakeArgs(jobKey, token, scheduleId)), true);

  assert.equal(publishScheduleHint(account, {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'baseline',
    source: 'baseline',
    priority: 10,
  }), true);
  assert.equal(publishScheduleHint(account, {
    nextActionAt: new Date(Date.now() + 30).toISOString(),
    reason: 'recovery',
    source: 'recovery',
    priority: 99,
  }), true);
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.RECOVERING);
  assert.equal(clearScheduleHint(account, 'recovery'), true);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(restarts, 0);
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.RECOVERING);
  assert.equal(state.state_source, 'schedule-hint:recovery');
});

test('a schedule hint without reason safely uses the waiting-schedule state', () => {
  const jobKey = 'scheduled:hint-without-reason';
  const token = 'hint-without-reason-token';
  const nextActionAt = new Date(Date.now() + 60_000).toISOString();
  beginRunnerState({
    jobKey,
    ownerId: 'hint-owner',
    accountId: 'hint-account',
    mode: 'scheduled',
    scheduleId: 9902,
    state: RUNNER_STATE.RUNNING,
  });
  assert.equal(registerSmartWake(smartWakeArgs(jobKey, token, 9902)), true);

  assert.equal(publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt,
    source: 'reasonless-test',
  }), true);
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_SCHEDULE);
  assert.equal(state.next_action_at, nextActionAt);
  assert.equal(state.state_source, 'schedule-hint:reasonless-test');
});

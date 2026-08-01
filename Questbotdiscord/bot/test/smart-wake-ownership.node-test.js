import './setup-env.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { authorizationFingerprint } from '../src/quest/authorization-fingerprint.js';
import {
  clearScheduleHintsForTests,
  publishScheduleHint,
} from '../src/quest/schedule-hint-bus.js';
import {
  clearAllSmartWakes,
  configureSmartWakeController,
  isSmartWakeRestarting,
  registerSmartWake,
} from '../src/quest/smart-wake-controller.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

function args(jobKey, token, scheduleId) {
  return {
    jobKey,
    ownerId: 'wake-owner',
    userToken: token,
    channelId: 'wake-channel',
    client: {},
    mode: 'scheduled',
    scheduleId,
    accountId: `wake-account-${scheduleId}`,
    username: 'wake-user',
  };
}

function sleepingJob(done = Promise.resolve()) {
  return {
    done,
    summary: () => ({ status: 'AUTO DAILY ACTIVE', nextCheckAt: null }),
  };
}

function beginSleepingRunner(jobKey, scheduleId) {
  beginRunnerState({
    jobKey,
    ownerId: 'wake-owner',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.WAITING_SCHEDULE,
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    stateSource: 'test-sleep',
  });
}

async function publishDue(token, offsetMs = -1) {
  publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt: new Date(Date.now() + offsetMs).toISOString(),
    reason: 'recovery',
    source: 'recovery',
    priority: 99,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
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

test('a denied Smart Wake attempt explicitly clears its consumed hint', () => {
  const source = readFileSync(new URL('../src/quest/smart-wake-controller.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!stopped\) \{\s*clearWakeTimer\(args\.jobKey\);\s*return false;\s*\}/);
});

test('smart wake clears a denied attempt and accepts a later changed hint', async () => {
  const jobKey = 'scheduled:smart-wake-stop-denied';
  const token = 'smart-wake-stop-denied-token';
  const scheduleId = 9961;
  beginSleepingRunner(jobKey, scheduleId);
  const active = sleepingJob(new Promise(() => {}));
  let restarts = 0;
  let stops = 0;
  configureSmartWakeController(async () => { restarts++; }, {
    getJob: () => active,
    stopJob: () => {
      stops++;
      return false;
    },
    getScheduled: () => ({ id: scheduleId }),
  });

  registerSmartWake(args(jobKey, token, scheduleId));
  await publishDue(token, -1);
  assert.equal(stops, 1);
  assert.equal(restarts, 0);
  assert.equal(isSmartWakeRestarting(jobKey), false);

  await publishDue(token, -2);
  assert.equal(stops, 2);
  assert.equal(restarts, 0);
  assert.equal(isSmartWakeRestarting(jobKey), false);
});

test('smart wake does not restart over a replacement job created during cleanup', async () => {
  const jobKey = 'scheduled:smart-wake-replacement';
  const token = 'smart-wake-replacement-token';
  const scheduleId = 9962;
  beginSleepingRunner(jobKey, scheduleId);

  let finishCleanup;
  const cleanup = new Promise((resolve) => { finishCleanup = resolve; });
  const active = sleepingJob(cleanup);
  const replacement = sleepingJob();
  let current = active;
  let restarts = 0;
  configureSmartWakeController(async () => { restarts++; }, {
    getJob: () => current,
    stopJob: () => {
      current = replacement;
      finishCleanup();
      return true;
    },
    getScheduled: () => ({ id: scheduleId }),
  });

  registerSmartWake(args(jobKey, token, scheduleId));
  await publishDue(token);

  assert.equal(restarts, 0);
  assert.equal(isSmartWakeRestarting(jobKey), false);
});

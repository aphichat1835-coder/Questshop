import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAIM_RETRY_REASON,
  persistClaimRetry,
} from '../src/quest/claim-retry-policy.js';
import { authorizationFingerprint } from '../src/quest/authorization-fingerprint.js';
import {
  clearScheduleHintsForTests,
  publishScheduleHint,
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
  RUNNER_MUTATION_KIND,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

const JOB_KEY = 'scheduled:claim-smart-wake-cooldown';
const TOKEN = 'claim-smart-wake-token';
const SCHEDULE_ID = 9971;

function runnerArgs() {
  return {
    jobKey: JOB_KEY,
    ownerId: 'claim-wake-owner',
    userToken: TOKEN,
    channelId: 'claim-wake-channel',
    client: {},
    mode: 'scheduled',
    scheduleId: SCHEDULE_ID,
    accountId: 'claim-wake-account',
    username: 'claim-wake-user',
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

test('urgent claim hints cannot bypass a durable claim cooldown', async () => {
  beginRunnerState({
    jobKey: JOB_KEY,
    ownerId: 'claim-wake-owner',
    accountId: 'claim-wake-account',
    mode: 'scheduled',
    scheduleId: SCHEDULE_ID,
    state: RUNNER_STATE.RUNNING,
  });

  const now = new Date();
  const delayMs = 60_000;
  const expectedRetryAt = new Date(now.getTime() + delayMs).toISOString();
  persistClaimRetry(JOB_KEY, {
    id: 'claim-wake-quest',
    name: 'Claim Wake Quest',
    eventName: 'WATCH_VIDEO',
    progress: 100,
    progressSecs: 60,
  }, {
    reason: CLAIM_RETRY_REASON.REQUEST_REJECTED,
    delayMs,
    error: Object.assign(new Error('claim rejected'), { status: 400 }),
    now,
  });

  let stops = 0;
  let restarts = 0;
  configureSmartWakeController(async () => { restarts++; }, {
    getJob: () => ({
      done: new Promise(() => {}),
      summary: () => ({ status: 'AUTO DAILY ACTIVE', nextCheckAt: null }),
    }),
    stopJob: () => {
      stops++;
      return true;
    },
    getScheduled: () => ({ id: SCHEDULE_ID }),
  });
  assert.equal(registerSmartWake(runnerArgs()), true);

  const account = authorizationFingerprint(TOKEN);
  const repeatedClaimHint = {
    nextActionAt: new Date(Date.now() - 1).toISOString(),
    reason: 'claim:claim-wake-quest',
    source: 'quest-list',
    priority: 100,
  };
  assert.equal(publishScheduleHint(account, repeatedClaimHint), true);
  // The bus intentionally deduplicates an identical source hint. That no-op
  // must still leave the durable claim cooldown authoritative.
  assert.equal(publishScheduleHint(account, repeatedClaimHint), false);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const state = getRunnerState(JOB_KEY);
  assert.equal(stops, 0);
  assert.equal(restarts, 0);
  assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
  assert.equal(state.mutation_kind, RUNNER_MUTATION_KIND.CLAIM);
  assert.equal(state.next_action_at, expectedRetryAt);
  assert.equal(state.metadata.claimRetryAt, expectedRetryAt);
  assert.equal(state.metadata.reason, 'claim-retry');
  assert.equal(state.state_source, 'schedule-hint:claim-retry');
});

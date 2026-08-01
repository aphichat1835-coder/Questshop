import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRunnerState } from '../src/quest/runner-state-observer.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  markRunnerMutationFailed,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_STATE,
  transitionRunnerState,
} from '../src/quest/runner-state-store.js';

function job(jobKey, status, nextCheckAt) {
  return {
    key: jobKey,
    ownerId: 'wait-owner',
    accountId: 'wait-account',
    username: 'wait-user',
    mode: 'scheduled',
    scheduleId: 71,
    lifecycle: 'running',
    status,
    nextCheckAt,
  };
}

test.beforeEach(clearRunnerStatesForTests);
test.afterEach(clearRunnerStatesForTests);

test('network retry status replaces a stale direct fetching state', () => {
  const jobKey = 'scheduled:observer-network-wait';
  const nextCheckAt = '2030-01-01T00:05:00.000Z';
  beginRunnerState({
    jobKey,
    ownerId: 'wait-owner',
    mode: 'scheduled',
    scheduleId: 71,
    state: RUNNER_STATE.FETCHING_QUESTS,
    stateSource: 'quest-orchestrator',
  });

  syncRunnerState(job(jobKey, '🌐 wait-user: NETWORK RETRY — อีก 5 นาที', nextCheckAt));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
  assert.equal(state.next_action_at, nextCheckAt);
  assert.equal(state.metadata.scheduleReason, 'retry');
  assert.equal(state.state_source, 'legacy-observer');
});

test('daily sleep status persists waiting schedule and its exact wake time', () => {
  const jobKey = 'scheduled:observer-daily-wait';
  const nextCheckAt = '2030-01-01T08:00:00.000Z';
  beginRunnerState({
    jobKey,
    ownerId: 'wait-owner',
    mode: 'scheduled',
    scheduleId: 71,
    state: RUNNER_STATE.RUNNING,
    stateSource: 'runner-service',
  });

  syncRunnerState(job(jobKey, '⏰ wait-user: NEXT CHECK 1/1/73 15:00', nextCheckAt));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_SCHEDULE);
  assert.equal(state.next_action_at, nextCheckAt);
  assert.equal(state.metadata.scheduleReason, 'baseline');
});

test('an active mutation checkpoint cannot be overwritten by observed sleep text', () => {
  const jobKey = 'scheduled:observer-mutation-preserve';
  beginRunnerState({
    jobKey,
    ownerId: 'wait-owner',
    mode: 'scheduled',
    scheduleId: 71,
  });
  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.VIDEO_PROGRESS,
    questId: 'wait-quest',
    payload: { timestamp: 10 },
  });
  const before = getRunnerState(jobKey);

  syncRunnerState(job(
    jobKey,
    '🌐 wait-user: NETWORK RETRY — อีก 5 นาที',
    '2030-01-01T00:05:00.000Z',
  ));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, before.state);
  assert.equal(state.mutation_status, before.mutation_status);
  assert.equal(state.next_action_at, before.next_action_at);
});

test('STOPPING state cannot be revived by a stale waiting message', () => {
  const jobKey = 'scheduled:observer-stop-preserve';
  beginRunnerState({
    jobKey,
    ownerId: 'wait-owner',
    mode: 'scheduled',
    scheduleId: 71,
    state: RUNNER_STATE.RUNNING,
  });
  transitionRunnerState(jobKey, RUNNER_STATE.STOPPING, {
    stateSource: 'runner-service-control',
  });

  syncRunnerState(job(
    jobKey,
    '💤 wait-user: AUTO DAILY ACTIVE',
    '2030-01-01T08:00:00.000Z',
  ));
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.STOPPING);
});

test('failed mutation accepts and preserves the live runner retry deadline', () => {
  const jobKey = 'scheduled:observer-failed-mutation-retry';
  const nextCheckAt = '2030-01-01T00:05:00.000Z';
  beginRunnerState({
    jobKey,
    ownerId: 'wait-owner',
    mode: 'scheduled',
    scheduleId: 71,
  });
  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.VIDEO_PROGRESS,
    questId: 'wait-quest',
    payload: { timestamp: 10 },
  });
  markRunnerMutationFailed(jobKey, Object.assign(new Error('bad request'), { status: 400 }));

  syncRunnerState(job(jobKey, '🌐 wait-user: NETWORK RETRY — อีก 5 นาที', nextCheckAt));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
  assert.equal(state.mutation_status, 'FAILED');
  assert.equal(state.next_action_at, nextCheckAt);
  assert.equal(state.state_source, 'legacy-observer');
});

test('failed mutation no longer blocks the next durable daily schedule', () => {
  const jobKey = 'scheduled:observer-failed-mutation-daily';
  const nextCheckAt = '2030-01-01T08:00:00.000Z';
  beginRunnerState({
    jobKey,
    ownerId: 'wait-owner',
    mode: 'scheduled',
    scheduleId: 71,
  });
  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.HEARTBEAT,
    questId: 'wait-quest',
    payload: { terminal: false },
  });
  markRunnerMutationFailed(jobKey, Object.assign(new Error('bad request'), { status: 400 }));

  syncRunnerState(job(jobKey, '💤 wait-user: AUTO DAILY ACTIVE', nextCheckAt));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_SCHEDULE);
  assert.equal(state.mutation_status, 'FAILED');
  assert.equal(state.next_action_at, nextCheckAt);
  assert.equal(state.metadata.scheduleReason, 'baseline');
});

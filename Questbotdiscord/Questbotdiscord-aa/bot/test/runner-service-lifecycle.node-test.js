import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/db.js';
import {
  clearRunnerExecutionContextsForTests,
  registerRunnerExecution,
  resolveRunnerExecutionContext,
} from '../src/quest/runner-execution-context.js';
import {
  restoreScheduledRunners,
  shouldDelegateScheduledRunner,
  shutdownRunners,
  startLocalRunner,
  stopAllForUser,
  stopJob,
  stopScheduledJob,
} from '../src/quest/runner-service.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

function runnerArgs(jobKey, overrides = {}) {
  return {
    jobKey,
    ownerId: 'runner-service-owner',
    userToken: `runner-service-token-${jobKey}`,
    channelId: 'runner-service-channel',
    client: {},
    mode: 'invalid-test-mode',
    accountId: `account-${jobKey}`,
    username: `user-${jobKey}`,
    ...overrides,
  };
}

test.beforeEach(async () => {
  await shutdownRunners();
  clearRunnerExecutionContextsForTests();
  clearRunnerStatesForTests();
  db.prepare('DELETE FROM scheduled_runners').run();
});

test.afterEach(async () => {
  await shutdownRunners();
  clearRunnerExecutionContextsForTests();
  clearRunnerStatesForTests();
  db.prepare('DELETE FROM scheduled_runners').run();
});

test('scheduled delegation is limited to the control process', () => {
  assert.equal(shouldDelegateScheduledRunner('control', 'scheduled'), true);
  assert.equal(shouldDelegateScheduledRunner('control', 'oneshot'), false);
  assert.equal(shouldDelegateScheduledRunner('worker', 'scheduled'), false);
  assert.equal(shouldDelegateScheduledRunner('all', 'scheduled'), false);
});

test('local start releases its execution context and persists failure when runner validation fails', async () => {
  const args = runnerArgs('runner-service-invalid-mode');

  await assert.rejects(
    startLocalRunner(args),
    /Unknown runner mode: invalid-test-mode/,
  );

  const state = getRunnerState(args.jobKey);
  assert.equal(state.state, RUNNER_STATE.FAILED);
  assert.equal(state.last_error, 'Unknown runner mode: invalid-test-mode');
  assert.deepEqual(state.metadata, { stage: 'start' });
  assert.equal(state.state_source, 'runner-start-failure');
  assert.equal(resolveRunnerExecutionContext(args.jobKey), null);
});

test('duplicate authorization registration fails closed before the legacy runner starts', async () => {
  const token = 'runner-service-duplicate-token';
  const existing = registerRunnerExecution({
    jobKey: 'runner-service-existing',
    ownerId: 'runner-service-owner',
    userToken: token,
    mode: 'oneshot',
  });
  const args = runnerArgs('runner-service-duplicate', {
    userToken: token,
    mode: 'oneshot',
  });

  try {
    await assert.rejects(
      startLocalRunner(args),
      /Authorization fingerprint is already registered/,
    );
    const state = getRunnerState(args.jobKey);
    assert.equal(state.state, RUNNER_STATE.FAILED);
    assert.match(state.last_error, /runner-service-existing/);
    assert.equal(resolveRunnerExecutionContext(args.jobKey), null);
  } finally {
    existing.release();
  }
});

test('recovery start preserves durable identity before a failed restart attempt', async () => {
  const jobKey = 'scheduled:runner-service-recovery';
  const token = 'runner-service-recovery-token';
  beginRunnerState({
    jobKey,
    ownerId: 'runner-service-owner',
    accountId: 'persisted-account',
    username: 'persisted-user',
    mode: 'scheduled',
    scheduleId: 44,
    state: RUNNER_STATE.RECOVERING,
    nextActionAt: '2030-01-01T00:00:00.000Z',
    metadata: { existing: true },
  });
  const existing = registerRunnerExecution({
    jobKey: 'runner-service-recovery-owner',
    ownerId: 'runner-service-owner',
    userToken: token,
    mode: 'scheduled',
  });

  try {
    await assert.rejects(startLocalRunner(runnerArgs(jobKey, {
      userToken: token,
      mode: 'scheduled',
      scheduleId: 44,
      accountId: null,
      username: null,
      recoveryPlan: {
        action: 'VERIFY_MUTATION',
        reason: 'accepted-checkpoint',
        targetState: RUNNER_STATE.VERIFYING_PROGRESS,
      },
    })), /Authorization fingerprint is already registered/);

    const state = getRunnerState(jobKey);
    assert.equal(state.state, RUNNER_STATE.FAILED);
    assert.equal(state.account_id, 'persisted-account');
    assert.equal(state.username, 'persisted-user');
    assert.equal(state.metadata.stage, 'start');
  } finally {
    existing.release();
  }
});

test('empty restore and shutdown paths complete without leaving active state', async () => {
  const restored = await restoreScheduledRunners({});
  assert.equal(restored.restored, 0);
  assert.equal(restored.failed, 0);

  assert.equal(stopJob('runner-service-owner', 'missing-job'), false);
  assert.equal(stopScheduledJob('runner-service-owner', 999_999), false);
  assert.equal(stopAllForUser('runner-service-owner'), 0);
  assert.equal(await shutdownRunners(), 0);
});

import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  syncRunnerState,
  syncRunnerStates,
} from '../src/quest/runner-state-observer.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

const JOB_KEY = 'scheduled:observer-test';

test.beforeEach(() => clearRunnerStatesForTests());
test.afterEach(() => clearRunnerStatesForTests());

test('observer keeps an active smart-wake state while the legacy runner is sleeping', () => {
  const nextActionAt = '2030-01-01T01:00:00.000Z';
  beginRunnerState({
    jobKey: JOB_KEY,
    ownerId: 'owner-1',
    accountId: 'account-1',
    username: 'runner',
    mode: 'scheduled',
    scheduleId: 1,
    state: RUNNER_STATE.WAITING_ENROLLMENT,
    nextActionAt,
    metadata: { reason: 'enrollment:quest-1', priority: 70 },
  });

  syncRunnerState({
    key: JOB_KEY,
    ownerId: 'owner-1',
    accountId: 'account-1',
    username: 'runner',
    mode: 'scheduled',
    scheduleId: 1,
    lifecycle: 'running',
    nextCheckAt: '2030-01-01T08:00:00.000Z',
    status: 'AUTO DAILY ACTIVE · NEXT CHECK 08:00',
  });

  const state = getRunnerState(JOB_KEY);
  assert.equal(state.state, RUNNER_STATE.WAITING_ENROLLMENT);
  assert.equal(state.next_action_at, nextActionAt);
  assert.equal(state.metadata.reason, 'enrollment:quest-1');
  assert.equal(state.metadata.priority, 70);
  assert.equal(state.metadata.lifecycle, 'running');
  assert.match(state.metadata.status, /AUTO DAILY ACTIVE/);
});

test('observer batch continues after one job fails to synchronize', () => {
  const messages = [];
  const result = syncRunnerStates(
    [{ key: 'bad' }, { key: 'good' }],
    (job) => {
      if (job.key === 'bad') throw new Error('database busy');
      return job.key;
    },
    (message) => messages.push(message),
  );

  assert.deepEqual(result, ['good']);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /RunnerState:bad/);
  assert.match(messages[0], /database busy/);
});

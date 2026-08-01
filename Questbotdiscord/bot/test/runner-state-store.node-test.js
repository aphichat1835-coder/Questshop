import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  listRunnerStates,
  markInterruptedRunnerStates,
  RUNNER_STATE,
  transitionRunnerState,
} from '../src/quest/runner-state-store.js';

test.beforeEach(() => clearRunnerStatesForTests());

test('runner state persists lifecycle, quest and next action data', () => {
  beginRunnerState({
    jobKey: 'scheduled:1',
    ownerId: 'owner-1',
    accountId: 'account-1',
    username: 'runner',
    mode: 'scheduled',
    scheduleId: 1,
  });
  transitionRunnerState('scheduled:1', RUNNER_STATE.RUNNING_PROGRESS, {
    questId: 'quest-1',
    questName: 'Quest One',
    progress: 50,
    nextActionAt: '2030-01-01T00:00:00.000Z',
    lastError: 'temporary error',
    metadata: { source: 'test' },
  });

  const state = getRunnerState('scheduled:1');
  assert.equal(state.state, RUNNER_STATE.RUNNING_PROGRESS);
  assert.equal(state.quest_id, 'quest-1');
  assert.equal(state.quest_name, 'Quest One');
  assert.equal(state.progress, 50);
  assert.deepEqual(state.metadata, { source: 'test' });
});

test('partial transitions preserve omitted checkpoint and diagnostic fields', () => {
  beginRunnerState({
    jobKey: 'scheduled:partial',
    ownerId: 'owner-1',
    accountId: 'account-1',
    username: 'runner',
    mode: 'scheduled',
    scheduleId: 2,
  });
  transitionRunnerState('scheduled:partial', RUNNER_STATE.RUNNING_PROGRESS, {
    questId: 'quest-1',
    questName: 'Quest One',
    progress: 75,
    nextActionAt: '2030-01-01T00:05:00.000Z',
    retryCount: 2,
    lastError: 'network ambiguity',
    metadata: { reason: 'verification' },
  });

  const transitioned = transitionRunnerState('scheduled:partial', RUNNER_STATE.VERIFYING_COMPLETION);
  assert.equal(transitioned.quest_id, 'quest-1');
  assert.equal(transitioned.quest_name, 'Quest One');
  assert.equal(transitioned.progress, 75);
  assert.equal(transitioned.next_action_at, '2030-01-01T00:05:00.000Z');
  assert.equal(transitioned.retry_count, 2);
  assert.equal(transitioned.last_error, 'network ambiguity');
  assert.deepEqual(transitioned.metadata, { reason: 'verification' });
});

test('explicit null values still clear optional checkpoint fields', () => {
  beginRunnerState({ jobKey: 'clearable', ownerId: 'owner-1', mode: 'oneshot' });
  transitionRunnerState('clearable', RUNNER_STATE.RUNNING_PROGRESS, {
    questId: 'quest-1',
    progress: 20,
    lastError: 'old error',
    metadata: { source: 'old' },
  });
  const cleared = transitionRunnerState('clearable', RUNNER_STATE.RUNNING, {
    questId: null,
    progress: null,
    lastError: null,
    metadata: null,
  });
  assert.equal(cleared.quest_id, null);
  assert.equal(cleared.progress, null);
  assert.equal(cleared.last_error, null);
  assert.equal(cleared.metadata, null);
});

test('direct transition creation requires owner and mode but has safe defaults', () => {
  const state = transitionRunnerState('direct-create', RUNNER_STATE.QUEUED, {
    ownerId: 'owner-1',
    mode: 'oneshot',
  });
  assert.equal(state.retry_count, 0);
  assert.equal(state.quest_id, null);
});

test('process restart recovers scheduled work and fails non-restorable one-shot work', () => {
  beginRunnerState({
    jobKey: 'scheduled:1',
    ownerId: 'owner-1',
    mode: 'scheduled',
    state: RUNNER_STATE.RUNNING_PROGRESS,
  });
  beginRunnerState({
    jobKey: 'oneshot:active',
    ownerId: 'owner-1',
    mode: 'oneshot',
    state: RUNNER_STATE.RUNNING_PROGRESS,
  });
  beginRunnerState({
    jobKey: 'oneshot:completed',
    ownerId: 'owner-1',
    mode: 'oneshot',
    state: RUNNER_STATE.COMPLETED,
  });

  const changed = markInterruptedRunnerStates(new Date('2030-01-01T00:00:00.000Z'));
  assert.equal(changed, 2);
  assert.equal(getRunnerState('scheduled:1').state, RUNNER_STATE.RECOVERING);
  const failedOneShot = getRunnerState('oneshot:active');
  assert.equal(failedOneShot.state, RUNNER_STATE.FAILED);
  assert.match(failedOneShot.last_error, /cannot be restored/);
  assert.ok(failedOneShot.completed_at);
  assert.equal(getRunnerState('oneshot:completed').state, RUNNER_STATE.COMPLETED);
});

test('worker recovery touches scheduled states only and leaves control one-shot states active', () => {
  beginRunnerState({
    jobKey: 'scheduled:worker',
    ownerId: 'owner-1',
    mode: 'scheduled',
    state: RUNNER_STATE.RUNNING_PROGRESS,
  });
  beginRunnerState({
    jobKey: 'oneshot:control',
    ownerId: 'owner-1',
    mode: 'oneshot',
    state: RUNNER_STATE.RUNNING_PROGRESS,
  });

  const changed = markInterruptedRunnerStates(
    new Date('2030-01-01T00:00:00.000Z'),
    { includeOneShot: false, includeScheduled: true },
  );

  assert.equal(changed, 1);
  assert.equal(getRunnerState('scheduled:worker').state, RUNNER_STATE.RECOVERING);
  assert.equal(getRunnerState('oneshot:control').state, RUNNER_STATE.RUNNING_PROGRESS);
});

test('control recovery fails interrupted one-shot work without changing worker scheduled state', () => {
  beginRunnerState({
    jobKey: 'scheduled:delegated',
    ownerId: 'owner-1',
    mode: 'scheduled',
    state: RUNNER_STATE.WAITING_SCHEDULE,
  });
  beginRunnerState({
    jobKey: 'oneshot:interrupted',
    ownerId: 'owner-1',
    mode: 'oneshot',
    state: RUNNER_STATE.RUNNING_PROGRESS,
  });

  const changed = markInterruptedRunnerStates(
    new Date('2030-01-01T00:00:00.000Z'),
    { includeOneShot: true, includeScheduled: false },
  );

  assert.equal(changed, 1);
  assert.equal(getRunnerState('scheduled:delegated').state, RUNNER_STATE.WAITING_SCHEDULE);
  assert.equal(getRunnerState('oneshot:interrupted').state, RUNNER_STATE.FAILED);
});

test('terminal states created directly include a completion timestamp', () => {
  const state = beginRunnerState({
    jobKey: 'terminal',
    ownerId: 'owner-1',
    mode: 'oneshot',
    state: RUNNER_STATE.STOPPED,
  });
  assert.ok(state.completed_at);
});

test('activeOnly excludes completed, stopped and failed rows', () => {
  for (const [jobKey, state] of [
    ['active', RUNNER_STATE.WAITING_SCHEDULE],
    ['completed', RUNNER_STATE.COMPLETED],
    ['stopped', RUNNER_STATE.STOPPED],
    ['failed', RUNNER_STATE.FAILED],
  ]) {
    beginRunnerState({ jobKey, ownerId: 'owner-1', mode: 'scheduled', state });
  }

  assert.deepEqual(
    listRunnerStates({ ownerId: 'owner-1', activeOnly: true }).map((row) => row.job_key),
    ['active'],
  );
});

import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/db.js';
import {
  clearRunnerCompletionObserversForTests,
  configureRunnerCompletionObserver,
  observeRunnerCompletion,
} from '../src/quest/runner-completion-observer.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  markRunnerMutationUncertain,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

const NOW = Date.parse('2030-01-01T00:00:00.000Z');

async function settleObserver() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test.beforeEach(() => {
  clearRunnerCompletionObserversForTests();
  clearRunnerStatesForTests();
});

test.after(() => {
  clearRunnerCompletionObserversForTests();
  clearRunnerStatesForTests();
});

test('transient recovery exit becomes WAITING_RETRY without losing mutation evidence', async () => {
  const jobKey = 'scheduled:completion-recovery-deferred';
  const scheduleId = 9951;
  beginRunnerState({
    jobKey,
    ownerId: 'completion-owner',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.RECOVERING,
  });
  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.VIDEO_PROGRESS,
    questId: 'completion-quest',
    payload: { timestamp: 20 },
  });
  markRunnerMutationUncertain(jobKey, new Error('temporary network failure'));

  configureRunnerCompletionObserver({
    getJob: () => ({ done: Promise.resolve() }),
    getScheduled: () => ({ id: scheduleId }),
    currentTime: () => NOW,
  });
  assert.equal(observeRunnerCompletion(jobKey, 'scheduled', scheduleId), true);
  assert.equal(observeRunnerCompletion(jobKey, 'scheduled', scheduleId), false);
  await settleObserver();

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
  assert.equal(state.next_action_at, '2030-01-01T00:05:00.000Z');
  assert.equal(state.mutation_kind, RUNNER_MUTATION_KIND.VIDEO_PROGRESS);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.UNCERTAIN);
  assert.equal(state.quest_id, 'completion-quest');
  assert.equal(state.state_source, 'runner-recovery-deferred');
  assert.equal(state.metadata.completion, 'recovery-deferred');
});

test('interrupted completion recovery fetch is deferred without mutation evidence', async () => {
  const jobKey = 'scheduled:completion-fetch-deferred';
  const scheduleId = 9956;
  beginRunnerState({
    jobKey,
    ownerId: 'completion-owner',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.FETCHING_QUESTS,
    metadata: {
      recoveryAction: 'VERIFY_COMPLETION',
      recoveryReason: 'resume-verifying-completion',
    },
  });

  configureRunnerCompletionObserver({
    getJob: () => ({ done: Promise.resolve() }),
    getScheduled: () => ({ id: scheduleId }),
    currentTime: () => NOW,
  });
  assert.equal(observeRunnerCompletion(jobKey, 'scheduled', scheduleId), true);
  await settleObserver();

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
  assert.equal(state.next_action_at, '2030-01-01T00:05:00.000Z');
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.NONE);
  assert.equal(state.state_source, 'runner-recovery-deferred');
  assert.equal(state.metadata.recoveryAction, 'VERIFY_COMPLETION');
  assert.equal(state.metadata.completion, 'recovery-deferred');
});

test('ordinary scheduled exit with an active schedule remains a FAILED lifecycle', async () => {
  const jobKey = 'scheduled:completion-unexpected-exit';
  const scheduleId = 9952;
  beginRunnerState({
    jobKey,
    ownerId: 'completion-owner',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.RUNNING,
  });
  configureRunnerCompletionObserver({
    getJob: () => ({ done: Promise.resolve() }),
    getScheduled: () => ({ id: scheduleId }),
    currentTime: () => NOW,
  });

  assert.equal(observeRunnerCompletion(jobKey, 'scheduled', scheduleId), true);
  await settleObserver();
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.FAILED);
  assert.equal(state.last_error, 'Scheduled runner exited while its persisted schedule was still active');
});

test('scheduled exit becomes STOPPED when its persisted row is gone', async () => {
  const jobKey = 'scheduled:completion-row-gone';
  const scheduleId = 9953;
  beginRunnerState({
    jobKey,
    ownerId: 'completion-owner',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.RUNNING,
  });
  configureRunnerCompletionObserver({
    getJob: () => ({ done: Promise.resolve() }),
    getScheduled: () => null,
    currentTime: () => NOW,
  });

  assert.equal(observeRunnerCompletion(jobKey, 'scheduled', scheduleId), true);
  await settleObserver();
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.STOPPED);
});

test('rejected runner promises remain terminal failures', async () => {
  const jobKey = 'scheduled:completion-rejected';
  const scheduleId = 9954;
  beginRunnerState({
    jobKey,
    ownerId: 'completion-owner',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.RECOVERING,
  });
  configureRunnerCompletionObserver({
    getJob: () => ({ done: Promise.reject(new Error('cleanup exploded')) }),
    getScheduled: () => ({ id: scheduleId }),
    currentTime: () => NOW,
  });

  assert.equal(observeRunnerCompletion(jobKey, 'scheduled', scheduleId), true);
  await settleObserver();
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.FAILED);
  assert.equal(state.last_error, 'cleanup exploded');
  assert.equal(state.metadata.completion, 'runner-promise-rejected');
});

test('durable transition failure is reported without an unhandled rejection', async () => {
  const jobKey = 'scheduled:completion-transition-failure';
  const scheduleId = 9955;
  const trigger = 'fail_completion_observer_transition';
  beginRunnerState({
    jobKey,
    ownerId: 'completion-owner',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.RUNNING,
  });
  db.exec(`
    CREATE TRIGGER ${trigger}
    BEFORE UPDATE OF state ON runner_states
    WHEN NEW.job_key = '${jobKey}'
    BEGIN
      SELECT RAISE(FAIL, 'completion state unavailable');
    END;
  `);

  const reported = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    configureRunnerCompletionObserver({
      getJob: () => ({ done: Promise.resolve() }),
      getScheduled: () => ({ id: scheduleId }),
      currentTime: () => NOW,
      reportError: (error, observedJobKey) => {
        reported.push({ message: error.message, jobKey: observedJobKey });
      },
    });

    assert.equal(observeRunnerCompletion(jobKey, 'scheduled', scheduleId), true);
    await settleObserver();
    assert.deepEqual(reported, [{
      message: 'completion state unavailable',
      jobKey,
    }]);
    assert.deepEqual(unhandled, []);
    assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.RUNNING);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
});

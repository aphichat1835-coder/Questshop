import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeVerifiedMutation } from '../src/mutation-retry.js';
import {
  clearRunnerExecutionContextsForTests,
  registerRunnerExecution,
  runWithRunnerExecutionContext,
} from '../src/quest/runner-execution-context.js';
import {
  beginRunnerState,
  getRunnerState,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
} from '../src/quest/runner-state-store.js';

test.beforeEach(clearRunnerExecutionContextsForTests);
test.afterEach(clearRunnerExecutionContextsForTests);

test('verification transport failure preserves the uncertain mutation checkpoint', async () => {
  const jobKey = 'oneshot:verification-failure-preserves-uncertain';
  beginRunnerState({
    jobKey,
    ownerId: 'verification-owner',
    accountId: 'verification-account',
    mode: 'oneshot',
  });
  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.ENROLL,
    questId: 'verification-quest',
    payload: { location: 11 },
  });
  const registration = registerRunnerExecution({
    jobKey,
    ownerId: 'verification-owner',
    accountId: 'verification-account',
    userToken: 'verification-token',
    mode: 'oneshot',
  });
  const mutationError = Object.assign(new Error('response lost'), { status: 500 });
  const verificationError = Object.assign(new Error('fresh read timed out'), {
    code: 'ETIMEDOUT',
  });

  try {
    await assert.rejects(
      runWithRunnerExecutionContext(registration.context, () => executeVerifiedMutation({
        perform: async () => { throw mutationError; },
        verify: async () => { throw verificationError; },
        wait: async () => {},
      })),
      (error) => error === verificationError,
    );

    const state = getRunnerState(jobKey);
    assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.UNCERTAIN);
    assert.equal(state.mutation_kind, RUNNER_MUTATION_KIND.ENROLL);
    assert.equal(state.quest_id, 'verification-quest');
    assert.notEqual(state.mutation_status, RUNNER_MUTATION_STATUS.FAILED);
  } finally {
    registration.release();
  }
});

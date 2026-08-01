import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerRunnerExecution,
} from '../src/quest/runner-execution-context.js';
import {
  assertRunnerMutationOwnership,
  RunnerOwnershipLostError,
} from '../src/quest/runner-ownership-guard.js';
import {
  acquireScheduledRunnerClaim,
  releaseScheduledRunnerClaim,
} from '../src/quest/scheduled-worker-claims.js';

test('scheduled worker mutation requires the active claim holder', () => {
  const scheduleId = 910001;
  const now = Date.now();
  const registration = registerRunnerExecution({
    jobKey: `scheduled:${scheduleId}`,
    ownerId: 'ownership-owner-a',
    userToken: 'ownership-token-a',
    mode: 'scheduled',
    scheduleId,
    workerHolder: 'worker-a',
  });

  try {
    assert.equal(acquireScheduledRunnerClaim(scheduleId, 'worker-a', 90_000, now), true);
    assert.equal(assertRunnerMutationOwnership(`scheduled:${scheduleId}`, now + 1), true);

    assert.equal(releaseScheduledRunnerClaim(scheduleId, 'worker-a'), true);
    assert.equal(acquireScheduledRunnerClaim(scheduleId, 'worker-b', 90_000, now + 2), true);
    assert.throws(
      () => assertRunnerMutationOwnership(`scheduled:${scheduleId}`, now + 3),
      (error) => error instanceof RunnerOwnershipLostError
        && error.code === 'RUNNER_OWNERSHIP_LOST',
    );
  } finally {
    releaseScheduledRunnerClaim(scheduleId, 'worker-a');
    releaseScheduledRunnerClaim(scheduleId, 'worker-b');
    registration.release();
  }
});

test('all-in-one and one-shot runners do not require worker claims', () => {
  const registration = registerRunnerExecution({
    jobKey: 'oneshot:ownership-no-claim',
    ownerId: 'ownership-owner-b',
    userToken: 'ownership-token-b',
    mode: 'oneshot',
  });
  try {
    assert.equal(assertRunnerMutationOwnership('oneshot:ownership-no-claim'), true);
  } finally {
    registration.release();
  }
});

test('a queued mutation fails closed after its runner context is released', () => {
  const jobKey = 'scheduled:ownership-context-released';
  const registration = registerRunnerExecution({
    jobKey,
    ownerId: 'ownership-owner-c',
    userToken: 'ownership-token-c',
    mode: 'scheduled',
    scheduleId: 910002,
    workerHolder: 'worker-c',
  });
  registration.release();

  assert.throws(
    () => assertRunnerMutationOwnership(jobKey),
    (error) => error instanceof RunnerOwnershipLostError
      && error.code === 'RUNNER_OWNERSHIP_LOST'
      && error.jobKey === jobKey
      && error.scheduleId === null,
  );
});

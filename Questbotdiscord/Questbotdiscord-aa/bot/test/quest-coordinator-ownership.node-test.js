import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DiscordRateLimitCoordinator,
} from '../src/quest/rate-limit-coordinator.js';
import {
  registerRunnerExecution,
} from '../src/quest/runner-execution-context.js';
import {
  acquireScheduledRunnerClaim,
  releaseScheduledRunnerClaim,
} from '../src/quest/scheduled-worker-claims.js';
import {
  beginRunnerState,
  getRunnerState,
  RUNNER_MUTATION_STATUS,
} from '../src/quest/runner-state-store.js';

function response(status = 200, headers = {}, body = '{}') {
  return new Response(body, { status, headers });
}

test('coordinator rejects a mutation after scheduled ownership moves to another worker', async () => {
  const scheduleId = 910101;
  const jobKey = `scheduled:${scheduleId}`;
  const token = 'coordinator-owner-token';
  const now = Date.now();
  beginRunnerState({
    jobKey,
    ownerId: 'coordinator-owner',
    mode: 'scheduled',
    scheduleId,
  });
  const registration = registerRunnerExecution({
    jobKey,
    ownerId: 'coordinator-owner',
    userToken: token,
    mode: 'scheduled',
    scheduleId,
    workerHolder: 'worker-owner-a',
  });
  let executed = 0;

  try {
    assert.equal(acquireScheduledRunnerClaim(scheduleId, 'worker-owner-a', 90_000, now), true);
    assert.equal(releaseScheduledRunnerClaim(scheduleId, 'worker-owner-a'), true);
    assert.equal(acquireScheduledRunnerClaim(scheduleId, 'worker-owner-b', 90_000, now + 1), true);

    const coordinator = new DiscordRateLimitCoordinator();
    await assert.rejects(
      coordinator.schedule('https://discord.com/api/v10/quests/quest-owner/heartbeat', {
        method: 'POST',
        headers: { Authorization: token },
        body: JSON.stringify({ terminal: false }),
      }, async () => {
        executed++;
        return response();
      }),
      (error) => error?.code === 'RUNNER_OWNERSHIP_LOST',
    );

    assert.equal(executed, 0);
    assert.equal(coordinator.snapshot().ownershipLosses, 1);
    assert.equal(getRunnerState(jobKey).mutation_status, RUNNER_MUTATION_STATUS.NONE);
  } finally {
    releaseScheduledRunnerClaim(scheduleId, 'worker-owner-a');
    releaseScheduledRunnerClaim(scheduleId, 'worker-owner-b');
    registration.release();
  }
});

test('429 without retry headers still blocks its shared bucket with a safe fallback', async () => {
  const coordinator = new DiscordRateLimitCoordinator();
  await coordinator.schedule('https://discord.com/api/v10/quests/@me', {
    headers: { Authorization: 'coordinator-429-fallback' },
  }, async () => response(429));

  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.rateLimited, 1);
  assert.equal(snapshot.blockedBuckets, 1);
});

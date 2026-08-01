import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeVerifiedMutation } from '../src/mutation-retry.js';
import { DiscordRateLimitCoordinator } from '../src/quest/rate-limit-coordinator.js';
import {
  clearRunnerExecutionContextsForTests,
  registerRunnerExecution,
} from '../src/quest/runner-execution-context.js';
import {
  beginRunnerState,
  getRunnerState,
  RUNNER_MUTATION_STATUS,
} from '../src/quest/runner-state-store.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test.beforeEach(clearRunnerExecutionContextsForTests);
test.afterEach(clearRunnerExecutionContextsForTests);

test('fresh NOT_APPLIED evidence unlocks exactly one controlled retry through the coordinator', async () => {
  const token = 'controlled-retry-account';
  const jobKey = 'oneshot:controlled-retry-integration';
  const questId = 'controlled-retry-quest';
  beginRunnerState({
    jobKey,
    ownerId: 'controlled-retry-owner',
    accountId: 'controlled-retry-account-id',
    mode: 'oneshot',
  });
  const registration = registerRunnerExecution({
    jobKey,
    ownerId: 'controlled-retry-owner',
    userToken: token,
    accountId: 'controlled-retry-account-id',
    mode: 'oneshot',
  });
  const coordinator = new DiscordRateLimitCoordinator();
  let mutationAttempts = 0;
  let serverProgress = 0;

  const mutation = async () => {
    const response = await coordinator.schedule(
      `https://discord.com/api/v9/quests/${questId}/video-progress`,
      {
        method: 'POST',
        headers: { Authorization: token },
        body: JSON.stringify({ timestamp: 10 }),
      },
      async () => {
        mutationAttempts++;
        if (mutationAttempts === 1) return jsonResponse({ message: 'temporary failure' }, 500);
        serverProgress = 10;
        return jsonResponse({ ok: true });
      },
    );
    if (!response.ok) {
      const error = new Error(`Discord API ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  };

  const verify = async () => {
    const response = await coordinator.schedule(
      'https://discord.com/api/v9/quests/@me',
      { headers: { Authorization: token } },
      async () => jsonResponse({
        quests: [{
          id: questId,
          config: {},
          user_status: {
            progress: { WATCH_VIDEO: { value: serverProgress } },
          },
        }],
      }),
    );
    const payload = await response.json();
    return payload.quests[0].user_status.progress.WATCH_VIDEO.value >= 10;
  };

  try {
    await executeVerifiedMutation({
      perform: mutation,
      verify,
      wait: async () => {},
    });

    assert.equal(mutationAttempts, 2);
    assert.equal(serverProgress, 10);
    assert.equal(getRunnerState(jobKey).mutation_status, RUNNER_MUTATION_STATUS.ACCEPTED);
    assert.equal(coordinator.snapshot().blockedMutationJobs, 1);

    assert.equal(await verify(), true);
    assert.equal(getRunnerState(jobKey).mutation_status, RUNNER_MUTATION_STATUS.VERIFIED);
    assert.equal(coordinator.snapshot().blockedMutationJobs, 0);
  } finally {
    registration.release();
  }
});

test('ACCEPTED mutation remains blocked when fresh state is not visible yet', async () => {
  const token = 'accepted-eventual-account';
  const jobKey = 'oneshot:accepted-eventual-integration';
  const questId = 'accepted-eventual-quest';
  beginRunnerState({
    jobKey,
    ownerId: 'accepted-eventual-owner',
    accountId: 'accepted-eventual-account-id',
    mode: 'oneshot',
  });
  const registration = registerRunnerExecution({
    jobKey,
    ownerId: 'accepted-eventual-owner',
    userToken: token,
    accountId: 'accepted-eventual-account-id',
    mode: 'oneshot',
  });
  const coordinator = new DiscordRateLimitCoordinator();

  try {
    const mutation = await coordinator.schedule(
      `https://discord.com/api/v9/quests/${questId}/video-progress`,
      {
        method: 'POST',
        headers: { Authorization: token },
        body: JSON.stringify({ timestamp: 10 }),
      },
      async () => jsonResponse({ ok: true }),
    );
    assert.equal(mutation.status, 200);

    const stale = await coordinator.schedule(
      'https://discord.com/api/v9/quests/@me',
      { headers: { Authorization: token } },
      async () => jsonResponse({
        quests: [{
          id: questId,
          config: {},
          user_status: { progress: { WATCH_VIDEO: { value: 0 } } },
        }],
      }),
    );
    await stale.json();

    assert.equal(getRunnerState(jobKey).mutation_status, RUNNER_MUTATION_STATUS.ACCEPTED);
    assert.equal(coordinator.snapshot().blockedMutationJobs, 1);
    await assert.rejects(
      coordinator.schedule(
        `https://discord.com/api/v9/quests/${questId}/heartbeat`,
        {
          method: 'POST',
          headers: { Authorization: token },
          body: JSON.stringify({ terminal: false }),
        },
        async () => jsonResponse({ ok: true }),
      ),
      (error) => error?.code === 'RUNNER_MUTATION_REQUIRES_VERIFICATION',
    );
  } finally {
    registration.release();
  }
});

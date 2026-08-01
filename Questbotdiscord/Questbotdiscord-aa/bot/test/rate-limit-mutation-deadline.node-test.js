import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordRateLimitCoordinator } from '../src/quest/rate-limit-coordinator.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  markRunnerMutationInFlight,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

test.beforeEach(clearRunnerStatesForTests);
test.afterEach(clearRunnerStatesForTests);

test('mutating 429 preserves Discord Retry-After as the final durable deadline', async () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const retryAfterSeconds = 30;
  const expectedRetryAt = new Date(now + retryAfterSeconds * 1000).toISOString();
  const jobKey = 'oneshot:mutation-rate-limit-deadline';
  const questId = 'rate-limit-quest';
  const coordinator = new DiscordRateLimitCoordinator({ now: () => now });

  beginRunnerState({
    jobKey,
    ownerId: 'rate-limit-owner',
    accountId: 'rate-limit-account',
    mode: 'oneshot',
    state: RUNNER_STATE.RUNNING,
  });
  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.ENROLL,
    questId,
    payload: { location: 11 },
  });
  markRunnerMutationInFlight(jobKey, new Date(now));

  const response = new Response(JSON.stringify({ retry_after: retryAfterSeconds }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(retryAfterSeconds),
      'x-ratelimit-global': 'true',
    },
  });
  const handled = await coordinator.handleResponse({
    account: 'rate-limit-account-fingerprint',
    jobKey,
    mutation: {
      kind: RUNNER_MUTATION_KIND.ENROLL,
      questId,
      payload: { location: 11 },
    },
    method: 'POST',
    route: 'POST:/quests/:questId/enroll',
    url: `https://discord.com/api/v9/quests/${questId}/enroll`,
  }, response);

  assert.equal(handled, response);
  const state = getRunnerState(jobKey);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.UNCERTAIN);
  assert.equal(state.state, RUNNER_STATE.WAITING_RATE_LIMIT);
  assert.equal(state.next_action_at, expectedRetryAt);
  assert.equal(state.state_source, 'rate-limit:global');
  assert.equal(coordinator.snapshot().globalBlockedUntil, expectedRetryAt);
});

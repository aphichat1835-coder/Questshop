import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordRateLimitCoordinator } from '../src/quest/rate-limit-coordinator.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

test.beforeEach(clearRunnerStatesForTests);
test.afterEach(clearRunnerStatesForTests);

test('global 429 without remaining header persists the exact wait deadline', async () => {
  const now = 10_000;
  const jobKey = 'scheduled:global-rate-limit-audit';
  beginRunnerState({
    jobKey,
    ownerId: 'owner-global-rate-limit',
    mode: 'scheduled',
    scheduleId: 7001,
    state: RUNNER_STATE.RUNNING,
  });
  const coordinator = new DiscordRateLimitCoordinator({ now: () => now });

  await coordinator.updateRateLimitState({
    account: 'global-rate-limit-account',
    jobKey,
    method: 'GET',
    route: 'GET:/quests/@me',
    url: 'https://discord.com/api/v10/quests/@me',
  }, {
    status: 429,
    headers: new Headers({
      'x-ratelimit-global': 'true',
      'x-ratelimit-scope': 'global',
      'retry-after': '120',
    }),
  });

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_RATE_LIMIT);
  assert.equal(state.next_action_at, new Date(now + 120_000).toISOString());
  assert.equal(state.state_source, 'rate-limit:global');
});

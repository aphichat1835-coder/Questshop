import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordRateLimitCoordinator } from '../src/quest/rate-limit-coordinator.js';

function task(overrides = {}) {
  return {
    account: 'rate-limit-audit-account-a',
    jobKey: null,
    method: 'GET',
    route: 'GET:/quests/@me',
    url: 'https://discord.com/api/v10/quests/@me',
    ...overrides,
  };
}

test('one non-global 429 records one bucket reset even when remaining is zero', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ now: () => 10_000 });
  const calls = [];
  const original = coordinator.setBucketReset.bind(coordinator);
  coordinator.setBucketReset = (...args) => {
    calls.push(args);
    return original(...args);
  };

  await coordinator.updateRateLimitState(task(), {
    status: 429,
    headers: new Headers({
      'x-ratelimit-bucket': 'audit-bucket',
      'x-ratelimit-scope': 'shared',
      'x-ratelimit-remaining': '0',
      'retry-after': '30',
    }),
  });

  assert.equal(calls.length, 1);
  assert.equal(coordinator.bucketResetAt.get('audit-bucket'), 40_000);
});

test('a later shorter shared reset cannot shorten an existing bucket block', () => {
  let now = 1_000;
  const coordinator = new DiscordRateLimitCoordinator({ now: () => now });
  const currentTask = task();

  coordinator.setBucketReset(currentTask, 'audit-bucket', 120_000, 'shared');
  now = 2_000;
  coordinator.setBucketReset(currentTask, 'audit-bucket', 1_000, 'shared');

  assert.equal(coordinator.bucketResetAt.get('audit-bucket'), 121_000);
});

test('global-scope circuits are shared across authorization fingerprints', () => {
  const coordinator = new DiscordRateLimitCoordinator({
    now: () => 1_000,
    circuitFailureThreshold: 1,
    circuitOpenMs: 30_000,
    circuitMaxOpenMs: 30_000,
  });
  coordinator.routeBuckets.set('GET:/quests/@me', 'global-bucket');
  coordinator.routeScopes.set('GET:/quests/@me', 'global');

  coordinator.recordCircuitFailure(task({ account: 'account-a' }));

  assert.ok(coordinator.circuitBlockedUntil(task({ account: 'account-b' })) > 1_000);
});

test('route-to-bucket remapping migrates and closes the previous circuit', async () => {
  const coordinator = new DiscordRateLimitCoordinator({
    now: () => 1_000,
    circuitFailureThreshold: 1,
    circuitOpenMs: 30_000,
    circuitMaxOpenMs: 30_000,
  });
  const currentTask = task();
  coordinator.recordCircuitFailure(currentTask);
  assert.equal(coordinator.snapshot().openCircuits, 1);

  const response = {
    status: 200,
    headers: new Headers({
      'x-ratelimit-bucket': 'resolved-bucket',
      'x-ratelimit-scope': 'shared',
      'x-ratelimit-remaining': '4',
    }),
  };
  await coordinator.updateRateLimitState(currentTask, response);
  coordinator.updateCircuitFromResponse(currentTask, response);

  assert.equal(coordinator.snapshot().openCircuits, 0);
  assert.equal(coordinator.circuits.has('shared:GET:/quests/@me'), false);
});

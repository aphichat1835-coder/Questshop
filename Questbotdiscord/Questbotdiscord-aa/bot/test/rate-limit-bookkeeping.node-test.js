import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordRateLimitCoordinator } from '../src/quest/rate-limit-coordinator.js';

test('circuit accounting still runs when rate-limit bookkeeping throws', async () => {
  const coordinator = new DiscordRateLimitCoordinator({
    circuitFailureThreshold: 1,
    circuitOpenMs: 30_000,
    circuitMaxOpenMs: 30_000,
  });
  coordinator.updateRateLimitState = async () => {
    throw new Error('durable rate-limit state unavailable');
  };

  const response = await coordinator.schedule(
    'https://discord.com/api/v10/quests/@me',
    { headers: { Authorization: 'bookkeeping-circuit-token' } },
    async () => new Response('{}', { status: 500 }),
  );

  assert.equal(response.status, 500);
  const status = coordinator.snapshot();
  assert.equal(status.bookkeepingErrors, 1);
  assert.equal(status.circuitOpens, 1);
  assert.equal(status.openCircuits, 1);
});

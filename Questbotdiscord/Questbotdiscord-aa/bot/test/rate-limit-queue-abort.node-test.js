import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordRateLimitCoordinator } from '../src/quest/rate-limit-coordinator.js';

function response() {
  return new Response('{}', { status: 200 });
}

test('aborting a blocked request removes it from the queue without executing transport', async () => {
  const coordinator = new DiscordRateLimitCoordinator();
  const controller = new AbortController();
  const now = Date.now();
  let executed = false;

  coordinator.routeBuckets.set('GET:/blocked', 'bucket-blocked');
  coordinator.routeLastSeenAt.set('GET:/blocked', now);
  coordinator.bucketResetAt.set('bucket-blocked', now + 10 * 60_000);

  const pending = coordinator.schedule('https://discord.com/api/v10/blocked', {
    headers: { Authorization: 'queued-abort-account' },
    signal: controller.signal,
  }, async () => {
    executed = true;
    return response();
  });

  assert.equal(coordinator.snapshot().queued, 1);
  controller.abort();

  await assert.rejects(
    pending,
    (error) => error?.name === 'AbortError' && error?.message === 'aborted',
  );
  assert.equal(executed, false);
  assert.equal(coordinator.snapshot().queued, 0);
  assert.equal(coordinator.snapshot().active, 0);
});

test('an already-aborted request is rejected before entering the queue', async () => {
  const coordinator = new DiscordRateLimitCoordinator();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    coordinator.schedule('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: 'already-aborted-account' },
      signal: controller.signal,
    }, async () => response()),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(coordinator.snapshot().queued, 0);
});
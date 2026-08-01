import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordRateLimitCoordinator } from '../src/quest/rate-limit-coordinator.js';

function response(status = 200) {
  return new Response('{}', { status });
}

async function settleWithin(promise, timeoutMs = 250) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Coordinator request did not settle after cleanup')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('successful caller resumes only after its active slot is released', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 1 });
  const url = 'https://example.test/resource';
  let executions = 0;

  const first = await coordinator.schedule(url, {}, async () => {
    executions++;
    return response();
  });

  assert.equal(first.status, 200);
  assert.equal(coordinator.snapshot().active, 0);
  assert.equal(coordinator.snapshot().queued, 0);

  const second = await settleWithin(coordinator.schedule(url, {}, async () => {
    executions++;
    return response();
  }));

  assert.equal(second.status, 200);
  assert.equal(executions, 2);
  assert.equal(coordinator.snapshot().active, 0);
  assert.equal(coordinator.snapshot().queued, 0);
});

test('failed caller resumes only after cleanup and the same slot can run again', async () => {
  const coordinator = new DiscordRateLimitCoordinator({
    maxConcurrency: 1,
    circuitFailureThreshold: 10,
  });
  const url = 'https://example.test/resource';

  await assert.rejects(
    settleWithin(coordinator.schedule(url, {}, async () => {
      throw new Error('transport failed');
    })),
    /transport failed/,
  );

  assert.equal(coordinator.snapshot().active, 0);
  assert.equal(coordinator.snapshot().queued, 0);

  const recovered = await settleWithin(coordinator.schedule(url, {}, async () => response()));
  assert.equal(recovered.status, 200);
  assert.equal(coordinator.snapshot().active, 0);
  assert.equal(coordinator.snapshot().queued, 0);
});

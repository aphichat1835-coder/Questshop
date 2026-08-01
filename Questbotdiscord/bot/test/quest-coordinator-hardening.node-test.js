import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizationFingerprint,
  DiscordRateLimitCoordinator,
} from '../src/quest/rate-limit-coordinator.js';
import {
  clearRunnerExecutionContextsForTests,
  registerRunnerExecution,
} from '../src/quest/runner-execution-context.js';
import {
  beginRunnerState,
  getRunnerState,
  RUNNER_MUTATION_STATUS,
} from '../src/quest/runner-state-store.js';
import {
  clearScheduleHint,
  clearScheduleHintsForTests,
  getLatestScheduleHint,
  listScheduleHints,
  publishScheduleHint,
} from '../src/quest/schedule-hint-bus.js';
import { chooseNextQuestAction } from '../src/quest/smart-scheduler.js';

function response(status = 200, headers = {}, body = '{}') {
  return new Response(body, { status, headers });
}

test.beforeEach(() => {
  clearScheduleHintsForTests();
  clearRunnerExecutionContextsForTests();
});

test('hint sources coexist so a baseline update cannot erase an urgent claim', () => {
  const now = Date.now();
  publishScheduleHint('hardening-account-1', {
    nextActionAt: new Date(now + 10 * 60_000).toISOString(),
    reason: 'claim:quest-1',
    priority: 100,
    source: 'quest-list',
  });
  publishScheduleHint('hardening-account-1', {
    nextActionAt: new Date(now + 60_000).toISOString(),
    reason: 'baseline',
    priority: 10,
    source: 'baseline',
  });

  assert.equal(listScheduleHints('hardening-account-1').length, 2);
  assert.equal(getLatestScheduleHint('hardening-account-1').reason, 'claim:quest-1');
  assert.equal(clearScheduleHint('hardening-account-1', 'quest-list'), true);
  assert.equal(getLatestScheduleHint('hardening-account-1').reason, 'baseline');
});

test('scheduler considers rate limit recovery and stalled progress inputs', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  const result = chooseNextQuestAction({
    now,
    rateLimitAt: '2030-01-01T00:05:00.000Z',
    progressStallAt: '2030-01-01T00:01:00.000Z',
    fallbackAt: '2030-01-01T08:00:00.000Z',
  });
  assert.equal(result.reason, 'rate-limit');
  assert.equal(result.priority, 98);
  assert.equal(result.source, 'rate-limit');
});

test('user-scoped bucket blocks only the matching authorization fingerprint', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 2 });
  const route = 'GET:/quests/@me';
  const bucket = 'bucket-user';
  const tokenA = 'scope-account-a';
  const tokenB = 'scope-account-b';
  const startedAt = Date.now();
  const order = [];
  coordinator.routeBuckets.set(route, bucket);
  coordinator.routeScopes.set(route, 'user');
  coordinator.routeLastSeenAt.set(route, startedAt);
  coordinator.accountBucketResetAt.set(
    `${authorizationFingerprint(tokenA)}:${bucket}`,
    startedAt + 40,
  );

  const blocked = coordinator.schedule('https://discord.com/api/v10/quests/@me', {
    headers: { Authorization: tokenA },
  }, async () => {
    order.push(['a', Date.now() - startedAt]);
    return response();
  });
  const free = coordinator.schedule('https://discord.com/api/v10/quests/@me', {
    headers: { Authorization: tokenB },
  }, async () => {
    order.push(['b', Date.now() - startedAt]);
    return response();
  });

  await Promise.all([blocked, free]);
  assert.equal(order[0][0], 'b');
  assert.ok(order.find(([name]) => name === 'a')[1] >= 25);
});

test('retry_after response body blocks the next request when headers are absent', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 1 });
  const started = [];
  const first = coordinator.schedule('https://discord.com/api/v10/quests/@me', {
    headers: { Authorization: 'body-delay-a' },
  }, async () => {
    started.push(Date.now());
    return response(429, { 'content-type': 'application/json' }, JSON.stringify({ retry_after: 0.03 }));
  });
  const second = coordinator.schedule('https://discord.com/api/v10/quests/@me', {
    headers: { Authorization: 'body-delay-b' },
  }, async () => {
    started.push(Date.now());
    return response();
  });

  await Promise.all([first, second]);
  assert.ok(started[1] - started[0] >= 20);
});

test('circuit breaker opens after repeated server failures and permits one delayed probe', async () => {
  const coordinator = new DiscordRateLimitCoordinator({
    maxConcurrency: 1,
    circuitFailureThreshold: 2,
    circuitOpenMs: 30,
    circuitMaxOpenMs: 30,
  });
  const url = 'https://discord.com/api/v10/quests/@me';
  const options = { headers: { Authorization: 'circuit-account' } };
  await coordinator.schedule(url, options, async () => response(500));
  await coordinator.schedule(url, options, async () => response(500));
  assert.equal(coordinator.snapshot().openCircuits, 1);

  // Hold the cooldown with a test-owned referenced timer. Queue timer behaviour
  // is covered separately by the bucket and global-rate-limit tests; this case
  // focuses on the single HALF_OPEN probe and circuit closure contract.
  await new Promise((resolve) => setTimeout(resolve, 35));
  let probes = 0;
  await coordinator.schedule(url, options, async () => {
    probes++;
    return response(200);
  });
  assert.equal(probes, 1);
  assert.equal(coordinator.snapshot().openCircuits, 0);
  assert.equal(coordinator.snapshot().halfOpenCircuits, 0);
  assert.equal(coordinator.snapshot().circuitOpens, 1);
});

test('coordinator blocks another mutation until fresh Quest verification completes', async () => {
  const token = 'checkpoint-account';
  const jobKey = 'scheduled:coordinator-hardening-checkpoint';
  beginRunnerState({ jobKey, ownerId: 'owner-hardening', mode: 'scheduled', scheduleId: 9201 });
  const registration = registerRunnerExecution({
    jobKey,
    ownerId: 'owner-hardening',
    userToken: token,
    mode: 'scheduled',
    scheduleId: 9201,
  });
  const coordinator = new DiscordRateLimitCoordinator();
  const mutationUrl = 'https://discord.com/api/v10/quests/quest-1/video-progress';

  try {
    await coordinator.schedule(mutationUrl, {
      method: 'POST',
      headers: { Authorization: token },
      body: JSON.stringify({ timestamp: 10, captcha_key: 'do-not-store' }),
    }, async () => response(200));

    let state = getRunnerState(jobKey);
    assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.ACCEPTED);
    assert.equal(state.quest_id, 'quest-1');
    assert.deepEqual(state.mutation_payload, { timestamp: 10 });
    assert.equal(coordinator.snapshot().blockedMutationJobs, 1);

    await assert.rejects(
      coordinator.schedule('https://discord.com/api/v10/quests/quest-1/heartbeat', {
        method: 'POST',
        headers: { Authorization: token },
        body: JSON.stringify({ terminal: false }),
      }, async () => response(200)),
      (error) => error?.code === 'RUNNER_MUTATION_REQUIRES_VERIFICATION',
    );

    const staleResult = await coordinator.schedule('https://discord.com/api/v10/quests/@me', {
      headers: { Authorization: token },
    }, async () => response(200, { 'content-type': 'application/json' }, JSON.stringify({
      quests: [{
        id: 'quest-1',
        config: {},
        user_status: { progress: { WATCH_VIDEO: { value: 5 } } },
      }],
    })));
    await staleResult.json();
    assert.equal(getRunnerState(jobKey).mutation_status, RUNNER_MUTATION_STATUS.ACCEPTED);
    assert.equal(coordinator.snapshot().blockedMutationJobs, 1);

    const verifiedResult = await coordinator.schedule('https://discord.com/api/v10/quests/@me', {
      headers: { Authorization: token },
    }, async () => response(200, { 'content-type': 'application/json' }, JSON.stringify({
      quests: [{
        id: 'quest-1',
        config: {},
        user_status: { progress: { WATCH_VIDEO: { value: 10 } } },
      }],
    })));
    await verifiedResult.json();

    state = getRunnerState(jobKey);
    assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.VERIFIED);
    assert.equal(state.server_progress_seconds, 10);
    assert.equal(coordinator.snapshot().blockedMutationJobs, 0);

    const nextMutation = await coordinator.schedule('https://discord.com/api/v10/quests/quest-1/heartbeat', {
      method: 'POST',
      headers: { Authorization: token },
      body: JSON.stringify({ terminal: false }),
    }, async () => response(400));
    assert.equal(nextMutation.status, 400);
  } finally {
    registration.release();
  }
});

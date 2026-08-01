import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCORD_API_VERSION,
  installDiscordApiRuntime,
  uninstallDiscordApiRuntime,
} from '../src/quest/discord-api-runtime.js';
import {
  authorizationFingerprint,
  DiscordRateLimitCoordinator,
} from '../src/quest/rate-limit-coordinator.js';
import {
  clearScheduleHintsForTests,
  getLatestScheduleHint,
} from '../src/quest/schedule-hint-bus.js';

function response(status = 200, headers = {}) {
  return new Response('{}', { status, headers });
}

function fetchInputUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new TypeError('Unsupported fetch input');
}

test('Discord API runtime coordinates older versioned URLs without rewriting them', async () => {
  const calls = [];
  installDiscordApiRuntime({
    fetchFn: async (input) => {
      calls.push(fetchInputUrl(input));
      return response();
    },
  });

  try {
    await globalThis.fetch('https://discord.com/api/v9/users/@me', {
      headers: { Authorization: 'fixture-user-token' },
    });
    assert.equal(DISCORD_API_VERSION, 10);
    assert.equal(calls[0], 'https://discord.com/api/v9/users/@me');
  } finally {
    uninstallDiscordApiRuntime();
  }
});

test('Request input method and requested API version reach the coordinator unchanged', async () => {
  const scheduled = [];
  const transported = [];
  const coordinator = {
    async schedule(url, options, execute) {
      scheduled.push({ url, method: options.method });
      return execute();
    },
  };
  installDiscordApiRuntime({
    coordinator,
    fetchFn: async (input) => {
      transported.push({ url: input.url, method: input.method });
      return response();
    },
  });

  try {
    const request = new Request('https://discord.com/api/v9/quests/quest-1/claim-reward', {
      method: 'POST',
      headers: { Authorization: 'request-account' },
      body: '{}',
    });
    await globalThis.fetch(request);
    assert.deepEqual(scheduled, [{
      url: 'https://discord.com/api/v9/quests/quest-1/claim-reward',
      method: 'POST',
    }]);
    assert.deepEqual(transported, [{
      url: 'https://discord.com/api/v9/quests/quest-1/claim-reward',
      method: 'POST',
    }]);
  } finally {
    uninstallDiscordApiRuntime();
  }
});

test('non-Discord traffic is not coordinated', async () => {
  const calls = [];
  installDiscordApiRuntime({
    fetchFn: async (input) => {
      calls.push(fetchInputUrl(input));
      return response();
    },
  });

  try {
    await globalThis.fetch('https://example.com/api/v9/health');
    assert.deepEqual(calls, ['https://example.com/api/v9/health']);
  } finally {
    uninstallDiscordApiRuntime();
  }
});

test('coordinator never runs two requests for the same account concurrently', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 4 });
  let active = 0;
  let maximum = 0;
  const execute = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return response();
  };

  await Promise.all([
    coordinator.schedule('https://discord.com/api/v10/quests/@me', {
      headers: { Authorization: 'same-account' },
    }, execute),
    coordinator.schedule('https://discord.com/api/v10/quests/@me', {
      headers: { Authorization: 'same-account' },
    }, execute),
  ]);

  assert.equal(maximum, 1);
});

test('quest list and per-quest endpoints keep separate route bucket mappings', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 2 });

  await Promise.all([
    coordinator.schedule('https://discord.com/api/v10/quests/@me', {
      headers: { Authorization: 'list-account' },
    }, async () => response(200, { 'x-ratelimit-bucket': 'bucket-list' })),
    coordinator.schedule('https://discord.com/api/v10/quests/quest-123/heartbeat', {
      method: 'POST',
      headers: { Authorization: 'quest-account' },
    }, async () => response(200, { 'x-ratelimit-bucket': 'bucket-quest' })),
  ]);

  assert.equal(coordinator.snapshot().knownRoutes, 2);
  assert.equal(coordinator.routeBuckets.get('GET:/quests/@me'), 'bucket-list');
  assert.equal(
    coordinator.routeBuckets.get('POST:/quests/:questId/heartbeat'),
    'bucket-quest',
  );
});

test('global 429 pauses the next queued Discord request', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 1 });
  const started = [];
  const first = coordinator.schedule('https://discord.com/api/v10/quests/@me', {
    headers: { Authorization: 'account-a' },
  }, async () => {
    started.push(Date.now());
    return response(429, {
      'retry-after': '0.03',
      'x-ratelimit-global': 'true',
    });
  });
  const second = coordinator.schedule('https://discord.com/api/v10/quests/@me', {
    headers: { Authorization: 'account-b' },
  }, async () => {
    started.push(Date.now());
    return response();
  });

  await Promise.all([first, second]);
  assert.ok(started[1] - started[0] >= 20, `global pause was only ${started[1] - started[0]}ms`);
  assert.equal(coordinator.snapshot().globalRateLimits, 1);
});

test('an earlier blocked bucket replaces a later queue wakeup timer', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 2 });
  const startedAt = Date.now();
  const order = [];

  coordinator.routeBuckets.set('GET:/long', 'bucket-long');
  coordinator.routeLastSeenAt.set('GET:/long', startedAt);
  coordinator.bucketResetAt.set('bucket-long', startedAt + 10_000);
  const long = coordinator.schedule('https://discord.com/api/v10/long', {
    headers: { Authorization: 'account-long' },
  }, async () => {
    order.push(['long', Date.now() - startedAt]);
    return response();
  });

  coordinator.routeBuckets.set('GET:/short', 'bucket-short');
  coordinator.routeLastSeenAt.set('GET:/short', startedAt);
  coordinator.bucketResetAt.set('bucket-short', startedAt + 20);
  const short = coordinator.schedule('https://discord.com/api/v10/short', {
    headers: { Authorization: 'account-short' },
  }, async () => {
    order.push(['short', Date.now() - startedAt]);
    return response();
  });

  await short;
  assert.deepEqual(order.map(([name]) => name), ['short']);
  assert.ok(order[0][1] < 8_000, `short bucket started after ${order[0][1]}ms`);

  coordinator.bucketResetAt.set('bucket-long', 0);
  coordinator.pump();
  await long;
  assert.deepEqual(order.map(([name]) => name), ['short', 'long']);
});

test('coordinator settles the caller even when response bookkeeping throws', async () => {
  class ThrowingCoordinator extends DiscordRateLimitCoordinator {
    updateRateLimitState() {
      throw new Error('bookkeeping failed');
    }

    publishSchedule() {
      throw new Error('schedule publication failed');
    }
  }

  const coordinator = new ThrowingCoordinator();
  const result = await coordinator.schedule('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: 'account-a' },
  }, async () => response(200));

  assert.equal(result.status, 200);
  const status = coordinator.snapshot();
  assert.equal(status.bookkeepingErrors, 1);
  assert.equal(status.scheduleHintErrors, 1);
});

test('Quest list responses publish a smart hint without consuming the engine response body', async () => {
  clearScheduleHintsForTests();
  const token = 'schedule-hint-account';
  const coordinator = new DiscordRateLimitCoordinator();
  const result = await coordinator.schedule('https://discord.com/api/v10/quests/@me', {
    headers: { Authorization: token },
  }, async () => new Response(JSON.stringify({
    quests: [{
      id: 'claim-ready',
      config: {},
      user_status: { completed_at: '2030-01-01T00:00:00.000Z' },
    }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));

  const body = await result.json();
  assert.equal(body.quests[0].id, 'claim-ready');
  await new Promise((resolve) => setImmediate(resolve));
  const hint = getLatestScheduleHint(authorizationFingerprint(token));
  assert.equal(hint.reason, 'claim:claim-ready');
  assert.equal(hint.priority, 100);
});

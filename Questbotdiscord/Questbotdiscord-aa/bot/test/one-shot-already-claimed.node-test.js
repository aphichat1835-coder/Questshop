import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchInputUrl } from './fetch-input.js';

process.env.DATABASE_PATH = './test/.tmp/one-shot-already-claimed.db';

const {
  getUserJobs,
  shutdownRunners,
  startRunner,
} = await import('../src/discord-runner.js');

const originalFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockClient() {
  const message = { async edit() { return message; } };
  return {
    channels: {
      async fetch() {
        return {
          isTextBased: () => true,
          async send() { return message; },
        };
      },
    },
  };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for one-shot completion');
}

function questPayload({ completed, claimed }) {
  return {
    quests: [{
      id: 'already-claimed-after-progress',
      config: {
        messages: { quest_name: 'Already Claimed Quest' },
        rewards_config: { platforms: [0] },
        task_config: { tasks: { WATCH_VIDEO: { target: 1 } } },
      },
      user_status: {
        enrolled_at: '2026-01-01T00:00:00.000Z',
        completed_at: completed ? '2026-01-01T00:01:00.000Z' : null,
        claimed_at: claimed ? '2026-01-01T00:01:01.000Z' : null,
        progress: { WATCH_VIDEO: { value: completed ? 1 : 0 } },
      },
    }],
  };
}

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  await shutdownRunners(1000);
});

test('fresh already-claimed state completes one-shot without a duplicate claim mutation', async () => {
  let completed = false;
  let claimed = false;
  let progressRequests = 0;
  let claimRequests = 0;

  globalThis.fetch = async (input) => {
    const path = fetchInputUrl(input);
    if (path.endsWith('/quests/@me') || path.endsWith('/users/@me/quests')) {
      return jsonResponse(questPayload({ completed, claimed }));
    }
    if (path.endsWith('/video-progress')) {
      progressRequests++;
      completed = true;
      claimed = true;
      return jsonResponse({ ok: true });
    }
    if (path.endsWith('/claim-reward') || path.endsWith('/claim')) {
      claimRequests++;
      return jsonResponse({ message: 'already claimed' }, 409);
    }
    throw new Error(`Unexpected request path: ${path}`);
  };

  await startRunner({
    jobKey: 'oneshot:already-claimed',
    ownerId: 'already-claimed-owner',
    userToken: 'already-claimed-fixture',
    channelId: 'already-claimed-channel',
    client: mockClient(),
    mode: 'oneshot',
    accountId: 'already-claimed-account',
    username: 'already-claimed-user',
  });

  await waitFor(() => getUserJobs('already-claimed-owner').length === 0);
  assert.equal(completed, true);
  assert.equal(claimed, true);
  assert.equal(progressRequests, 1);
  assert.equal(claimRequests, 0);
});

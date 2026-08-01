import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchInputUrl } from './fetch-input.js';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.RUNNER_TOKEN_SECRET = 'status-mutation-test-secret-123456';
process.env.DATABASE_PATH = ':memory:';

const {
  clearQuestStatuses,
  getQuestStatus,
  listQuestStatuses,
  recordQuestSuccess,
  recordQuestVerification,
} = await import('../src/quest-status-store.js');
const { executeVerifiedMutation } = await import('../src/mutation-retry.js');
const {
  clearQuestEngineStatuses,
  fetchQuests,
  getQuestEngineStatus,
  listQuestEngineStatuses,
} = await import('../src/discord-runner.js');

function questPayload(id, eventName, target, progress) {
  return {
    quests: [{
      id,
      config: {
        messages: { quest_name: id },
        task_config: { tasks: { [eventName]: { target } } },
      },
      user_status: {
        enrolled_at: '2026-07-21T00:00:00Z',
        progress: { [eventName]: { value: progress } },
      },
    }],
  };
}

test.beforeEach(() => {
  clearQuestStatuses();
  clearQuestEngineStatuses();
});

test('Quest status store keeps accounts isolated and aggregates explicitly', () => {
  recordQuestSuccess('account:a', {
    state: 'compatible',
    questCount: 2,
    supportedCount: 1,
    unknownEvents: [],
    schemaIssues: [],
    questListPath: '/quests/@me',
  }, { ownerId: 'owner', accountId: 'a', username: 'alpha', lifecycle: 'running' });
  recordQuestSuccess('account:b', {
    state: 'degraded',
    questCount: 3,
    supportedCount: 2,
    unknownEvents: ['NEW_EVENT'],
    schemaIssues: ['new field'],
    questListPath: '/users/@me/quests',
  }, { ownerId: 'owner', accountId: 'b', username: 'beta', lifecycle: 'running' });
  recordQuestVerification('account:a', 'progress');

  assert.equal(getQuestStatus('account:a').questCount, 2);
  assert.equal(getQuestStatus('account:b').questCount, 3);
  const aggregate = getQuestStatus();
  assert.equal(aggregate.accountCount, 2);
  assert.equal(aggregate.questCount, 5);
  assert.equal(aggregate.supportedCount, 3);
  assert.equal(aggregate.state, 'degraded');
  assert.equal(aggregate.questListPath, 'multiple');
  assert.deepEqual(aggregate.unknownEvents, ['NEW_EVENT']);
  assert.equal(listQuestStatuses({ ownerId: 'owner' }).length, 2);
});

test('verified mutation does not resend when fresh state confirms success', async () => {
  let attempts = 0;
  let verifies = 0;
  const result = await executeVerifiedMutation({
    perform: async () => {
      attempts++;
      throw new TypeError('connection reset after server accepted request');
    },
    verify: async () => {
      verifies++;
      return true;
    },
    wait: async () => assert.fail('wait must not run after verified success'),
  });

  assert.deepEqual(result, { verifiedAfterFailure: true });
  assert.equal(attempts, 1);
  assert.equal(verifies, 1);
});

test('verified mutation retries once only after fresh state is still absent', async () => {
  let attempts = 0;
  let verifies = 0;
  let waits = 0;
  const result = await executeVerifiedMutation({
    perform: async () => {
      attempts++;
      if (attempts === 1) {
        const error = new Error('rate limited');
        error.status = 429;
        error.data = { retry_after: 0 };
        throw error;
      }
      return { ok: true };
    },
    verify: async () => {
      verifies++;
      return false;
    },
    wait: async () => { waits++; },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  assert.equal(verifies, 1);
  assert.equal(waits, 1);
});

test('verified mutation never retries deterministic client errors', async () => {
  let attempts = 0;
  let verifies = 0;
  await assert.rejects(
    executeVerifiedMutation({
      perform: async () => {
        attempts++;
        const error = new Error('bad request');
        error.status = 400;
        throw error;
      },
      verify: async () => { verifies++; return false; },
    }),
    /bad request/,
  );
  assert.equal(attempts, 1);
  assert.equal(verifies, 0);
});

test('fetchQuests writes independent status snapshots for concurrent accounts', async () => {
  const payloadByToken = new Map([
    ['token-a', questPayload('quest-a', 'WATCH_VIDEO', 60, 15)],
    ['token-b', questPayload('quest-b', 'PLAY_ON_DESKTOP', 900, 300)],
  ]);
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = fetchInputUrl(url);
    if (!requestUrl.endsWith('/quests/@me')) throw new Error(`Unexpected URL: ${requestUrl}`);
    const payload = payloadByToken.get(options.headers?.Authorization);
    if (!payload) throw new Error('Unexpected authorization in test request');
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await Promise.all([
    fetchQuests('token-a', undefined, {
      key: 'job:a', ownerId: 'owner', accountId: 'a', username: 'alpha', jobKey: 'a', mode: 'oneshot',
    }),
    fetchQuests('token-b', undefined, {
      key: 'job:b', ownerId: 'owner', accountId: 'b', username: 'beta', jobKey: 'b', mode: 'scheduled',
    }),
  ]);

  assert.equal(getQuestEngineStatus('job:a').questCount, 1);
  assert.equal(getQuestEngineStatus('job:a').supportedCount, 1);
  assert.equal(getQuestEngineStatus('job:b').questCount, 1);
  assert.equal(getQuestEngineStatus('job:b').supportedCount, 1);
  assert.equal(listQuestEngineStatuses({ ownerId: 'owner' }).length, 2);
  assert.equal(getQuestEngineStatus().accountCount, 2);
});

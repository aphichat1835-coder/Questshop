import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { fetchInputUrl } from './fetch-input.js';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.DATABASE_PATH = `/tmp/questbot-runner-control-${process.pid}.db`;
process.env.RUNNER_TOKEN_SECRET = 'runner-control-test-secret-123456';

const { getUserJobs, startRunner, shutdownRunners } = await import('../src/discord-runner.js');
const {
  durableStopTimeoutMs,
  isAccountStopping,
  stopRunnerAndWait,
  summarizeStopResults,
} = await import('../src/runner-control.js');
const { closeDatabase } = await import('../src/db.js');

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

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for runner state');
}

test.after(async () => {
  await shutdownRunners();
  closeDatabase();
  await Promise.all([
    fs.rm(process.env.DATABASE_PATH, { force: true }),
    fs.rm(`${process.env.DATABASE_PATH}-wal`, { force: true }),
    fs.rm(`${process.env.DATABASE_PATH}-shm`, { force: true }),
  ]);
});

test('stop result summary is shared by runner control and stop command flows', () => {
  assert.deepEqual(summarizeStopResults([
    { accepted: true, cleanupComplete: true },
    { accepted: true, cleanupComplete: false },
    { accepted: false, cleanupComplete: false },
  ]), { accepted: 2, completed: 1, pending: 1 });
});

test('durable stop timeout covers at least two worker polls plus cleanup margin', () => {
  assert.equal(durableStopTimeoutMs(5_000), 15_000);
  assert.equal(durableStopTimeoutMs(30_000), 65_000);
  assert.equal(durableStopTimeoutMs(60_000), 125_000);
});

test('stop control blocks restart state until runner cleanup finishes', async () => {
  globalThis.fetch = async (url, options = {}) => {
    const value = fetchInputUrl(url);
    if (value.endsWith('/quests/@me')) {
      return new Response(JSON.stringify({ quests: [{
        id: 'quest-control',
        config: {
          application: { id: 'app-control' },
          messages: { quest_name: 'Control Quest' },
          task_config: { tasks: { PLAY_ON_DESKTOP: { target: 60 } } },
        },
        user_status: {
          enrolled_at: '2026-07-01T00:00:00Z',
          progress: { PLAY_ON_DESKTOP: { value: 0 } },
        },
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (value.includes('/heartbeat')) {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    throw new Error(`Unexpected fetch: ${value}`);
  };

  await startRunner({
    jobKey: 'test-owner:oneshot:control',
    ownerId: 'test-owner',
    userToken: 'token-control',
    channelId: 'channel-control',
    client: mockClient(),
    mode: 'oneshot',
    accountId: 'account-control',
    username: 'control-user',
  });

  await waitFor(() => getUserJobs('test-owner').length === 1);
  const stopping = stopRunnerAndWait('test-owner', { mode: 'oneshot' });
  assert.equal(isAccountStopping('test-owner', 'account-control'), true);
  assert.equal(await stopping, true);
  assert.equal(isAccountStopping('test-owner', 'account-control'), false);
  assert.equal(getUserJobs('test-owner').length, 0);
});

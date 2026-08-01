import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.DATABASE_PATH = `/tmp/questbot-maintenance-${process.pid}.db`;
process.env.RUNNER_TOKEN_SECRET = 'maintenance-test-secret-123456';
process.env.HEALTH_STATUS_TOKEN = 'health-test-secret';

const apiStatusCommand = await import('../src/commands/api-status.js');
const stopCommand = await import('../src/commands/stop.js');
const { hasStatusAccess } = await import('../src/dashboard.js');
const {
  closeDatabase,
  getDatabaseBackupDirectory,
} = await import('../src/db.js');
const {
  createScheduledRunner,
  listScheduledRunners,
} = await import('../src/scheduled-runner-store.js');

test.after(async () => {
  closeDatabase();
  await Promise.all([
    fs.rm(process.env.DATABASE_PATH, { force: true }),
    fs.rm(`${process.env.DATABASE_PATH}-wal`, { force: true }),
    fs.rm(`${process.env.DATABASE_PATH}-shm`, { force: true }),
  ]);
});

test('STOP ALL removes persisted scheduled runners even when they are offline', async () => {
  for (const suffix of ['a', 'b']) {
    createScheduledRunner({
      ownerId: 'offline-owner',
      guildId: 'guild',
      channelId: 'channel',
      accountId: `account-${suffix}`,
      username: `user-${suffix}`,
      token: `token-${suffix}`,
      secret: process.env.RUNNER_TOKEN_SECRET,
    });
  }
  assert.equal(listScheduledRunners('offline-owner').length, 2);

  let updatedPayload;
  await stopCommand.handleButton({
    customId: 'runner-stop:all',
    user: { id: 'offline-owner' },
    async update(payload) {
      updatedPayload = payload;
      return payload;
    },
  });

  assert.equal(listScheduledRunners('offline-owner').length, 0);
  const description = updatedPayload.embeds[0].data.description;
  assert.ok(description.includes('2'));
  assert.ok(description.includes('token'));
});

test('api-status rejects users without manager access before reading system details', async () => {
  let reply;
  await apiStatusCommand.execute({
    user: { id: 'not-a-manager' },
    member: {
      permissions: { has: () => false },
      roles: { cache: { has: () => false } },
    },
    async reply(payload) {
      reply = payload;
      return payload;
    },
  });

  assert.equal(reply.flags, 64);
  assert.match(reply.content, /Manager/);
});

test('non-persistent database paths use the local bounded backup directory', () => {
  assert.equal(getDatabaseBackupDirectory(), './data/backups');
});

test('health status authorization uses an exact bearer token', () => {
  assert.equal(hasStatusAccess('Bearer health-test-secret'), true);
  assert.equal(hasStatusAccess('Bearer wrong-secret'), false);
  assert.equal(hasStatusAccess('health-test-secret'), false);
  assert.equal(hasStatusAccess(undefined), false);
  assert.equal(hasStatusAccess('Bearer anything', ''), false);
});

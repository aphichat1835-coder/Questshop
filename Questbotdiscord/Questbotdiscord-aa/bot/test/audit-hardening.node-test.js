import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.DATABASE_PATH = `/tmp/questbot-audit-hardening-${process.pid}.db`;
process.env.RUNNER_TOKEN_SECRET = 'audit-hardening-secret-123456789';
process.env.HEALTH_STATUS_TOKEN = 'audit-health-secret-123456';

const TEST_CHROME_VERSION = [140, 1, 2, 3].join('.');

const {
  acquireRuntimeLease,
  closeDatabase,
  releaseRuntimeLease,
  renewRuntimeLease,
} = await import('../src/db.js');
const { redactSensitive } = await import('../src/error-reporter.js');
const { executeVerifiedMutation } = await import('../src/mutation-retry.js');
const {
  clearQuestStatuses,
  getQuestStatus,
  recordQuestFailure,
  recordQuestSuccess,
  setQuestStatusLifecycle,
} = await import('../src/quest-status-store.js');
const {
  withAccountAdmissionLock,
} = await import('../src/run-admission-lock.js');
const { transientRetryDelayMs } = await import('../src/runner-schedule.js');

test.after(async () => {
  closeDatabase();
  await Promise.all([
    fs.rm(process.env.DATABASE_PATH, { force: true }),
    fs.rm(`${process.env.DATABASE_PATH}-wal`, { force: true }),
    fs.rm(`${process.env.DATABASE_PATH}-shm`, { force: true }),
  ]);
});

test('account admission is serialized globally across different owners', async () => {
  let releaseFirst;
  let firstStarted;
  const firstReady = new Promise((resolve) => { firstStarted = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const order = [];

  const first = withAccountAdmissionLock('same-account', async () => {
    order.push('first');
    firstStarted();
    await firstRelease;
  });
  await firstReady;
  const second = withAccountAdmissionLock('same-account', async () => {
    order.push('second');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
});

test('verification errors never trigger a duplicate mutation', async () => {
  let attempts = 0;
  await assert.rejects(
    executeVerifiedMutation({
      perform: async () => {
        attempts++;
        throw new TypeError('connection reset after server accepted request');
      },
      verify: async () => {
        throw new Error('fresh state unavailable');
      },
      wait: async () => assert.fail('retry wait must not run'),
    }),
    /fresh state unavailable/,
  );
  assert.equal(attempts, 1);
});

test('aggregate status excludes stopped history and counts active accounts uniquely', () => {
  clearQuestStatuses();
  recordQuestFailure('old', new Error('old failure'), false, {
    ownerId: 'owner',
    accountId: 'old-account',
    lifecycle: 'stopped',
  });
  recordQuestSuccess('active-a', {
    state: 'compatible',
    questCount: 1,
    supportedCount: 1,
    unknownEvents: [],
    schemaIssues: [],
  }, {
    ownerId: 'owner',
    accountId: 'same-account',
    lifecycle: 'running',
  });
  recordQuestSuccess('active-b', {
    state: 'compatible',
    questCount: 2,
    supportedCount: 1,
    unknownEvents: [],
    schemaIssues: [],
  }, {
    ownerId: 'owner',
    accountId: 'same-account',
    lifecycle: 'running',
  });
  const aggregate = getQuestStatus();
  assert.equal(aggregate.state, 'compatible');
  assert.equal(aggregate.accountCount, 1);
  assert.equal(aggregate.questCount, 3);
  setQuestStatusLifecycle('active-a', 'stopped');
  setQuestStatusLifecycle('active-b', 'stopped');
});

test('transient retry delays are bounded at 5, 15 and 30 minutes', () => {
  assert.equal(transientRetryDelayMs(0), 5 * 60 * 1000);
  assert.equal(transientRetryDelayMs(1), 15 * 60 * 1000);
  assert.equal(transientRetryDelayMs(2), 30 * 60 * 1000);
  assert.equal(transientRetryDelayMs(99), 30 * 60 * 1000);
});

test('error redaction removes JSON CAPTCHA and token fields', () => {
  const safe = redactSensitive(
    '{"captcha_rqtoken":"captcha-secret","token":"plain-secret","message":"safe"}',
  );
  assert.doesNotMatch(safe, /captcha-secret|plain-secret/);
  assert.match(safe, /REDACTED/);
});

test('runtime lease allows one holder and can be renewed and released', () => {
  assert.equal(acquireRuntimeLease('test-runtime', 'holder-a', 60_000), true);
  assert.equal(acquireRuntimeLease('test-runtime', 'holder-b', 60_000), false);
  assert.equal(renewRuntimeLease('test-runtime', 'holder-a', 60_000), true);
  assert.equal(releaseRuntimeLease('test-runtime', 'holder-a'), true);
  assert.equal(acquireRuntimeLease('test-runtime', 'holder-b', 60_000), true);
  assert.equal(releaseRuntimeLease('test-runtime', 'holder-b'), true);
});

test('validated Discord client profile is exposed through config', () => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `
      const { config } = await import('./src/config.js');
      console.log(JSON.stringify({
        client: config.discordClientVersion,
        chrome: config.discordChromeVersion,
        electron: config.discordElectronVersion,
        build: config.discordBuildNumber,
        nativeBuild: config.discordNativeBuildNumber,
        locale: config.discordLocale,
      }));
    `],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DISCORD_CLIENT_VERSION: '9.8.7',
        DISCORD_CHROME_VERSION: TEST_CHROME_VERSION,
        DISCORD_ELECTRON_VERSION: '40.2.1',
        DISCORD_BUILD_NUMBER: '700001',
        DISCORD_NATIVE_BUILD_NUMBER: '50001',
        DISCORD_LOCALE: 'th-TH',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)), {
    client: '9.8.7',
    chrome: TEST_CHROME_VERSION,
    electron: '40.2.1',
    build: 700001,
    nativeBuild: 50001,
    locale: 'th-TH',
  });
});

test('invalid environment values fail fast', () => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "await import('./src/config.js')"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DISCORD_CLIENT_ID: 'not-a-snowflake',
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(child.status, 0);
  assert.match(`${child.stderr}${child.stdout}`, /DISCORD_CLIENT_ID/);
});

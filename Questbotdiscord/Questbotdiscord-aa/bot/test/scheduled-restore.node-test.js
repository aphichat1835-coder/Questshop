import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import {
  createScheduledRunner,
  deleteAllScheduledRunners,
} from '../src/scheduled-runner-store.js';
import { encryptRunnerToken } from '../src/runner-token-crypto.js';
import { restoreScheduledRunnerRows } from '../src/quest/scheduled-restore.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

const OWNER_ID = 'scheduled-restore-test-owner';

function cleanup() {
  deleteAllScheduledRunners(OWNER_ID);
  clearRunnerStatesForTests();
}

function unresolvedRow(id, token) {
  const encrypted = encryptRunnerToken(token, config.runnerTokenSecret, OWNER_ID, null);
  return {
    id,
    owner_id: OWNER_ID,
    guild_id: null,
    channel_id: `channel-${id}`,
    account_id: null,
    username: `unresolved-${id}`,
    token_ciphertext: encrypted.ciphertext,
    token_iv: encrypted.iv,
    token_tag: encrypted.tag,
    token_salt: encrypted.salt,
    next_check_at: null,
  };
}

test.beforeEach(cleanup);
test.afterEach(cleanup);

test('scheduled restore decrypts the persisted token and delegates to the runner service', async () => {
  const row = createScheduledRunner({
    ownerId: OWNER_ID,
    guildId: 'guild-1',
    channelId: 'channel-1',
    accountId: 'account-1',
    username: 'restored-user',
    token: 'persisted-user-token',
    secret: config.runnerTokenSecret,
    nextCheckAt: '2030-01-01T08:00:00.000Z',
  });
  beginRunnerState({
    jobKey: `scheduled:${row.id}`,
    ownerId: OWNER_ID,
    accountId: 'account-1',
    username: 'restored-user',
    mode: 'scheduled',
    scheduleId: row.id,
    state: RUNNER_STATE.RECOVERING,
  });

  const starts = [];
  const result = await restoreScheduledRunnerRows({ id: 'fake-client' }, async (args) => {
    starts.push(args);
  });

  assert.deepEqual(result, { restored: 1, failed: 0 });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].jobKey, `scheduled:${row.id}`);
  assert.equal(starts[0].userToken, 'persisted-user-token');
  assert.equal(starts[0].mode, 'scheduled');
  assert.equal(starts[0].initialNextCheckAt, '2030-01-01T08:00:00.000Z');
});

test('multiple unresolved account rows restore independently', async () => {
  const rows = [
    unresolvedRow(900001, 'unresolved-token-1'),
    unresolvedRow(900002, 'unresolved-token-2'),
  ];
  const starts = [];

  const result = await restoreScheduledRunnerRows({}, async (args) => {
    starts.push(args);
  }, { rows });

  assert.deepEqual(result, { restored: 2, failed: 0 });
  assert.deepEqual(starts.map((args) => args.userToken), [
    'unresolved-token-1',
    'unresolved-token-2',
  ]);
  assert.deepEqual(starts.map((args) => args.accountId), [null, null]);
});

test('recovering durable states without a matching scheduled row become failed', async () => {
  beginRunnerState({
    jobKey: 'scheduled:999999',
    ownerId: OWNER_ID,
    accountId: 'missing-account',
    username: 'orphan',
    mode: 'scheduled',
    scheduleId: 999999,
    state: RUNNER_STATE.RECOVERING,
  });

  const result = await restoreScheduledRunnerRows({}, async () => {
    assert.fail('orphaned state must not start a runner');
  });

  assert.deepEqual(result, { restored: 0, failed: 0 });
  const state = getRunnerState('scheduled:999999');
  assert.equal(state.state, RUNNER_STATE.FAILED);
  assert.match(state.last_error, /no matching scheduled runner row/);
  assert.ok(state.completed_at);
});

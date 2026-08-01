import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { encryptRunnerToken } from '../src/runner-token-crypto.js';
import { reconcileScheduledWorker } from '../src/quest/scheduled-worker-reconciler.js';
import { releaseScheduledRunnerClaim } from '../src/quest/scheduled-worker-claims.js';

function scheduledRow(id) {
  const ownerId = `claim-owner-${id}`;
  const accountId = `claim-account-${id}`;
  const encrypted = encryptRunnerToken(
    `claim-token-${id}`,
    config.runnerTokenSecret,
    ownerId,
    accountId,
  );
  return {
    id,
    owner_id: ownerId,
    guild_id: 'guild-claims',
    channel_id: 'channel-claims',
    account_id: accountId,
    username: `claim-runner-${id}`,
    token_ciphertext: encrypted.ciphertext,
    token_iv: encrypted.iv,
    token_tag: encrypted.tag,
    token_salt: encrypted.salt,
    next_check_at: null,
  };
}

test('a second worker cannot restore a row claimed by the first worker', async () => {
  const row = scheduledRow(9401);
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const firstStarts = [];
  const first = await reconcileScheduledWorker({}, {
    rows: [row],
    jobs: [],
    holder: 'reconciler-worker-a',
    claimTtlMs: 10_000,
    now,
    startRunner: async (args) => firstStarts.push(args),
  });
  assert.equal(first.restore.restored, 1);
  assert.equal(first.claimsAcquired, 1);
  assert.equal(firstStarts.length, 1);

  const second = await reconcileScheduledWorker({}, {
    rows: [row],
    jobs: [],
    holder: 'reconciler-worker-b',
    claimTtlMs: 10_000,
    now: now + 1,
    startRunner: async () => assert.fail('claimed row must not start on another worker'),
  });
  assert.equal(second.restore.restored, 0);
  assert.equal(second.claimConflicts, 1);
  releaseScheduledRunnerClaim(row.id, 'reconciler-worker-a');
});

test('another worker restores the row after the previous ownership lease expires', async () => {
  const row = scheduledRow(9402);
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  await reconcileScheduledWorker({}, {
    rows: [row],
    jobs: [],
    holder: 'reconciler-expired-a',
    claimTtlMs: 10_000,
    now,
    startRunner: async () => {},
  });

  const takeoverStarts = [];
  const takeover = await reconcileScheduledWorker({}, {
    rows: [row],
    jobs: [],
    holder: 'reconciler-expired-b',
    claimTtlMs: 10_000,
    now: now + 10_001,
    startRunner: async (args) => takeoverStarts.push(args),
  });
  assert.equal(takeover.restore.restored, 1);
  assert.equal(takeover.claimsAcquired, 1);
  assert.equal(takeoverStarts[0].jobKey, `scheduled:${row.id}`);
  releaseScheduledRunnerClaim(row.id, 'reconciler-expired-b');
});

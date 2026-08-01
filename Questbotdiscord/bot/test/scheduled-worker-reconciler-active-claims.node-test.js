import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileScheduledWorker } from '../src/quest/scheduled-worker-reconciler.js';

function row(id) {
  return {
    id,
    owner_id: `active-owner-${id}`,
    account_id: `active-account-${id}`,
  };
}

function job(id) {
  return {
    key: `scheduled:${id}`,
    ownerId: `active-owner-${id}`,
    accountId: `active-account-${id}`,
    mode: 'scheduled',
    scheduleId: id,
  };
}

test('worker stops its local job immediately after losing the ownership claim', async () => {
  const stops = [];
  const result = await reconcileScheduledWorker({}, {
    rows: [row(9501)],
    jobs: [job(9501)],
    holder: 'active-worker-lost',
    now: Date.parse('2030-01-01T00:00:00.000Z'),
    renewClaim: () => false,
    acquireClaim: () => false,
    releaseClaim: () => false,
    stop: (ownerId, jobKey, options) => {
      stops.push({ ownerId, jobKey, options });
      return true;
    },
    startRunner: async () => assert.fail('claim-lost job must not restart locally'),
  });

  assert.equal(result.claimLost, 1);
  assert.equal(result.stopRequested, 1);
  assert.equal(result.claimsRenewed, 0);
  assert.deepEqual(stops, [{
    ownerId: 'active-owner-9501',
    jobKey: 'scheduled:9501',
    options: { removeSchedule: false },
  }]);
});

test('worker renews the claim for its active job without restarting it', async () => {
  let renewals = 0;
  const result = await reconcileScheduledWorker({}, {
    rows: [row(9502)],
    jobs: [job(9502)],
    holder: 'active-worker-owner',
    now: Date.parse('2030-01-01T00:00:00.000Z'),
    renewClaim: () => {
      renewals++;
      return true;
    },
    acquireClaim: () => assert.fail('owned claim should renew before acquire'),
    releaseClaim: () => false,
    stop: () => assert.fail('owned job must not stop'),
    startRunner: async () => assert.fail('owned active job must not restart'),
  });

  assert.equal(renewals, 1);
  assert.equal(result.claimsRenewed, 1);
  assert.equal(result.claimLost, 0);
  assert.equal(result.stopRequested, 0);
  assert.equal(result.restore.restored, 0);
});

test('slow cleanup cannot delay renewal of unrelated active claims', async () => {
  let finishCleanup;
  const done = new Promise((resolve) => { finishCleanup = resolve; });
  const renewals = [];
  const stops = [];
  let heartbeat = null;
  let heartbeatCleared = false;

  const reconciliation = reconcileScheduledWorker({}, {
    rows: [row(9504)],
    jobs: [job(9503), job(9504)],
    holder: 'active-worker-slow-cleanup',
    claimTtlMs: 3_000,
    now: Date.parse('2030-01-01T00:00:00.000Z'),
    setInterval: (callback, delay) => {
      assert.equal(delay, 1_000);
      heartbeat = callback;
      return { unref() {} };
    },
    clearInterval: () => { heartbeatCleared = true; },
    renewClaim: (scheduleId) => {
      renewals.push(scheduleId);
      return scheduleId === 9504;
    },
    acquireClaim: () => assert.fail('the surviving job should keep its existing claim'),
    releaseClaim: () => true,
    getJob: (jobKey) => jobKey === 'scheduled:9503' ? { done } : null,
    stop: (_ownerId, jobKey) => {
      stops.push(jobKey);
      return true;
    },
    startRunner: async () => assert.fail('no row should restart during cleanup'),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(renewals, [9504]);
  assert.deepEqual(stops, ['scheduled:9503']);
  assert.equal(typeof heartbeat, 'function');

  heartbeat();
  assert.deepEqual(renewals, [9504, 9504]);

  finishCleanup();
  const result = await reconciliation;
  assert.deepEqual(renewals, [9504, 9504, 9504]);
  assert.equal(heartbeatCleared, true);
  assert.equal(result.claimsRenewed, 1);
  assert.equal(result.stopRequested, 1);
  assert.equal(result.claimLost, 0);
});

test('worker stops a survivor that loses ownership during slow cleanup', async () => {
  let finishCleanup;
  const done = new Promise((resolve) => { finishCleanup = resolve; });
  const stops = [];
  let heartbeat = null;
  let survivorOwned = true;

  const reconciliation = reconcileScheduledWorker({}, {
    rows: [row(9508)],
    jobs: [job(9507), job(9508)],
    holder: 'active-worker-ownership-lost-during-cleanup',
    claimTtlMs: 3_000,
    now: Date.parse('2030-01-01T00:00:00.000Z'),
    setInterval: (callback) => {
      heartbeat = callback;
      return { unref() {} };
    },
    clearInterval: () => {},
    renewClaim: (scheduleId) => scheduleId === 9508 && survivorOwned,
    acquireClaim: () => false,
    releaseClaim: () => true,
    getJob: (jobKey) => jobKey === 'scheduled:9507' ? { done } : null,
    stop: (_ownerId, jobKey) => {
      stops.push(jobKey);
      return true;
    },
    startRunner: async () => assert.fail('ownership-lost survivor must not restart locally'),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stops, ['scheduled:9507']);
  assert.equal(typeof heartbeat, 'function');

  survivorOwned = false;
  heartbeat();
  finishCleanup();

  const result = await reconciliation;
  assert.deepEqual(stops, ['scheduled:9507', 'scheduled:9508']);
  assert.equal(result.claimLost, 1);
  assert.equal(result.claimsRenewed, 1);
  assert.equal(result.stopRequested, 2);
  assert.equal(result.restore.restored, 0);
});

test('restore claim acquisition uses a fresh clock after slow cleanup', async () => {
  let finishCleanup;
  const done = new Promise((resolve) => { finishCleanup = resolve; });
  const initialNow = Date.parse('2030-01-01T00:00:00.000Z');
  let clock = initialNow;
  const acquireTimes = [];

  const reconciliation = reconcileScheduledWorker({}, {
    rows: [row(9506)],
    jobs: [job(9505)],
    holder: 'active-worker-fresh-clock',
    now: () => clock,
    acquireClaim: (_scheduleId, _holder, _ttlMs, now) => {
      acquireTimes.push(now);
      return false;
    },
    renewClaim: () => false,
    releaseClaim: () => true,
    getJob: (jobKey) => jobKey === 'scheduled:9505' ? { done } : null,
    stop: () => true,
    startRunner: async () => assert.fail('conflicted row must not restart'),
  });

  await new Promise((resolve) => setImmediate(resolve));
  clock += 120_000;
  finishCleanup();

  const result = await reconciliation;
  assert.deepEqual(acquireTimes, [clock]);
  assert.equal(result.claimConflicts, 1);
  assert.equal(result.stopRequested, 1);
});

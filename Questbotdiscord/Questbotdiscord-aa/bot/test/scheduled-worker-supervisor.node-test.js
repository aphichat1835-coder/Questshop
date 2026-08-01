import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { encryptRunnerToken } from '../src/runner-token-crypto.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';
import {
  reconcileScheduledWorker,
  startScheduledWorkerSupervisor,
  stopScheduledWorkerSupervisor,
} from '../src/quest/scheduled-worker-supervisor.js';

const OWNER_ID = 'scheduled-worker-supervisor-owner';

function scheduledRow(id) {
  const accountId = `account-${id}`;
  const token = encryptRunnerToken(
    `scheduled-worker-token-${id}`,
    config.runnerTokenSecret,
    OWNER_ID,
    accountId,
  );
  return {
    id,
    owner_id: OWNER_ID,
    account_id: accountId,
    username: `user-${id}`,
    channel_id: `channel-${id}`,
    token_ciphertext: token.ciphertext,
    token_iv: token.iv,
    token_tag: token.tag,
    token_salt: token.salt,
    next_check_at: null,
  };
}

test.beforeEach(clearRunnerStatesForTests);
test.afterEach(async () => {
  await stopScheduledWorkerSupervisor();
  clearRunnerStatesForTests();
});

test('supervisor stops deleted rows and starts newly persisted rows', async () => {
  const stopped = [];
  const started = [];
  const rows = [scheduledRow(2)];

  const result = await reconcileScheduledWorker({}, {
    rows,
    jobs: [{
      key: 'scheduled:1',
      ownerId: OWNER_ID,
      accountId: 'account-1',
      mode: 'scheduled',
      scheduleId: 1,
    }],
    stop: (ownerId, jobKey, options) => {
      stopped.push({ ownerId, jobKey, options });
      return true;
    },
    getJob: () => null,
    startRunner: async (args) => {
      started.push(args);
      return { jobKey: args.jobKey };
    },
  });

  assert.equal(result.stopRequested, 1);
  assert.equal(result.restore.restored, 1);
  assert.deepEqual(stopped, [{
    ownerId: OWNER_ID,
    jobKey: 'scheduled:1',
    options: { removeSchedule: false },
  }]);
  assert.equal(started[0].jobKey, 'scheduled:2');
  assert.equal(started[0].userToken, 'scheduled-worker-token-2');
});

test('one stop failure does not block later stops, restore or finalization', async () => {
  const stopped = [];
  const rows = [scheduledRow(3)];
  beginRunnerState({
    jobKey: 'scheduled:30',
    ownerId: OWNER_ID,
    accountId: 'account-30',
    mode: 'scheduled',
    scheduleId: 30,
    state: RUNNER_STATE.STOPPING,
  });

  const result = await reconcileScheduledWorker({}, {
    rows,
    jobs: [
      {
        key: 'scheduled:1',
        ownerId: OWNER_ID,
        accountId: 'account-1',
        mode: 'scheduled',
        scheduleId: 1,
      },
      {
        key: 'scheduled:2',
        ownerId: OWNER_ID,
        accountId: 'account-2',
        mode: 'scheduled',
        scheduleId: 2,
      },
    ],
    stop: (_ownerId, jobKey) => {
      stopped.push(jobKey);
      if (jobKey === 'scheduled:1') throw new Error('stop failed');
      return true;
    },
    getJob: () => null,
    reportStopError: async () => {},
    startRunner: async (args) => ({ jobKey: args.jobKey }),
  });

  assert.deepEqual(stopped, ['scheduled:1', 'scheduled:2']);
  assert.equal(result.stopRequested, 1);
  assert.equal(result.stopFailures, 1);
  assert.equal(result.restore.restored, 1);
  assert.equal(result.finalizedStops, 1);
  assert.equal(getRunnerState('scheduled:30').state, RUNNER_STATE.STOPPED);
});

test('failed rows use a bounded retry delay before the supervisor restarts them', async () => {
  const row = scheduledRow(3);
  beginRunnerState({
    jobKey: 'scheduled:3',
    ownerId: OWNER_ID,
    accountId: 'account-3',
    mode: 'scheduled',
    scheduleId: 3,
    state: RUNNER_STATE.FAILED,
  });

  let starts = 0;
  const result = await reconcileScheduledWorker({}, {
    rows: [row],
    jobs: [],
    startRunner: async () => { starts++; },
    now: Date.now(),
  });

  assert.equal(result.restore.restored, 0);
  assert.equal(starts, 0);
});

test('detached STOPPING state becomes STOPPED after the worker confirms no row or job remains', async () => {
  beginRunnerState({
    jobKey: 'scheduled:4',
    ownerId: OWNER_ID,
    accountId: 'account-4',
    mode: 'scheduled',
    scheduleId: 4,
    state: RUNNER_STATE.STOPPING,
    metadata: { stopSource: 'control' },
  });

  const result = await reconcileScheduledWorker({}, {
    rows: [],
    jobs: [],
    startRunner: async () => assert.fail('deleted row must not restart'),
  });

  assert.equal(result.finalizedStops, 1);
  const state = getRunnerState('scheduled:4');
  assert.equal(state.state, RUNNER_STATE.STOPPED);
  assert.equal(state.last_error, null);
  assert.equal(state.metadata.stopConfirmedBy, 'worker-supervisor');
  assert.ok(state.completed_at);
});

test('STOPPING remains active until the local job cleanup promise settles', async () => {
  beginRunnerState({
    jobKey: 'scheduled:5',
    ownerId: OWNER_ID,
    accountId: 'account-5',
    mode: 'scheduled',
    scheduleId: 5,
    state: RUNNER_STATE.STOPPING,
  });

  let finishCleanup;
  const done = new Promise((resolve) => { finishCleanup = resolve; });
  const reconcilePromise = reconcileScheduledWorker({}, {
    rows: [],
    jobs: [{
      key: 'scheduled:5',
      ownerId: OWNER_ID,
      accountId: 'account-5',
      mode: 'scheduled',
      scheduleId: 5,
    }],
    getJob: () => ({ done }),
    stop: () => true,
    startRunner: async () => assert.fail('deleted row must not restart'),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getRunnerState('scheduled:5').state, RUNNER_STATE.STOPPING);

  finishCleanup();
  const result = await reconcilePromise;
  assert.equal(result.stopRequested, 1);
  assert.equal(result.finalizedStops, 1);
  assert.equal(getRunnerState('scheduled:5').state, RUNNER_STATE.STOPPED);
});

test('supervisor rejects a failed initial reconcile, blocks duplicate start, and permits retry', async () => {
  let releaseInitial;
  const initialGate = new Promise((resolve) => { releaseInitial = resolve; });
  const firstStart = startScheduledWorkerSupervisor({}, {
    initialReconcile: async () => {
      await initialGate;
      throw new Error('initial reconcile failed');
    },
  });

  const duplicate = await startScheduledWorkerSupervisor({});
  assert.equal(duplicate, false);
  releaseInitial();
  await assert.rejects(firstStart, /initial reconcile failed/);

  const retry = await startScheduledWorkerSupervisor({}, {
    initialReconcile: async () => ({ recovered: true }),
  });
  assert.equal(retry, true);
});

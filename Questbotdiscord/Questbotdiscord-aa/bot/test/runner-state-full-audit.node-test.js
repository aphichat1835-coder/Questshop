import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  ensureRunnerStateSchema,
  getRunnerState,
  listStoppingScheduledRunnerStates,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';
import { reconcileScheduledWorker } from '../src/quest/scheduled-worker-reconciler.js';

test.beforeEach(clearRunnerStatesForTests);
test.afterEach(clearRunnerStatesForTests);

test('runner state schema migration acquires an immediate transaction before schema reads or writes', () => {
  const calls = [];
  const database = {
    transaction(callback) {
      calls.push('transaction-created');
      return {
        immediate() {
          calls.push('transaction-immediate');
          return callback();
        },
      };
    },
    exec() {
      calls.push('exec');
    },
    prepare() {
      calls.push('prepare');
      return { all: () => [] };
    },
  };

  ensureRunnerStateSchema(database);

  assert.equal(calls[0], 'transaction-created');
  assert.equal(calls[1], 'transaction-immediate');
  assert.ok(calls.indexOf('transaction-immediate') < calls.indexOf('prepare'));
  assert.ok(calls.indexOf('transaction-immediate') < calls.indexOf('exec'));
});

test('worker reconciliation finalizes every detached STOPPING row beyond the old 500-row window', async () => {
  const total = 550;
  for (let index = 0; index < total; index++) {
    beginRunnerState({
      jobKey: `scheduled:bulk-stop-${index}`,
      ownerId: `owner-${Math.floor(index / 10)}`,
      accountId: `account-${index}`,
      mode: 'scheduled',
      scheduleId: 10_000 + index,
      state: RUNNER_STATE.STOPPING,
    });
  }

  assert.equal(listStoppingScheduledRunnerStates().length, total);
  const result = await reconcileScheduledWorker({}, {
    rows: [],
    jobs: [],
    startRunner: async () => assert.fail('detached STOPPING rows must not restart'),
  });

  assert.equal(result.finalizedStops, total);
  assert.equal(listStoppingScheduledRunnerStates().length, 0);
  assert.equal(getRunnerState('scheduled:bulk-stop-549').state, RUNNER_STATE.STOPPED);
});

import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getScheduledWorkerStatus,
  releaseScheduledWorkerSupervisorClaims,
  startScheduledWorkerSupervisor,
  stopScheduledWorkerSupervisor,
} from '../src/quest/scheduled-worker-supervisor.js';
import { clearRunnerStatesForTests } from '../src/quest/runner-state-store.js';

test.beforeEach(async () => {
  await stopScheduledWorkerSupervisor();
  clearRunnerStatesForTests();
});

test.afterEach(async () => {
  await stopScheduledWorkerSupervisor();
  clearRunnerStatesForTests();
});

test('default initial reconcile records a defensive status snapshot', async () => {
  assert.equal(releaseScheduledWorkerSupervisorClaims(), 0);

  const started = await startScheduledWorkerSupervisor({}, {
    holder: 'worker:supervisor-status-test',
  });
  assert.equal(started, true);

  const first = getScheduledWorkerStatus();
  assert.equal(first.error, null);
  assert.match(first.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof first.stopRequested, 'number');
  assert.equal(typeof first.finalizedStops, 'number');
  assert.equal(typeof first.restore, 'object');

  first.error = 'caller mutation must not leak';
  assert.equal(getScheduledWorkerStatus().error, null);
});

test('initial reconciliation failure rejects startup and permits a clean retry', async () => {
  await assert.rejects(
    startScheduledWorkerSupervisor({}, {
      holder: 'worker:initial-failure',
      initialReconcile: async () => {
        throw new Error('initial reconciliation failed');
      },
    }),
    /initial reconciliation failed/,
  );

  const retried = await startScheduledWorkerSupervisor({}, {
    holder: 'worker:initial-retry',
    initialReconcile: async () => ({ restored: 0 }),
  });
  assert.equal(retried, true);
});

test('concurrent supervisor starts do not create duplicate startup work', async () => {
  let releaseInitial;
  const initial = new Promise((resolve) => {
    releaseInitial = resolve;
  });
  const first = startScheduledWorkerSupervisor({}, {
    holder: 'worker:concurrent-start',
    initialReconcile: async () => initial,
  });
  const second = await startScheduledWorkerSupervisor({}, {
    holder: 'worker:duplicate-start',
    initialReconcile: async () => {
      throw new Error('duplicate initial reconciliation must not run');
    },
  });

  assert.equal(second, false);
  releaseInitial({ restored: 0 });
  assert.equal(await first, true);
});

test('stop waits for an in-flight initial reconciliation and clears the resulting timer', async () => {
  let releaseInitial;
  const initial = new Promise((resolve) => {
    releaseInitial = resolve;
  });
  const started = startScheduledWorkerSupervisor({}, {
    holder: 'worker:stop-during-start',
    initialReconcile: async () => initial,
  });
  const stopping = stopScheduledWorkerSupervisor();

  releaseInitial({ restored: 0 });
  assert.equal(await started, true);
  assert.equal(await stopping, true);

  const restarted = await startScheduledWorkerSupervisor({}, {
    holder: 'worker:after-stop-during-start',
    initialReconcile: async () => ({ restored: 0 }),
  });
  assert.equal(restarted, true);
});

test('stopping without automatic release preserves the holder for explicit cleanup', async () => {
  const started = await startScheduledWorkerSupervisor({}, {
    holder: 'worker:supervisor-explicit-release',
    initialReconcile: async () => ({ skipped: true }),
  });
  assert.equal(started, true);

  assert.equal(await stopScheduledWorkerSupervisor({ releaseClaims: false }), true);
  assert.equal(releaseScheduledWorkerSupervisorClaims(), 0);
  assert.equal(releaseScheduledWorkerSupervisorClaims(), 0);
});

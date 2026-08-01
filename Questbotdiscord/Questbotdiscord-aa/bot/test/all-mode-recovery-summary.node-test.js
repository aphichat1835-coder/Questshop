import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAllModeRecoveryController } from '../src/quest/all-mode-recovery.js';
import { RUNNER_STATE } from '../src/quest/runner-state-store.js';

test('an all-mode restore summary with zero restored rows is retried', async () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const timers = [];
  const errors = [];
  const context = {
    jobKey: 'scheduled:empty-restore-summary',
    mode: 'scheduled',
    processRole: 'all',
    scheduleId: 8101,
    client: {},
  };
  const controller = createAllModeRecoveryController({
    readState: () => ({
      state: RUNNER_STATE.WAITING_RETRY,
      schedule_id: 8101,
      next_action_at: new Date(now).toISOString(),
    }),
    readJob: () => null,
    readScheduled: () => ({ id: 8101 }),
    restore: async () => ({ restored: 0, failed: 1, skipped: 0 }),
    currentTime: () => now,
    restoreRetryDelayMs: 60_000,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
    reportError: (error) => errors.push({ code: error.code, message: error.message }),
  });

  assert.equal(await controller.run(context), false);
  assert.equal(controller.isScheduled(context.jobKey), true);
  assert.equal(timers[0].delay, 60_000);
  assert.equal(errors[0].code, 'ALL_MODE_RESTORE_EMPTY');
  assert.match(errors[0].message, /restored no runner/);
});

import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAllModeRecoveryController } from '../src/quest/all-mode-recovery.js';
import { RUNNER_STATE } from '../src/quest/runner-state-store.js';

function fixture({
  restore = null,
  restoreRetryDelayMs = 60_000,
  persistRetry = null,
} = {}) {
  let now = Date.parse('2030-01-01T00:00:00.000Z');
  const jobs = new Map();
  const schedules = new Map([[41, { id: 41, owner_id: 'owner-41' }]]);
  const states = new Map([['scheduled:41', {
    job_key: 'scheduled:41',
    schedule_id: 41,
    state: RUNNER_STATE.WAITING_RETRY,
    next_action_at: new Date(now + 5_000).toISOString(),
  }]]);
  const timers = [];
  const restores = [];
  const errors = [];
  const persisted = [];
  let readStateFn = (jobKey) => states.get(jobKey) ?? null;

  const restoreFn = restore ?? (async () => undefined);
  const persistRetryFn = persistRetry ?? (async (jobKey, nextActionAt, error) => {
    const state = states.get(jobKey);
    if (state?.state !== RUNNER_STATE.WAITING_RETRY) return false;
    state.next_action_at = nextActionAt;
    persisted.push({ jobKey, nextActionAt, message: error.message });
    return true;
  });
  const controller = createAllModeRecoveryController({
    readState: (jobKey) => readStateFn(jobKey),
    readJob: (jobKey) => jobs.get(jobKey) ?? null,
    readScheduled: (scheduleId) => schedules.get(scheduleId) ?? null,
    restore: async (row, context) => {
      restores.push({ row, context });
      return restoreFn(row, context);
    },
    persistRetry: persistRetryFn,
    currentTime: () => now,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    reportError: (error) => errors.push(error.message),
    restoreRetryDelayMs,
  });

  return {
    context: {
      jobKey: 'scheduled:41',
      mode: 'scheduled',
      processRole: 'all',
      scheduleId: 41,
      client: {},
    },
    controller,
    errors,
    jobs,
    persisted,
    restores,
    schedules,
    setNow: (value) => { now = value; },
    setReadState: (callback) => { readStateFn = callback; },
    states,
    timers,
  };
}

test('all-mode recovery schedules from durable next_action_at and restores when due', async () => {
  const item = fixture();
  assert.equal(item.controller.schedule(item.context), true);
  assert.equal(item.controller.isScheduled(item.context.jobKey), true);
  assert.equal(item.timers[0].delay, 5_000);

  item.setNow(Date.parse('2030-01-01T00:00:05.000Z'));
  assert.equal(await item.controller.run(item.context), true);
  assert.equal(item.restores.length, 1);
  assert.equal(item.restores[0].row.id, 41);
  assert.equal(item.restores[0].context.userToken, undefined);
  assert.deepEqual(item.errors, []);
  assert.deepEqual(item.persisted, []);
});

test('failed all-mode restore persists and rearms with a nonzero bounded delay', async () => {
  const item = fixture({
    restore: async () => { throw new Error('restore unavailable'); },
    restoreRetryDelayMs: 60_000,
  });
  item.setNow(Date.parse('2030-01-01T00:00:05.000Z'));

  assert.equal(await item.controller.run(item.context), false);
  assert.deepEqual(item.errors, ['restore unavailable']);
  assert.equal(item.persisted.length, 1);
  assert.equal(
    item.persisted[0].nextActionAt,
    '2030-01-01T00:01:05.000Z',
  );
  assert.equal(
    item.states.get(item.context.jobKey).next_action_at,
    '2030-01-01T00:01:05.000Z',
  );
  assert.equal(item.controller.isScheduled(item.context.jobKey), true);
  assert.equal(item.timers.length, 1);
  assert.equal(item.timers[0].delay, 60_000);
});

test('failed restore is not rearmed after the durable state becomes terminal', async () => {
  const item = fixture({
    restore: async () => {
      item.states.get(item.context.jobKey).state = RUNNER_STATE.FAILED;
      throw new Error('terminal restore failure');
    },
  });
  item.setNow(Date.parse('2030-01-01T00:00:05.000Z'));

  assert.equal(await item.controller.run(item.context), false);
  assert.equal(item.controller.isScheduled(item.context.jobKey), false);
  assert.equal(item.timers.length, 0);
  assert.deepEqual(item.persisted, []);
});

test('timer callback contains durable state read failures without unhandled rejection', async () => {
  const item = fixture();
  assert.equal(item.controller.schedule(item.context), true);
  item.setNow(Date.parse('2030-01-01T00:00:05.000Z'));
  item.setReadState(() => {
    throw new Error('state read failed');
  });

  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.once('unhandledRejection', onUnhandled);
  try {
    item.timers[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, null);
    assert.ok(item.errors.includes('state read failed'));
    assert.equal(item.controller.isScheduled(item.context.jobKey), false);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('all-mode recovery refuses stale state, removed schedules and replacement jobs', async () => {
  const item = fixture();
  item.states.get(item.context.jobKey).state = RUNNER_STATE.RUNNING;
  assert.equal(item.controller.schedule(item.context), false);

  item.states.get(item.context.jobKey).state = RUNNER_STATE.WAITING_RETRY;
  item.schedules.delete(41);
  assert.equal(item.controller.schedule(item.context), false);

  item.schedules.set(41, { id: 41 });
  item.jobs.set(item.context.jobKey, { key: item.context.jobKey });
  assert.equal(item.controller.schedule(item.context), false);
  assert.equal(await item.controller.run(item.context), false);
  assert.equal(item.restores.length, 0);
});

test('all-mode recovery is disabled outside scheduled all-in-one topology', () => {
  const item = fixture();
  assert.equal(item.controller.schedule({ ...item.context, processRole: 'worker' }), false);
  assert.equal(item.controller.schedule({ ...item.context, processRole: 'control' }), false);
  assert.equal(item.controller.schedule({ ...item.context, mode: 'oneshot' }), false);
  assert.equal(item.timers.length, 0);
});

test('rescheduling replaces the previous timer and clear cancels every pending wake', () => {
  const item = fixture();
  assert.equal(item.controller.schedule(item.context), true);
  const first = item.timers[0];
  assert.equal(item.controller.schedule(item.context), true);
  assert.equal(first.cleared, true);
  assert.equal(item.timers[1].cleared, false);

  item.controller.clear();
  assert.equal(item.timers[1].cleared, true);
  assert.equal(item.controller.isScheduled(item.context.jobKey), false);
});

test('recovery rechecks durable state at execution time before restoring', async () => {
  const item = fixture();
  assert.equal(item.controller.schedule(item.context), true);
  item.setNow(Date.parse('2030-01-01T00:00:05.000Z'));
  item.states.get(item.context.jobKey).state = RUNNER_STATE.STOPPED;

  assert.equal(await item.controller.run(item.context), false);
  assert.equal(item.restores.length, 0);
});

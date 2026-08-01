import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { rollbackStartedRunner } from '../src/quest/runner-start-rollback.js';

test('rollback stops a started runner without deleting its schedule and waits for settlement', async () => {
  const calls = [];
  let active = true;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const result = await rollbackStartedRunner({
    jobKey: 'scheduled:rollback',
    ownerId: 'owner-1',
  }, {
    getJob: () => (active ? { done } : null),
    stopJob: (ownerId, jobKey, options) => {
      calls.push({ ownerId, jobKey, options });
      active = false;
      resolveDone();
      return true;
    },
  });

  assert.deepEqual(calls, [{
    ownerId: 'owner-1',
    jobKey: 'scheduled:rollback',
    options: { removeSchedule: false },
  }]);
  assert.deepEqual(result, { found: true, stopped: true, settled: true });
});

test('rollback is a no-op when the legacy runner never started', async () => {
  const result = await rollbackStartedRunner({ jobKey: 'oneshot:missing' }, {
    getJob: () => null,
    stopJob: () => {
      throw new Error('stop should not run');
    },
  });

  assert.deepEqual(result, { found: false, stopped: false, settled: true });
});

test('rollback reports stop failures without masking the original start error path', async () => {
  const reports = [];
  const result = await rollbackStartedRunner({
    jobKey: 'scheduled:rollback-failure',
    ownerId: 'owner-1',
  }, {
    getJob: () => ({ done: Promise.resolve() }),
    stopJob: () => false,
    reportError: (error, context) => reports.push({ message: error.message, context }),
  });

  assert.equal(result.found, true);
  assert.equal(result.stopped, false);
  assert.equal(result.settled, false);
  assert.equal(reports.length, 1);
  assert.match(reports[0].message, /could not be stopped/);
  assert.deepEqual(reports[0].context, {
    jobKey: 'scheduled:rollback-failure',
    stopped: false,
  });
});

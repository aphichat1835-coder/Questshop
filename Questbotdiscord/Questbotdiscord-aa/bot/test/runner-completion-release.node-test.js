import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseRunnerExecutionWhenSettled } from '../src/quest/runner-completion-release.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

async function flushTasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('completion release runs once after a resolved runner promise', async () => {
  const completion = deferred();
  let releases = 0;
  assert.equal(releaseRunnerExecutionWhenSettled(
    completion.promise,
    () => { releases++; },
  ), true);

  completion.resolve();
  await flushTasks();
  assert.equal(releases, 1);
});

test('completion release consumes a rejected runner promise without unhandled rejection', async () => {
  const completion = deferred();
  let releases = 0;
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    assert.equal(releaseRunnerExecutionWhenSettled(
      completion.promise,
      () => { releases++; },
    ), true);
    completion.reject(new Error('runner failed'));
    await flushTasks();
    assert.equal(releases, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('release callback failures are reported and do not escape the promise chain', async () => {
  const completion = deferred();
  const reported = [];
  releaseRunnerExecutionWhenSettled(completion.promise, () => {
    throw new Error('release failed');
  }, {
    onError: (error) => reported.push(error.message),
  });

  completion.reject(new Error('runner failed first'));
  await flushTasks();
  assert.deepEqual(reported, ['release failed']);
});

test('a failing error reporter cannot create another unhandled rejection', async () => {
  const completion = deferred();
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    releaseRunnerExecutionWhenSettled(completion.promise, () => {
      throw new Error('release failed');
    }, {
      onError: () => {
        throw new Error('reporter failed');
      },
    });

    completion.resolve();
    await flushTasks();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('missing completion promise releases synchronously', () => {
  let releases = 0;
  assert.equal(releaseRunnerExecutionWhenSettled(
    null,
    () => { releases++; },
  ), false);
  assert.equal(releases, 1);
});

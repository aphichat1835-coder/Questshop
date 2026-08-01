import assert from 'node:assert/strict';
import test from 'node:test';
import {
  withAccountAdmissionLock,
  withOwnerAdmissionLock,
} from '../src/run-admission-lock.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('runner admission is serialized for the same owner', async () => {
  const firstRelease = deferred();
  const firstStarted = deferred();
  const order = [];

  const first = withOwnerAdmissionLock('owner-a', async () => {
    order.push('first-start');
    firstStarted.resolve();
    await firstRelease.promise;
    order.push('first-end');
  });

  await firstStarted.promise;
  const second = withOwnerAdmissionLock('owner-a', async () => {
    order.push('second-start');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);

  firstRelease.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
});

test('different owners can perform admission concurrently', async () => {
  const release = deferred();
  const started = [];

  const first = withOwnerAdmissionLock('owner-a', async () => {
    started.push('owner-a');
    await release.promise;
  });
  const second = withOwnerAdmissionLock('owner-b', async () => {
    started.push('owner-b');
    await release.promise;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(new Set(started), new Set(['owner-a', 'owner-b']));

  release.resolve();
  await Promise.all([first, second]);
});

test('account admission blocks different owners for the same Discord account', async () => {
  const release = deferred();
  const started = deferred();
  const order = [];

  const first = withAccountAdmissionLock('account-a', async () => {
    order.push('owner-a');
    started.resolve();
    await release.promise;
  });
  await started.promise;
  const second = withAccountAdmissionLock('account-a', async () => {
    order.push('owner-b');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['owner-a']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['owner-a', 'owner-b']);
});

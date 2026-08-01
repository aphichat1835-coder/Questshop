import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireProcessRoleLease,
  clearProcessRoleLeasesForTests,
  isProcessRoleActive,
  listActiveProcessRoles,
  listActiveWorkerHolders,
  releaseProcessRoleLease,
} from '../src/process-topology.js';

test.beforeEach(clearProcessRoleLeasesForTests);
test.afterEach(clearProcessRoleLeasesForTests);

test('control and multiple worker leases can coexist', () => {
  assert.equal(acquireProcessRoleLease('control', 'control-holder'), true);
  assert.equal(acquireProcessRoleLease('worker', 'worker-a'), true);
  assert.equal(acquireProcessRoleLease('worker', 'worker-b'), true);
  assert.equal(isProcessRoleActive('control'), true);
  assert.equal(isProcessRoleActive('worker'), true);
  assert.deepEqual(listActiveProcessRoles(), ['control', 'worker']);
  assert.deepEqual(listActiveWorkerHolders(), ['worker-a', 'worker-b']);
  assert.equal(releaseProcessRoleLease('worker', 'worker-a'), true);
  assert.equal(isProcessRoleActive('worker'), true);
  assert.equal(releaseProcessRoleLease('worker', 'worker-b'), true);
  assert.equal(releaseProcessRoleLease('control', 'control-holder'), true);
});

test('all-in-one lease conflicts with control and every worker', () => {
  assert.equal(acquireProcessRoleLease('control', 'control-holder'), true);
  assert.equal(acquireProcessRoleLease('worker', 'worker-a'), true);
  assert.equal(acquireProcessRoleLease('all', 'all-holder'), false);
  assert.equal(releaseProcessRoleLease('worker', 'worker-a'), true);
  assert.equal(releaseProcessRoleLease('control', 'control-holder'), true);

  assert.equal(acquireProcessRoleLease('all', 'all-holder'), true);
  assert.equal(acquireProcessRoleLease('control', 'control-holder'), false);
  assert.equal(acquireProcessRoleLease('worker', 'worker-a'), false);
  assert.equal(acquireProcessRoleLease('worker', 'worker-b'), false);
  assert.deepEqual(listActiveProcessRoles(), ['all']);
});

test('singleton roles reject another holder while worker holders remain independent', () => {
  assert.equal(acquireProcessRoleLease('control', 'control-a'), true);
  assert.equal(acquireProcessRoleLease('control', 'control-b'), false);
  assert.equal(acquireProcessRoleLease('control', 'control-a'), true);

  assert.equal(acquireProcessRoleLease('worker', 'worker-a'), true);
  assert.equal(acquireProcessRoleLease('worker', 'worker-b'), true);
  assert.equal(acquireProcessRoleLease('worker', 'worker-a'), true);
});

test('expired worker leases are excluded independently from active role discovery', () => {
  const now = Date.now();
  assert.equal(acquireProcessRoleLease('worker', 'worker-a', 1000), true);
  assert.equal(isProcessRoleActive('worker', now + 2000), false);
  assert.deepEqual(listActiveProcessRoles(now + 2000), []);
  assert.deepEqual(listActiveWorkerHolders(now + 2000), []);
});

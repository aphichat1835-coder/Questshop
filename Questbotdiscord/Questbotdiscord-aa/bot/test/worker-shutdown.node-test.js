import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { shutdownWorkerResources } from '../src/worker-shutdown.js';

test('worker shutdown runs every cleanup step even when earlier steps fail', async () => {
  const calls = [];
  const reports = [];

  const result = await shutdownWorkerResources({
    stopSupervisor: async () => {
      calls.push('supervisor');
      throw new Error('supervisor failed');
    },
    shutdownRunners: async () => {
      calls.push('runners');
    },
    releaseClaims: () => {
      calls.push('claims');
      throw new Error('claim release failed');
    },
    stopDashboard: async () => {
      calls.push('dashboard');
    },
    uninstallRuntime: () => {
      calls.push('runtime');
    },
    reportError: (label, error) => {
      reports.push({ label, message: error.message });
    },
  });

  assert.deepEqual(calls, [
    'supervisor',
    'runners',
    'claims',
    'dashboard',
    'runtime',
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map((failure) => failure.label), [
    'Scheduled worker supervisor shutdown',
    'Scheduled worker claim release',
  ]);
  assert.deepEqual(reports, [
    {
      label: 'Scheduled worker supervisor shutdown',
      message: 'supervisor failed',
    },
    {
      label: 'Scheduled worker claim release',
      message: 'claim release failed',
    },
  ]);
});

test('worker shutdown continues when failure reporting also throws', async () => {
  const calls = [];
  const result = await shutdownWorkerResources({
    stopSupervisor: async () => {
      calls.push('supervisor');
      throw new Error('stop failed');
    },
    shutdownRunners: async () => calls.push('runners'),
    releaseClaims: () => calls.push('claims'),
    stopDashboard: async () => calls.push('dashboard'),
    uninstallRuntime: () => calls.push('runtime'),
    reportError: () => {
      throw new Error('reporting failed');
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [
    'supervisor',
    'runners',
    'claims',
    'dashboard',
    'runtime',
  ]);
});

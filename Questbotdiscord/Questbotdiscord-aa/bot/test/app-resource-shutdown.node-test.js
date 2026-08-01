import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { shutdownAppResources } from '../src/app-resource-shutdown.js';

test('app resource shutdown continues after Discord client destruction fails', async () => {
  const calls = [];
  const reports = [];

  const result = await shutdownAppResources({
    destroyClient: async () => {
      calls.push('client');
      throw new Error('destroy failed');
    },
    stopDashboard: async () => {
      calls.push('dashboard');
    },
    uninstallRuntime: () => {
      calls.push('runtime');
    },
    reportError: (label, error) => reports.push({ label, message: error.message }),
  });

  assert.deepEqual(calls, ['client', 'dashboard', 'runtime']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map((failure) => failure.label), [
    'Discord client shutdown',
  ]);
  assert.deepEqual(reports, [{
    label: 'Discord client shutdown',
    message: 'destroy failed',
  }]);
});

test('app resource shutdown continues if failure reporting throws', async () => {
  const calls = [];
  const result = await shutdownAppResources({
    destroyClient: async () => {
      calls.push('client');
      throw new Error('destroy failed');
    },
    stopDashboard: async () => calls.push('dashboard'),
    uninstallRuntime: () => calls.push('runtime'),
    reportError: () => {
      throw new Error('reporting failed');
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['client', 'dashboard', 'runtime']);
});

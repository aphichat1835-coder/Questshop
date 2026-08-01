import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fatalBootstrapShutdown,
  resetBootstrapStateForTests,
} from '../src/bootstrap.js';
import { INCIDENT } from '../src/incident-catalog.js';

const originalConsoleError = console.error;
const originalWebhook = process.env.LOG_WEBHOOK_URL;
const originalExitCode = process.exitCode;

test.afterEach(() => {
  console.error = originalConsoleError;
  process.exitCode = originalExitCode;
  resetBootstrapStateForTests();
  if (originalWebhook == null) delete process.env.LOG_WEBHOOK_URL;
  else process.env.LOG_WEBHOOK_URL = originalWebhook;
});

test('a repeated fatal bootstrap error is redacted and logged while shutdown is already reserved', async () => {
  delete process.env.LOG_WEBHOOK_URL;
  const logs = [];
  console.error = (...args) => logs.push(args.map(String).join(' '));

  await fatalBootstrapShutdown({
    code: INCIDENT.CLIENT_STARTUP_FAILED,
    error: new Error('first bootstrap failure'),
    context: { component: 'bootstrap-test' },
  });
  await fatalBootstrapShutdown({
    code: INCIDENT.UNHANDLED_REJECTION,
    error: new Error('second failure apiKey=must-not-leak'),
    context: { component: 'bootstrap-test', token: 'also-hidden' },
  });

  const output = logs.join('\n');
  assert.match(output, /UNHANDLED_REJECTION/);
  assert.match(output, /fatal shutdown already in progress/i);
  assert.doesNotMatch(output, /must-not-leak|also-hidden/);
  assert.match(output, /apiKey=\[REDACTED\]/);
});

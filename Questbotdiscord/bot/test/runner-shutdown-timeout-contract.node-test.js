import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('runner-service applies a bounded shutdown timeout when callers omit one', async () => {
  const source = await readFile(
    new URL('../src/quest/runner-service.js', import.meta.url),
    'utf8',
  );

  assert.match(source, /export const DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS = 15_000;/);
  assert.match(
    source,
    /shutdownRunners\(timeoutMs = DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS\)/,
  );
  assert.doesNotMatch(source, /shutdownRunners\(timeoutMs = null\)/);
});

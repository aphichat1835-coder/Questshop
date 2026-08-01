import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRunnerError,
  RUNNER_ERROR_CATEGORY,
} from '../src/quest/runner-state-store.js';

const cases = [
  { label: 'abort by name', error: { name: 'AbortError' }, expected: RUNNER_ERROR_CATEGORY.ABORTED },
  { label: 'abort by message', error: { message: 'aborted' }, expected: RUNNER_ERROR_CATEGORY.ABORTED },
  { label: 'schema compatibility', error: { name: 'QuestCompatibilityError' }, expected: RUNNER_ERROR_CATEGORY.SCHEMA },
  { label: 'timeout by name', error: { name: 'RequestTimeoutError' }, expected: RUNNER_ERROR_CATEGORY.TIMEOUT },
  { label: 'timeout by code', error: { code: 'ETIMEDOUT' }, expected: RUNNER_ERROR_CATEGORY.TIMEOUT },
  { label: 'authentication 401', error: { status: 401 }, expected: RUNNER_ERROR_CATEGORY.AUTH },
  { label: 'authentication 403', error: { status: 403 }, expected: RUNNER_ERROR_CATEGORY.AUTH },
  { label: 'rate limit', error: { status: 429 }, expected: RUNNER_ERROR_CATEGORY.RATE_LIMIT },
  { label: 'API 5xx', error: { status: 503 }, expected: RUNNER_ERROR_CATEGORY.API_5XX },
  { label: 'API 4xx', error: { status: 404 }, expected: RUNNER_ERROR_CATEGORY.API_4XX },
  { label: 'SQLite storage', error: { code: 'SQLITE_BUSY' }, expected: RUNNER_ERROR_CATEGORY.STORAGE },
  { label: 'connection reset', error: { code: 'ECONNRESET' }, expected: RUNNER_ERROR_CATEGORY.NETWORK },
  { label: 'connection refused', error: { code: 'ECONNREFUSED' }, expected: RUNNER_ERROR_CATEGORY.NETWORK },
  { label: 'DNS not found', error: { code: 'ENOTFOUND' }, expected: RUNNER_ERROR_CATEGORY.NETWORK },
  { label: 'temporary DNS failure', error: { code: 'EAI_AGAIN' }, expected: RUNNER_ERROR_CATEGORY.NETWORK },
  { label: 'Undici code', error: { code: 'UND_ERR_CONNECT_TIMEOUT' }, expected: RUNNER_ERROR_CATEGORY.NETWORK },
  { label: 'Undici cause code', error: { cause: { code: 'UND_ERR_SOCKET' } }, expected: RUNNER_ERROR_CATEGORY.NETWORK },
  { label: 'known network cause code', error: { cause: { code: 'ECONNRESET' } }, expected: RUNNER_ERROR_CATEGORY.NETWORK },
  { label: 'fetch failed message', error: new TypeError('fetch failed'), expected: RUNNER_ERROR_CATEGORY.NETWORK },
  { label: 'generic Error without network evidence', error: new Error('invariant violated'), expected: RUNNER_ERROR_CATEGORY.UNKNOWN },
  { label: 'programming TypeError', error: new TypeError('cannot read property'), expected: RUNNER_ERROR_CATEGORY.UNKNOWN },
  { label: 'unknown plain value', error: { code: 'OTHER' }, expected: RUNNER_ERROR_CATEGORY.UNKNOWN },
  { label: 'null', error: null, expected: RUNNER_ERROR_CATEGORY.UNKNOWN },
];

for (const { label, error, expected } of cases) {
  test(`runner error classification: ${label}`, () => {
    assert.equal(classifyRunnerError(error), expected);
  });
}

test('abort classification takes precedence over an HTTP status', () => {
  assert.equal(
    classifyRunnerError({ name: 'AbortError', status: 503 }),
    RUNNER_ERROR_CATEGORY.ABORTED,
  );
});

test('timeout classification takes precedence over an HTTP status', () => {
  assert.equal(
    classifyRunnerError({ name: 'RequestTimeoutError', status: 503 }),
    RUNNER_ERROR_CATEGORY.TIMEOUT,
  );
});

test('HTTP classification takes precedence over a storage-shaped code', () => {
  assert.equal(
    classifyRunnerError({ status: 503, code: 'SQLITE_BUSY' }),
    RUNNER_ERROR_CATEGORY.API_5XX,
  );
});

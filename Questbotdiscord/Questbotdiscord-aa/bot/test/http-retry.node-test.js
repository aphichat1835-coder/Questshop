import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchWithRetry,
  RequestTimeoutError,
} from '../src/http-retry.js';

test('retries server errors with exponential backoff', async () => {
  let calls = 0;
  const waits = [];
  const response = await fetchWithRetry('https://example.test', {}, {
    fetchFn: async () => {
      calls++;
      return new Response('', { status: calls < 3 ? 503 : 200 });
    },
    random: () => 0,
    waitFn: async (ms) => waits.push(ms),
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('honors Retry-After for rate limits', async () => {
  let calls = 0;
  const waits = [];
  await fetchWithRetry('https://example.test', {}, {
    fetchFn: async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '2.5' } })
        : new Response('', { status: 200 });
    },
    waitFn: async (ms) => waits.push(ms),
  });

  assert.equal(calls, 2);
  assert.deepEqual(waits, [2500]);
});

test('does not retry authentication failures', async () => {
  let calls = 0;
  const response = await fetchWithRetry('https://example.test', {}, {
    fetchFn: async () => {
      calls++;
      return new Response('', { status: 401 });
    },
    waitFn: async () => {},
  });

  assert.equal(response.status, 401);
  assert.equal(calls, 1);
});

test('aborts requests that exceed the timeout', async () => {
  await assert.rejects(
    fetchWithRetry('https://example.test', {}, {
      timeoutMs: 10,
      maxRetries: 0,
      fetchFn: async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
      }),
    }),
    RequestTimeoutError,
  );
});

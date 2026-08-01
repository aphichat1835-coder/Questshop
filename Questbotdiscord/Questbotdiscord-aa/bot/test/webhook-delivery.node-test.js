import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeDiscordWebhook,
  validateDiscordWebhookUrl,
} from '../src/webhook-delivery.js';
import { createFakeDiscordWebhookUrl } from '../test-support/fake-webhook.js';

const WEBHOOK_URL = createFakeDiscordWebhookUrl('transport');

function alteredWebhookUrl(mutator) {
  const url = new URL(WEBHOOK_URL);
  mutator(url);
  return url.toString();
}

test('webhook URL validation rejects unsafe variants', () => {
  assert.equal(validateDiscordWebhookUrl('LOG_WEBHOOK_URL', WEBHOOK_URL), WEBHOOK_URL);
  for (const value of [
    alteredWebhookUrl((url) => { url.protocol = 'http:'; }),
    alteredWebhookUrl((url) => { url.hostname = 'example.com'; }),
    alteredWebhookUrl((url) => { url.port = '444'; }),
    alteredWebhookUrl((url) => { url.username = 'user'; url.password = 'pass'; }),
    alteredWebhookUrl((url) => { url.searchParams.set('wait', 'true'); }),
    alteredWebhookUrl((url) => { url.hash = 'fragment'; }),
  ]) {
    assert.throws(
      () => validateDiscordWebhookUrl('LOG_WEBHOOK_URL', value),
      /standard HTTPS Discord incoming webhook URL/,
    );
  }
});

test('successful delivery disables redirects and sends JSON', async () => {
  let request;
  const result = await executeDiscordWebhook({
    url: WEBHOOK_URL,
    payload: { content: 'test' },
    fetchFn: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(result.state, 'delivered');
  assert.equal(request.url, WEBHOOK_URL);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { content: 'test' });
});

test('429 and selected gateway failures retry at most once', async () => {
  const waits = [];
  let attempts = 0;
  const result = await executeDiscordWebhook({
    url: WEBHOOK_URL,
    payload: { content: 'test' },
    waitFn: async (ms) => waits.push(ms),
    fetchFn: async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': '0.25' },
        });
      }
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(result.state, 'delivered');
  assert.equal(result.attempts, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [250]);
});

test('retryable failures stop after the second response', async () => {
  const waits = [];
  let attempts = 0;
  const result = await executeDiscordWebhook({
    url: WEBHOOK_URL,
    payload: { content: 'test' },
    waitFn: async (ms) => waits.push(ms),
    fetchFn: async () => {
      attempts++;
      return new Response(null, { status: 503 });
    },
  });

  assert.equal(result.state, 'delivery_unknown');
  assert.equal(result.status, 503);
  assert.equal(result.attempts, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [750]);
});

test('client failures do not retry', async () => {
  let attempts = 0;
  const result = await executeDiscordWebhook({
    url: WEBHOOK_URL,
    payload: { content: 'test' },
    fetchFn: async () => {
      attempts++;
      return new Response(null, { status: 404 });
    },
  });

  assert.equal(result.state, 'permanent_failure');
  assert.equal(result.status, 404);
  assert.equal(attempts, 1);
});

test('network ambiguity does not blindly repeat a POST', async () => {
  let attempts = 0;
  const result = await executeDiscordWebhook({
    url: WEBHOOK_URL,
    payload: { content: 'test' },
    fetchFn: async () => {
      attempts++;
      throw Object.assign(new Error('socket closed after request body'), { name: 'TypeError' });
    },
  });

  assert.equal(result.state, 'delivery_unknown');
  assert.equal(result.attempts, 1);
  assert.equal(attempts, 1);
});

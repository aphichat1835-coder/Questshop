import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerDiscordClient } from '../src/quest/worker-discord-client.js';

test('worker status client exposes an explicit readiness lifecycle', () => {
  const client = createWorkerDiscordClient({
    botToken: 'bot-token-fixture',
    fetchFn: async () => new Response('{}', { status: 200 }),
  });

  assert.equal(client.isReady(), false);
  assert.equal(client.ws.ping, -1);
  client.markReady();
  assert.equal(client.isReady(), true);
  client.markNotReady();
  assert.equal(client.isReady(), false);
});

test('worker resolves global fetch when the request is sent, not when the client is created', async () => {
  const originalFetch = globalThis.fetch;
  const client = createWorkerDiscordClient({ botToken: 'bot-token-fixture' });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 'late-runtime-message' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const channel = await client.channels.fetch('channel-late');
    await channel.send({ content: 'late runtime' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/channel-late/messages');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker status client sends and edits messages through Discord API v10', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createWorkerDiscordClient({
    fetchFn,
    botToken: 'bot-token-fixture',
  });

  const channel = await client.channels.fetch('channel-1');
  assert.equal(channel.isTextBased(), true);
  const sent = await channel.send({ content: 'hello' });
  await sent.edit({ content: 'updated' });

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['https://discord.com/api/v10/channels/channel-1/messages', 'POST'],
    ['https://discord.com/api/v10/channels/channel-1/messages/message-1', 'PATCH'],
  ]);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bot bot-token-fixture');
    assert.equal(call.options.signal instanceof AbortSignal, true);
    const payload = JSON.parse(call.options.body);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
  }
});

test('worker status client aborts a Discord REST request at its timeout', async () => {
  const client = createWorkerDiscordClient({
    botToken: 'bot-token-fixture',
    requestTimeoutMs: 5,
    fetchFn: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  const channel = await client.channels.fetch('channel-timeout');
  await assert.rejects(
    channel.send({ content: 'will timeout' }),
    (error) => error?.name === 'TimeoutError',
  );
});

test('worker status client rejects Discord REST failures without exposing response bodies', async () => {
  const client = createWorkerDiscordClient({
    botToken: 'bot-token-fixture',
    fetchFn: async () => new Response(JSON.stringify({
      message: 'sensitive upstream detail',
      code: 50001,
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const channel = await client.channels.fetch('channel-1');
  await assert.rejects(
    channel.send({ content: 'hello' }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 50001);
      assert.doesNotMatch(error.message, /sensitive upstream detail/);
      return true;
    },
  );
});

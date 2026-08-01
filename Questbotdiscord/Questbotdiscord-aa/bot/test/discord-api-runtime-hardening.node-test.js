import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installDiscordApiRuntime,
  uninstallDiscordApiRuntime,
} from '../src/quest/discord-api-runtime.js';

test.afterEach(() => {
  uninstallDiscordApiRuntime();
});

test('malformed fetch input returns a rejected promise instead of throwing synchronously', async () => {
  installDiscordApiRuntime({
    fetchFn: async () => {
      throw new Error('transport should not run');
    },
    coordinator: {
      schedule() {
        throw new Error('coordinator should not run');
      },
    },
  });

  let request;
  assert.doesNotThrow(() => {
    request = globalThis.fetch('not a valid URL');
  });
  await assert.rejects(request, TypeError);
});

test('streaming Request bodies survive Discord API coordination without version rewriting', async () => {
  const observed = [];
  installDiscordApiRuntime({
    coordinator: {
      async schedule(url, options, execute) {
        observed.push({ url, method: options.method });
        return execute();
      },
    },
    fetchFn: async (input) => {
      assert.equal(input instanceof Request, true);
      assert.equal(input.url, 'https://discord.com/api/v9/quests/quest-stream/heartbeat');
      assert.equal(await input.text(), 'stream-payload');
      return new Response('{}', { status: 200 });
    },
  });

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('stream-payload'));
      controller.close();
    },
  });
  const request = new Request(
    'https://discord.com/api/v9/quests/quest-stream/heartbeat',
    {
      method: 'POST',
      headers: { Authorization: 'stream-account' },
      body,
      duplex: 'half',
    },
  );

  const response = await globalThis.fetch(request);
  assert.equal(response.status, 200);
  assert.deepEqual(observed, [{
    url: 'https://discord.com/api/v9/quests/quest-stream/heartbeat',
    method: 'POST',
  }]);
});

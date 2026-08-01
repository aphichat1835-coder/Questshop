import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DiscordApiError,
  fetchQuestPayload,
} from '../src/quest/api/discord-client.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('a later 401 overrides an earlier empty Quest payload', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ quests: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ message: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };

  await assert.rejects(
    () => fetchQuestPayload('expired-token'),
    (error) => error instanceof DiscordApiError && error.status === 401 && error.fatalAuth === true,
  );
  assert.equal(calls, 2);
});

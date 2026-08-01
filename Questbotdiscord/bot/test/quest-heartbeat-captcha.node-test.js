import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DiscordApiError,
  sendHeartbeatRequest,
} from '../src/quest/api/discord-client.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('desktop heartbeat does not send a second mutation after a CAPTCHA 400', async () => {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      message: 'captcha required',
      captcha_sitekey: 'fixture-site-key',
      captcha_rqtoken: 'fixture-rq-token',
    }), { status: 400 });
  };

  await assert.rejects(
    () => sendHeartbeatRequest('fixture-token', {
      id: 'quest-heartbeat-captcha',
      applicationId: 'application-1',
    }, false, false),
    (error) => {
      assert.equal(error instanceof DiscordApiError, true);
      assert.equal(error.status, 400);
      assert.equal(error.data.captcha_sitekey, 'fixture-site-key');
      return true;
    },
  );

  assert.deepEqual(calls, [
    { stream_key: 'call:quest-heartbeat-captcha:1', terminal: false },
  ]);
});

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQuestApiClient,
  DiscordApiError,
  DiscordApiTimeoutError,
  QUEST_API_VERSION,
} from '../../src/quest-engine/api/client.js';

const originalFetch = globalThis.fetch;
const profile = Object.freeze({ clientVersion: '1.0.0', chromeVersion: '120.0.0.0',
  electronVersion: '28.0.0', buildNumber: 1, nativeBuildNumber: 1, locale: 'en-US' });

afterEach(() => { globalThis.fetch = originalFetch; });

function api(options = {}) {
  return createQuestApiClient({ token: 'test-token', profile, coordinator: {
    schedule: async ({ execute }) => execute(), blockGlobally() {}, blockRoute() {}, blockAccount() {},
  }, ...options });
}

function response(body, status) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
  };
}

test('Quest client pins the proven v9 API profile and falls back to application heartbeat after non-CAPTCHA 400', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (calls.length === 1) return response(JSON.stringify({ message: 'bad stream' }), 400);
    return response('{}', 200);
  };
  await api().sendHeartbeat({ id: 'quest-1', applicationId: 'app-1' }, false, false);
  assert.equal(calls[0].url, `https://discord.com/api/v${QUEST_API_VERSION}/quests/quest-1/heartbeat`);
  assert.deepEqual(calls.map((call) => call.body), [
    { stream_key: 'call:quest-1:1', terminal: false },
    { application_id: 'app-1', terminal: false },
  ]);
});

test('Quest client does not bypass CAPTCHA with application heartbeat fallback', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response(JSON.stringify({ captcha_sitekey: 'challenge' }), 400);
  };
  await assert.rejects(api().sendHeartbeat({ id: 'quest-1', applicationId: 'app-1' }, false, false), DiscordApiError);
  assert.equal(calls, 1);
});

test('Quest client aborts a hung request with a bounded timeout', async () => {
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(api({ timeoutMs: 5 }).enroll('quest-1'), (error) => {
    assert.ok(error instanceof DiscordApiTimeoutError);
    assert.equal(error.possiblySent, true);
    return true;
  });
});

test('Quest client marks a mutation timeout before dispatch as safe to retry', async () => {
  const coordinator = {
    schedule: async () => { throw new Error('queue unavailable'); },
    blockGlobally() {}, blockRoute() {}, blockAccount() {},
  };
  await assert.rejects(createQuestApiClient({ token: 'test-token', profile, coordinator }).enroll('quest-1'), (error) => {
    assert.equal(error.possiblySent, false);
    return true;
  });
});

test('only identity/list 403 is fatal authentication evidence', () => {
  assert.equal(new DiscordApiError(403, '/users/@me', {}).fatalAuth, true);
  assert.equal(new DiscordApiError(403, '/quests/id/heartbeat', {}).fatalAuth, false);
});

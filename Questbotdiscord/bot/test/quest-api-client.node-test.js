import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDiscordApiUrl,
  buildDiscordUserHeaders,
  claimQuestRequest,
  DISCORD_API_BASE,
  DiscordApiError,
  discordFetch,
  enrollQuestRequest,
  fetchQuestPayload,
  QUEST_API_VERSION,
  sendHeartbeatRequest,
  sendVideoProgressRequest,
} from '../src/quest/api/discord-client.js';

const originalFetch = globalThis.fetch;

function fetchInputUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new TypeError('Unsupported fetch input');
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('Quest client preserves the production API v9 transport and coherent headers', () => {
  assert.equal(QUEST_API_VERSION, 9);
  assert.equal(DISCORD_API_BASE, 'https://discord.com/api/v9');
  const headers = buildDiscordUserHeaders('fixture-token', '/quests/@me', {
    clientVersion: '1.0.1',
    chromeVersion: '138.0.1',
    electronVersion: '37.0.0',
    buildNumber: 1,
    nativeBuildNumber: 2,
    locale: 'en-US',
    timezone: 'Asia/Bangkok',
  });
  assert.equal(headers.Authorization, 'fixture-token');
  assert.equal(headers.Referer, 'https://discord.com/quest-home');
  const properties = JSON.parse(Buffer.from(headers['X-Super-Properties'], 'base64').toString('utf8'));
  assert.equal(properties.client_build_number, 1);
  assert.equal(properties.native_build_number, 2);
});

test('discordFetch sends Quest traffic to v9 without runtime rewriting', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: fetchInputUrl(url), method: options.method ?? 'GET' });
    return new Response(JSON.stringify({ id: 'me' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const result = await discordFetch('fixture-token', '/users/@me');
  assert.equal(result.id, 'me');
  assert.deepEqual(calls, [{
    url: 'https://discord.com/api/v9/users/@me',
    method: 'GET',
  }]);
});

test('API URL builder rejects authority, query, fragment and traversal injection', () => {
  assert.equal(String(buildDiscordApiUrl('/users/@me')), 'https://discord.com/api/v9/users/@me');
  for (const unsafePath of [
    '//attacker.example/quests',
    '/../users/@me',
    '/%2e%2e/users/@me',
    '/users/@me?redirect=https://attacker.example',
    '/users/@me#fragment',
    String.raw`/users\@me`,
  ]) {
    assert.throws(() => buildDiscordApiUrl(unsafePath), TypeError);
  }
});

test('external Quest identifiers are encoded as one URL path segment', async () => {
  let requestUrl = null;
  globalThis.fetch = async (url) => {
    requestUrl = fetchInputUrl(url);
    return new Response('{}', { status: 200 });
  };

  await enrollQuestRequest('fixture-token', 'quest/../../escape?next=https://attacker.example');
  assert.equal(
    requestUrl,
    'https://discord.com/api/v9/quests/quest%2F..%2F..%2Fescape%3Fnext%3Dhttps%3A%2F%2Fattacker.example/enroll',
  );
});

test('Quest endpoint fallback accepts an empty first endpoint and populated second endpoint', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const requestUrl = fetchInputUrl(url);
    calls.push(requestUrl);
    if (requestUrl.endsWith('/quests/@me')) {
      return new Response(JSON.stringify({ quests: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ quests: [{ id: 'quest-1' }] }), { status: 200 });
  };
  const payload = await fetchQuestPayload('fixture-token');
  assert.equal(payload.path, '/users/@me/quests');
  assert.equal(payload.quests[0].id, 'quest-1');
  assert.equal(calls.length, 2);
});

test('Quest endpoint search stops immediately after a fatal 401', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  };

  await assert.rejects(
    () => fetchQuestPayload('bad-token'),
    (error) => error instanceof DiscordApiError && error.status === 401,
  );
  assert.equal(calls, 1);
});

test('Quest endpoint search keeps an earlier empty payload when a later endpoint is forbidden', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ quests: [] }), { status: 200 });
    return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
  };

  const payload = await fetchQuestPayload('fixture-token');
  assert.equal(payload.path, '/quests/@me');
  assert.deepEqual(payload.quests, []);
  assert.equal(calls, 2);
});

test('Quest endpoint search propagates abort errors without trying another endpoint', async () => {
  let calls = 0;
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
  globalThis.fetch = async () => {
    calls++;
    throw abortError;
  };

  await assert.rejects(() => fetchQuestPayload('fixture-token'), (error) => error === abortError);
  assert.equal(calls, 1);
});

test('enroll and video progress mutations use the production Quest v9 transport', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: fetchInputUrl(url),
      method: options.method,
      body: JSON.parse(options.body),
    });
    return new Response('{}', { status: 200 });
  };

  await enrollQuestRequest('fixture-token', 'quest-enroll');
  await sendVideoProgressRequest('fixture-token', 'quest-video', 30);
  await sendVideoProgressRequest('fixture-token', 'quest-video-string', '30');

  assert.equal(calls[0].url, 'https://discord.com/api/v9/quests/quest-enroll/enroll');
  assert.deepEqual(calls[0].body, {
    location: 11,
    is_targeted: false,
    metadata_raw: null,
  });
  assert.equal(calls[1].url, 'https://discord.com/api/v9/quests/quest-video/video-progress');
  assert.deepEqual(calls[1].body, { timestamp: 30 });
  assert.equal(calls[2].url, 'https://discord.com/api/v9/quests/quest-video-string/video-progress');
  assert.deepEqual(calls[2].body, { timestamp: 30 });
});

test('video progress rejects malformed timestamps before any network request', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{}', { status: 200 });
  };

  for (const timestamp of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 'invalid']) {
    assert.throws(
      () => sendVideoProgressRequest('fixture-token', 'quest-video-invalid', timestamp),
      /non-negative integer/,
      String(timestamp),
    );
  }
  assert.equal(calls, 0);
});

test('claim falls back from claim-reward to the legacy claim endpoint only on 404', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const requestUrl = fetchInputUrl(url);
    calls.push({ url: requestUrl, body: JSON.parse(options.body) });
    if (requestUrl.endsWith('/claim-reward')) {
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }
    return new Response('{}', { status: 200 });
  };

  await claimQuestRequest('fixture-token', 'quest-claim', 4);
  assert.deepEqual(calls, [
    {
      url: 'https://discord.com/api/v9/quests/quest-claim/claim-reward',
      body: { location: 11, platform: 4 },
    },
    {
      url: 'https://discord.com/api/v9/quests/quest-claim/claim',
      body: { location: 1, platform: 4 },
    },
  ]);
});

test('desktop heartbeat falls back to application payload after stream-key 400', async () => {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (Object.hasOwn(body, 'stream_key')) {
      return new Response(JSON.stringify({ message: 'application payload required' }), { status: 400 });
    }
    return new Response('{}', { status: 200 });
  };

  await sendHeartbeatRequest('fixture-token', {
    id: 'quest-heartbeat',
    applicationId: 'application-1',
  }, false, false);

  assert.deepEqual(calls, [
    { stream_key: 'call:quest-heartbeat:1', terminal: false },
    { application_id: 'application-1', terminal: false },
  ]);
});

test('Discord API errors preserve fatal authentication classification', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Unauthorized' }), {
    status: 401,
  });
  await assert.rejects(
    () => discordFetch('bad-token', '/users/@me'),
    (error) => error instanceof DiscordApiError && error.fatalAuth === true,
  );
});

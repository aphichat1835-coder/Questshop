import assert from 'node:assert/strict';
import test from 'node:test';
import { SURFACE_COMMANDS } from '../../src/discord/commands/definitions.js';
import {
  fetchSurfaceMessageFresh, surfaceNonce, updateOrCreateSurfaceAnchor,
} from '../../src/discord/surfaces/setup.js';
import { normalizeDiscordPayload } from '../../src/discord/payload.js';

function createChannel({ listedMessages = [], sentMessage = { id: 'new-anchor' } } = {}) {
  const fetches = [];
  const sent = [];
  return {
    fetches,
    sent,
    client: { user: { id: 'bot' } },
    messages: {
      fetch: async (input) => {
        fetches.push(input);
        return input?.limit ? listedMessages : null;
      },
    },
    send: async (body) => {
      sent.push(body);
      return sentMessage;
    },
  };
}

test('surface setup fetches its stored anchor from Discord instead of using a stale cache entry', async () => {
  const channel = createChannel();
  await fetchSurfaceMessageFresh(channel, 'old-anchor');
  assert.deepEqual(channel.fetches, [{ message: 'old-anchor', force: true, cache: false }]);
});

test('every setup surface uses a stable Discord nonce no longer than 25 characters', () => {
  for (const surfaceKey of Object.values(SURFACE_COMMANDS)) {
    const first = surfaceNonce(surfaceKey);
    assert.equal(first, surfaceNonce(surfaceKey));
    assert.ok(first.length <= 25, `${surfaceKey} produced a ${first.length}-character nonce`);
  }
  assert.equal(surfaceNonce('LOG_QUEST_OPERATIONS').length, 25);
});

test('surface setup does not treat permission or network failures as a deleted message', async () => {
  const channel = createChannel();
  channel.messages.fetch = async () => {
    throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 });
  };
  await assert.rejects(() => fetchSurfaceMessageFresh(channel, 'old-anchor'), { code: 50013 });
  assert.equal(channel.sent.length, 0);
});

test('surface setup recreates an anchor when its stored Discord message was deleted', async () => {
  const stale = {
    id: 'old-anchor',
    edit: async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 }); },
  };
  const channel = createChannel();
  const result = await updateOrCreateSurfaceAnchor(channel, 'ADMIN_PANEL', { values: {} }, stale);
  assert.equal(result.message.id, 'new-anchor');
  assert.equal(result.recreated, true);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].nonce, 'surface-admin_panel');
});

test('surface setup preserves non-missing Discord failures instead of creating a duplicate anchor', async () => {
  const unavailable = {
    id: 'old-anchor',
    edit: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }); },
  };
  const channel = createChannel();
  await assert.rejects(() => updateOrCreateSurfaceAnchor(channel, 'ADMIN_PANEL', { values: {} }, unavailable), {
    code: 50013,
  });
  assert.equal(channel.sent.length, 0);
});

test('surface setup finds its marker beyond the old 25-message scan without creating a duplicate', async () => {
  const marker = { id: 'older-anchor', author: { id: 'bot' }, embeds: [{ footer: { text: 'Questshop Surface • ADMIN_PANEL' } }],
    edit: async () => marker };
  const listedMessages = Array.from({ length: 40 }, (_, index) => ({ id: `message-${index}`, author: { id: 'other' }, embeds: [] }));
  listedMessages[30] = marker;
  const channel = createChannel({ listedMessages });
  const result = await updateOrCreateSurfaceAnchor(channel, 'ADMIN_PANEL', { values: {} });
  assert.equal(result.message.id, 'older-anchor');
  assert.equal(channel.sent.length, 0);
});

test('rate limiting and transient fetch failures never become a missing-message recreate', async () => {
  for (const error of [
    Object.assign(new Error('rate limit'), { status: 429 }),
    Object.assign(new Error('gateway error'), { status: 503 }),
    Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
  ]) {
    const channel = createChannel();
    channel.messages.fetch = async () => { throw error; };
    await assert.rejects(() => fetchSurfaceMessageFresh(channel, 'old-anchor'));
    assert.equal(channel.sent.length, 0);
  }
});

test('Discord payload boundary strips unsafe mentions and bounds textual output', () => {
  const body = normalizeDiscordPayload({ content: '@everyone '.repeat(500), allowedMentions: { parse: ['everyone'] } });
  assert.ok(body.content.length <= 2_000);
  assert.match(body.content, /@\u200beveryone/);
  assert.deepEqual(body.allowedMentions.parse, []);
});

test('Discord payload boundary preserves only explicitly allowlisted role mentions without control-character placeholders', () => {
  const roleId = '123456789012345678';
  const body = normalizeDiscordPayload({
    content: `<@&${roleId}> @everyone <@&987654321098765432>`,
    allowedMentions: { roles: [roleId] },
  });
  assert.equal(body.content, `<@&${roleId}> @\u200beveryone <@\u200b&987654321098765432>`);
  assert.doesNotMatch(body.content, /[\u0000-\u001f]/);
});

test('Discord payload boundary also bounds embeds and drops an unsafe link component', () => {
  const body = normalizeDiscordPayload({
    embeds: [{ title: '@here '.repeat(100), description: 'x'.repeat(5_000),
      fields: Array.from({ length: 30 }, () => ({ name: 'n'.repeat(300), value: 'v'.repeat(1_200) })) }],
    components: [{ type: 1, components: [
      { type: 2, style: 5, label: 'bad', url: 'javascript:alert(1)' },
      { type: 2, style: 1, label: 'safe', custom_id: 'x'.repeat(120) },
    ] }],
  });
  const [embed] = body.embeds;
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 4_096);
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.fields.every((field) => field.name.length <= 256 && field.value.length <= 1_024));
  assert.ok(body.components[0].components.every((component) => component.url !== 'javascript:alert(1)'));
  assert.equal(body.components[0].components[0].custom_id.length, 100);
});

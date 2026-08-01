import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRunnerStatusContent,
  installPersistentRunnerStatusHeaders,
} from '../src/runner-status-header.js';

test('runner headers keep their own quest count across later edits', () => {
  const state = {};
  const first = formatRunnerStatusContent([
    '```',
    '✅ LOGIN : account-a',
    '🤖 AUTO DAILY ENABLED — CHECK 00:00 / 08:00 / 16:00',
    '🔎 account-a: พบ 3 QUESTS',
    '▶️ account-a: กำลังทำ Quest A',
    '```',
  ].join('\n'), state);

  assert.match(first, /ตรวจพบ Quest ที่พร้อมทำ : 3/);

  const second = formatRunnerStatusContent([
    '```',
    '⌛ account-a: Quest A 25%',
    '```',
  ].join('\n'), state);
  assert.match(second, /ตรวจพบ Quest ที่พร้อมทำ : 3/);
  assert.match(second, /Quest A 25%/);
});

test('separate runner messages never share quest totals', () => {
  const a = {};
  const b = {};
  formatRunnerStatusContent('```\n✅ LOGIN : a\n🔎 a: พบ 2 QUESTS\n```', a);
  formatRunnerStatusContent('```\n✅ LOGIN : b\n🔎 b: พบ 7 QUESTS\n```', b);

  assert.match(formatRunnerStatusContent('```\n⌛ a: 25%\n```', a), /ทำได้ทั้งหมด : 2/);
  assert.match(formatRunnerStatusContent('```\n⌛ b: 25%\n```', b), /ทำได้ทั้งหมด : 7/);
});

test('runner status always fits the Discord message limit', () => {
  const oversizedActivity = formatRunnerStatusContent([
    '```',
    '✅ LOGIN : account-a',
    '🔎 account-a: พบ 1 QUESTS',
    `⌛ ${'activity'.repeat(400)}`,
    '```',
  ].join('\n'));
  assert.ok(oversizedActivity.length <= 1950);
  assert.ok(oversizedActivity.endsWith('\n```'));

  const oversizedHeader = formatRunnerStatusContent([
    '```',
    `✅ LOGIN : ${'account'.repeat(400)}`,
    '🔎 account-a: พบ 1 QUESTS',
    '```',
  ].join('\n'));
  assert.ok(oversizedHeader.length <= 1950);
  assert.ok(oversizedHeader.endsWith('\n```'));
  assert.match(oversizedHeader, /…\n```$/);
});

test('installed wrapper only reformats runner messages', async () => {
  const sent = [];
  const edited = [];
  const rawMessage = {
    async edit(payload) {
      edited.push(payload);
      return this;
    },
  };
  const channel = {
    async send(payload) {
      sent.push(payload);
      return rawMessage;
    },
  };
  const client = { channels: { async fetch() { return channel; } } };

  assert.equal(installPersistentRunnerStatusHeaders(client), true);
  assert.equal(installPersistentRunnerStatusHeaders(client), false);
  const wrapped = await client.channels.fetch('channel');
  await wrapped.send({ content: 'hello' });
  const runnerMessage = await wrapped.send({
    content: '```\n✅ LOGIN : account-a\n🔎 account-a: พบ 4 QUESTS\n```',
  });
  await runnerMessage.edit({ content: '```\n⌛ account-a: 50%\n```' });

  assert.equal(sent[0].content, 'hello');
  assert.match(sent[1].content, /ทำได้ทั้งหมด : 4/);
  assert.match(edited[0].content, /ทำได้ทั้งหมด : 4/);
});

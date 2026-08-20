import test from 'node:test';
import assert from 'node:assert/strict';
import { renderQuestNewProjection } from '../../src/discord/renderers/quest-new.js';
import { renderProjectionForDelivery } from '../../src/workers/outbox-worker.js';

function questRow(overrides = {}) {
  return {
    quest_id: 'quest-1',
    name: 'Quest Artwork Test',
    task_type: 'PLAY_ON_DESKTOP',
    task_target: 900,
    orbs: 750,
    price_cents: 700,
    url: 'https://discord.com/quests/quest-1',
    starts_at: '2026-08-18T17:00:00.000Z',
    expires_at: '2026-08-28T17:00:00.000Z',
    detected_at: '2026-08-19T00:21:00.000Z',
    updated_at: '2026-08-20T05:29:00.000Z',
    artwork_url: 'https://cdn.discordapp.com/assets/quests/quest-1/hero.jpg',
    thumbnail_url: 'https://cdn.discordapp.com/assets/quests/quest-1/gametile.png',
    ...overrides,
  };
}

function poolWithQuest(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}

test('Quest announcement shows Orbs, Quest lifetime, and two static Quest images', async () => {
  const row = questRow();
  const body = await renderQuestNewProjection(poolWithQuest(row), {
    projection_type: 'QUEST_NEW', aggregate_id: row.quest_id,
  });
  const embed = body.embeds[0].data;
  const startUnix = Math.floor(Date.parse(row.starts_at) / 1000);
  const expiryUnix = Math.floor(Date.parse(row.expires_at) / 1000);

  assert.match(embed.title, /พบ Quest ใหม่/);
  assert.ok(embed.description.includes('**รางวัล:** 750 Orbs'));
  assert.ok(embed.description.includes(`**เริ่ม Quest:** <t:${startUnix}:F>`));
  assert.ok(embed.description.includes(`**หมดอายุ:** <t:${expiryUnix}:F>`));
  assert.doesNotMatch(embed.description, /ตรวจพบ|อัปเดต/);
  assert.equal(embed.timestamp, undefined);
  assert.equal(embed.image.url, row.artwork_url);
  assert.equal(embed.thumbnail.url, row.thumbnail_url);
});

test('Quest announcement omits missing media instead of inventing artwork', async () => {
  const body = await renderQuestNewProjection(poolWithQuest(questRow({
    artwork_url: null, thumbnail_url: null,
  })), { projection_type: 'QUEST_NEW', aggregate_id: 'quest-1' });
  const embed = body.embeds[0].data;
  assert.equal(embed.image, undefined);
  assert.equal(embed.thumbnail, undefined);
});

test('Quest announcement renderer keeps one image when the two media URLs are identical', async () => {
  const image = 'https://cdn.discordapp.com/assets/quests/quest-1/shared.jpg';
  const body = await renderQuestNewProjection(poolWithQuest(questRow({
    artwork_url: image, thumbnail_url: image,
  })), { projection_type: 'QUEST_NEW', aggregate_id: 'quest-1' });
  const embed = body.embeds[0].data;
  assert.equal(embed.image.url, image);
  assert.equal(embed.thumbnail, undefined);
});

test('outbox routes QUEST_NEW through the renovated announcement renderer', async () => {
  const body = await renderProjectionForDelivery(poolWithQuest(questRow()), {
    projection_type: 'QUEST_NEW', aggregate_id: 'quest-1',
  });
  assert.match(body.embeds[0].data.description, /เริ่ม Quest/);
  assert.doesNotMatch(body.embeds[0].data.description, /อัปเดต/);
});

test('Quest announcement missing-row fallback remains safe', async () => {
  const body = await renderQuestNewProjection(poolWithQuest(null), {
    projection_type: 'QUEST_NEW', aggregate_id: 'missing',
  });
  assert.equal(body.embeds[0].data.title, 'ไม่พบข้อมูล Quest ใหม่');
  assert.deepEqual(body.allowedMentions, { parse: [] });
});

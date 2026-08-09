import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProjection } from '../../src/discord/renderers/projections.js';

test('history projection renders truthful released and review terminal states', async () => {
  const pool = { query: async (sql) => {
    if (sql.includes('FROM order_items i JOIN orders')) return { rows: [{ id: 'item', state: 'FAILED_RELEASED',
      account_id: 'account', account_username: 'Quest account', account_avatar_url: null, order_id: 'order',
      quest_name: 'Quest', progress_bucket: 25, trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7',
      reservation_state: 'RELEASED', reservation_amount: 500, terminal_reason: 'EXECUTOR_FAILED', updated_at: new Date() }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const body = await renderProjection(pool, { projection_type: 'QUEST_HISTORY', aggregate_id: 'item' });
  assert.match(body.embeds[0].data.title, /คืนเครดิตแล้ว/);
  assert.match(body.embeds[0].data.description, /คืนเครดิตแล้ว/);
  assert.doesNotMatch(body.embeds[0].data.description, /FAILED_RELEASED|RELEASED/);
  assert.deepEqual(body.components, []);
});

test('quest-new projection does not expose internal sale state', async () => {
  const pool = { query: async () => ({ rows: [{ quest_id: 'q', task_type: 'WATCH_VIDEO', task_target: 60,
    orbs: 10, price_cents: 500, name: 'New Quest', detected_at: new Date(), updated_at: new Date(),
    expires_at: new Date(), url: 'https://discord.com/quests/q', sale_state: 'OPEN' }] }) };
  const body = await renderProjection(pool, { projection_type: 'QUEST_NEW', aggregate_id: 'q' });
  assert.doesNotMatch(body.embeds[0].data.description, /OPEN|WATCH(?:_\\)?VIDEO|สถานะการรับงาน/);
  assert.doesNotMatch(body.embeds[0].data.description, /สถานะ:/);
  assert.equal(body.embeds[0].data.footer, undefined);
  assert.match(body.embeds[0].data.description, /ดูวิดีโอ/);
  assert.match(body.embeds[0].data.description, /ดู Quest ได้ที่นี่/);
});

test('order DM uses Discord link buttons instead of markdown action links', async () => {
  const pool = { query: async (sql) => {
    if (sql.includes('FROM order_aggregates')) return { rows: [{ id: 'order', account_username: 'Account',
      total_items: 3, captured_items: 2, released_items: 1, review_items: 0 }] };
    if (sql.includes('FROM order_items i LEFT JOIN wallet_reservations')) return { rows: [
      { id: 'item-1', sequence_number: 1, quest_name: 'Quest 1', state: 'READY_TO_CLAIM', price_cents: 500,
        claim_url: 'https://discord.com/quests/first', terminal_reason: null, reservation_state: 'CAPTURED',
        amount_cents: 500, message_id: 'message-1' },
      { id: 'item-2', sequence_number: 2, quest_name: 'Quest 2', state: 'READY_TO_CLAIM', price_cents: 500,
        claim_url: 'https://discord.com/quests/second', terminal_reason: null, reservation_state: 'CAPTURED',
        amount_cents: 500, message_id: 'message-2' },
      { id: 'item-3', sequence_number: 3, quest_name: 'Quest 3', state: 'FAILED_RELEASED', price_cents: 500,
        claim_url: null, terminal_reason: 'EXECUTOR_FAILED', reservation_state: 'RELEASED',
        amount_cents: 500, message_id: 'message-3' },
    ] };
    if (sql.includes('COALESCE(sum(r.amount_cents)')) return { rows: [{ captured_cents: 1000,
      released_cents: 500, reserved_cents: 0 }] };
    if (sql.includes('SELECT discord_user_id FROM orders')) return { rows: [{ discord_user_id: 'user' }] };
    if (sql.includes('SELECT available_cents,reserved_cents FROM wallets')) return { rows: [{ available_cents: 1000,
      reserved_cents: 0 }] };
    if (sql.includes('SELECT guild_id,channel_id FROM surfaces')) return { rows: [{ guild_id: 'guild', channel_id: 'history' }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const body = await renderProjection(pool, { projection_type: 'ORDER_DM', aggregate_id: 'order' },
    { env: { DISCORD_GUILD_ID: 'guild' } });
  assert.doesNotMatch(body.embeds[0].data.description, /\[ประวัติ\]|\[รับรางวัล\]/);
  assert.deepEqual(body.components[0].components.map((button) => button.data.label),
    ['รับรางวัลทั้งหมด', 'ดูประวัติ Quest ทั้งหมด']);
  assert.deepEqual(body.components[0].components.map((button) => button.data.url),
    ['https://discord.com/quests/first', 'https://discord.com/channels/guild/history']);
});

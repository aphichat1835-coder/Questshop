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
  assert.match(body.embeds[0].data.title, /คืนเงิน/);
  assert.match(body.embeds[0].data.description, /RELEASED/);
  assert.deepEqual(body.components, []);
});

test('quest-new projection does not expose internal sale state', async () => {
  const pool = { query: async () => ({ rows: [{ quest_id: 'q', task_type: 'WATCH_VIDEO', task_target: 60,
    orbs: 10, price_cents: 500, name: 'New Quest', detected_at: new Date(), updated_at: new Date(),
    expires_at: new Date(), url: 'https://discord.com/quests/q', sale_state: 'OPEN' }] }) };
  const body = await renderProjection(pool, { projection_type: 'QUEST_NEW', aggregate_id: 'q' });
  assert.doesNotMatch(body.embeds[0].data.description, /สถานะซื้อ/);
  assert.match(body.embeds[0].data.description, /WATCH\\_VIDEO/);
});

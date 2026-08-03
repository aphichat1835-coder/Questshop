import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { resolvePrice } from '../../src/domain/pricing/resolver.js';
import { resolvePromotionBonus } from '../../src/domain/promotions/resolver.js';
import { bangkokDayBounds } from '../../src/db/postgres-time.js';
import { ANALYSIS_TRANSITIONS, SALE_TRANSITIONS, TEST_TRANSITIONS } from '../../src/domain/catalog/states.js';
import { ORDER_ITEM_TRANSITIONS } from '../../src/domain/orders/states.js';
import { TOPUP_TRANSITIONS } from '../../src/domain/payments/states.js';
import { RUNNER_JOB_TRANSITIONS } from '../../src/domain/runner/states.js';
import { REVIEW_TRANSITIONS } from '../../src/domain/reviews/states.js';
import { createTestPool } from '../fixtures/postgres.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function graphStates(graph) { return [...new Set([...Object.keys(graph), ...Object.values(graph).flat()])].sort(); }
async function databaseStates(table, column) {
  const rows = (await pool.query(`SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c WHERE c.conrelid=$1::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) LIKE $2`, [table, `%${column}%`])).rows;
  const values = rows.flatMap((row) => [...row.definition.matchAll(/'([A-Z][A-Z0-9_]*)'::text/g)]
    .map((match) => match[1]));
  return [...new Set(values)].sort();
}

test('PostgreSQL enum checks remain synchronized with domain state graphs', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  assert.deepEqual(await databaseStates('quests', 'analysis_state'), graphStates(ANALYSIS_TRANSITIONS));
  assert.deepEqual(await databaseStates('quests', 'sale_state'), graphStates(SALE_TRANSITIONS));
  assert.deepEqual(await databaseStates('quest_test_runs', 'state'), graphStates(TEST_TRANSITIONS));
  assert.deepEqual(await databaseStates('topups', 'status'), graphStates(TOPUP_TRANSITIONS));
  assert.deepEqual(await databaseStates('order_items', 'state'), graphStates(ORDER_ITEM_TRANSITIONS));
  assert.deepEqual(await databaseStates('runner_jobs', 'state'), graphStates(RUNNER_JOB_TRANSITIONS));
  assert.deepEqual(await databaseStates('manual_reviews', 'state'), graphStates(REVIEW_TRANSITIONS));
});

test('price resolver applies Temporary then Quest then Type then Default and exactly one rule', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7();
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at)
    VALUES('price-q','SUPPORTED','OPEN','Price Quest','WATCH_VIDEO',60,'https://discord.com/quests/price-q',
    clock_timestamp()+interval '1 day')`);
  const rows = [
    ['DEFAULT', null, null, 1000, 0],
    ['TYPE', null, 'WATCH_VIDEO', 900, 0],
    ['QUEST', 'price-q', null, 800, 0],
    ['TEMPORARY', 'price-q', null, 700, 1],
    ['TEMPORARY', 'price-q', null, 650, 0],
  ];
  for (const [type, quest, task, amount, priority] of rows) {
    await pool.query(`INSERT INTO price_rules(id,rule_type,quest_id,task_type,amount_cents,priority,
      config_version,actor_id,trace_id) VALUES($1,$2,$3,$4,$5,$6,1,'test',$7)`,
    [uuidv7(), type, quest, task, amount, priority, trace]);
  }
  const price = await resolvePrice(pool, { questId: 'price-q', taskType: 'WATCH_VIDEO' });
  assert.equal(price.rule_type, 'TEMPORARY');
  assert.equal(BigInt(price.amount_cents), 700n);
});

test('promotion selects highest tier, rounds half-up, caps daily bonus and enforces user limit', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const promotionId = uuidv7(); const trace = uuidv7(); const user = '10000000000000123';
  await pool.query(`INSERT INTO promotions(id,version,name,state,starts_at,ends_at,max_uses_per_user,
    max_bonus_per_day_cents,actor_id,trace_id) VALUES($1,1,'tiers','ACTIVE',clock_timestamp()-interval '1 day',
    clock_timestamp()+interval '1 day',2,5000,'test',$2)`, [promotionId, trace]);
  for (const [minimum, points] of [[10_000, 1000], [30_000, 1500], [60_000, 2000]]) {
    await pool.query(`INSERT INTO promotion_tiers(id,promotion_id,minimum_amount_cents,basis_points)
      VALUES($1,$2,$3,$4)`, [uuidv7(), promotionId, minimum, points]);
  }
  const first = await resolvePromotionBonus(pool, { promotionId, discordUserId: user,
    principalCents: 30_004n, bangkokDay: '2026-08-02' });
  assert.equal(first.bonusCents, 4_501n);
  assert.equal(first.eligible, true);
  await pool.query(`INSERT INTO promotion_usages(id,promotion_id,discord_user_id,topup_id,bangkok_day,
    principal_cents,bonus_cents) VALUES($1,$2,$3,$4,'2026-08-02',30004,4501)`,
  [uuidv7(), promotionId, user, uuidv7()]);
  const capped = await resolvePromotionBonus(pool, { promotionId, discordUserId: user,
    principalCents: 30_004n, bangkokDay: '2026-08-02' });
  assert.equal(capped.bonusCents, 499n);
  await pool.query(`INSERT INTO promotion_usages(id,promotion_id,discord_user_id,topup_id,bangkok_day,
    principal_cents,bonus_cents) VALUES($1,$2,$3,$4,'2026-08-01',10000,1000)`,
  [uuidv7(), promotionId, user, uuidv7()]);
  const limited = await resolvePromotionBonus(pool, { promotionId, discordUserId: user,
    principalCents: 60_000n, bangkokDay: '2026-08-02' });
  assert.equal(limited.eligible, false);
  assert.equal(limited.reason, 'USER_LIMIT');
});

test('Bangkok promotion day is computed in PostgreSQL and does not drift through UTC midnight', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const bounds = await bangkokDayBounds(pool, '2026-08-01T17:30:00.000Z');
  assert.equal(bounds.bangkok_day, '2026-08-02');
  assert.equal(new Date(bounds.starts_at).toISOString(), '2026-08-01T17:00:00.000Z');
});

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { reconcileSellableQuests } from '../../src/workers/maintenance-worker.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('expired sellable Quest records both sale and analysis transitions during maintenance', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'SYSTEM', actorId: 'maintenance', guildId: 'guild',
    idempotencyKey: 'quest-expiry-reconcile' });
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at)
    VALUES('already-expired','SUPPORTED','OPEN','Expired Quest','WATCH_VIDEO',60,
      'https://discord.com/quests/already-expired',clock_timestamp()-interval '1 minute')`);
  await reconcileSellableQuests(pool, context, 3);
  const quest = (await pool.query("SELECT analysis_state,sale_state FROM quests WHERE quest_id='already-expired'"))
    .rows[0];
  assert.deepEqual(quest, { analysis_state: 'EXPIRED', sale_state: 'EXPIRED' });
  const transitions = (await pool.query(`SELECT aggregate_type,from_state,to_state FROM state_transitions
    WHERE aggregate_id='already-expired' ORDER BY aggregate_type`)).rows;
  assert.deepEqual(transitions, [
    { aggregate_type: 'QUEST_ANALYSIS', from_state: 'SUPPORTED', to_state: 'EXPIRED' },
    { aggregate_type: 'QUEST_SALE', from_state: 'OPEN', to_state: 'EXPIRED' },
  ]);
});

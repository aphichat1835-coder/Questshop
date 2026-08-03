import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createContext } from '../../src/shared/correlation.js';
import { maintainQuestRetests } from '../../src/workers/maintenance-worker.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('an overdue Monitor retest pauses sale and creates the next three-attempt batch', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const traceId = uuidv7();
  const context = createContext({ actorType: 'SYSTEM', actorId: 'maintenance', guildId: 'guild',
    traceId, idempotencyKey: 'retest-availability' });
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,
    engine_version,executor_version,contract_version)
    VALUES('retest-no-monitor','SUPPORTED','OPEN','Retest Quest','WATCH_VIDEO',60,
      'https://discord.com/quests/retest-no-monitor','1','1','1')`);
  const testRun = uuidv7();
  await pool.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,executor_version,
    contract_version,trace_id,completed_at) VALUES($1,'retest-no-monitor','TEST_PASSED','1','1','1',$2,
      clock_timestamp()-interval '25 hours')`,
  [testRun, traceId]);

  await withTransaction({ pool, isolation: 'SERIALIZABLE' },
    (client) => maintainQuestRetests(client, context));
  assert.equal((await pool.query("SELECT sale_state FROM quests WHERE quest_id='retest-no-monitor'"))
    .rows[0].sale_state, 'PAUSED');
  assert.equal((await pool.query(`SELECT state FROM quest_test_batches WHERE quest_id='retest-no-monitor'
    ORDER BY created_at DESC LIMIT 1`)).rows[0].state, 'FAILED');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM state_transitions
    WHERE aggregate_type='QUEST_SALE' AND aggregate_id='retest-no-monitor'
      AND from_state='OPEN' AND to_state='PAUSED' AND reason_code='RETEST_REQUIRED'`)).rows[0].count), 1);

  const monitorId = uuidv7();
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state)
    VALUES($1,'monitor-retest',ARRAY['TEST'],'ACTIVE')`, [monitorId]);
  await withTransaction({ pool, isolation: 'SERIALIZABLE' },
    (client) => maintainQuestRetests(client, context));
  const batch = (await pool.query(`SELECT * FROM quest_test_batches WHERE quest_id='retest-no-monitor'
    ORDER BY created_at DESC LIMIT 1`)).rows[0];
  assert.equal(batch.state, 'RUNNING');
  const queued = (await pool.query(`SELECT * FROM quest_test_runs WHERE batch_id=$1`, [batch.id])).rows[0];
  assert.deepEqual({ state: queued.state, monitor: queued.target_monitor_id, attempt: queued.attempt_in_monitor },
    { state: 'TEST_QUEUED', monitor: monitorId, attempt: 1 });
});

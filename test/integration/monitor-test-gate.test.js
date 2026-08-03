import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createContext } from '../../src/shared/correlation.js';
import { ingestDiscovery } from '../../src/domain/catalog/service.js';
import { advanceMonitorTestBatch, markMonitorTestBatchPassed } from '../../src/domain/catalog/test-gate.js';
import { forcePublishFailedMonitorTest } from '../../src/domain/admin/operations-service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function normalized(id) {
  return {
    id, name: `Quest ${id}`, eventName: 'WATCH_VIDEO', secondsNeeded: 60,
    startsAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    url: `https://discord.com/quests/${id}`, artworkUrl: null, orbs: 10,
    executorId: 'video', autoSupported: true, coreComplete: true, compatibilityIssues: [],
  };
}

test('Monitor discovery stays private until a batch passes; exhausted monitors create an auditable override', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const traceId = uuidv7();
  const context = createContext({ traceId, actorType: 'SYSTEM', actorId: 'scanner', guildId: 'guild', idempotencyKey: 'monitor-gate' });
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'owner',$2)`, [uuidv7(), traceId]);
  const monitorOne = uuidv7(); const monitorTwo = uuidv7();
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state,priority) VALUES
    ($1,'monitor-one',ARRAY['TEST'],'ACTIVE',10),($2,'monitor-two',ARRAY['TEST'],'ACTIVE',5)`, [monitorOne, monitorTwo]);

  await ingestDiscovery({ normalized: normalized('monitor-gated'), source: 'MONITOR' }, context, { pool });
  assert.equal((await pool.query("SELECT sale_state FROM quests WHERE quest_id='monitor-gated'")).rows[0].sale_state, 'CLOSED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='monitor-gated'`)).rows[0].count), 0);

  // Fail three attempts on the first Monitor, then three on the second. The
  // batch service owns selection and stops at the first possible success.
  for (let index = 0; index < 6; index += 1) {
    const run = (await pool.query(`SELECT * FROM quest_test_runs WHERE batch_id=(SELECT id FROM quest_test_batches
      WHERE quest_id='monitor-gated' ORDER BY created_at DESC LIMIT 1) ORDER BY created_at DESC LIMIT 1`)).rows[0];
    await pool.query("UPDATE quest_test_runs SET state='TEST_FAILED',completed_at=clock_timestamp() WHERE id=$1", [run.id]);
    await withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (client) => {
      const quest = (await client.query("SELECT * FROM quests WHERE quest_id='monitor-gated' FOR UPDATE")).rows[0];
      await advanceMonitorTestBatch(client, { run, quest,
        error: { code: 'TEST_MUTATION_NOT_VERIFIED', message: `attempt ${index + 1} did not verify` }, context });
    });
  }
  const alert = (await pool.query("SELECT * FROM quest_test_failure_alerts WHERE quest_id='monitor-gated'")).rows[0];
  assert.equal(alert.state, 'OPEN');
  const forced = await forcePublishFailedMonitorTest({ alertId: alert.id, reason: 'operator verified external evidence' },
    { ...context, actorType: 'ADMIN', actorId: 'admin' }, { pool });
  assert.equal(forced.quest.sale_state, 'OPEN');
  assert.equal((await pool.query("SELECT public_test_gate_override FROM quests WHERE quest_id='monitor-gated'"))
    .rows[0].public_test_gate_override, true);

  await ingestDiscovery({ normalized: normalized('monitor-passed'), source: 'MONITOR' }, context, { pool });
  const passRun = (await pool.query(`SELECT * FROM quest_test_runs WHERE quest_id='monitor-passed'
    ORDER BY created_at DESC LIMIT 1`)).rows[0];
  await pool.query("UPDATE quest_test_runs SET state='TEST_PASSED',completed_at=clock_timestamp() WHERE id=$1", [passRun.id]);
  await withTransaction({ pool, isolation: 'SERIALIZABLE' },
    (client) => markMonitorTestBatchPassed(client, { run: passRun, context }));
  await ingestDiscovery({ normalized: normalized('monitor-passed'), source: 'MONITOR' }, context, { pool });
  assert.equal((await pool.query("SELECT sale_state FROM quests WHERE quest_id='monitor-passed'")).rows[0].sale_state, 'OPEN');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='monitor-passed'`)).rows[0].count), 1);
});

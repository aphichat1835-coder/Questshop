import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { ingestDiscovery } from '../../src/domain/catalog/service.js';
import { enqueueProjection } from '../../src/domain/outbox/service.js';
import { questContractHash } from '../../src/quest-engine/schema/contract.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function expiredQuest(id) {
  const quest = {
    id,
    name: `Expired ${id}`,
    eventName: 'WATCH_VIDEO',
    secondsNeeded: 60,
    startsAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    url: `https://discord.com/quests/${id}`,
    artworkUrl: null,
    orbs: 10,
    applicationId: `app-${id}`,
    progressKey: 'video',
    executorId: 'video',
    autoSupported: true,
    coreComplete: true,
    compatibilityIssues: [],
  };
  const contract = questContractHash(quest, {
    engineVersion: '1.0.0', executorVersion: '1.0.0', contractVersion: '1.0.0',
  });
  return { ...quest, contractHash: contract.hash, contractComplete: contract.complete };
}

test('Monitor discovery keeps expired Quest as history but never queues a Monitor test or QUEST_NEW', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'SYSTEM', actorId: 'scanner', guildId: 'guild',
    idempotencyKey: 'expired-monitor-discovery' });
  const result = await ingestDiscovery({ normalized: expiredQuest('expired-monitor'), source: 'MONITOR' },
    context, { pool });

  assert.equal(result.quest.sale_state, 'EXPIRED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM quest_test_batches
    WHERE quest_id='expired-monitor'`)).rows[0].count), 0);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='expired-monitor'`)).rows[0].count), 0);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_OPERATION' AND aggregate_id='expired-monitor'`)).rows[0].count), 1);
});

test('expired customer-side discovery is never emitted as QUEST_NEW either', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'CUSTOMER', actorId: 'customer', guildId: 'guild',
    idempotencyKey: 'expired-customer-discovery' });
  const result = await ingestDiscovery({ normalized: expiredQuest('expired-customer'), source: 'CUSTOMER_CHECKOUT' },
    context, { pool });

  assert.equal(result.quest.sale_state, 'EXPIRED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='expired-customer'`)).rows[0].count), 0);
});

test('outbox enqueue boundary refuses a first-time QUEST_NEW for an already expired Quest', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'SYSTEM', actorId: 'maintenance', guildId: 'guild',
    idempotencyKey: 'expired-outbox-guard' });
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at)
    VALUES('expired-outbox','SUPPORTED','CLOSED','Expired outbox','WATCH_VIDEO',60,
      'https://discord.com/quests/expired-outbox',clock_timestamp()-interval '1 minute')`);

  const projection = await enqueueProjection(pool, {
    projectionType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: 'expired-outbox',
    aggregateVersion: 1, surfaceKey: 'QUEST_NEW', context,
  });
  assert.equal(projection, null);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='expired-outbox'`)).rows[0].count), 0);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM outbox_events
    WHERE aggregate_type='QUEST' AND aggregate_id='expired-outbox'`)).rows[0].count), 0);
});

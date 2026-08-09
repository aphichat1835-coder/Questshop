import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrations.js';
import { validateRuntimeRole } from '../../src/db/role-contract.js';
import { MAX_COMPATIBLE_SCHEMA_VERSION } from '../../src/config/versions.js';

const { Pool } = pg;
let pool;
before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
});
after(async () => { await pool?.end(); });

test('migration runner applies and verifies all checksums idempotently', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const first = await runMigrations({ pool, gitSha: 'integration-test' });
  const second = await runMigrations({ pool, gitSha: 'integration-test' });
  assert.equal(first.current, MAX_COMPATIBLE_SCHEMA_VERSION);
  assert.equal(second.current, MAX_COMPATIBLE_SCHEMA_VERSION);
  const rows = (await pool.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
  assert.equal(rows.length, MAX_COMPATIBLE_SCHEMA_VERSION);
  assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)));
  const permissionSnapshot = await pool.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='surfaces' AND column_name='expected_permissions'`);
  assert.equal(permissionSnapshot.rowCount, 0);
  const contractColumns = await pool.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='contract_hash'
      AND table_name IN ('quest_metadata_revisions','quest_test_batches','quest_test_runs',
        'checkout_quest_options','order_items','runner_jobs')`);
  assert.equal(contractColumns.rowCount, 6);
  const activeBatchIndex = await pool.query(`SELECT indexdef FROM pg_indexes
    WHERE schemaname='public' AND indexname='quest_test_batches_one_active_contract_idx'`);
  assert.match(activeBatchIndex.rows[0].indexdef, /quest_id, contract_hash/);

  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state)
    VALUES('LOG_SYSTEM','guild','channel','message','DRIFTED')
    ON CONFLICT(surface_key) DO UPDATE SET state='DRIFTED'`);
  await pool.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
    VALUES(gen_random_uuid(),'PERMISSION_DRIFT','LOG_SYSTEM','OPEN','ERROR','{}',gen_random_uuid())
    ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED'
    DO UPDATE SET severity='ERROR',state='OPEN'`);
  const retireMigration = await readFile(new URL('../../migrations/0019_remove_permission_drift.sql', import.meta.url), 'utf8');
  await pool.query(retireMigration);
  assert.equal((await pool.query("SELECT state FROM surfaces WHERE surface_key='LOG_SYSTEM'")).rows[0].state, 'ACTIVE');
  assert.equal((await pool.query("SELECT state,severity FROM incidents WHERE incident_code='PERMISSION_DRIFT' AND scope='LOG_SYSTEM'")).rows[0].state, 'RESOLVED');
  assert.equal((await pool.query("SELECT severity FROM incidents WHERE incident_code='PERMISSION_DRIFT' AND scope='LOG_SYSTEM'")).rows[0].severity, 'WARNING');
});

test('deployment grants the split runtime role access to the durable Quest API cooldown table', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const runtimeRole = `questshop_runtime_${randomBytes(6).toString('hex')}`;
  await pool.query(`CREATE ROLE ${runtimeRole}`);
  try {
    await runMigrations({ pool, gitSha: 'integration-test', runtimeRole });
    const privileges = (await pool.query(`SELECT
      has_schema_privilege($1,'public','USAGE') AS can_use_schema,
      has_table_privilege($1,'quest_api_rate_limit_blocks','SELECT') AS can_select,
      has_table_privilege($1,'quest_api_rate_limit_blocks','INSERT') AS can_insert,
      has_table_privilege($1,'quest_api_rate_limit_blocks','UPDATE') AS can_update,
      has_table_privilege($1,'quest_api_rate_limit_blocks','DELETE') AS can_delete`, [runtimeRole])).rows[0];
    assert.deepEqual(privileges, { can_use_schema: true, can_select: true,
      can_insert: true, can_update: true, can_delete: true });
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${runtimeRole}`);
      const contract = await validateRuntimeRole(client, { enforce: true });
      assert.deepEqual(contract.violations, []);
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  } finally {
    await pool.query(`DROP OWNED BY ${runtimeRole}; DROP ROLE ${runtimeRole}`);
  }
});

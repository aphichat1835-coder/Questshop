import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrations.js';
import { MAX_COMPATIBLE_SCHEMA_VERSION } from '../../src/config/versions.js';

const { Pool } = pg;
let pool;
after(async () => { await pool?.end(); });

test('migration runner applies and verifies all checksums idempotently', async (t) => {
  if (!process.env.TEST_DATABASE_URL) return t.skip('TEST_DATABASE_URL not set');
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
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

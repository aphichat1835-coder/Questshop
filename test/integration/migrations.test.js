import test, { after } from 'node:test';
import assert from 'node:assert/strict';
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
});

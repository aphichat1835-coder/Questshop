import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeploymentMigrations } from '../../src/db/deployment-migrations.js';

function database(schemaVersion = 21) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (sql.includes('to_regclass')) return { rows: [{ value: 'schema_migrations' }] };
      if (sql.includes('COALESCE(max(version)')) return { rows: [{ value: schemaVersion }] };
      if (sql.includes('INSERT INTO backup_runs')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const env = {
  NODE_ENV: 'production', BACKUP_ENABLED: true, GIT_SHA: 'a'.repeat(40),
  DATABASE_POOL_URL: 'postgresql://runtime:password@host/db?sslmode=verify-full',
};

test('production deployment refuses a pending migration when backup is disabled', async () => {
  const pool = database();
  let migrated = false;
  await assert.rejects(() => runDeploymentMigrations({ ...env, BACKUP_ENABLED: false }, {
    pool, listMigrations: async () => [{ version: 22 }],
    runMigrations: async () => { migrated = true; },
    validateOrInitializeKeyringSentinels: async () => {},
  }), /verified pre-migration backup/);
  assert.equal(migrated, false);
});

test('deployment verifies and records a backup before applying a pending production migration', async () => {
  const pool = database();
  const order = [];
  const result = await runDeploymentMigrations(env, {
    pool, listMigrations: async () => [{ version: 22 }],
    validateBackupTools: async () => { order.push('tools'); },
    createEncryptedBackup: async () => {
      order.push('backup');
      return { id: 'backup', objectKey: 'object', checksum: 'sum', sizeBytes: 1,
        schemaVersion: 21, encryptionKeyVersion: 1 };
    },
    runMigrations: async () => { order.push('migrate'); return { current: 22, applied: 1 }; },
    validateOrInitializeKeyringSentinels: async () => { order.push('sentinels'); },
  });
  assert.deepEqual(order, ['tools', 'backup', 'migrate', 'sentinels']);
  assert.equal(result.preMigrationBackup, 'VERIFIED');
  assert.ok(pool.queries.some((sql) => sql.includes('INSERT INTO backup_runs')));
});

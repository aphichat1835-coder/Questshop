import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDirectPool } from './pools.js';
import { MAX_COMPATIBLE_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION } from '../config/versions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION_LOCK_KEY = 7_448_173_001;

function checksum(content) {
  return createHash('sha256').update(content).digest('hex');
}
function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export const listMigrations = async (directory = path.join(root, 'migrations')) => {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(directory, name), 'utf8');
    return { version: Number(name.slice(0, 4)), name, sql, checksum: checksum(sql) };
  }));
};

export async function validateSchemaCompatibility(database) {
  const current = Number((await database.query(
    'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
  )).rows[0].version);
  if (current < MIN_COMPATIBLE_SCHEMA_VERSION || current > MAX_COMPATIBLE_SCHEMA_VERSION) {
    throw new Error(`Schema version ${current} is incompatible with this app; run the deployment migration step first`);
  }
  return current;
}

// Runtime is read-only with respect to schema, but it must not accept an image
// whose migration source differs from the durable schema records. Version alone
// cannot detect a modified migration file with the same numeric version.
export async function validateMigrationChecksums(database, { migrations = null } = {}) {
  const expected = migrations ?? await listMigrations();
  const applied = (await database.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows;
  if (applied.length !== expected.length) {
    throw Object.assign(new Error('Schema migration record count does not match this application'), {
      code: 'SCHEMA_MIGRATION_CHECKSUM_MISMATCH',
    });
  }
  const actualByVersion = new Map(applied.map((row) => [Number(row.version), row]));
  for (const migration of expected) {
    const actual = actualByVersion.get(migration.version);
    if (!actual || actual.name !== migration.name || actual.checksum !== migration.checksum) {
      throw Object.assign(new Error(`Schema migration checksum mismatch: ${migration.name}`), {
        code: 'SCHEMA_MIGRATION_CHECKSUM_MISMATCH', version: migration.version,
      });
    }
  }
  return expected.length;
}

export const runMigrations = async ({ pool = getDirectPool(), gitSha = 'unknown', runtimeRole = null } = {}) => {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        git_sha text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const migrations = await listMigrations();
    let applied = 0;
    for (const migration of migrations) {
      const existing = (await client.query(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [migration.version],
      )).rows[0];
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch: ${migration.name}`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(`
          INSERT INTO schema_migrations(version, name, checksum, git_sha)
          VALUES ($1, $2, $3, $4)
        `, [migration.version, migration.name, migration.checksum, gitSha]);
        await client.query('COMMIT');
        applied += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    if (runtimeRole) {
      // Hardened PostgreSQL installations may revoke the default PUBLIC
      // schema access.  Table/function grants are unusable without USAGE,
      // while USAGE alone does not permit DDL or data access.
      await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(runtimeRole)}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
        quest_api_rate_limit_blocks TO ${quoteIdentifier(runtimeRole)}`);
      await client.query(`GRANT EXECUTE ON FUNCTION
        questshop_prune_wallet_ledger(timestamptz, integer) TO ${quoteIdentifier(runtimeRole)}`);
      await client.query(`GRANT EXECUTE ON FUNCTION
        questshop_prune_operational_details(timestamptz, timestamptz, integer) TO ${quoteIdentifier(runtimeRole)}`);
    }
    const current = await validateSchemaCompatibility(client);
    return { current, applied };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
};

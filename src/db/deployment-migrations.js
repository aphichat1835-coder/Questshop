import { createEncryptedBackup, validateBackupTools } from '../adapters/s3/backup.js';
import { validateOrInitializeKeyringSentinels } from '../bootstrap/keyring-sentinels.js';
import { closeDirectPool, getDirectPool } from './pools.js';
import { listMigrations, runMigrations } from './migrations.js';

export async function runDeploymentMigrations(env, options = {}) {
  const backupEnabled = env.BACKUP_ENABLED ?? env.NODE_ENV === 'production';
  const database = options.pool ?? getDirectPool(env);
  const close = options.pool ? null : (options.closeDirectPool ?? closeDirectPool);
  const list = options.listMigrations ?? listMigrations;
  const migrate = options.runMigrations ?? runMigrations;
  const backup = options.createEncryptedBackup ?? createEncryptedBackup;
  const validateTools = options.validateBackupTools ?? validateBackupTools;
  const validateSentinels = options.validateOrInitializeKeyringSentinels
    ?? validateOrInitializeKeyringSentinels;
  try {
    if (env.NODE_ENV === 'production' && backupEnabled) await validateTools(env);
    const migrationTable = (await database.query(
      "SELECT to_regclass('public.schema_migrations') AS value",
    )).rows[0].value;
    let preMigrationBackup = null;
    let backupStatus = 'FIRST_INSTALL_NOT_APPLICABLE';
    if (migrationTable) {
      const schemaVersion = Number((await database.query(
        'SELECT COALESCE(max(version),0) AS value FROM schema_migrations',
      )).rows[0].value);
      const migrations = await list();
      const latestVersion = migrations.length ? Math.max(...migrations.map((migration) => migration.version)) : 0;
      if (schemaVersion < latestVersion && env.NODE_ENV === 'production' && !backupEnabled) {
        throw new Error('Production migrations require a verified pre-migration backup');
      }
      if (schemaVersion < latestVersion && backupEnabled) {
        preMigrationBackup = await backup({ env, schemaVersion, reason: 'pre-migration' });
        backupStatus = 'VERIFIED';
      } else backupStatus = backupEnabled ? 'NO_PENDING_MIGRATION' : 'DISABLED_BY_CONFIG';
    }
    const migration = await migrate({ pool: database, gitSha: env.GIT_SHA,
      runtimeRole: decodeURIComponent(new URL(env.DATABASE_POOL_URL).username) });
    await validateSentinels(database, env);
    if (preMigrationBackup) {
      await database.query(`INSERT INTO backup_runs(id,backup_type,state,object_key,checksum,size_bytes,schema_version,
        git_sha,encryption_key_version,manifest,completed_at) VALUES($1,'PRE_MIGRATION','VERIFIED',$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,
      [preMigrationBackup.id, preMigrationBackup.objectKey, preMigrationBackup.checksum,
        preMigrationBackup.sizeBytes, preMigrationBackup.schemaVersion, env.GIT_SHA,
        preMigrationBackup.encryptionKeyVersion, preMigrationBackup]);
    }
    return { migration, preMigrationBackup: backupStatus };
  } finally {
    await close?.();
  }
}

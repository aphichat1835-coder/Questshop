import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { loadEnvironment } from '../config/env.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { closeDirectPool, closePools, getDirectPool, getRuntimePool } from '../db/pools.js';
import { listMigrations, runMigrations } from '../db/migrations.js';
import { acquireLease, renewLease } from '../db/leases.js';
import { createDiscordClient } from '../discord/client.js';
import { routeInteraction } from '../discord/interactions/router.js';
import { startWorkers } from '../workers/worker-manager.js';
import { closeHealthServer, createHealthState, startHealthServer } from './health-server.js';
import { createLogger } from '../shared/logger.js';
import { createEncryptedBackup, validateBackupTools } from '../adapters/s3/backup.js';
import { runMaintenance } from '../workers/maintenance-worker.js';
import { validateKeyringCoverage } from './keyring-coverage.js';
import { validateRuntimeRole } from '../db/role-contract.js';
import { processOutbox } from '../workers/outbox-worker.js';

export async function startup({ health = createHealthState(), server: existingServer = null,
  onRuntimeLeaseLost = null } = {}) {
  const requestedPort = /^\d+$/.test(process.env.PORT ?? '') ? Number(process.env.PORT) : 3000;
  const bootstrapPort = requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : 3000;
  const logger = createLogger({ gitSha: process.env.GIT_SHA ?? 'bootstrap' });
  const server = existingServer ?? await startHealthServer({ port: bootstrapPort,
    statusToken: process.env.STATUS_TOKEN ?? 'unconfigured', state: health });
  const abortController = new AbortController();
  let client;
  let pool;
  try {
    const env = loadEnvironment();
    const backupEnabled = env.BACKUP_ENABLED ?? env.NODE_ENV === 'production';
    health.checks.config = 'OK';
    if (env.NODE_ENV === 'production' && backupEnabled) {
      await validateBackupTools(env);
      health.checks.backupTools = 'OK';
    } else health.checks.backupTools = env.NODE_ENV === 'production'
      ? 'DISABLED_BY_CONFIG' : 'SKIPPED_NON_PRODUCTION';
    const directPool = getDirectPool(env);
    const migrationTable = (await directPool.query("SELECT to_regclass('public.schema_migrations') AS value")).rows[0].value;
    let preMigrationBackup = null;
    if (migrationTable) {
      const schemaVersion = Number((await directPool.query('SELECT COALESCE(max(version),0) AS value FROM schema_migrations')).rows[0].value);
      const latestVersion = Math.max(...(await listMigrations()).map((migration) => migration.version));
      if (backupEnabled && schemaVersion < latestVersion) {
        preMigrationBackup = await createEncryptedBackup({ env, schemaVersion, reason: 'pre-migration' });
        health.checks.preMigrationBackup = 'VERIFIED';
      } else health.checks.preMigrationBackup = backupEnabled
        ? 'NO_PENDING_MIGRATION' : 'DISABLED_BY_CONFIG';
    } else health.checks.preMigrationBackup = 'FIRST_INSTALL_NOT_APPLICABLE';
    await runMigrations({ gitSha: env.GIT_SHA,
      runtimeRole: decodeURIComponent(new URL(env.DATABASE_POOL_URL).username) });
    if (preMigrationBackup) {
      await directPool.query(`INSERT INTO backup_runs(id,backup_type,state,object_key,checksum,size_bytes,schema_version,
        git_sha,encryption_key_version,manifest,completed_at) VALUES($1,'PRE_MIGRATION','VERIFIED',$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,
      [preMigrationBackup.id, preMigrationBackup.objectKey, preMigrationBackup.checksum,
        preMigrationBackup.sizeBytes, preMigrationBackup.schemaVersion, env.GIT_SHA,
        preMigrationBackup.encryptionKeyVersion, preMigrationBackup]);
    }
    await closeDirectPool();
    health.checks.schema = 'OK';
    pool = getRuntimePool(env);
    await pool.query('SELECT 1');
    await validateKeyringCoverage(pool, env);
    health.checks.keyrings = 'OK';
    const roleContract = await validateRuntimeRole(pool, { enforce: env.NODE_ENV === 'production' });
    health.checks.runtimeRole = roleContract.violations.length ? 'DEGRADED' : 'OK';
    health.checks.database = 'OK';
    const holder = uuidv7();
    let runtimeLease = await acquireLease({ resourceType: 'RUNTIME', resourceId: env.DISCORD_GUILD_ID, holder, ttlSeconds: 60 });
    if (!runtimeLease) throw new Error('Another Questshop runtime holds the production guild lease');
    health.checks.runtimeLease = 'OK';
    const config = await loadRuntimeConfig(pool);
    client = createDiscordClient();
    client.questshop = { env, logger, health, pool, config };
    client.on('interactionCreate', routeInteraction);
    client.on('error', (error) => logger.error({ error }, 'discord client error'));
    await client.login(env.DISCORD_BOT_TOKEN);
    if (!client.isReady()) await once(client, 'ready');
    const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
    await guild.members.fetchMe();
    await runMaintenance({ env, holder: 'startup-recovery', client, pool,
      runnerConcurrency: Number(config.values?.runnerConcurrency ?? env.RUNNER_CONCURRENCY) });
    health.checks.discord = 'OK';
    const workers = startWorkers({ client, pool, env, signal: abortController.signal, health, logger,
      startDeferred: false });
    const notificationsEnabled = (await pool.query("SELECT enabled FROM feature_gates WHERE gate='NOTIFICATIONS_ENABLED'"))
      .rows[0]?.enabled === true;
    if (notificationsEnabled) {
      await processOutbox({ holder: uuidv7(), client, pool, env });
    }
    workers.startDeferred();
    const heartbeat = (async () => {
      while (!abortController.signal.aborted) {
        await delay(15_000, undefined, { signal: abortController.signal, ref: false });
        if (abortController.signal.aborted) break;
        try {
        runtimeLease = await renewLease({ resourceType: 'RUNTIME', resourceId: env.DISCORD_GUILD_ID,
          holder, fencingToken: runtimeLease.fencing_token, ttlSeconds: 60 });
        } catch (error) {
          health.ready = false; health.status = 'INCIDENT'; health.lastError = error;
          abortController.abort(error);
          Promise.resolve(onRuntimeLeaseLost?.(error)).catch((callbackError) => {
            logger.error({ error: callbackError }, 'runtime lease-loss shutdown failed');
          });
          break;
        }
      }
    })().catch((error) => { if (error?.name !== 'AbortError') throw error; });
    health.ready = true;
    const storeOpen = (await pool.query("SELECT enabled FROM feature_gates WHERE gate='STORE_OPEN'"))
      .rows[0]?.enabled === true;
    health.status = storeOpen ? 'HEALTHY' : 'MAINTENANCE';
    logger.info({ guildId: env.DISCORD_GUILD_ID }, 'Questshop ready');
    return { env, logger, health, server, pool, client, config, workers, abortController, heartbeat,
      runtimeLease, runtimeHolder: holder, acceptingInteractions: true, shutdownPromise: null };
  } catch (error) {
    health.lastError = error; health.status = 'NOT_READY';
    logger.error({ error }, 'Questshop startup failed');
    if (pool && error?.code === 'SECRET_DECRYPT_FAILED') {
      await pool.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
        VALUES($1,'SECRET_DECRYPT_FAILED','CRYPTO','OPEN','CRITICAL',$2,$3)
        ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED' DO UPDATE SET
          severity=EXCLUDED.severity,evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
      [uuidv7(), { phase: 'startup' }, uuidv7()]).catch(() => null);
    }
    abortController.abort(error);
    client?.destroy();
    await closePools().catch(() => null);
    health.live = false;
    await closeHealthServer(server).catch(() => null);
    throw error;
  }
}

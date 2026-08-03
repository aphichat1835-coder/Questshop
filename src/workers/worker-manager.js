import { v7 as uuidv7 } from 'uuid';
import { runWorkerLoop } from './loop.js';
import { processPayment } from './payment-worker.js';
import { processOutbox } from './outbox-worker.js';
import { acquireRunnableJob, processRunnerJob, renewRunnerJob } from '../domain/runner/service.js';
import { setTimeout as delay } from 'node:timers/promises';
import { runMaintenance } from './maintenance-worker.js';
import { createContext } from '../shared/correlation.js';
import { scanMonitor } from './discovery-worker.js';
import { testQuest } from './quest-test-worker.js';
import { runScheduledBackup } from './backup-worker.js';
import { runRetention } from './retention-worker.js';
import { rotateEncryptedRows } from './key-rotation-worker.js';
import { evaluateAlerts } from './alert-worker.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';

async function gate(pool, name) {
  return (await pool.query('SELECT enabled FROM feature_gates WHERE gate = $1', [name])).rows[0]?.enabled === true;
}

function configuredRunnerConcurrency(client, env) {
  return Math.max(1, Math.min(env.RUNNER_CONCURRENCY_HARD_MAX,
    Number(client.questshop.config.values?.runnerConcurrency ?? env.RUNNER_CONCURRENCY)));
}

export function startWorkers({ client, pool, env, signal, health, logger, startDeferred = true }) {
  const tasks = [];
  const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
  eventLoopMonitor.enable();
  const recordIteration = async ({ name, error, durationMs }) => {
    await pool.query(`INSERT INTO operation_metrics(id,operation,outcome,duration_ms,error_class)
      VALUES($1,$2,$3,$4,$5)`, [uuidv7(), `WORKER:${name}`, error ? 'ERROR' : 'SUCCESS',
      Math.max(0, durationMs), error?.category ?? error?.code ?? error?.name ?? null]);
    if (error?.code === 'SECRET_DECRYPT_FAILED') {
      await pool.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
        VALUES($1,'SECRET_DECRYPT_FAILED','CRYPTO','OPEN','CRITICAL',$2,$3)
        ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED' DO UPDATE SET
          severity=EXCLUDED.severity,evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
      [uuidv7(), { worker: name }, uuidv7()]);
    }
  };
  const start = (name, runOnce, idleMs) => tasks.push(runWorkerLoop({ name, signal, health, logger,
    runOnce, idleMs, onIteration: recordIteration }));
  start('readiness', async () => {
    try {
      await pool.query('SELECT 1');
      health.checks.database = 'OK';
      health.checks.discord = client.isReady() ? 'OK' : 'NOT_READY';
      const ready = client.isReady() && health.checks.schema === 'OK'
        && health.checks.runtimeLease === 'OK' && health.checks.config === 'OK'
        && health.checks.keyrings === 'OK';
      health.ready = ready;
      if (ready) health.lastError = null;
      if (!ready) health.status = 'NOT_READY';
      else if (health.status === 'NOT_READY') health.status = 'HEALTHY';
      return false;
    } catch (error) {
      health.ready = false; health.status = 'NOT_READY';
      health.checks.database = 'FAILED'; health.lastError = error;
      throw error;
    }
  }, 5_000);
  start('outbox-1', async () => (await gate(pool, 'NOTIFICATIONS_ENABLED'))
    && processOutbox({ holder: uuidv7(), client, pool, env }), 250);
  start('outbox-2', async () => (await gate(pool, 'NOTIFICATIONS_ENABLED'))
    && processOutbox({ holder: uuidv7(), client, pool, env }), 250);
  let deferredStarted = false;
  const startDeferredWorkers = () => {
    if (deferredStarted) return;
    deferredStarted = true;
    start('payment', async () => processPayment({ holder: uuidv7(), env, signal, pool,
      autoCredit: await gate(pool, 'AUTO_CREDIT_ENABLED') }), 500);
    for (let index = 0; index < env.RUNNER_CONCURRENCY_HARD_MAX; index += 1) {
      const holder = uuidv7();
      start(`runner-${index + 1}`, async () => {
        if (!(await gate(pool, 'RUNNER_DISPATCH_ENABLED'))) return false;
        const effectiveConcurrency = configuredRunnerConcurrency(client, env);
        if (index >= effectiveConcurrency) return false;
        const acquisitionContext = createContext({ actorType: 'SYSTEM', actorId: holder,
          guildId: env.DISCORD_GUILD_ID, idempotencyKey: `runner-acquire:${uuidv7()}` });
        const job = await acquireRunnableJob({ holder }, acquisitionContext);
        if (!job) return false;
        const leaseAbort = new AbortController();
        const jobSignal = AbortSignal.any([signal, leaseAbort.signal]);
        const heartbeat = (async () => {
          while (!jobSignal.aborted) {
            await delay(15_000, undefined, { signal: jobSignal, ref: false });
            if (jobSignal.aborted) break;
            try { await renewRunnerJob(job, 60); }
            catch (error) { leaseAbort.abort(error); break; }
          }
        })().catch(() => {});
        try { await processRunnerJob(job, { env: { ...env, RUNNER_CONCURRENCY: effectiveConcurrency }, signal: jobSignal }); }
        finally { leaseAbort.abort('runner finished'); await heartbeat; }
        return true;
      }, 250);
    }
    const maintenanceHolder = uuidv7();
    const scannerHolder = uuidv7();
    start('scanner', async () => (await gate(pool, 'QUEST_SCANNER_ENABLED'))
      && scanMonitor({ env, pool, signal, holder: scannerHolder,
        runnerConcurrency: configuredRunnerConcurrency(client, env) }), 60_000);
    const testHolder = uuidv7();
    start('quest-test', async () => (await gate(pool, 'QUEST_BACKGROUND_TESTING_ENABLED'))
      && testQuest({ env, pool, signal, holder: testHolder,
        runnerConcurrency: configuredRunnerConcurrency(client, env) }), 1_000);
    start('backup', () => runScheduledBackup({ env, pool }), 60_000);
    start('retention', () => runRetention({ pool }), 60_000);
    start('key-rotation', async () => (await rotateEncryptedRows({ pool, env })) > 0, 60_000);
    start('alerts', () => evaluateAlerts({ pool, health, eventLoopMonitor }), 60_000);
    start('maintenance', async () => {
      await runMaintenance({ env, holder: maintenanceHolder, client, pool,
        runnerConcurrency: configuredRunnerConcurrency(client, env) });
      return false;
    }, 60_000);
  };
  if (startDeferred) startDeferredWorkers();
  return { tasks, startDeferred: startDeferredWorkers, stop: async () => {
    const results = await Promise.allSettled(tasks);
    eventLoopMonitor.disable();
    return results;
  } };
}

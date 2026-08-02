import { v7 as uuidv7 } from 'uuid';
import { readFile } from 'node:fs/promises';
import { RUNNER_VERSION_COMPATIBILITY } from '../config/versions.js';
import { isRunnerVersionCompatible } from '../config/versions.js';

async function memoryLimitBytes() {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const value = (await readFile(path, 'utf8')).trim();
      if (value !== 'max' && /^\d+$/.test(value)) {
        const bytes = Number(value);
        if (Number.isSafeInteger(bytes) && bytes > 0 && bytes < 2 ** 50) return bytes;
      }
    } catch { /* try the next cgroup layout */ }
  }
  return null;
}

async function setIncident(client, { code, scope, active, severity, evidence }) {
  if (active) {
    await client.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
      VALUES($1,$2,$3,'OPEN',$4,$5,$6) ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED'
      DO UPDATE SET severity=EXCLUDED.severity,evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
    [uuidv7(), code, scope, severity, evidence, uuidv7()]);
  } else {
    await client.query(`UPDATE incidents SET state='RESOLVED',resolved_at=clock_timestamp(),
      updated_at=clock_timestamp() WHERE incident_code=$1 AND scope=$2 AND state<>'RESOLVED'`, [code, scope]);
  }
}

export async function evaluateAlerts({ pool, health, eventLoopMonitor = null }) {
  const rssBytes = process.memoryUsage().rss;
  const memoryLimit = await memoryLimitBytes();
  const memoryPercent = memoryLimit ? (rssBytes / memoryLimit) * 100 : null;
  const eventLoopLagMs = eventLoopMonitor ? eventLoopMonitor.percentile(99) / 1e6 : null;
  eventLoopMonitor?.reset();
  await pool.query(`INSERT INTO operation_metrics(id,operation,outcome,duration_ms,error_class)
    VALUES($1,'SYSTEM:MEMORY_PERCENT',$2,$3,NULL),
      ($4,'SYSTEM:EVENT_LOOP_LAG',$5,$6,NULL)`, [uuidv7(), memoryPercent != null && memoryPercent > 85 ? 'ERROR' : 'SUCCESS',
    Math.round(Math.max(0, memoryPercent ?? 0)), uuidv7(),
    eventLoopLagMs != null && eventLoopLagMs > 500 ? 'ERROR' : 'SUCCESS',
    Math.round(Math.max(0, eventLoopLagMs ?? 0))]);
  const [financial, queue, outbox, errors, backup, restore, counts, gates, activeVersions] = await Promise.all([
    pool.query(`SELECT
      (SELECT count(*)::integer FROM wallets WHERE available_cents<0 OR reserved_cents<0) AS negative,
      (SELECT count(*)::integer FROM wallets w LEFT JOIN LATERAL (
        SELECT available_after_cents,reserved_after_cents FROM wallet_transactions t
        WHERE t.discord_user_id=w.discord_user_id ORDER BY created_at DESC,id DESC LIMIT 1) t ON true
        LEFT JOIN LATERAL (SELECT available_cents,reserved_cents FROM wallet_checkpoints c
          WHERE c.discord_user_id=w.discord_user_id ORDER BY created_at DESC LIMIT 1) c ON true
        WHERE COALESCE(t.available_after_cents,c.available_cents,w.available_cents)<>w.available_cents
          OR COALESCE(t.reserved_after_cents,c.reserved_cents,w.reserved_cents)<>w.reserved_cents) AS mismatch,
      (SELECT count(*)::integer FROM topups WHERE status IN ('AMBIGUOUS','MANUAL_REVIEW')) AS ambiguous,
      (SELECT count(*)::integer FROM dead_letter_items d WHERE d.state='DEAD_LETTER'
        AND d.category IN ('FINANCIAL','AUDIT')) AS financial_dlq`),
    pool.query(`SELECT count(*)::integer AS stuck FROM runner_jobs
      WHERE state NOT IN ('COMPLETED','FAILED') AND updated_at<clock_timestamp()-interval '5 minutes'`),
    pool.query(`SELECT count(*)::integer AS stuck FROM outbox_events
      WHERE state IN ('PENDING','LEASED','RETRY_WAIT')
        AND GREATEST(created_at,available_at)<clock_timestamp()-interval '5 minutes'`),
    pool.query(`SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE outcome<>'SUCCESS')::integer AS failed FROM operation_metrics
      WHERE created_at>=clock_timestamp()-interval '5 minutes'`),
    pool.query("SELECT EXTRACT(EPOCH FROM clock_timestamp()-completed_at)*1000 AS age_ms FROM backup_runs WHERE state='VERIFIED' ORDER BY completed_at DESC LIMIT 1"),
    pool.query("SELECT EXTRACT(EPOCH FROM clock_timestamp()-completed_at)*1000 AS age_ms FROM restore_drills WHERE state='VERIFIED' ORDER BY completed_at DESC LIMIT 1"),
    pool.query(`SELECT
      (SELECT count(*)::integer FROM runner_jobs WHERE state NOT IN ('COMPLETED','FAILED')) AS queue,
      (SELECT count(*)::integer FROM outbox_events WHERE state IN ('PENDING','LEASED','RETRY_WAIT')) AS outbox,
      (SELECT count(*)::integer FROM manual_reviews WHERE state<>'RESOLVED') AS reviews,
      (SELECT count(*)::integer FROM incidents WHERE state<>'RESOLVED') AS incidents,
      (SELECT enabled FROM feature_gates WHERE gate='STORE_OPEN') AS store_open`),
    pool.query('SELECT gate,enabled,version FROM feature_gates ORDER BY gate'),
    pool.query(`SELECT DISTINCT engine_version,executor_version,contract_version,runner_state_schema_version
      FROM runner_jobs WHERE state NOT IN ('COMPLETED','FAILED')`),
  ]);
  const invariant = financial.rows[0];
  const engineVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.engine);
  const executorVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.executor);
  const contractVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.contract);
  const stateSchemas = RUNNER_VERSION_COMPATIBILITY.map((item) => item.stateSchema);
  const incompatibleJobs = Number((await pool.query(`SELECT count(*)::integer AS count FROM runner_jobs j
    WHERE j.state NOT IN ('COMPLETED','FAILED') AND NOT EXISTS(SELECT 1 FROM
      unnest($1::text[],$2::text[],$3::text[],$4::integer[])
      AS supported(engine,executor,contract,state_schema)
      WHERE supported.engine=j.engine_version AND supported.executor=j.executor_version
        AND supported.contract=j.contract_version
        AND supported.state_schema=j.runner_state_schema_version)`,
  [engineVersions, executorVersions, contractVersions, stateSchemas])).rows[0].count);
  if (incompatibleJobs > 0) await pool.query(`UPDATE feature_gates SET enabled=false,
    reason='RUNNER_VERSION_INCOMPATIBLE',version=version+CASE WHEN enabled THEN 1 ELSE 0 END,
    updated_at=clock_timestamp() WHERE gate='RUNNER_DISPATCH_ENABLED' AND enabled=true`);
  await setIncident(pool, { code: 'RUNNER_VERSION_INCOMPATIBLE', scope: 'RUNNER',
    active: incompatibleJobs > 0, severity: 'CRITICAL', evidence: { count: incompatibleJobs } });
  const financialBroken = invariant.negative > 0 || invariant.mismatch > 0;
  if (financialBroken) await pool.query(`UPDATE feature_gates SET enabled=false,reason='FINANCIAL_INVARIANT',
    version=version+CASE WHEN enabled THEN 1 ELSE 0 END,updated_at=clock_timestamp()
    WHERE gate IN ('AUTO_CREDIT_ENABLED','ORDER_ACCEPTING') AND enabled=true`);
  await setIncident(pool, { code: 'FINANCIAL_INVARIANT', scope: 'WALLET_LEDGER', active: financialBroken,
    severity: 'CRITICAL', evidence: invariant });
  await setIncident(pool, { code: 'PAYMENT_AMBIGUOUS', scope: 'TRUEMONEY', active: invariant.ambiguous > 0,
    severity: 'CRITICAL', evidence: { count: invariant.ambiguous } });
  await setIncident(pool, { code: 'FINANCIAL_DLQ', scope: 'OUTBOX', active: invariant.financial_dlq > 0,
    severity: 'CRITICAL', evidence: { count: invariant.financial_dlq } });
  const incompatibleVersions = activeVersions.rows.filter((row) => !isRunnerVersionCompatible(row));
  await setIncident(pool, { code: 'RUNNER_VERSION_INCOMPATIBLE', scope: 'RUNNER',
    active: incompatibleVersions.length > 0, severity: 'ERROR', evidence: { versions: incompatibleVersions } });
  await setIncident(pool, { code: 'QUEUE_STUCK', scope: 'RUNNER', active: queue.rows[0].stuck > 0,
    severity: 'ERROR', evidence: queue.rows[0] });
  await setIncident(pool, { code: 'OUTBOX_STUCK', scope: 'DISCORD', active: outbox.rows[0].stuck > 0,
    severity: 'ERROR', evidence: outbox.rows[0] });
  const errorRateHigh = errors.rows[0].total >= 20
    && errors.rows[0].failed / errors.rows[0].total >= 0.05;
  await setIncident(pool, { code: 'ERROR_RATE_HIGH', scope: 'OPERATIONS', active: errorRateHigh,
    severity: 'ERROR', evidence: errors.rows[0] });
  const backupAgeMs = backup.rows[0]?.age_ms == null ? Infinity : Number(backup.rows[0].age_ms);
  const restoreAgeMs = restore.rows[0]?.age_ms == null ? Infinity : Number(restore.rows[0].age_ms);
  await setIncident(pool, { code: 'BACKUP_STALE', scope: 'DATABASE', active: backupAgeMs > 26 * 3_600_000,
    severity: 'ERROR', evidence: { ageMs: Number.isFinite(backupAgeMs) ? backupAgeMs : null } });
  await setIncident(pool, { code: 'RESTORE_DRILL_STALE', scope: 'DATABASE', active: restoreAgeMs > 35 * 86_400_000,
    severity: 'ERROR', evidence: { ageMs: Number.isFinite(restoreAgeMs) ? restoreAgeMs : null } });
  const staleWorkers = Object.entries(health.workers).filter(([, worker]) => worker.lastTick
    && Date.now() - Date.parse(worker.lastTick) > 120_000).map(([name]) => name);
  await setIncident(pool, { code: 'WORKER_HEARTBEAT_MISSING', scope: 'RUNTIME', active: staleWorkers.length > 0,
    severity: 'ERROR', evidence: { workers: staleWorkers } });
  const sustained = (await pool.query(`SELECT
    count(*) FILTER (WHERE operation='SYSTEM:MEMORY_PERCENT' AND outcome='ERROR'
      AND created_at>=clock_timestamp()-interval '10 minutes')::integer AS memory_high,
    count(*) FILTER (WHERE operation='SYSTEM:EVENT_LOOP_LAG' AND outcome='ERROR'
      AND created_at>=clock_timestamp()-interval '5 minutes')::integer AS event_loop_high
    FROM operation_metrics`)).rows[0];
  await setIncident(pool, { code: 'MEMORY_PRESSURE', scope: 'RUNTIME', active: sustained.memory_high >= 10,
    severity: 'ERROR', evidence: { percent: memoryPercent, rssBytes, memoryLimitBytes: memoryLimit,
      highSamples: sustained.memory_high } });
  await setIncident(pool, { code: 'EVENT_LOOP_LAG', scope: 'RUNTIME', active: sustained.event_loop_high >= 5,
    severity: 'ERROR', evidence: { p99Ms: eventLoopLagMs, highSamples: sustained.event_loop_high } });
  health.overview = { ...counts.rows[0], queueSoftLimit: 400, queueHardLimit: 500,
    gates: Object.fromEntries(gates.rows.map((row) => [row.gate, {
      enabled: row.enabled, version: Number(row.version),
    }])),
    backupAgeMs: Number.isFinite(backupAgeMs) ? backupAgeMs : null,
    restoreAgeMs: Number.isFinite(restoreAgeMs) ? restoreAgeMs : null,
    memoryRssBytes: rssBytes, memoryLimitBytes: memoryLimit, memoryPercent, eventLoopLagP99Ms: eventLoopLagMs };
  health.status = financialBroken ? 'INCIDENT' : !health.ready ? 'NOT_READY'
    : queue.rows[0].stuck || outbox.rows[0].stuck ? 'DEGRADED'
      : !counts.rows[0].store_open ? 'MAINTENANCE' : 'HEALTHY';
  return false;
}

import { decryptSecret } from '../adapters/crypto/keyring.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createQuestApiClient, profileFromEnv } from '../quest-engine/api/client.js';
import { createContext } from '../shared/correlation.js';
import { ingestDiscovery } from '../domain/catalog/service.js';

async function loadScanMonitors(pool) {
  return (await pool.query(`SELECT m.*,c.key_version,c.nonce,c.ciphertext,c.auth_tag
    FROM monitor_accounts m JOIN monitor_credentials c ON c.monitor_id=m.id
    WHERE m.state='ACTIVE' AND 'SCAN'=ANY(m.capabilities)
    ORDER BY m.priority DESC,m.last_used_at NULLS FIRST`)).rows;
}

async function markMonitorFailure(pool, monitor, error, context) {
  const failures = Number(monitor.consecutive_failures) + 1;
  let state = 'ACTIVE';
  if (error.fatalAuth || failures >= 5) state = 'QUARANTINED';
  else if (failures >= 3) state = 'COOLDOWN';
  const updated = (await pool.query(`UPDATE monitor_accounts SET state=$2,consecutive_failures=$3,
    state_version=state_version+CASE WHEN state<>$2 THEN 1 ELSE 0 END,
    cooldown_until=CASE WHEN $2='COOLDOWN' THEN clock_timestamp()+interval '15 minutes' ELSE cooldown_until END,
    updated_at=clock_timestamp() WHERE id=$1 AND state<>'DISABLED' RETURNING state`,
  [monitor.id, state, failures])).rows[0];
  if (updated?.state === 'QUARANTINED') await pool.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
    VALUES(gen_random_uuid(),'MONITOR_QUARANTINED',$1,'OPEN','ERROR',$2,$3)
    ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED'
    DO UPDATE SET evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
  [monitor.id, { errorCode: error.code ?? error.name }, context.traceId]);
}

async function fetchMonitorQuests(monitor, { env, signal }) {
  const token = decryptSecret({ keyVersion: monitor.key_version, nonce: monitor.nonce,
    ciphertext: monitor.ciphertext, authTag: monitor.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
  `monitor:${monitor.id}:${env.DISCORD_GUILD_ID}`);
  const api = createQuestApiClient({ token, profile: profileFromEnv(env) });
  let last = [];
  // Metadata can lag on one Discord account.  Perform the bounded source
  // retry before moving to a fallback account; network retries are still
  // handled inside the safe-read API client.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [profile, quests] = await Promise.all([api.fetchCurrentUser(signal), api.fetchQuests(signal)]);
    if (String(profile.id) !== monitor.account_id) {
      throw Object.assign(new Error('Monitor account mismatch'), { fatalAuth: true });
    }
    last = quests;
    if (quests.every((quest) => quest.coreComplete)) break;
    if (attempt < 2) await delay([2_000, 5_000][attempt], undefined, { signal, ref: false });
  }
  return last;
}

async function ingestMonitorQuests(quests, { source, context, pool, runnerConcurrency }) {
  for (const quest of quests) {
    await ingestDiscovery({ normalized: quest, source, runnerConcurrency }, context, { pool });
  }
}

function missingCoreQuestIds(quests) {
  return new Set(quests.filter((quest) => !quest.coreComplete).map((quest) => quest.id));
}

async function scanOneMonitor(monitor, input, context) {
  try {
    const quests = await fetchMonitorQuests(monitor, input);
    await ingestMonitorQuests(quests, { source: 'MONITOR', context, pool: input.pool,
      runnerConcurrency: input.runnerConcurrency });
    await input.pool.query(`UPDATE monitor_accounts SET consecutive_failures=0,last_used_at=clock_timestamp(),
      updated_at=clock_timestamp() WHERE id=$1`, [monitor.id]);
    return { quests, missingCoreIds: missingCoreQuestIds(quests) };
  } catch (error) {
    await markMonitorFailure(input.pool, monitor, error, context);
    return { quests: [], missingCoreIds: new Set(['FETCH_FAILED']) };
  }
}

export async function scanMonitor({ env, pool, signal, holder, runnerConcurrency = env.RUNNER_CONCURRENCY }) {
  const monitors = await loadScanMonitors(pool);
  if (!monitors.length) return false;
  const context = createContext({ actorType: 'SYSTEM', actorId: holder, guildId: env.DISCORD_GUILD_ID,
    idempotencyKey: `monitor-scan:${monitors[0].id}:${new Date().toISOString().slice(0, 16)}` });
  const input = { env, pool, signal, runnerConcurrency };
  const primary = await scanOneMonitor(monitors[0], input, context);
  if (!primary.missingCoreIds.size) return true;
  // Merge observations by Quest ID through catalog ingestion.  Do not scan
  // every fallback when primary metadata is complete: that keeps normal
  // discovery inexpensive while still making incomplete data recoverable.
  const missing = primary.missingCoreIds;
  for (const monitor of monitors.slice(1)) {
    const fallback = await scanOneMonitor(monitor, input, context);
    for (const quest of fallback.quests) {
      if (quest.coreComplete) missing.delete(quest.id);
    }
    if (!missing.size) break;
  }
  return true;
}

import { decryptSecret } from '../adapters/crypto/keyring.js';
import { createQuestApiClient, profileFromEnv } from '../quest-engine/api/client.js';
import { createContext } from '../shared/correlation.js';
import { ingestDiscovery } from '../domain/catalog/service.js';

export async function scanMonitor({ env, pool, signal, holder, runnerConcurrency = env.RUNNER_CONCURRENCY }) {
  const monitor = (await pool.query(`SELECT m.*,c.key_version,c.nonce,c.ciphertext,c.auth_tag
    FROM monitor_accounts m JOIN monitor_credentials c ON c.monitor_id=m.id
    WHERE m.state='ACTIVE' AND 'SCAN'=ANY(m.capabilities)
    ORDER BY m.priority DESC,m.last_used_at NULLS FIRST LIMIT 1`)).rows[0];
  if (!monitor) return false;
  const context = createContext({ actorType: 'SYSTEM', actorId: holder, guildId: env.DISCORD_GUILD_ID,
    idempotencyKey: `monitor-scan:${monitor.id}:${new Date().toISOString().slice(0, 16)}` });
  try {
    const token = decryptSecret({ keyVersion: monitor.key_version, nonce: monitor.nonce,
      ciphertext: monitor.ciphertext, authTag: monitor.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
    `monitor:${monitor.id}:${env.DISCORD_GUILD_ID}`);
    const api = createQuestApiClient({ token, profile: profileFromEnv(env) });
    const [profile, quests] = await Promise.all([api.fetchCurrentUser(signal), api.fetchQuests(signal)]);
    if (String(profile.id) !== monitor.account_id) throw Object.assign(new Error('Monitor account mismatch'), { fatalAuth: true });
    for (const quest of quests) await ingestDiscovery({ normalized: quest, source: 'MONITOR',
      runnerConcurrency }, context, { pool });
    await pool.query(`UPDATE monitor_accounts SET consecutive_failures=0,last_used_at=clock_timestamp(),
      updated_at=clock_timestamp() WHERE id=$1`, [monitor.id]);
  } catch (error) {
    const failures = Number(monitor.consecutive_failures) + 1;
    let state = 'ACTIVE';
    if (error.fatalAuth || failures >= 5) state = 'QUARANTINED';
    else if (failures >= 3) state = 'COOLDOWN';
    await pool.query(`UPDATE monitor_accounts SET state=$2,consecutive_failures=$3,
      cooldown_until=CASE WHEN $2='COOLDOWN' THEN clock_timestamp()+interval '15 minutes' ELSE cooldown_until END,
      updated_at=clock_timestamp() WHERE id=$1`, [monitor.id, state, failures]);
    if (state === 'QUARANTINED') await pool.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
      VALUES(gen_random_uuid(),'MONITOR_QUARANTINED',$1,'OPEN','ERROR',$2,$3)
      ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED'
      DO UPDATE SET evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
    [monitor.id, { errorCode: error.code ?? error.name }, context.traceId]);
  }
  return true;
}

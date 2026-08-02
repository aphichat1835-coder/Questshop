import { v7 as uuidv7 } from 'uuid';
import { encryptSecret } from '../../adapters/crypto/keyring.js';
import { createQuestApiClient, profileFromEnv } from '../../quest-engine/api/client.js';
import { withTransaction } from '../../db/transaction.js';
import { appendAdminAudit } from './audit.js';

export async function addMonitor({ token, capabilities, env, reason }, context, options = {}) {
  if (!Array.isArray(capabilities) || !capabilities.length
    || capabilities.some((item) => !['SCAN', 'TEST'].includes(item)) || !reason?.trim()) {
    throw new TypeError('invalid monitor request');
  }
  const questApiFactory = options.questApiFactory ?? createQuestApiClient;
  const profile = await questApiFactory({ token, profile: profileFromEnv(env) }).fetchCurrentUser();
  const id = uuidv7();
  const encrypted = encryptSecret(token, env.DATA_ENCRYPTION_KEYS_JSON, `monitor:${id}:${context.guildId}`);
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const row = (await client.query(`INSERT INTO monitor_accounts(id,account_id,username,capabilities,state)
      VALUES($1,$2,$3,$4,'ACTIVE') RETURNING *`, [id, String(profile.id), profile.global_name ?? profile.username,
      [...new Set(capabilities)]])).rows[0];
    await client.query(`INSERT INTO monitor_credentials(monitor_id,key_version,nonce,ciphertext,auth_tag)
      VALUES($1,$2,$3,$4,$5)`, [id, encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authTag]);
    await appendAdminAudit(client, { action: 'ADD_MONITOR', targetType: 'MONITOR', targetId: id,
      actorId: context.actorId, after: { accountId: row.account_id, capabilities: row.capabilities }, reason, context });
    return row;
  });
}

export async function rotateMonitorCredential({ monitorId, token, env, reason }, context, options = {}) {
  if (!token?.trim() || !reason?.trim()) throw new TypeError('token and reason are required');
  const questApiFactory = options.questApiFactory ?? createQuestApiClient;
  const profile = await questApiFactory({ token, profile: profileFromEnv(env) }).fetchCurrentUser();
  const encrypted = encryptSecret(token, env.DATA_ENCRYPTION_KEYS_JSON,
    `monitor:${monitorId}:${context.guildId}`);
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const monitor = (await client.query('SELECT * FROM monitor_accounts WHERE id=$1 FOR UPDATE', [monitorId])).rows[0];
    if (!monitor || String(profile.id) !== monitor.account_id) throw new TypeError('Monitor token account does not match');
    const credential = (await client.query('SELECT key_version FROM monitor_credentials WHERE monitor_id=$1 FOR UPDATE',
      [monitorId])).rows[0];
    await client.query(`UPDATE monitor_credentials SET key_version=$2,nonce=$3,ciphertext=$4,auth_tag=$5,
      updated_at=transaction_timestamp() WHERE monitor_id=$1`, [monitorId, encrypted.keyVersion,
      encrypted.nonce, encrypted.ciphertext, encrypted.authTag]);
    const updated = (await client.query(`UPDATE monitor_accounts SET state='ACTIVE',consecutive_failures=0,
      cooldown_until=NULL,updated_at=transaction_timestamp() WHERE id=$1 RETURNING *`, [monitorId])).rows[0];
    await appendAdminAudit(client, { action: 'ROTATE_MONITOR_CREDENTIAL', targetType: 'MONITOR',
      targetId: monitorId, actorId: context.actorId,
      before: { state: monitor.state, keyVersion: credential.key_version },
      after: { state: updated.state, keyVersion: encrypted.keyVersion }, reason, context });
    return updated;
  });
}

export async function setMonitorState({ monitorId, state, reason }, context, options = {}) {
  if (!['ACTIVE', 'QUARANTINED', 'DISABLED'].includes(state) || !reason?.trim()) {
    throw new TypeError('invalid monitor state change');
  }
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query('SELECT * FROM monitor_accounts WHERE id=$1 FOR UPDATE', [monitorId])).rows[0];
    if (!before) throw new TypeError('monitor not found');
    const updated = (await client.query(`UPDATE monitor_accounts SET state=$2,
      cooldown_until=CASE WHEN $2='ACTIVE' THEN NULL ELSE cooldown_until END,
      updated_at=transaction_timestamp() WHERE id=$1 RETURNING *`, [monitorId, state])).rows[0];
    await appendAdminAudit(client, { action: 'MONITOR_STATE_CHANGE', targetType: 'MONITOR',
      targetId: monitorId, actorId: context.actorId, before: { state: before.state },
      after: { state: updated.state }, reason, context });
    return updated;
  });
}

import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { AuthorizationError, QuestshopError } from '../../shared/errors.js';

export async function createAdminSession({ actorId, guildId, channelId, messageId,
  operation, payload, configVersion, ttlMinutes = 5 }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => (
    (await client.query(`INSERT INTO interaction_sessions(id,actor_id,guild_id,channel_id,message_id,
      operation,config_version,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,
      clock_timestamp()+make_interval(mins=>$9)) RETURNING *`, [uuidv7(), actorId, guildId,
      channelId, messageId, operation, configVersion, payload, ttlMinutes])).rows[0]
  ));
}

export async function loadAdminSession({ sessionId, actorId, guildId, channelId = null,
  messageId = null, operation }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const row = (await client.query(`SELECT *,expires_at>clock_timestamp() AS fresh
      FROM interaction_sessions WHERE id=$1`, [sessionId])).rows[0];
    if (!row?.fresh || row.state!=='ACTIVE' || row.operation!==operation) throw new QuestshopError('SESSION_EXPIRED', 'เซสชัน Admin หมดอายุ');
    if (row.actor_id!==actorId || row.guild_id!==guildId) throw new AuthorizationError('เซสชัน Admin เป็นของผู้ใช้อื่น');
    if (channelId && row.channel_id!==channelId) throw new AuthorizationError('เซสชันถูกเรียกจากห้องอื่น');
    const effectiveMessageId = messageId ?? context?.messageId ?? null;
    if (row.message_id && row.message_id !== effectiveMessageId) {
      throw new AuthorizationError('เซสชันถูกเรียกจากข้อความอื่น');
    }
    return row;
  });
}

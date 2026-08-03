import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { appendAdminAudit } from '../admin/audit.js';

const TYPES = new Set(['TOPUP_BLOCKED', 'ORDER_BLOCKED']);

export async function blockUser({ discordUserId, blockType, reason, expiresInHours = null }, context, options = {}) {
  if (!TYPES.has(blockType) || !reason?.trim() || (expiresInHours != null
    && (!Number.isInteger(Number(expiresInHours)) || Number(expiresInHours) <= 0))) throw new TypeError('invalid block request');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    await client.query(`UPDATE blocklist_entries SET revoked_at=clock_timestamp(),revoked_by='SYSTEM'
      WHERE discord_user_id=$1 AND block_type=$2 AND revoked_at IS NULL AND expires_at<=clock_timestamp()`,
    [discordUserId, blockType]);
    const existing = (await client.query(`SELECT * FROM blocklist_entries WHERE discord_user_id=$1
      AND block_type=$2 AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR UPDATE`, [discordUserId, blockType])).rows[0];
    if (existing) return existing;
    const row = (await client.query(`INSERT INTO blocklist_entries(id,discord_user_id,block_type,reason,
      expires_at,actor_id,trace_id) VALUES($1,$2,$3,$4,
      CASE WHEN $5::integer IS NULL THEN NULL ELSE clock_timestamp()+make_interval(hours=>$5::integer) END,$6,$7) RETURNING *`,
    [uuidv7(), discordUserId, blockType, reason.trim(), expiresInHours, context.actorId, context.traceId])).rows[0];
    await appendAdminAudit(client, { action: 'BLOCK_USER', targetType: 'DISCORD_USER', targetId: discordUserId,
      actorId: context.actorId, after: row, reason, context });
    return row;
  });
}

export async function unblockUser({ discordUserId, blockType, reason }, context, options = {}) {
  if (!TYPES.has(blockType) || !reason?.trim()) throw new TypeError('invalid unblock request');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query(`SELECT * FROM blocklist_entries WHERE discord_user_id=$1
      AND block_type=$2 AND revoked_at IS NULL FOR UPDATE`, [discordUserId, blockType])).rows[0];
    if (!before) return null;
    const row = (await client.query(`UPDATE blocklist_entries SET revoked_at=transaction_timestamp(),
      revoked_by=$3 WHERE discord_user_id=$1 AND block_type=$2 AND revoked_at IS NULL RETURNING *`,
    [discordUserId, blockType, context.actorId])).rows[0];
    await appendAdminAudit(client, { action: 'UNBLOCK_USER', targetType: 'DISCORD_USER', targetId: discordUserId,
      actorId: context.actorId, before, after: row, reason, context });
    return row;
  });
}

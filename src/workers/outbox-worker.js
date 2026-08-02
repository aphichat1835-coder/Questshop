import { acquireDelivery, recordDelivery } from '../domain/outbox/service.js';
import { withTransaction } from '../db/transaction.js';
import { renderProjection } from '../discord/renderers/projections.js';

const BACKOFF = [1, 5, 15, 60, 300, 900];

async function failDelivery(event, error, pool) {
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const projection = event.projection_id
      ? (await client.query('SELECT * FROM message_projections WHERE id=$1 FOR UPDATE', [event.projection_id])).rows[0]
      : null;
    const forbidden = Number(error.status) === 403 || Number(error.code) === 50013;
    const missing = Number(error.status) === 404 || [10003, 10008].includes(Number(error.code));
    // Six bounded waits (1s, 5s, 15s, 60s, 5m, 15m), then the seventh failed
    // delivery is moved to DLQ. A 403 remains terminal immediately.
    const dead = forbidden || event.attempt_count > BACKOFF.length;
    const configuredDelay = BACKOFF[Math.min(event.attempt_count - 1, BACKOFF.length - 1)];
    const retryAfter = Number(error.retryAfter ?? error.retry_after);
    const delaySeconds = Number.isFinite(retryAfter) ? Math.max(configuredDelay,
      retryAfter > 1000 ? Math.ceil(retryAfter / 1000) : Math.ceil(retryAfter)) : configuredDelay;
    await client.query(`UPDATE outbox_events SET state = $4, available_at = clock_timestamp()
      + make_interval(secs => $5), lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3`,
    [event.id, event.lease_owner, event.fencing_token, dead ? 'DEAD_LETTER' : 'RETRY_WAIT', delaySeconds]);
    await client.query(`INSERT INTO delivery_attempts(id,outbox_id,attempt_number,outcome,discord_status,error_code,evidence)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6) ON CONFLICT(outbox_id,attempt_number) DO NOTHING`,
    [event.id, event.attempt_count, dead ? 'FAILED' : 'RETRY', Number(error.status) || null,
      error.code ?? String(error.status ?? error.name), { message: String(error.message).slice(0, 1000) }]);
    if (event.projection_id) await client.query(`UPDATE message_projections SET last_error_code=$2,
      message_id=CASE WHEN $4 THEN NULL ELSE message_id END,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND lease_owner=$3`, [event.projection_id, error.code ?? error.name,
      event.lease_owner, missing]);
    if (forbidden && projection && !projection.surface_key.startsWith('DM:')) {
      await client.query(`UPDATE surfaces SET state='DRIFTED',state_version=state_version+1,
        updated_at=clock_timestamp() WHERE surface_key=$1 AND state<>'DRIFTED'`, [projection.surface_key]);
      await client.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
        VALUES(gen_random_uuid(),'PERMISSION_DRIFT',$1,'OPEN','CRITICAL',$2,$3)
        ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED' DO UPDATE SET
          evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
      [projection.surface_key, { source: 'DISCORD_403', code: error.code }, event.trace_id]);
    }
    if (missing && projection && Number(error.code) === 10003) {
      await client.query(`UPDATE surfaces SET state='RECONCILING',state_version=state_version+1,
        updated_at=clock_timestamp() WHERE surface_key=$1`, [projection.surface_key]);
    }
    if (dead) await client.query(`INSERT INTO dead_letter_items(id,source_type,source_id,category,state,error_code,evidence,parent_trace_id)
      VALUES(gen_random_uuid(),'OUTBOX',$1,$2,'DEAD_LETTER',$3,$4,$5) ON CONFLICT DO NOTHING`,
    [event.id, ['TOPUP','WALLET','REFUND'].includes(event.aggregate_type) ? 'FINANCIAL'
      : projection?.projection_type === 'ADMIN_AUDIT' ? 'AUDIT' : 'NOTIFICATION',
      error.code ?? error.name, { message: String(error.message).slice(0, 1000) }, event.trace_id]);
  });
}

export async function processOutbox({ holder, client, pool, env }) {
  const event = await acquireDelivery({ holder }, { pool });
  if (!event) return false;
  try {
    const projection = event.projection_id ? (await pool.query('SELECT * FROM message_projections WHERE id = $1', [event.projection_id])).rows[0] : null;
    if (!projection) {
      await recordDelivery({ outboxId: event.id, holder, fencingToken: event.fencing_token }, { pool });
      return true;
    }
    const directMessage = projection.surface_key.startsWith('DM:');
    const surface = directMessage ? null : (await pool.query('SELECT * FROM surfaces WHERE surface_key = $1 AND state = \'ACTIVE\'', [projection.surface_key])).rows[0];
    if (!directMessage && !surface) throw Object.assign(new Error('Surface unavailable'), { code: 'SURFACE_UNAVAILABLE' });
    const channel = directMessage
      ? await (await client.users.fetch(projection.surface_key.slice(3))).createDM()
      : await client.channels.fetch(surface.channel_id);
    if (!channel?.isTextBased()) throw Object.assign(new Error('Surface channel missing'), { code: 'DISCORD_404' });
    const body = await renderProjection(pool, projection, { env, client });
    let pingSent = false;
    if (projection.projection_type === 'QUEST_NEW' && !projection.ping_sent_at) {
      const config = (await pool.query('SELECT payload FROM config_versions ORDER BY version DESC LIMIT 1')).rows[0]?.payload;
      const roleId = config?.questAnnouncementRoleId;
      if (roleId) {
        body.content = `<@&${roleId}>`;
        body.allowedMentions = { parse: [], roles: [roleId] };
        pingSent = true;
      }
    }
    let message = projection.message_id ? await channel.messages.fetch(projection.message_id).catch(() => null) : null;
    if (message) message = await message.edit(body);
    else message = await channel.send({ ...body, nonce: projection.nonce, enforceNonce: true });
    await recordDelivery({ outboxId: event.id, holder, fencingToken: event.fencing_token,
      messageId: message.id, pingSent }, { pool });
  } catch (error) { await failDelivery(event, error, pool); }
  return true;
}

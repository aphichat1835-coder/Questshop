import { acquireDelivery, recordDelivery } from '../domain/outbox/service.js';
import { withTransaction } from '../db/transaction.js';
import { renderProjection } from '../discord/renderers/projections.js';
import { renewDeliveryLease } from '../domain/outbox/service.js';
import { FencingLostError } from '../shared/errors.js';
import { recordTransition } from '../domain/shared/transition.js';
import { setTimeout as delay } from 'node:timers/promises';

const BACKOFF = [1, 5, 15, 60, 300, 900];

function errorDetails(error) {
  const status = Number(error.status);
  const code = Number(error.code);
  return {
    forbidden: status === 403 || code === 50013,
    missing: status === 404 || error.code === 'DISCORD_404' || [10003, 10008].includes(code),
    missingChannel: error.code === 'DISCORD_404' || code === 10003,
  };
}

function retryDelaySeconds(event, error) {
  const configured = BACKOFF[Math.min(event.attempt_count - 1, BACKOFF.length - 1)];
  const retryAfter = Number(error.retryAfter ?? error.retry_after);
  if (!Number.isFinite(retryAfter)) return configured;
  const seconds = retryAfter > 1000 ? Math.ceil(retryAfter / 1000) : Math.ceil(retryAfter);
  return Math.max(configured, seconds);
}

function deadLetterCategory(event, projection) {
  if (['TOPUP', 'WALLET', 'REFUND'].includes(event.aggregate_type)) return 'FINANCIAL';
  if (projection?.projection_type === 'ADMIN_AUDIT') return 'AUDIT';
  return 'NOTIFICATION';
}

async function updateFailedProjection(client, event, projection, error, missing) {
  if (!event.projection_id) return;
  await client.query(`UPDATE message_projections SET last_error_code=$2,
    message_id=CASE WHEN $4 THEN NULL ELSE message_id END,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=$1 AND lease_owner=$3 AND fencing_token=$5 AND lease_expires_at>clock_timestamp()`, [event.projection_id, error.code ?? error.name,
    event.lease_owner, missing, event.projection_fencing_token]);
}

async function recordSurfaceFailure(client, event, projection, error, details) {
  if (!projection || projection.surface_key.startsWith('DM:')) return;
  if (details.forbidden) {
    await client.query(`UPDATE surfaces SET state='DRIFTED',state_version=state_version+1,
      updated_at=clock_timestamp() WHERE surface_key=$1 AND state<>'DRIFTED'`, [projection.surface_key]);
    await client.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
      VALUES(gen_random_uuid(),'PERMISSION_DRIFT',$1,'OPEN','CRITICAL',$2,$3)
      ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED' DO UPDATE SET
        evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
    [projection.surface_key, { source: 'DISCORD_403', code: error.code }, event.trace_id]);
  }
  if (details.missingChannel) {
    await client.query(`UPDATE surfaces SET state='RECONCILING',state_version=state_version+1,
      updated_at=clock_timestamp() WHERE surface_key=$1`, [projection.surface_key]);
  }
}

async function createDeadLetter(client, event, projection, error) {
  await client.query(`INSERT INTO dead_letter_items(id,source_type,source_id,category,state,error_code,evidence,parent_trace_id)
    VALUES(gen_random_uuid(),'OUTBOX',$1,$2,'DEAD_LETTER',$3,$4,$5) ON CONFLICT DO NOTHING`,
  [event.id, deadLetterCategory(event, projection), error.code ?? error.name,
    { message: String(error.message).slice(0, 1000) }, event.trace_id]);
}

async function failDelivery(event, error, pool) {
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const details = errorDetails(error);
    const projection = event.projection_id
      ? (await client.query('SELECT * FROM message_projections WHERE id=$1 FOR UPDATE', [event.projection_id])).rows[0]
      : null;
    // Order completion DM is best effort by policy.  It is deliberately not
    // retried (or DLQed) because a later retry can duplicate a customer-facing
    // summary and must never influence runner/financial settlement.
    const terminalDmFailure = projection?.projection_type === 'ORDER_DM'
      && projection.surface_key.startsWith('DM:');
    const dead = !terminalDmFailure && (details.forbidden || event.attempt_count > BACKOFF.length);
    const nextState = terminalDmFailure ? 'DELIVERED' : (dead ? 'DEAD_LETTER' : 'RETRY_WAIT');
    const updated = (await client.query(`UPDATE outbox_events SET state = $4, state_version=state_version+1,
      available_at = clock_timestamp()
      + make_interval(secs => $5), delivered_at=CASE WHEN $6 THEN clock_timestamp() ELSE delivered_at END,
      lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
        AND state_version=$7 AND lease_expires_at>clock_timestamp()
      RETURNING *`,
    [event.id, event.lease_owner, event.fencing_token, nextState,
      retryDelaySeconds(event, error), terminalDmFailure, event.state_version])).rows[0];
    // The lease belongs to a newer worker or has expired.  That worker will
    // reconcile the event; a stale worker must not create retry/DLQ evidence.
    if (!updated) return false;
    await recordTransition(client, { aggregateType: 'OUTBOX_EVENT', aggregateId: event.id,
      fromState: 'LEASED', toState: nextState, stateVersion: updated.state_version,
      reasonCode: terminalDmFailure ? 'ORDER_DM_FAILED_ONCE' : (dead ? 'OUTBOX_DEAD_LETTER' : 'OUTBOX_RETRY'),
      context: { traceId: event.trace_id, causationId: event.causation_id ?? null,
        actorType: 'SYSTEM', actorId: event.lease_owner } });
    await client.query(`INSERT INTO delivery_attempts(id,outbox_id,attempt_number,outcome,discord_status,error_code,evidence)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6) ON CONFLICT(outbox_id,attempt_number) DO NOTHING`,
    [event.id, event.attempt_count, dead || terminalDmFailure ? 'FAILED' : 'RETRY', Number(error.status) || null,
      error.code ?? String(error.status ?? error.name), { message: String(error.message).slice(0, 1000) }]);
    await updateFailedProjection(client, event, projection, error, details.missing);
    await recordSurfaceFailure(client, event, projection, error, details);
    if (dead) await createDeadLetter(client, event, projection, error);
    return true;
  });
}

async function claimOrderDmAttempt(pool, event, projection) {
  if (projection?.projection_type !== 'ORDER_DM' || !projection.surface_key.startsWith('DM:')) return true;
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const claimed = (await client.query(`UPDATE orders SET dm_summary_attempted_at=clock_timestamp()
      WHERE id=$1 AND dm_summary_attempted_at IS NULL AND EXISTS(
        SELECT 1 FROM outbox_events WHERE id=$2 AND state='LEASED' AND lease_owner=$3
          AND fencing_token=$4 AND lease_expires_at>clock_timestamp()
      ) RETURNING id`, [projection.aggregate_id, event.id, event.lease_owner, event.fencing_token])).rows[0];
    return Boolean(claimed);
  });
}

function startDeliveryHeartbeat(event, pool) {
  const abort = new AbortController();
  let lost = null;
  const done = (async () => {
    while (!abort.signal.aborted) {
      await delay(10_000, undefined, { signal: abort.signal, ref: false });
      if (abort.signal.aborted) break;
      const renewed = await renewDeliveryLease({ outboxId: event.id, holder: event.lease_owner,
        fencingToken: event.fencing_token, ttlSeconds: 30 }, { pool });
      if (!renewed) {
        lost = new FencingLostError(`outbox:${event.id}`);
        abort.abort(lost);
      }
    }
  })().catch((error) => {
    if (error?.name !== 'AbortError') {
      lost = error;
      abort.abort(error);
    }
  });
  return {
    assertOwned() { if (lost) throw lost; },
    async stop() { abort.abort('outbox delivery finished'); await done; },
  };
}

async function loadActiveSurface(pool, projection) {
  if (projection.surface_key.startsWith('DM:')) return null;
  const surface = (await pool.query(`SELECT * FROM surfaces WHERE surface_key = $1 AND state = 'ACTIVE'`,
    [projection.surface_key])).rows[0];
  if (!surface) throw Object.assign(new Error('Surface unavailable'), { code: 'SURFACE_UNAVAILABLE' });
  return surface;
}

async function resolveChannel(client, projection, surface) {
  const channel = projection.surface_key.startsWith('DM:')
    ? await (await client.users.fetch(projection.surface_key.slice(3))).createDM()
    : await client.channels.fetch(surface.channel_id);
  if (!channel?.isTextBased()) throw Object.assign(new Error('Surface channel missing'), { code: 'DISCORD_404' });
  return channel;
}

async function applyQuestAnnouncementPing(pool, projection, body) {
  if (projection.projection_type !== 'QUEST_NEW' || projection.ping_sent_at) return false;
  const config = (await pool.query('SELECT payload FROM config_versions ORDER BY version DESC LIMIT 1')).rows[0]?.payload;
  const roleId = config?.questAnnouncementRoleId;
  if (!roleId) return false;
  body.content = `<@&${roleId}>`;
  body.allowedMentions = { parse: [], roles: [roleId] };
  return true;
}

async function findMessageByNonce(channel, nonce) {
  const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  if (!messages?.values) return null;
  return [...messages.values()].find((message) => String(message.nonce ?? '') === String(nonce)) ?? null;
}

async function publishProjection(channel, projection, body) {
  const message = projection.message_id ? await channel.messages.fetch(projection.message_id).catch(() => null) : null;
  if (message) return message.edit(body);
  // `send` can fail after Discord accepted the create.  Reconcile by the
  // stable nonce before creating, and once more after an unknown result, so a
  // retry does not fill a durable projection with duplicate messages.
  const existing = await findMessageByNonce(channel, projection.nonce);
  if (existing) return existing;
  try {
    return await channel.send({ ...body, nonce: projection.nonce, enforceNonce: true });
  } catch (error) {
    const reconciled = await findMessageByNonce(channel, projection.nonce);
    if (reconciled) return reconciled;
    throw error;
  }
}

export async function processOutbox({ holder, client, pool, env }) {
  const event = await acquireDelivery({ holder }, { pool });
  if (!event) return false;
  const heartbeat = startDeliveryHeartbeat(event, pool);
  try {
    const projection = event.projection_id
      ? (await pool.query('SELECT * FROM message_projections WHERE id = $1', [event.projection_id])).rows[0]
      : null;
    if (!projection) {
      await recordDelivery({ outboxId: event.id, holder, fencingToken: event.fencing_token }, { pool });
      return true;
    }
    if (!(await claimOrderDmAttempt(pool, event, projection))) {
      await recordDelivery({ outboxId: event.id, holder, fencingToken: event.fencing_token }, { pool });
      return true;
    }
    const surface = await loadActiveSurface(pool, projection);
    const channel = await resolveChannel(client, projection, surface);
    const body = await renderProjection(pool, projection, { env, client });
    const pingSent = await applyQuestAnnouncementPing(pool, projection, body);
    const message = await publishProjection(channel, projection, body);
    heartbeat.assertOwned();
    await recordDelivery({ outboxId: event.id, holder, fencingToken: event.fencing_token,
      messageId: message.id, pingSent }, { pool });
  } catch (error) {
    if (!(error instanceof FencingLostError)) await failDelivery(event, error, pool);
  } finally {
    await heartbeat.stop();
  }
  return true;
}

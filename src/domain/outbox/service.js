import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';

function projectionNonce(id) {
  return createHash('sha256').update(String(id)).digest('base64url').slice(0, 25);
}

export async function enqueueProjection(client, {
  projectionType,
  aggregateType,
  aggregateId,
  aggregateVersion,
  surfaceKey,
  topic = 'REFRESH_PROJECTION',
  notBefore = null,
  context,
}) {
  const projectionId = uuidv7();
  const projection = (await client.query(`
    INSERT INTO message_projections(
      id, projection_type, aggregate_id, surface_key, nonce, next_allowed_at
    ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, transaction_timestamp()))
    ON CONFLICT (projection_type, aggregate_id, surface_key) DO UPDATE SET
      desired_version = GREATEST(
        message_projections.desired_version + 1,
        EXCLUDED.desired_version
      ),
      next_allowed_at = GREATEST(message_projections.next_allowed_at, EXCLUDED.next_allowed_at),
      updated_at = transaction_timestamp()
    RETURNING *
  `, [projectionId, projectionType, String(aggregateId), surfaceKey, projectionNonce(projectionId), notBefore])).rows[0];

  await client.query(`
    INSERT INTO outbox_events(
      id, topic, aggregate_type, aggregate_id, aggregate_version,
      projection_id, state, available_at, trace_id, causation_id
    ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING',
      COALESCE($7, transaction_timestamp()), $8, $9)
    ON CONFLICT (topic, aggregate_type, aggregate_id, aggregate_version) DO NOTHING
  `, [
    uuidv7(), topic, aggregateType, String(aggregateId), aggregateVersion,
    projection.id, notBefore, context.traceId, context.causationId,
  ]);
  return projection;
}

export async function acquireDelivery({ holder, ttlSeconds = 30 }, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const result = await client.query(`
      WITH candidate AS (
        SELECT o.id FROM outbox_events o
        JOIN message_projections p ON p.id=o.projection_id
        WHERE (p.surface_key IS DISTINCT FROM 'QUEST_NEW' OR EXISTS(
          SELECT 1 FROM feature_gates g WHERE g.gate='QUEST_ANNOUNCEMENT_ENABLED' AND g.enabled=true
        )) AND ((
          o.state IN ('PENDING', 'RETRY_WAIT') AND o.available_at <= clock_timestamp()
        ) OR (
          o.state = 'LEASED' AND o.lease_expires_at <= clock_timestamp()
        )) AND (p.lease_owner IS NULL OR p.lease_expires_at<=clock_timestamp())
        ORDER BY o.available_at, o.created_at
        FOR UPDATE OF o,p SKIP LOCKED
        LIMIT 1
      )
      UPDATE outbox_events o
      SET state = 'LEASED',
          lease_owner = $1,
          lease_expires_at = clock_timestamp() + make_interval(secs => $2),
          fencing_token = o.fencing_token + 1,
          attempt_count = o.attempt_count + 1
      FROM candidate
      WHERE o.id = candidate.id
      RETURNING o.*
    `, [holder, ttlSeconds]);
    const event = result.rows[0] ?? null;
    if (event?.projection_id) await client.query(`UPDATE message_projections SET lease_owner=$2,
      lease_expires_at=clock_timestamp()+make_interval(secs=>$3),fencing_token=fencing_token+1
      WHERE id=$1`, [event.projection_id, holder, ttlSeconds]);
    return event;
  });
}

export async function recordDelivery({
  outboxId,
  holder,
  fencingToken,
  messageId = null,
  pingSent = false,
}, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const event = (await client.query(`
      UPDATE outbox_events
      SET state = 'DELIVERED', delivered_at = clock_timestamp(),
          lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
        AND lease_expires_at > clock_timestamp()
      RETURNING *
    `, [outboxId, holder, fencingToken])).rows[0];
    if (!event) return null;
    await client.query(`INSERT INTO delivery_attempts(id,outbox_id,attempt_number,outcome)
      VALUES($1,$2,$3,'DELIVERED') ON CONFLICT(outbox_id,attempt_number) DO NOTHING`,
    [uuidv7(), event.id, event.attempt_count]);
    if (event.projection_id) {
      const projection = (await client.query(`
        UPDATE message_projections
        SET message_id = COALESCE($2, message_id),
            delivered_version = desired_version,
            ping_sent_at = CASE
              WHEN $4 AND ping_sent_at IS NULL THEN clock_timestamp()
              ELSE ping_sent_at
            END,
            last_error_code = NULL, lease_owner=NULL, lease_expires_at=NULL,
            updated_at = clock_timestamp()
        WHERE id = $1 AND lease_owner=$3
        RETURNING *
      `, [event.projection_id, messageId, holder, pingSent])).rows[0];
      if (projection?.projection_type === 'PAYMENT_LOG') {
        await client.query(`UPDATE topup_sensitive_payloads SET log_delivered_at=clock_timestamp()
          WHERE topup_id=$1`, [projection.aggregate_id]);
      }
      if (projection?.projection_type === 'QUEST_NEW') {
        await client.query(`UPDATE quests SET announcement_state='ANNOUNCED',
          announcement_version=announcement_version+CASE WHEN announcement_state='NOT_ANNOUNCED' THEN 1 ELSE 0 END,
          updated_at=clock_timestamp() WHERE quest_id=$1`, [projection.aggregate_id]);
      }
      // One successful render is the latest state of the projection. Older
      // queued notifications for the same message must not edit that message
      // again; they are durably coalesced rather than silently discarded.
      await client.query(`UPDATE outbox_events SET state='DELIVERED',delivered_at=clock_timestamp(),
        lease_owner=NULL,lease_expires_at=NULL
        WHERE projection_id=$1 AND id<>$2 AND state IN ('PENDING','RETRY_WAIT')`,
      [event.projection_id, event.id]);
    }
    await client.query(`UPDATE dead_letter_items SET state='RESOLVED',resolved_at=clock_timestamp()
      WHERE state='PENDING' AND evidence->>'replayOutboxId'=$1`, [event.id]);
    return event;
  });
}

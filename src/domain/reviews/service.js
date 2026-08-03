import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { AuthorizationError, StaleStateError } from '../../shared/errors.js';
import { enqueueProjection } from '../outbox/service.js';
import { recordTransition } from '../shared/transition.js';
import { appendAdminAudit } from '../admin/audit.js';
import { redact } from '../../shared/redaction.js';
import {
  captureReservationInTransaction,
  creditRedeemedTopupInTransaction,
  releaseReservationInTransaction,
} from '../wallet/service.js';

export async function openReview(client, {
  subjectType,
  subjectId,
  reason,
  financial = false,
  ownerOnly = false,
  context,
}) {
  const id = uuidv7();
  const result = await client.query(`
    INSERT INTO manual_reviews(
      id, subject_type, subject_id, state, financial, owner_only,
      opened_reason, trace_id
    ) VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, $7)
    ON CONFLICT (subject_type, subject_id) WHERE state <> 'RESOLVED'
    DO UPDATE SET remind_at = LEAST(manual_reviews.remind_at, transaction_timestamp() + interval '24 hours')
    RETURNING *
  `, [id, subjectType, String(subjectId), financial, ownerOnly, reason, context.traceId]);
  const review = result.rows[0];
  await enqueueProjection(client, {
    projectionType: 'MANUAL_REVIEW', aggregateType: 'MANUAL_REVIEW', aggregateId: review.id,
    aggregateVersion: review.state_version, surfaceKey: 'ADMIN_PANEL', context,
  });
  return review;
}

export async function assignReview({ reviewId, assigneeId, expectedVersion }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const updated = (await client.query(`
      UPDATE manual_reviews
      SET state = 'ASSIGNED', assigned_to = $2, state_version = state_version + 1
      WHERE id = $1 AND state = 'OPEN' AND state_version = $3
      RETURNING *
    `, [reviewId, assigneeId, expectedVersion])).rows[0];
    if (!updated) throw new StaleStateError('manual_review', reviewId);
    await recordTransition(client, {
      aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
      fromState: 'OPEN', toState: 'ASSIGNED', stateVersion: updated.state_version, context,
    });
    await appendAdminAudit(client, { action: 'MANUAL_REVIEW_ASSIGNED', targetType: 'MANUAL_REVIEW',
      targetId: reviewId, actorId: context.actorId, before: { state: 'OPEN', assignedTo: null },
      after: { state: updated.state, assignedTo: updated.assigned_to }, reason: 'review assignment', context });
    return updated;
  });
}

export async function addEvidence({ reviewId, evidenceType, payload }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    let review = (await client.query(
      'SELECT * FROM manual_reviews WHERE id = $1 FOR UPDATE', [reviewId],
    )).rows[0];
    if (!review || review.state === 'RESOLVED') throw new StaleStateError('manual_review', reviewId);
    if (review.state === 'OPEN') {
      const assigned = (await client.query(`UPDATE manual_reviews SET state='ASSIGNED',assigned_to=$2,
        state_version=state_version+1 WHERE id=$1 AND state='OPEN' AND state_version=$3 RETURNING *`,
      [reviewId, context.actorId, review.state_version])).rows[0];
      await recordTransition(client, { aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
        fromState: 'OPEN', toState: 'ASSIGNED', stateVersion: assigned.state_version, context });
      review = assigned;
    }
    await client.query(`
      INSERT INTO review_evidence(id, review_id, evidence_type, payload, actor_type, actor_id, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [uuidv7(), reviewId, evidenceType, redact(payload), context.actorType, context.actorId, context.traceId]);
    if (review.state !== 'ASSIGNED') {
      await appendAdminAudit(client, { action: 'MANUAL_REVIEW_EVIDENCE_ADDED', targetType: 'MANUAL_REVIEW',
        targetId: reviewId, actorId: context.actorId, before: { state: review.state },
        after: { evidenceType }, reason: 'review evidence added', context });
      return review;
    }
    const pending = (await client.query(`UPDATE manual_reviews SET state='EVIDENCE_PENDING',
      state_version=state_version+1 WHERE id=$1 AND state='ASSIGNED' AND state_version=$2 RETURNING *`,
    [reviewId, review.state_version])).rows[0];
    await recordTransition(client, { aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
      fromState: 'ASSIGNED', toState: 'EVIDENCE_PENDING', stateVersion: pending.state_version, context });
    await appendAdminAudit(client, { action: 'MANUAL_REVIEW_EVIDENCE_ADDED', targetType: 'MANUAL_REVIEW',
      targetId: reviewId, actorId: context.actorId, before: { state: 'ASSIGNED' },
      after: { state: pending.state, evidenceType }, reason: 'review evidence added', context });
    return pending;
  });
}

export async function resolveReview({
  reviewId,
  decision,
  reason,
  isOwner,
  expectedVersion = null,
  decisionEvidence = null,
  applyDecision,
}, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    let review = (await client.query(
      'SELECT * FROM manual_reviews WHERE id = $1 FOR UPDATE', [reviewId],
    )).rows[0];
    if (!review || review.state === 'RESOLVED') throw new StaleStateError('manual_review', reviewId);
    if (expectedVersion != null && String(review.state_version) !== String(expectedVersion)) {
      throw new StaleStateError('manual_review', reviewId);
    }
    if (review.owner_only && !isOwner) throw new AuthorizationError('รายการนี้ให้ Owner ตัดสินเท่านั้น');
    if (review.state === 'OPEN') {
      const assigned = (await client.query(`UPDATE manual_reviews SET state='ASSIGNED',assigned_to=$2,
        state_version=state_version+1 WHERE id=$1 AND state='OPEN' AND state_version=$3 RETURNING *`,
      [reviewId, context.actorId, review.state_version])).rows[0];
      await recordTransition(client, { aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
        fromState: 'OPEN', toState: 'ASSIGNED', stateVersion: assigned.state_version, context });
      review = assigned;
    }
    if (decisionEvidence) await client.query(`INSERT INTO review_evidence(id,review_id,evidence_type,
      payload,actor_type,actor_id,trace_id) VALUES($1,$2,'DECISION_INPUT',$3,$4,$5,$6)`,
    [uuidv7(), reviewId, redact(decisionEvidence), context.actorType, context.actorId, context.traceId]);
    if (review.state === 'ASSIGNED') {
      const pending = (await client.query(`UPDATE manual_reviews SET state='EVIDENCE_PENDING',
        state_version=state_version+1 WHERE id=$1 AND state='ASSIGNED' AND state_version=$2 RETURNING *`,
      [reviewId, review.state_version])).rows[0];
      await recordTransition(client, { aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
        fromState: 'ASSIGNED', toState: 'EVIDENCE_PENDING', stateVersion: pending.state_version, context });
      review = pending;
    }
    if (review.state === 'EVIDENCE_PENDING') {
      const ready = (await client.query(`UPDATE manual_reviews SET state='DECISION_READY',
        state_version=state_version+1 WHERE id=$1 AND state='EVIDENCE_PENDING' AND state_version=$2 RETURNING *`,
      [reviewId, review.state_version])).rows[0];
      await recordTransition(client, { aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
        fromState: 'EVIDENCE_PENDING', toState: 'DECISION_READY', stateVersion: ready.state_version, context });
      review = ready;
    }
    if (review.state !== 'DECISION_READY') throw new StaleStateError('manual_review', reviewId);
    const applied = await applyDecision(client, review);
    await client.query(`
      INSERT INTO review_decisions(id, review_id, decision, reason, actor_id, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [uuidv7(), reviewId, decision, reason, context.actorId, context.traceId]);
    const updated = (await client.query(`
      UPDATE manual_reviews SET state = 'RESOLVED', state_version = state_version + 1,
        resolved_at = transaction_timestamp() WHERE id = $1 RETURNING *
    `, [reviewId])).rows[0];
    await recordTransition(client, {
      aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
      fromState: review.state, toState: 'RESOLVED', stateVersion: updated.state_version,
      reasonCode: decision, metadata: { decision, applied }, context,
    });
    return { review: updated, applied };
  });
}

const ORDER_RELEASE_DECISIONS = Object.freeze({
  RELEASE: 'FAILED_RELEASED',
  STOP: 'STOPPED_RELEASED',
  FAIL: 'FAILED_RELEASED',
});

async function applyTopupDecision(client, review, decision, input, context) {
  const topup = (await client.query('SELECT * FROM topups WHERE id=$1 FOR UPDATE',
    [review.subject_id])).rows[0];
  if (topup?.status !== 'MANUAL_REVIEW') throw new StaleStateError('topup', review.subject_id);
  if (decision === 'REJECT') {
    const updated = (await client.query(`UPDATE topups SET status='REJECTED',state_version=state_version+1,
      failure_code=$2,updated_at=transaction_timestamp() WHERE id=$1 AND status='MANUAL_REVIEW' RETURNING *`,
    [topup.id, input.reason])).rows[0];
    await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: topup.id,
      fromState: 'MANUAL_REVIEW', toState: 'REJECTED', stateVersion: updated.state_version,
      reasonCode: 'OWNER_REJECTED', context });
    await enqueueProjection(client, { projectionType: 'PAYMENT_LOG', aggregateType: 'TOPUP',
      aggregateId: topup.id, aggregateVersion: updated.state_version,
      surfaceKey: 'LOG_PAYMENTS', context });
    return { topupId: topup.id, status: updated.status };
  }
  if (decision !== 'CREDIT') throw new TypeError('invalid top-up review decision');
  const amount = BigInt(input.amountCents ?? topup.amount_cents ?? 0);
  if (amount <= 0n || !input.providerTransactionId?.trim()) {
    throw new TypeError('confirmed amount and provider transaction id are required');
  }
  const redeemed = (await client.query(`UPDATE topups SET status='REDEEMED',state_version=state_version+1,
    amount_cents=$2,currency='THB',provider_transaction_id=$3,redeemed_at=transaction_timestamp(),
    failure_code=NULL,updated_at=transaction_timestamp()
    WHERE id=$1 AND status='MANUAL_REVIEW' RETURNING *`,
  [topup.id, amount, input.providerTransactionId.trim()])).rows[0];
  await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: topup.id,
    fromState: 'MANUAL_REVIEW', toState: 'REDEEMED', stateVersion: redeemed.state_version,
    reasonCode: 'OWNER_CONFIRMED_REDEEMED', context });
  const credited = await creditRedeemedTopupInTransaction(client, { topupId: topup.id }, context);
  return { topupId: topup.id, status: credited.topup.status,
    transactionId: credited.transaction.id };
}

async function applyOrderItemDecision(client, review, decision, input, context) {
  const item = (await client.query(`SELECT i.*,q.url AS quest_url FROM order_items i
    JOIN quests q ON q.quest_id=i.quest_id WHERE i.id=$1 FOR UPDATE OF i`,
  [review.subject_id])).rows[0];
  if (item?.state !== 'MANUAL_REVIEW') throw new StaleStateError('order_item', review.subject_id);
  if (decision === 'RETRY') {
    const updated = (await client.query(`UPDATE order_items SET state='QUEUED',state_version=state_version+1,
      updated_at=transaction_timestamp() WHERE id=$1 AND state='MANUAL_REVIEW' RETURNING *`,
    [item.id])).rows[0];
    const job = (await client.query(`UPDATE runner_jobs SET state='QUEUED',state_version=state_version+1,
      available_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE order_item_id=$1 AND state='MANUAL_REVIEW' RETURNING id`, [item.id])).rows[0];
    if (!job) throw new StaleStateError('runner_job', item.id);
    await recordTransition(client, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
      fromState: 'MANUAL_REVIEW', toState: 'QUEUED', stateVersion: updated.state_version,
      reasonCode: 'ADMIN_RETRY', context });
    await enqueueProjection(client, { projectionType: 'QUEST_HISTORY', aggregateType: 'ORDER_ITEM',
      aggregateId: item.id, aggregateVersion: updated.state_version,
      surfaceKey: 'QUEST_HISTORY', context });
    return { orderItemId: item.id, status: updated.state };
  }
  if (decision === 'CAPTURE') {
    const settling = (await client.query(`UPDATE order_items SET state='SETTLING',state_version=state_version+1,
      updated_at=transaction_timestamp() WHERE id=$1 AND state='MANUAL_REVIEW' RETURNING *`,
    [item.id])).rows[0];
    await client.query(`UPDATE runner_jobs SET state='SETTLING',state_version=state_version+1,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE order_item_id=$1 AND state='MANUAL_REVIEW'`, [item.id]);
    await recordTransition(client, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
      fromState: 'MANUAL_REVIEW', toState: 'SETTLING', stateVersion: settling.state_version,
      reasonCode: 'ADMIN_CAPTURE', context });
    const captured = await captureReservationInTransaction(client,
      { orderItemId: item.id, claimUrl: input.claimUrl ?? item.claim_url ?? item.quest_url }, context);
    await client.query(`UPDATE runner_jobs SET state='COMPLETED',state_version=state_version+1,
      updated_at=clock_timestamp() WHERE order_item_id=$1`, [item.id]);
    return { orderItemId: item.id, status: captured.state };
  }
  const terminalState = ORDER_RELEASE_DECISIONS[decision];
  if (!terminalState) throw new TypeError('invalid order-item review decision');
  const released = await releaseReservationInTransaction(client, { orderItemId: item.id,
    terminalState, reason: input.reason }, context);
  await client.query(`UPDATE runner_jobs SET state='FAILED',state_version=state_version+1,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE order_item_id=$1`, [item.id]);
  return { orderItemId: item.id, status: released.state };
}

export async function resolveSubjectReview({ reviewId, decision, reason, isOwner,
  amountCents = null, providerTransactionId = null, claimUrl = null,
  expectedVersion = null }, context, options = {}) {
  if (!reason?.trim()) throw new TypeError('review resolution reason is required');
  return resolveReview({ reviewId, decision, reason, isOwner, expectedVersion,
    decisionEvidence: { decision, amountCents: amountCents == null ? null : String(amountCents),
      providerTransactionId, claimUrl },
    applyDecision: async (client, review) => {
      const input = { reason: reason.trim(), amountCents, providerTransactionId, claimUrl };
      let applied;
      if (review.subject_type === 'TOPUP') {
        if (!isOwner) throw new AuthorizationError('Top-up ที่ผลไม่ชัดเจนให้ Owner ตัดสินเท่านั้น');
        applied = await applyTopupDecision(client, review, decision, input, context);
      } else if (review.subject_type === 'ORDER_ITEM') {
        applied = await applyOrderItemDecision(client, review, decision, input, context);
      } else {
        throw new TypeError(`unsupported manual review subject: ${review.subject_type}`);
      }
      await appendAdminAudit(client, { action: 'MANUAL_REVIEW_RESOLVED',
        targetType: review.subject_type, targetId: review.subject_id, actorId: context.actorId,
        before: { reviewState: review.state }, after: { decision, applied }, reason, context });
      return applied;
    } }, context, options);
}

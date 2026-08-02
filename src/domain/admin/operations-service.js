import { withTransaction } from '../../db/transaction.js';
import { QuestshopError } from '../../shared/errors.js';
import { evaluateExpiryAdmission } from '../catalog/expiry.js';
import { SALE_TRANSITIONS } from '../catalog/states.js';
import { resolvePrice } from '../pricing/resolver.js';
import { enqueueProjection } from '../outbox/service.js';
import { openReview } from '../reviews/service.js';
import { assertTransition, recordTransition } from '../shared/transition.js';
import { ORDER_ITEM_TRANSITIONS } from '../orders/states.js';
import { appendAdminAudit } from './audit.js';

export async function setQuestSaleState({ questId, nextState, runnerConcurrency = 3,
  reason }, context, options = {}) {
  if (!['OPEN', 'PAUSED', 'EXPIRED'].includes(nextState) || !reason?.trim()) {
    throw new TypeError('invalid Quest sale change');
  }
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const quest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [questId])).rows[0];
    if (!quest) throw new QuestshopError('QUEST_NOT_FOUND', 'ไม่พบ Quest');
    if (quest.sale_state === nextState) return quest;
    assertTransition(SALE_TRANSITIONS, quest.sale_state, nextState);
    if (nextState === 'OPEN') {
      const price = await resolvePrice(client, { questId, taskType: quest.task_type });
      const expiry = await evaluateExpiryAdmission(client, { quest, runnerConcurrency });
      if (quest.analysis_state !== 'SUPPORTED' || !quest.executor_id || !price || !expiry.eligible) {
        throw new QuestshopError('QUEST_NOT_SALE_ELIGIBLE', `เปิดขายไม่ได้: ${expiry.reason ?? 'ข้อมูล/Executor/ราคาไม่ครบ'}`);
      }
    }
    const updated = (await client.query(`UPDATE quests SET sale_state=$2,sale_version=sale_version+1,
      analysis_state=CASE WHEN $2='EXPIRED' AND analysis_state IN ('UNSUPPORTED','MANUAL_REVIEW','SUPPORTED')
        THEN 'EXPIRED' ELSE analysis_state END,
      analysis_version=analysis_version+CASE WHEN $2='EXPIRED'
        AND analysis_state IN ('UNSUPPORTED','MANUAL_REVIEW','SUPPORTED') THEN 1 ELSE 0 END,
      updated_at=transaction_timestamp() WHERE quest_id=$1 AND sale_version=$3 RETURNING *`,
    [questId, nextState, quest.sale_version])).rows[0];
    if (!updated) throw new QuestshopError('STALE_STATE', 'Quest เปลี่ยนพร้อมกัน');
    await recordTransition(client, { aggregateType: 'QUEST_SALE', aggregateId: questId,
      fromState: quest.sale_state, toState: nextState, stateVersion: updated.sale_version,
      reasonCode: 'ADMIN_SALE_CHANGE', context });
    if (nextState === 'EXPIRED' && ['UNSUPPORTED', 'MANUAL_REVIEW', 'SUPPORTED'].includes(quest.analysis_state)) {
      await recordTransition(client, { aggregateType: 'QUEST_ANALYSIS', aggregateId: questId,
        fromState: quest.analysis_state, toState: 'EXPIRED', stateVersion: updated.analysis_version,
        reasonCode: 'ADMIN_EXPIRED', context });
    }
    await appendAdminAudit(client, { action: 'QUEST_SALE_CHANGE', targetType: 'QUEST', targetId: questId,
      actorId: context.actorId, before: { saleState: quest.sale_state },
      after: { saleState: nextState }, reason, context });
    await enqueueProjection(client, { projectionType: 'QUEST_NEW', aggregateType: 'QUEST',
      aggregateId: questId, aggregateVersion: updated.sale_version,
      surfaceKey: 'QUEST_NEW', context });
    return updated;
  });
}

export async function openOrderItemReview({ orderItemId, reason, ownerOnly = false }, context, options = {}) {
  if (!reason?.trim()) throw new TypeError('review reason is required');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const item = (await client.query('SELECT * FROM order_items WHERE id=$1 FOR UPDATE', [orderItemId])).rows[0];
    if (!item) throw new QuestshopError('ORDER_ITEM_NOT_FOUND', 'ไม่พบ Order item');
    if (item.state !== 'MANUAL_REVIEW') {
      assertTransition(ORDER_ITEM_TRANSITIONS, item.state, 'MANUAL_REVIEW');
      const updated = (await client.query(`UPDATE order_items SET state='MANUAL_REVIEW',
        state_version=state_version+1,updated_at=transaction_timestamp()
        WHERE id=$1 AND state_version=$2 RETURNING *`, [orderItemId, item.state_version])).rows[0];
      await client.query(`UPDATE runner_jobs SET state='MANUAL_REVIEW',state_version=state_version+1,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE order_item_id=$1 AND state NOT IN ('COMPLETED','FAILED')`, [orderItemId]);
      await recordTransition(client, { aggregateType: 'ORDER_ITEM', aggregateId: orderItemId,
        fromState: item.state, toState: 'MANUAL_REVIEW', stateVersion: updated.state_version,
        reasonCode: 'ADMIN_REVIEW', context });
      await enqueueProjection(client, { projectionType: 'QUEST_HISTORY', aggregateType: 'ORDER_ITEM',
        aggregateId: orderItemId, aggregateVersion: updated.state_version,
        surfaceKey: 'QUEST_HISTORY', context });
    }
    const review = await openReview(client, { subjectType: 'ORDER_ITEM', subjectId: orderItemId,
      reason, financial: true, ownerOnly, context });
    await appendAdminAudit(client, { action: 'ORDER_ITEM_REVIEW_OPENED', targetType: 'ORDER_ITEM',
      targetId: orderItemId, actorId: context.actorId, before: { state: item.state },
      after: { state: 'MANUAL_REVIEW', reviewId: review.id }, reason, context });
    return review;
  });
}

export async function setCircuitBreakerState({ breakerKey, nextState, expectedVersion,
  reason }, context, options = {}) {
  if (!['HALF_OPEN', 'CLOSED'].includes(nextState) || !reason?.trim()) throw new TypeError('invalid circuit breaker change');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query('SELECT * FROM circuit_breakers WHERE breaker_key=$1 FOR UPDATE',
      [breakerKey])).rows[0];
    if (!before || String(before.state_version) !== String(expectedVersion)) {
      throw new QuestshopError('STALE_STATE', 'Circuit breaker เปลี่ยนหลัง Preview');
    }
    const updated = (await client.query(`UPDATE circuit_breakers SET state=$2,reason=$3,
      failure_count=CASE WHEN $2='CLOSED' THEN 0 ELSE failure_count END,
      next_probe_at=CASE WHEN $2='HALF_OPEN' THEN clock_timestamp() ELSE NULL END,
      state_version=state_version+1,trace_id=$4,updated_at=clock_timestamp()
      WHERE breaker_key=$1 AND state_version=$5 RETURNING *`, [breakerKey, nextState,
      reason, context.traceId, expectedVersion])).rows[0];
    await appendAdminAudit(client, { action: 'CIRCUIT_BREAKER_CHANGE', targetType: 'CIRCUIT_BREAKER',
      targetId: breakerKey, actorId: context.actorId, before, after: updated, reason, context });
    return updated;
  });
}

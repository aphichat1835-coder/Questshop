import { expireSessions } from '../domain/checkout/service.js';
import { createContext } from '../shared/correlation.js';
import { withTransaction } from '../db/transaction.js';
import { checkPermissionDrift } from '../discord/permissions/drift.js';
import { recordTransition } from '../domain/shared/transition.js';
import { materializeNextOrderItem } from '../domain/runner/service.js';
import { enqueueProjection } from '../domain/outbox/service.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { appendAdminAudit } from '../domain/admin/audit.js';
import { releaseReservation } from '../domain/wallet/service.js';
import { evaluateExpiryAdmission } from '../domain/catalog/expiry.js';
import { reconcileSurfaceAnchors } from '../discord/surfaces/setup.js';
import { openReview } from '../domain/reviews/service.js';

export async function runMaintenance({ env, holder, client, pool, runnerConcurrency = env.RUNNER_CONCURRENCY }) {
  const context = createContext({ actorType: 'SYSTEM', actorId: holder, guildId: env.DISCORD_GUILD_ID,
    idempotencyKey: `maintenance:${new Date().toISOString().slice(0, 16)}` });
  await expireSessions({}, context, { pool });
  await withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (client) => {
    const leased = await client.query(`
      UPDATE runner_jobs SET state = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL,
        available_at = clock_timestamp(), state_version = state_version + 1, updated_at = clock_timestamp()
      WHERE state = 'LEASED' AND lease_expires_at <= clock_timestamp() RETURNING *
    `);
    for (const job of leased.rows) {
      const item = (await client.query(`UPDATE order_items SET state='QUEUED',state_version=state_version+1,
        updated_at=clock_timestamp() WHERE id=$1 AND state='LEASED' RETURNING *`, [job.order_item_id])).rows[0];
      if (item) await recordTransition(client, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
        fromState: 'LEASED', toState: 'QUEUED', stateVersion: item.state_version,
        reasonCode: 'LEASE_EXPIRED_BEFORE_RUN', context });
    }
    await client.query(`UPDATE runner_jobs j SET state='COMPLETED',state_version=j.state_version+1,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() FROM order_items i
      WHERE i.id=j.order_item_id AND i.state='READY_TO_CLAIM' AND j.state<>'COMPLETED'`);
    const crashed = await client.query(`SELECT j.*,
      EXISTS(SELECT 1 FROM runner_mutations m WHERE m.job_id=j.id
        AND m.status IN ('IN_FLIGHT','ACCEPTED','UNCERTAIN')) AS uncertain
      FROM runner_jobs j WHERE j.state IN ('RUNNING','VERIFYING','SETTLING')
        AND j.lease_expires_at<=clock_timestamp() FOR UPDATE`);
    for (const job of crashed.rows) {
      const review = job.uncertain || job.state === 'SETTLING';
      const next = review ? 'MANUAL_REVIEW' : 'WAITING_RETRY';
      await client.query(`UPDATE runner_jobs SET state=$2,state_version=state_version+1,
        available_at=clock_timestamp()+interval '5 seconds',lease_owner=NULL,lease_expires_at=NULL,
        updated_at=clock_timestamp() WHERE id=$1`, [job.id, next]);
      const item = (await client.query(`UPDATE order_items SET state=$2,state_version=state_version+1,
        updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [job.order_item_id, next])).rows[0];
      await recordTransition(client, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
        fromState: job.state, toState: next, stateVersion: item.state_version,
        reasonCode: 'WORKER_CRASH_RECOVERY', context });
      if (review) await openReview(client, { subjectType: 'ORDER_ITEM', subjectId: job.order_item_id,
        reason: 'WORKER_CRASH_REQUIRES_VERIFICATION', financial: true, ownerOnly: false,
        context: { ...context, traceId: job.trace_id } });
    }
    const retryJobs = await client.query(`UPDATE runner_jobs SET state='QUEUED',state_version=state_version+1,
      updated_at=clock_timestamp() WHERE state='WAITING_RETRY' AND available_at<=clock_timestamp() RETURNING *`);
    for (const job of retryJobs.rows) {
      const item = (await client.query(`UPDATE order_items SET state='QUEUED',state_version=state_version+1,
        updated_at=clock_timestamp() WHERE id=$1 AND state='WAITING_RETRY' RETURNING *`, [job.order_item_id])).rows[0];
      if (item) await recordTransition(client, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
        fromState: 'WAITING_RETRY', toState: 'QUEUED', stateVersion: item.state_version,
        reasonCode: 'RETRY_DUE', context });
    }
    const crashedTests = await client.query(`SELECT tr.*,EXISTS(
      SELECT 1 FROM quest_test_mutations m WHERE m.test_run_id=tr.id
        AND m.status IN ('IN_FLIGHT','ACCEPTED','UNCERTAIN')) AS uncertain
      FROM quest_test_runs tr WHERE tr.state='TESTING'
        AND tr.lease_expires_at<=clock_timestamp() FOR UPDATE`);
    for (const testRun of crashedTests.rows) {
      const next = testRun.uncertain ? 'MANUAL_REVIEW' : 'TEST_FAILED';
      const updated = (await client.query(`UPDATE quest_test_runs SET state=$2,
        state_version=state_version+1,lease_owner=NULL,lease_expires_at=NULL,
        error_class='TEST_WORKER_CRASH',completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND state='TESTING' AND state_version=$3 RETURNING *`,
      [testRun.id, next, testRun.state_version])).rows[0];
      if (!updated) continue;
      await recordTransition(client, { aggregateType: 'QUEST_TEST', aggregateId: testRun.id,
        fromState: 'TESTING', toState: next, stateVersion: updated.state_version,
        reasonCode: 'TEST_WORKER_CRASH', context: { ...context, traceId: testRun.trace_id } });
      if (testRun.uncertain) await openReview(client, { subjectType: 'QUEST',
        subjectId: testRun.quest_id, reason: 'QUEST_TEST_CRASH_WITH_UNCERTAIN_MUTATION',
        financial: false, ownerOnly: false, context: { ...context, traceId: testRun.trace_id } });
      else await client.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,
        executor_version,contract_version,trace_id) VALUES(gen_random_uuid(),$1,'TEST_QUEUED',$2,$3,$4,$5)`,
      [testRun.quest_id, testRun.engine_version, testRun.executor_version,
        testRun.contract_version, testRun.trace_id]);
      await enqueueProjection(client, { projectionType: 'QUEST_OPERATION', aggregateType: 'QUEST',
        aggregateId: testRun.quest_id, aggregateVersion: updated.state_version,
        surfaceKey: 'LOG_QUEST_OPERATIONS', context: { ...context, traceId: testRun.trace_id } });
    }
    await client.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,executor_version,
      contract_version,trace_id)
      SELECT gen_random_uuid(),q.quest_id,'RETEST_REQUIRED',q.engine_version,q.executor_version,
        q.contract_version,gen_random_uuid() FROM quests q
      WHERE q.analysis_state='SUPPORTED' AND q.sale_state<>'EXPIRED'
        AND NOT EXISTS(SELECT 1 FROM quest_test_runs active WHERE active.quest_id=q.quest_id
          AND active.state IN ('TEST_QUEUED','TESTING','RETEST_REQUIRED','MANUAL_REVIEW'))
        AND NOT EXISTS(SELECT 1 FROM quest_test_runs recent WHERE recent.quest_id=q.quest_id
          AND recent.created_at>clock_timestamp()-interval '24 hours')
        AND EXISTS(SELECT 1 FROM quest_test_runs passed WHERE passed.quest_id=q.quest_id
          AND passed.state='TEST_PASSED' AND passed.completed_at<clock_timestamp()-interval '24 hours')`);
    const dueRetests = await client.query(`UPDATE quest_test_runs SET state='TEST_QUEUED',
      state_version=state_version+1,updated_at=clock_timestamp()
      WHERE state='RETEST_REQUIRED' RETURNING *`);
    for (const testRun of dueRetests.rows) await recordTransition(client, {
      aggregateType: 'QUEST_TEST', aggregateId: testRun.id, fromState: 'RETEST_REQUIRED',
      toState: 'TEST_QUEUED', stateVersion: testRun.state_version,
      reasonCode: 'RETEST_DUE', context: { ...context, traceId: testRun.trace_id },
    });
    const activeTestMonitors = Number((await client.query(`SELECT count(*)::integer AS count
      FROM monitor_accounts WHERE state='ACTIVE' AND 'TEST'=ANY(capabilities)`)).rows[0].count);
    if (activeTestMonitors === 0) await client.query(`UPDATE quests q SET sale_state='PAUSED',
      sale_version=sale_version+1,updated_at=clock_timestamp()
      WHERE q.sale_state='OPEN' AND EXISTS(SELECT 1 FROM quest_test_runs tr
        WHERE tr.quest_id=q.quest_id AND tr.state='RETEST_REQUIRED')`);
    const crashedPayments = await client.query(`SELECT * FROM topups WHERE status='PROCESSING'
      AND lease_expires_at<=clock_timestamp() FOR UPDATE`);
    for (const row of crashedPayments.rows) {
      const ambiguous = (await client.query(`UPDATE topups SET status='AMBIGUOUS',
        state_version=state_version+1,failure_code='PROCESS_CRASH_AFTER_POSSIBLE_SEND',
        lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND status='PROCESSING' AND state_version=$2 RETURNING *`,
      [row.id, row.state_version])).rows[0];
      if (!ambiguous) continue;
      await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: row.id,
        fromState: 'PROCESSING', toState: 'AMBIGUOUS', stateVersion: ambiguous.state_version,
        reasonCode: 'PROCESS_CRASH_AFTER_POSSIBLE_SEND', context: { ...context, traceId: row.trace_id } });
      const reviewState = (await client.query(`UPDATE topups SET status='MANUAL_REVIEW',
        state_version=state_version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND status='AMBIGUOUS' AND state_version=$2 RETURNING *`,
      [row.id, ambiguous.state_version])).rows[0];
      await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: row.id,
        fromState: 'AMBIGUOUS', toState: 'MANUAL_REVIEW', stateVersion: reviewState.state_version,
        reasonCode: 'PROCESS_CRASH_AFTER_POSSIBLE_SEND', context: { ...context, traceId: row.trace_id } });
      await openReview(client, { subjectType: 'TOPUP', subjectId: row.id,
        reason: 'PROCESS_CRASH_AFTER_POSSIBLE_SEND', financial: true, ownerOnly: true,
        context: { ...context, traceId: row.trace_id } });
    }
    const retries = await client.query(`UPDATE topups SET status='PAYMENT_QUEUED',
      state_version=state_version+1,updated_at=clock_timestamp()
      WHERE status='RETRY_WAIT' AND available_at<=clock_timestamp() RETURNING *`);
    for (const row of retries.rows) {
      await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: row.id,
        fromState: 'RETRY_WAIT', toState: 'PAYMENT_QUEUED', stateVersion: row.state_version, context });
    }
    await client.query(`UPDATE monitor_accounts SET state='ACTIVE',cooldown_until=NULL,
      updated_at=clock_timestamp() WHERE state='COOLDOWN' AND cooldown_until<=clock_timestamp()`);
    const expiredBlocks = await client.query(`UPDATE blocklist_entries SET revoked_at=clock_timestamp(),
      revoked_by='SYSTEM' WHERE revoked_at IS NULL AND expires_at<=clock_timestamp() RETURNING *`);
    for (const block of expiredBlocks.rows) await appendAdminAudit(client, { action: 'BLOCK_EXPIRED',
      targetType: 'DISCORD_USER', targetId: block.discord_user_id, actorId: 'SYSTEM', before: block,
      after: { revokedAt: block.revoked_at, blockType: block.block_type }, reason: 'configured expiry reached', context });
    const incidents = await client.query(`SELECT *,floor(extract(epoch FROM updated_at))::bigint AS version
      FROM incidents WHERE state<>'RESOLVED'`);
    for (const incident of incidents.rows) await enqueueProjection(client, {
      projectionType: 'SYSTEM_INCIDENT', aggregateType: 'INCIDENT', aggregateId: incident.id,
      aggregateVersion: incident.version, surfaceKey: 'LOG_SYSTEM', context,
    });
    const dueReviews = await client.query(`UPDATE manual_reviews SET remind_at=clock_timestamp()+interval '24 hours'
      WHERE state<>'RESOLVED' AND remind_at<=clock_timestamp()
      RETURNING *,floor(extract(epoch FROM remind_at))::bigint AS reminder_version`);
    for (const review of dueReviews.rows) await enqueueProjection(client, {
      projectionType: 'MANUAL_REVIEW', aggregateType: 'MANUAL_REVIEW', aggregateId: review.id,
      aggregateVersion: review.reminder_version, surfaceKey: 'ADMIN_PANEL', context,
    });
  });
  const expiredItems = (await pool.query(`SELECT i.id,j.id AS job_id FROM order_items i
    LEFT JOIN runner_jobs j ON j.order_item_id=i.id
    WHERE i.state IN ('RESERVED','QUEUED') AND i.deadline_at<=clock_timestamp() LIMIT 100`)).rows;
  for (const item of expiredItems) {
    await releaseReservation({ orderItemId: item.id, terminalState: 'EXPIRED_RELEASED',
      reason: 'QUEST_EXPIRED_BEFORE_START' }, { ...context,
      idempotencyKey: `${context.idempotencyKey}:expiry:${item.id}` }, { pool });
    if (item.job_id) await pool.query(`UPDATE runner_jobs SET state='FAILED',state_version=state_version+1,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, [item.job_id]);
  }
  const sellable = (await pool.query("SELECT * FROM quests WHERE sale_state IN ('OPEN','PAUSED') LIMIT 100")).rows;
  for (const quest of sellable) {
    const admission = await withTransaction({ pool, isolation: 'READ COMMITTED', maxAttempts: 1 },
      (database) => evaluateExpiryAdmission(database, { quest, runnerConcurrency }));
    if (!admission.eligible) {
      await withTransaction({ pool, isolation: 'READ COMMITTED' }, async (database) => {
        const expired = admission.reason !== 'EXPIRY_MISSING' && admission.remainingMs <= 0;
        const next = expired ? 'EXPIRED' : 'PAUSED';
        const updated = (await database.query(`UPDATE quests SET sale_state=$2,
          analysis_state=CASE WHEN $2='EXPIRED' THEN 'EXPIRED' ELSE analysis_state END,
          sale_version=sale_version+CASE WHEN sale_state<>$2 THEN 1 ELSE 0 END,
          analysis_version=analysis_version+CASE WHEN $2='EXPIRED' AND analysis_state<>'EXPIRED' THEN 1 ELSE 0 END,
          updated_at=clock_timestamp() WHERE quest_id=$1 AND sale_state<>$2 RETURNING *`, [quest.quest_id, next])).rows[0];
        if (updated) await enqueueProjection(database, { projectionType: 'QUEST_NEW', aggregateType: 'QUEST',
          aggregateId: updated.quest_id, aggregateVersion: updated.sale_version,
          surfaceKey: 'QUEST_NEW', context });
      });
    }
  }
  const orders = (await pool.query(`SELECT DISTINCT i.order_id FROM order_items i
    WHERE i.state='RESERVED' AND NOT EXISTS(SELECT 1 FROM runner_jobs j JOIN order_items active
      ON active.id=j.order_item_id WHERE active.order_id=i.order_id
      AND j.state NOT IN ('COMPLETED','FAILED')) LIMIT 100`)).rows;
  for (const order of orders) await materializeNextOrderItem({ orderId: order.order_id }, context, { pool });
  await checkPermissionDrift({ client, pool, env });
  client.questshop.config = await loadRuntimeConfig(pool);
  await reconcileSurfaceAnchors({ client, pool, env, config: client.questshop.config }, context);
  return true;
}

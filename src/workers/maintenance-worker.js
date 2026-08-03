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
import { pauseQuestForRetest } from '../domain/catalog/service.js';
import { reconcileSurfaceAnchors } from '../discord/surfaces/setup.js';
import { openReview } from '../domain/reviews/service.js';
import { acquireLease, releaseLease, renewLease } from '../db/leases.js';
import { setTimeout as delay } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';

async function recoverExpiredLeases(database, context) {
  const leased = await database.query(`
      UPDATE runner_jobs SET state = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL,
        available_at = clock_timestamp(), state_version = state_version + 1, updated_at = clock_timestamp()
      WHERE state = 'LEASED' AND lease_expires_at <= clock_timestamp() RETURNING *
    `);
  for (const job of leased.rows) {
    await recordTransition(database, { aggregateType: 'RUNNER_JOB', aggregateId: job.id,
      fromState: 'LEASED', toState: 'QUEUED', stateVersion: job.state_version,
      reasonCode: 'LEASE_EXPIRED_BEFORE_RUN', context });
    const item = (await database.query(`UPDATE order_items SET state='QUEUED',state_version=state_version+1,
        updated_at=clock_timestamp() WHERE id=$1 AND state='LEASED' RETURNING *`, [job.order_item_id])).rows[0];
    if (item) await recordTransition(database, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
      fromState: 'LEASED', toState: 'QUEUED', stateVersion: item.state_version,
      reasonCode: 'LEASE_EXPIRED_BEFORE_RUN', context });
  }
  const completed = await database.query(`WITH candidates AS (
      SELECT j.id,j.state AS previous_state FROM runner_jobs j JOIN order_items i ON i.id=j.order_item_id
      WHERE i.state='READY_TO_CLAIM' AND j.state<>'COMPLETED' FOR UPDATE OF j
    ) UPDATE runner_jobs j SET state='COMPLETED',state_version=j.state_version+1,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() FROM candidates
      WHERE j.id=candidates.id RETURNING j.*,candidates.previous_state`);
  for (const job of completed.rows) await recordTransition(database, {
    aggregateType: 'RUNNER_JOB', aggregateId: job.id, fromState: job.previous_state,
    toState: 'COMPLETED', stateVersion: job.state_version,
    reasonCode: 'ITEM_ALREADY_READY_TO_CLAIM', context,
  });
}

async function recoverCrashedRunnerJobs(database, context) {
  const crashed = await database.query(`SELECT j.*,
      EXISTS(SELECT 1 FROM runner_mutations m WHERE m.job_id=j.id
        AND m.status IN ('IN_FLIGHT','ACCEPTED','UNCERTAIN')) AS uncertain
      FROM runner_jobs j WHERE j.state IN ('RUNNING','VERIFYING','SETTLING')
        AND j.lease_expires_at<=clock_timestamp() FOR UPDATE`);
  for (const job of crashed.rows) {
    const review = job.uncertain || job.state === 'SETTLING';
    const next = review ? 'MANUAL_REVIEW' : 'WAITING_RETRY';
    await database.query(`UPDATE runner_jobs SET state=$2,state_version=state_version+1,
        available_at=clock_timestamp()+interval '5 seconds',lease_owner=NULL,lease_expires_at=NULL,
        updated_at=clock_timestamp() WHERE id=$1`, [job.id, next]);
    const recoveredJob = (await database.query('SELECT * FROM runner_jobs WHERE id=$1', [job.id])).rows[0];
    await recordTransition(database, { aggregateType: 'RUNNER_JOB', aggregateId: job.id,
      fromState: job.state, toState: next, stateVersion: recoveredJob.state_version,
      reasonCode: 'WORKER_CRASH_RECOVERY', context });
    const item = (await database.query(`UPDATE order_items SET state=$2,state_version=state_version+1,
        updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [job.order_item_id, next])).rows[0];
    await recordTransition(database, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
      fromState: job.state, toState: next, stateVersion: item.state_version,
      reasonCode: 'WORKER_CRASH_RECOVERY', context });
    if (review) await openReview(database, { subjectType: 'ORDER_ITEM', subjectId: job.order_item_id,
      reason: 'WORKER_CRASH_REQUIRES_VERIFICATION', financial: true, ownerOnly: false,
      context: { ...context, traceId: job.trace_id } });
  }
}

async function requeueRetryJobs(database, context) {
  const retryJobs = await database.query(`UPDATE runner_jobs SET state='QUEUED',state_version=state_version+1,
      updated_at=clock_timestamp() WHERE state='WAITING_RETRY' AND available_at<=clock_timestamp() RETURNING *`);
  for (const job of retryJobs.rows) {
    await recordTransition(database, { aggregateType: 'RUNNER_JOB', aggregateId: job.id,
      fromState: 'WAITING_RETRY', toState: 'QUEUED', stateVersion: job.state_version,
      reasonCode: 'RETRY_DUE', context });
    const item = (await database.query(`UPDATE order_items SET state='QUEUED',state_version=state_version+1,
        updated_at=clock_timestamp() WHERE id=$1 AND state='WAITING_RETRY' RETURNING *`, [job.order_item_id])).rows[0];
    if (item) await recordTransition(database, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
      fromState: 'WAITING_RETRY', toState: 'QUEUED', stateVersion: item.state_version,
      reasonCode: 'RETRY_DUE', context });
  }
}

async function recoverCrashedQuestTests(database, context) {
  const crashedTests = await database.query(`SELECT tr.*,EXISTS(
      SELECT 1 FROM quest_test_mutations m WHERE m.test_run_id=tr.id
        AND m.status IN ('IN_FLIGHT','ACCEPTED','UNCERTAIN')) AS uncertain
      FROM quest_test_runs tr WHERE tr.state='TESTING'
        AND tr.lease_expires_at<=clock_timestamp() FOR UPDATE`);
  for (const testRun of crashedTests.rows) {
    const next = testRun.uncertain ? 'MANUAL_REVIEW' : 'TEST_FAILED';
    const updated = (await database.query(`UPDATE quest_test_runs SET state=$2,
        state_version=state_version+1,lease_owner=NULL,lease_expires_at=NULL,
        error_class='TEST_WORKER_CRASH',completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND state='TESTING' AND state_version=$3 RETURNING *`,
      [testRun.id, next, testRun.state_version])).rows[0];
    if (!updated) continue;
    const tracedContext = { ...context, traceId: testRun.trace_id };
    await recordTransition(database, { aggregateType: 'QUEST_TEST', aggregateId: testRun.id,
      fromState: 'TESTING', toState: next, stateVersion: updated.state_version,
      reasonCode: 'TEST_WORKER_CRASH', context: tracedContext });
    if (testRun.uncertain) await openReview(database, { subjectType: 'QUEST',
      subjectId: testRun.quest_id, reason: 'QUEST_TEST_CRASH_WITH_UNCERTAIN_MUTATION',
      financial: false, ownerOnly: false, context: tracedContext });
    else await database.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,
        executor_version,contract_version,trace_id) VALUES(gen_random_uuid(),$1,'TEST_QUEUED',$2,$3,$4,$5)`,
      [testRun.quest_id, testRun.engine_version, testRun.executor_version,
        testRun.contract_version, testRun.trace_id]);
    await enqueueProjection(database, { projectionType: 'QUEST_OPERATION', aggregateType: 'QUEST',
      aggregateId: testRun.quest_id, aggregateVersion: updated.state_version,
      surfaceKey: 'LOG_QUEST_OPERATIONS', context: tracedContext });
  }
}

export async function maintainQuestRetests(database, context) {
  await database.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,executor_version,
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
  const activeTestMonitors = Number((await database.query(`SELECT count(*)::integer AS count
      FROM monitor_accounts WHERE state='ACTIVE' AND 'TEST'=ANY(capabilities)`)).rows[0].count);
  if (activeTestMonitors === 0) {
    const affectedQuests = await database.query(`SELECT q.* FROM quests q
      WHERE q.sale_state='OPEN' AND EXISTS(SELECT 1 FROM quest_test_runs tr
        WHERE tr.quest_id=q.quest_id AND tr.state='RETEST_REQUIRED') FOR UPDATE`);
    for (const quest of affectedQuests.rows) {
      await pauseQuestForRetest(database, quest, context);
    }
    return;
  }
  const dueRetests = await database.query(`UPDATE quest_test_runs SET state='TEST_QUEUED',
      state_version=state_version+1,updated_at=clock_timestamp()
      WHERE state='RETEST_REQUIRED' RETURNING *`);
  for (const testRun of dueRetests.rows) await recordTransition(database, {
    aggregateType: 'QUEST_TEST', aggregateId: testRun.id, fromState: 'RETEST_REQUIRED',
    toState: 'TEST_QUEUED', stateVersion: testRun.state_version,
    reasonCode: 'RETEST_DUE', context: { ...context, traceId: testRun.trace_id },
  });
}

async function recoverCrashedPayments(database, context) {
  const crashedPayments = await database.query(`SELECT * FROM topups WHERE status='PROCESSING'
      AND lease_expires_at<=clock_timestamp() FOR UPDATE`);
  for (const row of crashedPayments.rows) {
    const ambiguous = (await database.query(`UPDATE topups SET status='AMBIGUOUS',
        state_version=state_version+1,failure_code='PROCESS_CRASH_AFTER_POSSIBLE_SEND',
        lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND status='PROCESSING' AND state_version=$2 RETURNING *`,
      [row.id, row.state_version])).rows[0];
    if (!ambiguous) continue;
    const tracedContext = { ...context, traceId: row.trace_id };
    await recordTransition(database, { aggregateType: 'TOPUP', aggregateId: row.id,
      fromState: 'PROCESSING', toState: 'AMBIGUOUS', stateVersion: ambiguous.state_version,
      reasonCode: 'PROCESS_CRASH_AFTER_POSSIBLE_SEND', context: tracedContext });
    const reviewState = (await database.query(`UPDATE topups SET status='MANUAL_REVIEW',
        state_version=state_version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND status='AMBIGUOUS' AND state_version=$2 RETURNING *`,
      [row.id, ambiguous.state_version])).rows[0];
    await recordTransition(database, { aggregateType: 'TOPUP', aggregateId: row.id,
      fromState: 'AMBIGUOUS', toState: 'MANUAL_REVIEW', stateVersion: reviewState.state_version,
      reasonCode: 'PROCESS_CRASH_AFTER_POSSIBLE_SEND', context: tracedContext });
    await openReview(database, { subjectType: 'TOPUP', subjectId: row.id,
      reason: 'PROCESS_CRASH_AFTER_POSSIBLE_SEND', financial: true, ownerOnly: true, context: tracedContext });
  }
  const retries = await database.query(`UPDATE topups SET status='PAYMENT_QUEUED',
      state_version=state_version+1,updated_at=clock_timestamp()
      WHERE status='RETRY_WAIT' AND available_at<=clock_timestamp() RETURNING *`);
  for (const row of retries.rows) await recordTransition(database, { aggregateType: 'TOPUP', aggregateId: row.id,
    fromState: 'RETRY_WAIT', toState: 'PAYMENT_QUEUED', stateVersion: row.state_version, context });
}

async function maintainMonitorsAndBlocks(database, context) {
  await database.query(`UPDATE monitor_accounts SET state='ACTIVE',cooldown_until=NULL,
      updated_at=clock_timestamp() WHERE state='COOLDOWN' AND cooldown_until<=clock_timestamp()`);
  const expiredBlocks = await database.query(`UPDATE blocklist_entries SET revoked_at=clock_timestamp(),
      revoked_by='SYSTEM' WHERE revoked_at IS NULL AND expires_at<=clock_timestamp() RETURNING *`);
  for (const block of expiredBlocks.rows) await appendAdminAudit(database, { action: 'BLOCK_EXPIRED',
      targetType: 'DISCORD_USER', targetId: block.discord_user_id, actorId: 'SYSTEM', before: block,
      after: { revokedAt: block.revoked_at, blockType: block.block_type }, reason: 'configured expiry reached', context });
}

async function queueMaintenanceNotifications(database, context) {
  const incidents = await database.query(`SELECT *,floor(extract(epoch FROM updated_at))::bigint AS version
      FROM incidents WHERE state<>'RESOLVED'`);
  for (const incident of incidents.rows) await enqueueProjection(database, {
      projectionType: 'SYSTEM_INCIDENT', aggregateType: 'INCIDENT', aggregateId: incident.id,
      aggregateVersion: incident.version, surfaceKey: 'LOG_SYSTEM', context,
    });
  const dueReviews = await database.query(`UPDATE manual_reviews SET remind_at=clock_timestamp()+interval '24 hours'
      WHERE state<>'RESOLVED' AND remind_at<=clock_timestamp()
      RETURNING *,floor(extract(epoch FROM remind_at))::bigint AS reminder_version`);
  for (const review of dueReviews.rows) await enqueueProjection(database, {
      projectionType: 'MANUAL_REVIEW', aggregateType: 'MANUAL_REVIEW', aggregateId: review.id,
      aggregateVersion: review.reminder_version, surfaceKey: 'ADMIN_PANEL', context,
    });
}

async function runTransactionalMaintenance(pool, context) {
  return withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (database) => {
    await recoverExpiredLeases(database, context);
    await recoverCrashedRunnerJobs(database, context);
    await requeueRetryJobs(database, context);
    await recoverCrashedQuestTests(database, context);
    await maintainQuestRetests(database, context);
    await recoverCrashedPayments(database, context);
    await maintainMonitorsAndBlocks(database, context);
    await queueMaintenanceNotifications(database, context);
  });
}

async function releaseExpiredOrderItems(pool, context) {
  const expiredItems = (await pool.query(`SELECT i.id,j.id AS job_id,j.state AS job_state FROM order_items i
    LEFT JOIN runner_jobs j ON j.order_item_id=i.id
    WHERE i.state IN ('RESERVED','QUEUED') AND i.deadline_at<=clock_timestamp() LIMIT 100`)).rows;
  for (const item of expiredItems) {
    await releaseReservation({ orderItemId: item.id, terminalState: 'EXPIRED_RELEASED',
      reason: 'QUEST_EXPIRED_BEFORE_START' }, { ...context,
      idempotencyKey: `${context.idempotencyKey}:expiry:${item.id}` }, { pool });
    if (item.job_id) {
      const failedJob = (await pool.query(`UPDATE runner_jobs SET state='FAILED',state_version=state_version+1,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND state NOT IN ('COMPLETED','FAILED') RETURNING *`, [item.job_id])).rows[0];
      if (failedJob) await withTransaction({ pool, isolation: 'READ COMMITTED' }, (database) => recordTransition(database, {
        aggregateType: 'RUNNER_JOB', aggregateId: failedJob.id, fromState: item.job_state,
        toState: 'FAILED', stateVersion: failedJob.state_version,
        reasonCode: 'QUEST_EXPIRED_BEFORE_START', context,
      }));
    }
  }
}

export async function reconcileSellableQuests(pool, context, runnerConcurrency) {
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
        if (!updated) return;
        if (quest.sale_state !== updated.sale_state) {
          await recordTransition(database, { aggregateType: 'QUEST_SALE', aggregateId: updated.quest_id,
            fromState: quest.sale_state, toState: updated.sale_state,
            stateVersion: updated.sale_version, reasonCode: admission.reason, context });
        }
        if (quest.analysis_state !== updated.analysis_state) {
          await recordTransition(database, { aggregateType: 'QUEST_ANALYSIS', aggregateId: updated.quest_id,
            fromState: quest.analysis_state, toState: updated.analysis_state,
            stateVersion: updated.analysis_version, reasonCode: admission.reason, context });
        }
        await enqueueProjection(database, { projectionType: 'QUEST_NEW', aggregateType: 'QUEST',
          aggregateId: updated.quest_id, aggregateVersion: updated.sale_version,
          surfaceKey: 'QUEST_NEW', context });
      });
    }
  }
}

async function materializeAvailableOrders(pool, context) {
  const orders = (await pool.query(`SELECT DISTINCT i.order_id FROM order_items i
    WHERE i.state='RESERVED' AND NOT EXISTS(SELECT 1 FROM runner_jobs j JOIN order_items active
      ON active.id=j.order_item_id WHERE active.order_id=i.order_id
      AND j.state NOT IN ('COMPLETED','FAILED')) LIMIT 100`)).rows;
  for (const order of orders) await materializeNextOrderItem({ orderId: order.order_id }, context, { pool });
}

function startMaintenanceHeartbeat(lease, pool) {
  const abort = new AbortController();
  let lost = null;
  const done = (async () => {
    while (!abort.signal.aborted) {
      await delay(30_000, undefined, { signal: abort.signal, ref: false });
      if (abort.signal.aborted) break;
      try {
        await renewLease({ resourceType: 'MAINTENANCE', resourceId: lease.resource_id,
          holder: lease.lease_owner, fencingToken: lease.fencing_token, ttlSeconds: 120 }, { pool });
      } catch (error) {
        lost = error;
        abort.abort(error);
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
    async stop() { abort.abort('maintenance complete'); await done; },
  };
}

async function runMaintainedStep(heartbeat, action) {
  heartbeat.assertOwned();
  const result = await action();
  heartbeat.assertOwned();
  return result;
}

export async function runMaintenance({ env, holder, client, pool, runnerConcurrency = env.RUNNER_CONCURRENCY }) {
  // Startup recovery historically used a human-readable holder.  The durable
  // lease owner is UUID typed, so keep that diagnostic actor separately.
  const leaseHolder = typeof holder === 'string' && /^[0-9a-f]{8}-/i.test(holder) ? holder : uuidv7();
  const lease = await acquireLease({ resourceType: 'MAINTENANCE', resourceId: env.DISCORD_GUILD_ID,
    holder: leaseHolder, ttlSeconds: 120 }, { pool });
  if (!lease) return false;
  const heartbeat = startMaintenanceHeartbeat(lease, pool);
  const context = createContext({ actorType: 'SYSTEM', actorId: holder, guildId: env.DISCORD_GUILD_ID,
    idempotencyKey: `maintenance:${new Date().toISOString().slice(0, 16)}` });
  try {
    await runMaintainedStep(heartbeat, () => expireSessions({}, context, { pool }));
    await runMaintainedStep(heartbeat, () => runTransactionalMaintenance(pool, context));
    await runMaintainedStep(heartbeat, () => releaseExpiredOrderItems(pool, context));
    await runMaintainedStep(heartbeat, () => reconcileSellableQuests(pool, context, runnerConcurrency));
    await runMaintainedStep(heartbeat, () => materializeAvailableOrders(pool, context));
    await runMaintainedStep(heartbeat, () => checkPermissionDrift({ client, pool, env }));
    client.questshop.config = await runMaintainedStep(heartbeat, () => loadRuntimeConfig(pool));
    await runMaintainedStep(heartbeat, () => reconcileSurfaceAnchors({ client, pool, env,
      config: client.questshop.config }, context));
    return true;
  } finally {
    await heartbeat.stop();
    await releaseLease({ resourceType: 'MAINTENANCE', resourceId: env.DISCORD_GUILD_ID,
      holder: lease.lease_owner, fencingToken: lease.fencing_token }, { pool });
  }
}

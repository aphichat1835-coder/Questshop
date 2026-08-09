import { expireSessions } from '../domain/checkout/service.js';
import { createContext } from '../shared/correlation.js';
import { withTransaction } from '../db/transaction.js';
import { assertTransition, recordTransition } from '../domain/shared/transition.js';
import { containRunnerQueueMismatch, materializeNextOrderItem, requeueDueRunnerJobsInTransaction } from '../domain/runner/service.js';
import { RUNNER_JOB_TRANSITIONS } from '../domain/runner/states.js';
import { ORDER_ITEM_TRANSITIONS } from '../domain/orders/states.js';
import { TOPUP_TRANSITIONS } from '../domain/payments/states.js';
import { ANALYSIS_TRANSITIONS, SALE_TRANSITIONS, TEST_TRANSITIONS } from '../domain/catalog/states.js';
import { enqueueProjection } from '../domain/outbox/service.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { appendAdminAudit } from '../domain/admin/audit.js';
import { releaseReservation } from '../domain/wallet/service.js';
import { evaluateExpiryAdmission } from '../domain/catalog/expiry.js';
import { resolvePrice } from '../domain/pricing/resolver.js';
import { pauseQuestForRetest } from '../domain/catalog/service.js';
import { advanceMonitorTestBatch, hasCurrentTestPass, reconcilePassedMonitorTestBatches } from '../domain/catalog/test-gate.js';
import { reconcileSurfaceAnchors } from '../discord/surfaces/setup.js';
import { openReview } from '../domain/reviews/service.js';
import { acquireLease, releaseLease, renewLease } from '../db/leases.js';
import { setTimeout as delay } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { QuestshopError } from '../shared/errors.js';

function assertRunnerPairTransition(jobState, itemState, nextState) {
  assertTransition(RUNNER_JOB_TRANSITIONS, jobState, nextState);
  assertTransition(ORDER_ITEM_TRANSITIONS, itemState, nextState);
}

async function transitionRunnerPair(database, job, item, nextState, context, reasonCode, {
  delaySeconds = null,
  makeAvailableNow = false,
  clearLease = true,
} = {}) {
  assertRunnerPairTransition(job.state, item.state, nextState);
  const updatedJob = (await database.query(`UPDATE runner_jobs SET state=$2,
      state_version=state_version+1,
      available_at=CASE WHEN $3::integer IS NOT NULL THEN clock_timestamp()+make_interval(secs=>$3)
        WHEN $4::boolean THEN clock_timestamp() ELSE available_at END,
      lease_owner=CASE WHEN $5::boolean THEN NULL ELSE lease_owner END,
      lease_expires_at=CASE WHEN $5::boolean THEN NULL ELSE lease_expires_at END,
      updated_at=clock_timestamp()
      WHERE id=$1 AND state=$6 AND state_version=$7 RETURNING *`,
  [job.id, nextState, delaySeconds, makeAvailableNow, clearLease, job.state, job.state_version])).rows[0];
  if (!updatedJob) throw new QuestshopError('STALE_RUNNER_STATE', `Runner job ${job.id} changed during recovery`);
  const updatedItem = (await database.query(`UPDATE order_items SET state=$2,state_version=state_version+1,
      updated_at=clock_timestamp() WHERE id=$1 AND state=$3 AND state_version=$4 RETURNING *`,
  [item.id, nextState, item.state, item.state_version])).rows[0];
  if (!updatedItem) throw new QuestshopError('STALE_ITEM_STATE', `Order item ${item.id} changed during recovery`);
  await recordTransition(database, { aggregateType: 'RUNNER_JOB', aggregateId: updatedJob.id,
    fromState: job.state, toState: nextState, stateVersion: updatedJob.state_version,
    reasonCode, context });
  await recordTransition(database, { aggregateType: 'ORDER_ITEM', aggregateId: updatedItem.id,
    fromState: item.state, toState: nextState, stateVersion: updatedItem.state_version,
    reasonCode, context });
  return { job: updatedJob, item: updatedItem };
}

async function recoverExpiredLeases(database, context) {
  const leased = (await database.query(`
      SELECT j.*,i.state AS item_state,i.state_version AS item_state_version
      FROM runner_jobs j JOIN order_items i ON i.id=j.order_item_id
      WHERE j.state='LEASED' AND j.lease_expires_at<=clock_timestamp()
      FOR UPDATE OF j,i SKIP LOCKED
    `)).rows;
  for (const job of leased) {
    if (job.item_state !== 'LEASED') {
      await containRunnerQueueMismatch(database, job, context, 'EXPIRED_LEASE_STATE_MISMATCH');
      continue;
    }
    await transitionRunnerPair(database, job, { id: job.order_item_id, state: job.item_state,
      state_version: job.item_state_version }, 'QUEUED', context, 'LEASE_EXPIRED_BEFORE_RUN', {
      makeAvailableNow: true,
    });
  }
  const settled = (await database.query(`
      SELECT j.* FROM runner_jobs j JOIN order_items i ON i.id=j.order_item_id
      WHERE i.state='READY_TO_CLAIM' AND j.state='SETTLING'
      FOR UPDATE OF j,i SKIP LOCKED
    `)).rows;
  for (const job of settled) {
    assertTransition(RUNNER_JOB_TRANSITIONS, job.state, 'COMPLETED');
    const updated = (await database.query(`UPDATE runner_jobs SET state='COMPLETED',
      state_version=state_version+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND state='SETTLING' AND state_version=$2 RETURNING *`,
    [job.id, job.state_version])).rows[0];
    if (!updated) throw new QuestshopError('STALE_RUNNER_STATE', `Runner job ${job.id} changed during settlement recovery`);
    await recordTransition(database, { aggregateType: 'RUNNER_JOB', aggregateId: updated.id,
      fromState: job.state, toState: 'COMPLETED', stateVersion: updated.state_version,
      reasonCode: 'ITEM_ALREADY_READY_TO_CLAIM', context });
  }
}

async function recoverCrashedRunnerJobs(database, context) {
  const crashed = await database.query(`SELECT j.*,
      i.state AS item_state,i.state_version AS item_state_version,
      EXISTS(SELECT 1 FROM runner_mutations m WHERE m.job_id=j.id
        AND m.status IN ('IN_FLIGHT','ACCEPTED','UNCERTAIN')) AS uncertain
      FROM runner_jobs j JOIN order_items i ON i.id=j.order_item_id
      WHERE j.state IN ('RUNNING','VERIFYING','SETTLING')
        AND j.lease_expires_at<=clock_timestamp() FOR UPDATE OF j,i SKIP LOCKED`);
  for (const job of crashed.rows) {
    const review = job.uncertain || job.state === 'SETTLING';
    const next = review ? 'MANUAL_REVIEW' : 'WAITING_RETRY';
    if (job.item_state !== job.state) {
      await containRunnerQueueMismatch(database, job, context, 'CRASH_RECOVERY_STATE_MISMATCH');
      continue;
    }
    await transitionRunnerPair(database, job, {
      id: job.order_item_id, state: job.item_state, state_version: job.item_state_version,
    }, next, context, 'WORKER_CRASH_RECOVERY', {
      delaySeconds: next === 'WAITING_RETRY' ? 5 : null,
    });
    if (review) await openReview(database, { subjectType: 'ORDER_ITEM', subjectId: job.order_item_id,
      reason: 'WORKER_CRASH_REQUIRES_VERIFICATION', financial: true, ownerOnly: false,
      context: { ...context, traceId: job.trace_id } });
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
    assertTransition(TEST_TRANSITIONS, testRun.state, next);
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
    else if (updated.batch_id) {
      const quest = (await database.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE',
        [updated.quest_id])).rows[0];
      await advanceMonitorTestBatch(database, { run: updated, quest,
        error: { code: 'TEST_WORKER_CRASH', message: 'Quest test worker stopped before completion' },
        context: tracedContext });
    } else await database.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,
        executor_version,contract_version,trace_id) VALUES(gen_random_uuid(),$1,'TEST_QUEUED',$2,$3,$4,$5)`,
      [testRun.quest_id, testRun.engine_version, testRun.executor_version,
        testRun.contract_version, testRun.trace_id]);
    await enqueueProjection(database, { projectionType: 'QUEST_OPERATION', aggregateType: 'QUEST',
      aggregateId: testRun.quest_id, aggregateVersion: updated.state_version,
      surfaceKey: 'LOG_QUEST_OPERATIONS', context: tracedContext });
  }
}

async function recoverCrashedPayments(database, context) {
  const crashedPayments = await database.query(`SELECT * FROM topups WHERE status='PROCESSING'
      AND lease_expires_at<=clock_timestamp() FOR UPDATE`);
  for (const row of crashedPayments.rows) {
    assertTransition(TOPUP_TRANSITIONS, row.status, 'AMBIGUOUS');
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
    assertTransition(TOPUP_TRANSITIONS, ambiguous.status, 'MANUAL_REVIEW');
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
  const retries = (await database.query(`SELECT * FROM topups
      WHERE status='RETRY_WAIT' AND available_at<=clock_timestamp()
      FOR UPDATE SKIP LOCKED`)).rows;
  for (const row of retries) {
    assertTransition(TOPUP_TRANSITIONS, row.status, 'PAYMENT_QUEUED');
    const updated = (await database.query(`UPDATE topups SET status='PAYMENT_QUEUED',
      state_version=state_version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND status=$2 AND state_version=$3 RETURNING *`,
    [row.id, row.status, row.state_version])).rows[0];
    if (!updated) throw new QuestshopError('STALE_TOPUP_STATE', `Top-up ${row.id} changed during recovery`);
    await recordTransition(database, { aggregateType: 'TOPUP', aggregateId: updated.id,
      fromState: row.status, toState: 'PAYMENT_QUEUED', stateVersion: updated.state_version, context });
  }
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
    await requeueDueRunnerJobsInTransaction(database, context, { includeExpired: true });
    await recoverCrashedQuestTests(database, context);
    await reconcilePassedMonitorTestBatches(database, context);
    await recoverCrashedPayments(database, context);
    await maintainMonitorsAndBlocks(database, context);
    await queueMaintenanceNotifications(database, context);
  });
}

async function releaseExpiredOrderItems(pool, context) {
  const expiredItems = (await pool.query(`SELECT i.id,j.id AS job_id FROM order_items i
    LEFT JOIN runner_jobs j ON j.order_item_id=i.id
    WHERE i.state IN ('RESERVED','QUEUED') AND i.deadline_at<=clock_timestamp() LIMIT 100`)).rows;
  for (const item of expiredItems) {
    await releaseReservation({ orderItemId: item.id, terminalState: 'EXPIRED_RELEASED',
      reason: 'QUEST_EXPIRED_BEFORE_START' }, { ...context,
      idempotencyKey: `${context.idempotencyKey}:expiry:${item.id}` }, { pool });
    if (item.job_id) {
      await withTransaction({ pool, isolation: 'READ COMMITTED' }, async (database) => {
        const job = (await database.query('SELECT * FROM runner_jobs WHERE id=$1 FOR UPDATE', [item.job_id])).rows[0];
        if (!job || ['COMPLETED', 'FAILED'].includes(job.state)) return;
        assertTransition(RUNNER_JOB_TRANSITIONS, job.state, 'FAILED');
        const failedJob = (await database.query(`UPDATE runner_jobs SET state='FAILED',state_version=state_version+1,
          lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND state=$2 AND state_version=$3 RETURNING *`,
        [job.id, job.state, job.state_version])).rows[0];
        if (!failedJob) throw new QuestshopError('STALE_RUNNER_STATE', `Runner job ${job.id} changed during expiry`);
        await recordTransition(database, { aggregateType: 'RUNNER_JOB', aggregateId: failedJob.id,
          fromState: job.state, toState: 'FAILED', stateVersion: failedJob.state_version,
          reasonCode: 'QUEST_EXPIRED_BEFORE_START', context });
      });
    }
  }
}

export async function reconcileSellableQuests(pool, context, runnerConcurrency) {
  const sellable = (await pool.query(`SELECT * FROM quests WHERE sale_state IN ('OPEN','PAUSED','CLOSED')
    ORDER BY updated_at,quest_id LIMIT 100`)).rows;
  for (const quest of sellable) {
    const admission = await withTransaction({ pool, isolation: 'READ COMMITTED', maxAttempts: 1 },
      (database) => evaluateExpiryAdmission(database, { quest, runnerConcurrency }));
    if (!admission.eligible) {
      await withTransaction({ pool, isolation: 'READ COMMITTED' }, async (database) => {
        const current = (await database.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [quest.quest_id])).rows[0];
        if (!current) return;
        const currentAdmission = await evaluateExpiryAdmission(database, { quest: current, runnerConcurrency });
        if (currentAdmission.eligible) return;
        const expired = currentAdmission.reason !== 'EXPIRY_MISSING' && currentAdmission.remainingMs <= 0;
        const next = expired ? 'EXPIRED' : 'PAUSED';
        if (current.sale_state === next) return;
        assertTransition(SALE_TRANSITIONS, current.sale_state, next);
        const analysisExpires = next === 'EXPIRED' && current.analysis_state !== 'EXPIRED';
        if (analysisExpires) assertTransition(ANALYSIS_TRANSITIONS, current.analysis_state, 'EXPIRED');
        const updated = (await database.query(`UPDATE quests SET sale_state=$2,
          analysis_state=CASE WHEN $2='EXPIRED' THEN 'EXPIRED' ELSE analysis_state END,
          sale_version=sale_version+1,
          analysis_version=analysis_version+CASE WHEN $2='EXPIRED' AND analysis_state<>'EXPIRED' THEN 1 ELSE 0 END,
          updated_at=clock_timestamp() WHERE quest_id=$1 AND sale_state=$3 AND sale_version=$4 RETURNING *`,
        [current.quest_id, next, current.sale_state, current.sale_version])).rows[0];
        if (!updated) return;
        if (current.sale_state !== updated.sale_state) {
          await recordTransition(database, { aggregateType: 'QUEST_SALE', aggregateId: updated.quest_id,
            fromState: current.sale_state, toState: updated.sale_state,
            stateVersion: updated.sale_version, reasonCode: currentAdmission.reason, context });
        }
        if (current.analysis_state !== updated.analysis_state) {
          await recordTransition(database, { aggregateType: 'QUEST_ANALYSIS', aggregateId: updated.quest_id,
            fromState: current.analysis_state, toState: updated.analysis_state,
            stateVersion: updated.analysis_version, reasonCode: currentAdmission.reason, context });
        }
        await enqueueProjection(database, { projectionType: 'QUEST_NEW', aggregateType: 'QUEST',
          aggregateId: updated.quest_id, aggregateVersion: updated.sale_version,
          surfaceKey: 'QUEST_NEW', context });
      });
      continue;
    }
    await withTransaction({ pool, isolation: 'READ COMMITTED' }, async (database) => {
      const current = (await database.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [quest.quest_id])).rows[0];
      const testPassed = await hasCurrentTestPass(database, current);
      if (!testPassed) {
        if (current.sale_state === 'OPEN') await pauseQuestForRetest(database, current, context);
        return;
      }
      if (!['CLOSED', 'PAUSED'].includes(current.sale_state) || current.analysis_state !== 'SUPPORTED') return;
      const coreComplete = Boolean(current.name && current.task_type && Number(current.task_target) > 0
        && current.url && current.starts_at && current.expires_at && current.executor_id);
      const price = await resolvePrice(database, { questId: current.quest_id, taskType: current.task_type });
      if (!coreComplete || !price) return;
      assertTransition(SALE_TRANSITIONS, current.sale_state, 'OPEN');
      const opened = (await database.query(`UPDATE quests SET sale_state='OPEN',sale_version=sale_version+1,
        updated_at=clock_timestamp() WHERE quest_id=$1 AND sale_state=$2 AND sale_version=$3 RETURNING *`,
      [current.quest_id, current.sale_state, current.sale_version])).rows[0];
      if (!opened) return;
      await recordTransition(database, { aggregateType: 'QUEST_SALE', aggregateId: opened.quest_id,
        fromState: current.sale_state, toState: 'OPEN', stateVersion: opened.sale_version,
        reasonCode: 'MONITOR_TEST_PASSED', context });
      await enqueueProjection(database, { projectionType: 'QUEST_NEW', aggregateType: 'QUEST',
        aggregateId: opened.quest_id, aggregateVersion: opened.sale_version,
        surfaceKey: 'QUEST_NEW', context });
    });
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

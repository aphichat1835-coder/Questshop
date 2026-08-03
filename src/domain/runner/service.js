import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { decryptSecret } from '../../adapters/crypto/keyring.js';
import { withTransaction } from '../../db/transaction.js';
import { FencingLostError, QuestshopError } from '../../shared/errors.js';
import { createContext } from '../../shared/correlation.js';
import { createQuestApiClient, profileFromEnv } from '../../quest-engine/api/client.js';
import { executeQuestExecutor } from '../../quest-engine/executors/contract.js';
import { selectQuestExecutor } from '../../quest-engine/executors/registry.js';
import { evaluateExpiryAdmission } from '../catalog/expiry.js';
import { enqueueProjection } from '../outbox/service.js';
import { openReview } from '../reviews/service.js';
import { recordTransition } from '../shared/transition.js';
import { captureReservation, releaseReservation } from '../wallet/service.js';
import { progressBucket, RUNNER_JOB_TRANSITIONS } from './states.js';
import { isRunnerVersionCompatible, RUNNER_VERSION_COMPATIBILITY } from '../../config/versions.js';
import { secureJitter } from '../../shared/random.js';

function assertJobTransition(current, next) {
  if (!(RUNNER_JOB_TRANSITIONS[current] ?? []).includes(next)) {
    throw new TypeError(`Illegal runner job transition ${current} -> ${next}`);
  }
}

function requestHash(kind, payload) {
  return createHash('sha256').update(`${kind}:${JSON.stringify(payload)}`).digest('hex');
}

function isUncertain(error) {
  return error?.code === 'PROVIDER_RESULT_AMBIGUOUS'
    || error?.name === 'AbortError'
    || error?.name === 'TypeError'
    || error?.status === 429
    || Number(error?.status) >= 500;
}

function isRunnerTransient(error) {
  return error?.retryable === true || error?.status === 429 || Number(error?.status) >= 500
    || (error?.name === 'TypeError' && error?.category !== 'BUSINESS');
}

function retryStateForRunnerJob(state) {
  if (state === 'LEASED') return 'QUEUED';
  if (['RUNNING', 'VERIFYING'].includes(state)) return 'WAITING_RETRY';
  return 'MANUAL_REVIEW';
}

async function checkpointRetryJob(job, context, options, reasonCode = 'GRACEFUL_SHUTDOWN_CHECKPOINT') {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const current = (await client.query(`SELECT * FROM runner_jobs WHERE id=$1 AND lease_owner=$2
      AND fencing_token=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [job.id, job.lease_owner, job.fencing_token])).rows[0];
    if (!current) throw new FencingLostError(`runner:${job.id}`);
    const next = retryStateForRunnerJob(current.state);
    const itemNext = next;
    const updatedJob = (await client.query(`UPDATE runner_jobs SET state=$2,state_version=state_version+1,
      available_at=clock_timestamp()+make_interval(secs => floor(random()*LEAST(300::double precision,
        5::double precision*power(2::double precision,GREATEST(0,attempt_count-1))))::integer),
      lease_owner=NULL,lease_expires_at=NULL,
      updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [current.id, next])).rows[0];
    const item = (await client.query(`UPDATE order_items SET state=$2,state_version=state_version+1,
      updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [current.order_item_id, itemNext])).rows[0];
    await recordTransition(client, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
      fromState: current.state, toState: itemNext, stateVersion: item.state_version,
      reasonCode, context });
    if (next === 'MANUAL_REVIEW') await openReview(client, { subjectType: 'ORDER_ITEM',
      subjectId: item.id, reason: `${reasonCode}_DURING_SETTLEMENT`, financial: true,
      ownerOnly: false, context });
    return updatedJob;
  });
}

function retryDelay(error) {
  const seconds = Number(error?.data?.retry_after ?? error?.retryAfter);
  const cap = Number.isFinite(seconds) ? Math.min(60_000, seconds * 1000) : 1000;
  return secureJitter(cap);
}

function mutationApplied(kind, payload, baseline, fresh) {
  if (kind === 'ENROLL') return fresh.enrolled;
  if (fresh.completed) return true;
  if (kind === 'VIDEO_PROGRESS') return Number(fresh.progressSecs) >= Number(payload.timestamp);
  if (kind === 'HEARTBEAT') return Number(fresh.progressSecs) > Number(baseline);
  return false;
}

async function updateOwnedJob(client, job, next, patch = {}) {
  assertJobTransition(job.state, next);
  const result = await client.query(`
    UPDATE runner_jobs SET
      state = $4, state_version = state_version + 1,
      available_at = COALESCE($5, available_at),
      lease_owner = CASE WHEN $6 THEN NULL ELSE lease_owner END,
      lease_expires_at = CASE WHEN $6 THEN NULL ELSE lease_expires_at END,
      updated_at = clock_timestamp()
    WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
      AND state_version = $7 AND lease_expires_at > clock_timestamp()
    RETURNING *
  `, [
    job.id, job.lease_owner, job.fencing_token, next, patch.availableAt ?? null,
    patch.releaseLease ?? false, job.state_version,
  ]);
  if (!result.rows[0]) throw new FencingLostError(`runner:${job.id}`);
  return result.rows[0];
}

export async function acquireRunnableJob({ holder, ttlSeconds = 60 }, context, options = {}) {
  const engineVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.engine);
  const executorVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.executor);
  const contractVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.contract);
  const stateSchemas = RUNNER_VERSION_COMPATIBILITY.map((item) => item.stateSchema);
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const result = await client.query(`
      WITH selected_user AS (
        SELECT su.discord_user_id
        FROM scheduler_users su
        WHERE EXISTS (
          SELECT 1 FROM runner_jobs j
          WHERE j.discord_user_id = su.discord_user_id
            AND j.state = 'QUEUED' AND j.available_at <= clock_timestamp()
            AND j.deadline_at > clock_timestamp()
            AND EXISTS (SELECT 1 FROM unnest($3::text[],$4::text[],$5::text[],$6::integer[])
              AS supported(engine,executor,contract,state_schema)
              WHERE supported.engine=j.engine_version AND supported.executor=j.executor_version
                AND supported.contract=j.contract_version
                AND supported.state_schema=j.runner_state_schema_version)
        )
        ORDER BY su.last_dispatched_at NULLS FIRST, su.updated_at
        FOR UPDATE SKIP LOCKED LIMIT 1
      ), candidate AS (
        SELECT j.id FROM runner_jobs j JOIN selected_user u USING (discord_user_id)
        WHERE j.state = 'QUEUED' AND j.available_at <= clock_timestamp()
          AND j.deadline_at > clock_timestamp()
          AND EXISTS (SELECT 1 FROM unnest($3::text[],$4::text[],$5::text[],$6::integer[])
            AS supported(engine,executor,contract,state_schema)
            WHERE supported.engine=j.engine_version AND supported.executor=j.executor_version
              AND supported.contract=j.contract_version
              AND supported.state_schema=j.runner_state_schema_version)
        ORDER BY j.available_at, j.created_at
        FOR UPDATE OF j SKIP LOCKED LIMIT 1
      )
      UPDATE runner_jobs j SET
        state = 'LEASED', state_version = state_version + 1,
        lease_owner = $1, lease_expires_at = clock_timestamp() + make_interval(secs => $2),
        fencing_token = fencing_token + 1, attempt_count = attempt_count + 1,
        updated_at = clock_timestamp()
      FROM candidate WHERE j.id = candidate.id RETURNING j.*
    `, [holder, ttlSeconds, engineVersions, executorVersions, contractVersions, stateSchemas]);
    const job = result.rows[0];
    if (!job) return null;
    await client.query(`
      UPDATE scheduler_users SET last_dispatched_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE discord_user_id = $1
    `, [job.discord_user_id]);
    const item = (await client.query(`
      UPDATE order_items SET state = 'LEASED', state_version = state_version + 1,
        updated_at = clock_timestamp()
      WHERE id = $1 AND state = 'QUEUED' RETURNING *
    `, [job.order_item_id])).rows[0];
    if (!item) throw new QuestshopError('ITEM_STATE_CONFLICT', 'Order item was not queued');
    await recordTransition(client, {
      aggregateType: 'ORDER_ITEM', aggregateId: item.id,
      fromState: 'QUEUED', toState: 'LEASED', stateVersion: item.state_version, context,
    });
    await enqueueProjection(client, { projectionType: 'RUNNER_SUMMARY', aggregateType: 'RUNNER_JOB',
      aggregateId: job.id, aggregateVersion: job.state_version, surfaceKey: 'LOG_QUEST_OPERATIONS', context });
    return job;
  });
}

export async function renewRunnerJob(job, ttlSeconds = 60, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const result = await client.query(`
      UPDATE runner_jobs SET lease_expires_at = clock_timestamp() + make_interval(secs => $4),
        updated_at = clock_timestamp()
      WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
        AND lease_expires_at > clock_timestamp() AND state NOT IN ('COMPLETED','FAILED')
      RETURNING *
    `, [job.id, job.lease_owner, job.fencing_token, ttlSeconds]);
    if (!result.rows[0]) throw new FencingLostError(`runner:${job.id}`);
    return result.rows[0];
  });
}

async function createAttempt(job, context, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => (
    (await client.query(`
      INSERT INTO runner_attempts(id, job_id, attempt_number, parent_attempt_id, stage, trace_id)
      VALUES ($1,$2,$3,(
        SELECT id FROM runner_attempts WHERE job_id=$2
        ORDER BY attempt_number DESC,started_at DESC LIMIT 1
      ),'STARTING',$4) RETURNING *
    `, [uuidv7(), job.id, job.attempt_count, context.traceId])).rows[0]
  ));
}

async function prepareMutation(job, attempt, kind, payload, baseline, context, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const owned = (await client.query(`
      SELECT * FROM runner_jobs WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
        AND lease_expires_at > clock_timestamp() FOR UPDATE
    `, [job.id, job.lease_owner, job.fencing_token])).rows[0];
    if (!owned) throw new FencingLostError(`runner:${job.id}`);
    const pending = (await client.query(`
      SELECT 1 FROM runner_mutations WHERE job_id = $1
        AND status IN ('PREPARED','IN_FLIGHT','ACCEPTED','UNCERTAIN') LIMIT 1
    `, [job.id])).rowCount;
    if (pending) throw new QuestshopError('MUTATION_REQUIRES_VERIFICATION', 'Previous mutation is not verified');
    const sequence = Number((await client.query(`
      SELECT COALESCE(max(sequence_number), 0)::integer + 1 AS sequence
      FROM runner_mutations WHERE job_id = $1
    `, [job.id])).rows[0].sequence);
    const mutation = (await client.query(`
      INSERT INTO runner_mutations(
        id, job_id, attempt_id, sequence_number, mutation_kind, status,
        baseline_progress, target_payload, request_hash, trace_id
      ) VALUES ($1,$2,$3,$4,$5,'PREPARED',$6,$7,$8,$9) RETURNING *
    `, [
      uuidv7(), job.id, attempt.id, sequence, kind, baseline,
      payload, requestHash(kind, payload), context.traceId,
    ])).rows[0];
    return (await client.query(`
      UPDATE runner_mutations SET status = 'IN_FLIGHT', attempted_at = clock_timestamp()
      WHERE id = $1 AND status = 'PREPARED' RETURNING *
    `, [mutation.id])).rows[0];
  });
}

async function markMutation(job, mutationId, status, evidence, errorClass, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const updated = (await client.query(`
      UPDATE runner_mutations SET status = $2, evidence = $3, error_class = $4,
        verified_at = CASE WHEN $2 = 'VERIFIED' THEN clock_timestamp() ELSE verified_at END
      WHERE id = $1 AND EXISTS(SELECT 1 FROM runner_jobs j WHERE j.id=runner_mutations.job_id
        AND j.lease_owner=$5 AND j.fencing_token=$6 AND j.lease_expires_at>clock_timestamp())
      RETURNING *
    `, [mutationId, status, evidence ?? {}, errorClass ?? null, job.lease_owner, job.fencing_token])).rows[0];
    if (!updated) throw new FencingLostError(`runner:${job.id}`);
    return updated;
  });
}

async function acceptInitialMutation(job, mutation, perform, options) {
  try {
    await perform();
    await markMutation(job, mutation.id, 'ACCEPTED', {}, null, options);
    return null;
  } catch (error) {
    if (!isUncertain(error)) {
      await markMutation(job, mutation.id, 'FAILED', {}, error.code ?? error.name, options);
      throw error;
    }
    await markMutation(job, mutation.id, 'UNCERTAIN', {}, error.code ?? error.name, options);
    return error;
  }
}

async function verifyMutationResult(job, mutation, kind, payload, baseline, fetchFresh, options) {
  try {
    const fresh = await fetchFresh();
    if (mutationApplied(kind, payload, baseline, fresh)) {
      await markMutation(job, mutation.id, 'VERIFIED', { progress: fresh.progressSecs }, null, options);
      return fresh;
    }
    return null;
  } catch (error) {
    await markMutation(job, mutation.id, 'UNCERTAIN', { verificationFailed: true }, error.code ?? error.name, options);
    throw new QuestshopError('MUTATION_AMBIGUOUS', 'ไม่สามารถยืนยันผล Mutation ได้', {
      category: 'AMBIGUOUS', cause: error,
    });
  }
}

async function controlledRetry({ job, mutation, perform, fetchFresh, kind, payload, baseline, options }) {
  try {
    await perform();
    const fresh = await fetchFresh();
    if (!mutationApplied(kind, payload, baseline, fresh)) return null;
    await markMutation(job, mutation.id, 'VERIFIED', { controlledRetry: true, progress: fresh.progressSecs }, null, options);
    return fresh;
  } catch (error) {
    await markMutation(job, mutation.id, 'UNCERTAIN', { controlledRetry: true }, error.code ?? error.name, options);
    return null;
  }
}

async function executeMutation({ job, attempt, kind, payload, baseline, perform, fetchFresh, context, options }) {
  const mutation = await prepareMutation(job, attempt, kind, payload, baseline, context, options);
  const firstError = await acceptInitialMutation(job, mutation, perform, options);
  const verified = await verifyMutationResult(job, mutation, kind, payload, baseline, fetchFresh, options);
  if (verified) return verified;
  await markMutation(job, mutation.id, firstError ? 'UNCERTAIN' : 'FAILED',
    { notApplied: true, controlledRetryPending: true }, firstError?.code ?? 'NOT_APPLIED', options);
  await delay(firstError ? retryDelay(firstError) : secureJitter(1000), undefined, { ref: false });
  const retried = await controlledRetry({ job, mutation, perform, fetchFresh, kind, payload, baseline, options });
  if (retried) return retried;
  throw new QuestshopError('MUTATION_AMBIGUOUS', 'Mutation ยังไม่ชัดเจนหลัง Controlled retry', {
    category: 'AMBIGUOUS',
  });
}

async function updateItemProgress(job, fresh, context, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const owned = (await client.query(`SELECT 1 FROM runner_jobs WHERE id=$1 AND lease_owner=$2
      AND fencing_token=$3 AND lease_expires_at>clock_timestamp()`,
    [job.id, job.lease_owner, job.fencing_token])).rowCount;
    if (!owned) throw new FencingLostError(`runner:${job.id}`);
    const item = (await client.query(`
      SELECT * FROM order_items WHERE id = $1 FOR UPDATE
    `, [job.order_item_id])).rows[0];
    if (!item || ['READY_TO_CLAIM', 'EXPIRED_RELEASED', 'EXTERNAL_COMPLETED_RELEASED', 'STOPPED_RELEASED', 'FAILED_RELEASED'].includes(item.state)) {
      return item;
    }
    const actual = Math.max(Number(item.progress_actual), Number(fresh.progress));
    const bucket = progressBucket(actual, fresh.completed);
    const changed = bucket !== item.progress_bucket || fresh.completed;
    const updated = (await client.query(`
      UPDATE order_items SET progress_actual = $2, progress_bucket = $3,
        updated_at = clock_timestamp() WHERE id = $1 RETURNING *
    `, [item.id, actual, bucket])).rows[0];
    if (changed) {
      await enqueueProjection(client, {
        projectionType: 'QUEST_HISTORY', aggregateType: 'ORDER_ITEM', aggregateId: item.id,
        aggregateVersion: updated.state_version * 1000 + bucket, surfaceKey: 'QUEST_HISTORY', context,
      });
    }
    return updated;
  });
}

async function transitionRunning(job, context, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const updatedJob = await updateOwnedJob(client, job, 'RUNNING');
    const item = (await client.query(`
      UPDATE order_items SET state = 'RUNNING', state_version = state_version + 1,
        started_at = COALESCE(started_at, clock_timestamp()), updated_at = clock_timestamp()
      WHERE id = $1 AND state = 'LEASED' RETURNING *
    `, [job.order_item_id])).rows[0];
    if (!item) throw new QuestshopError('ITEM_STATE_CONFLICT', 'Order item was not leased');
    await recordTransition(client, {
      aggregateType: 'ORDER_ITEM', aggregateId: item.id,
      fromState: 'LEASED', toState: 'RUNNING', stateVersion: item.state_version, context,
    });
    await enqueueProjection(client, { projectionType: 'RUNNER_SUMMARY', aggregateType: 'RUNNER_JOB',
      aggregateId: updatedJob.id, aggregateVersion: updatedJob.state_version,
      surfaceKey: 'LOG_QUEST_OPERATIONS', context });
    return updatedJob;
  });
}

async function transitionToSettling(job, context, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    let updatedJob = await updateOwnedJob(client, job, 'VERIFYING');
    const verifying = (await client.query(`
      UPDATE order_items SET state = 'VERIFYING', state_version = state_version + 1,
        updated_at = clock_timestamp() WHERE id = $1 AND state = 'RUNNING' RETURNING *
    `, [job.order_item_id])).rows[0];
    await recordTransition(client, {
      aggregateType: 'ORDER_ITEM', aggregateId: verifying.id,
      fromState: 'RUNNING', toState: 'VERIFYING', stateVersion: verifying.state_version, context,
    });
    updatedJob = await updateOwnedJob(client, updatedJob, 'SETTLING');
    const settling = (await client.query(`
      UPDATE order_items SET state = 'SETTLING', state_version = state_version + 1,
        updated_at = clock_timestamp() WHERE id = $1 AND state = 'VERIFYING' RETURNING *
    `, [job.order_item_id])).rows[0];
    await recordTransition(client, {
      aggregateType: 'ORDER_ITEM', aggregateId: settling.id,
      fromState: 'VERIFYING', toState: 'SETTLING', stateVersion: settling.state_version, context,
    });
    return updatedJob;
  });
}

async function completeJob(job, context, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const updated = await updateOwnedJob(client, job, 'COMPLETED', { releaseLease: true });
    await enqueueProjection(client, { projectionType: 'RUNNER_SUMMARY', aggregateType: 'RUNNER_JOB',
      aggregateId: updated.id, aggregateVersion: updated.state_version,
      surfaceKey: 'LOG_QUEST_OPERATIONS', context });
    return updated;
  });
}

async function failJob(job, context, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const current = (await client.query('SELECT * FROM runner_jobs WHERE id = $1 FOR UPDATE', [job.id])).rows[0];
    if (!current || ['COMPLETED', 'FAILED'].includes(current.state)) return current;
    const updated = await updateOwnedJob(client, current, 'FAILED', { releaseLease: true });
    await enqueueProjection(client, { projectionType: 'RUNNER_SUMMARY', aggregateType: 'RUNNER_JOB',
      aggregateId: updated.id, aggregateVersion: updated.state_version,
      surfaceKey: 'LOG_QUEST_OPERATIONS', context });
    return updated;
  });
}

export async function materializeNextOrderItem({ orderId }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const count = Number((await client.query(`
      SELECT count(*)::integer AS count FROM runner_jobs
      WHERE state IN ('QUEUED','LEASED','RUNNING','WAITING_RATE_LIMIT','WAITING_RETRY')
    `)).rows[0].count);
    if (count >= 500) return null;
    const item = (await client.query(`
      SELECT i.*, o.discord_user_id, o.account_id, o.trace_id
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE i.order_id = $1 AND i.state = 'RESERVED'
      ORDER BY i.sequence_number FOR UPDATE OF i SKIP LOCKED LIMIT 1
    `, [orderId])).rows[0];
    if (!item) return null;
    const queued = (await client.query(`
      UPDATE order_items SET state = 'QUEUED', state_version = state_version + 1,
        updated_at = clock_timestamp() WHERE id = $1 AND state_version = $2 RETURNING *
    `, [item.id, item.state_version])).rows[0];
    await client.query(`
      INSERT INTO runner_jobs(
        id, order_item_id, discord_user_id, account_id, state, deadline_at,
        engine_version, executor_version, contract_version,
        runner_state_schema_version, trace_id
      ) VALUES ($1,$2,$3,$4,'QUEUED',$5,$6,$7,$8,$9,$10)
    `, [
      uuidv7(), item.id, item.discord_user_id, item.account_id, item.deadline_at,
      item.engine_version, item.executor_version, item.contract_version,
      item.runner_state_schema_version, item.trace_id,
    ]);
    await recordTransition(client, {
      aggregateType: 'ORDER_ITEM', aggregateId: item.id,
      fromState: 'RESERVED', toState: 'QUEUED', stateVersion: queued.state_version, context,
    });
    return queued;
  });
}

function runnerContext(job, env) {
  return createContext({
    traceId: job.trace_id,
    actorType: 'SYSTEM', actorId: String(job.lease_owner),
    guildId: env.DISCORD_GUILD_ID, idempotencyKey: `runner:${job.id}:${job.attempt_count}`,
  });
}

async function loadRunnerData(job, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => (
    (await client.query(`
      SELECT o.*, i.quest_id, i.state AS item_state, i.deadline_at,
        q.*, c.key_version, c.nonce, c.ciphertext, c.auth_tag
      FROM runner_jobs j
      JOIN order_items i ON i.id = j.order_item_id
      JOIN orders o ON o.id = i.order_id
      JOIN quests q ON q.quest_id = i.quest_id
      JOIN order_credentials c ON c.order_id = o.id
      WHERE j.id = $1
    `, [job.id])).rows[0]
  ));
}

async function prepareRunnerExecution(job, env, signal, options) {
  if (!isRunnerVersionCompatible(job)) {
    throw new QuestshopError('RUNNER_VERSION_INCOMPATIBLE', 'Worker รุ่นนี้ไม่รองรับ Job version ที่ถูก Pin');
  }
  const data = await loadRunnerData(job, options);
  const token = decryptSecret({ keyVersion: data.key_version, nonce: data.nonce,
    ciphertext: data.ciphertext, authTag: data.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
  `order:${data.id}:${env.DISCORD_GUILD_ID}`);
  const api = createQuestApiClient({ token, profile: profileFromEnv(env) });
  const [profile, quests] = await Promise.all([api.fetchCurrentUser(signal), api.fetchQuests(signal)]);
  if (String(profile.id) !== data.account_id) throw new QuestshopError('RUNNER_ACCOUNT_MISMATCH', 'Token account changed');
  const quest = quests.find((item) => item.id === data.quest_id);
  if (!quest) throw new QuestshopError('QUEST_MISSING', 'Quest disappeared from account');
  return { data, api, quest };
}

function runnerOwnership(job) {
  return { jobId: job.id, leaseOwner: job.lease_owner, fencingToken: job.fencing_token };
}

async function releaseBeforeExecution({ job, data, quest, env, context, options }) {
  if (quest.completed) {
    await releaseReservation({ orderItemId: job.order_item_id, terminalState: 'EXTERNAL_COMPLETED_RELEASED',
      reason: 'EXTERNAL_COMPLETED_BEFORE_START', runnerOwnership: runnerOwnership(job) }, context, options);
    await failJob(job, context, options);
    await materializeNextOrderItem({ orderId: data.id }, context, options);
    return { outcome: 'EXTERNAL_COMPLETED_RELEASED' };
  }
  const admission = await withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, (client) => (
    evaluateExpiryAdmission(client, { quest: { ...data, progress_actual: quest.progress },
      runnerConcurrency: env.RUNNER_CONCURRENCY })
  ));
  if (admission.eligible) return null;
  await releaseReservation({ orderItemId: job.order_item_id, terminalState: 'EXPIRED_RELEASED',
    reason: admission.reason, runnerOwnership: runnerOwnership(job) }, context, options);
  await failJob(job, context, options);
  await materializeNextOrderItem({ orderId: data.id }, context, options);
  return { outcome: 'EXPIRED_RELEASED' };
}

async function executeAndSettleRunner({ state, attempt, data, api, quest: initialQuest, signal, context, options }) {
  const executor = selectQuestExecutor(initialQuest);
  if (!executor.supportsAutomaticProgress || executor.id !== data.executor_id) {
    throw new QuestshopError('EXECUTOR_INCOMPATIBLE', 'Quest executor contract changed');
  }
  state.runningJob = await transitionRunning(state.runningJob, context, options);
  let quest = initialQuest;
  const fetchFreshQuest = async () => {
    const fresh = (await api.fetchQuests(signal)).find((item) => item.id === quest.id);
    if (!fresh) throw new QuestshopError('QUEST_MISSING', 'Quest disappeared during execution');
    return fresh;
  };
  const mutate = async (kind, payload, perform) => {
    const fresh = await executeMutation({ job: state.runningJob, attempt, kind, payload,
      baseline: quest.progressSecs, perform, fetchFresh: fetchFreshQuest, context, options });
    quest = fresh;
    return fresh;
  };
  if (!quest.enrolled) {
    quest = await mutate('ENROLL', { location: 11 }, () => api.enroll(quest.id, signal));
    if (!quest.enrolled) throw new QuestshopError('ENROLL_NOT_VERIFIED', 'Discord did not confirm enrollment');
  }
  const execution = await executeQuestExecutor(executor, {
    quest, api, signal, mutate, fetchFreshQuest,
    onServerProgress: (fresh) => updateItemProgress(state.runningJob, fresh, context, options),
    sleep: (ms, abortSignal) => delay(ms, undefined, { signal: abortSignal, ref: false }),
    now: () => Date.now(),
  });
  await updateItemProgress(state.runningJob, execution.executionResult, context, options);
  const verified = await fetchFreshQuest();
  if (!execution.verified || !verified.completed || !verified.completedAt) {
    throw new QuestshopError('COMPLETION_NOT_VERIFIED', 'Discord did not confirm completed_at');
  }
  state.runningJob = await transitionToSettling(state.runningJob, context, options);
  await captureReservation({ orderItemId: state.runningJob.order_item_id, claimUrl: verified.url,
    runnerOwnership: runnerOwnership(state.runningJob) }, context, options);
  await completeJob(state.runningJob, context, options);
  await materializeNextOrderItem({ orderId: data.id }, context, options);
  return { outcome: 'READY_TO_CLAIM', quest: verified };
}

async function moveRunnerToManualReview(job, context, options, error, contractFailure) {
  await withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const current = (await client.query('SELECT * FROM runner_jobs WHERE id = $1 FOR UPDATE', [job.id])).rows[0];
    if (!current || ['COMPLETED', 'FAILED', 'MANUAL_REVIEW'].includes(current.state)) return;
    await client.query(`UPDATE runner_jobs SET state = 'MANUAL_REVIEW', state_version = state_version + 1,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE id = $1`, [job.id]);
    await client.query(`UPDATE order_items SET state = 'MANUAL_REVIEW', state_version = state_version + 1,
      updated_at = clock_timestamp() WHERE id = $1`, [job.order_item_id]);
    await openReview(client, { subjectType: 'ORDER_ITEM', subjectId: job.order_item_id,
      reason: error.code, financial: true, ownerOnly: false, context });
    if (!contractFailure) return;
    await client.query(`UPDATE quests SET sale_state='PAUSED',sale_version=sale_version+1,
      updated_at=clock_timestamp() WHERE quest_id=(SELECT quest_id FROM order_items WHERE id=$1)
      AND sale_state='OPEN'`, [job.order_item_id]);
    await client.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
      VALUES(gen_random_uuid(),'QUEST_CONTRACT_FAILURE',$1,'OPEN','CRITICAL',$2,$3)`,
    [job.order_item_id, { errorCode: error.code }, context.traceId]);
  });
}

function needsManualReview(error) {
  const ambiguous = error.code === 'MUTATION_AMBIGUOUS' || error.category === 'AMBIGUOUS';
  const contractFailure = error.name === 'QuestCompatibilityError'
    || ['EXECUTOR_INCOMPATIBLE', 'QUEST_PAYLOAD_NOT_ARRAY', 'QUEST_ENTRY_INVALID'].includes(error.code);
  return { manualReview: ambiguous || contractFailure, contractFailure };
}

async function resolveRunnerFailure({ state, job, context, options, error }) {
  if (error instanceof FencingLostError) throw error;
  if (error?.name === 'AbortError' && error.code !== 'MUTATION_AMBIGUOUS') {
    await checkpointRetryJob(state.runningJob, context, options);
    return { outcome: 'CHECKPOINTED_FOR_RESTART', error };
  }
  if (isRunnerTransient(error) && Number(state.runningJob.attempt_count) < 3) {
    await checkpointRetryJob(state.runningJob, context, options, 'TRANSIENT_RETRY');
    return { outcome: 'WAITING_RETRY', error };
  }
  const review = needsManualReview(error);
  if (review.manualReview) {
    await moveRunnerToManualReview(job, context, options, error, review.contractFailure);
    return { outcome: 'MANUAL_REVIEW', error };
  }
  await releaseReservation({ orderItemId: job.order_item_id, terminalState: 'FAILED_RELEASED',
    reason: error.code ?? error.name, runnerOwnership: runnerOwnership(state.runningJob) }, context, options);
  await failJob(state.runningJob, context, options);
  if (state.order?.id) await materializeNextOrderItem({ orderId: state.order.id }, context, options);
  return { outcome: 'FAILED_RELEASED', error };
}

export async function processRunnerJob(job, { env, signal, options = {} }) {
  const context = runnerContext(job, env);
  const attempt = await createAttempt(job, context, options);
  const state = { runningJob: job, order: null };
  try {
    const prepared = await prepareRunnerExecution(job, env, signal, options);
    state.order = prepared.data;
    const released = await releaseBeforeExecution({ job, ...prepared, env, context, options });
    if (released) return released;
    return executeAndSettleRunner({ state, attempt, ...prepared, signal, context, options });
  } catch (error) {
    return resolveRunnerFailure({ state, job, context, options, error });
  }
}

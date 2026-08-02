import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { ENGINE_VERSION, EXECUTOR_VERSION, QUEST_CONTRACT_VERSION } from '../../config/versions.js';
import { resolvePrice } from '../pricing/resolver.js';
import { enqueueProjection } from '../outbox/service.js';
import { recordTransition } from '../shared/transition.js';
import { evaluateExpiryAdmission } from './expiry.js';

async function transitionAnalysis(client, quest, next, context) {
  if (quest.analysis_state === next) return quest;
  const updated = (await client.query(`
    UPDATE quests SET analysis_state = $2, analysis_version = analysis_version + 1,
      updated_at = transaction_timestamp(),
      first_analysis_at = COALESCE(first_analysis_at, transaction_timestamp())
    WHERE quest_id = $1 AND analysis_version = $3 RETURNING *
  `, [quest.quest_id, next, quest.analysis_version])).rows[0];
  await recordTransition(client, {
    aggregateType: 'QUEST_ANALYSIS', aggregateId: quest.quest_id,
    fromState: quest.analysis_state, toState: next, stateVersion: updated.analysis_version, context,
  });
  return updated;
}

async function reconcileSale(client, quest, normalized, context, runnerConcurrency) {
  const price = await resolvePrice(client, { questId: quest.quest_id, taskType: quest.task_type });
  const expiry = await evaluateExpiryAdmission(client, { quest, runnerConcurrency });
  const canSell = quest.analysis_state === 'SUPPORTED'
    && normalized.coreComplete && Boolean(price) && expiry.eligible;
  let next = quest.sale_state;
  const expired = (await client.query(
    'SELECT $1::timestamptz <= clock_timestamp() AS value',
    [quest.expires_at],
  )).rows[0].value;
  if (expired) next = 'EXPIRED';
  else if (canSell && ['CLOSED', 'PAUSED'].includes(quest.sale_state)) next = 'OPEN';
  else if (!canSell && quest.sale_state === 'OPEN') next = 'PAUSED';
  if (next === quest.sale_state) return { quest, price, expiry };
  const updated = (await client.query(`
    UPDATE quests SET sale_state = $2, sale_version = sale_version + 1,
      updated_at = transaction_timestamp()
    WHERE quest_id = $1 AND sale_version = $3 RETURNING *
  `, [quest.quest_id, next, quest.sale_version])).rows[0];
  await recordTransition(client, {
    aggregateType: 'QUEST_SALE', aggregateId: quest.quest_id,
    fromState: quest.sale_state, toState: next, stateVersion: updated.sale_version,
    reasonCode: expiry.reason, context,
  });
  return { quest: updated, price, expiry };
}

function requiresRetest(previousQuest, normalized) {
  if (!previousQuest) return false;
  return previousQuest.executor_id !== normalized.executorId
    || previousQuest.contract_version !== QUEST_CONTRACT_VERSION
    || Number(previousQuest.task_target) !== Number(normalized.secondsNeeded);
}

async function upsertQuest(client, normalized) {
  return (await client.query(`
      INSERT INTO quests(
        quest_id, analysis_state, name, task_type, task_target, url, artwork_url,
        orbs, starts_at, expires_at, executor_id, engine_version,
        executor_version, contract_version
      ) VALUES ($1,'DETECTED',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (quest_id) DO UPDATE SET
        name = EXCLUDED.name, task_type = EXCLUDED.task_type,
        task_target = EXCLUDED.task_target, url = EXCLUDED.url,
        artwork_url = EXCLUDED.artwork_url, orbs = EXCLUDED.orbs,
        starts_at = EXCLUDED.starts_at, expires_at = EXCLUDED.expires_at,
        executor_id = EXCLUDED.executor_id, engine_version = EXCLUDED.engine_version,
        executor_version = EXCLUDED.executor_version, contract_version = EXCLUDED.contract_version,
        updated_at = transaction_timestamp()
      RETURNING *
    `, [
      normalized.id, normalized.name, normalized.eventName, normalized.secondsNeeded,
      normalized.url, normalized.artworkUrl, normalized.orbs, normalized.startsAt,
      normalized.expiresAt, normalized.executorId, ENGINE_VERSION, EXECUTOR_VERSION,
      QUEST_CONTRACT_VERSION,
    ])).rows[0];
}

async function recordMetadataRevision(client, quest, normalized, source, redactedRaw, context) {
  const revision = Number(quest.current_metadata_revision) + 1;
    await client.query(`
      INSERT INTO quest_metadata_revisions(
        id, quest_id, revision, normalized, redacted_raw, source,
        core_complete, schema_issues, trace_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      uuidv7(), quest.quest_id, revision, normalized, redactedRaw ?? normalized,
      source, normalized.coreComplete, normalized.compatibilityIssues, context.traceId,
    ]);
  const updatedQuest = (await client.query(`
      UPDATE quests SET current_metadata_revision = $2 WHERE quest_id = $1 RETURNING *
    `, [quest.quest_id, revision])).rows[0];
  return { quest: updatedQuest, revision };
}

async function analyzeQuest(client, quest, normalized, context) {
  if (quest.analysis_state === 'DETECTED' || quest.analysis_state === 'METADATA_RETRY') {
    if (!normalized.coreComplete) return transitionAnalysis(client, quest, 'METADATA_RETRY', context);
    const analyzed = await transitionAnalysis(client, quest, 'ANALYZED', context);
    return transitionAnalysis(client, analyzed, normalized.autoSupported ? 'SUPPORTED' : 'UNSUPPORTED', context);
  }
  if (quest.analysis_state === 'UNSUPPORTED' && normalized.coreComplete && normalized.autoSupported) {
    return transitionAnalysis(client, quest, 'SUPPORTED', context);
  }
  return quest;
}

async function pauseForRetest(client, quest, context) {
  if (quest.sale_state !== 'OPEN') return quest;
  const paused = (await client.query(`UPDATE quests SET sale_state='PAUSED',sale_version=sale_version+1,
    updated_at=transaction_timestamp() WHERE quest_id=$1 AND sale_state='OPEN'
      AND sale_version=$2 RETURNING *`, [quest.quest_id, quest.sale_version])).rows[0];
  await recordTransition(client, { aggregateType: 'QUEST_SALE', aggregateId: quest.quest_id,
    fromState: 'OPEN', toState: 'PAUSED', stateVersion: paused.sale_version,
    reasonCode: 'RETEST_REQUIRED', context });
  return paused;
}

async function queueTestIfSupported(client, quest, requiresTest, context) {
  if (quest.analysis_state !== 'SUPPORTED') return;
  const testState = requiresTest ? 'RETEST_REQUIRED' : 'TEST_QUEUED';
  await client.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,executor_version,
        contract_version,trace_id)
        SELECT $1,$2,$7,$3,$4,$5,$6
        WHERE NOT EXISTS(SELECT 1 FROM quest_test_runs WHERE quest_id=$2 AND engine_version=$3
          AND executor_version=$4 AND contract_version=$5 AND state IN ('TEST_QUEUED','TESTING','TEST_PASSED','RETEST_REQUIRED')
          AND ($7<>'RETEST_REQUIRED' OR state<>'TEST_PASSED'))`,
      [uuidv7(), quest.quest_id, ENGINE_VERSION, EXECUTOR_VERSION, QUEST_CONTRACT_VERSION,
        context.traceId, testState]);
}

async function queueDiscoveryProjections(client, quest, revision, context) {
  const announcementNotBefore = quest.announcement_state === 'ANNOUNCED'
    ? (await client.query("SELECT clock_timestamp()+interval '30 seconds' AS value")).rows[0].value
    : null;
  await enqueueProjection(client, {
      projectionType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: quest.quest_id,
      aggregateVersion: revision, surfaceKey: 'QUEST_NEW', notBefore: announcementNotBefore, context,
  });
  await enqueueProjection(client, {
      projectionType: 'QUEST_OPERATION', aggregateType: 'QUEST', aggregateId: quest.quest_id,
      aggregateVersion: revision, surfaceKey: 'LOG_QUEST_OPERATIONS', context,
  });
}

export async function ingestDiscovery({
  normalized,
  source,
  redactedRaw = null,
  runnerConcurrency = 3,
}, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const previousQuest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE',
      [normalized.id])).rows[0] ?? null;
    const needsRetest = requiresRetest(previousQuest, normalized);
    let quest = await upsertQuest(client, normalized);
    const metadata = await recordMetadataRevision(client, quest, normalized, source, redactedRaw, context);
    quest = await analyzeQuest(client, metadata.quest, normalized, context);
    const sale = await reconcileSale(client, quest, normalized, context, runnerConcurrency);
    quest = needsRetest ? await pauseForRetest(client, sale.quest, context) : sale.quest;
    await queueTestIfSupported(client, quest, needsRetest, context);
    await queueDiscoveryProjections(client, quest, metadata.revision, context);
    return { quest, price: sale.price, expiry: sale.expiry, revision: metadata.revision };
  });
}

export async function resolveSaleEligibility({ questId, progressActual = 0, runnerConcurrency = 3 }, _context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const quest = (await client.query('SELECT * FROM quests WHERE quest_id = $1', [questId])).rows[0];
    if (!quest) return { eligible: false, reason: 'QUEST_NOT_FOUND' };
    if (quest.sale_state !== 'OPEN' || quest.analysis_state !== 'SUPPORTED') {
      return { eligible: false, reason: 'QUEST_NOT_FOR_SALE', quest };
    }
    const price = await resolvePrice(client, { questId, taskType: quest.task_type });
    if (!price) return { eligible: false, reason: 'PRICE_MISSING', quest };
    const expiry = await evaluateExpiryAdmission(client, {
      quest: { ...quest, progress_actual: progressActual }, runnerConcurrency,
    });
    return { eligible: expiry.eligible, reason: expiry.reason, quest, price, expiry };
  });
}

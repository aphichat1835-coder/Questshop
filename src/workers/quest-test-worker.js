import { v7 as uuidv7 } from 'uuid';
import { setTimeout as delay } from 'node:timers/promises';
import { decryptSecret } from '../adapters/crypto/keyring.js';
import { createQuestApiClient, profileFromEnv } from '../quest-engine/api/client.js';
import { selectQuestExecutor } from '../quest-engine/executors/registry.js';
import { executeQuestExecutor } from '../quest-engine/executors/contract.js';
import { createContext } from '../shared/correlation.js';
import { FencingLostError } from '../shared/errors.js';
import { ingestDiscovery } from '../domain/catalog/service.js';
import { withTransaction } from '../db/transaction.js';
import { RUNNER_VERSION_COMPATIBILITY } from '../config/versions.js';
import { recordTransition } from '../domain/shared/transition.js';

export async function acquireTestRun({ holder, pool }) {
  const engineVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.engine);
  const executorVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.executor);
  const contractVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.contract);
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const monitor = (await client.query(`SELECT m.*,c.key_version,c.nonce,c.ciphertext,c.auth_tag
      FROM monitor_accounts m JOIN monitor_credentials c ON c.monitor_id=m.id
      WHERE m.state='ACTIVE' AND 'TEST'=ANY(m.capabilities)
      ORDER BY m.last_used_at NULLS FIRST,m.priority DESC FOR UPDATE OF m SKIP LOCKED LIMIT 1`)).rows[0];
    if (!monitor) return null;
    const run = (await client.query(`WITH candidate AS (
      SELECT tr.id FROM quest_test_runs tr JOIN quests q ON q.quest_id=tr.quest_id
      WHERE tr.state='TEST_QUEUED'
        AND EXISTS (SELECT 1 FROM unnest($3::text[],$4::text[],$5::text[])
          AS supported(engine,executor,contract)
          WHERE supported.engine=tr.engine_version AND supported.executor=tr.executor_version
            AND supported.contract=tr.contract_version)
      ORDER BY tr.created_at FOR UPDATE OF tr SKIP LOCKED LIMIT 1
    ) UPDATE quest_test_runs tr SET state='TESTING',state_version=state_version+1,
      monitor_id=$1,lease_owner=$2,lease_expires_at=clock_timestamp()+interval '120 seconds',
      fencing_token=fencing_token+1,started_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM candidate,quests q WHERE tr.id=candidate.id AND q.quest_id=tr.quest_id
      RETURNING tr.*,q.task_type,q.executor_id,q.contract_version AS current_contract`,
    [monitor.id, holder, engineVersions, executorVersions, contractVersions])).rows[0];
    if (!run) return null;
    await client.query('UPDATE monitor_accounts SET last_used_at=clock_timestamp() WHERE id=$1', [monitor.id]);
    await recordTransition(client, { aggregateType: 'QUEST_TEST', aggregateId: run.id,
      fromState: 'TEST_QUEUED', toState: 'TESTING', stateVersion: run.state_version,
      reasonCode: 'TEST_LEASED', context: { traceId: run.trace_id, causationId: null,
        actorType: 'SYSTEM', actorId: holder } });
    return { run, monitor };
  });
}

export async function renewQuestTestLease(run, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const updated = (await client.query(`UPDATE quest_test_runs
      SET lease_expires_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
      WHERE id=$1 AND state='TESTING' AND lease_owner=$2 AND fencing_token=$3
        AND lease_expires_at>clock_timestamp() RETURNING *`,
    [run.id, run.lease_owner, run.fencing_token])).rows[0];
    if (!updated) throw new FencingLostError(`quest-test:${run.id}`);
    return updated;
  });
}

async function updateOwned(pool, run, sql, params, nextState, reasonCode, context) {
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const row = (await client.query(`${sql} AND id=$1 AND state='TESTING' AND lease_owner=$2
      AND fencing_token=$3 AND lease_expires_at>clock_timestamp() RETURNING *`,
    [run.id, run.lease_owner, run.fencing_token, ...params])).rows[0];
    if (!row) throw new FencingLostError(`quest-test:${run.id}`);
    await recordTransition(client, { aggregateType: 'QUEST_TEST', aggregateId: run.id,
      fromState: 'TESTING', toState: nextState, stateVersion: row.state_version,
      reasonCode, context });
    return row;
  });
}

async function createTestMutation(pool, run, context, { kind, payload, baseline }) {
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const owned = (await client.query(`SELECT 1 FROM quest_test_runs WHERE id=$1 AND state='TESTING'
      AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [run.id, run.lease_owner, run.fencing_token])).rowCount;
    if (!owned) throw new FencingLostError(`quest-test:${run.id}`);
    const sequence = Number((await client.query(`SELECT COALESCE(max(sequence_number),0)+1 AS value
      FROM quest_test_mutations WHERE test_run_id=$1`, [run.id])).rows[0].value);
    return (await client.query(`INSERT INTO quest_test_mutations(id,test_run_id,sequence_number,
      mutation_kind,status,baseline_progress,target_payload,trace_id)
      VALUES($1,$2,$3,$4,'PREPARED',$5,$6,$7) RETURNING *`,
    [uuidv7(), run.id, sequence, kind, baseline, payload, context.traceId])).rows[0];
  });
}

async function setMutationState(pool, run, mutation, state, evidence = {}) {
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const owned = (await client.query(`SELECT 1 FROM quest_test_runs WHERE id=$1 AND state='TESTING'
      AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>clock_timestamp()`,
    [run.id, run.lease_owner, run.fencing_token])).rowCount;
    if (!owned) throw new FencingLostError(`quest-test:${run.id}`);
    return (await client.query(`UPDATE quest_test_mutations SET status=$2,evidence=evidence||$3::jsonb,
      attempted_at=CASE WHEN $2='IN_FLIGHT' THEN clock_timestamp() ELSE attempted_at END,
      verified_at=CASE WHEN $2='VERIFIED' THEN clock_timestamp() ELSE verified_at END
      WHERE id=$1 RETURNING *`, [mutation.id, state, evidence])).rows[0];
  });
}

export async function testQuest({ env, pool, signal, holder, runnerConcurrency = env.RUNNER_CONCURRENCY }) {
  const acquired = await acquireTestRun({ holder, pool });
  if (!acquired) return false;
  const { run, monitor } = acquired;
  const context = createContext({ traceId: run.trace_id, actorType: 'SYSTEM', actorId: holder,
    guildId: env.DISCORD_GUILD_ID, idempotencyKey: `quest-test:${run.id}` });
  const leaseAbort = new AbortController();
  const testSignal = AbortSignal.any([signal, leaseAbort.signal]);
  const heartbeat = (async () => {
    while (!testSignal.aborted) {
      await delay(30_000, undefined, { signal: testSignal, ref: false });
      if (!testSignal.aborted) await renewQuestTestLease(run, { pool });
    }
  })().catch((error) => { if (!testSignal.aborted) leaseAbort.abort(error); });
  try {
    const token = decryptSecret({ keyVersion: monitor.key_version, nonce: monitor.nonce,
      ciphertext: monitor.ciphertext, authTag: monitor.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
    `monitor:${monitor.id}:${env.DISCORD_GUILD_ID}`);
    const api = createQuestApiClient({ token, profile: profileFromEnv(env) });
    const quest = (await api.fetchQuests(testSignal)).find((candidate) => candidate.id === run.quest_id);
    const executor = quest && selectQuestExecutor(quest);
    if (!quest || !executor?.supportsAutomaticProgress || executor.id !== run.executor_id) {
      throw Object.assign(new Error('Quest contract unsupported on monitor'), { code: 'TEST_CONTRACT_UNSUPPORTED' });
    }
    if (quest.completed) throw Object.assign(new Error('Monitor already completed this Quest'), {
      code: 'MONITOR_QUEST_ALREADY_COMPLETED', accountSpecific: true,
    });
    const freshQuest = async () => {
      const fresh = (await api.fetchQuests(testSignal)).find((candidate) => candidate.id === run.quest_id);
      if (!fresh) throw Object.assign(new Error('Quest disappeared during test'), { code: 'TEST_QUEST_MISSING' });
      return fresh;
    };
    let current = quest;
    const mutate = async (kind, payload, perform) => {
      const baseline = current.progressSecs;
      let mutation = await createTestMutation(pool, run, context, { kind, payload, baseline });
      mutation = await setMutationState(pool, run, mutation, 'IN_FLIGHT');
      let mutationError = null;
      try {
        await perform();
        mutation = await setMutationState(pool, run, mutation, 'ACCEPTED');
      } catch (cause) {
        mutationError = cause;
        mutation = await setMutationState(pool, run, mutation, 'UNCERTAIN', { code: cause.code ?? cause.name });
      }
      let fresh = await freshQuest();
      const applied = () => kind === 'ENROLL' ? fresh.enrolled
        : fresh.completed || Number(fresh.progressSecs) > Number(baseline);
      if (!applied()) {
        if (mutationError && mutationError.fatalAuth) throw mutationError;
        await setMutationState(pool, run, mutation, 'FAILED', { freshProgress: fresh.progressSecs });
        await delay(Math.floor(Math.random() * 1000), undefined, { signal: testSignal, ref: false });
        mutation = await createTestMutation(pool, run, context,
          { kind, payload: { ...payload, controlledRetry: true }, baseline });
        mutation = await setMutationState(pool, run, mutation, 'IN_FLIGHT');
        try {
          await perform();
          mutation = await setMutationState(pool, run, mutation, 'ACCEPTED');
        } catch (cause) {
          mutation = await setMutationState(pool, run, mutation, 'UNCERTAIN', { code: cause.code ?? cause.name });
        }
        fresh = await freshQuest();
      }
      if (!applied()) {
        throw Object.assign(new Error('Test mutation not verified'), { code: 'TEST_MUTATION_NOT_VERIFIED' });
      }
      await setMutationState(pool, run, mutation, 'VERIFIED', { freshProgress: fresh.progressSecs });
      current = fresh;
      return fresh;
    };
    if (!current.enrolled) current = await mutate('ENROLL', {}, () => api.enroll(current.id, testSignal));
    const execution = await executeQuestExecutor(executor, { quest: current, api, signal: testSignal, mutate,
      fetchFreshQuest: freshQuest, onServerProgress: async () => {},
      sleep: (ms, abortSignal) => delay(ms, undefined, { signal: abortSignal, ref: false }),
      now: () => Date.now() });
    current = await freshQuest();
    if (!execution.verified || !current.completed || !current.completedAt) {
      throw Object.assign(new Error('Background test completion not verified'), { code: 'TEST_COMPLETION_NOT_VERIFIED' });
    }
    await updateOwned(pool, run, `UPDATE quest_test_runs SET state='TEST_PASSED',
      state_version=state_version+1,evidence=$4,completed_at=clock_timestamp(),
      lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE true`,
    [{ accountVisible: true, executorId: executor.id, completedAt: current.completedAt,
      traceId: context.traceId }], 'TEST_PASSED', 'TEST_COMPLETION_VERIFIED', context);
    await pool.query(`UPDATE monitor_accounts SET consecutive_failures=0,updated_at=clock_timestamp()
      WHERE id=$1`, [monitor.id]);
    await ingestDiscovery({ normalized: current, source: 'MONITOR',
      runnerConcurrency }, context, { pool });
  } catch (error) {
    if (error.code === 'FENCING_LOST') throw error;
    const nextTestState = error.fatalAuth ? 'MANUAL_REVIEW' : 'TEST_FAILED';
    await updateOwned(pool, run, `UPDATE quest_test_runs SET state=$4,state_version=state_version+1,
      error_class=$5,evidence=$6,completed_at=clock_timestamp(),lease_owner=NULL,
      lease_expires_at=NULL,updated_at=clock_timestamp() WHERE true`, [
      nextTestState, error.code ?? error.name,
      { accountSpecific: Boolean(error.fatalAuth || error.accountSpecific), traceId: context.traceId },
    ], nextTestState, error.code ?? error.name, context);
    const monitorFailure = error.fatalAuth || error.retryable || error.category === 'NETWORK';
    if (monitorFailure) {
      const failures = Number(monitor.consecutive_failures) + 1;
      const monitorState = error.fatalAuth || failures >= 5 ? 'QUARANTINED'
        : failures >= 3 ? 'COOLDOWN' : 'ACTIVE';
      await pool.query(`UPDATE monitor_accounts SET state=$2,consecutive_failures=$3,
        cooldown_until=CASE WHEN $2='COOLDOWN' THEN clock_timestamp()+interval '15 minutes'
          ELSE cooldown_until END,updated_at=clock_timestamp() WHERE id=$1`,
      [monitor.id, monitorState, failures]);
      if (monitorState === 'QUARANTINED') await pool.query(`INSERT INTO incidents(id,incident_code,
        scope,state,severity,evidence,trace_id) VALUES(gen_random_uuid(),'MONITOR_QUARANTINED',$1,
        'OPEN','ERROR',$2,$3) ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED'
        DO UPDATE SET evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
      [monitor.id, { errorCode: error.code ?? error.name }, context.traceId]);
    }
    if (error.accountSpecific) {
      const alternate = Number((await pool.query(`SELECT count(*)::integer AS count FROM monitor_accounts
        WHERE id<>$1 AND state='ACTIVE' AND 'TEST'=ANY(capabilities)`, [monitor.id])).rows[0].count);
      if (alternate > 0) await pool.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,
        executor_version,contract_version,trace_id) VALUES(gen_random_uuid(),$1,'TEST_QUEUED',$2,$3,$4,$5)`,
      [run.quest_id, run.engine_version, run.executor_version, run.contract_version, run.trace_id]);
    }
    if (!error.accountSpecific && !error.fatalAuth
      && ['TEST_CONTRACT_UNSUPPORTED', 'TEST_MUTATION_NOT_VERIFIED',
        'TEST_COMPLETION_NOT_VERIFIED'].includes(error.code)) {
      await withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (client) => {
        const quest = (await client.query(`UPDATE quests SET sale_state='PAUSED',
          sale_version=sale_version+1,updated_at=clock_timestamp()
          WHERE quest_id=$1 AND sale_state='OPEN' RETURNING *`, [run.quest_id])).rows[0];
        if (quest) await recordTransition(client, { aggregateType: 'QUEST_SALE',
          aggregateId: run.quest_id, fromState: 'OPEN', toState: 'PAUSED',
          stateVersion: quest.sale_version, reasonCode: error.code, context });
      });
    }
  } finally {
    leaseAbort.abort('quest test finished');
    await heartbeat;
  }
  return true;
}

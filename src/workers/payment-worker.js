import { setTimeout as delay } from 'node:timers/promises';
import { decryptSecret } from '../adapters/crypto/keyring.js';
import { redeemVoucher } from '../adapters/truemoney/voucher.js';
import { createContext } from '../shared/correlation.js';
import {
  acquirePaymentJob, createPaymentAttempt, markPaymentPossiblySent, recordProviderResult, renewPaymentLease,
} from '../domain/payments/service.js';
import { creditRedeemedTopup } from '../domain/wallet/service.js';
import { getRuntimePool } from '../db/pools.js';

async function creditPendingRedemption({ holder, env, pool }) {
  const topup = (await pool.query(`SELECT * FROM topups WHERE status = 'REDEEMED'
    ORDER BY redeemed_at LIMIT 1`)).rows[0];
  if (!topup) return false;
  const context = createContext({ traceId: topup.trace_id, actorType: 'SYSTEM', actorId: holder,
    guildId: env.DISCORD_GUILD_ID, idempotencyKey: `credit-recovery:${topup.id}` });
  await creditRedeemedTopup({ topupId: topup.id }, context, { pool });
  return true;
}

function startLeaseHeartbeat(topup, pool, parentSignal) {
  const leaseAbort = new AbortController();
  const signal = AbortSignal.any([parentSignal, leaseAbort.signal]);
  const done = (async () => {
    while (!signal.aborted) {
      await delay(10_000, undefined, { signal, ref: false });
      if (!signal.aborted) await renewPaymentLease(topup, 30, { pool });
    }
  })().catch((error) => { leaseAbort.abort(error); });
  return { signal, stop: async () => { leaseAbort.abort('payment finished'); await done; } };
}

async function decryptPaymentSecrets(pool, topup, env) {
  const [payloadResult, receiverResult] = await Promise.all([
    pool.query('SELECT * FROM topup_sensitive_payloads WHERE topup_id = $1', [topup.id]),
    pool.query('SELECT * FROM receiver_versions WHERE id = $1', [topup.receiver_version_id]),
  ]);
  const payload = payloadResult.rows[0];
  const receiver = receiverResult.rows[0];
  if (!payload || !receiver) throw new Error('Payment credentials are unavailable');
  const sensitive = JSON.parse(decryptSecret({ keyVersion: payload.key_version,
    nonce: payload.nonce, ciphertext: payload.ciphertext, authTag: payload.auth_tag },
  env.DATA_ENCRYPTION_KEYS_JSON, `topup:${topup.id}:${env.DISCORD_GUILD_ID}`));
  const phone = decryptSecret({ keyVersion: receiver.encryption_key_version, nonce: receiver.nonce,
    ciphertext: receiver.encrypted_phone, authTag: receiver.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
  `receiver:${receiver.id}:${env.DISCORD_GUILD_ID}`);
  return { code: sensitive.code, phone };
}

function normalizeProviderResult(result, topup) {
  if (result.outcome === 'REDEEMED' && !result.providerTransactionId) {
    return { ...result, outcome: 'AMBIGUOUS', providerCode: 'PROVIDER_TRANSACTION_ID_MISSING' };
  }
  if (result.outcome === 'RETRY_WAIT' && topup.attempt_count >= 3) return { ...result, outcome: 'FAILED' };
  return result;
}

async function closeSuccessfulProbe(pool, breaker, context) {
  if (breaker?.state !== 'HALF_OPEN') return;
  await pool.query(`UPDATE circuit_breakers SET state='CLOSED',reason='PROBE_SCHEMA_VALID',
    failure_count=0,next_probe_at=NULL,state_version=state_version+1,trace_id=$2,
    updated_at=clock_timestamp() WHERE breaker_key=$1 AND state='HALF_OPEN'`,
  ['TRUEMONEY_DIRECT', context.traceId]);
}

async function openCircuit(pool, error, context, breaker) {
  const schemaFailure = error.category === 'PROVIDER_SCHEMA';
  const failedProbe = breaker?.state === 'HALF_OPEN';
  if (!schemaFailure && !failedProbe) return;
  await pool.query(`UPDATE circuit_breakers SET state='OPEN',reason=$2,
    failure_count=failure_count+1,opened_at=clock_timestamp(),
    next_probe_at=clock_timestamp()+interval '15 minutes',state_version=state_version+1,
    trace_id=$3,updated_at=clock_timestamp() WHERE breaker_key=$1${failedProbe ? " AND state='HALF_OPEN'" : ''}`,
  ['TRUEMONEY_DIRECT', error.code ?? error.name, context.traceId]);
  if (!schemaFailure) return;
  await pool.query(`UPDATE feature_gates SET enabled=false,reason='TRUEMONEY_SCHEMA_CIRCUIT_OPEN',
    version=version+1,actor_type='SYSTEM',actor_id='payment-worker',trace_id=$1,
    updated_at=clock_timestamp() WHERE gate='AUTO_CREDIT_ENABLED'`, [context.traceId]);
  await pool.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
    VALUES(gen_random_uuid(),'PROVIDER_SCHEMA_CHANGED','TRUEMONEY_DIRECT','OPEN','CRITICAL',$1,$2)`,
  [{ errorCode: error.code ?? error.name }, context.traceId]);
}

function failureResult(error, topup) {
  const ambiguous = error.category === 'AMBIGUOUS' || error.category === 'PROVIDER_SCHEMA'
    || error.code === 'PROVIDER_RESULT_AMBIGUOUS';
  if (ambiguous) return { outcome: 'AMBIGUOUS', providerCode: error.code ?? error.name };
  return { outcome: error.retryable && topup.attempt_count < 3 ? 'RETRY_WAIT' : 'FAILED',
    providerCode: error.code ?? error.name };
}

async function processClaimedPayment({ topup, breaker, holder, env, signal, autoCredit, pool }) {
  const context = createContext({ traceId: topup.trace_id, actorType: 'SYSTEM', actorId: holder,
    guildId: env.DISCORD_GUILD_ID, idempotencyKey: `payment:${topup.id}:${topup.attempt_count}` });
  const attempt = await createPaymentAttempt({ topup }, context, { pool });
  const heartbeat = startLeaseHeartbeat(topup, pool, signal);
  try {
    const { code, phone } = await decryptPaymentSecrets(pool, topup, env);
    const result = normalizeProviderResult(await redeemVoucher({ code, receiverPhone: phone, signal: heartbeat.signal,
      onPossiblySent: () => markPaymentPossiblySent({ attemptId: attempt.id }, { pool }) }), topup);
    const updated = await recordProviderResult({ topup, attemptId: attempt.id, result }, context, { pool });
    await closeSuccessfulProbe(pool, breaker, context);
    if (updated.status === 'REDEEMED' && autoCredit) await creditRedeemedTopup({ topupId: topup.id }, context, { pool });
  } catch (error) {
    await openCircuit(pool, error, context, breaker);
    await recordProviderResult({ topup, attemptId: attempt.id, result: failureResult(error, topup) }, context, { pool })
      .catch(() => {});
  } finally {
    await heartbeat.stop();
  }
}

export async function processPayment({ holder, env, signal, autoCredit = false, pool = getRuntimePool() }) {
  if (autoCredit && await creditPendingRedemption({ holder, env, pool })) return true;
  const breaker = (await pool.query("SELECT state FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
  if (breaker?.state === 'OPEN') return false;
  const topup = await acquirePaymentJob({ holder }, { pool });
  if (!topup) return false;
  await processClaimedPayment({ topup, breaker, holder, env, signal, autoCredit, pool });
  return true;
}

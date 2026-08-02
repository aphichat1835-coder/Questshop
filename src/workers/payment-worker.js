import { decryptSecret } from '../adapters/crypto/keyring.js';
import { redeemVoucher } from '../adapters/truemoney/voucher.js';
import { createContext } from '../shared/correlation.js';
import {
  acquirePaymentJob, createPaymentAttempt, markPaymentPossiblySent, recordProviderResult, renewPaymentLease,
} from '../domain/payments/service.js';
import { creditRedeemedTopup } from '../domain/wallet/service.js';
import { getRuntimePool } from '../db/pools.js';
import { setTimeout as delay } from 'node:timers/promises';

export async function processPayment({ holder, env, signal, autoCredit = false, pool = getRuntimePool() }) {
  if (autoCredit) {
    const pendingCredit = (await pool.query(`SELECT * FROM topups WHERE status = 'REDEEMED'
      ORDER BY redeemed_at LIMIT 1`)).rows[0];
    if (pendingCredit) {
      const recoveryContext = createContext({ traceId: pendingCredit.trace_id, actorType: 'SYSTEM', actorId: holder,
        guildId: env.DISCORD_GUILD_ID, idempotencyKey: `credit-recovery:${pendingCredit.id}` });
      await creditRedeemedTopup({ topupId: pendingCredit.id }, recoveryContext, { pool });
      return true;
    }
  }
  const breaker = (await pool.query("SELECT state FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
  if (breaker?.state === 'OPEN') return false;
  const topup = await acquirePaymentJob({ holder }, { pool });
  if (!topup) return false;
  const context = createContext({ traceId: topup.trace_id, actorType: 'SYSTEM', actorId: holder,
    guildId: env.DISCORD_GUILD_ID, idempotencyKey: `payment:${topup.id}:${topup.attempt_count}` });
  const attempt = await createPaymentAttempt({ topup }, context, { pool });
  const leaseAbort = new AbortController();
  const paymentSignal = AbortSignal.any([signal, leaseAbort.signal]);
  const heartbeat = (async () => {
    while (!paymentSignal.aborted) {
      await delay(10_000, undefined, { signal: paymentSignal, ref: false });
      if (!paymentSignal.aborted) await renewPaymentLease(topup, 30, { pool });
    }
  })().catch((error) => { leaseAbort.abort(error); });
  const [payload, receiver] = await Promise.all([
    pool.query('SELECT * FROM topup_sensitive_payloads WHERE topup_id = $1', [topup.id]),
    pool.query('SELECT * FROM receiver_versions WHERE id = $1', [topup.receiver_version_id]),
  ]);
  try {
    const encryptedPayload = payload.rows[0];
    const sensitive = JSON.parse(decryptSecret({ keyVersion: encryptedPayload.key_version,
      nonce: encryptedPayload.nonce, ciphertext: encryptedPayload.ciphertext,
      authTag: encryptedPayload.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
      `topup:${topup.id}:${env.DISCORD_GUILD_ID}`));
    const row = receiver.rows[0];
    const phone = decryptSecret({ keyVersion: row.encryption_key_version, nonce: row.nonce,
      ciphertext: row.encrypted_phone, authTag: row.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
    `receiver:${row.id}:${env.DISCORD_GUILD_ID}`);
    const result = await redeemVoucher({ code: sensitive.code, receiverPhone: phone, signal: paymentSignal,
      onPossiblySent: () => markPaymentPossiblySent({ attemptId: attempt.id }, { pool }) });
    if (result.outcome === 'REDEEMED' && !result.providerTransactionId) {
      result.outcome = 'AMBIGUOUS';
      result.providerCode = 'PROVIDER_TRANSACTION_ID_MISSING';
    }
    if (result.outcome === 'RETRY_WAIT' && topup.attempt_count >= 3) result.outcome = 'FAILED';
    const updated = await recordProviderResult({ topup, attemptId: attempt.id, result }, context, { pool });
    if (breaker?.state === 'HALF_OPEN') {
      await pool.query(`UPDATE circuit_breakers SET state='CLOSED',reason='PROBE_SCHEMA_VALID',
        failure_count=0,next_probe_at=NULL,state_version=state_version+1,trace_id=$2,
        updated_at=clock_timestamp() WHERE breaker_key=$1 AND state='HALF_OPEN'`,
      ['TRUEMONEY_DIRECT', context.traceId]);
    }
    if (updated.status === 'REDEEMED' && autoCredit) {
      await creditRedeemedTopup({ topupId: topup.id }, context, { pool });
    }
  } catch (error) {
    const ambiguous = error.category === 'AMBIGUOUS' || error.category === 'PROVIDER_SCHEMA'
      || error.code === 'PROVIDER_RESULT_AMBIGUOUS';
    if (error.category === 'PROVIDER_SCHEMA') {
      await pool.query(`UPDATE circuit_breakers SET state='OPEN',reason=$2,failure_count=failure_count+1,
        opened_at=clock_timestamp(),next_probe_at=clock_timestamp()+interval '15 minutes',
        state_version=state_version+1,trace_id=$3,updated_at=clock_timestamp() WHERE breaker_key=$1`,
      ['TRUEMONEY_DIRECT', error.code ?? error.name, context.traceId]);
      await pool.query(`UPDATE feature_gates SET enabled=false,reason='TRUEMONEY_SCHEMA_CIRCUIT_OPEN',
        version=version+1,actor_type='SYSTEM',actor_id='payment-worker',trace_id=$1,
        updated_at=clock_timestamp() WHERE gate='AUTO_CREDIT_ENABLED'`, [context.traceId]);
      await pool.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
        VALUES(gen_random_uuid(),'PROVIDER_SCHEMA_CHANGED','TRUEMONEY_DIRECT','OPEN','CRITICAL',$1,$2)`,
      [{ errorCode: error.code ?? error.name }, context.traceId]);
    }
    if (breaker?.state === 'HALF_OPEN' && error.category !== 'PROVIDER_SCHEMA') {
      await pool.query(`UPDATE circuit_breakers SET state='OPEN',reason=$2,
        failure_count=failure_count+1,opened_at=clock_timestamp(),
        next_probe_at=clock_timestamp()+interval '15 minutes',state_version=state_version+1,
        trace_id=$3,updated_at=clock_timestamp() WHERE breaker_key=$1 AND state='HALF_OPEN'`,
      ['TRUEMONEY_DIRECT', error.code ?? error.name, context.traceId]);
    }
    await recordProviderResult({ topup, attemptId: attempt.id, result: {
      outcome: ambiguous ? 'AMBIGUOUS' : error.retryable && topup.attempt_count < 3 ? 'RETRY_WAIT' : 'FAILED',
      providerCode: error.code ?? error.name,
    } }, context, { pool }).catch(() => {});
  } finally { leaseAbort.abort('payment finished'); await heartbeat; }
  return true;
}

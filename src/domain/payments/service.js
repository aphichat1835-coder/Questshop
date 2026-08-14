import { v7 as uuidv7 } from 'uuid';
import { setTimeout as delay } from 'node:timers/promises';
import { isRetryableTransactionError, withTransaction } from '../../db/transaction.js';
import { allVoucherHmacs, encryptSecret } from '../../adapters/crypto/keyring.js';
import { normalizeVoucherUrl } from '../../adapters/truemoney/voucher.js';
import { QuestshopError, FencingLostError } from '../../shared/errors.js';
import { recordTransition } from '../shared/transition.js';
import { openReview } from '../reviews/service.js';
import { TOPUP_TRANSITIONS } from './states.js';
import { enqueueProjection } from '../outbox/service.js';

async function findVoucher(client, hashes) {
  for (const candidate of hashes) {
    const row = (await client.query(`
      SELECT * FROM topups WHERE voucher_hmac_version = $1 AND voucher_hmac = $2
    `, [candidate.version, candidate.digest])).rows[0];
    if (row) return row;
  }
  return null;
}

async function findCommittedVoucher(pool, hashes) {
  // PostgreSQL may report a serialization failure while the concurrent owner
  // is still committing.  This is a read-only bounded reconciliation; it
  // never attempts to redeem or recreate a voucher.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await withTransaction({ pool, isolation: 'READ COMMITTED', maxAttempts: 1 }, (client) => (
      findVoucher(client, hashes)
    ));
    if (existing) return existing;
    if (attempt < 4) await delay(25 * (attempt + 1));
  }
  return null;
}

function paymentAttemptState(outcome) {
  if (outcome === 'REDEEMED') return 'VERIFIED';
  if (outcome === 'AMBIGUOUS') return 'AMBIGUOUS';
  return 'FAILED';
}

export async function submitVoucher({ discordUserId, voucherUrl, env }, context, options = {}) {
  const normalized = normalizeVoucherUrl(voucherUrl);
  const hashes = allVoucherHmacs(normalized.code, env.VOUCHER_HMAC_KEYS_JSON);
  try {
    return await withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const locked = (await client.query(`SELECT 1 FROM topup_daily_locks
      WHERE discord_user_id=$1 AND expires_at>clock_timestamp()`, [discordUserId])).rowCount > 0;
    if (locked) throw new QuestshopError('TOPUP_DAILY_LIMIT', 'เติมเงินครบเพดานของวันนี้แล้ว กรุณาลองใหม่หลังเที่ยงคืน');
    const existing = await findVoucher(client, hashes);
    if (existing) return { topup: existing, idempotent: true };
    const receiver = (await client.query(`
      SELECT * FROM receiver_versions WHERE state = 'ACTIVE' FOR SHARE
    `)).rows[0];
    if (!receiver) throw new QuestshopError('RECEIVER_UNAVAILABLE', 'ยังไม่ได้ตั้งค่าบัญชีรับซอง');
    const promotion = (await client.query(`SELECT * FROM promotions
      WHERE state='ACTIVE' AND (
        manual_controlled=true OR (starts_at<=clock_timestamp() AND ends_at>clock_timestamp())
      ) ORDER BY version DESC LIMIT 1`)).rows[0] ?? null;
    const topupId = uuidv7();
    const encrypted = encryptSecret(
      JSON.stringify({ code: normalized.code, url: normalized.url }),
      env.DATA_ENCRYPTION_KEYS_JSON,
      `topup:${topupId}:${context.guildId}`,
    );
    const currentHash = hashes.find((item) => item.version === env.VOUCHER_HMAC_KEYS_JSON.current);
    let topup = (await client.query(`
      INSERT INTO topups(
        id, discord_user_id, status, voucher_hmac_version, voucher_hmac,
        receiver_version_id, receiver_phone_last4, promotion_id, prelaunch, trace_id
      ) VALUES ($1,$2,'RECEIVED',$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [
      topupId, discordUserId, currentHash.version, currentHash.digest,
      receiver.id, receiver.phone_last4, promotion?.id ?? null, env.PRELAUNCH, context.traceId,
    ])).rows[0];
    await client.query(`
      INSERT INTO topup_sensitive_payloads(topup_id, key_version, nonce, ciphertext, auth_tag)
      VALUES ($1,$2,$3,$4,$5)
    `, [topupId, encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authTag]);
    for (const next of ['VALIDATING', 'PAYMENT_QUEUED']) {
      const previous = topup.status;
      const updated = (await client.query(`
        UPDATE topups SET status = $2, state_version = state_version + 1,
          updated_at = transaction_timestamp() WHERE id = $1 AND state_version = $3 RETURNING *
      `, [topupId, next, topup.state_version])).rows[0];
      if (!updated) throw new QuestshopError('TOPUP_STALE', 'Top-up changed concurrently');
      await recordTransition(client, {
        aggregateType: 'TOPUP', aggregateId: topupId, fromState: previous,
        toState: next, stateVersion: updated.state_version, context,
      });
      topup = updated;
    }
    return { topup, idempotent: false };
    });
  } catch (error) {
    // Concurrent submissions of the same voucher may exhaust SERIALIZABLE
    // retries after the competing transaction has become its durable owner.
    // Re-read only the HMAC identity; never re-run creation or encryption.
    if (error.code !== '23505' && !isRetryableTransactionError(error)) throw error;
    const existing = await findCommittedVoucher(options.pool, hashes);
    if (!existing) throw error;
    return { topup: existing, idempotent: true };
  }
}

export async function acquirePaymentJob({ holder, ttlSeconds = 30 }, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const result = await client.query(`
      WITH candidate AS (
        SELECT id FROM topups
        WHERE status = 'PAYMENT_QUEUED' AND available_at <= clock_timestamp()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE topups t SET
        status = 'PROCESSING', state_version = state_version + 1,
        lease_owner = $1, lease_expires_at = clock_timestamp() + make_interval(secs => $2),
        fencing_token = fencing_token + 1, attempt_count = attempt_count + 1,
        updated_at = clock_timestamp()
      FROM candidate WHERE t.id = candidate.id RETURNING t.*
    `, [holder, ttlSeconds]);
    const topup = result.rows[0] ?? null;
    if (topup) {
      await client.query(`INSERT INTO state_transitions(id,aggregate_type,aggregate_id,from_state,to_state,
        state_version,actor_type,actor_id,trace_id,reason_code)
        VALUES($1,'TOPUP',$2,'PAYMENT_QUEUED','PROCESSING',$3,'SYSTEM',$4,$5,'PAYMENT_LEASED')`,
      [uuidv7(), topup.id, topup.state_version, holder, topup.trace_id]);
    }
    return topup;
  });
}

export async function createPaymentAttempt({ topup, parentAttemptId = null }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => (
    (await client.query(`
      INSERT INTO payment_attempts(
        id, topup_id, attempt_number, parent_attempt_id, dispatch_state, trace_id
      ) VALUES ($1,$2,$3,$4,'INTENT_RECORDED',$5) RETURNING *
    `, [uuidv7(), topup.id, topup.attempt_count, parentAttemptId, context.traceId])).rows[0]
  ));
}

export async function renewPaymentLease(topup, ttlSeconds = 30, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const row = (await client.query(`UPDATE topups SET lease_expires_at=clock_timestamp()+make_interval(secs=>$4),
      updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3
      AND status='PROCESSING' AND lease_expires_at>clock_timestamp() RETURNING *`,
    [topup.id, topup.lease_owner, topup.fencing_token, ttlSeconds])).rows[0];
    if (!row) throw new FencingLostError(`topup:${topup.id}`);
    return row;
  });
}

export async function markPaymentPossiblySent({ attemptId }, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => (
    (await client.query(`
      UPDATE payment_attempts SET dispatch_state = 'POSSIBLY_SENT',
        possibly_sent_at = clock_timestamp()
      WHERE id = $1 AND dispatch_state = 'INTENT_RECORDED' RETURNING *
    `, [attemptId])).rows[0]
  ));
}

export async function recordProviderResult({ topup, attemptId, result }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const locked = (await client.query(`
      SELECT * FROM topups WHERE id = $1 AND lease_owner=$2 AND fencing_token=$3
        AND lease_expires_at>clock_timestamp() FOR UPDATE
    `, [topup.id, topup.lease_owner, topup.fencing_token])).rows[0];
    if (!locked) {
      throw new FencingLostError(`topup:${topup.id}`);
    }
    const next = result.outcome;
    if (!(TOPUP_TRANSITIONS[locked.status] ?? []).includes(next)) {
      throw new QuestshopError('TOPUP_TRANSITION_INVALID', `${locked.status} cannot become ${next}`);
    }
    await client.query(`
      UPDATE payment_attempts SET dispatch_state = $2, provider_status_code = $3,
        provider_http_status = $4, provider_evidence = $5,
        completed_at = clock_timestamp() WHERE id = $1
    `, [
      attemptId, paymentAttemptState(next),
      result.providerCode ?? null, result.httpStatus ?? null,
      { receiverConfirmation: result.receiverConfirmation ?? null },
    ]);
    let updated = (await client.query(`
      UPDATE topups SET status = $2, state_version = state_version + 1,
        provider_transaction_id = $3, amount_cents = $4, currency = $5,
        sender_name = $6, sender_phone = $7, failure_code = $8,
        warning_code = CASE WHEN $4 > 100000 THEN 'AMOUNT_OVER_CONFIGURED_LIMIT'
          WHEN $4 < 1000 THEN 'AMOUNT_BELOW_CONFIGURED_LIMIT' ELSE warning_code END,
        redeemed_at = CASE WHEN $2 = 'REDEEMED' THEN transaction_timestamp() ELSE redeemed_at END,
        -- Full jitter: a request proven not sent may retry at most three times
        -- inside the two-minute payment budget. A possibly-sent request never
        -- reaches this branch (it is sent to Manual Review instead).
        available_at = CASE WHEN $2 = 'RETRY_WAIT' THEN clock_timestamp() + make_interval(
          secs => floor(random() * LEAST(60::double precision,
            10::double precision * power(2::double precision, GREATEST(0, $10 - 1))))::integer
        ) ELSE available_at END,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = transaction_timestamp()
      WHERE id = $1 AND state_version = $9 RETURNING *
    `, [
      topup.id, next, result.providerTransactionId ?? null, result.amountCents ?? null,
      result.currency ?? null, result.senderName ?? null, result.senderPhone ?? null,
      result.providerCode ?? null, locked.state_version, topup.attempt_count,
    ])).rows[0];
    if (!updated) throw new QuestshopError('TOPUP_STALE', 'Top-up changed concurrently');
    await recordTransition(client, {
      aggregateType: 'TOPUP', aggregateId: topup.id,
      fromState: locked.status, toState: next, stateVersion: updated.state_version, context,
    });
    if (['INVALID', 'EXPIRED', 'ALREADY_REDEEMED'].includes(next)) {
      await client.query(`INSERT INTO customer_rate_limit_events(id,discord_user_id,operation,trace_id)
        VALUES($1,$2,'VOUCHER_INVALID',$3)`, [uuidv7(), updated.discord_user_id, context.traceId]);
    }
    if (next === 'AMBIGUOUS') {
      const ambiguous = updated;
      updated = (await client.query(`
        UPDATE topups SET status = 'MANUAL_REVIEW', state_version = state_version + 1,
          updated_at = transaction_timestamp() WHERE id = $1 AND state_version = $2 RETURNING *
      `, [topup.id, ambiguous.state_version])).rows[0];
      await recordTransition(client, {
        aggregateType: 'TOPUP', aggregateId: topup.id,
        fromState: 'AMBIGUOUS', toState: 'MANUAL_REVIEW', stateVersion: updated.state_version,
        context,
      });
      await openReview(client, {
        subjectType: 'TOPUP', subjectId: topup.id,
        reason: 'AMBIGUOUS_PROVIDER_RESULT', financial: true, ownerOnly: true, context,
      });
    }
    await enqueueProjection(client, { projectionType: 'PAYMENT_LOG', aggregateType: 'TOPUP',
      aggregateId: topup.id, aggregateVersion: updated.state_version,
      surfaceKey: 'LOG_PAYMENTS', context });
    return updated;
  });
}

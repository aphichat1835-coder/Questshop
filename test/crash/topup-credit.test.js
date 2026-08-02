import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { adjustBalance, creditRedeemedTopup, reverseTopup } from '../../src/domain/wallet/service.js';
import { resolveSubjectReview } from '../../src/domain/reviews/service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('crash/replay at REDEEMED to CREDITED credits exactly once', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiver = uuidv7(); const topup = uuidv7(); const trace = uuidv7();
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id) VALUES($1,1,$2,1,$3,$4,'1234','ACTIVE','owner',$5)`,
  [receiver, Buffer.alloc(10), Buffer.alloc(12), Buffer.alloc(16), trace]);
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,provider_transaction_id,amount_cents,currency,trace_id,redeemed_at)
    VALUES($1,'credit-user','REDEEMED',1,$2,$3,'1234','provider-1',1000,'THB',$4,clock_timestamp())`,
  [topup, Buffer.alloc(32, 1), receiver, trace]);
  const makeContext = (key) => createContext({ traceId: trace, actorType: 'SYSTEM', actorId: 'payment-worker',
    guildId: '10000000000000002', idempotencyKey: key });
  const results = await Promise.all([
    creditRedeemedTopup({ topupId: topup }, makeContext('credit-a'), { pool }),
    creditRedeemedTopup({ topupId: topup }, makeContext('credit-b'), { pool }),
  ]);
  assert.equal(results.filter((result) => result.topup.status === 'CREDITED').length, 2);
  const wallet = (await pool.query("SELECT * FROM wallets WHERE discord_user_id='credit-user'")).rows[0];
  assert.equal(BigInt(wallet.available_cents), 1000n);
  const ledger = (await pool.query(`SELECT count(*)::integer AS count FROM wallet_transactions
    WHERE reference_type='TOPUP' AND reference_id=$1 AND transaction_type='TOPUP_CREDIT'`, [topup])).rows[0];
  assert.equal(ledger.count, 1);
});

test('owner manual review credits ambiguous top-up atomically with audit', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const topup = uuidv7(); const review = uuidv7(); const trace = uuidv7();
  const receiver = (await pool.query("SELECT id FROM receiver_versions WHERE state='ACTIVE'")).rows[0].id;
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id) VALUES($1,'review-user','MANUAL_REVIEW',1,$2,$3,'5678',$4)`,
  [topup, Buffer.alloc(32, 2), receiver, trace]);
  await pool.query(`INSERT INTO manual_reviews(id,subject_type,subject_id,state,financial,owner_only,
    opened_reason,trace_id) VALUES($1,'TOPUP',$2,'OPEN',true,true,'AMBIGUOUS',$3)`,
  [review, topup, trace]);
  const context = createContext({ traceId: trace, actorType: 'OWNER', actorId: 'owner',
    guildId: '10000000000000002', idempotencyKey: 'manual-credit' });
  const result = await resolveSubjectReview({ reviewId: review, decision: 'CREDIT',
    reason: 'verified in TrueMoney application', isOwner: true, amountCents: 1_250n,
    providerTransactionId: 'provider-manual-1' }, context, { pool });
  assert.equal(result.review.state, 'RESOLVED');
  assert.equal(result.applied.status, 'CREDITED');
  const wallet = (await pool.query("SELECT * FROM wallets WHERE discord_user_id='review-user'")).rows[0];
  assert.equal(BigInt(wallet.available_cents), 1_250n);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM review_decisions WHERE review_id=$1',
    [review])).rows[0].count), 1);
  assert.deepEqual((await pool.query(`SELECT from_state,to_state FROM state_transitions
    WHERE aggregate_type='MANUAL_REVIEW' AND aggregate_id=$1 ORDER BY created_at`, [review])).rows, [
    { from_state: 'OPEN', to_state: 'ASSIGNED' },
    { from_state: 'ASSIGNED', to_state: 'EVIDENCE_PENDING' },
    { from_state: 'EVIDENCE_PENDING', to_state: 'DECISION_READY' },
    { from_state: 'DECISION_READY', to_state: 'RESOLVED' },
  ]);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM review_evidence
    WHERE review_id=$1 AND evidence_type='DECISION_INPUT'`, [review])).rows[0].count), 1);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM admin_audit_logs
    WHERE target_type='TOPUP' AND target_id=$1`, [topup])).rows[0].count), 1);
  await adjustBalance({ discordUserId: 'review-user', amountCents: -1_000n,
    reason: 'spent before reversal' }, createContext({ traceId: trace, actorType: 'OWNER', actorId: 'owner',
    guildId: '10000000000000002', idempotencyKey: 'spend-before-reversal' }), { pool });
  const reversal = await reverseTopup({ topupId: topup, reason: 'provider reversal requested' },
    createContext({ traceId: trace, actorType: 'OWNER', actorId: 'owner',
      guildId: '10000000000000002', idempotencyKey: 'reversal-review' }), { pool });
  assert.equal(reversal.pendingReview, true);
  assert.equal((await pool.query('SELECT status FROM topups WHERE id=$1', [topup])).rows[0].status, 'CREDITED');
  assert.equal(reversal.review.owner_only, true);
});

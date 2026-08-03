import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { adjustBalance } from '../../src/domain/wallet/service.js';
import {
  buildQuote, confirmOrder, createSession, getSelectionPage, selectAll,
} from '../../src/domain/checkout/service.js';
import { openOrderItemReview, setQuestSaleState } from '../../src/domain/admin/operations-service.js';
import { resolveSubjectReview } from '../../src/domain/reviews/service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('large checkout reserves all items but materializes one account job', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7(); const rule = uuidv7(); const user = 'checkout-user';
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'owner',$2)`, [rule, trace]);
  const quests = Array.from({ length: 5 }, (_, index) => ({ id: `checkout-${index}`, name: `Quest ${index}`,
    eventName: 'WATCH_VIDEO', secondsNeeded: 60, progressSecs: 0, progress: 0, completed: false,
    completedAt: null, enrolled: true, enrolledAt: new Date().toISOString(), autoSupported: true,
    executorId: 'video', startsAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), url: `https://discord.com/quests/checkout-${index}`,
    artworkUrl: null, orbs: 100, coreComplete: true, compatibilityIssues: [] }));
  const api = { fetchCurrentUser: async () => ({ id: 'quest-account', username: 'Quest Account', avatar: null }),
    fetchQuests: async () => quests };
  const key = Buffer.alloc(32, 9).toString('base64');
  const env = { PRELAUNCH: true, RUNNER_CONCURRENCY: 3,
    DATA_ENCRYPTION_KEYS_JSON: { current: 1, keys: { 1: key } },
    DISCORD_CLIENT_VERSION: '1.0.0', DISCORD_CHROME_VERSION: '1.0.0', DISCORD_ELECTRON_VERSION: '1.0.0',
    DISCORD_BUILD_NUMBER: 1, DISCORD_NATIVE_BUILD_NUMBER: 1, DISCORD_LOCALE: 'en-US' };
  const options = { pool, questApiFactory: () => api };
  const context = (keyName) => createContext({ traceId: trace, actorType: 'CUSTOMER', actorId: user,
    guildId: '10000000000000002', idempotencyKey: keyName });
  await adjustBalance({ discordUserId: user, amountCents: 5_000n, reason: 'seed' }, context('seed'), { pool });
  const created = await createSession({ discordUserId: user, guildId: '10000000000000002',
    channelId: '10000000000000003', messageId: null, token: 'test-token-value', env }, context('session'), options);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM checkout_quest_options
    WHERE session_id=$1 AND admission_scope='CUSTOMER_ACCOUNT'`, [created.session.id])).rows[0].count), 5);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id LIKE 'checkout-%'`)).rows[0].count), 5);
  assert.equal(Number((await pool.query("SELECT count(*)::integer AS count FROM quests WHERE sale_state='CLOSED'"))
    .rows[0].count), 5);
  await assert.rejects(() => getSelectionPage({ sessionId: created.session.id, actorId: user,
    guildId: '10000000000000002', channelId: 'wrong-channel' }, context('wrong-channel'), options),
  (error) => error.code === 'NOT_AUTHORIZED');
  await selectAll({ sessionId: created.session.id, actorId: user, guildId: '10000000000000002' }, context('all'), options);
  await buildQuote({ sessionId: created.session.id, actorId: user, guildId: '10000000000000002' }, context('quote'), options);
  const confirmationTrace = uuidv7();
  const order = await confirmOrder({ sessionId: created.session.id, actorId: user,
    guildId: '10000000000000002', env }, createContext({ traceId: confirmationTrace,
    actorType: 'CUSTOMER', actorId: user, guildId: '10000000000000002', idempotencyKey: 'confirm' }), options);
  assert.equal(order.items.length, 5);
  const persistedSession = (await pool.query('SELECT trace_id FROM interaction_sessions WHERE id=$1', [created.session.id])).rows[0];
  const persistedOrder = (await pool.query('SELECT trace_id FROM orders WHERE id=$1', [order.orderId])).rows[0];
  const auditEvent = (await pool.query(`SELECT trace_id FROM outbox_events
    WHERE aggregate_type='INTERACTION_SESSION' AND aggregate_id=$1`, [created.session.id])).rows[0];
  assert.equal(persistedSession.trace_id, trace);
  assert.equal(persistedOrder.trace_id, trace);
  assert.equal(auditEvent.trace_id, trace);
  assert.notEqual(persistedOrder.trace_id, confirmationTrace);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM runner_jobs')).rows[0].count), 1);
  const wallet = (await pool.query('SELECT * FROM wallets WHERE discord_user_id=$1', [user])).rows[0];
  assert.equal(BigInt(wallet.available_cents), 2_500n);
  assert.equal(BigInt(wallet.reserved_cents), 2_500n);
  const secondUser = 'checkout-user-two';
  await adjustBalance({ discordUserId: secondUser, amountCents: 5_000n, reason: 'seed' },
    createContext({ traceId: trace, actorType: 'CUSTOMER', actorId: secondUser,
      guildId: '10000000000000002', idempotencyKey: 'seed-two' }), { pool });
  const secondContext = (keyName) => createContext({ traceId: trace, actorType: 'CUSTOMER', actorId: secondUser,
    guildId: '10000000000000002', idempotencyKey: keyName });
  const second = await createSession({ discordUserId: secondUser, guildId: '10000000000000002',
    channelId: '10000000000000003', messageId: null, token: 'same-account-token', env }, secondContext('session-two'), options);
  await selectAll({ sessionId: second.session.id, actorId: secondUser, guildId: '10000000000000002' }, secondContext('all-two'), options);
  await buildQuote({ sessionId: second.session.id, actorId: secondUser, guildId: '10000000000000002' }, secondContext('quote-two'), options);
  await assert.rejects(() => confirmOrder({ sessionId: second.session.id, actorId: secondUser,
    guildId: '10000000000000002', env }, secondContext('confirm-two'), options),
  (error) => error.code === 'ACCOUNT_ACTIVE_ORDER');
  const adminContext = createContext({ traceId: trace, actorType: 'ADMIN', actorId: 'admin-user',
    guildId: '10000000000000002', idempotencyKey: 'admin-review-open' });
  const review = await openOrderItemReview({ orderItemId: order.items[0].id,
    reason: 'operator requested stop after evidence review' }, adminContext, { pool });
  const resolution = await resolveSubjectReview({ reviewId: review.id, decision: 'STOP',
    reason: 'approved stop and wallet release', isOwner: false, expectedVersion: review.state_version },
  createContext({ traceId: trace, actorType: 'ADMIN', actorId: 'admin-user',
    guildId: '10000000000000002', idempotencyKey: 'admin-review-stop' }), { pool });
  assert.equal(resolution.applied.status, 'STOPPED_RELEASED');
  const afterStop = (await pool.query('SELECT * FROM wallets WHERE discord_user_id=$1', [user])).rows[0];
  assert.equal(BigInt(afterStop.available_cents), 3_000n);
  assert.equal(BigInt(afterStop.reserved_cents), 2_000n);
  const questId = order.items[0].quest_id;
  const paused = await setQuestSaleState({ questId, nextState: 'PAUSED', reason: 'temporary operator pause' },
    createContext({ traceId: trace, actorType: 'ADMIN', actorId: 'admin-user',
      guildId: '10000000000000002', idempotencyKey: 'quest-pause' }), { pool });
  assert.equal(paused.sale_state, 'PAUSED');
  await pool.query(`UPDATE quests SET public_test_gate_override=true WHERE quest_id=$1`, [questId]);
  const reopened = await setQuestSaleState({ questId, nextState: 'OPEN', reason: 'validation passed',
    runnerConcurrency: 3 }, createContext({ traceId: trace, actorType: 'ADMIN', actorId: 'admin-user',
    guildId: '10000000000000002', idempotencyKey: 'quest-open' }), { pool });
  assert.equal(reopened.sale_state, 'OPEN');
  const priceChangeUser = 'checkout-user-price-change';
  const priceContext = (keyName) => createContext({ traceId: trace, actorType: 'CUSTOMER', actorId: priceChangeUser,
    guildId: '10000000000000002', idempotencyKey: keyName });
  await adjustBalance({ discordUserId: priceChangeUser, amountCents: 5_000n, reason: 'seed' },
    priceContext('seed-price'), { pool });
  const priceSession = await createSession({ discordUserId: priceChangeUser, guildId: '10000000000000002',
    channelId: '10000000000000003', messageId: null, token: 'price-token', env },
  priceContext('session-price'), options);
  await selectAll({ sessionId: priceSession.session.id, actorId: priceChangeUser,
    guildId: '10000000000000002' }, priceContext('all-price'), options);
  await pool.query(`INSERT INTO price_rules(id,rule_type,quest_id,amount_cents,priority,config_version,
    actor_id,trace_id) VALUES($1,'TEMPORARY','checkout-0',900,100,1,'owner',$2)`, [uuidv7(), trace]);
  await assert.rejects(() => buildQuote({ sessionId: priceSession.session.id, actorId: priceChangeUser,
    guildId: '10000000000000002' }, priceContext('quote-price'), options),
  (error) => error.code === 'QUOTE_EXPIRED');
});

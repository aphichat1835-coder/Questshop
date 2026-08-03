import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import {
  addMonitor, checkAllMonitorHealth, checkMonitorHealth, rotateMonitorCredential, setMonitorState,
} from '../../src/domain/admin/monitor-service.js';
import { setCircuitBreakerState } from '../../src/domain/admin/operations-service.js';
import { createPromotion, setPriceRule, setPriceRuleEnabled, setPromotionState } from '../../src/domain/admin/config-service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

const keyring = { current: 1, keys: { 1: Buffer.alloc(32, 7).toString('base64') } };
const env = { DATA_ENCRYPTION_KEYS_JSON: keyring };
const context = createContext({ actorType: 'OWNER', actorId: 'owner', guildId: 'guild',
  idempotencyKey: 'admin-operations' });

test('monitor credential rotation validates the same account and never exposes plaintext', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const factory = ({ token }) => ({ fetchCurrentUser: async () => ({
    id: token === 'other-token' ? 'account-2' : 'account-1', username: 'monitor',
  }) });
  const monitor = await addMonitor({ token: 'initial-token', env }, context, { pool, questApiFactory: factory });
  assert.equal(monitor.account_id, 'account-1');
  assert.deepEqual(monitor.capabilities, ['SCAN', 'TEST']);
  await setMonitorState({ monitorId: monitor.id, state: 'QUARANTINED' },
    context, { pool });
  await assert.rejects(() => rotateMonitorCredential({ monitorId: monitor.id, token: 'other-token', env },
    context, { pool, questApiFactory: factory }), /does not match/);
  const rotated = await rotateMonitorCredential({ monitorId: monitor.id, token: 'replacement-token', env },
    context, { pool, questApiFactory: factory });
  assert.equal(rotated.state, 'ACTIVE');
  const credential = (await pool.query('SELECT * FROM monitor_credentials WHERE monitor_id=$1', [monitor.id])).rows[0];
  assert.notEqual(credential.ciphertext.toString('utf8'), 'replacement-token');
  const audit = (await pool.query(`SELECT action,before_state,after_state FROM admin_audit_logs
    WHERE target_id=$1 ORDER BY created_at`, [monitor.id])).rows;
  assert.deepEqual(audit.map((row) => row.action), [
    'ADD_MONITOR', 'MONITOR_STATE_CHANGE', 'ROTATE_MONITOR_CREDENTIAL',
  ]);
});

test('monitor health check is read-only, records readiness, and quarantines an invalid token', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const calls = [];
  const invalidMonitorTokens = new Set(['invalid-token']);
  const factory = ({ token }) => ({
    fetchCurrentUser: async () => {
      calls.push(`profile:${token}`);
      if (invalidMonitorTokens.has(token)) {
        const error = new Error('unauthorized');
        error.status = 401;
        throw error;
      }
      return { id: token === 'healthy-token' ? 'monitor-health' : 'monitor-invalid', username: token };
    },
    fetchQuests: async () => {
      calls.push(`quests:${token}`);
      return [{ id: 'quest-a' }, { id: 'quest-b' }];
    },
  });
  const healthy = await addMonitor({ token: 'healthy-token', env }, context, { pool, questApiFactory: factory });
  const invalid = await addMonitor({ token: 'valid-before-rotation', env }, context, { pool, questApiFactory: factory });
  await rotateMonitorCredential({ monitorId: invalid.id, token: 'invalid-token', env }, context, {
    pool,
    questApiFactory: ({ token }) => ({ fetchCurrentUser: async () => ({ id: 'monitor-invalid', username: token }) }),
  });

  calls.length = 0;
  const ready = await checkMonitorHealth({ monitorId: healthy.id, env }, context, { pool, questApiFactory: factory });
  assert.equal(ready.healthState, 'READY');
  assert.equal(ready.questCount, 2);
  assert.deepEqual(calls, ['profile:healthy-token', 'quests:healthy-token']);

  const failed = await checkMonitorHealth({ monitorId: invalid.id, env }, context, { pool, questApiFactory: factory });
  assert.equal(failed.healthState, 'INVALID');
  assert.equal(failed.errorCode, 'TOKEN_REJECTED');
  const row = (await pool.query(`SELECT state,health_state,last_health_quest_count,last_health_error_code
    FROM monitor_accounts WHERE id=$1`, [invalid.id])).rows[0];
  assert.deepEqual(row, {
    state: 'QUARANTINED', health_state: 'INVALID', last_health_quest_count: null,
    last_health_error_code: 'TOKEN_REJECTED',
  });

  await setMonitorState({ monitorId: healthy.id, state: 'DISABLED' }, context, { pool });
  const all = await checkAllMonitorHealth({ env }, context, { pool, questApiFactory: factory });
  const disabled = all.find((result) => result.monitor.id === healthy.id);
  assert.equal(disabled?.healthState, 'READY');
  assert.equal(disabled?.monitor.state, 'DISABLED');
  assert.ok(all.some((result) => result.monitor.id === invalid.id));
  const plaintext = JSON.stringify((await pool.query(`SELECT before_state,after_state FROM admin_audit_logs
    WHERE action='MONITOR_HEALTH_CHECK'`)).rows);
  assert.equal(plaintext.includes('healthy-token'), false);
  assert.equal(plaintext.includes('invalid-token'), false);
});

test('circuit breaker recovery uses optimistic state version and audit', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const initial = (await pool.query("SELECT * FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
  const halfOpen = await setCircuitBreakerState({ breakerKey: 'TRUEMONEY_DIRECT', nextState: 'HALF_OPEN',
    expectedVersion: initial.state_version, reason: 'owner probe' }, context, { pool });
  assert.equal(halfOpen.state, 'HALF_OPEN');
  await assert.rejects(() => setCircuitBreakerState({ breakerKey: 'TRUEMONEY_DIRECT', nextState: 'CLOSED',
    expectedVersion: initial.state_version, reason: 'stale close' }, context, { pool }),
  (error) => error.code === 'STALE_STATE');
  const closed = await setCircuitBreakerState({ breakerKey: 'TRUEMONEY_DIRECT', nextState: 'CLOSED',
    expectedVersion: halfOpen.state_version, reason: 'probe verified' }, context, { pool });
  assert.equal(closed.state, 'CLOSED');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM admin_audit_logs
    WHERE target_id='TRUEMONEY_DIRECT' AND action='CIRCUIT_BREAKER_CHANGE'`)).rows[0].count), 2);
});

test('price rules can be scheduled then independently enabled or disabled with audit evidence', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const rule = await setPriceRule({ ruleType: 'DEFAULT', amountCents: 500,
    startsAt: new Date('2030-01-01T00:00:00Z'), endsAt: new Date('2030-02-01T00:00:00Z'),
    reason: 'scheduled baseline' }, context, { pool });
  assert.equal(rule.enabled, true);
  const disabled = await setPriceRuleEnabled({ priceRuleId: rule.id, enabled: false, expectedVersion: rule.state_version,
    reason: 'temporary suspension' }, context, { pool });
  assert.equal(disabled.enabled, false);
  await assert.rejects(() => setPriceRuleEnabled({ priceRuleId: rule.id, enabled: true,
    expectedVersion: rule.state_version, reason: 'stale admin tab' }, context, { pool }), /STALE_CONFIG/);
  const enabled = await setPriceRuleEnabled({ priceRuleId: rule.id, enabled: true, expectedVersion: disabled.state_version,
    reason: 'resume scheduled price' }, context, { pool });
  assert.equal(enabled.enabled, true);
  const audit = (await pool.query(`SELECT action FROM admin_audit_logs WHERE target_id=$1 ORDER BY created_at`, [rule.id])).rows;
  assert.deepEqual(audit.map((entry) => entry.action), ['PRICE_RULE_CREATE', 'PRICE_RULE_DISABLE', 'PRICE_RULE_ENABLE']);
});

test('promotion lifecycle keeps one active campaign and preserves an audit for displaced campaign', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const period = { startsAt: new Date('2020-01-01T00:00:00Z'), endsAt: new Date('2030-01-01T00:00:00Z') };
  const first = await createPromotion({ name: 'first', ...period,
    tiers: [{ minimumAmountCents: 10_000, basisPoints: 1_000 }], activate: true, reason: 'initial offer' }, context, { pool });
  const second = await createPromotion({ name: 'second', ...period,
    tiers: [{ minimumAmountCents: 10_000, basisPoints: 1_500 }], activate: false, reason: 'next offer' }, context, { pool });
  const activated = await setPromotionState({ promotionId: second.id, state: 'ACTIVE', expectedVersion: second.state_version,
    reason: 'replace offer' }, context, { pool });
  assert.equal(activated.state, 'ACTIVE');
  const states = (await pool.query('SELECT id,state FROM promotions WHERE id = ANY($1::uuid[]) ORDER BY name', [[first.id, second.id]])).rows;
  assert.deepEqual(states.map((row) => row.state), ['DISABLED', 'ACTIVE']);
  const actions = (await pool.query(`SELECT action FROM admin_audit_logs WHERE target_type='PROMOTION'
    AND target_id = ANY($1::text[]) ORDER BY created_at`, [[first.id, second.id]])).rows.map((row) => row.action);
  assert.ok(actions.includes('PROMOTION_DISABLE'));
  assert.ok(actions.includes('PROMOTION_ACTIVE'));
});

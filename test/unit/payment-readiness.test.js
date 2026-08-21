import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePaymentReadiness } from '../../src/bootstrap/startup.js';

function fakePool({ topup = false, autoCredit = false, receiver = false } = {}) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM feature_gates')) return { rows: [
        { gate: 'TOPUP_ACCEPTING', enabled: topup },
        { gate: 'AUTO_CREDIT_ENABLED', enabled: autoCredit },
      ], rowCount: 2 };
      if (sql.includes('FROM receiver_versions')) {
        return { rows: receiver ? [{ id: 'receiver' }] : [], rowCount: receiver ? 1 : 0 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('payment readiness fails closed when payment is enabled without an active receiver', async () => {
  const health = { checks: {} };
  await assert.rejects(() => validatePaymentReadiness(fakePool({ topup: true }), health),
    (error) => error.code === 'TRUEMONEY_RECEIVER_REQUIRED');
  assert.equal(health.checks.payments, 'MISSING_RECEIVER');
});

test('payment readiness permits maintenance startup when payment gates are disabled', async () => {
  const health = { checks: {} };
  const result = await validatePaymentReadiness(fakePool(), health);
  assert.deepEqual(result, { paymentEnabled: false, hasReceiver: false });
  assert.equal(health.checks.payments, 'DISABLED');
});

test('payment readiness records OK when an active receiver exists', async () => {
  const health = { checks: {} };
  const result = await validatePaymentReadiness(fakePool({ topup: true, autoCredit: true, receiver: true }), health);
  assert.deepEqual(result, { paymentEnabled: true, hasReceiver: true });
  assert.equal(health.checks.payments, 'OK');
});

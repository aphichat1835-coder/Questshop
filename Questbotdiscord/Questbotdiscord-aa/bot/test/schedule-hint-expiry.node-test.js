import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearScheduleHintsForTests,
  getLatestScheduleHint,
  publishScheduleHint,
  selectEffectiveScheduleHint,
} from '../src/quest/schedule-hint-bus.js';

test.beforeEach(clearScheduleHintsForTests);
test.afterEach(clearScheduleHintsForTests);

test('republishing the same hint with a later expiry refreshes its lifetime', () => {
  const account = 'schedule-hint-expiry-account';
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const nextActionAt = new Date(now + 30_000).toISOString();
  const firstExpiry = new Date(now + 10_000).toISOString();
  const refreshedExpiry = new Date(now + 120_000).toISOString();

  assert.equal(publishScheduleHint(account, {
    nextActionAt,
    reason: 'rate-limit',
    source: 'rate-limit',
    priority: 98,
    expiresAt: firstExpiry,
  }), true);
  assert.equal(publishScheduleHint(account, {
    nextActionAt,
    reason: 'rate-limit',
    source: 'rate-limit',
    priority: 98,
    expiresAt: refreshedExpiry,
  }), true);

  assert.equal(getLatestScheduleHint(account).expiresAt, refreshedExpiry);
  assert.equal(selectEffectiveScheduleHint(account, now + 20_000).expiresAt, refreshedExpiry);
});

test('an exactly identical source hint remains a no-op', () => {
  const account = 'schedule-hint-identical-account';
  const hint = {
    nextActionAt: '2030-01-01T00:01:00.000Z',
    reason: 'verification',
    source: 'verification',
    priority: 90,
    expiresAt: '2030-01-01T00:02:00.000Z',
  };

  assert.equal(publishScheduleHint(account, hint), true);
  assert.equal(publishScheduleHint(account, hint), false);
});

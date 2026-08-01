import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearScheduleHintsForTests,
  pruneExpiredScheduleHints,
  publishScheduleHint,
  scheduleHintMemorySnapshot,
  subscribeScheduleHints,
} from '../src/quest/schedule-hint-bus.js';

test.beforeEach(clearScheduleHintsForTests);
test.afterEach(clearScheduleHintsForTests);

test('global pruning removes expired hints and stale effective entries for inactive accounts', () => {
  const now = Date.now();
  assert.equal(publishScheduleHint('expired-account', {
    nextActionAt: new Date(now + 10_000).toISOString(),
    expiresAt: new Date(now + 1_000).toISOString(),
    reason: 'retry',
    source: 'retry',
    priority: 80,
  }), true);
  assert.equal(publishScheduleHint('active-account', {
    nextActionAt: new Date(now + 20_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    reason: 'rate-limit',
    source: 'rate-limit',
    priority: 98,
  }), true);

  const before = scheduleHintMemorySnapshot({ prune: false });
  assert.equal(before.listenerAccounts, 0);
  assert.equal(before.hintAccounts, 2);
  assert.equal(before.effectiveAccounts, 2);
  assert.equal(before.hints, 2);
  assert.ok(Number.isFinite(before.lastPruneAt));

  const result = pruneExpiredScheduleHints(now + 2_000, { force: true });
  assert.equal(result.skipped, false);
  assert.equal(result.removedHints, 1);
  assert.equal(result.removedAccounts, 1);
  assert.deepEqual(scheduleHintMemorySnapshot({ prune: false }), {
    listenerAccounts: 0,
    hintAccounts: 1,
    effectiveAccounts: 1,
    hints: 1,
    lastPruneAt: now + 2_000,
  });
});

test('expired hint pruning notifies an existing listener and keeps the subscription', () => {
  const now = Date.now();
  const received = [];
  const unsubscribe = subscribeScheduleHints('listener-account', (hint) => received.push(hint));
  assert.equal(publishScheduleHint('listener-account', {
    nextActionAt: new Date(now + 10_000).toISOString(),
    expiresAt: new Date(now + 1_000).toISOString(),
    reason: 'verification',
    source: 'verification',
    priority: 90,
  }), true);

  const result = pruneExpiredScheduleHints(now + 2_000, { force: true });
  assert.equal(result.removedHints, 1);
  assert.equal(received.at(-1), null);
  assert.equal(scheduleHintMemorySnapshot({ prune: false }).listenerAccounts, 1);

  unsubscribe();
  assert.equal(scheduleHintMemorySnapshot({ prune: false }).listenerAccounts, 0);
});

test('already expired hints are rejected instead of entering memory', () => {
  const now = Date.now();
  assert.equal(publishScheduleHint('expired-on-arrival', {
    nextActionAt: new Date(now + 10_000).toISOString(),
    expiresAt: new Date(now - 1).toISOString(),
    reason: 'retry',
    source: 'retry',
  }), false);
  assert.equal(scheduleHintMemorySnapshot({ prune: false }).hintAccounts, 0);
});

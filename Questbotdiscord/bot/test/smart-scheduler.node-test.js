import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseNextQuestAction } from '../src/quest/smart-scheduler.js';

const now = new Date('2030-01-01T00:00:00.000Z');

test('completed unclaimed Quest receives highest immediate priority', () => {
  const result = chooseNextQuestAction({
    now,
    quests: [{
      id: 'claim-me',
      completed: true,
      claimed: false,
      enrolled: true,
    }],
    fallbackAt: '2030-01-01T08:00:00.000Z',
  });

  assert.equal(result.reason, 'claim:claim-me');
  assert.equal(result.priority, 100);
  assert.equal(result.nextActionAt, '2030-01-01T00:00:05.000Z');
});

test('enrollment unblock wakes before the fixed baseline schedule', () => {
  const result = chooseNextQuestAction({
    now,
    quests: [{
      id: 'blocked',
      completed: false,
      claimed: false,
      enrolled: false,
      enrollmentBlockedUntil: '2030-01-01T01:00:00.000Z',
    }],
    fallbackAt: '2030-01-01T08:00:00.000Z',
  });

  assert.equal(result.reason, 'enrollment:blocked');
  assert.equal(result.nextActionAt, '2030-01-01T01:00:00.000Z');
});

test('Quest near expiry is promoted ahead of ordinary retry work', () => {
  const result = chooseNextQuestAction({
    now,
    retryAt: '2030-01-01T00:10:00.000Z',
    quests: [{
      id: 'urgent',
      completed: false,
      claimed: false,
      enrolled: true,
      expiresAt: '2030-01-01T00:20:00.000Z',
    }],
  });

  assert.equal(result.reason, 'deadline:urgent');
  assert.equal(result.priority, 95);
});

test('expired incomplete Quest does not create a fresh deadline hint', () => {
  const result = chooseNextQuestAction({
    now,
    quests: [{
      id: 'expired',
      completed: false,
      claimed: false,
      enrolled: true,
      expiresAt: '2029-12-31T23:59:00.000Z',
    }],
    fallbackAt: '2030-01-01T08:00:00.000Z',
  });

  assert.equal(result.reason, 'baseline');
  assert.equal(result.nextActionAt, '2030-01-01T08:00:00.000Z');
});

import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeQuest } from '../src/quest/schema/normalizer.js';

test('numeric Quest IDs are canonical strings for durable recovery matching', () => {
  const quest = normalizeQuest({
    id: 123456,
    config: {
      task_config: { tasks: { WATCH_VIDEO: { target: 60 } } },
    },
    user_status: {
      progress: { WATCH_VIDEO: { value: 0 } },
    },
  });

  assert.equal(quest.id, '123456');
  assert.equal(quest.name, '123456');
  assert.equal(quest.id === String(123456), true);
});

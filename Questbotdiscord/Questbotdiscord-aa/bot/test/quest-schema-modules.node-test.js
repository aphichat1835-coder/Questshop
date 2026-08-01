import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectQuestExecutor } from '../src/quest/executors.js';
import {
  extractQuestArray,
  QuestCompatibilityError,
  summarizeQuestCompatibility,
} from '../src/quest/schema/compatibility.js';
import { normalizeQuest, normalizeQuestPayload } from '../src/quest/schema/normalizer.js';

function rawQuest(overrides = {}) {
  return {
    id: 'quest-1',
    config: {
      messages: { quest_name: 'Quest One' },
      task_config_v2: {
        join_operator: 'or',
        tasks: {
          WATCH_VIDEO: { target: 60 },
        },
      },
      ...overrides.config,
    },
    user_status: {
      enrolled_at: '2030-01-01T00:00:00.000Z',
      progress: { WATCH_VIDEO: { value: 30 } },
      ...overrides.user_status,
    },
    ...overrides,
  };
}

test('compatibility layer accepts array and wrapped Quest responses', () => {
  const quests = [rawQuest()];
  assert.equal(extractQuestArray(quests), quests);
  assert.equal(extractQuestArray({ quests }), quests);
  assert.throws(
    () => extractQuestArray({ items: quests }, '/quests/@me'),
    (error) => error instanceof QuestCompatibilityError
      && error.code === 'QUEST_LIST_SHAPE_CHANGED',
  );
});

test('normalizer preserves current video progress semantics', () => {
  const quest = normalizeQuest(rawQuest());
  assert.equal(quest.name, 'Quest One');
  assert.equal(quest.eventName, 'WATCH_VIDEO');
  assert.equal(quest.secondsNeeded, 60);
  assert.equal(quest.progressSecs, 30);
  assert.equal(quest.progress, 50);
  assert.equal(quest.enrolled, true);
  assert.equal(selectQuestExecutor(quest).id, 'video');
});

test('normalizer accepts finite non-negative numeric strings', () => {
  const quest = normalizeQuest(rawQuest({
    config: {
      task_config_v2: {
        join_operator: 'or',
        tasks: { WATCH_VIDEO: { target: '60' } },
      },
    },
    user_status: { progress: { WATCH_VIDEO: { value: '30' } } },
  }));

  assert.equal(quest.secondsNeeded, 60);
  assert.equal(quest.progressSecs, 30);
  assert.equal(quest.progress, 50);
  assert.equal(quest.autoSupported, true);
  assert.deepEqual(quest.schemaIssues, []);
  assert.equal(selectQuestExecutor(quest).id, 'video');
});

test('invalid targets fail closed before executor selection', () => {
  for (const target of ['not-a-number', 0, -1, Number.POSITIVE_INFINITY]) {
    const quest = normalizeQuest(rawQuest({
      config: {
        task_config_v2: {
          join_operator: 'or',
          tasks: { WATCH_VIDEO: { target } },
        },
      },
    }));

    assert.equal(quest.autoSupported, false, String(target));
    assert.equal(quest.secondsNeeded, 0, String(target));
    assert.equal(quest.progress, 0, String(target));
    assert.equal(selectQuestExecutor(quest).id, 'unsupported', String(target));
    assert.ok(
      quest.compatibilityIssues.some((issue) => issue.code === 'TASK_TARGET_INVALID'),
      String(target),
    );
  }
});

test('invalid progress fails closed without allowing NaN into normalized state', () => {
  for (const value of ['not-a-number', -1, Number.POSITIVE_INFINITY]) {
    const quest = normalizeQuest(rawQuest({
      user_status: { progress: { WATCH_VIDEO: { value } } },
    }));

    assert.equal(quest.autoSupported, false, String(value));
    assert.equal(quest.progressSecs, 0, String(value));
    assert.equal(quest.progress, 0, String(value));
    assert.equal(Number.isFinite(quest.progressSecs), true, String(value));
    assert.equal(Number.isFinite(quest.progress), true, String(value));
    assert.equal(selectQuestExecutor(quest).id, 'unsupported', String(value));
    assert.ok(
      quest.compatibilityIssues.some((issue) => issue.code === 'TASK_PROGRESS_INVALID'),
      String(value),
    );
  }
});

test('progress above the target remains finite and clamps percentage at 100', () => {
  const quest = normalizeQuest(rawQuest({
    user_status: { progress: { WATCH_VIDEO: { value: 90 } } },
  }));
  assert.equal(quest.progressSecs, 90);
  assert.equal(quest.progress, 100);
  assert.equal(quest.autoSupported, true);
});

test('multi-task AND remains visible but is rejected by the executor registry', () => {
  const quest = normalizeQuest(rawQuest({
    config: {
      task_config_v2: {
        join_operator: 'and',
        tasks: {
          WATCH_VIDEO: { target: 60 },
          PLAY_ON_DESKTOP: { target: 60 },
        },
      },
    },
  }));
  assert.equal(quest.autoSupported, false);
  assert.equal(selectQuestExecutor(quest).id, 'unsupported');
  assert.ok(quest.schemaIssues.some((issue) => issue.includes('join_operator=and')));
});

test('payload normalization and compatibility summary identify unknown events', () => {
  const quests = normalizeQuestPayload([
    rawQuest(),
    rawQuest({
      id: 'unknown-1',
      config: {
        task_config_v2: {
          tasks: { BRAND_NEW_EVENT: { target: 10 } },
        },
      },
      user_status: { progress: {} },
    }),
  ], '2030-01-01T01:00:00.000Z');
  const summary = summarizeQuestCompatibility(quests, selectQuestExecutor);
  assert.deepEqual(summary.unknownEvents, ['BRAND_NEW_EVENT']);
  assert.equal(quests[0].enrollmentBlockedUntil, '2030-01-01T01:00:00.000Z');
});

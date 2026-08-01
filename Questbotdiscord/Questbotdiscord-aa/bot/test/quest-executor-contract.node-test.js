import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertQuestExecutorContract,
  describeUnsupportedQuest,
  executeQuestExecutor,
  QUEST_EXECUTORS,
  selectQuestExecutor,
} from '../src/quest/executors.js';

const REQUIRED_METHODS = [
  'matches',
  'validate',
  'estimateDuration',
  'execute',
  'verify',
  'describeUnsupportedReason',
];

test('every registered executor implements the complete plugin contract', () => {
  for (const executor of QUEST_EXECUTORS) {
    assert.equal(assertQuestExecutorContract(executor), executor);
    for (const method of REQUIRED_METHODS) assert.equal(typeof executor[method], 'function');
  }
});

test('video executor owns progress submission and fresh-state verification', async () => {
  const calls = [];
  const quest = {
    id: 'video-1',
    eventName: 'WATCH_VIDEO',
    secondsNeeded: 10,
    progressSecs: 0,
    enrolledAt: '2029-01-01T00:00:00.000Z',
    completed: false,
  };
  const executor = selectQuestExecutor(quest);
  const result = await executeQuestExecutor(executor, {
    quest,
    signal: new AbortController().signal,
    now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    sleep: async (ms) => calls.push(['sleep', ms]),
    sendVideoProgress: async (questId, timestamp) => {
      calls.push(['video-progress', questId, timestamp]);
      return { ok: true };
    },
    fetchFreshQuest: async (questId) => {
      calls.push(['fetch', questId]);
      return { ...quest, progressSecs: 10, progress: 100, completed: true };
    },
    onMutationAccepted: () => calls.push(['accepted']),
    onServerProgress: async (fresh) => calls.push(['progress', fresh.progressSecs]),
  });

  assert.equal(executor.id, 'video');
  assert.equal(result.verified, true);
  assert.deepEqual(calls, [
    ['video-progress', 'video-1', 10],
    ['accepted'],
    ['sleep', 1000],
    ['fetch', 'video-1'],
    ['progress', 10],
  ]);
});

test('desktop executor owns heartbeat loop and terminal verification', async () => {
  const calls = [];
  const quest = {
    id: 'desktop-1',
    eventName: 'PLAY_ON_DESKTOP_V2',
    applicationId: 'app-1',
    secondsNeeded: 30,
    progressSecs: 0,
    completed: false,
  };
  let fetches = 0;
  const executor = selectQuestExecutor(quest);
  const result = await executeQuestExecutor(executor, {
    quest,
    signal: new AbortController().signal,
    heartbeatInterval: 1,
    sleep: async (ms) => calls.push(['sleep', ms]),
    sendHeartbeat: async (fresh, terminal, useApplicationPayload) => {
      calls.push(['heartbeat', fresh.id, terminal, useApplicationPayload]);
      return { ok: true };
    },
    fetchFreshQuest: async (questId) => {
      fetches++;
      calls.push(['fetch', questId]);
      return fetches === 1
        ? { ...quest, progressSecs: 30, progress: 100, completed: false }
        : { ...quest, progressSecs: 30, progress: 100, completed: true };
    },
    onMutationAccepted: () => calls.push(['accepted']),
    onServerProgress: async (fresh) => calls.push(['progress', fresh.progressSecs]),
  });

  assert.equal(executor.id, 'desktop');
  assert.equal(result.verified, true);
  assert.deepEqual(calls, [
    ['heartbeat', 'desktop-1', false, false],
    ['accepted'],
    ['sleep', 1000],
    ['fetch', 'desktop-1'],
    ['progress', 30],
    ['heartbeat', 'desktop-1', true, false],
    ['accepted'],
    ['sleep', 1000],
    ['fetch', 'desktop-1'],
    ['progress', 30],
  ]);
});

test('unsupported and unknown Quests expose structured reasons and cannot execute', () => {
  assert.equal(describeUnsupportedQuest({ eventName: 'PLAY_ON_XBOX' }), 'UNSUPPORTED_EVENT');
  assert.equal(describeUnsupportedQuest({ eventName: 'NEW_EVENT' }), 'UNKNOWN_EVENT');
  assert.equal(describeUnsupportedQuest({ eventName: 'WATCH_VIDEO', autoSupported: false }), 'MULTI_TASK_AND');
  assert.equal(describeUnsupportedQuest({
    eventName: 'WATCH_VIDEO',
    autoSupported: false,
    compatibilityIssues: [{ code: 'TASK_TARGET_INVALID' }],
  }), 'TASK_TARGET_INVALID');
  assert.equal(describeUnsupportedQuest({
    eventName: 'PLAY_ON_DESKTOP',
    autoSupported: false,
    compatibilityIssues: [{ code: 'TASK_PROGRESS_INVALID' }],
  }), 'TASK_PROGRESS_INVALID');
});
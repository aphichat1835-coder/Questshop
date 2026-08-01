import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRunnerState } from '../src/quest/runner-state-observer.js';
import {
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

function observedJob(jobKey, status) {
  return {
    key: jobKey,
    ownerId: 'observer-parsing-owner',
    accountId: 'observer-parsing-account',
    username: 'observer-parsing-user',
    mode: 'scheduled',
    scheduleId: 990001,
    lifecycle: 'running',
    status,
    nextCheckAt: null,
  };
}

test.beforeEach(clearRunnerStatesForTests);
test.afterEach(clearRunnerStatesForTests);

test('observer extracts a preparing Quest name without a backtracking expression', () => {
  const jobKey = 'scheduled:observer-preparing-name';
  syncRunnerState(observedJob(jobKey, '🧭 user: กำลังเตรียมทำ Quest Alpha'));

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.ENROLLING);
  assert.equal(state.quest_name, 'Quest Alpha');
  assert.equal(state.progress, null);
});

test('observer strips progress from a running Quest name', () => {
  const jobKey = 'scheduled:observer-running-name-progress';
  syncRunnerState(observedJob(jobKey, '▶️ user: กำลังทำ Quest Alpha 50%'));

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.RUNNING_PROGRESS);
  assert.equal(state.quest_name, 'Quest Alpha');
  assert.equal(state.progress, 50);
});

test('observer strips a separator before a running progress suffix', () => {
  const jobKey = 'scheduled:observer-running-name-separator';
  syncRunnerState(observedJob(jobKey, '▶️ user: กำลังทำ Quest Alpha — 75%'));

  const state = getRunnerState(jobKey);
  assert.equal(state.quest_name, 'Quest Alpha');
  assert.equal(state.progress, 75);
});

test('observer extracts a colon-delimited Quest name and clamps progress', () => {
  const jobKey = 'scheduled:observer-progress-colon';
  syncRunnerState(observedJob(jobKey, '▶️ user: Quest Beta 150%'));

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.RUNNING_PROGRESS);
  assert.equal(state.quest_name, 'Quest Beta');
  assert.equal(state.progress, 100);
});

test('observer extracts a Quest name from progress text without a colon', () => {
  const jobKey = 'scheduled:observer-progress-no-colon';
  syncRunnerState(observedJob(jobKey, 'Quest Gamma 45%'));

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.RUNNING_PROGRESS);
  assert.equal(state.quest_name, 'Quest Gamma');
  assert.equal(state.progress, 45);
});

test('observer leaves Quest fields empty for unrelated running text', () => {
  const jobKey = 'scheduled:observer-unrelated-running';
  syncRunnerState(observedJob(jobKey, '▶️ user: runner active'));

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.RUNNING);
  assert.equal(state.quest_name, null);
  assert.equal(state.progress, null);
});

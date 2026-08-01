import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { syncRunnerState } from '../src/quest/runner-state-observer.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
  transitionRunnerState,
} from '../src/quest/runner-state-store.js';

function observedJob(jobKey, status, lifecycle = 'running') {
  return {
    key: jobKey,
    ownerId: 'terminal-observer-owner',
    accountId: 'terminal-observer-account',
    username: 'terminal-observer-user',
    mode: 'scheduled',
    scheduleId: 930001,
    lifecycle,
    status,
    nextCheckAt: null,
  };
}

test.beforeEach(clearRunnerStatesForTests);
test.afterEach(clearRunnerStatesForTests);

test('fatal authentication status overrides a high-priority rate-limit wait', () => {
  const jobKey = 'scheduled:terminal-observer-auth';
  beginRunnerState({
    jobKey,
    ownerId: 'terminal-observer-owner',
    mode: 'scheduled',
    scheduleId: 930001,
    state: RUNNER_STATE.WAITING_RATE_LIMIT,
    nextActionAt: '2030-01-01T00:10:00.000Z',
    stateSource: 'schedule-hint:rate-limit',
  });

  syncRunnerState(observedJob(jobKey, '🔐 user: TOKEN INVALID — RUNNER DISABLED (401)'));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.FAILED);
  assert.match(state.last_error, /TOKEN INVALID/);
  assert.equal(state.next_action_at, null);
  assert.equal(state.state_source, 'legacy-observer');
});

test('observed user stop overrides a schedule-hint waiting state', () => {
  const jobKey = 'scheduled:terminal-observer-stop';
  beginRunnerState({
    jobKey,
    ownerId: 'terminal-observer-owner',
    mode: 'scheduled',
    scheduleId: 930002,
    state: RUNNER_STATE.WAITING_ENROLLMENT,
    nextActionAt: '2030-01-01T00:10:00.000Z',
    stateSource: 'schedule-hint:enrollment',
  });

  syncRunnerState(observedJob(jobKey, '🛑 user: STOPPED BY USER'));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.STOPPED);
  assert.equal(state.next_action_at, null);
});

test('recoverable quest failure text cannot overwrite a durable retry state', () => {
  const jobKey = 'scheduled:terminal-observer-retry';
  const retryAt = '2030-01-01T00:10:00.000Z';
  beginRunnerState({
    jobKey,
    ownerId: 'terminal-observer-owner',
    mode: 'scheduled',
    scheduleId: 930004,
    state: RUNNER_STATE.WAITING_RETRY,
    nextActionAt: retryAt,
    stateSource: 'mutation-failure',
  });

  syncRunnerState(observedJob(jobKey, '⚠️ user: Quest A — รับ Quest ไม่สำเร็จ'));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
  assert.equal(state.next_action_at, retryAt);
  assert.equal(state.state_source, 'mutation-failure');
});

test('observer source does not classify generic failure wording as terminal', async () => {
  const source = await readFile(
    new URL('../src/quest/runner-state-observer.js', import.meta.url),
    'utf8',
  );

  assert.match(source, /if \(\/TOKEN INVALID\/\.test\(status\)\)/);
  assert.doesNotMatch(source, /TOKEN INVALID\|ERROR\|ไม่สำเร็จ/);
});

test('an already terminal durable state remains authoritative over stale running text', () => {
  const jobKey = 'scheduled:terminal-observer-preserve';
  beginRunnerState({
    jobKey,
    ownerId: 'terminal-observer-owner',
    mode: 'scheduled',
    scheduleId: 930003,
    state: RUNNER_STATE.RUNNING,
  });
  transitionRunnerState(jobKey, RUNNER_STATE.FAILED, {
    lastError: 'durable failure',
    stateSource: 'runner-completion-observer',
  });

  syncRunnerState(observedJob(jobKey, '▶️ user: กำลังทำ Quest A'));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.FAILED);
  assert.equal(state.last_error, 'durable failure');
  assert.equal(state.state_source, 'runner-completion-observer');
});

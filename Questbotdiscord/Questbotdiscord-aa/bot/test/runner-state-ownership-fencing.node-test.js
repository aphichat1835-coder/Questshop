import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  clearRunnerExecutionContextsForTests,
  registerRunnerExecution,
} from '../src/quest/runner-execution-context.js';
import {
  acquireScheduledRunnerClaim,
  clearScheduledRunnerClaimsForTests,
} from '../src/quest/scheduled-worker-claims.js';
import { syncRunnerState } from '../src/quest/runner-state-observer.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

const scheduleId = 9911;
const jobKey = `scheduled:${scheduleId}`;

function observedJob() {
  return {
    key: jobKey,
    ownerId: 'fence-owner',
    accountId: 'fence-account',
    username: 'fence-user',
    mode: 'scheduled',
    scheduleId,
    lifecycle: 'running',
    status: '⌛ Fence Quest 50%',
    nextCheckAt: null,
  };
}

test.beforeEach(() => {
  clearRunnerExecutionContextsForTests();
  clearScheduledRunnerClaimsForTests();
  clearRunnerStatesForTests();
});

test.afterEach(() => {
  clearRunnerExecutionContextsForTests();
  clearScheduledRunnerClaimsForTests();
  clearRunnerStatesForTests();
});

test('observer cannot write durable state after scheduled ownership moves', () => {
  const startedAt = Date.now();
  assert.equal(
    acquireScheduledRunnerClaim(scheduleId, 'worker-a', 1000, startedAt),
    true,
  );
  const registration = registerRunnerExecution({
    jobKey,
    ownerId: 'fence-owner',
    accountId: 'fence-account',
    mode: 'scheduled',
    scheduleId,
    workerHolder: 'worker-a',
  });
  beginRunnerState({
    jobKey,
    ownerId: 'fence-owner',
    accountId: 'fence-account',
    username: 'fence-user',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.WAITING_SCHEDULE,
    stateSource: 'worker-a',
  });

  try {
    assert.equal(
      acquireScheduledRunnerClaim(scheduleId, 'worker-b', 1000, startedAt + 1001),
      true,
    );

    assert.throws(
      () => syncRunnerState(observedJob()),
      (error) => error?.code === 'RUNNER_OWNERSHIP_LOST',
    );

    const state = getRunnerState(jobKey);
    assert.equal(state.state, RUNNER_STATE.WAITING_SCHEDULE);
    assert.equal(state.state_source, 'worker-a');
    assert.equal(state.progress, null);
  } finally {
    registration.release();
  }
});

test('direct runner state transitions fence worker ownership before writing', async () => {
  const source = await readFile(new URL('../src/discord-runner.js', import.meta.url), 'utf8');

  assert.match(source, /executionContext\?\.workerHolder/);
  assert.match(source, /assertRunnerMutationOwnership\(jobKey\)/);
  assert.match(source, /if \(isTerminalRunnerError\(error\)\) throw error;/);
});

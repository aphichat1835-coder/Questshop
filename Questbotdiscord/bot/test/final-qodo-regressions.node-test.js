import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeVerifiedMutation } from '../src/mutation-retry.js';
import {
  DiscordRateLimitCoordinator,
  MAX_RATE_LIMIT_TIMER_DELAY_MS,
} from '../src/quest/rate-limit-coordinator.js';
import {
  clearRunnerExecutionContextsForTests,
  registerRunnerExecution,
  runWithRunnerExecutionContext,
} from '../src/quest/runner-execution-context.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

function beginMutation(jobKey) {
  beginRunnerState({
    jobKey,
    ownerId: 'owner',
    accountId: 'account',
    username: 'tester',
    mode: 'oneshot',
    state: RUNNER_STATE.RUNNING,
  });
  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.ENROLL,
    questId: 'quest-1',
  });
}

function coordinatorTask(overrides = {}) {
  return {
    account: 'timer-account',
    jobKey: null,
    method: 'GET',
    route: 'GET:/quests/@me',
    url: 'https://discord.com/api/v10/quests/@me',
    ...overrides,
  };
}

test.beforeEach(() => {
  clearRunnerExecutionContextsForTests();
  clearRunnerStatesForTests();
});

test('deterministic mutation failures enter WAITING_RETRY instead of appearing RUNNING', async () => {
  const jobKey = 'qodo-mutation-retry';
  beginMutation(jobKey);
  const error = Object.assign(new Error('bad request'), { status: 400 });

  await assert.rejects(
    runWithRunnerExecutionContext({ jobKey }, () => executeVerifiedMutation({
      perform: async () => { throw error; },
      verify: async () => false,
    })),
    /bad request/,
  );

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.FAILED);
  assert.equal(state.next_action_at, null);
});

test('coordinator records deterministic HTTP mutation failures as WAITING_RETRY', async () => {
  const jobKey = 'qodo-coordinator-400';
  const token = 'qodo-coordinator-token';
  beginRunnerState({
    jobKey,
    ownerId: 'owner',
    accountId: 'account',
    username: 'tester',
    mode: 'oneshot',
    state: RUNNER_STATE.RUNNING,
  });
  const registration = registerRunnerExecution({
    jobKey,
    ownerId: 'owner',
    accountId: 'account',
    username: 'tester',
    mode: 'oneshot',
    userToken: token,
  });
  try {
    const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 1 });
    const response = await coordinator.schedule(
      'https://discord.com/api/v10/quests/quest-1/enroll',
      {
        method: 'POST',
        headers: { Authorization: token },
        body: '{}',
      },
      async () => new Response(null, { status: 400 }),
    );

    assert.equal(response.status, 400);
    const state = getRunnerState(jobKey);
    assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
    assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.FAILED);
  } finally {
    registration.release();
  }
});

test('aborting a queued mutation does not leave its durable state RUNNING', async () => {
  const jobKey = 'qodo-coordinator-abort';
  const token = 'qodo-abort-token';
  beginRunnerState({
    jobKey,
    ownerId: 'owner',
    accountId: 'account',
    username: 'tester',
    mode: 'oneshot',
    state: RUNNER_STATE.RUNNING,
  });
  const registration = registerRunnerExecution({
    jobKey,
    ownerId: 'owner',
    accountId: 'account',
    username: 'tester',
    mode: 'oneshot',
    userToken: token,
  });
  let releaseActive;
  try {
    const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 1 });
    const active = coordinator.schedule(
      'https://discord.com/api/v10/users/@me',
      { method: 'GET', headers: { Authorization: token } },
      () => new Promise((resolve) => {
        releaseActive = () => resolve(new Response(null, { status: 204 }));
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const controller = new AbortController();
    const queued = coordinator.schedule(
      'https://discord.com/api/v10/quests/quest-1/enroll',
      {
        method: 'POST',
        headers: { Authorization: token },
        body: '{}',
        signal: controller.signal,
      },
      async () => new Response(null, { status: 204 }),
    );
    controller.abort();
    await assert.rejects(queued, (error) => error?.name === 'AbortError');

    const state = getRunnerState(jobKey);
    assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
    assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.FAILED);

    releaseActive();
    await active;
  } finally {
    releaseActive?.();
    registration.release();
  }
});

test('very long Retry-After keeps the logical deadline but chunks the Node timer', async () => {
  const now = 1_000;
  const coordinator = new DiscordRateLimitCoordinator({ now: () => now });
  const task = coordinatorTask();
  const logicalDelay = MAX_RATE_LIMIT_TIMER_DELAY_MS + 3_600_000;

  await coordinator.updateRateLimitState(task, {
    status: 429,
    headers: new Headers({
      'x-ratelimit-bucket': 'long-delay-bucket',
      'x-ratelimit-scope': 'shared',
      'x-ratelimit-remaining': '0',
      'retry-after': String(logicalDelay / 1000),
    }),
  });

  assert.equal(
    coordinator.bucketResetAt.get('long-delay-bucket'),
    now + logicalDelay,
  );

  coordinator.queue.push({ ...task, id: 1, priority: 1 });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let scheduledDelay = null;
  globalThis.setTimeout = (_callback, delay) => {
    scheduledDelay = delay;
    return { unref() {} };
  };
  globalThis.clearTimeout = () => {};
  try {
    coordinator.scheduleWakeup();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    coordinator.wakeupTimer = null;
  }

  assert.equal(scheduledDelay, MAX_RATE_LIMIT_TIMER_DELAY_MS);
});

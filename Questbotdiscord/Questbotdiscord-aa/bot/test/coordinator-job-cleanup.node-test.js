import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearRunnerCompletionObserversForTests,
  configureRunnerCompletionObserver,
  observeRunnerCompletion,
} from '../src/quest/runner-completion-observer.js';
import {
  discordRateLimitCoordinator,
  DiscordRateLimitCoordinator,
} from '../src/quest/rate-limit-coordinator.js';

async function flushPromiseHandlers() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test.afterEach(() => {
  discordRateLimitCoordinator.blockedMutationJobs.clear();
  clearRunnerCompletionObserversForTests();
});

test('coordinator releases only the completed job mutation block', () => {
  const coordinator = new DiscordRateLimitCoordinator();
  coordinator.blockedMutationJobs.add('job-completed');
  coordinator.blockedMutationJobs.add('job-active');
  assert.equal(coordinator.snapshot().blockedMutationJobs, 2);

  assert.equal(coordinator.releaseJob('job-completed'), true);
  assert.equal(coordinator.snapshot().blockedMutationJobs, 1);
  assert.equal(coordinator.blockedMutationJobs.has('job-completed'), false);
  assert.equal(coordinator.blockedMutationJobs.has('job-active'), true);
  assert.equal(coordinator.releaseJob('job-completed'), false);
  assert.equal(coordinator.releaseJob(''), false);
  assert.equal(coordinator.releaseJob(null), false);
  assert.equal(coordinator.snapshot().blockedMutationJobs, 1);
  assert.equal(coordinator.blockedMutationJobs.has('job-active'), true);
});

test('runner completion releases its in-memory mutation block', async () => {
  const jobKey = 'oneshot:coordinator-cleanup';
  discordRateLimitCoordinator.blockedMutationJobs.add(jobKey);
  assert.equal(discordRateLimitCoordinator.snapshot().blockedMutationJobs, 1);
  configureRunnerCompletionObserver({
    getJob: () => ({ done: Promise.resolve() }),
    getScheduled: () => null,
  });

  assert.equal(observeRunnerCompletion(jobKey, 'oneshot'), true);
  await flushPromiseHandlers();

  assert.equal(discordRateLimitCoordinator.blockedMutationJobs.has(jobKey), false);
  assert.equal(discordRateLimitCoordinator.snapshot().blockedMutationJobs, 0);
});

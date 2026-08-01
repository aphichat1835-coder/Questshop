import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimRetryAt,
  CLAIM_LONG_RETRY_DELAY_MS,
  CLAIM_RETRY_DELAY_MS,
  CLAIM_RETRY_REASON,
  classifyClaimRetry,
  persistClaimRetry,
} from '../src/quest/claim-retry-policy.js';
import {
  beginRunnerState,
  getRunnerState,
  RUNNER_ERROR_CATEGORY,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
  transitionRunnerState,
} from '../src/quest/runner-state-store.js';

test('captcha and ambiguous platforms use durable long claim cooldowns', () => {
  const captcha = classifyClaimRetry({
    status: 400,
    data: { captcha_sitekey: 'fixture-site-key' },
  });
  assert.equal(captcha.reason, CLAIM_RETRY_REASON.CAPTCHA);
  assert.equal(captcha.delayMs, CLAIM_LONG_RETRY_DELAY_MS);

  const ambiguous = classifyClaimRetry(null, { platformAmbiguous: true });
  assert.equal(ambiguous.reason, CLAIM_RETRY_REASON.PLATFORM_AMBIGUOUS);
  assert.equal(ambiguous.delayMs, CLAIM_LONG_RETRY_DELAY_MS);
});

test('generic HTTP 400 is not misclassified as CAPTCHA', () => {
  const rejected = classifyClaimRetry({
    status: 400,
    message: 'invalid request body',
    data: { code: 50_035 },
  });

  assert.equal(rejected.reason, CLAIM_RETRY_REASON.REQUEST_REJECTED);
  assert.equal(rejected.delayMs, CLAIM_RETRY_DELAY_MS);
  assert.equal(rejected.error.status, 400);
});

test('HTTP 429 keeps a standard durable cooldown and a distinct reason', () => {
  const limited = classifyClaimRetry({ status: 429, message: 'rate limited' });
  assert.equal(limited.reason, CLAIM_RETRY_REASON.RATE_LIMITED);
  assert.equal(limited.delayMs, CLAIM_RETRY_DELAY_MS);
  assert.equal(limited.error.status, 429);
});

test('temporary claim failures use the standard cooldown', () => {
  const retry = classifyClaimRetry({ status: 503, message: 'temporarily unavailable' });
  assert.equal(retry.reason, CLAIM_RETRY_REASON.TEMPORARY_API_ERROR);
  assert.equal(retry.delayMs, CLAIM_RETRY_DELAY_MS);
});

test('claim retry survives restart and later schedule-state transitions', () => {
  const jobKey = 'scheduled:claim-retry-policy';
  const now = new Date('2030-01-01T00:00:00.000Z');
  beginRunnerState({
    jobKey,
    ownerId: 'claim-retry-owner',
    mode: 'scheduled',
    scheduleId: 920001,
  });

  const retry = classifyClaimRetry({ status: 503, message: 'temporary' });
  persistClaimRetry(jobKey, {
    id: 'claim-retry-quest',
    name: 'Claim Retry Quest',
    eventName: 'WATCH_VIDEO',
    progress: 100,
    progressSecs: 60,
  }, { ...retry, now });

  let state = getRunnerState(jobKey);
  const expectedRetryAt = now.getTime() + CLAIM_RETRY_DELAY_MS;
  assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
  assert.equal(state.mutation_kind, RUNNER_MUTATION_KIND.CLAIM);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.FAILED);
  assert.equal(state.metadata.claimRetryReason, CLAIM_RETRY_REASON.TEMPORARY_API_ERROR);
  assert.equal(claimRetryAt(jobKey), expectedRetryAt);

  transitionRunnerState(jobKey, RUNNER_STATE.WAITING_SCHEDULE, {
    nextActionAt: '2030-01-01T08:00:00.000Z',
    stateSource: 'legacy-observer',
  });
  state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_SCHEDULE);
  assert.equal(state.metadata.claimRetryAt, new Date(expectedRetryAt).toISOString());
  assert.equal(claimRetryAt(jobKey), expectedRetryAt);
});

test('rejected claim persists an API 4xx error category', () => {
  const jobKey = 'scheduled:claim-retry-policy-rejected';
  beginRunnerState({
    jobKey,
    ownerId: 'claim-retry-owner',
    mode: 'scheduled',
    scheduleId: 920002,
  });

  const retry = classifyClaimRetry({ status: 400, message: 'invalid claim payload' });
  persistClaimRetry(jobKey, { id: 'claim-retry-quest-rejected' }, { ...retry });

  const state = getRunnerState(jobKey);
  assert.equal(state.metadata.claimRetryReason, CLAIM_RETRY_REASON.REQUEST_REJECTED);
  assert.equal(state.error_category, RUNNER_ERROR_CATEGORY.API_4XX);
});

for (const terminalState of [
  RUNNER_STATE.STOPPED,
  RUNNER_STATE.COMPLETED,
  RUNNER_STATE.FAILED,
]) {
  test(`claim retry cannot revive a ${terminalState} runner`, () => {
    const jobKey = `scheduled:claim-retry-terminal-${terminalState.toLowerCase()}`;
    beginRunnerState({
      jobKey,
      ownerId: 'claim-retry-owner',
      mode: 'scheduled',
      scheduleId: 920100 + terminalState.length,
      state: terminalState,
      nextActionAt: null,
      metadata: { terminalMarker: terminalState },
    });
    const before = getRunnerState(jobKey);
    const retry = classifyClaimRetry({ status: 503, message: 'late claim failure' });

    const result = persistClaimRetry(jobKey, { id: 'late-claim' }, { ...retry });
    const after = getRunnerState(jobKey);

    assert.equal(result.state, terminalState);
    assert.equal(after.state, terminalState);
    assert.equal(after.next_action_at, before.next_action_at);
    assert.equal(after.mutation_kind, before.mutation_kind);
    assert.deepEqual(after.metadata, before.metadata);
    assert.equal(claimRetryAt(jobKey), null);
  });
}

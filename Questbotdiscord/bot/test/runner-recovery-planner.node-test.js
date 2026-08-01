import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRunnerRecoveryPlan,
  planRunnerRecovery,
  RUNNER_RECOVERY_ACTION,
} from '../src/quest/recovery-planner.js';
import { buildScheduledRestorePlan } from '../src/quest/scheduled-restore.js';
import {
  beginRunnerState,
  getRunnerState,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
  transitionRunnerState,
} from '../src/quest/runner-state-store.js';

test('future waiting checkpoint resumes at its persisted next action time', () => {
  beginRunnerState({
    jobKey: 'scheduled:recovery-wait',
    ownerId: 'owner-1',
    mode: 'scheduled',
    scheduleId: 9101,
  });
  transitionRunnerState('scheduled:recovery-wait', RUNNER_STATE.WAITING_RATE_LIMIT, {
    nextActionAt: '2030-01-01T01:00:00.000Z',
  });

  const recovery = buildScheduledRestorePlan(
    { id: 'recovery-wait', next_check_at: '2030-01-01T08:00:00.000Z' },
    new Date('2030-01-01T00:00:00.000Z'),
  );
  assert.equal(recovery.recoveryPlan.action, RUNNER_RECOVERY_ACTION.WAIT);
  assert.equal(recovery.initialNextCheckAt, '2030-01-01T01:00:00.000Z');
  assert.equal(getRunnerState('scheduled:recovery-wait').state, RUNNER_STATE.WAITING_RATE_LIMIT);
});

test('uncertain mutation restarts in verification state before any resend', () => {
  beginRunnerState({
    jobKey: 'scheduled:recovery-uncertain',
    ownerId: 'owner-1',
    mode: 'scheduled',
    scheduleId: 9102,
  });
  prepareRunnerMutation('scheduled:recovery-uncertain', {
    kind: RUNNER_MUTATION_KIND.CLAIM,
    questId: 'quest-claim',
    payload: { platform: 4 },
  });
  transitionRunnerState('scheduled:recovery-uncertain', RUNNER_STATE.VERIFYING_CLAIM, {
    mutationStatus: RUNNER_MUTATION_STATUS.UNCERTAIN,
  });

  const plan = planRunnerRecovery(
    getRunnerState('scheduled:recovery-uncertain'),
    new Date('2030-01-01T00:00:00.000Z'),
  );
  assert.equal(plan.action, RUNNER_RECOVERY_ACTION.VERIFY_MUTATION);
  assert.equal(plan.targetState, RUNNER_STATE.VERIFYING_CLAIM);
  assert.equal(plan.initialNextCheckAt, null);

  applyRunnerRecoveryPlan('scheduled:recovery-uncertain', plan);
  const state = getRunnerState('scheduled:recovery-uncertain');
  assert.equal(state.state, RUNNER_STATE.VERIFYING_CLAIM);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.UNCERTAIN);
  assert.equal(state.metadata.recoveryAction, RUNNER_RECOVERY_ACTION.VERIFY_MUTATION);
});

test('applying recovery plan preserves existing diagnostic metadata', () => {
  const jobKey = 'scheduled:recovery-metadata-preserved';
  beginRunnerState({
    jobKey,
    ownerId: 'owner-1',
    mode: 'scheduled',
    scheduleId: 9105,
    metadata: {
      source: 'worker',
      claimRetryReason: 'rate-limited',
      claimRetryAt: '2030-01-01T00:05:00.000Z',
      customDiagnostic: 'keep-me',
      recoveryAction: 'STALE_ACTION',
      questId: 'stale-quest',
    },
  });

  applyRunnerRecoveryPlan(jobKey, {
    action: RUNNER_RECOVERY_ACTION.VERIFY_COMPLETION,
    reason: 'resume-verifying-completion',
    questId: 'fresh-quest',
    initialNextCheckAt: null,
    targetState: RUNNER_STATE.VERIFYING_COMPLETION,
  });

  const state = getRunnerState(jobKey);
  assert.equal(state.metadata.source, 'worker');
  assert.equal(state.metadata.claimRetryReason, 'rate-limited');
  assert.equal(state.metadata.claimRetryAt, '2030-01-01T00:05:00.000Z');
  assert.equal(state.metadata.customDiagnostic, 'keep-me');
  assert.equal(state.metadata.recoveryAction, RUNNER_RECOVERY_ACTION.VERIFY_COMPLETION);
  assert.equal(state.metadata.recoveryReason, 'resume-verifying-completion');
  assert.equal(state.metadata.questId, 'fresh-quest');
});

test('uncertain checkpoint is verified even when the persisted runner state is still running', () => {
  const plan = planRunnerRecovery({
    mode: 'scheduled',
    state: RUNNER_STATE.RUNNING,
    mutation_kind: RUNNER_MUTATION_KIND.CLAIM,
    mutation_status: RUNNER_MUTATION_STATUS.UNCERTAIN,
    quest_id: 'quest-crash-before-state-transition',
    next_action_at: null,
  });

  assert.equal(plan.action, RUNNER_RECOVERY_ACTION.VERIFY_MUTATION);
  assert.equal(plan.reason, 'verify-claim');
  assert.equal(plan.targetState, RUNNER_STATE.VERIFYING_CLAIM);
});

test('verified mutation metadata never re-enters uncertain mutation recovery', () => {
  beginRunnerState({
    jobKey: 'scheduled:recovery-verified',
    ownerId: 'owner-1',
    mode: 'scheduled',
    scheduleId: 9104,
  });
  prepareRunnerMutation('scheduled:recovery-verified', {
    kind: RUNNER_MUTATION_KIND.CLAIM,
    questId: 'quest-verified',
    payload: { platform: 4 },
  });
  transitionRunnerState('scheduled:recovery-verified', RUNNER_STATE.RUNNING, {
    mutationStatus: RUNNER_MUTATION_STATUS.VERIFIED,
  });

  const plan = planRunnerRecovery(getRunnerState('scheduled:recovery-verified'));
  assert.equal(plan.action, RUNNER_RECOVERY_ACTION.START_FRESH);
  assert.equal(plan.reason, 'fetch-fresh-server-state');
  assert.equal(plan.targetState, RUNNER_STATE.RECOVERING);
});

test('stale verified mutation columns from an older row do not trigger mutation verification', () => {
  const plan = planRunnerRecovery({
    mode: 'scheduled',
    state: RUNNER_STATE.RUNNING,
    mutation_kind: RUNNER_MUTATION_KIND.CLAIM,
    mutation_status: RUNNER_MUTATION_STATUS.VERIFIED,
    quest_id: 'quest-stale-verified',
    next_action_at: null,
  });

  assert.equal(plan.action, RUNNER_RECOVERY_ACTION.START_FRESH);
  assert.equal(plan.reason, 'fetch-fresh-server-state');
  assert.equal(plan.targetState, RUNNER_STATE.RECOVERING);
});

test('one-shot recovery is rejected because its token is intentionally not durable', () => {
  beginRunnerState({ jobKey: 'oneshot:recovery', ownerId: 'owner-1', mode: 'oneshot' });
  const plan = planRunnerRecovery(getRunnerState('oneshot:recovery'));
  assert.equal(plan.action, RUNNER_RECOVERY_ACTION.FAIL);
  assert.equal(plan.targetState, RUNNER_STATE.FAILED);
});

test('active scheduled row with a terminal checkpoint starts from fresh server state', () => {
  beginRunnerState({
    jobKey: 'scheduled:recovery-terminal',
    ownerId: 'owner-1',
    mode: 'scheduled',
    scheduleId: 9103,
    state: RUNNER_STATE.FAILED,
  });
  const plan = planRunnerRecovery(getRunnerState('scheduled:recovery-terminal'));
  assert.equal(plan.action, RUNNER_RECOVERY_ACTION.START_FRESH);
  assert.equal(plan.targetState, RUNNER_STATE.RECOVERING);
});

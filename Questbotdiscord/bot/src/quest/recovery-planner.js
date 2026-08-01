import {
  getRunnerState,
  mutationVerificationState,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';

export const RUNNER_RECOVERY_ACTION = Object.freeze({
  START_FRESH: 'START_FRESH',
  WAIT: 'WAIT',
  VERIFY_MUTATION: 'VERIFY_MUTATION',
  VERIFY_COMPLETION: 'VERIFY_COMPLETION',
  FAIL: 'FAIL',
});

const WAITING_STATES = new Set([
  RUNNER_STATE.WAITING_RATE_LIMIT,
  RUNNER_STATE.WAITING_ENROLLMENT,
  RUNNER_STATE.WAITING_RETRY,
  RUNNER_STATE.WAITING_SCHEDULE,
]);
const MUTATION_RECOVERY_STATUSES = new Set([
  RUNNER_MUTATION_STATUS.PREPARED,
  RUNNER_MUTATION_STATUS.IN_FLIGHT,
  RUNNER_MUTATION_STATUS.ACCEPTED,
  RUNNER_MUTATION_STATUS.UNCERTAIN,
]);
const MUTATION_VERIFY_STATES = new Set([
  RUNNER_STATE.VERIFYING_ENROLLMENT,
  RUNNER_STATE.VERIFYING_PROGRESS,
  RUNNER_STATE.VERIFYING_CLAIM,
]);
const TERMINAL_STATES = new Set([
  RUNNER_STATE.STOPPED,
  RUNNER_STATE.COMPLETED,
  RUNNER_STATE.FAILED,
]);

function timestamp(value) {
  const parsed = value == null ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function plan(action, values = {}) {
  return Object.freeze({ action, ...values });
}

export function planRunnerRecovery(state, now = new Date()) {
  const nowMs = now.getTime();
  if (!state) {
    return plan(RUNNER_RECOVERY_ACTION.START_FRESH, {
      reason: 'no-durable-checkpoint',
      initialNextCheckAt: null,
      targetState: RUNNER_STATE.RECOVERING,
    });
  }
  if (state.mode !== 'scheduled') {
    return plan(RUNNER_RECOVERY_ACTION.FAIL, {
      reason: 'one-shot-token-is-not-persisted',
      initialNextCheckAt: null,
      targetState: RUNNER_STATE.FAILED,
    });
  }

  const nextAt = timestamp(state.next_action_at);
  if (WAITING_STATES.has(state.state) && nextAt != null && nextAt > nowMs) {
    return plan(RUNNER_RECOVERY_ACTION.WAIT, {
      reason: `resume-${String(state.state).toLowerCase()}`,
      initialNextCheckAt: new Date(nextAt).toISOString(),
      targetState: state.state,
    });
  }

  if (
    state.mutation_kind
    && MUTATION_RECOVERY_STATUSES.has(state.mutation_status)
  ) {
    return plan(RUNNER_RECOVERY_ACTION.VERIFY_MUTATION, {
      reason: `verify-${String(state.mutation_kind).toLowerCase()}`,
      mutationKind: state.mutation_kind,
      questId: state.quest_id ?? null,
      initialNextCheckAt: null,
      targetState: mutationVerificationState(state.mutation_kind),
    });
  }

  if (MUTATION_VERIFY_STATES.has(state.state)) {
    return plan(RUNNER_RECOVERY_ACTION.VERIFY_MUTATION, {
      reason: `resume-${String(state.state).toLowerCase()}`,
      mutationKind: state.mutation_kind ?? null,
      questId: state.quest_id ?? null,
      initialNextCheckAt: null,
      targetState: state.state,
    });
  }

  if (state.state === RUNNER_STATE.VERIFYING_COMPLETION) {
    return plan(RUNNER_RECOVERY_ACTION.VERIFY_COMPLETION, {
      reason: 'resume-verifying-completion',
      questId: state.quest_id ?? null,
      initialNextCheckAt: null,
      targetState: RUNNER_STATE.VERIFYING_COMPLETION,
    });
  }

  if (TERMINAL_STATES.has(state.state)) {
    return plan(RUNNER_RECOVERY_ACTION.START_FRESH, {
      reason: 'active-schedule-has-terminal-checkpoint',
      initialNextCheckAt: null,
      targetState: RUNNER_STATE.RECOVERING,
    });
  }

  return plan(RUNNER_RECOVERY_ACTION.START_FRESH, {
    reason: 'fetch-fresh-server-state',
    questId: state.quest_id ?? null,
    initialNextCheckAt: null,
    targetState: RUNNER_STATE.RECOVERING,
  });
}

export function applyRunnerRecoveryPlan(jobKey, recoveryPlan) {
  if (!recoveryPlan?.targetState) return null;
  const current = getRunnerState(jobKey);
  return transitionRunnerState(jobKey, recoveryPlan.targetState, {
    nextActionAt: recoveryPlan.initialNextCheckAt,
    metadata: {
      ...current?.metadata,
      recoveryAction: recoveryPlan.action,
      recoveryReason: recoveryPlan.reason,
      mutationKind: recoveryPlan.mutationKind ?? null,
      questId: recoveryPlan.questId ?? null,
    },
    stateSource: 'recovery-planner',
  });
}

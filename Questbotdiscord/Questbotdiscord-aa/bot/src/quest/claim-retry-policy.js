import {
  getRunnerState,
  RUNNER_ERROR_CATEGORY,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';

export const CLAIM_RETRY_DELAY_MS = 15 * 60 * 1000;
export const CLAIM_LONG_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

const TERMINAL_RUNNER_STATES = new Set([
  RUNNER_STATE.STOPPED,
  RUNNER_STATE.COMPLETED,
  RUNNER_STATE.FAILED,
]);

export const CLAIM_RETRY_REASON = Object.freeze({
  CAPTCHA: 'CAPTCHA',
  PLATFORM_AMBIGUOUS: 'PLATFORM_AMBIGUOUS',
  REQUEST_REJECTED: 'REQUEST_REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
  VERIFICATION_ABSENT: 'VERIFICATION_ABSENT',
  TEMPORARY_API_ERROR: 'TEMPORARY_API_ERROR',
});

function retryError(reason, message, status = null) {
  const error = new Error(message);
  error.name = 'ClaimRetryError';
  error.code = reason;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

export function isCaptchaChallengeData(data) {
  return Boolean(
    data?.captcha_sitekey
    || data?.captcha_service
    || data?.captcha_rqtoken
    || data?.captcha_rqdata
    || data?.captcha_key,
  );
}

export function classifyClaimRetry(error, { platformAmbiguous = false } = {}) {
  if (platformAmbiguous) {
    return {
      reason: CLAIM_RETRY_REASON.PLATFORM_AMBIGUOUS,
      delayMs: CLAIM_LONG_RETRY_DELAY_MS,
      error: retryError(
        CLAIM_RETRY_REASON.PLATFORM_AMBIGUOUS,
        'Discord Quest reward platform is ambiguous',
      ),
    };
  }

  if (isCaptchaChallengeData(error?.data)) {
    return {
      reason: CLAIM_RETRY_REASON.CAPTCHA,
      delayMs: CLAIM_LONG_RETRY_DELAY_MS,
      error: retryError(
        CLAIM_RETRY_REASON.CAPTCHA,
        error?.message ?? 'Discord claim requires a CAPTCHA cooldown',
        error?.status,
      ),
    };
  }

  if (error?.status === 400) {
    return {
      reason: CLAIM_RETRY_REASON.REQUEST_REJECTED,
      delayMs: CLAIM_RETRY_DELAY_MS,
      error: retryError(
        CLAIM_RETRY_REASON.REQUEST_REJECTED,
        error?.message ?? 'Discord rejected the claim request without a CAPTCHA challenge',
        error.status,
      ),
    };
  }

  if (error?.status === 429) {
    return {
      reason: CLAIM_RETRY_REASON.RATE_LIMITED,
      delayMs: CLAIM_RETRY_DELAY_MS,
      error: retryError(
        CLAIM_RETRY_REASON.RATE_LIMITED,
        error?.message ?? 'Discord rate limited the claim request',
        error.status,
      ),
    };
  }

  return {
    reason: CLAIM_RETRY_REASON.TEMPORARY_API_ERROR,
    delayMs: CLAIM_RETRY_DELAY_MS,
    error: retryError(
      CLAIM_RETRY_REASON.TEMPORARY_API_ERROR,
      error?.message ?? 'Discord claim verification is temporarily unavailable',
      error?.status,
    ),
  };
}

function claimRetryErrorCategory(error) {
  const status = Number(error?.status);
  if (status === 429) return RUNNER_ERROR_CATEGORY.RATE_LIMIT;
  if (status >= 500) return RUNNER_ERROR_CATEGORY.API_5XX;
  if (status >= 400) return RUNNER_ERROR_CATEGORY.API_4XX;
  return RUNNER_ERROR_CATEGORY.VERIFICATION;
}

export function persistClaimRetry(jobKey, quest, {
  reason,
  delayMs,
  error = null,
  now = new Date(),
} = {}) {
  const current = getRunnerState(jobKey);
  if (!current || TERMINAL_RUNNER_STATES.has(current.state)) return current;
  const nextActionAt = new Date(now.getTime() + Math.max(1000, Number(delayMs) || 0)).toISOString();
  return transitionRunnerState(jobKey, RUNNER_STATE.WAITING_RETRY, {
    questId: quest?.id ?? current.quest_id,
    questName: quest?.name ?? current.quest_name,
    questEvent: quest?.eventName ?? current.quest_event,
    progress: Number.isFinite(Number(quest?.progress)) ? Number(quest.progress) : current.progress,
    serverProgressSeconds: Number.isFinite(Number(quest?.progressSecs))
      ? Number(quest.progressSecs)
      : current.server_progress_seconds,
    nextActionAt,
    mutationKind: RUNNER_MUTATION_KIND.CLAIM,
    mutationStatus: RUNNER_MUTATION_STATUS.FAILED,
    lastError: error?.message ?? `Claim retry scheduled: ${reason}`,
    errorCategory: claimRetryErrorCategory(error),
    metadata: {
      ...current.metadata,
      claimRetryReason: reason,
      claimRetryAt: nextActionAt,
    },
    stateSource: 'claim-retry-policy',
  });
}

export function claimRetryAt(jobKey) {
  const state = getRunnerState(jobKey);
  const durableMetadataAt = Date.parse(state?.metadata?.claimRetryAt);
  if (Number.isFinite(durableMetadataAt) && durableMetadataAt > Date.now()) {
    return durableMetadataAt;
  }
  if (
    state?.state !== RUNNER_STATE.WAITING_RETRY
    || state?.mutation_kind !== RUNNER_MUTATION_KIND.CLAIM
  ) {
    return null;
  }
  const value = Date.parse(state.next_action_at);
  return Number.isFinite(value) && value > Date.now() ? value : null;
}

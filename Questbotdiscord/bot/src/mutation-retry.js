import { abortableDelay } from './abortable-delay.js';
import { currentRunnerExecutionContext } from './quest/runner-execution-context.js';
import {
  incrementRunnerRetry,
  markRunnerMutationFailed,
  markRunnerMutationUncertain,
  markRunnerMutationVerified,
} from './quest/runner-state-store.js';

const MAX_RETRY_DELAY_MS = 60_000;
const NON_NETWORK_GUARD_CODES = new Set([
  'RUNNER_CHECKPOINT_FAILED',
  'RUNNER_MUTATION_CHECKPOINT_FAILED',
  'RUNNER_MUTATION_REQUIRES_VERIFICATION',
  'RUNNER_OWNERSHIP_LOST',
]);

export class RunnerCheckpointError extends Error {
  constructor(stage, cause) {
    super(`Runner checkpoint failed during ${stage}: ${cause?.message ?? 'unknown storage error'}`, {
      cause,
    });
    this.name = 'RunnerCheckpointError';
    this.code = 'RUNNER_CHECKPOINT_FAILED';
    this.stage = stage;
  }
}

function currentJobKey() {
  return currentRunnerExecutionContext()?.jobKey ?? null;
}

function checkpoint(stage, callback, { required = false } = {}) {
  const jobKey = currentJobKey();
  if (!jobKey) return null;
  try {
    return callback(jobKey);
  } catch (error) {
    console.warn(
      `[MutationCheckpoint:${jobKey}] ${stage} failed — ${error?.message ?? 'checkpoint failed'}`,
    );
    if (required) throw new RunnerCheckpointError(stage, error);
    return null;
  }
}

function markUncertain(error) {
  return checkpoint(
    'mark-uncertain',
    (jobKey) => markRunnerMutationUncertain(jobKey, error),
    { required: true },
  );
}

function markVerified() {
  return checkpoint(
    'mark-verified',
    (jobKey) => markRunnerMutationVerified(jobKey),
    { required: true },
  );
}

function markFailed(error) {
  return checkpoint('mark-failed', (jobKey) => markRunnerMutationFailed(jobKey, error));
}

function markControlledRetry() {
  return checkpoint(
    'controlled-retry',
    (jobKey) => incrementRunnerRetry(jobKey),
    { required: true },
  );
}

export function isUncertainMutationFailure(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.message === 'aborted') return false;
  if (NON_NETWORK_GUARD_CODES.has(error.code)) return false;
  if (!Number.isInteger(error.status)) return true;
  return error.status === 429 || error.status >= 500;
}

export function mutationRetryDelayMs(error) {
  const seconds = Number(
    error?.data?.retry_after
      ?? error?.data?.retryAfter
      ?? error?.retryAfter,
  );
  if (!Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1000));
}

export function waitForMutationRetry(ms, signal) {
  return abortableDelay(ms, signal, { unref: true });
}

async function verifyAfterUncertainFailure(verify) {
  const verified = await verify();
  if (verified) markVerified();
  return verified;
}

function handleVerificationFailure(error) {
  // A failed fresh read is not evidence that the earlier mutation was absent.
  // Preserve UNCERTAIN so restart recovery must verify server state before any
  // later mutation. A checkpoint persistence failure is likewise terminal.
  throw error;
}

/**
 * A mutating request is never retried blindly. After an uncertain failure
 * (network, timeout, 429 or 5xx), fresh server state is checked first. Only
 * when the desired state is still absent can one controlled retry occur.
 *
 * Durable checkpoint updates for an uncertain result and a controlled retry
 * are mandatory. If storage cannot record those boundaries, execution stops
 * and the existing PREPARED/IN_FLIGHT checkpoint is left for restart recovery.
 */
export async function executeVerifiedMutation({
  perform,
  verify,
  signal,
  wait = waitForMutationRetry,
}) {
  let firstError;
  try {
    return await perform();
  } catch (error) {
    firstError = error;
  }

  if (!isUncertainMutationFailure(firstError)) {
    markFailed(firstError);
    throw firstError;
  }

  markUncertain(firstError);
  try {
    if (await verifyAfterUncertainFailure(verify)) return { verifiedAfterFailure: true };
  } catch (verificationError) {
    handleVerificationFailure(verificationError);
  }

  await wait(mutationRetryDelayMs(firstError), signal);
  markControlledRetry();

  try {
    return await perform();
  } catch (retryError) {
    if (isUncertainMutationFailure(retryError)) {
      markUncertain(retryError);
      try {
        if (await verifyAfterUncertainFailure(verify)) return { verifiedAfterFailure: true };
      } catch (verificationError) {
        handleVerificationFailure(verificationError);
      }
    }
    markFailed(retryError);
    throw retryError;
  }
}

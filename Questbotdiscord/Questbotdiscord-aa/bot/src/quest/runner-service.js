import { config } from '../config.js';
import * as legacyRunner from '../discord-runner.js';
import { isProcessRoleActive } from '../process-topology.js';
import {
  getScheduledRunner,
  listScheduledRunners,
} from '../scheduled-runner-store.js';
import { createAllModeRecoveryController } from './all-mode-recovery.js';
import { observeRunnerCompletion } from './runner-completion-observer.js';
import { releaseRunnerExecutionWhenSettled } from './runner-completion-release.js';
import {
  registerRunnerExecution,
  runWithRunnerExecutionContext,
} from './runner-execution-context.js';
import { rollbackStartedRunner } from './runner-start-rollback.js';
import { restoreScheduledRunnerRows } from './scheduled-restore.js';
import {
  clearAllSmartWakes,
  clearSmartWake,
  configureSmartWakeController,
  registerSmartWake,
} from './smart-wake-controller.js';
import {
  beginRunnerState,
  getRunnerState,
  markInterruptedRunnerStates,
  pruneRunnerStates,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';
import {
  startRunnerStateObserver,
  stopRunnerStateObserver,
  syncAllRunnerStates,
} from './runner-state-observer.js';

const TERMINAL_RUNNER_STATES = new Set([
  RUNNER_STATE.STOPPED,
  RUNNER_STATE.COMPLETED,
  RUNNER_STATE.FAILED,
]);

function recoveryMetadata(args, source, current = null) {
  return {
    ...current?.metadata,
    source,
    recoveryAction: args.recoveryPlan?.action ?? null,
    recoveryReason: args.recoveryPlan?.reason ?? null,
  };
}

function beginDurableStart(args, source = 'runner-service') {
  const current = getRunnerState(args.jobKey);
  if (args.recoveryPlan && current) {
    transitionRunnerState(args.jobKey, RUNNER_STATE.AUTHENTICATING, {
      accountId: args.accountId ?? current.account_id,
      username: args.username ?? current.username,
      nextActionAt: args.initialNextCheckAt ?? current.next_action_at,
      metadata: recoveryMetadata(args, source, current),
      stateSource: 'recovery-start',
    });
    return;
  }

  beginRunnerState({
    jobKey: args.jobKey,
    ownerId: args.ownerId,
    accountId: args.accountId ?? null,
    username: args.username ?? null,
    mode: args.mode ?? 'oneshot',
    scheduleId: args.scheduleId ?? null,
    state: RUNNER_STATE.QUEUED,
    nextActionAt: args.initialNextCheckAt ?? null,
    metadata: { source },
    stateSource: source,
  });
  transitionRunnerState(args.jobKey, RUNNER_STATE.AUTHENTICATING, {
    stateSource: source,
  });
}

function activeScheduledInventory() {
  const jobs = legacyRunner.listJobs().filter((job) => (
    job.mode === 'scheduled' && job.lifecycle !== 'stopping'
  ));
  const existingAccountIds = jobs.map((job) => job.accountId).filter(Boolean);
  const existingOwnerCounts = new Map();
  for (const job of jobs) {
    existingOwnerCounts.set(
      job.ownerId,
      (existingOwnerCounts.get(job.ownerId) ?? 0) + 1,
    );
  }
  return { existingAccountIds, existingOwnerCounts };
}

async function restoreAllModeRow(row, context) {
  const inventory = activeScheduledInventory();
  return restoreScheduledRunnerRows(context.client, startLocalRunner, {
    rows: [row],
    reconciliationRows: listScheduledRunners(),
    existingAccountIds: inventory.existingAccountIds,
    existingOwnerCounts: inventory.existingOwnerCounts,
    now: new Date(),
  });
}

async function persistAllModeRetry(jobKey, nextActionAt, error) {
  const current = getRunnerState(jobKey);
  if (current?.state !== RUNNER_STATE.WAITING_RETRY) return false;
  transitionRunnerState(jobKey, RUNNER_STATE.WAITING_RETRY, {
    nextActionAt,
    retryCount: Number(current.retry_count ?? 0) + 1,
    lastError: error?.message ?? String(error),
    metadata: {
      ...current.metadata,
      recoveryRetryPersisted: true,
    },
    stateSource: 'all-mode-recovery-retry',
  });
  return true;
}

const allModeRecovery = createAllModeRecoveryController({
  readState: getRunnerState,
  readJob: legacyRunner.getJob,
  readScheduled: getScheduledRunner,
  restore: restoreAllModeRow,
  persistRetry: persistAllModeRetry,
  reportError: (error, context) => {
    console.error(
      `[RunnerRecovery:${String(context?.jobKey ?? 'unknown').slice(0, 100)}] restart failed — ${error?.message ?? 'unknown error'}`,
    );
  },
});

function recoveryWakeContext(args) {
  return {
    jobKey: args.jobKey,
    mode: args.mode ?? 'oneshot',
    processRole: config.processRole,
    scheduleId: args.scheduleId ?? null,
    client: args.client,
  };
}

function startedStateSource(args) {
  if (args.recoveryPlan) return 'recovery-started';
  return config.processRole === 'worker' ? 'worker' : 'runner-service';
}

function markStarted(args) {
  allModeRecovery.cancel(args.jobKey);
  const current = getRunnerState(args.jobKey);
  const targetState = args.recoveryPlan?.targetState ?? RUNNER_STATE.RUNNING;
  transitionRunnerState(args.jobKey, targetState, {
    accountId: args.accountId ?? current?.account_id ?? null,
    username: args.username ?? current?.username ?? null,
    nextActionAt: args.initialNextCheckAt ?? current?.next_action_at ?? null,
    lastError: args.recoveryPlan ? current?.last_error ?? null : null,
    metadata: args.recoveryPlan
      ? recoveryMetadata(args, 'recovery-started', current)
      : current?.metadata ?? null,
    stateSource: startedStateSource(args),
  });
  registerSmartWake(args);
  observeRunnerCompletion(args.jobKey, args.mode ?? 'oneshot', args.scheduleId ?? null);
  startRunnerStateObserver();
}

function markStartFailure(args, error) {
  allModeRecovery.cancel(args.jobKey);
  transitionRunnerState(args.jobKey, RUNNER_STATE.FAILED, {
    lastError: error?.message ?? String(error),
    metadata: { stage: 'start' },
    stateSource: 'runner-start-failure',
  });
  clearSmartWake(args.jobKey);
}

function transitionOwnedRunner(jobKey, ownerId, state, metadata) {
  const current = getRunnerState(jobKey);
  if (!current || current.owner_id !== ownerId || TERMINAL_RUNNER_STATES.has(current.state)) {
    return current;
  }
  return transitionRunnerState(jobKey, state, {
    nextActionAt: null,
    metadata: { ...current.metadata, ...metadata },
    stateSource: 'runner-service-control',
  });
}

function releaseExecutionWhenSettled(args, registration) {
  const job = legacyRunner.getJob(args.jobKey);
  const done = job?.done;
  const scheduleRecovery = () => {
    queueMicrotask(() => allModeRecovery.schedule(recoveryWakeContext(args)));
  };
  if (!done) {
    registration.release();
    return;
  }

  releaseRunnerExecutionWhenSettled(done, () => registration.release(), {
    onError: (error) => {
      console.error(
        `[RunnerExecution:${String(args.jobKey).slice(0, 100)}] release failed — ${error?.message ?? 'unknown error'}`,
      );
    },
  });
  void Promise.resolve(done).then(scheduleRecovery, () => undefined);
}

async function rollbackPostStartFailure(args) {
  return rollbackStartedRunner(args, {
    getJob: legacyRunner.getJob,
    stopJob: legacyRunner.stopJob,
    reportError: (rollbackError, context) => {
      console.error(
        `[RunnerStartRollback:${String(context?.jobKey ?? 'unknown').slice(0, 100)}] ${rollbackError?.message ?? 'rollback failed'}`,
      );
    },
  });
}

export function shouldDelegateScheduledRunner(processRole, mode) {
  return processRole === 'control' && mode === 'scheduled';
}

export async function startLocalRunner(args) {
  beginDurableStart(args, config.processRole === 'worker' ? 'worker' : 'runner-service');
  let registration;
  let legacyStarted = false;
  try {
    registration = registerRunnerExecution(args);
    const result = await runWithRunnerExecutionContext(
      registration.context,
      () => legacyRunner.startRunner(args),
    );
    legacyStarted = true;
    markStarted(args);
    releaseExecutionWhenSettled(args, registration);
    return result;
  } catch (error) {
    if (legacyStarted) await rollbackPostStartFailure(args);
    registration?.release();
    try {
      markStartFailure(args, error);
    } catch (stateError) {
      console.error(
        `[RunnerStartFailure:${String(args.jobKey).slice(0, 100)}] state update failed — ${stateError?.message ?? 'unknown error'}`,
      );
    }
    throw error;
  }
}

export async function startRunner(args) {
  if (!shouldDelegateScheduledRunner(config.processRole, args.mode)) {
    return startLocalRunner(args);
  }

  beginDurableStart(args, 'control-plane');
  const nextActionAt = new Date().toISOString();
  transitionRunnerState(args.jobKey, RUNNER_STATE.WAITING_SCHEDULE, {
    nextActionAt,
    lastError: null,
    metadata: {
      source: 'control-plane',
      delegated: true,
      reason: 'worker-queue',
    },
    stateSource: 'control-plane',
  });
  return { queued: true, nextActionAt };
}

configureSmartWakeController(startLocalRunner);

export async function restoreScheduledRunners(client) {
  if (config.processRole === 'control') {
    markInterruptedRunnerStates(new Date(), {
      includeOneShot: true,
      includeScheduled: false,
    });
    pruneRunnerStates();
    startRunnerStateObserver();
    return {
      restored: 0,
      failed: 0,
      delegated: listScheduledRunners().length,
    };
  }

  markInterruptedRunnerStates(new Date(), {
    includeOneShot: config.processRole !== 'worker',
    includeScheduled: false,
  });
  const result = await restoreScheduledRunnerRows(client, startLocalRunner);
  syncAllRunnerStates();
  startRunnerStateObserver();
  pruneRunnerStates();
  return result;
}

export const DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS = 15_000;

export async function shutdownRunners(timeoutMs = DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS) {
  for (const job of legacyRunner.listJobs()) {
    const current = getRunnerState(job.key);
    if (current) {
      transitionRunnerState(job.key, RUNNER_STATE.STOPPING, {
        stateSource: 'shutdown',
      });
    }
  }
  allModeRecovery.clear();
  clearAllSmartWakes();
  const result = await legacyRunner.shutdownRunners(timeoutMs);
  syncAllRunnerStates();
  stopRunnerStateObserver();
  return result;
}

export function stopJob(ownerId, jobKey, options = {}) {
  const stopped = legacyRunner.stopJob(ownerId, jobKey, options);
  if (stopped) {
    allModeRecovery.cancel(jobKey);
    transitionOwnedRunner(jobKey, ownerId, RUNNER_STATE.STOPPING, {
      stopSource: config.processRole,
    });
    if (options.removeSchedule !== false) clearSmartWake(jobKey);
  }
  return stopped;
}

export function stopScheduledJob(ownerId, scheduleId) {
  const jobKey = `scheduled:${scheduleId}`;
  const hadLocalJob = Boolean(legacyRunner.getJob(jobKey));
  const stopped = legacyRunner.stopScheduledJob(ownerId, scheduleId);
  if (!stopped) return false;

  allModeRecovery.cancel(jobKey);
  clearSmartWake(jobKey);
  const workerMayStillBeRunning = config.processRole === 'control'
    && isProcessRoleActive('worker');
  const state = hadLocalJob || workerMayStillBeRunning
    ? RUNNER_STATE.STOPPING
    : RUNNER_STATE.STOPPED;
  transitionOwnedRunner(jobKey, ownerId, state, {
    stopSource: config.processRole,
    delegated: workerMayStillBeRunning,
  });
  return true;
}

export function stopAllForUser(ownerId, options = {}) {
  const jobs = legacyRunner.getUserJobs(ownerId, {
    mode: options.mode ?? null,
    includeStopping: true,
  });
  const stopped = legacyRunner.stopAllForUser(ownerId, options);
  if (stopped > 0) {
    for (const job of jobs) {
      allModeRecovery.cancel(job.key);
      transitionOwnedRunner(job.key, ownerId, RUNNER_STATE.STOPPING, {
        stopSource: config.processRole,
      });
      clearSmartWake(job.key);
    }
  }
  return stopped;
}

export const clearQuestEngineStatuses = legacyRunner.clearQuestEngineStatuses;
export const fetchMe = legacyRunner.fetchMe;
export const findAnyJobByAccount = legacyRunner.findAnyJobByAccount;
export const findUserJobByAccount = legacyRunner.findUserJobByAccount;
export const getJob = legacyRunner.getJob;
export const getQuestEngineStatus = legacyRunner.getQuestEngineStatus;
export const getUserJobs = legacyRunner.getUserJobs;
export const listJobs = legacyRunner.listJobs;
export const listQuestEngineStatuses = legacyRunner.listQuestEngineStatuses;
export const refreshBuildInfo = legacyRunner.refreshBuildInfo;

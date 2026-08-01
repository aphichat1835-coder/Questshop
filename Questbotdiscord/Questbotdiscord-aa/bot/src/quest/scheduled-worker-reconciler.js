import { config } from '../config.js';
import { reportCriticalError } from '../error-reporter.js';
import { listScheduledRunners } from '../scheduled-runner-store.js';
import {
  getJob,
  listJobs,
  startLocalRunner,
  stopJob,
} from './runner-service.js';
import { restoreScheduledRunnerRows } from './scheduled-restore.js';
import {
  acquireScheduledRunnerClaim,
  DEFAULT_SCHEDULED_CLAIM_TTL_MS,
  releaseScheduledRunnerClaim,
  renewScheduledRunnerClaim,
} from './scheduled-worker-claims.js';
import {
  getRunnerState,
  listStoppingScheduledRunnerStates,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';

const FAILED_RETRY_DELAY_MS = 5 * 60 * 1000;

export function scheduledClaimTtlMs(pollIntervalMs = config.workerPollIntervalMs) {
  const poll = Number(pollIntervalMs);
  return Math.max(
    DEFAULT_SCHEDULED_CLAIM_TTL_MS,
    Number.isFinite(poll) && poll > 0 ? poll * 3 : 0,
  );
}

function activeScheduledJobs(jobs) {
  return jobs.filter((job) => job.mode === 'scheduled' && job.scheduleId != null);
}

function ownerCounts(jobs) {
  const counts = new Map();
  for (const job of jobs) counts.set(job.ownerId, (counts.get(job.ownerId) ?? 0) + 1);
  return counts;
}

function currentTime(options) {
  const value = typeof options.now === 'function' ? options.now() : options.now;
  const now = Number(value);
  return Number.isFinite(now) ? now : Date.now();
}

function retryEligible(row, now) {
  const state = getRunnerState(`scheduled:${row.id}`);
  if (state?.state !== RUNNER_STATE.FAILED) return true;
  const updatedAt = Date.parse(state.updated_at);
  return !Number.isFinite(updatedAt) || updatedAt + FAILED_RETRY_DELAY_MS <= now;
}

async function waitForLocalJobSettlement(job, options) {
  const current = options.getJob(job.key);
  if (!current?.done) return;
  await Promise.resolve(current.done).catch(() => undefined);
}

async function stopSafely(job, options) {
  try {
    const requested = options.stop(job.ownerId, job.key, { removeSchedule: false }) ? 1 : 0;
    await waitForLocalJobSettlement(job, options);
    if (options.holder) options.releaseClaim(Number(job.scheduleId), options.holder);
    return { requested, failed: 0 };
  } catch (error) {
    await Promise.resolve(options.reportStopError(`Scheduled worker stop ${job.key}`, error))
      .catch(() => undefined);
    return { requested: 0, failed: 1 };
  }
}

async function stopJobsSafely(jobs, options) {
  const results = await Promise.all(jobs.map((job) => stopSafely(job, options)));
  return results.reduce((summary, result) => ({
    requested: summary.requested + result.requested,
    failed: summary.failed + result.failed,
  }), { requested: 0, failed: 0 });
}

function claimHeartbeatDelay(options) {
  const ttl = Number(options.claimTtlMs);
  return Math.max(1_000, Math.floor((Number.isFinite(ttl) ? ttl : 3_000) / 3));
}

function startClaimHeartbeat(jobs, options, renewedJobs, ownershipLost) {
  if (!options.holder || jobs.length === 0) return () => {};
  const timer = options.setInterval(() => {
    for (const job of jobs) {
      try {
        if (ownsActiveClaim(job, options)) renewedJobs.add(job.key);
        else ownershipLost.add(job.key);
      } catch {
        ownershipLost.add(job.key);
      }
    }
  }, claimHeartbeatDelay(options));
  timer?.unref?.();
  return () => options.clearInterval(timer);
}

function ownsActiveClaim(job, options, now = currentTime(options)) {
  if (!options.holder) return true;
  const id = Number(job.scheduleId);
  return options.renewClaim(id, options.holder, options.claimTtlMs, now)
    || options.acquireClaim(id, options.holder, options.claimTtlMs, now);
}

function partitionActiveJobs(rows, jobs, options) {
  const rowIds = new Set(rows.map((row) => Number(row.id)));
  const surviving = [];
  const stopCandidates = [];
  const renewedJobs = new Set();
  let claimLost = 0;

  for (const job of jobs) {
    const rowExists = rowIds.has(Number(job.scheduleId));
    const ownsClaim = rowExists && ownsActiveClaim(job, options);
    if (rowExists && ownsClaim) {
      surviving.push(job);
      if (options.holder) renewedJobs.add(job.key);
      continue;
    }
    if (rowExists) claimLost++;
    stopCandidates.push(job);
  }

  return { claimLost, renewedJobs, stopCandidates, surviving };
}

function addStopResult(result, stopped) {
  result.stopRequested += stopped.requested;
  result.stopFailures += stopped.failed;
}

async function stopCandidatesWithHeartbeat(stopCandidates, surviving, options, renewedJobs) {
  const ownershipLost = new Set();
  const stopHeartbeat = startClaimHeartbeat(
    surviving,
    options,
    renewedJobs,
    ownershipLost,
  );

  try {
    const stopped = await stopJobsSafely(stopCandidates, options);
    return { ownershipLost, stopped };
  } finally {
    stopHeartbeat();
  }
}

function shouldRevalidateOwnership(options, stopCandidates, surviving) {
  return Boolean(options.holder && stopCandidates.length > 0 && surviving.length > 0);
}

async function revalidateSurvivingClaims(
  surviving,
  stopCandidates,
  options,
  renewedJobs,
  ownershipLost,
) {
  if (!shouldRevalidateOwnership(options, stopCandidates, surviving)) {
    return {
      claimLost: 0,
      stopped: { requested: 0, failed: 0 },
      surviving,
    };
  }

  const confirmed = [];
  const lostDuringCleanup = [];
  for (const job of surviving) {
    if (!ownershipLost.has(job.key) && ownsActiveClaim(job, options)) {
      confirmed.push(job);
      renewedJobs.add(job.key);
    } else {
      lostDuringCleanup.push(job);
    }
  }

  return {
    claimLost: lostDuringCleanup.length,
    stopped: await stopJobsSafely(lostDuringCleanup, options),
    surviving: confirmed,
  };
}

async function reconcileActive(rows, jobs, options) {
  const partition = partitionActiveJobs(rows, jobs, options);
  const result = {
    claimLost: partition.claimLost,
    stopFailures: 0,
    stopRequested: 0,
  };

  // Renew every healthy local job before awaiting cleanup for any removed/lost job.
  // This prevents one slow shutdown from starving unrelated ownership leases.
  const cleanup = await stopCandidatesWithHeartbeat(
    partition.stopCandidates,
    partition.surviving,
    options,
    partition.renewedJobs,
  );
  addStopResult(result, cleanup.stopped);

  // Verify ownership again before the restore phase. The heartbeat prevents a
  // long cleanup from allowing unrelated leases to expire mid-reconciliation.
  const revalidated = await revalidateSurvivingClaims(
    partition.surviving,
    partition.stopCandidates,
    options,
    partition.renewedJobs,
    cleanup.ownershipLost,
  );
  result.claimLost += revalidated.claimLost;
  addStopResult(result, revalidated.stopped);

  return {
    ...result,
    claimsRenewed: partition.renewedJobs.size,
    surviving: revalidated.surviving,
  };
}

async function restoreMissing(client, rows, surviving, options) {
  const activeIds = new Set(surviving.map((job) => Number(job.scheduleId)));
  const accounts = surviving.map((job) => job.accountId).filter(Boolean);
  const counts = ownerCounts(surviving);
  const result = { restore: { restored: 0, failed: 0 }, claimsAcquired: 0, claimConflicts: 0 };

  for (const row of rows) {
    const id = Number(row.id);
    const now = currentTime(options);
    if (activeIds.has(id) || !retryEligible(row, now)) continue;
    if (options.holder && !options.acquireClaim(id, options.holder, options.claimTtlMs, now)) {
      result.claimConflicts++;
      continue;
    }
    if (options.holder) result.claimsAcquired++;
    const restored = await restoreScheduledRunnerRows(client, options.startRunner, {
      rows: [row],
      reconciliationRows: rows,
      existingAccountIds: accounts,
      existingOwnerCounts: counts,
      now: new Date(now),
      workerHolder: options.holder,
    });
    result.restore.restored += restored.restored;
    result.restore.failed += restored.failed;
    if (restored.restored > 0) {
      activeIds.add(id);
      if (row.account_id) accounts.push(row.account_id);
      counts.set(row.owner_id, (counts.get(row.owner_id) ?? 0) + 1);
    } else if (options.holder) {
      options.releaseClaim(id, options.holder);
    }
  }
  return result;
}

function finalizeStops(rows, active, options) {
  const rowIds = new Set(rows.map((row) => Number(row.id)));
  const activeIds = new Set(active.map((job) => Number(job.scheduleId)));
  let finalized = 0;
  for (const state of listStoppingScheduledRunnerStates()) {
    const id = Number(state.schedule_id);
    if (rowIds.has(id) || activeIds.has(id)) continue;
    if (options.holder) options.releaseClaim(id, options.holder);
    transitionRunnerState(state.job_key, RUNNER_STATE.STOPPED, {
      nextActionAt: null,
      lastError: null,
      metadata: { ...state.metadata, stopConfirmedBy: 'worker-supervisor' },
      stateSource: 'worker-supervisor',
    });
    finalized++;
  }
  return finalized;
}

export async function reconcileScheduledWorker(client, supplied = {}) {
  const options = {
    rows: listScheduledRunners(),
    jobs: listJobs(),
    getJob,
    startRunner: startLocalRunner,
    stop: stopJob,
    reportStopError: reportCriticalError,
    now: Date.now,
    holder: null,
    claimTtlMs: scheduledClaimTtlMs(),
    acquireClaim: acquireScheduledRunnerClaim,
    renewClaim: renewScheduledRunnerClaim,
    releaseClaim: releaseScheduledRunnerClaim,
    setInterval,
    clearInterval,
    ...supplied,
  };
  const active = activeScheduledJobs(options.jobs);
  const activeResult = await reconcileActive(options.rows, active, options);
  const restored = await restoreMissing(client, options.rows, activeResult.surviving, options);
  return {
    scheduledRows: options.rows.length,
    activeBefore: active.length,
    stopRequested: activeResult.stopRequested,
    stopFailures: activeResult.stopFailures,
    claimLost: activeResult.claimLost,
    claimsRenewed: activeResult.claimsRenewed,
    claimsAcquired: restored.claimsAcquired,
    claimConflicts: restored.claimConflicts,
    finalizedStops: finalizeStops(options.rows, activeResult.surviving, options),
    restore: restored.restore,
  };
}

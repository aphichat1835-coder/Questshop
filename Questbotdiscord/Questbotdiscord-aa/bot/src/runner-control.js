import { config } from './config.js';
import {
  getJob,
  getUserJobs,
  stopJob as stopJobImmediately,
  stopScheduledJob as stopScheduledJobImmediately,
} from './quest/runner-service.js';
import { getRunnerState, RUNNER_STATE } from './quest/runner-state-store.js';

const LOCAL_STOP_TIMEOUT_MS = 15_000;
const DURABLE_STOP_POLL_MS = 250;
const TERMINAL_DURABLE_STATES = new Set([
  RUNNER_STATE.STOPPED,
  RUNNER_STATE.COMPLETED,
  RUNNER_STATE.FAILED,
]);
const stoppingAccounts = new Set();
const stoppingJobs = new Map();

export function durableStopTimeoutMs(workerPollIntervalMs = config.workerPollIntervalMs) {
  const cadence = Number.isFinite(workerPollIntervalMs) && workerPollIntervalMs > 0
    ? workerPollIntervalMs
    : config.workerPollIntervalMs;
  return Math.max(LOCAL_STOP_TIMEOUT_MS, cadence * 2 + 5_000);
}

function accountKey(ownerId, accountId) {
  return accountId ? `${ownerId}:${accountId}` : null;
}

function result(accepted, cleanupComplete) {
  return { accepted, cleanupComplete };
}

async function waitForCompletion(completion, timeoutMs) {
  if (!completion || typeof completion.then !== 'function') return true;
  let timeout;
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDurableStop(jobKey, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = getRunnerState(jobKey);
    if (!state || TERMINAL_DURABLE_STATES.has(state.state)) return true;
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.max(1, Math.min(DURABLE_STOP_POLL_MS, remaining)),
    ));
  }
  const state = getRunnerState(jobKey);
  return !state || TERMINAL_DURABLE_STATES.has(state.state);
}

function trackStoppingJob(jobKey, key, done) {
  const completion = Promise.resolve(done)
    .catch(() => {})
    .finally(() => {
      stoppingJobs.delete(jobKey);
      if (key) stoppingAccounts.delete(key);
    });
  stoppingJobs.set(jobKey, completion);
  return completion;
}

export function summarizeStopResults(results) {
  const accepted = results.filter((item) => item.accepted).length;
  const completed = results.filter((item) => item.accepted && item.cleanupComplete).length;
  return {
    accepted,
    completed,
    pending: accepted - completed,
  };
}

export function isAccountStopping(ownerId, accountId) {
  const key = accountKey(ownerId, accountId);
  return key ? stoppingAccounts.has(key) : false;
}

export function listStoppingAccounts(ownerId) {
  const prefix = `${ownerId}:`;
  return [...stoppingAccounts]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

export async function stopJobAndWait(ownerId, jobKey, {
  removeSchedule = true,
  timeoutMs = LOCAL_STOP_TIMEOUT_MS,
} = {}) {
  const existingCompletion = stoppingJobs.get(jobKey);
  if (existingCompletion) {
    return result(true, await waitForCompletion(existingCompletion, timeoutMs));
  }

  const job = getJob(jobKey);
  if (!job || job.ownerId !== ownerId) return result(false, false);
  const key = accountKey(ownerId, job.accountId);
  if (key) stoppingAccounts.add(key);

  const completion = trackStoppingJob(jobKey, key, job.done);
  const stopped = stopJobImmediately(ownerId, jobKey, { removeSchedule });
  if (!stopped) {
    stoppingJobs.delete(jobKey);
    if (key) stoppingAccounts.delete(key);
    return result(false, false);
  }

  return result(true, await waitForCompletion(completion, timeoutMs));
}

export async function stopScheduledJobAndWaitDetailed(ownerId, scheduleId, {
  timeoutMs = durableStopTimeoutMs(),
} = {}) {
  const jobKey = `scheduled:${scheduleId}`;
  const job = getJob(jobKey);
  if (!job) {
    const removed = stopScheduledJobImmediately(ownerId, scheduleId);
    if (!removed) return result(false, false);
    return result(true, await waitForDurableStop(jobKey, timeoutMs));
  }
  return stopJobAndWait(ownerId, jobKey, { removeSchedule: true, timeoutMs });
}

export async function stopScheduledJobAndWait(ownerId, scheduleId, options = {}) {
  return (await stopScheduledJobAndWaitDetailed(ownerId, scheduleId, options)).accepted;
}

export async function stopAllForUserAndWaitDetailed(ownerId, {
  mode = null,
  removeSchedule = true,
  timeoutMs = LOCAL_STOP_TIMEOUT_MS,
} = {}) {
  const jobs = getUserJobs(ownerId, { mode, includeStopping: true });
  const results = await Promise.all(jobs.map((job) => stopJobAndWait(ownerId, job.key, {
    removeSchedule,
    timeoutMs,
  })));
  return summarizeStopResults(results);
}

export async function stopAllForUserAndWait(ownerId, options = {}) {
  return (await stopAllForUserAndWaitDetailed(ownerId, options)).accepted;
}

export async function stopRunnerAndWaitDetailed(ownerId, options = {}) {
  return stopAllForUserAndWaitDetailed(ownerId, options);
}

export async function stopRunnerAndWait(ownerId, options = {}) {
  return (await stopRunnerAndWaitDetailed(ownerId, options)).accepted > 0;
}

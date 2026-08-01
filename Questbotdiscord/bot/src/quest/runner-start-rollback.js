import { settleWithTimeout } from '../async-settle.js';

const DEFAULT_ROLLBACK_TIMEOUT_MS = 5000;

export async function rollbackStartedRunner(args, {
  getJob,
  stopJob,
  timeoutMs = DEFAULT_ROLLBACK_TIMEOUT_MS,
  reportError = () => {},
} = {}) {
  if (typeof getJob !== 'function' || typeof stopJob !== 'function') {
    throw new TypeError('Runner start rollback requires getJob and stopJob');
  }

  const job = getJob(args?.jobKey);
  if (!job) return { found: false, stopped: false, settled: true };

  let stopped = false;
  try {
    stopped = Boolean(stopJob(args.ownerId, args.jobKey, { removeSchedule: false }));
    if (!stopped) throw new Error(`Started runner ${args.jobKey} could not be stopped`);
    await settleWithTimeout([job.done], timeoutMs, {
      pendingCount: () => (getJob(args.jobKey) ? 1 : 0),
      timeoutMessage: () => `Started runner ${args.jobKey} did not settle after rollback`,
    });
    return { found: true, stopped: true, settled: true };
  } catch (error) {
    try {
      reportError(error, { jobKey: args?.jobKey, stopped });
    } catch {}
    return { found: true, stopped, settled: false, error };
  }
}

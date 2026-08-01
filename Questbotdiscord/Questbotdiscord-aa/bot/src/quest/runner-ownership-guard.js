import { resolveRunnerExecutionContext } from './runner-execution-context.js';
import { getScheduledRunnerClaim } from './scheduled-worker-claims.js';

export class RunnerOwnershipLostError extends Error {
  constructor(jobKey, scheduleId) {
    super(`Runner ${jobKey} no longer owns scheduled row ${scheduleId ?? 'unavailable'}`);
    this.name = 'RunnerOwnershipLostError';
    this.code = 'RUNNER_OWNERSHIP_LOST';
    this.jobKey = jobKey;
    this.scheduleId = scheduleId;
  }
}

export function assertRunnerMutationOwnership(jobKey, now = Date.now()) {
  const context = resolveRunnerExecutionContext(jobKey);
  if (!context) throw new RunnerOwnershipLostError(jobKey, null);
  if (context.mode !== 'scheduled' || !context.workerHolder) return true;
  const scheduleId = Number(context.scheduleId);
  const claim = Number.isInteger(scheduleId) && scheduleId > 0
    ? getScheduledRunnerClaim(scheduleId, now)
    : null;
  if (claim?.holder !== context.workerHolder) {
    throw new RunnerOwnershipLostError(jobKey, context.scheduleId ?? null);
  }
  return true;
}

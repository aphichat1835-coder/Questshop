import { config } from '../config.js';
import { reportCriticalError } from '../error-reporter.js';
import {
  decryptRunnerToken,
  listScheduledRunners,
  updateScheduledRunner,
} from '../scheduled-runner-store.js';
import {
  applyRunnerRecoveryPlan,
  planRunnerRecovery,
} from './recovery-planner.js';
import {
  getRunnerState,
  listRunnerStates,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';

const MAX_RUNNERS_PER_OWNER = 10;

function durableJobKey(row) {
  return `scheduled:${row.id}`;
}

function failDurableRestore(row, message) {
  const jobKey = durableJobKey(row);
  if (!getRunnerState(jobKey)) return;
  transitionRunnerState(jobKey, RUNNER_STATE.FAILED, {
    lastError: message,
    metadata: { stage: 'restore' },
    stateSource: 'scheduled-restore-failure',
  });
}

function recordSkippedRestore(row, message) {
  updateScheduledRunner(row.id, { lastError: message });
  failDurableRestore(row, message);
}

function failOrphanedScheduledStates(rows) {
  const validScheduleIds = new Set(rows.map((row) => Number(row.id)));
  for (const state of listRunnerStates({ activeOnly: true, limit: 500 })) {
    if (state.mode !== 'scheduled') continue;
    if (state.state === RUNNER_STATE.STOPPING) continue;
    if (validScheduleIds.has(Number(state.schedule_id))) continue;
    transitionRunnerState(state.job_key, RUNNER_STATE.FAILED, {
      lastError: 'Persisted runner state has no matching scheduled runner row',
      metadata: { stage: 'restore-reconcile' },
      stateSource: 'scheduled-restore-reconcile',
    });
  }
}

export function buildScheduledRestorePlan(row, now = new Date()) {
  const jobKey = durableJobKey(row);
  const current = getRunnerState(jobKey);
  const recoveryPlan = planRunnerRecovery(current, now);
  if (current) applyRunnerRecoveryPlan(jobKey, recoveryPlan);
  return {
    jobKey,
    current,
    recoveryPlan,
    initialNextCheckAt: recoveryPlan.initialNextCheckAt ?? row.next_check_at ?? null,
  };
}

async function restoreRow({ row, client, startRunner, ownerCount, now, workerHolder }) {
  const restore = buildScheduledRestorePlan(row, now);
  const token = decryptRunnerToken(row, config.runnerTokenSecret);
  await startRunner({
    jobKey: restore.jobKey,
    ownerId: row.owner_id,
    userToken: token,
    channelId: row.channel_id,
    client,
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
    initialNextCheckAt: restore.initialNextCheckAt,
    recoveryPlan: restore.recoveryPlan,
    workerHolder,
  });
  return ownerCount + 1;
}

function ownerCounts(value) {
  if (value instanceof Map) return new Map(value);
  return new Map(Object.entries(value ?? {}));
}

export async function restoreScheduledRunnerRows(client, startRunner, {
  rows = listScheduledRunners(),
  reconciliationRows = rows,
  existingAccountIds = [],
  existingOwnerCounts = new Map(),
  now = new Date(),
  workerHolder = null,
} = {}) {
  failOrphanedScheduledStates(reconciliationRows);
  if (!rows.length) return { restored: 0, failed: 0 };

  if (!config.runnerTokenSecret || config.runnerTokenSecret.length < 16) {
    const message = 'Restore skipped: RUNNER_TOKEN_SECRET is unavailable or too short';
    for (const row of rows) recordSkippedRestore(row, message);
    return { restored: 0, failed: rows.length };
  }

  let restored = 0;
  let failed = 0;
  const restoredByOwner = ownerCounts(existingOwnerCounts);
  const restoredAccounts = new Set(existingAccountIds.filter(Boolean));

  for (const row of rows) {
    const ownerCount = restoredByOwner.get(row.owner_id) ?? 0;
    if (ownerCount >= MAX_RUNNERS_PER_OWNER) {
      failed++;
      recordSkippedRestore(row, 'Restore skipped: owner runner limit exceeded');
      continue;
    }
    if (row.account_id && restoredAccounts.has(row.account_id)) {
      failed++;
      recordSkippedRestore(row, 'Restore skipped: Discord account already restored');
      continue;
    }

    try {
      const nextOwnerCount = await restoreRow({
        row,
        client,
        startRunner,
        ownerCount,
        now,
        workerHolder,
      });
      restored++;
      restoredByOwner.set(row.owner_id, nextOwnerCount);
      if (row.account_id) restoredAccounts.add(row.account_id);
    } catch (error) {
      failed++;
      const message = `Restore failed: ${error.message}`;
      updateScheduledRunner(row.id, { lastError: message });
      failDurableRestore(row, message);
      await reportCriticalError(`Restore Scheduled Runner #${row.id}`, error);
    }
  }

  console.log(`♻️ Scheduled Runners restored: ${restored}, failed: ${failed}`);
  return { restored, failed };
}

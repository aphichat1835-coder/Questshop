import { config } from './config.js';
import {
  backupDatabaseSlot,
  clearInactiveDatabaseBackupSlots,
  DATABASE_BACKUP_SLOT_COUNT,
  getLatestDatabaseBackupAt,
} from './db.js';
import {
  reportError,
  reportIncident,
  reportRecovery,
  safeErrorMessage,
} from './error-reporter.js';
import { INCIDENT } from './incident-catalog.js';
import { nextDailyTime } from './runner-schedule.js';
import { settleWithTimeout } from './async-settle.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
export const BACKUP_RETRY_MS = 15 * 60 * 1000;
export const BACKUP_FAST_RETRY_LIMIT = 3;
export const BACKUP_FAILURE_THRESHOLD = 3;
export const BACKUP_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const BACKUP_INCIDENT_SCOPE = 'database-backup';
const monitoringStartedAt = Date.now();
let backupTimeout = null;
let workerStopping = false;
const activeTasks = new Set();
const backupHealth = {
  state: config.databaseBackupEnabled ? 'unknown' : 'disabled',
  lastSuccessAt: getLatestDatabaseBackupAt(),
  consecutiveFailures: 0,
  fastRetryAttempts: 0,
  incidentOpen: false,
  recoveryPending: false,
  lastError: null,
  nextAttemptAt: null,
};

if (backupHealth.lastSuccessAt) backupHealth.state = 'healthy';

function trackTask(promise) {
  activeTasks.add(promise);
  void promise.then(
    () => activeTasks.delete(promise),
    () => activeTasks.delete(promise),
  );
  return promise;
}

function backupAgeMs(now = new Date()) {
  const baseline = backupHealth.lastSuccessAt
    ? new Date(backupHealth.lastSuccessAt).getTime()
    : monitoringStartedAt;
  return Math.max(0, now.getTime() - baseline);
}

function backupAgeHours(now = new Date()) {
  return Math.round((backupAgeMs(now) / 3_600_000) * 10) / 10;
}

function normalizedRetention() {
  return Math.min(DATABASE_BACKUP_SLOT_COUNT, config.databaseBackupRetention);
}

function backupSlotForDate(now, retention) {
  const dayNumber = Math.floor(now.getTime() / MILLISECONDS_PER_DAY);
  return ((dayNumber % retention) + retention) % retention;
}

export async function runDatabaseBackup(now = new Date()) {
  if (!config.databaseBackupEnabled) return null;
  const retention = normalizedRetention();
  const slotIndex = backupSlotForDate(now, retention);
  const destination = await backupDatabaseSlot(slotIndex);
  await clearInactiveDatabaseBackupSlots(retention);

  console.log(`💾 Database backup completed → slot ${slotIndex + 1}/${retention}`);
  return destination;
}

function shouldEscalateBackupFailure(now) {
  return backupHealth.consecutiveFailures >= BACKUP_FAILURE_THRESHOLD
    || backupAgeMs(now) >= BACKUP_MAX_AGE_MS;
}

function backupIncidentContext(now) {
  return {
    consecutiveFailures: backupHealth.consecutiveFailures,
    lastSuccessAt: backupHealth.lastSuccessAt,
    backupAgeHours: backupAgeHours(now),
    storageMode: config.storageProfile.mode,
  };
}

function recoveryCompleted(result) {
  return ['delivered', 'not_open', 'logged_only'].includes(result?.state);
}

function incidentIsTracked(result) {
  return [
    'delivered',
    'suppressed',
    'retry_deferred',
    'delivery_unknown',
    'permanent_failure',
  ].includes(result?.state);
}

export async function runBackupAttempt({
  now = new Date(),
  backupFn = runDatabaseBackup,
  reportErrorFn = reportError,
  reportIncidentFn = reportIncident,
  reportRecoveryFn = reportRecovery,
} = {}) {
  if (!config.databaseBackupEnabled) {
    backupHealth.state = 'disabled';
    return { ok: true, skipped: true, destination: null };
  }

  try {
    const destination = await backupFn(now);
    backupHealth.state = 'healthy';
    backupHealth.lastSuccessAt = now.toISOString();
    backupHealth.consecutiveFailures = 0;
    backupHealth.fastRetryAttempts = 0;
    backupHealth.lastError = null;

    let recovery = null;
    if (backupHealth.incidentOpen || backupHealth.recoveryPending) {
      recovery = await reportRecoveryFn({
        code: INCIDENT.BACKUP_PROTECTION_LOST,
        scope: BACKUP_INCIDENT_SCOPE,
        context: backupIncidentContext(now),
      });
      if (recoveryCompleted(recovery)) {
        backupHealth.incidentOpen = false;
        backupHealth.recoveryPending = false;
      } else {
        backupHealth.incidentOpen = true;
        backupHealth.recoveryPending = true;
      }
    }

    return {
      ok: true,
      skipped: false,
      destination,
      recovery,
    };
  } catch (error) {
    backupHealth.state = 'degraded';
    backupHealth.consecutiveFailures++;
    backupHealth.lastError = safeErrorMessage(error);
    reportErrorFn('Database backup attempt', error, {
      context: backupIncidentContext(now),
    });

    let incident = null;
    if (shouldEscalateBackupFailure(now)) {
      incident = await reportIncidentFn({
        code: INCIDENT.BACKUP_PROTECTION_LOST,
        error,
        scope: BACKUP_INCIDENT_SCOPE,
        source: 'Database backup protection',
        context: backupIncidentContext(now),
      });
      if (incidentIsTracked(incident)) backupHealth.incidentOpen = true;
    }
    return { ok: false, skipped: false, error, incident };
  }
}

function clearBackupTimer() {
  if (!backupTimeout) return;
  clearTimeout(backupTimeout);
  backupTimeout = null;
}

function scheduleAfter(delay, label) {
  if (workerStopping || !config.databaseBackupEnabled) return;
  clearBackupTimer();
  backupHealth.nextAttemptAt = new Date(Date.now() + delay).toISOString();
  console.log(`💾 Database backup ${label} in ${Math.floor(delay / 3_600_000)}h ${Math.floor((delay % 3_600_000) / 60_000)}m`);

  backupTimeout = setTimeout(() => {
    backupTimeout = null;
    trackTask((async () => {
      const result = await runBackupAttempt();
      if (result.ok) {
        scheduleDatabaseBackup();
        return;
      }
      if (backupHealth.fastRetryAttempts < BACKUP_FAST_RETRY_LIMIT) {
        backupHealth.fastRetryAttempts++;
        scheduleAfter(BACKUP_RETRY_MS, `fast retry ${backupHealth.fastRetryAttempts}/${BACKUP_FAST_RETRY_LIMIT}`);
        return;
      }
      backupHealth.fastRetryAttempts = 0;
      scheduleDatabaseBackup();
    })());
  }, delay);
  backupTimeout.unref?.();
}

function scheduleDatabaseBackup() {
  if (workerStopping || !config.databaseBackupEnabled) return;
  const next = nextDailyTime(3, new Date(), config.timezone);
  scheduleAfter(Math.max(0, next.getTime() - Date.now()), 'scheduled');
}

export function startWorker() {
  workerStopping = false;
  if (!config.databaseBackupEnabled) {
    backupHealth.state = 'disabled';
    backupHealth.nextAttemptAt = null;
    console.log('💾 Database backup scheduler disabled — DATABASE_BACKUP_ENABLED is false');
    return;
  }

  if (config.storageProfile.warning) {
    console.warn(`⚠️ Storage: ${config.storageProfile.warning}`);
  }
  scheduleDatabaseBackup();
}

export async function stopWorker(timeoutMs = null) {
  workerStopping = true;
  clearBackupTimer();
  backupHealth.nextAttemptAt = null;

  await settleWithTimeout(activeTasks, timeoutMs, {
    pendingCount: () => activeTasks.size,
    timeoutMessage: (count) => (
      `Database backup shutdown timed out with ${count} task(s) pending`
    ),
  });
  console.log('💾 Database backup scheduler stopped');
}

export function getBackupHealthStatus(now = new Date()) {
  return {
    enabled: config.databaseBackupEnabled,
    state: backupHealth.state,
    lastSuccessAt: backupHealth.lastSuccessAt,
    backupAgeHours: config.databaseBackupEnabled ? backupAgeHours(now) : null,
    consecutiveFailures: backupHealth.consecutiveFailures,
    fastRetryAttempts: backupHealth.fastRetryAttempts,
    fastRetryLimit: BACKUP_FAST_RETRY_LIMIT,
    incidentOpen: backupHealth.incidentOpen,
    recoveryPending: backupHealth.recoveryPending,
    lastError: backupHealth.lastError,
    nextAttemptAt: backupHealth.nextAttemptAt,
    threshold: BACKUP_FAILURE_THRESHOLD,
    maxAgeHours: BACKUP_MAX_AGE_MS / 3_600_000,
  };
}

export function resetBackupHealthForTests({
  state = config.databaseBackupEnabled ? 'unknown' : 'disabled',
  lastSuccessAt = null,
  consecutiveFailures = 0,
  fastRetryAttempts = 0,
  incidentOpen = false,
  recoveryPending = false,
  lastError = null,
  nextAttemptAt = null,
} = {}) {
  clearBackupTimer();
  backupHealth.state = state;
  backupHealth.lastSuccessAt = lastSuccessAt;
  backupHealth.consecutiveFailures = consecutiveFailures;
  backupHealth.fastRetryAttempts = fastRetryAttempts;
  backupHealth.incidentOpen = incidentOpen;
  backupHealth.recoveryPending = recoveryPending;
  backupHealth.lastError = lastError;
  backupHealth.nextAttemptAt = nextAttemptAt;
  workerStopping = false;
}

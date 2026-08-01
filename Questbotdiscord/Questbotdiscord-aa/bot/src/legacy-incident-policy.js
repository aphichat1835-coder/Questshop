import { INCIDENT } from './incident-catalog.js';

const IMMEDIATE_SOURCE_CODES = new Map([
  ['Client startup', INCIDENT.CLIENT_STARTUP_FAILED],
  ['Database backup', INCIDENT.BACKUP_PROTECTION_LOST],
  ['Discord login', INCIDENT.DISCORD_LOGIN_FAILED],
  ['Discord session invalidated', INCIDENT.DISCORD_SESSION_INVALIDATED],
  ['Health server', INCIDENT.HEALTH_SERVER_BIND_FAILED],
  ['Runtime lease', INCIDENT.RUNTIME_LEASE_LOST],
  ['Uncaught exception', INCIDENT.UNCAUGHT_EXCEPTION],
  ['Unhandled rejection', INCIDENT.UNHANDLED_REJECTION],
]);

function safeMessage(error) {
  return String(error?.message ?? error ?? '');
}

export function classifyLegacyIncident(source, error, emergency = undefined) {
  const normalizedSource = String(source ?? 'Unknown source');
  const message = safeMessage(error);

  if (emergency === false) return null;
  if (emergency === true) {
    return {
      code: INCIDENT.SYSTEM_FAILURE,
      threshold: 1,
      scope: normalizedSource,
      context: { component: normalizedSource },
    };
  }

  const immediateCode = IMMEDIATE_SOURCE_CODES.get(normalizedSource);
  if (immediateCode) {
    return { code: immediateCode, threshold: 1, scope: normalizedSource, context: {} };
  }

  if (normalizedSource.startsWith('Restore Scheduled Runner')) {
    const decryptFailure = /decrypt|cipher|authenticate data|runner token secret|token secret/i.test(message);
    return {
      code: INCIDENT.RUNNER_RESTORE_SYSTEM_FAILED,
      threshold: 3,
      scope: 'scheduled-runner-restore',
      context: {
        total: 1,
        restored: 0,
        failed: 1,
        decryptFailures: decryptFailure ? 1 : 0,
        duplicateAccounts: 0,
      },
    };
  }

  if (normalizedSource === 'Quest API compatibility') {
    if (/unknown events/i.test(message)) return null;
    if (/endpoints unavailable/i.test(message)) {
      return {
        code: INCIDENT.QUEST_API_TRANSPORT_OUTAGE,
        threshold: 3,
        scope: 'quest-api-transport',
        context: {
          endpointCount: 2,
          consecutiveFailures: 1,
          statusCode: error?.status,
          durationMinutes: 0,
        },
      };
    }
    if (
      error?.name === 'QuestCompatibilityError'
      || /schema changed|could not be parsed|missing a valid id/i.test(message)
    ) {
      return {
        code: INCIDENT.QUEST_API_SCHEMA_INCOMPATIBLE,
        threshold: 1,
        scope: 'quest-api-schema',
        context: {
          endpoint: error?.path,
          schemaIssueCount: 1,
          questCount: 0,
        },
      };
    }
  }

  return null;
}

export function accumulateLegacyContext(code, contexts) {
  if (code === INCIDENT.RUNNER_RESTORE_SYSTEM_FAILED) {
    return contexts.reduce((summary, context) => ({
      total: summary.total + (context.total ?? 0),
      restored: summary.restored + (context.restored ?? 0),
      failed: summary.failed + (context.failed ?? 0),
      decryptFailures: summary.decryptFailures + (context.decryptFailures ?? 0),
      duplicateAccounts: summary.duplicateAccounts + (context.duplicateAccounts ?? 0),
    }), {
      total: 0,
      restored: 0,
      failed: 0,
      decryptFailures: 0,
      duplicateAccounts: 0,
    });
  }

  if (code === INCIDENT.QUEST_API_TRANSPORT_OUTAGE) {
    const latest = contexts.at(-1) ?? {};
    return {
      endpointCount: Math.max(...contexts.map((item) => item.endpointCount ?? 0), 0),
      consecutiveFailures: contexts.length,
      statusCode: latest.statusCode,
      durationMinutes: latest.durationMinutes ?? 0,
    };
  }

  return contexts.at(-1) ?? {};
}

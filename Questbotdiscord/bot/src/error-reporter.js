import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import {
  allowlistedIncidentContext,
  getIncidentDefinition,
} from './incident-catalog.js';
import {
  accumulateLegacyContext,
  classifyLegacyIncident,
} from './legacy-incident-policy.js';
import { redactText } from './redaction.js';
import { executeDiscordWebhook } from './webhook-delivery.js';

const incidentState = new Map();
const legacyCounters = new Map();
const LEGACY_WINDOW_MS = 10 * 60_000;
const FAILED_DELIVERY_RETRY_MS = 60_000;
const CLOSED_INCIDENT_RETENTION_MS = 24 * 60 * 60_000;
const FAILED_INCIDENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const OPEN_INCIDENT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_INCIDENT_STATE_ENTRIES = 256;
const IN_FLIGHT_INCIDENT_STATES = new Set(['delivering', 'recovering']);
const INCIDENT_EVICTION_PRIORITY = new Map([
  ['recovered', 0],
  ['delivery_failed', 1],
  ['delivery_unknown', 1],
  ['new', 1],
  ['open', 2],
  ['recovery_pending', 2],
]);
const SENSITIVE_KEY = /authorization|token|secret|cookie|captcha|email|webhook|cipher|password|(?:api|private|encryption|access|signing)[_.-]?key/i;

const reporterStatus = {
  lastDeliveryAt: null,
  lastDeliveryState: 'never',
  suppressedIncidents: 0,
};

function sanitizeValue(value, seen = new WeakSet(), depth = 0) {
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 5) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, seen, depth + 1));
  }

  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? '[REDACTED]'
      : sanitizeValue(item, seen, depth + 1);
  }
  return output;
}

function printable(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(sanitizeValue(value));
  } catch {
    return String(value);
  }
}

export function redactSensitive(value) {
  return redactText(printable(value), {
    scanLimit: 10_000,
    outputLimit: 8000,
  });
}

export function safeErrorMessage(error) {
  return redactSensitive(error?.message ?? error ?? 'Unknown error').slice(0, 1200);
}

function safeErrorStack(error) {
  const stack = redactSensitive(error?.stack ?? '');
  if (!stack) return '';
  return stack.split('\n').slice(0, 4).join('\n').slice(0, 1800);
}

function codeBlock(value, limit) {
  const safe = String(value || 'No additional detail')
    .replaceAll('```', '`\u200b``')
    .slice(0, limit);
  return `\`\`\`\n${safe}\n\`\`\``;
}

function runtimeField() {
  const service = redactSensitive(process.env.RENDER_SERVICE_NAME || 'NeverDie Quest Bot');
  const region = redactSensitive(process.env.RENDER_REGION || 'unknown');
  return `${service}\nNode ${process.version} · PID ${process.pid}\nRegion: ${region}`.slice(0, 1024);
}

function deployField() {
  const commit = redactSensitive(process.env.RENDER_GIT_COMMIT || 'unknown').slice(0, 12);
  const instance = redactSensitive(process.env.RENDER_INSTANCE_ID || 'unknown');
  return `Commit: ${commit}\nInstance: ${instance}`.slice(0, 1024);
}

function incidentIdentity(code, scope) {
  return `${code}:${String(scope || 'system').slice(0, 120)}`;
}

function createIncidentId() {
  return `NQB-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

function canDeliverEmergencyWebhook() {
  const allowTestWebhook = process.env.ALLOW_TEST_WEBHOOK === 'true';
  if (process.env.QUESTBOT_TEST_MODE === 'true') return allowTestWebhook;
  return process.env.NODE_TEST_WORKER_ID == null || allowTestWebhook;
}

function contextField(code, context) {
  const allowed = allowlistedIncidentContext(code, context);
  if (Object.keys(allowed).length === 0) return null;
  return codeBlock(redactSensitive(allowed), 900);
}

function incidentFields({ code, incidentId, status, context, occurrences }) {
  const definition = getIncidentDefinition(code);
  const fields = [
    { name: 'สถานะ', value: status === 'RECOVERED' ? 'RECOVERED' : 'CRITICAL · DETECTED', inline: true },
    { name: 'เหตุการณ์', value: code, inline: true },
    { name: 'Incident ID', value: incidentId, inline: true },
    { name: 'ผลกระทบ', value: definition.impact.slice(0, 1024), inline: false },
    { name: 'สิ่งที่ควรทำ', value: definition.action.slice(0, 1024), inline: false },
    { name: 'Runtime', value: runtimeField(), inline: false },
    { name: 'Deployment', value: deployField(), inline: false },
  ];
  if (occurrences > 1) {
    fields.push({ name: 'เกิดซ้ำ', value: `${occurrences} ครั้ง`, inline: true });
  }
  const safeContext = contextField(code, context);
  if (safeContext) fields.push({ name: 'Context', value: safeContext, inline: false });
  return fields;
}

function fitIncidentEmbedText(title, details, fields, footerText) {
  const boundedFields = fields.map((field) => ({ ...field }));
  const fixedLength = () => title.length + footerText.length + boundedFields.reduce(
    (total, field) => total + field.name.length + field.value.length,
    0,
  );
  let overflow = Math.max(0, fixedLength() + 8 - 6000);
  for (let index = boundedFields.length - 1; index >= 0 && overflow > 0; index--) {
    const removable = Math.max(0, boundedFields[index].value.length - 1);
    const removed = Math.min(removable, overflow);
    if (removed > 0) {
      boundedFields[index].value = boundedFields[index].value.slice(0, -removed);
      overflow -= removed;
    }
  }
  const descriptionBudget = Math.max(8, Math.min(4096, 6000 - fixedLength()));
  return {
    fields: boundedFields,
    description: codeBlock(details, Math.max(0, descriptionBudget - 8)),
  };
}

export function buildIncidentWebhookPayload({
  code,
  error = null,
  context = {},
  incidentId = createIncidentId(),
  status = 'DETECTED',
  occurrences = 1,
} = {}) {
  const definition = getIncidentDefinition(code);
  const details = status === 'RECOVERED'
    ? 'ระบบกลับมาทำงานภายในเกณฑ์ที่กำหนดแล้ว'
    : [safeErrorMessage(error), safeErrorStack(error)].filter(Boolean).join('\n');
  const title = `${status === 'RECOVERED' ? '✅' : '🚨'} ${definition.title}`;
  const footerText = 'NeverDie Quest Bot · Backend Incident Log';
  const fitted = fitIncidentEmbedText(
    title,
    details,
    incidentFields({ code, incidentId, status, context, occurrences }),
    footerText,
  );

  return {
    username: 'Quest Bot Backend',
    allowed_mentions: { parse: [] },
    embeds: [{
      title,
      description: fitted.description,
      color: status === 'RECOVERED' ? 0x57F287 : 0xED4245,
      fields: fitted.fields,
      footer: { text: footerText },
      timestamp: new Date().toISOString(),
    }],
  };
}

function logWebhookDeliveryFailure(code, incidentId, result) {
  console.error(
    `❌ [Incident delivery ${code} ${incidentId}]`,
    redactSensitive(result),
  );
}

export function reportError(source, error, { context = {} } = {}) {
  const safeSource = redactSensitive(source || 'Unknown source').slice(0, 256);
  const safeMessage = redactSensitive(error?.stack || error?.message || error);
  const safeContext = redactSensitive(sanitizeValue(context));
  console.error(`❌ [${safeSource}]`, safeMessage, safeContext === '{}' ? '' : safeContext);
  return { state: 'logged' };
}

function incidentReferenceTime(incident, now) {
  return incident.recoveredAt
    ?? incident.recoveryAttemptAt
    ?? incident.lastSeenAt
    ?? incident.firstSeenAt
    ?? now;
}

function incidentEvictionPriority(incident) {
  return INCIDENT_EVICTION_PRIORITY.get(incident.state) ?? 1;
}

function pruneIncidentCapacity() {
  if (incidentState.size <= MAX_INCIDENT_STATE_ENTRIES) return;
  const candidates = [...incidentState.entries()]
    .filter(([, incident]) => !IN_FLIGHT_INCIDENT_STATES.has(incident.state))
    .sort(([, left], [, right]) => {
      const priorityDifference = incidentEvictionPriority(left) - incidentEvictionPriority(right);
      return priorityDifference || incidentReferenceTime(left, 0) - incidentReferenceTime(right, 0);
    });
  while (incidentState.size > MAX_INCIDENT_STATE_ENTRIES && candidates.length) {
    const [key] = candidates.shift();
    incidentState.delete(key);
  }
}

function pruneReporterState(now) {
  for (const [key, incident] of incidentState) {
    const reference = incidentReferenceTime(incident, now);
    if (['open', 'recovery_pending'].includes(incident.state)) {
      if (now - reference >= OPEN_INCIDENT_MAX_AGE_MS) incidentState.delete(key);
      continue;
    }
    if (IN_FLIGHT_INCIDENT_STATES.has(incident.state)) continue;
    const retention = incident.state === 'recovered'
      ? CLOSED_INCIDENT_RETENTION_MS
      : FAILED_INCIDENT_RETENTION_MS;
    if (now - reference >= retention) incidentState.delete(key);
  }
  pruneIncidentCapacity();

  for (const [key, counter] of legacyCounters) {
    if (now - (counter.lastSeenAt ?? counter.firstSeenAt ?? now) >= LEGACY_WINDOW_MS) {
      legacyCounters.delete(key);
    }
  }
}

function suppressIncident(incident, code, now, state = 'suppressed') {
  incident.occurrences++;
  incident.lastSeenAt = now;
  if (incident.state === 'recovering') incident.reoccurredDuringRecovery = true;
  reporterStatus.suppressedIncidents++;
  return {
    state,
    code,
    incidentId: incident.incidentId,
    occurrences: incident.occurrences,
  };
}

function newIncident(code, scope, now) {
  return {
    incidentId: createIncidentId(),
    code,
    scope,
    occurrences: 0,
    firstSeenAt: now,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastDeliveredAt: null,
    nextRetryAt: null,
    reoccurredDuringRecovery: false,
    state: 'new',
  };
}

function reopenRecoveryPendingIncident(incident) {
  incident.recoveryDelivery = null;
  incident.recoveryAttemptAt = null;
  incident.nextRecoveryRetryAt = null;
  incident.recoveredAt = null;
}

function suppressionForExistingIncident(incident, code, now) {
  if (!incident) return null;
  if (['delivering', 'recovering', 'open'].includes(incident.state)) {
    return suppressIncident(incident, code, now);
  }
  const retryPending = ['delivery_failed', 'delivery_unknown'].includes(incident.state)
    && now < (incident.nextRetryAt ?? 0);
  return retryPending
    ? suppressIncident(incident, code, now, 'retry_deferred')
    : null;
}

function reserveIncident(code, scope, now) {
  pruneReporterState(now);
  const key = incidentIdentity(code, scope);
  let incident = incidentState.get(key);
  const suppression = suppressionForExistingIncident(incident, code, now);
  if (suppression) return { suppression };

  if (!incident || incident.state === 'recovered') {
    incident = newIncident(code, scope, now);
  } else if (incident.state === 'recovery_pending') {
    reopenRecoveryPendingIncident(incident);
  }

  incident.occurrences++;
  incident.lastSeenAt = now;
  incident.lastAttemptAt = now;
  incident.state = 'delivering';
  incidentState.set(key, incident);
  return { key, incident };
}

async function deliverWebhook(payload, fallbackReason) {
  try {
    return await executeDiscordWebhook({
      url: config.logWebhookUrl,
      payload,
    });
  } catch (deliveryError) {
    return {
      state: 'delivery_unknown',
      attempts: 0,
      reason: deliveryError?.name || fallbackReason,
    };
  }
}

function recordDeliveryStatus(code, incidentId, delivery, now) {
  reporterStatus.lastDeliveryState = delivery.state;
  if (delivery.state === 'delivered') {
    reporterStatus.lastDeliveryAt = new Date(now).toISOString();
    return;
  }
  logWebhookDeliveryFailure(code, incidentId, delivery);
}

function applyIncidentDelivery(key, incident, delivery, now) {
  incident.delivery = delivery;
  if (delivery.state === 'delivered') {
    incident.state = 'open';
    incident.lastDeliveredAt = now;
    incident.nextRetryAt = null;
  } else {
    incident.state = delivery.state === 'permanent_failure'
      ? 'delivery_failed'
      : 'delivery_unknown';
    incident.nextRetryAt = now + FAILED_DELIVERY_RETRY_MS;
  }
  incidentState.set(key, incident);
  pruneReporterState(now);
}

function incidentDeliveryResult(code, incident, delivery) {
  return {
    state: delivery.state,
    code,
    incidentId: incident.incidentId,
    occurrences: incident.occurrences,
  };
}

export async function reportIncident({
  code,
  error,
  context = {},
  scope = 'system',
  source = code,
  now = Date.now(),
  notify = true,
  log = true,
} = {}) {
  getIncidentDefinition(code);
  if (log) reportError(source, error, { context: allowlistedIncidentContext(code, context) });
  if (!notify || !canDeliverEmergencyWebhook()) return { state: 'logged_only', code };

  const reservation = reserveIncident(code, scope, now);
  if (reservation.suppression) return reservation.suppression;

  const { key, incident } = reservation;
  const payload = buildIncidentWebhookPayload({
    code,
    error,
    context,
    incidentId: incident.incidentId,
    occurrences: incident.occurrences,
  });
  const delivery = await deliverWebhook(payload, 'unexpected delivery failure');
  applyIncidentDelivery(key, incident, delivery, now);
  recordDeliveryStatus(code, incident.incidentId, delivery, now);
  return incidentDeliveryResult(code, incident, delivery);
}

export async function reportRecovery({
  code,
  context = {},
  scope = 'system',
  now = Date.now(),
} = {}) {
  getIncidentDefinition(code);
  pruneReporterState(now);
  const key = incidentIdentity(code, scope);
  const incident = incidentState.get(key);

  if (!incident || incident.state === 'recovered') return { state: 'not_open', code };
  if (['delivery_failed', 'delivery_unknown'].includes(incident.state)) {
    incident.state = 'recovered';
    incident.recoveredAt = now;
    incidentState.set(key, incident);
    pruneReporterState(now);
    return { state: 'not_open', code, incidentId: incident.incidentId };
  }
  if (incident.state === 'delivering') {
    return { state: 'retry_deferred', code, incidentId: incident.incidentId };
  }
  if (incident.state === 'recovering') {
    return { state: 'recovery_in_progress', code, incidentId: incident.incidentId };
  }
  if (incident.state === 'recovery_pending' && now < (incident.nextRecoveryRetryAt ?? 0)) {
    return { state: 'retry_deferred', code, incidentId: incident.incidentId };
  }
  if (!canDeliverEmergencyWebhook()) {
    incident.state = 'recovered';
    incident.recoveredAt = now;
    incidentState.set(key, incident);
    pruneReporterState(now);
    return { state: 'logged_only', code, incidentId: incident.incidentId };
  }

  incident.state = 'recovering';
  incident.recoveryAttemptAt = now;
  incidentState.set(key, incident);

  const payload = buildIncidentWebhookPayload({
    code,
    context,
    incidentId: incident.incidentId,
    status: 'RECOVERED',
    occurrences: incident.occurrences,
  });
  const delivery = await deliverWebhook(payload, 'unexpected recovery delivery failure');

  incident.recoveryDelivery = delivery;
  let resultState = delivery.state;
  if (incident.reoccurredDuringRecovery) {
    incident.reoccurredDuringRecovery = false;
    incident.recoveredAt = null;
    incident.state = 'open';
    incident.nextRecoveryRetryAt = null;
    resultState = 'reopened';
  } else if (delivery.state === 'delivered') {
    incident.recoveredAt = now;
    incident.state = 'recovered';
    incident.nextRecoveryRetryAt = null;
  } else {
    incident.state = 'recovery_pending';
    incident.nextRecoveryRetryAt = now + FAILED_DELIVERY_RETRY_MS;
  }
  incidentState.set(key, incident);
  pruneReporterState(now);

  recordDeliveryStatus(code, incident.incidentId, delivery, now);
  return { state: resultState, code, incidentId: incident.incidentId };
}

function legacyCounterKey(policy) {
  return `${policy.code}:${policy.scope}`;
}

function collectLegacyEvidence(policy, now) {
  pruneReporterState(now);
  const key = legacyCounterKey(policy);
  let counter = legacyCounters.get(key);
  if (!counter || now - counter.firstSeenAt >= LEGACY_WINDOW_MS) {
    counter = { firstSeenAt: now, contexts: [], count: 0 };
  }
  counter.count++;
  counter.contexts.push(policy.context);
  if (counter.contexts.length > 50) counter.contexts.shift();
  counter.lastSeenAt = now;
  legacyCounters.set(key, counter);
  return { key, counter };
}

export function isEmergencyIncident(source, error) {
  return Boolean(classifyLegacyIncident(source, error, undefined));
}

export function buildEmergencyWebhookPayload(source, error, context = {}) {
  const policy = classifyLegacyIncident(source, error, true);
  return buildIncidentWebhookPayload({
    code: policy.code,
    error,
    context,
  });
}

export async function reportCriticalError(
  source,
  error,
  {
    notify = true,
    emergency = undefined,
    context = {},
    incidentCode = null,
    scope = 'system',
    now = Date.now(),
  } = {},
) {
  if (incidentCode) {
    return reportIncident({
      code: incidentCode,
      error,
      context,
      scope,
      source,
      notify,
      now,
    });
  }

  const policy = classifyLegacyIncident(source, error, emergency);
  if (!policy) return reportError(source, error, { context });
  if (policy.threshold <= 1) {
    return reportIncident({
      code: policy.code,
      error,
      context: { ...policy.context, ...context },
      scope: policy.scope,
      source,
      notify,
      now,
    });
  }

  reportError(source, error, { context: policy.context });
  const { key, counter } = collectLegacyEvidence(policy, now);
  if (counter.count < policy.threshold) {
    return {
      state: 'logged_threshold',
      code: policy.code,
      count: counter.count,
      threshold: policy.threshold,
    };
  }

  legacyCounters.delete(key);
  return reportIncident({
    code: policy.code,
    error,
    context: accumulateLegacyContext(policy.code, counter.contexts),
    scope: policy.scope,
    source,
    notify,
    now,
    log: false,
  });
}

export function getIncidentReporterStatus() {
  pruneReporterState(Date.now());
  const incidents = [...incidentState.values()];
  return {
    webhookConfigured: Boolean(config.logWebhookUrl),
    lastDeliveryAt: reporterStatus.lastDeliveryAt,
    lastDeliveryState: reporterStatus.lastDeliveryState,
    suppressedIncidents: reporterStatus.suppressedIncidents,
    openIncidents: incidents.filter((item) => item.state !== 'recovered').length,
    pendingRecoveries: incidents.filter((item) => item.state === 'recovery_pending').length,
    pendingThresholds: [...legacyCounters.values()].filter((item) => item.count > 0).length,
  };
}

export function resetIncidentReporterStateForTests() {
  incidentState.clear();
  legacyCounters.clear();
  reporterStatus.lastDeliveryAt = null;
  reporterStatus.lastDeliveryState = 'never';
  reporterStatus.suppressedIncidents = 0;
}

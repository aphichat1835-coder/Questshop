import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBootstrapIncidentPayload } from '../src/bootstrap-reporter.js';
import { INCIDENT } from '../src/incident-catalog.js';
import { isPersistentDatabasePath } from '../src/storage-profile.js';
import { executeDiscordWebhook } from '../src/webhook-delivery.js';
import { createFakeDiscordWebhookUrl } from '../test-support/fake-webhook.js';

process.env.QUESTBOT_TEST_MODE = 'true';
process.env.ALLOW_TEST_WEBHOOK = 'true';

const {
  buildIncidentWebhookPayload,
  getIncidentReporterStatus,
  reportIncident,
  reportRecovery,
  resetIncidentReporterStateForTests,
} = await import('../src/error-reporter.js');

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
console.error = () => {};

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function healthIncident(scope, now, message = 'health failure', options = {}) {
  return reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error(message),
    scope,
    now,
    ...options,
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetIncidentReporterStateForTests();
});

test.after(() => {
  console.error = originalConsoleError;
  delete process.env.ALLOW_TEST_WEBHOOK;
});

test('runtime and bootstrap outbound payloads disable every Discord mention parse target', () => {
  const runtimePayload = buildIncidentWebhookPayload({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('@everyone must stay inert'),
  });
  const bootstrapPayload = buildBootstrapIncidentPayload({
    code: INCIDENT.CLIENT_STARTUP_FAILED,
    error: new Error('@everyone must stay inert'),
  });

  assert.deepEqual(runtimePayload.allowed_mentions, { parse: [] });
  assert.deepEqual(bootstrapPayload.allowed_mentions, { parse: [] });
});

test('terminal non-OK webhook responses are drained before returning', async () => {
  let drained = 0;
  const result = await executeDiscordWebhook({
    url: createFakeDiscordWebhookUrl('terminal-drain'),
    payload: { content: 'test' },
    maxAttempts: 1,
    fetchFn: async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      arrayBuffer: async () => { drained++; },
    }),
  });

  assert.equal(result.state, 'permanent_failure');
  assert.equal(drained, 1);
});

test('a new failure during recovery_pending reuses the original incident identity', async () => {
  let request = 0;
  globalThis.fetch = async () => {
    request++;
    return new Response(null, { status: request === 2 ? 400 : 204 });
  };
  const base = Date.now();
  const scope = 'backup:primary';

  const opened = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup unavailable'),
    scope,
    now: base,
  });
  const recovery = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope,
    now: base + 1_000,
  });
  const reopened = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup failed again'),
    scope,
    now: base + 2_000,
  });

  assert.equal(opened.state, 'delivered');
  assert.equal(recovery.state, 'permanent_failure');
  assert.equal(reopened.state, 'delivered');
  assert.equal(reopened.incidentId, opened.incidentId);
  assert.equal(reopened.occurrences, 2);
  assert.equal(request, 3);
});

test('duplicate recovery calls do not inflate failure occurrence or suppression counters', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const base = Date.now();
  const scope = 'health:10000';
  const opened = await healthIncident(scope, base, 'EADDRINUSE');

  const pendingResponse = deferred();
  globalThis.fetch = async () => pendingResponse.promise;
  const recoveryPromise = reportRecovery({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    scope,
    now: base + 1_000,
  });
  await Promise.resolve();

  const before = getIncidentReporterStatus();
  const duplicate = await reportRecovery({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    scope,
    now: base + 1_001,
  });
  const during = getIncidentReporterStatus();

  assert.equal(duplicate.state, 'recovery_in_progress');
  assert.equal(duplicate.incidentId, opened.incidentId);
  assert.equal(during.suppressedIncidents, before.suppressedIncidents);

  pendingResponse.resolve(new Response(null, { status: 204 }));
  const recovered = await recoveryPromise;
  assert.equal(recovered.state, 'delivered');
});

test('unrecovered open incidents expire after the absolute maximum age', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const base = Date.now();
  const first = await healthIncident('health:old', base, 'first failure');
  const afterMaximumAge = base + (31 * 24 * 60 * 60_000);

  await healthIncident('health:new', afterMaximumAge, 'prune trigger');
  const replacement = await healthIncident(
    'health:old',
    afterMaximumAge + 1,
    'old scope failed again',
  );

  assert.notEqual(replacement.incidentId, first.incidentId);
  assert.equal(replacement.occurrences, 1);
});

test('settled incident state remains capped when caller-controlled scopes keep changing', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const base = Date.now();

  for (let index = 0; index < 270; index++) {
    const result = await healthIncident(
      `caller-scope-${index}`,
      base + index,
      `failure ${index}`,
      { log: false },
    );
    assert.equal(result.state, 'delivered');
  }

  assert.ok(getIncidentReporterStatus().openIncidents <= 256);
});

test('capacity pruning evicts recovered incidents before an ongoing open incident', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const base = Date.now();
  const protectedIncident = await healthIncident('protected-open', base, 'ongoing failure');

  await healthIncident('terminal-candidate', base + 1, 'temporary failure');
  const recovery = await reportRecovery({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    scope: 'terminal-candidate',
    now: base + 2,
  });
  assert.equal(recovery.state, 'delivered');

  for (let index = 0; index < 255; index++) {
    await healthIncident(`capacity-noise-${index}`, base + 10 + index, 'new failure', { log: false });
  }

  const duplicate = await healthIncident('protected-open', base + 1_000, 'still failing');
  assert.equal(duplicate.state, 'suppressed');
  assert.equal(duplicate.incidentId, protectedIncident.incidentId);
  assert.ok(getIncidentReporterStatus().openIncidents <= 256);
});

test('relative database paths are never classified as persistent regardless of cwd', () => {
  assert.equal(isPersistentDatabasePath('/var/data/quests.db'), true);
  assert.equal(isPersistentDatabasePath('/var/data/nested/quests.db'), true);
  assert.equal(isPersistentDatabasePath('./var/data/quests.db'), false);
  assert.equal(isPersistentDatabasePath('var/data/quests.db'), false);
  assert.equal(isPersistentDatabasePath(':memory:'), false);
});

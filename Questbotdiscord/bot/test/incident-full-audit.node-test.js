import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ALLOW_TEST_WEBHOOK = 'true';

const { INCIDENT } = await import('../src/incident-catalog.js');
const {
  buildIncidentWebhookPayload,
  reportIncident,
  reportRecovery,
  resetIncidentReporterStateForTests,
} = await import('../src/error-reporter.js');

const originalFetch = globalThis.fetch;

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function embedCharacterCount(embed) {
  return [
    embed.title,
    embed.description,
    embed.footer?.text ?? '',
    ...embed.fields.flatMap((field) => [field.name, field.value]),
  ].reduce((total, value) => total + String(value ?? '').length, 0);
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetIncidentReporterStateForTests();
});

test.after(() => {
  delete process.env.ALLOW_TEST_WEBHOOK;
});

test('incident payload obeys Discord total embed budget with long deployment metadata', () => {
  const previous = {
    service: process.env.RENDER_SERVICE_NAME,
    region: process.env.RENDER_REGION,
    instance: process.env.RENDER_INSTANCE_ID,
  };
  process.env.RENDER_SERVICE_NAME = 'service-'.repeat(300);
  process.env.RENDER_REGION = 'region-'.repeat(300);
  process.env.RENDER_INSTANCE_ID = 'instance-'.repeat(300);

  try {
    const payload = buildIncidentWebhookPayload({
      code: INCIDENT.RUNNER_RESTORE_SYSTEM_FAILED,
      error: new Error('failure-detail-'.repeat(1000)),
      context: {
        total: 999,
        restored: 0,
        failed: 999,
        decryptFailures: 999,
        duplicateAccounts: 999,
      },
    });
    const embed = payload.embeds[0];
    assert.ok(embed.description.length <= 4096);
    assert.ok(embed.fields.every((field) => field.value.length <= 1024));
    assert.ok(embedCharacterCount(embed) <= 6000);
  } finally {
    if (previous.service == null) delete process.env.RENDER_SERVICE_NAME;
    else process.env.RENDER_SERVICE_NAME = previous.service;
    if (previous.region == null) delete process.env.RENDER_REGION;
    else process.env.RENDER_REGION = previous.region;
    if (previous.instance == null) delete process.env.RENDER_INSTANCE_ID;
    else process.env.RENDER_INSTANCE_ID = previous.instance;
  }
});

test('recovery silently closes an incident whose original alert never delivered', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(null, { status: 503 });
  };

  const failed = await reportIncident({
    code: INCIDENT.DISCORD_LOGIN_FAILED,
    error: new Error('login failed before alert delivery'),
    scope: 'runtime:delivery-failed',
    now: 1_000,
  });
  const attemptsAfterIncident = attempts;
  const recovered = await reportRecovery({
    code: INCIDENT.DISCORD_LOGIN_FAILED,
    scope: 'runtime:delivery-failed',
    now: 2_000,
  });

  assert.ok(['delivery_failed', 'delivery_unknown'].includes(failed.state));
  assert.equal(recovered.state, 'not_open');
  assert.equal(recovered.incidentId, failed.incidentId);
  assert.equal(attempts, attemptsAfterIncident);
});

test('a new occurrence during recovery prevents the incident from closing', async () => {
  const recoveryResponse = deferred();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(null, { status: 204 });
    return recoveryResponse.promise;
  };

  const opened = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup protection unavailable'),
    scope: 'database-backup:reoccurrence',
    now: 1_000,
  });
  const recoveryPromise = reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup:reoccurrence',
    now: 2_000,
  });
  await Promise.resolve();

  const duringRecovery = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup failed again during recovery delivery'),
    scope: 'database-backup:reoccurrence',
    now: 2_001,
  });
  assert.equal(duringRecovery.state, 'suppressed');
  assert.equal(duringRecovery.incidentId, opened.incidentId);

  recoveryResponse.resolve(new Response(null, { status: 204 }));
  const recovered = await recoveryPromise;
  assert.equal(recovered.state, 'reopened');

  const stillOpen = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup remains unavailable'),
    scope: 'database-backup:reoccurrence',
    now: 3_000,
  });
  assert.equal(stillOpen.state, 'suppressed');
  assert.equal(stillOpen.incidentId, opened.incidentId);
  assert.equal(calls, 2);
});

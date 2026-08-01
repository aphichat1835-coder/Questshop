import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ALLOW_TEST_WEBHOOK = 'true';

const { INCIDENT } = await import('../src/incident-catalog.js');
const {
  reportIncident,
  reportRecovery,
  resetIncidentReporterStateForTests,
} = await import('../src/error-reporter.js');

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
console.error = () => {};

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetIncidentReporterStateForTests();
});

test.after(() => {
  console.error = originalConsoleError;
  delete process.env.ALLOW_TEST_WEBHOOK;
});

test('a delivered incident remains open across long runtimes until recovery', async () => {
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  };

  const opened = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup protection unavailable'),
    scope: 'database-backup',
    now: 1_000,
  });
  const repeated = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup protection still unavailable'),
    scope: 'database-backup',
    now: 30 * 24 * 60 * 60_000,
  });
  const recovered = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup',
    now: 30 * 24 * 60 * 60_000 + 1,
  });

  assert.equal(opened.state, 'delivered');
  assert.equal(repeated.state, 'suppressed');
  assert.equal(repeated.incidentId, opened.incidentId);
  assert.equal(recovered.state, 'delivered');
  assert.equal(recovered.incidentId, opened.incidentId);
  assert.equal(payloads.length, 2);
});

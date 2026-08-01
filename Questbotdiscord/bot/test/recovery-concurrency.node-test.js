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

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetIncidentReporterStateForTests();
});

test.after(() => {
  console.error = originalConsoleError;
  delete process.env.ALLOW_TEST_WEBHOOK;
});

test('recovery is deferred until the initial incident delivery settles', async () => {
  const firstResponse = deferred();
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    if (payloads.length === 1) return firstResponse.promise;
    return new Response(null, { status: 204 });
  };

  const opening = reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup protection unavailable'),
    scope: 'database-backup',
    now: 1_000,
  });

  const earlyRecovery = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup',
    now: 1_001,
  });

  assert.equal(earlyRecovery.state, 'retry_deferred');
  assert.equal(payloads.length, 1);

  firstResponse.resolve(new Response(null, { status: 204 }));
  const opened = await opening;
  const recovered = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup',
    now: 1_002,
  });

  assert.equal(opened.state, 'delivered');
  assert.equal(recovered.state, 'delivered');
  assert.equal(recovered.incidentId, opened.incidentId);
  assert.equal(payloads.length, 2);
  assert.match(payloads[0].embeds[0].title, /^🚨/);
  assert.match(payloads[1].embeds[0].title, /^✅/);
});

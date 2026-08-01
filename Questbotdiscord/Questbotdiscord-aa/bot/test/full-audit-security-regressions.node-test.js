import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ALLOW_TEST_WEBHOOK = 'true';

const {
  redactSensitive,
  reportCriticalError,
  resetIncidentReporterStateForTests,
} = await import('../src/error-reporter.js');

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetIncidentReporterStateForTests();
});

test.after(() => {
  delete process.env.ALLOW_TEST_WEBHOOK;
});

test('explicit emergency false keeps an otherwise immediate incident in logs only', async () => {
  let webhookAttempts = 0;
  globalThis.fetch = async () => {
    webhookAttempts++;
    return new Response(null, { status: 204 });
  };

  const result = await reportCriticalError(
    'Uncaught exception',
    new Error('controlled non-emergency fixture'),
    { emergency: false },
  );

  assert.equal(result.state, 'logged');
  assert.equal(webhookAttempts, 0);
});

test('redaction covers API, private, encryption, access and signing key names', () => {
  const redactedObject = redactSensitive({
    apiKey: 'api-key-value-must-not-leak',
    privateKey: 'private-key-value-must-not-leak',
    encryptionKey: 'encryption-key-value-must-not-leak',
    access_key: 'access-key-value-must-not-leak',
    'signing-key': 'signing-key-value-must-not-leak',
    safeLabel: 'visible-value',
  });
  const redactedText = redactSensitive(
    'apiKey=api-text-secret private_key=private-text-secret encryption-key=encryption-text-secret',
  );

  for (const secret of [
    'api-key-value-must-not-leak',
    'private-key-value-must-not-leak',
    'encryption-key-value-must-not-leak',
    'access-key-value-must-not-leak',
    'signing-key-value-must-not-leak',
    'api-text-secret',
    'private-text-secret',
    'encryption-text-secret',
  ]) {
    assert.equal(redactedObject.includes(secret) || redactedText.includes(secret), false);
  }
  assert.match(redactedObject, /visible-value/);
  assert.match(redactedText, /apiKey=\[REDACTED\]/);
  assert.match(redactedText, /private_key=\[REDACTED\]/);
  assert.match(redactedText, /encryption-key=\[REDACTED\]/);
});

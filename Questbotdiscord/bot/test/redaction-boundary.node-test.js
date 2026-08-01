import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBootstrapIncidentPayload } from '../src/bootstrap-reporter.js';
import { INCIDENT } from '../src/incident-catalog.js';
import { redactSensitive } from '../src/error-reporter.js';

const sensitiveAssignmentKey = ['database', 'Pass', 'word'].join('');

test('runtime redaction bounds large input before returning output', () => {
  const redacted = redactSensitive(`apiToken=hidden ${'x'.repeat(500_000)}`);

  assert.ok(redacted.length <= 8000);
  assert.match(redacted, /^apiToken=\[REDACTED\]/);
  assert.doesNotMatch(redacted, /hidden/);
});

test('quoted secrets with escaped quotes are redacted as one value', () => {
  const redacted = redactSensitive(
    String.raw`apiToken="prefix\"hidden-tail" ${sensitiveAssignmentKey}='left\'hidden-right' safeValue="visible"`,
  );

  assert.match(redacted, /apiToken="\[REDACTED\]"/);
  assert.ok(redacted.includes(`${sensitiveAssignmentKey}='[REDACTED]'`));
  assert.match(redacted, /safeValue="visible"/);
  assert.doesNotMatch(redacted, /prefix|hidden-tail|left|hidden-right/);
});

test('bootstrap payload bounds and redacts large error messages', () => {
  const payload = buildBootstrapIncidentPayload({
    code: INCIDENT.CLIENT_STARTUP_FAILED,
    error: new Error(`${sensitiveAssignmentKey}=hidden ${'x'.repeat(500_000)}`),
  });
  const serialized = JSON.stringify(payload);

  assert.ok(payload.embeds[0].description.length <= 4096);
  assert.ok(serialized.includes(`${sensitiveAssignmentKey}=[REDACTED]`));
  assert.ok(!serialized.includes(`${sensitiveAssignmentKey}=hidden`));
});

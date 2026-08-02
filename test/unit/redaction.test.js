import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../src/shared/redaction.js';

test('structured redaction removes secret fields', () => {
  const output = redact({ token: 'abc', nested: { database_url: 'postgresql://secret@db/x' } });
  assert.equal(output.token, '[REDACTED]');
  assert.equal(output.nested.database_url, '[REDACTED]');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../src/shared/redaction.js';

test('structured redaction removes secret fields', () => {
  const databaseUrl = ['postgresql', '://', 'sensitive', '@', 'db.invalid', '/test'].join('');
  const output = redact({ token: 'abc', nested: { database_url: databaseUrl } });
  assert.equal(output.token, '[REDACTED]');
  assert.equal(output.nested.database_url, '[REDACTED]');
});

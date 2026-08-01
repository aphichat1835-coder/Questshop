import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationFingerprint } from '../src/quest/authorization-fingerprint.js';

test('invalid header records fall back to the anonymous fingerprint', () => {
  const anonymous = authorizationFingerprint();
  const invalid = authorizationFingerprint({ 'bad header\nname': 'value' });

  assert.equal(invalid, anonymous);
});

test('valid authorization headers retain account-specific grouping', () => {
  const first = authorizationFingerprint({ Authorization: 'account-a' });
  const same = authorizationFingerprint(new Headers({ Authorization: 'account-a' }));
  const different = authorizationFingerprint({ Authorization: 'account-b' });

  assert.equal(first, same);
  assert.notEqual(first, different);
});

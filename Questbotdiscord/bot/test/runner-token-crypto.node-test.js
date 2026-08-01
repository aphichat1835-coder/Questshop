import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptRunnerToken,
  encryptRunnerToken,
} from '../src/runner-token-crypto.js';

const secret = 'test-secret-at-least-16-characters';

function rowFromEncrypted(encrypted, overrides = {}) {
  return {
    owner_id: 'owner-1',
    account_id: 'account-1',
    token_ciphertext: encrypted.ciphertext,
    token_iv: encrypted.iv,
    token_tag: encrypted.tag,
    token_salt: encrypted.salt,
    ...overrides,
  };
}

test('runner token encryption round-trips without exposing plaintext', () => {
  const token = 'discord-user-token';
  const encrypted = encryptRunnerToken(token, secret, 'owner-1', 'account-1');
  assert.notEqual(encrypted.ciphertext, token);
  assert.equal(decryptRunnerToken(rowFromEncrypted(encrypted), secret), token);
});

test('wrong secret cannot decrypt a runner token', () => {
  const encrypted = encryptRunnerToken('token', secret, 'owner-1', 'account-1');
  assert.throws(
    () => decryptRunnerToken(rowFromEncrypted(encrypted), 'another-secret-at-least-16'),
  );
});

test('encrypted token is bound to its owner and Discord account', () => {
  const encrypted = encryptRunnerToken('token', secret, 'owner-1', 'account-1');
  assert.throws(
    () => decryptRunnerToken(rowFromEncrypted(encrypted, { owner_id: 'owner-2' }), secret),
  );
});

test('short encryption secrets are rejected', () => {
  assert.throws(
    () => encryptRunnerToken('token', 'too-short', 'owner-1', 'account-1'),
    /อย่างน้อย 16/,
  );
});

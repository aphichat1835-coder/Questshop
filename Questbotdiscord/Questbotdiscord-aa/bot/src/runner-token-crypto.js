import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

function requireSecret(secret) {
  if (!secret || secret.length < 16) {
    throw new Error('RUNNER_TOKEN_SECRET ต้องมีอย่างน้อย 16 ตัวอักษร');
  }
}

function deriveKey(secret, salt) {
  requireSecret(secret);
  return scryptSync(secret, salt, 32);
}

export function encryptRunnerToken(token, secret, ownerId, accountId) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  cipher.setAAD(Buffer.from(`${ownerId}:${accountId}`));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    salt: salt.toString('base64'),
  };
}

export function decryptRunnerToken(row, secret) {
  const salt = Buffer.from(row.token_salt, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(secret, salt),
    Buffer.from(row.token_iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(`${row.owner_id}:${row.account_id}`));
  decipher.setAuthTag(Buffer.from(row.token_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.token_ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

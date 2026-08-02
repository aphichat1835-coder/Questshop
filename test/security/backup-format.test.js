import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { downloadAndDecryptBackup } from '../../src/adapters/s3/backup.js';

const MAGIC = Buffer.from('QSBK1');
const key = Buffer.alloc(32, 11);
const keyring = { current: 1, keys: { 1: key.toString('base64') } };

function fixture(plaintext, { tamperTag = false } = {}) {
  const nonce = Buffer.alloc(12, 3);
  const header = Buffer.from(JSON.stringify({ keyVersion: 1, nonce: nonce.toString('base64'),
    schemaVersion: 11, gitSha: 'test-sha' }));
  const prefix = Buffer.concat([MAGIC, Buffer.alloc(4)]);
  prefix.writeUInt32BE(header.length, MAGIC.length);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tamperTag) tag[0] ^= 0xff;
  const body = Buffer.concat([prefix, header, encrypted, tag]);
  return { body, checksum: createHash('sha256').update(body).digest('hex') };
}

async function decode(value, expectedChecksum = value.checksum) {
  const chunks = [value.body.subarray(0, 3), value.body.subarray(3, 19),
    value.body.subarray(19, 47), value.body.subarray(47)];
  const s3 = { send: async () => ({ Body: Readable.from(chunks), ContentLength: value.body.length }) };
  const result = await downloadAndDecryptBackup({ env: { S3_BUCKET: 'test',
    BACKUP_ENCRYPTION_KEYS_JSON: keyring }, objectKey: 'fixture.qsbk', expectedChecksum, s3 });
  const clear = [];
  for await (const chunk of result.dumpStream) clear.push(chunk);
  return { metadata: result.metadata, plaintext: Buffer.concat(clear) };
}

test('QSBK1 restore streams arbitrary chunks and verifies checksum plus GCM tag', async () => {
  const clear = Buffer.from('pg_dump custom fixture'.repeat(4096));
  const value = fixture(clear);
  const decoded = await decode(value);
  assert.deepEqual(decoded.plaintext, clear);
  assert.equal(decoded.metadata.schemaVersion, 11);
  await assert.rejects(() => decode(value, '0'.repeat(64)), /checksum mismatch/);
  await assert.rejects(() => decode(fixture(clear, { tamperTag: true })), /authenticate data/);
});

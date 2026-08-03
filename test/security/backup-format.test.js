import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers';
import { createEncryptedBackup, downloadAndDecryptBackup } from '../../src/adapters/s3/backup.js';

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

test('backup creation streams a pg_dump through encryption then verifies uploaded object and manifest', async () => {
  const objects = new Map();
  const s3 = { send: async (command) => {
    const { Key, Body } = command.input;
    if (Body) {
      if (Buffer.isBuffer(Body)) objects.set(Key, Body);
      else {
        const chunks = [];
        for await (const chunk of Body) chunks.push(Buffer.from(chunk));
      objects.set(Key, Buffer.concat(chunks));
      }
      return {};
    }
    const object = objects.get(Key);
    if (!object) throw new Error(`missing fake S3 object: ${Key}`);
    if (command.constructor.name === 'GetObjectCommand') {
      return { Body: Readable.from([object]), ContentLength: object.length };
    }
    return { ContentLength: object.length, VersionId: 'fake-version-1' };
  } };
  const clear = Buffer.from('custom-format-pg-dump'.repeat(8_192));
  const spawnProcess = (binary, args, options) => {
    assert.equal(binary, '/usr/local/bin/pg_dump');
    assert.ok(args.includes('--format=custom'));
    assert.equal(options.env.PGPASSWORD, 'backup-password');
    const child = new EventEmitter();
    child.stdout = Readable.from([clear]);
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const upload = async (_client, params) => {
    const chunks = [];
    for await (const chunk of params.Body) chunks.push(Buffer.from(chunk));
    objects.set(params.Key, Buffer.concat(chunks));
  };
  const env = { S3_BUCKET: 'test', GIT_SHA: 'test-sha',
    DATABASE_BACKUP_URL: 'postgresql://backup-user:backup-password@db.example.test:5432/questshop',
    BACKUP_ENCRYPTION_KEYS_JSON: keyring };
  const backup = await createEncryptedBackup({ env, schemaVersion: 13, reason: 'test',
    backupId: '019fc530-2000-7000-8000-000000000001', s3, spawnProcess, upload });
  assert.equal(backup.objectVersion, 'fake-version-1');
  assert.ok(objects.has(backup.objectKey));
  assert.ok(objects.has(backup.manifestKey));
  const manifest = JSON.parse(objects.get(backup.manifestKey).toString('utf8'));
  assert.equal(manifest.appVersion, '0.1.0');
  assert.equal(manifest.engineVersion, '1.0.0');
  assert.equal(manifest.objectVersion, 'fake-version-1');
  assert.equal(manifest.sourceDbFingerprint.length, 64);
  const restored = await downloadAndDecryptBackup({ env, objectKey: backup.objectKey,
    expectedChecksum: backup.checksum, s3 });
  const chunks = [];
  for await (const chunk of restored.dumpStream) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), clear);
  assert.equal(restored.metadata.schemaVersion, 13);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  completeSetupValues,
  parseEnvironmentText,
  upsertEnvironmentText,
  writeEnvironmentFile,
} from '../../src/config/setup-environment.js';

const certificate = '-----BEGIN CERTIFICATE-----\nTEST-CA\n-----END CERTIFICATE-----\n';
const external = Object.freeze({
  NODE_ENV: 'production',
  DISCORD_BOT_TOKEN: 'x'.repeat(25),
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_GUILD_ID: '123456789012345679',
  OWNER_ID: '123456789012345680',
  DATABASE_POOL_URL: 'postgresql://runtime:password@host/db?sslmode=verify-full',
  DATABASE_DIRECT_URL: 'postgresql://migrator:password@host/db?sslmode=verify-full',
  DATABASE_SSL_CA_INPUT: certificate,
});

function deterministicRandom() {
  let value = 0;
  return (size) => Buffer.alloc(size, ++value);
}

test('first-run setup creates distinct persistent secrets and safe defaults', async () => {
  const result = await completeSetupValues({
    fileValues: external,
    processValues: {},
    randomBytesFunction: deterministicRandom(),
  });
  assert.deepEqual(result.missing, []);
  assert.equal(result.validated.BACKUP_ENABLED, false);
  assert.equal(result.generated.STATUS_TOKEN.length, 64);
  const data = JSON.parse(result.generated.DATA_ENCRYPTION_KEYS_JSON).keys['1'];
  const voucher = JSON.parse(result.generated.VOUCHER_HMAC_KEYS_JSON).keys['1'];
  const backup = JSON.parse(result.generated.BACKUP_ENCRYPTION_KEYS_JSON).keys['1'];
  assert.equal(new Set([data, voucher, backup]).size, 3);
  assert.equal(Buffer.from(result.generated.DATABASE_SSL_CA_BASE64, 'base64').toString(), certificate.trim());
});

test('re-running setup preserves existing secret values without generating replacements', async () => {
  const first = await completeSetupValues({
    fileValues: external,
    processValues: {},
    randomBytesFunction: deterministicRandom(),
  });
  const fileValues = { ...external, ...first.generated };
  const second = await completeSetupValues({
    fileValues,
    processValues: {},
    randomBytesFunction() {
      throw new Error('must not generate replacement secrets');
    },
  });
  assert.equal(second.generated.STATUS_TOKEN, first.generated.STATUS_TOKEN);
  assert.equal(second.generated.DATA_ENCRYPTION_KEYS_JSON, first.generated.DATA_ENCRYPTION_KEYS_JSON);
  assert.equal(second.generated.VOUCHER_HMAC_KEYS_JSON, first.generated.VOUCHER_HMAC_KEYS_JSON);
  assert.equal(second.generated.BACKUP_ENCRYPTION_KEYS_JSON, first.generated.BACKUP_ENCRYPTION_KEYS_JSON);
});

test('setup rejects a process-level key conflict instead of rotating durable secrets', async () => {
  const first = await completeSetupValues({
    fileValues: external,
    processValues: {},
    randomBytesFunction: deterministicRandom(),
  });
  await assert.rejects(() => completeSetupValues({
    fileValues: { ...external, ...first.generated },
    processValues: createOverrideValues(),
  }), /refusing implicit secret rotation/);
});

function createOverrideValues() {
  const key = Buffer.alloc(32, 9).toString('base64');
  const keyring = JSON.stringify({ current: 1, keys: { 1: key } });
  return {
    STATUS_TOKEN: 'f'.repeat(64),
    DATA_ENCRYPTION_KEYS_JSON: keyring,
    VOUCHER_HMAC_KEYS_JSON: keyring,
    BACKUP_ENCRYPTION_KEYS_JSON: keyring,
  };
}

test('environment writer updates keys atomically with owner-only permissions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'questshop-setup-'));
  const target = path.join(directory, '.env');
  try {
    const original = '# external\nDISCORD_CLIENT_ID=old\n';
    const written = await writeEnvironmentFile(pathToFileURL(target), original, {
      DISCORD_CLIENT_ID: '123456789012345678',
      STATUS_TOKEN: 'a'.repeat(64),
      DATA_ENCRYPTION_KEYS_JSON: JSON.stringify({ current: 1, keys: { 1: 'b'.repeat(44) } }),
    });
    assert.equal(written.path, target);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const parsed = parseEnvironmentText(await readFile(target, 'utf8'));
    assert.equal(parsed.DISCORD_CLIENT_ID, '123456789012345678');
    assert.equal(parsed.STATUS_TOKEN, 'a'.repeat(64));
    assert.deepEqual(JSON.parse(parsed.DATA_ENCRYPTION_KEYS_JSON), {
      current: 1,
      keys: { 1: 'b'.repeat(44) },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('environment text upsert preserves unrelated comments and settings', () => {
  const result = upsertEnvironmentText('# keep\nPORT=4000\n', {
    BACKUP_ENABLED: 'false',
  });
  assert.match(result, /^# keep\nPORT=4000/m);
  assert.match(result, /BACKUP_ENABLED=false/);
});

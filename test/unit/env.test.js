import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvironment, loadRuntimeEnvironment } from '../../src/config/env.js';
import { parsePromotionBasisPoints } from '../../src/discord/interactions/router.js';

const key = Buffer.alloc(32, 7).toString('base64');

function databaseUrl(role) {
  const url = new URL(['postgresql', ':', '/', '/db.example.invalid'].join(''));
  url.username = role;
  url.hostname = 'db.example.invalid';
  url.pathname = '/questshop_test';
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

function backupSettings() {
  return {
    BACKUP_ENABLED: 'true', DATABASE_BACKUP_URL: databaseUrl('backup'),
    S3_ENDPOINT: new URL('/questshop-backups', 'https://s3.example.invalid').toString(),
    S3_BUCKET: 'questshop-backups', S3_ACCESS_KEY_ID: ['access', 'key'].join('-'),
    S3_SECRET_ACCESS_KEY: ['test', 'secret'].join('-'),
    BACKUP_ENCRYPTION_KEYS_JSON: JSON.stringify({ current: 1, keys: { 1: key } }),
  };
}

const base = {
  NODE_ENV: 'production', DISCORD_BOT_TOKEN: 'x'.repeat(25), DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_GUILD_ID: '123456789012345679', OWNER_ID: '123456789012345680', STATUS_TOKEN: 'x'.repeat(32),
  DATABASE_POOL_URL: databaseUrl('runtime'),
  DATABASE_DIRECT_URL: databaseUrl('migrator'), DATABASE_SSL_CA_BASE64: 'Y2E=',
  GIT_SHA: 'a'.repeat(40),
  DATA_ENCRYPTION_KEYS_JSON: JSON.stringify({ current: 1, keys: { 1: key } }),
  VOUCHER_HMAC_KEYS_JSON: JSON.stringify({ current: 1, keys: { 1: key } }),
};

test('backup settings can be explicitly disabled without requiring S3 and backup database secrets', () => {
  const env = loadEnvironment({ ...base, BACKUP_ENABLED: 'false' });
  assert.equal(env.BACKUP_ENABLED, false);
  assert.equal(env.DATABASE_BACKUP_URL, undefined);
});

test('runtime configuration neither requires nor retains deployment/restore credentials and defaults concurrency to two', () => {
  const { DATABASE_DIRECT_URL: _migrationUrl, DATABASE_RESTORE_URL: _restoreUrl, ...runtimeBase } = base;
  const env = loadRuntimeEnvironment({ ...runtimeBase, BACKUP_ENABLED: 'false' });
  assert.equal(env.DATABASE_DIRECT_URL, undefined);
  assert.equal(env.DATABASE_RESTORE_URL, undefined);
  assert.equal(env.RUNNER_CONCURRENCY, 2);
  assert.equal(loadRuntimeEnvironment({ ...base, BACKUP_ENABLED: 'false' }).DATABASE_DIRECT_URL, undefined);
});

test('runtime backup needs no restore credential while deployment tooling does', () => {
  const backup = backupSettings();
  assert.equal(loadRuntimeEnvironment({ ...base, ...backup }).DATABASE_RESTORE_URL, undefined);
  assert.throws(() => loadEnvironment({ ...base, ...backup }), /DATABASE_RESTORE_URL/);
});

test('non-production defaults backups off when no backup settings are supplied', () => {
  const env = loadEnvironment({ ...base, NODE_ENV: 'development' });
  assert.equal(env.BACKUP_ENABLED, undefined);
});

test('enabled backup settings fail as configuration validation when incomplete', () => {
  assert.throws(() => loadEnvironment({ ...base, BACKUP_ENABLED: 'true' }), /BACKUP_ENABLED=true requires/);
});

test('boolean configuration rejects typos instead of silently disabling a safety feature', () => {
  assert.throws(() => loadEnvironment({ ...base, BACKUP_ENABLED: 'flase' }));
  assert.throws(() => loadEnvironment({ ...base, PRELAUNCH: 'yes' }));
});

test('production refuses an unknown deployment revision', () => {
  assert.throws(() => loadEnvironment({ ...base, GIT_SHA: 'unknown' }), /GIT_SHA/);
});

test('promotion percentages are parsed as exact basis points without floating point', () => {
  assert.equal(parsePromotionBasisPoints('12'), 1200);
  assert.equal(parsePromotionBasisPoints('12.3'), 1230);
  assert.equal(parsePromotionBasisPoints('12.34'), 1234);
  for (const invalid of ['12.345', '-1', '100.01', '1e2', '', '  ']) {
    assert.throws(() => parsePromotionBasisPoints(invalid));
  }
});

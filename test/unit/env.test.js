import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvironment } from '../../src/config/env.js';
import { parsePromotionBasisPoints } from '../../src/discord/interactions/router.js';

const key = Buffer.alloc(32, 7).toString('base64');
const base = {
  NODE_ENV: 'production', DISCORD_BOT_TOKEN: 'x'.repeat(25), DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_GUILD_ID: '123456789012345679', OWNER_ID: '123456789012345680', STATUS_TOKEN: 'x'.repeat(32),
  DATABASE_POOL_URL: 'postgresql://runtime:password@host/db?sslmode=verify-full',
  DATABASE_DIRECT_URL: 'postgresql://migrator:password@host/db?sslmode=verify-full', DATABASE_SSL_CA_BASE64: 'Y2E=',
  GIT_SHA: 'a'.repeat(40),
  DATA_ENCRYPTION_KEYS_JSON: JSON.stringify({ current: 1, keys: { 1: key } }),
  VOUCHER_HMAC_KEYS_JSON: JSON.stringify({ current: 1, keys: { 1: key } }),
};

test('backup settings can be explicitly disabled without requiring S3 and backup database secrets', () => {
  const env = loadEnvironment({ ...base, BACKUP_ENABLED: 'false' });
  assert.equal(env.BACKUP_ENABLED, false);
  assert.equal(env.DATABASE_BACKUP_URL, undefined);
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

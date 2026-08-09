import test from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDatabase, renewRuntimeLease } from '../../src/bootstrap/startup.js';
import { FencingLostError } from '../../src/shared/errors.js';

test('runtime startup rejects changed key material before role validation or ingress', async () => {
  const calls = [];
  const health = { checks: {} };
  const mismatch = Object.assign(new Error('different bytes under key version one'), { code: 'KEY_SENTINEL_MISMATCH' });
  await assert.rejects(() => openRuntimeDatabase({ NODE_ENV: 'production' }, health, {
    getRuntimePool: () => ({ query: async () => ({ rows: [] }) }),
    validateSchemaCompatibility: async () => calls.push('schema'),
    validateMigrationChecksums: async () => calls.push('checksums'),
    validateKeyringCoverage: async () => calls.push('coverage'),
    validateKeyringSentinels: async () => { calls.push('sentinel'); throw mismatch; },
    validateRuntimeRole: async () => { calls.push('role'); return { violations: [] }; },
  }), (error) => error.code === 'KEY_SENTINEL_MISMATCH');
  assert.deepEqual(calls, ['schema', 'checksums', 'coverage', 'sentinel']);
  assert.equal(health.checks.keyrings, undefined);
});

test('runtime lease retries a transient database failure but self-fences immediately when ownership is lost', async () => {
  const abortController = new AbortController();
  let attempts = 0;
  const lease = await renewRuntimeLease({ abortController, env: { DISCORD_GUILD_ID: 'guild' }, holder: 'holder',
    pool: {}, lease: { fencing_token: 7 }, wait: async () => {}, renew: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient database outage');
      return { fencing_token: 7 };
    } });
  assert.equal(attempts, 3);
  assert.equal(lease.fencing_token, 7);
  await assert.rejects(() => renewRuntimeLease({ abortController, env: { DISCORD_GUILD_ID: 'guild' }, holder: 'holder',
    pool: {}, lease: { fencing_token: 7 }, wait: async () => { throw new Error('wait must not run'); },
    renew: async () => { throw new FencingLostError('runtime'); } }), /lost ownership/);
});

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { validateKeyringCoverage } from '../../src/bootstrap/keyring-coverage.js';
import { createTestPool } from '../fixtures/postgres.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });
const ring = (versions) => ({ current: versions.at(-1),
  keys: Object.fromEntries(versions.map((version) => [version, Buffer.alloc(32, version).toString('base64')])) });

test('backup keyring is optional when no verified backups exist', async () => {
  const emptyPool = { query: async () => ({ rows: [] }) };
  const result = await validateKeyringCoverage(emptyPool, {
    DATA_ENCRYPTION_KEYS_JSON: ring([1]),
    VOUCHER_HMAC_KEYS_JSON: ring([1]),
  });
  assert.deepEqual(result, { data: [], vouchers: [], backups: [] });
});

test('startup refuses removal of encryption, voucher HMAC, and backup keys still required by durable rows', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7(); const receiver = uuidv7();
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id) VALUES($1,1,$2,2,$3,$4,'1234','ACTIVE','owner',$5)`,
  [receiver, Buffer.alloc(10), Buffer.alloc(12), Buffer.alloc(16), trace]);
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id) VALUES($1,'key-user','PAYMENT_QUEUED',3,$2,$3,'1234',$4)`,
  [uuidv7(), Buffer.alloc(32), receiver, trace]);
  await pool.query(`INSERT INTO backup_runs(id,backup_type,state,object_key,git_sha,encryption_key_version,
    completed_at) VALUES($1,'DAILY','VERIFIED','backup.qsbk','sha',4,clock_timestamp())`, [uuidv7()]);
  const complete = { DATA_ENCRYPTION_KEYS_JSON: ring([1, 2]), VOUCHER_HMAC_KEYS_JSON: ring([1, 3]),
    BACKUP_ENCRYPTION_KEYS_JSON: ring([1, 4]) };
  assert.deepEqual(await validateKeyringCoverage(pool, complete), { data: [2], vouchers: [3], backups: [4] });
  await assert.rejects(() => validateKeyringCoverage(pool, { ...complete,
    VOUCHER_HMAC_KEYS_JSON: ring([1]) }), (error) => error.code === 'KEYRING_VERSION_MISSING'
      && error.keyring === 'VOUCHER_HMAC');
});

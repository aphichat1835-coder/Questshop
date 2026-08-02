import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { submitVoucher } from '../../src/domain/payments/service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('same voucher submitted concurrently has one durable owner', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiver = uuidv7(); const trace = uuidv7();
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id) VALUES($1,1,$2,1,$3,$4,'1234','ACTIVE','owner',$5)`,
  [receiver, Buffer.alloc(10), Buffer.alloc(12), Buffer.alloc(16), trace]);
  const key = Buffer.alloc(32, 7).toString('base64');
  const env = { PRELAUNCH: true, DATA_ENCRYPTION_KEYS_JSON: { current: 1, keys: { 1: key } },
    VOUCHER_HMAC_KEYS_JSON: { current: 1, keys: { 1: key } } };
  const input = { discordUserId: 'voucher-user', voucherUrl: 'https://gift.truemoney.com/campaign/?v=ABCDEFGHIJKLMNOP', env };
  const makeContext = (idempotencyKey) => createContext({ actorType: 'CUSTOMER', actorId: 'voucher-user',
    guildId: '10000000000000002', idempotencyKey });
  const results = await Promise.all([
    submitVoucher(input, makeContext('voucher-a'), { pool }),
    submitVoucher(input, makeContext('voucher-b'), { pool }),
  ]);
  assert.equal(new Set(results.map((result) => result.topup.id)).size, 1);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM topups')).rows[0].count), 1);
});

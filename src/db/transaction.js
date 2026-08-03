import { setTimeout as delay } from 'node:timers/promises';
import { getRuntimePool } from './pools.js';
import { secureJitter } from '../shared/random.js';

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);
const ISOLATION_LEVELS = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);

function fullJitter(attempt, capMs = 1000, baseMs = 25) {
  return secureJitter(Math.min(capMs, baseMs * (2 ** attempt)));
}

async function rollbackOrRelease(client, error) {
  try {
    await client.query('ROLLBACK');
    return false;
  } catch {
    client.release(true);
    if (!isRetryableTransactionError(error)) throw error;
    return true;
  }
}

export function isRetryableTransactionError(error) {
  return RETRYABLE_SQLSTATES.has(error?.code);
}

export async function withTransaction({
  pool = getRuntimePool(),
  isolation = 'READ COMMITTED',
  maxAttempts = 3,
  deadlineMs = 5_000,
} = {}, callback) {
  const normalizedIsolation = String(isolation).toUpperCase();
  if (!ISOLATION_LEVELS.has(normalizedIsolation)) throw new TypeError('invalid isolation level');
  const started = performance.now();
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (performance.now() - started >= deadlineMs) break;
    const client = await pool.connect();
    let destroyed = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${normalizedIsolation}`);
      const transactionTime = (await client.query(
        'SELECT transaction_timestamp() AS transaction_time',
      )).rows[0].transaction_time;
      const result = await callback(client, Object.freeze({ attempt, transactionTime }));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      lastError = error;
      destroyed = await rollbackOrRelease(client, error);
      if (destroyed) continue;
      if (!isRetryableTransactionError(error) || attempt + 1 >= maxAttempts) throw error;
    } finally {
      if (!destroyed) client.release();
    }
    await delay(fullJitter(attempt), undefined, { ref: false });
  }
  throw lastError ?? new Error('transaction deadline exceeded');
}

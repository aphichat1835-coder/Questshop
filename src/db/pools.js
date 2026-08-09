import pg from 'pg';
import { loadEnvironment } from '../config/env.js';

const { Pool } = pg;
let runtimePool;
let directPool;

function commonOptions(env, connectionString) {
  const databaseUrl = new URL(connectionString);
  const sslDisabledForTest = env.NODE_ENV === 'test' && databaseUrl.searchParams.get('sslmode') === 'disable';
  const ssl = sslDisabledForTest ? false : {
    ...(env.DATABASE_SSL_CA_BASE64
      ? { ca: Buffer.from(env.DATABASE_SSL_CA_BASE64, 'base64').toString('utf8') }
      : {}),
    rejectUnauthorized: true,
  };
  return {
    ssl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
    options: '-c timezone=UTC -c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=15000',
  };
}

export function getRuntimePool(env = loadEnvironment()) {
  runtimePool ??= new Pool({
    ...commonOptions(env, env.DATABASE_POOL_URL),
    connectionString: env.DATABASE_POOL_URL,
    max: 8,
    application_name: 'questshop-runtime',
  });
  return runtimePool;
}

export function getDirectPool(env = loadEnvironment()) {
  directPool ??= new Pool({
    ...commonOptions(env, env.DATABASE_DIRECT_URL),
    connectionString: env.DATABASE_DIRECT_URL,
    max: 1,
    application_name: 'questshop-migrator',
  });
  return directPool;
}

export async function closeDirectPool() {
  if (!directPool) return;
  const pool = directPool;
  directPool = undefined;
  await pool.end();
}

export async function closePools() {
  const pools = [runtimePool, directPool].filter(Boolean);
  runtimePool = undefined;
  directPool = undefined;
  await Promise.allSettled(pools.map((pool) => pool.end()));
}

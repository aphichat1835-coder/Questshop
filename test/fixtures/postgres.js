import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';

const { Pool } = pg;

export async function createTestPool() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  const pool = new Pool({ connectionString: url, max: 12 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const directory = new URL('../../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((item) => item.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, directory), 'utf8'));
  }
  return pool;
}

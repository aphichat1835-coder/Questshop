import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * libpq tools (pg_dump/pg_restore) do not inherit node-postgres's in-memory
 * CA.  Materialize the configured CA only for the child process and remove it
 * even when that process, the stream, or S3 fails.
 */
export async function withPostgresRootCertificate(env, action, {
  makeTempDirectory = mkdtemp,
  write = writeFile,
  remove = rm,
} = {}) {
  const certificate = Buffer.from(env.DATABASE_SSL_CA_BASE64 ?? '', 'base64');
  if (!certificate.length) {
    throw Object.assign(new Error('DATABASE_SSL_CA_BASE64 is required for PostgreSQL tooling'), {
      code: 'POSTGRES_CA_UNAVAILABLE',
    });
  }
  const directory = await makeTempDirectory(join(tmpdir(), 'questshop-pg-ca-'));
  const path = join(directory, 'root.crt');
  try {
    await write(path, certificate, { mode: 0o600 });
    return await action(path);
  } finally {
    await remove(directory, { recursive: true, force: true }).catch(() => {});
  }
}

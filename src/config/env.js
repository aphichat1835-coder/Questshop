import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/);
const booleanText = z.enum(['true', 'false']).transform((value) => value === 'true');
const keyringSchema = z.object({
  current: z.coerce.number().int().positive(),
  keys: z.record(z.string(), z.string().min(40)),
}).superRefine((value, ctx) => {
  if (!value.keys[String(value.current)]) {
    ctx.addIssue({ code: 'custom', message: 'current key version is missing from keys' });
  }
  for (const [version, encoded] of Object.entries(value.keys)) {
    let decoded;
    try {
      decoded = Buffer.from(encoded, 'base64');
    } catch {
      decoded = null;
    }
    if (!/^\d+$/.test(version) || decoded?.length !== 32) {
      ctx.addIssue({ code: 'custom', message: `key ${version} must be a 32-byte base64 value` });
    }
  }
});

function jsonKeyring(value, ctx) {
  try {
    return keyringSchema.parse(JSON.parse(value));
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: `invalid keyring: ${error.message}` });
    return z.NEVER;
  }
}

const environmentFields = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TIMEZONE: z.literal('Asia/Bangkok').default('Asia/Bangkok'),
  PRELAUNCH: booleanText.default('true'),
  DISCORD_BOT_TOKEN: z.string().min(20),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  OWNER_ID: snowflake,
  STATUS_TOKEN: z.string().min(32),
  DATABASE_POOL_URL: z.string().url(),
  DATABASE_DIRECT_URL: z.string().url(),
  BACKUP_ENABLED: booleanText.optional(),
  DATABASE_BACKUP_URL: z.string().url().optional(),
  DATABASE_RESTORE_URL: z.string().url().optional(),
  DATABASE_SSL_CA_BASE64: z.string().min(1).optional(),
  PG_DUMP_PATH: z.string().min(1).default('pg_dump'),
  PG_RESTORE_PATH: z.string().min(1).default('pg_restore'),
  DATA_ENCRYPTION_KEYS_JSON: z.string().transform(jsonKeyring),
  VOUCHER_HMAC_KEYS_JSON: z.string().transform(jsonKeyring),
  BACKUP_ENCRYPTION_KEYS_JSON: z.string().optional().transform((value, ctx) => value == null ? undefined : jsonKeyring(value, ctx)),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default('auto'),
  S3_BUCKET: z.string().min(3).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: booleanText.default('true'),
  RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(2),
  RUNNER_CONCURRENCY_HARD_MAX: z.coerce.number().int().min(1).max(5).default(5),
  GIT_SHA: z.string().min(1).default('unknown'),
  DISCORD_CLIENT_VERSION: z.string().regex(/^\d+(?:\.\d+)+$/).default('1.0.9267'),
  DISCORD_CHROME_VERSION: z.string().regex(/^\d+(?:\.\d+)+$/).default('138.0.7204.251'),
  DISCORD_ELECTRON_VERSION: z.string().regex(/^\d+(?:\.\d+)+$/).default('37.6.0'),
  DISCORD_BUILD_NUMBER: z.coerce.number().int().nonnegative().default(572700),
  DISCORD_NATIVE_BUILD_NUMBER: z.coerce.number().int().nonnegative().default(47491),
  DISCORD_LOCALE: z.string().min(2).max(20).default('en-US'),
};

function refineEnvironment(value, ctx, { requireDirect }) {
  if (requireDirect && !value.DATABASE_DIRECT_URL) {
    ctx.addIssue({ code: 'custom', path: ['DATABASE_DIRECT_URL'], message: 'DATABASE_DIRECT_URL is required' });
  }
  if (value.RUNNER_CONCURRENCY > value.RUNNER_CONCURRENCY_HARD_MAX) {
    ctx.addIssue({ code: 'custom', message: 'RUNNER_CONCURRENCY exceeds hard max' });
  }
  if (value.NODE_ENV === 'production' && !/^[0-9a-f]{40}$/i.test(value.GIT_SHA)) {
    ctx.addIssue({ code: 'custom', message: 'GIT_SHA must be the 40-character deployment commit SHA in production' });
  }
  const backupKeys = ['DATABASE_BACKUP_URL', 'DATABASE_RESTORE_URL', 'S3_ENDPOINT', 'S3_BUCKET',
    'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'BACKUP_ENCRYPTION_KEYS_JSON'];
  const backupEnabled = value.BACKUP_ENABLED ?? value.NODE_ENV === 'production';
  if (backupEnabled && backupKeys.some((key) => value[key] == null || value[key] === '')) {
    ctx.addIssue({ code: 'custom', message: 'BACKUP_ENABLED=true requires backup database, S3 and encryption settings' });
  }
  for (const key of ['DATABASE_POOL_URL', ...(requireDirect ? ['DATABASE_DIRECT_URL'] : []), ...(backupEnabled
    ? ['DATABASE_BACKUP_URL', 'DATABASE_RESTORE_URL'] : [])]) {
    if (!value[key]) continue;
    const url = new URL(value[key]);
    if (value.NODE_ENV === 'production' && url.searchParams.get('sslmode') !== 'verify-full') {
      ctx.addIssue({ code: 'custom', message: `${key} must use sslmode=verify-full` });
    }
  }
}

const schema = z.object(environmentFields).superRefine((value, ctx) => refineEnvironment(value, ctx, { requireDirect: true }));
const { DATABASE_DIRECT_URL: _deploymentOnlyDatabaseUrl, ...runtimeEnvironmentFields } = environmentFields;
const runtimeSchema = z.object(runtimeEnvironmentFields)
  .superRefine((value, ctx) => refineEnvironment(value, ctx, { requireDirect: false }));

let cached;
let runtimeCached;

export function loadEnvironment(source = process.env) {
  if (source === process.env && cached) return cached;
  const parsed = schema.parse(source);
  if (source === process.env) cached = Object.freeze(parsed);
  return parsed;
}

export function loadRuntimeEnvironment(source = process.env) {
  if (source === process.env && runtimeCached) return runtimeCached;
  const parsed = runtimeSchema.parse(source);
  if (source === process.env) runtimeCached = Object.freeze(parsed);
  return parsed;
}

export function clearEnvironmentCacheForTests() {
  cached = undefined;
  runtimeCached = undefined;
}

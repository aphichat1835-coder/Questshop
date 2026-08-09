import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const DEPLOYMENT_ONLY_KEYS = new Set(['DATABASE_DIRECT_URL']);

function decodeBundle(raw) {
  if (!raw) return null;
  let values;
  try {
    values = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('QUESTSHOP_SECRET_BUNDLE must be a base64url JSON object');
  }
  if (!values || Array.isArray(values) || typeof values !== 'object') {
    throw new Error('QUESTSHOP_SECRET_BUNDLE must decode to an object');
  }
  return values;
}

function applyRuntimeValues(values) {
  if (!values) return;
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') {
      throw new Error('Runtime environment source contains an invalid entry');
    }
    if (!DEPLOYMENT_ONLY_KEYS.has(key) && process.env[key] == null) process.env[key] = value;
  }
}

try {
  applyRuntimeValues(parseEnv(readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8')));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const bundle = process.env.QUESTSHOP_SECRET_BUNDLE;
applyRuntimeValues(decodeBundle(bundle));
// A stateless runtime may receive a shared legacy bundle. Remove both the
// encoded source and deployment-only URL after importing the runtime allowlist.
delete process.env.QUESTSHOP_SECRET_BUNDLE;
delete process.env.DATABASE_DIRECT_URL;

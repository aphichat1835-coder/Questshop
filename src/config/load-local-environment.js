import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

export function decodeSecretBundle(raw) {
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
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') {
      throw new Error('QUESTSHOP_SECRET_BUNDLE contains an invalid environment entry');
    }
  }
  return values;
}

function loadSecretBundle() {
  const values = decodeSecretBundle(process.env.QUESTSHOP_SECRET_BUNDLE);
  if (!values) return;
  for (const [key, value] of Object.entries(values)) {
    // Explicit deployment variables take precedence. The bundle is intended
    // for stateless hosts, never as an implicit secret-rotation mechanism.
    if (process.env[key] == null) process.env[key] = value;
  }
}

try {
  loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

loadSecretBundle();

export { loadSecretBundle };

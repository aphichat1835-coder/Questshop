const SECRET_KEYS = /(?:token|authorization|cookie|password|secret|credential|session|database_url|api[_-]?key|ciphertext|auth_tag)/i;
const DISCORD_TOKEN = /(?:mfa\.[\w-]{20,}|[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,})/g;
const DATABASE_URL = /postgres(?:ql)?:\/\/[^\s]+/gi;

export function redactText(value) {
  return String(value)
    .replace(DISCORD_TOKEN, '[REDACTED_DISCORD_TOKEN]')
    .replace(DATABASE_URL, '[REDACTED_DATABASE_URL]');
}

export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SECRET_KEYS.test(key) ? '[REDACTED]' : redact(child, seen);
  }
  return result;
}

export function safeError(error) {
  return {
    name: String(error?.name ?? 'Error').slice(0, 80),
    code: String(error?.code ?? 'UNKNOWN').slice(0, 100),
    message: redactText(error?.message ?? String(error)).slice(0, 1000),
  };
}

const SECRET_KEYS = /(?:token|authorization|cookie|password|secret|credential|session|database_url|api[_-]?key|ciphertext|auth_tag)/i;
const MFA_DISCORD_TOKEN = /\bmfa\.[A-Za-z0-9_-]{20,}\b/g;
const DISCORD_TOKEN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g;
const DATABASE_URL = /postgres(?:ql)?:\/\/[^\s]+/gi;
const SENSITIVE_ASSIGNMENT = /((?:token|authorization|cookie|password|secret|credential|session|api[_-]?key|encryption[_-]?key|hmac[_-]?key)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const MAX_ERROR_MESSAGE = 1_000;
const MAX_ERROR_STACK = 12_000;
const MAX_CAUSE_DEPTH = 3;

export function redactText(value) {
  return String(value)
    .replace(MFA_DISCORD_TOKEN, '[REDACTED_DISCORD_TOKEN]')
    .replace(DISCORD_TOKEN, '[REDACTED_DISCORD_TOKEN]')
    .replace(DATABASE_URL, '[REDACTED_DATABASE_URL]')
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]');
}

export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Error) return serializeError(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SECRET_KEYS.test(key) ? '[REDACTED]' : redact(child, seen);
  }
  return result;
}

function truncate(value, maximum) {
  const text = redactText(value ?? '');
  return text.length > maximum ? `${text.slice(0, maximum)}…[TRUNCATED]` : text;
}

function serializeCause(cause, depth, seen) {
  if (cause == null) return null;
  if (depth >= MAX_CAUSE_DEPTH) return '[CAUSE_DEPTH_LIMIT]';
  if (typeof cause !== 'object') return truncate(cause, MAX_ERROR_MESSAGE);
  if (seen.has(cause)) return '[CIRCULAR]';
  if (cause instanceof Error) return serializeError(cause, { depth: depth + 1, seen });
  seen.add(cause);
  return truncate(String(cause), MAX_ERROR_MESSAGE);
}

// Error instances have no enumerable own properties in JavaScript, which used
// to produce `{}` in structured logs.  Deliberately serialize only a bounded,
// redacted diagnostic allowlist and never copy provider config/payload fields.
export function serializeError(error, { depth = 0, seen = new WeakSet() } = {}) {
  if (error && typeof error === 'object') {
    if (seen.has(error)) return '[CIRCULAR]';
    seen.add(error);
  }
  const result = {
    name: truncate(error?.name ?? 'Error', 80),
    message: truncate(error?.message ?? String(error ?? 'Unknown error'), MAX_ERROR_MESSAGE),
    code: truncate(error?.code ?? 'UNKNOWN', 100),
  };
  if (error?.stack) result.stack = truncate(error.stack, MAX_ERROR_STACK);
  const cause = serializeCause(error?.cause, depth, seen);
  if (cause != null) result.cause = cause;
  return result;
}

export function safeError(error) {
  const serialized = serializeError(error);
  return { name: serialized.name, code: serialized.code, message: serialized.message };
}

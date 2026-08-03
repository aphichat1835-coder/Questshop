import pino from 'pino';
import { redact } from './redaction.js';

export function createLogger(bindings = {}) {
  const base = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'questshop', ...bindings },
    redact: {
      paths: ['*.token', '*.authorization', '*.cookie', '*.password', '*.secret', '*.ciphertext'],
      censor: '[REDACTED]',
    },
  });
  const wrap = (level) => (object, message) => base[level](redact(object ?? {}), message);
  return Object.freeze({
    debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error'),
    child: (child) => createLogger({ ...bindings, ...child }),
  });
}

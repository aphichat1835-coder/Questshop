import pino from 'pino';
import { redact, redactText } from './redaction.js';

function safeMessage(message) {
  return typeof message === 'string' ? redactText(message) : message;
}

export function createLogger(bindings = {}, destination) {
  const options = {
    level: process.env.LOG_LEVEL ?? 'info',
    base: redact({ service: 'questshop', ...bindings }),
    redact: {
      paths: ['*.token', '*.authorization', '*.cookie', '*.password', '*.secret', '*.ciphertext'],
      censor: '[REDACTED]',
    },
  };
  const base = destination == null ? pino(options) : pino(options, destination);
  const wrap = (level) => (object, message) => base[level](redact(object ?? {}), safeMessage(message));
  return Object.freeze({
    debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error'),
    child: (child) => createLogger({ ...bindings, ...child }, destination),
  });
}

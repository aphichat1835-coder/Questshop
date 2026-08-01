const SENSITIVE_KEY = /authorization|token|secret|cookie|captcha|email|webhook|cipher|password|(?:api|private|encryption|access|signing)[_.-]?key/i;
const DISCORD_WEBHOOK_URL = /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[a-z0-9._-]+/gi;
const DISCORD_TOKEN = /\b[\w-]{20,}\.[\w-]{5,}\.[\w-]{15,}\b/g;

function isKeyCharacter(character) {
  if (!character) return false;
  const code = character.codePointAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || character === '_'
    || character === '.'
    || character === '-';
}

function isWhitespace(character) {
  return character === ' '
    || character === '\t'
    || character === '\n'
    || character === '\r';
}

function isUnquotedValueTerminator(character) {
  return isWhitespace(character)
    || character === ','
    || character === '}'
    || character === ']'
    || character === '"'
    || character === "'";
}

function assignmentKeyBounds(value, delimiterIndex) {
  let keyEnd = delimiterIndex;
  while (keyEnd > 0 && isWhitespace(value[keyEnd - 1])) keyEnd--;

  const closingQuote = value[keyEnd - 1];
  if (closingQuote === '"' || closingQuote === "'") {
    const openingQuote = value.lastIndexOf(closingQuote, keyEnd - 2);
    if (openingQuote >= 0) {
      return { start: openingQuote + 1, end: keyEnd - 1 };
    }
  }

  let keyStart = keyEnd;
  while (keyStart > 0 && isKeyCharacter(value[keyStart - 1])) keyStart--;
  return { start: keyStart, end: keyEnd };
}

function findClosingQuote(value, contentStart, quote) {
  let escaped = false;
  for (let index = contentStart; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === quote) return index;
  }
  return -1;
}

function assignmentValueBounds(value, delimiterIndex) {
  let start = delimiterIndex + 1;
  while (start < value.length && isWhitespace(value[start])) start++;

  const quote = value[start];
  if (quote === '"' || quote === "'") {
    const contentStart = start + 1;
    const closingQuote = findClosingQuote(value, contentStart, quote);
    return {
      start: contentStart,
      end: closingQuote === -1 ? value.length : closingQuote,
    };
  }

  let end = start;
  while (end < value.length && !isUnquotedValueTerminator(value[end])) end++;
  return { start, end };
}

function redactSensitiveAssignments(value) {
  let cursor = 0;
  let scanIndex = 0;
  let output = '';

  while (scanIndex < value.length) {
    const colonIndex = value.indexOf(':', scanIndex);
    const equalsIndex = value.indexOf('=', scanIndex);
    let delimiterIndex = colonIndex;
    if (delimiterIndex === -1 || (equalsIndex !== -1 && equalsIndex < delimiterIndex)) {
      delimiterIndex = equalsIndex;
    }
    if (delimiterIndex === -1) break;

    const keyBounds = assignmentKeyBounds(value, delimiterIndex);
    const key = value.slice(keyBounds.start, keyBounds.end);
    if (!key || !SENSITIVE_KEY.test(key)) {
      scanIndex = delimiterIndex + 1;
      continue;
    }

    const valueBounds = assignmentValueBounds(value, delimiterIndex);
    output += value.slice(cursor, valueBounds.start);
    output += '[REDACTED]';
    cursor = valueBounds.end;
    scanIndex = valueBounds.end;
  }

  return output + value.slice(cursor);
}

export function redactText(
  value,
  {
    scanLimit = 10_000,
    outputLimit = scanLimit,
    fallback = 'Unknown error',
  } = {},
) {
  const bounded = String(value ?? fallback).slice(0, scanLimit);
  const withoutWebhook = bounded.replace(DISCORD_WEBHOOK_URL, '[REDACTED_WEBHOOK]');
  return redactSensitiveAssignments(withoutWebhook)
    .replace(DISCORD_TOKEN, '[REDACTED_TOKEN]')
    .slice(0, outputLimit);
}
